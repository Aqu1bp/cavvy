import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { columnSteps, conversationLeast, splitShare, CONVERSATION_MIN, PANE_NARROW, REVIEW_DOCK_MIN, SPLIT_DRAG_MIN, SPLIT_PANE_MIN, windowLayout } from "../gui/src/lib/layout";
import { needsYou } from "../gui/src/lib/rail";
import { readdirSync, readFileSync } from "node:fs";

test("two sessions side by side: drops, focus, each one's panel, and what ends it (state/split.ts)", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-split.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});

const base = {
    win: { w: 1360, h: 880 }, rail: true, railOpen: false, railWidth: 260, panel: true, review: false, full: false,
    reviewBase: 720, inspectorWidth: 360, terminalShown: false, terminalPreferred: 260, terminalMax: false, dock: 140,
};

test("in a split the side panel and the diff reader dock as for one session, narrowing to leave each SPLIT_PANE_MIN where they can", () => {
    expect(conversationLeast(false)).toBe(CONVERSATION_MIN);
    expect(conversationLeast(true)).toBe(2 * SPLIT_PANE_MIN);
    // 1100 of sheet: 740 left for two panes of 370.
    expect(windowLayout({ ...base, split: true }).inspector.mode).toBe("dock");
    // 960 of sheet: 600 left, under two panes' least; it docks all the same, as for one.
    const narrow = { ...base, win: { w: 1220, h: 880 } };
    expect(windowLayout({ ...narrow, split: true }).inspector.mode).toBe("dock");
    // The diff reader: in the side panel, not over the sessions.
    const one = windowLayout({ ...narrow, review: true });
    const two = windowLayout({ ...narrow, review: true, split: true });
    expect([one.inspector.mode, two.inspector.mode]).toEqual(["dock", "dock"]);
    // Narrower in a split, down to REVIEW_DOCK_MIN, so the two keep what they can.
    expect(two.inspector.width).toBe(REVIEW_DOCK_MIN);
    expect(windowLayout({ ...base, review: true, split: true }).inspector.width).toBe(REVIEW_DOCK_MIN);
    expect(windowLayout({ ...base, review: true }).inspector.width).toBeGreaterThan(REVIEW_DOCK_MIN);
    // Wide enough for both: as wide as alone.
    const wide = { ...base, win: { w: 1800, h: 1000 } };
    expect(windowLayout({ ...wide, review: true, split: true }).inspector.width).toBe(windowLayout({ ...wide, review: true }).inspector.width);
    // Where one session wouldn't fit beside it, it floats over them, as over one.
    const tight = { ...base, win: { w: 900, h: 880 } };
    expect(windowLayout({ ...tight, review: true, split: true }).inspector.mode).toBe(windowLayout({ ...tight, review: true }).inspector.mode);
});

test("Needs you leaves out both sessions on screen in a split", () => {
    const waiting = [{ id: "a", status: "waiting" as const, updatedAt: 2 }, { id: "b", status: "waiting" as const, updatedAt: 1 }, { id: "c", status: "waiting" as const, updatedAt: 0 }];
    expect(needsYou(waiting, "a").map((s) => s.id)).toEqual(["b", "c"]);
    expect(needsYou(waiting, "a", "b").map((s) => s.id)).toEqual(["c"]);
});

test("the bar between them shares the column, keeping each at least SPLIT_DRAG_MIN; halves where there's no room for that", () => {
    expect(splitShare(0.3, 1000)).toBe(0.34);
    expect(splitShare(0.9, 1000)).toBe(1 - SPLIT_DRAG_MIN / 1000);
    expect(splitShare(0.42, 1000)).toBe(0.42);
    expect(splitShare(0.2, 2 * SPLIT_DRAG_MIN)).toBe(0.5);
    expect(splitShare(Number.NaN, 1000)).toBe(0.5);
    // Unmeasured (the layout's first values): halves.
    expect(splitShare(0.3, 0)).toBe(0.5);
});

test("a pane's own width steps in the styles are ones a pane gets (PANE_NARROW)", () => {
    const dir = fileURLToPath(new URL("../gui/src/styles/", import.meta.url));
    const used = new Set(readdirSync(dir).filter((f) => f.endsWith(".css")).flatMap((f) => [...readFileSync(dir + f, "utf8").matchAll(/\.stage-pane\[data-(?:narrow|bar)~="(\d+)"\]/g)].map((m) => Number(m[1]))));
    expect(used.has(360)).toBe(true);
    expect(used.has(240)).toBe(true);
    for (const step of used) expect(PANE_NARROW as readonly number[]).toContain(step);
    expect(columnSteps(297, PANE_NARROW)).toBe("700 640 600 520 440 360");
});
