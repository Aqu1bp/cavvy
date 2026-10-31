// What a change must not bring back, read from the source. Each list only shrinks: a new entry is a choice to pay for
// the cost, made in the open (AGENTS.md, Performance).
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const files = (dir: string, pattern: string) => [...new Glob(pattern).scanSync({ cwd: join(repo, dir) })].map((f) => join(dir, f)).sort();
const read = (f: string) => readFileSync(join(repo, f), "utf8");
/** The files under `dirs` whose code matches, and how often. */
function uses(dirs: string[], pattern: string, code: RegExp) {
    const found: Record<string, number> = {};
    for (const dir of dirs) for (const f of files(dir, pattern)) {
        const n = read(f).match(code)?.length ?? 0;
        if (n) found[f] = n;
    }
    return found;
}

test("the GUI's only timers that run for good are the clock's and the ones listed", () => {
    // One a second wakes every memo reading the time: lib/clock.ts is that one, and everything else shares it.
    expect(uses(["gui/src"], "**/*.{ts,tsx}", /\bsetInterval\(/g)).toEqual({
        "gui/src/components/PublishStatus.tsx": 1,
        "gui/src/lib/clock.ts": 1,
    });
});

test("the conversation's rows aren't holes in the window's drag strip", () => {
    // Chromium finds each hole again after every layout, for the whole page, and tells the main process when one has moved.
    const css = read("gui/src/styles/base.css");
    const rule = /\.app\.electron :is\(button[^{]*\{[^}]*no-drag/.exec(css)?.[0] ?? "";
    expect(rule).toContain(":not(.transcript *)");
    // Which is safe because the title bar covers the strip: it ends no lower than the bar does.
    expect(css).toContain("height: min(2 * var(--top-line) - var(--win-pad, 8px), var(--win-pad, 8px) + var(--header-h));");
});

test("nothing new blocks the server or an agent on a child process", () => {
    // A spawnSync there stops every session, and the socket, until it returns.
    expect(uses(["src/server", "src/agent", "src/util"], "**/*.ts", /\bspawnSync\(/g)).toEqual({
        "src/agent/turn-snapshots.ts": 1,
        "src/server/git-publish.ts": 1,
        "src/server/worktrees.ts": 1,
        "src/util/git.ts": 2,
    });
});

/** Each animation that runs for good: where, its keyframes' name and the whole declaration. */
function endless() {
    const out: { at: string; name: string; decl: string }[] = [];
    for (const f of files("gui/src/styles", "*.css")) {
        for (const m of read(f).matchAll(/animation:\s*([\w-]+)\s[^;]*\binfinite\b[^;]*;/g)) out.push({ at: f, name: m[1]!, decl: m[0] });
    }
    return out;
}

/** The properties a @keyframes block changes, by its name. */
function keyframes() {
    const out = new Map<string, Set<string>>();
    for (const f of files("gui/src/styles", "*.css")) {
        const css = read(f);
        for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
            let depth = 1, i = m.index + m[0].length;
            while (depth && i < css.length) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0, i++;
            const props = out.get(m[1]!) ?? new Set<string>();
            for (const p of css.slice(m.index + m[0].length, i).matchAll(/([a-z-]+)\s*:/g)) props.add(p[1]!);
            out.set(m[1]!, props);
        }
    }
    return out;
}

test("what animates for as long as something waits changes only when it must, and only what the compositor can draw", () => {
    // On a refresh with no change the compositor has nothing to draw: steps() keep most refreshes that way, for as long
    // as a session runs. Anything but these properties is painted again by the page on every change.
    const kinds = keyframes();
    const found = endless();
    expect(found.length).toBeGreaterThan(0);
    for (const a of found) {
        expect(`${a.at}: ${a.decl}`).toMatch(/steps\(\d+\)/);
        for (const p of kinds.get(a.name) ?? []) expect(`${a.name}: ${p}`).toMatch(/: (transform|opacity|filter)$/);
    }
});

test("what animates for good changes on the stream clock's grid, or the window is drawn again for each one out of step", async () => {
    const { STEP_MS } = await import("../gui/src/lib/stream-clock");
    const css = files("gui/src/styles", "*.css").map(read).join("\n");
    for (const a of endless()) {
        const m = /\s([\d.]+)(m?s)\s[^;]*steps\((\d+)\)/.exec(a.decl);
        expect(`${a.at}: ${a.decl}`).toMatch(/steps\(\d+\)/);
        // steps() counts within each stretch between keyframes, not over the whole of it.
        const block = css.slice(css.indexOf(`@keyframes ${a.name}`));
        const body = block.slice(0, block.indexOf("\n}"));
        const stops = [...new Set([0, 100, ...[...body.matchAll(/([\d.]+)%/g)].map((x) => Number(x[1]))])].sort((x, y) => x - y);
        const ms = Number(m![1]) * (m![2] === "s" ? 1000 : 1);
        for (let i = 1; i < stops.length; i++) {
            const every = (ms * (stops[i]! - stops[i - 1]!)) / 100 / Number(m![3]);
            expect(`${a.at}: ${a.decl}: ${Math.round(every * 100) / 100 % STEP_MS}`).toEndWith(": 0");
        }
    }
});

test("a blur doesn't come back over what's following the end of a reply", () => {
    // Most of what a streaming reply cost the GPU: base.css says why.
    const css = read("gui/src/styles/base.css");
    expect(css).toMatch(/\[data-following\] :is\([^{]*\.composer-box[^{]*\)\.glass \{[^}]*backdrop-filter: none/);
    const header = read("gui/src/styles/header.css");
    expect(header.slice(header.indexOf(".header::before"), header.indexOf("}", header.indexOf(".header::before")))).not.toContain("backdrop-filter");
});

test("the server ships on the Bun that's tested, and not on 1.3", () => {
    // 1.3 collects garbage on nearly every wake of the event loop: over ten times a reply's work in the server.
    const shipped = read("desktop-electron/pack.ts").match(/SERVER_BUN = "(.+?)"/)?.[1] ?? "";
    expect(shipped).toBe(read(".github/workflows/ci.yml").match(/BUN_VERSION: (\S+)/)?.[1] ?? "none");
    expect(Bun.semver.order(shipped, "1.4.0")).toBe(1);
});

test("a window whose page dies gets it back", () => {
    // Without this the window stays empty until the app's restarted, while the server carries on behind it.
    const main = read("desktop-electron/src/main.ts");
    const handler = main.slice(main.indexOf('"render-process-gone"'), main.indexOf('win.on("closed"'));
    expect(handler).toContain("pageGone()");
    expect(main.slice(main.indexOf("async function pageGone"), main.indexOf("function showWindow"))).toContain("webContents.reload()");
});

test("budgets only come down, and what's loaded at startup is read from index.html", async () => {
    const { eagerAssets, raised } = await import("../scripts/perf-budgets");
    expect(raised({ a: 2, b: 2 }, { a: 1, b: 2, c: 9 })).toEqual([]);
    expect(raised({ a: 2, b: 2 }, { a: 3 })).toEqual(["a: 2 -> 3", "b: removed (was 2)"]);
    expect(eagerAssets(`<script type="module" crossorigin src="./assets/index-x.js"></script><link rel="modulepreload" href="./assets/v.js"><link rel="stylesheet" href="./assets/index-x.css"><link rel="icon" href="./favicon.png">`)).toEqual({ js: ["assets/index-x.js", "assets/v.js"], css: ["assets/index-x.css"] });
});
