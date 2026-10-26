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

test("a session opening at its end mounts about two screens of its last turns first, by their text", async () => {
    const { firstShown, turnHeight, FIRST_TURNS_MIN } = await import("../gui/src/lib/transcript-scroll");
    const long = { prompt: { text: "explain" }, blocks: [{ t: "text", text: "x".repeat(9000) }] };
    const short = { prompt: { text: "hi" }, blocks: [{ t: "text", text: "hello" }] };
    expect(turnHeight(long)).toBeGreaterThan(2000);
    expect(turnHeight(short)).toBeLessThan(120);
    // Long replies: the minimum fills the screens already.
    expect(firstShown(Array(40).fill(turnHeight(long)), 40, true, 800)).toBe(FIRST_TURNS_MIN);
    // Short ones: as many as fill two screens.
    const n = firstShown(Array(40).fill(turnHeight(short)), 40, true, 800);
    expect(n * turnHeight(short)).toBeGreaterThanOrEqual(1600);
    expect((n - 1) * turnHeight(short)).toBeLessThan(1600);
    // Never more than the page, never fewer than there are; not at the end, the whole page.
    expect(firstShown(Array(3).fill(80), 3, true, 800)).toBe(3);
    expect(firstShown(Array(40).fill(80), 40, false, 800)).toBe(40);
});

test("a session reopened where it was being read mounts the place read and about two screens from it first", async () => {
    const { firstWindow } = await import("../gui/src/lib/transcript-scroll");
    const heights = Array(60).fill(400);
    // Read at turn 30 of 60, a page of 40: the turn above (29), and 30-33, two screens (1600px) from it.
    expect(firstWindow(heights, 40, 30, 800)).toEqual({ shown: 31, trimmed: 26 });
    // At the end: the last turns that fill two screens, nothing trimmed.
    expect(firstWindow(heights, 40, undefined, 800)).toEqual({ shown: 4, trimmed: 0 });
    // A place read near the end: nothing below to hold back.
    expect(firstWindow(heights, 40, 58, 800)).toEqual({ shown: 3, trimmed: 0 });
    // Read near the end of a turn taller than two screens: the two screens count from the place read, so the turns
    // below it that were in view go in too.
    const tall = [...Array(30).fill(400), 3000, ...Array(29).fill(400)];
    expect(firstWindow(tall, 40, 30, 800)).toEqual({ shown: 31, trimmed: 29 });
    expect(firstWindow(tall, 40, 30, 800, 2600)).toEqual({ shown: 31, trimmed: 26 });
    // The place read at the page's first turn: not the turn above it, which isn't in the page.
    expect(firstWindow(heights, 40, 20, 800).shown).toBe(40);
});
