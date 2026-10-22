import { expect, test } from "bun:test";
import { anchoredTop, atBottom, firstBelow, positionCache, restoredShown, type TranscriptPosition } from "../gui/src/lib/transcript-scroll";
import { duration, turnDuration } from "../src/server/duration";
import { fileURLToPath } from "node:url";

const saved = (turnId = "5"): TranscriptPosition => ({ bottom: false, top: 120, anchor: { turnId, offset: -23 }, openWork: [turnId] });

test("prepending turns preserves the anchor's viewport offset, including removal of the earlier button", () => {
    expect(anchoredTop(0, 2131, 75)).toBe(2056);
    expect(anchoredTop(2056, 75, 75)).toBe(2056); // observer replay is idempotent
    expect(anchoredTop(300, -100, -23)).toBe(223); // collapse above the reader
    expect(anchoredTop(0, -40, 0)).toBe(0); // browser's top boundary
});

test("session memory retains positions and folds, promotes reads and overwrites, and evicts the least recent session", () => {
    const cache = positionCache(2);
    cache.set("a", saved()); cache.set("b", { ...saved(), bottom: true });
    expect(cache.get("a")).toEqual(saved());
    cache.set("c", saved("10"));
    expect(cache.get("b")).toBeUndefined();
    cache.set("a", { ...saved(), top: 999 });
    cache.set("d", saved());
    expect(cache.get("c")).toBeUndefined();
    expect(cache.get("a")?.top).toBe(999);
});

test("restore loads enough full pages to retain an older anchor after background turns arrive", () => {
    const ids = Array.from({ length: 125 }, (_, i) => String(i));
    expect(restoredShown(ids)).toBe(40);
    expect(restoredShown(ids, saved())).toBe(120);
    expect(restoredShown(ids, saved("missing"))).toBe(40);
    expect(restoredShown([], saved())).toBe(40);
    expect(restoredShown(ids, { ...saved(), bottom: true })).toBe(40);
});

test("a reopened session shows its last page, or the pages down to where it was read, not every page it once showed", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => String(i));
    // Paged all the way up, then left at the end.
    expect(restoredShown(ids, { ...saved("0"), bottom: true })).toBe(40);
    // Left reading turn 100: the pages from there down.
    expect(restoredShown(ids, saved("100"))).toBe(920);
    expect(restoredShown(ids, saved("990"))).toBe(40);
});

test("the turn reaching into the view is found by halving, measuring a few", () => {
    const bottoms = Array.from({ length: 1000 }, (_, i) => (i + 1) * 100);
    let measured = 0;
    const at = (top: number) => firstBelow(bottoms.length, (i) => (measured++, bottoms[i]!), top);
    expect(at(-50)).toBe(0);
    expect(at(100)).toBe(1); // A bottom at the view's top isn't in it.
    expect(at(30_050)).toBe(300);
    expect(at(100_000)).toBe(1000); // None.
    expect(firstBelow(0, () => 0, 0)).toBe(0);
    expect(measured).toBeLessThanOrEqual(4 * 11);
});

test("following preserves the existing strict 64 pixel threshold", () => {
    expect(atBottom(436, 1000, 500)).toBe(false);
    expect(atBottom(437, 1000, 500)).toBe(true);
    expect(atBottom(510, 1000, 500)).toBe(true);
});

test("turn copy uses shared readable duration without changing subsecond tool durations", () => {
    expect(duration(341)).toBe("341ms");
    expect(turnDuration(341)).toBe("0s");
    expect(turnDuration(1042000)).toBe("17m 22s");
    expect(turnDuration(3600000)).toBe("1h 0m");
});

test("transcript component preserves paging, session memory, completion and explicit navigation", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-transcript-scroll.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
