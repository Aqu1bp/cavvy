import { expect, test } from "bun:test";
import { parseRules } from "./helpers/contrast";

const read = (path: string) => Bun.file(new URL(`../gui/src/${path}`, import.meta.url)).text();

// The window is glass and the dock's pieces are cards on it: a fill and a hairline. The conversation fades out
// before it reaches them (stage.css), so there is never anything behind one to blur, following the end or not.

test("the dock's pieces are cards, not floating glass: none of them blurs what's behind it", async () => {
    for (const [file, piece] of [
        ["components/Composer.tsx", 'class="composer-box card-surface"'],
        ["components/InteractionDock.tsx", "class={`ask card-surface itab"],
        ["components/QueueTab.tsx", 'class="uq-tray card-surface"'],
        ["components/Home.tsx", 'class="hcard card-surface'],
    ] as const) expect(await read(file)).toContain(piece);
    const base = parseRules(await read("styles/base.css"));
    const card = base.filter((r) => r.selectors.includes(".card-surface"));
    expect(card.length).toBe(1);
    expect([...card[0]!.decls.keys()].some((k) => k.includes("backdrop-filter"))).toBe(false);
    // And nothing gives a card one elsewhere.
    for (const file of ["composer.css", "home.css", "stage.css", "header.css", "plan.css"]) {
        const blurred = parseRules(await read(`styles/${file}`)).filter((r) => [...r.decls.keys()].some((k) => k.includes("backdrop-filter")) && r.selectors.some((s) => /\.(composer-box|ask|uq-tray|hcard|cap|needs)\b/.test(s)));
        expect(blurred.map((r) => r.selectors.join(", "))).toEqual([]);
    }
});

test("the steps, open, lie over the conversation: only then are they floating glass", async () => {
    // StepsTray.tsx: the dock keeps room for their one line only, so the open list has the conversation behind it.
    expect(await read("components/StepsTray.tsx")).toContain('classList={{ open: open(), glass: open(), "card-surface": !open() }}');
});

test("the conversation fades out under the title bar and before the dock, so nothing passes behind either", async () => {
    const stage = parseRules(await read("styles/stage.css"));
    const mask = stage.findLast((r) => r.selectors.includes(".stage .transcript") && r.decls.has("mask-image"))?.decls.get("mask-image") ?? "";
    expect(mask).toContain("var(--bar-h");
    expect(mask).toContain("var(--dock-h)");
    // No ground or blur under the title bar for it to scroll behind.
    const header = await read("styles/header.css");
    expect(header).not.toContain(".header::before");
    expect(header).not.toContain("backdrop-filter");
});
