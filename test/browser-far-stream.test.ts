// The pace of a page's pictures when its pane is watched over a network (src/browser/far-stream.ts): lighter frames
// as they come, the sharp still when they stop; and how many pictures may be on their way at once (feed.ts).

import { expect, test } from "bun:test";
import { FarStream, STOPPED_MS } from "../src/browser/far-stream";
import { FrameFeed } from "../src/browser/feed";

/**
 * A page, and a stream of it as Chrome sends one: a frame when the page changes, and one more (the page as it
 * already was) each time a still is taken, `echo` ms after the still began ("after": once it's done).
 */
function setup(o: { stillMs?: number; echo?: number | "after" | "none" } = {}) {
    const shown: string[] = [];
    let page = "A";
    let stills = 0;
    const stillMs = o.stillMs ?? 20;
    const stream = new FarStream<string>({
        show: (f) => void shown.push(f),
        still: async () => {
            stills++;
            const now = page;
            const echo = () => stream.frame(`light:${page}`, page);
            if (typeof o.echo === "number" || o.echo === undefined) setTimeout(echo, o.echo ?? stillMs / 2);
            await Bun.sleep(stillMs);
            if (o.echo === "after") setTimeout(echo, 15);
            return { frame: `sharp:${now}`, key: `still:${now}` };
        },
    });
    /** The page changes: Chrome sends a frame of it. */
    const change = (to: string) => ((page = to), stream.frame(`light:${to}`, to));
    return { stream, shown, stills: () => stills, change };
}
/** Long enough for a still to have been taken and shown after the last frame, on a busy machine too. */
const settled = () => Bun.sleep(STOPPED_MS + 250);

test("while the page changes its frames are shown as they come; once they stop, the sharp still, once", async () => {
    const { stream, shown, stills, change } = setup();
    stream.start();
    for (const p of ["B", "C", "D"]) {
        change(p);
        await Bun.sleep(30);
    }
    expect(shown).toEqual(["light:B", "light:C", "light:D"]);
    await settled();
    expect(shown.at(-1)).toBe("sharp:D");
    // The frame Chrome sent as the still was taken is the page as it was: not shown over the still, and no reason for another.
    await settled();
    expect([shown.slice(-2), stills()]).toEqual([["light:D", "sharp:D"], 1]);
    // A change that comes alone later (a caret, a letter) is shown at once, and sharpened after.
    change("E");
    expect(shown.at(-1)).toBe("light:E");
    await settled();
    expect(shown.slice(-2)).toEqual(["light:E", "sharp:E"]);
    stream.stop();
});

test("Chrome's own frame for a still is passed over whenever it comes: while the still is taken, just after, or not at all", async () => {
    for (const echo of [5, "after", "none"] as const) {
        const { stream, shown, stills, change } = setup({ echo });
        stream.start();
        change("B");
        await settled();
        await settled();
        // Ends on the sharp picture, taken once: nothing soft over it, nothing sent twice.
        expect([echo, shown, stills()]).toEqual([echo, ["light:B", "sharp:B"], 1]);
        stream.stop();
    }
});

test("a page at rest when the stream begins: its first frame is Chrome's own for the first still, and the sharp one follows", async () => {
    const { stream, shown } = setup();
    stream.start();
    await settled();
    await settled();
    expect(shown).toEqual(["light:A", "sharp:A"]);
    stream.stop();
});

test("a change while the still is taken is shown at once, the still taken then is dropped, and the one after shows the page as it is", async () => {
    const { stream, shown, stills, change } = setup({ stillMs: 120, echo: "none" });
    stream.start();
    change("B");
    await Bun.sleep(STOPPED_MS + 50);
    // The still of B is being taken: the page becomes C.
    expect(stills()).toBe(1);
    change("C");
    expect(shown).toEqual(["light:B", "light:C"]);
    await settled();
    await Bun.sleep(150);
    expect(shown).toEqual(["light:B", "light:C", "sharp:C"]);
    stream.stop();
});

test("a change that came in the same frame as Chrome's own isn't missed: that frame differs from the last, so it's a change", async () => {
    const { stream, shown, change } = setup({ stillMs: 60, echo: "none" });
    stream.start();
    change("B");
    await Bun.sleep(STOPPED_MS + 30);
    // One frame while the still (of B) is taken, and it shows C.
    change("C");
    await settled();
    await Bun.sleep(100);
    expect(shown.at(-1)).toBe("sharp:C");
    stream.stop();
});

test("a still that can't be taken, or a stream stopped or started again meanwhile: nothing of what was under way is shown after", async () => {
    const shown: string[] = [];
    let fail = true;
    const stream = new FarStream<string>({
        show: (f) => void shown.push(f),
        still: async () => {
            await Bun.sleep(40);
            if (fail) throw new Error("the page is closing");
            return { frame: "sharp", key: "s" };
        },
    });
    stream.start();
    stream.frame("light:1", 1);
    await settled();
    expect(shown).toEqual(["light:1"]);
    // Started again (the pane was resized) while a still is on its way: that still isn't this stream's.
    fail = false;
    stream.frame("light:2", 2);
    await Bun.sleep(STOPPED_MS + 15);
    stream.start();
    await Bun.sleep(60);
    expect(shown).toEqual(["light:1", "light:2"]);
    await settled();
    expect(shown).toEqual(["light:1", "light:2", "sharp"]);
    stream.stop();
    stream.frame("light:late", 3);
    await settled();
    expect(shown.length).toBe(3);
});

test("one picture is on its way to a viewer at a time, or as many as it's told: the newest waits for room, and only its own acknowledgement makes it", () => {
    for (const atOnce of [1, 2]) {
        const feed = new FrameFeed<string>(atOnce);
        const got: [string, string][] = [];
        const key = {};
        feed.add(key, (f, id) => void got.push([f, id]));
        for (const f of ["a", "b", "c", "d"]) feed.push(f);
        // The rest waited, and only the newest of them is kept.
        expect(got.map((g) => g[0])).toEqual(["a", "b"].slice(0, atOnce));
        feed.ack(key, "not-one-of-its");
        expect(got.length).toBe(atOnce);
        feed.ack(key, got[0]![1]);
        expect(got.map((g) => g[0])).toEqual([...["a", "b"].slice(0, atOnce), "d"]);
        // Acknowledged twice, it makes room once.
        feed.push("e");
        feed.ack(key, got[0]![1]);
        expect(got.length).toBe(atOnce + 1);
    }
});
