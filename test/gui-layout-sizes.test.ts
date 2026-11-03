// The sizes the shell keeps while an edge is dragged (and the composer dock's height) are custom
// properties registered `inherits: false` (gui/src/styles), so a change restyles only the element
// it's on. That means a box reading one gets it only if it's set on that box itself:
// - Through a wrapper that doesn't pass it on, a box falls back to the initial value (#217's .keep
//   put the sidebar at 260px in a column of the saved width, clipped or with a gap; the settings
//   sections were 260px whatever the rail's width).
// - Passed on with `--x: inherit`, WebKit (the app's WKWebView) keeps the old value when only the
//   parent's inline value changes (Chrome recomputes it): the inspector's content stayed 280px wide in
//   a 620px column after its edge was dragged, the sidebar kept its width while the rail's edge was
//   dragged, and the end of the conversation kept 140px of room under a taller composer.
// So no rule takes one with `inherit`, and every box that reads one (`var(--x)`) has it set on itself,
// in the components. These read the sources: the rendering is checked in WebKit and Chrome by hand.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parseRules } from "./helpers/contrast";

const gui = join(import.meta.dir, "../gui/src");
const read = (path: string) => readFileSync(join(gui, path), "utf8");
const files = (dir: string, ext: RegExp): string[] => readdirSync(join(gui, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), ext) : ext.test(e.name) ? [join(dir, e.name)] : []));
const styles = files("styles", /\.css$/).map((f) => ({ file: f, rules: parseRules(read(f)) }));
const sources = files(".", /\.tsx$/).map((f) => ({ file: f, text: read(f) }));

/** Every custom property registered as not inherited, in any stylesheet. */
const sizes = styles.flatMap((s) => s.rules).flatMap((r) => r.selectors.filter((sel) => sel.startsWith("@property ") && r.decls.get("inherits") === "false").map((sel) => sel.slice("@property ".length)));

/** The classes of the elements that set `name` themselves: a JSX tag with `"name":` in its style. */
function setters(name: string): Set<string> {
    const out = new Set<string>();
    for (const { text } of sources) {
        for (const m of text.matchAll(new RegExp(`"${name}":`, "g"))) {
            const tag = text.slice(text.lastIndexOf("<", m.index), m.index);
            const cls = /\sclass="([^"]+)"/.exec(tag)?.[1];
            if (cls) for (const c of cls.split(/\s+/)) out.add(c);
        }
    }
    return out;
}

/** The selectors of the rules that read `name` (`var(name)` in a declaration). */
function readers(name: string): { file: string; selector: string }[] {
    return styles.flatMap((s) => s.rules.filter((r) => !r.selectors.some((sel) => sel.startsWith("@")) && [...r.decls.values()].some((v) => v.includes(`var(${name})`))).flatMap((r) => r.selectors.map((selector) => ({ file: s.file, selector }))));
}

/** The classes on the element a selector styles: its last compound selector. */
const subject = (selector: string) => [...(selector.split(/\s*[\s>+~]\s*/).pop() ?? "").matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);

test("these are the sizes registered as not inherited", () => {
    // A new one is audited here too; add it once its readers set it themselves.
    expect(new Set(sizes)).toEqual(new Set(["--rail-w", "--insp-w", "--insp-col", "--insp-bottom", "--term-h", "--dock-h"]));
});

for (const name of ["--rail-w", "--insp-w", "--insp-col", "--insp-bottom", "--term-h", "--dock-h"]) {
    test(`no element takes ${name} with inherit (WebKit keeps it stale)`, () => {
        const inheriting = styles.flatMap((s) => s.rules.filter((r) => r.decls.get(name) === "inherit").map((r) => `${s.file}: ${r.selectors.join(", ")}`));
        expect(inheriting).toEqual([]);
    });

    test(`every box that reads ${name} sets it itself`, () => {
        const set = setters(name);
        expect(set.size).toBeGreaterThan(0);
        const users = readers(name);
        expect(users.length).toBeGreaterThan(0);
        for (const { file, selector } of users) expect({ file, selector, setsIt: subject(selector).some((c) => set.has(c)) }).toEqual({ file, selector, setsIt: true });
    });
}

test("nothing reads a size from an element's computed style (where WebKit may have kept an old one)", () => {
    for (const { file, text } of sources) for (const name of sizes) expect({ file, name, reads: text.includes(`getPropertyValue("${name}")`) }).toEqual({ file, name, reads: false });
});

test("the rail's column and the rail both have its width, the same one", () => {
    const app = read("App.tsx");
    const on = (cls: string) => new RegExp(`<div class="${cls}"[^>]*style=\\{\\{ "--rail-w": \`\\$\\{railWidth\\(\\)\\}px\` \\}\\}`).test(app);
    expect(on("win")).toBe(true);
    expect(on("win-rail")).toBe(true);
});

const shell = parseRules(read("styles/shell.css"));
const decl = (selector: string, property: string) => shell.findLast((r) => r.selectors.includes(selector) && r.decls.has(property))?.decls.get(property);

test("what's in the rail fills a track of the rail's own width: the sidebar, and the settings sections over it", () => {
    expect(decl(".win-rail", "display")).toBe("grid");
    expect(decl(".win-rail", "grid-template-columns")).toBe("var(--rail-w)");
    // Both children (.keep, and the absolutely placed .settings-host) take the track, not the column's box.
    expect(decl(".win-rail > *", "grid-area")).toBe("1 / 1");
    const sidebar = parseRules(read("styles/sidebar.css")).findLast((r) => r.selectors.includes(".sidebar") && r.decls.has("width"))?.decls.get("width");
    expect(sidebar).toBe("100%");
    // What App.tsx puts between the rail and the sidebar; a new wrapper has to fill the track as .keep does.
    const app = read("App.tsx");
    const between = app.slice(app.indexOf('<div class="win-rail"'), app.indexOf("<Sidebar"));
    expect([...between.matchAll(/<div class="([\w-]+)/g)].map((m) => m[1]!)).toEqual(["win-rail", "settings-host", "keep"]);
});

test("the inspector's content fills a track of the inspector's own width, less the hairline (docked), or its box (floating)", () => {
    expect(decl(".insp", "display")).toBe("grid");
    expect(decl(".insp", "grid-template-columns")).toBe("calc(var(--insp-w) - 0.5px)");
    expect(decl('[data-inspmode="float"] .insp', "grid-template-columns")).toBe("minmax(0, 1fr)");
    // The content sizes itself by nothing else.
    expect(decl(".insp > :not(.insp-resizer)", "width")).toBeUndefined();
});

test("the composer dock's measured height reaches the transcript (SessionView, rendered)", () => {
    // In a browser-conditions process, so Solid's renderer and signals are the same copy. Transcript's side
    // (its end, the Latest pill and find get it) is rendered in gui-transcript-scroll.
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "--conditions=browser", "test", join(import.meta.dir, "fixtures/gui-dock-height.ts")], { timeout: 15000 });
    expect({ code: result.exitCode, output: result.stderr.toString() }).toMatchObject({ code: 0 });
});

test("the transcript's end and the Latest pill have the composer dock's height set on them", () => {
    const transcript = read("components/Transcript.tsx");
    expect(transcript).toMatch(/<div class="transcript-end" style=\{\{ "--dock-h": dock\(\) \}\} \/>/);
    expect(transcript).toMatch(/<button class="jump glass" style=\{\{ "--dock-h": dock\(\) \}\}/);
    expect(read("components/Agents.tsx")).toMatch(/<div class="transcript-end" style=\{\{ "--dock-h": `\$\{dockH\(\)\}px` \}\} \/>/);
});
