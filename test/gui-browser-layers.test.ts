// A server's page in the Browser pane: the last sharp still under the stream, and only what changed drawn from the
// stream over it (gui/src/lib/browser-layers.ts).

import { expect, test } from "bun:test";
import { changedBox, Layers, MOST, type Pixels } from "../gui/src/lib/browser-layers";

/** A picture of `w` by `h`, all 0 but the listed boxes (x, y, w, h, value). */
function picture(w: number, h: number, boxes: [number, number, number, number, number][] = []): Uint32Array {
    const d = new Uint32Array(w * h);
    for (const [x, y, bw, bh, v] of boxes) for (let j = y; j < y + bh; j++) for (let i = x; i < x + bw; i++) d[j * w + i] = v;
    return d;
}

test("the box of what differs between two pictures; none when they're the same", () => {
    const a = picture(40, 30);
    expect(changedBox(a, picture(40, 30), 40, 30)).toBeUndefined();
    expect(changedBox(a, picture(40, 30, [[5, 7, 3, 2, 1]]), 40, 30)).toEqual({ x: 5, y: 7, width: 3, height: 2 });
    // Two changes far apart: one box around both.
    expect(changedBox(a, picture(40, 30, [[2, 1, 1, 1, 1], [38, 28, 2, 2, 9]]), 40, 30)).toEqual({ x: 2, y: 1, width: 38, height: 29 });
    // A single pixel, at each corner.
    expect(changedBox(a, picture(40, 30, [[0, 0, 1, 1, 1]]), 40, 30)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(changedBox(a, picture(40, 30, [[39, 29, 1, 1, 1]]), 40, 30)).toEqual({ x: 39, y: 29, width: 1, height: 1 });
});

/** A stand-in for a picture: closed once, and only once. */
function pic(name: string, closed: string[]) {
    return { name, close: () => void closed.push(name) };
}
const SIZE = { width: 400, height: 300 };
const px = (boxes: [number, number, number, number, number][] = []): Pixels => ({ data: picture(200, 150, boxes), width: 200, height: 150, scale: 0.5 });

test("a stream with no marked still is shown whole, and its frames aren't compared", () => {
    const closed: string[] = [];
    const l = new Layers<ReturnType<typeof pic>>();
    const a = pic("a", closed);
    l.frame(a, SIZE);
    expect([l.compares, l.plan()]).toEqual([false, { size: SIZE, over: a }]);
    l.frame(pic("b", closed), SIZE);
    expect(closed).toEqual(["a"]);
});

test("a page with a small moving part: the still stays under it, and only that part is drawn from the stream", () => {
    const closed: string[] = [];
    const l = new Layers<ReturnType<typeof pic>>();
    const still = pic("still", closed);
    expect(l.still(still, SIZE, 1)).toBe(true);
    expect([l.compares, l.plan()]).toEqual([true, { size: SIZE, under: still }]);
    // The first frame has none before it to compare with: the page may have moved all over, so it's shown whole.
    const f1 = pic("f1", closed);
    l.frame(f1, SIZE, () => px());
    expect(l.plan()).toEqual({ size: SIZE, over: f1 });
    // At rest again; then a dot moves: 10 by 10 at (20, 30) of the half-size pixels, so 20 by 20 at (40, 60) of the page, and a margin.
    const rest = pic("rest", closed);
    l.still(rest, SIZE, 1);
    const f2 = pic("f2", closed);
    l.frame(f2, SIZE, () => px([[20, 30, 10, 10, 1]]));
    expect(l.plan()).toEqual({ size: SIZE, under: rest, over: f2, part: { x: 36, y: 56, width: 28, height: 28 } });
    // It moves on: the part grows to hold where it was and where it is.
    const f3 = pic("f3", closed);
    l.frame(f3, SIZE, () => px([[40, 30, 10, 10, 1]]));
    expect(l.plan()!.part).toEqual({ x: 36, y: 56, width: 68, height: 28 });
    // A still of the page a moment ago: under the stream, and what was changing is still drawn from the stream.
    const steady = pic("steady", closed);
    expect(l.still(steady, SIZE, 2)).toBe(true);
    expect(l.plan()).toEqual({ size: SIZE, under: steady, over: f3, part: { x: 36, y: 56, width: 68, height: 28 } });
    // Nothing moves any more: the part from before the last still is let go at the next one.
    l.frame(pic("f4", closed), SIZE, () => px([[40, 30, 10, 10, 1]]));
    l.still(pic("steady2", closed), SIZE, 2);
    expect(l.plan()!.part).toBeUndefined();
    expect(closed).toEqual(["still", "f1", "f2", "rest", "f3", "steady"]);
});

test("the page moving all over (a scroll): the stream whole, no still under it, and a still of a moment ago isn't shown", () => {
    const closed: string[] = [];
    const l = new Layers<ReturnType<typeof pic>>();
    l.still(pic("rest", closed), SIZE, 1);
    l.frame(pic("f1", closed), SIZE, () => px());
    l.still(pic("rest2", closed), SIZE, 1);
    // More than MOST of the page changed.
    const scrolled = pic("scrolled", closed);
    l.frame(scrolled, SIZE, () => px([[0, 0, 200, Math.ceil(150 * MOST) + 10, 5]]));
    expect(l.plan()).toEqual({ size: SIZE, over: scrolled });
    expect(l.still(pic("late", closed), SIZE, 2)).toBe(false);
    expect(closed).toContain("late");
    expect(l.plan()).toEqual({ size: SIZE, over: scrolled });
    // It stops: the still at rest is the picture, alone.
    const rest = pic("rest3", closed);
    expect(l.still(rest, SIZE, 1)).toBe(true);
    expect(l.plan()).toEqual({ size: SIZE, under: rest });
    // Another size (the pane was resized): compared with nothing, shown whole.
    const other = pic("other", closed);
    l.frame(other, { width: 500, height: 300 }, () => ({ data: picture(250, 150), width: 250, height: 150, scale: 0.5 }));
    expect(l.plan()).toEqual({ size: { width: 500, height: 300 }, over: other });
    l.clear();
    expect(l.plan()).toBeUndefined();
});
