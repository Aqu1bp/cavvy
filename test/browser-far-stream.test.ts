// The pace of a page's pictures when its pane is watched over a network (src/browser/far-stream.ts): lighter frames
// as they come, the sharp still when they stop; and how many pictures may be on their way at once (feed.ts).

import { expect, test } from "bun:test";
import { FarStream, STOPPED_MS } from "../src/browser/far-stream";
import { FrameFeed } from "../src/browser/feed";

function setup(o: { stillMs?: number } = {}) {
    const shown: string[] = [];
    let page = "A";
    let stills = 0;
    /** What Chrome does when a still is taken: frames of the stream that come meanwhile. */
    let echo: (() => void) | undefined;
    const stream = new FarStream<string>({
        show: (f) => void shown.push(f),
        still: async () => {
            stills++;
            const now = page;
            await Bun.sleep((o.stillMs ?? 10) / 2);
            echo?.();
            await Bun.sleep((o.stillMs ?? 10) / 2);
            return { frame: `sharp:${now}`, key: now };
        },
    });
    return { stream, shown, stills: () => stills, setPage: (p: string) => (page = p), onStill: (fn: (() => void) | undefined) => (echo = fn) };
}
const after = (ms: number) => Bun.sleep(ms + 40);

test("a page at rest gets one sharp still, and looking again sends nothing more", async () => {
    const { stream, shown, stills, onStill } = setup();
    // As Chrome does: one frame of the stream for each still taken.
    onStill(() => stream.frame("light:echo"));
    stream.start();
    await after(STOPPED_MS);
    expect(shown).toEqual(["sharp:A"]);
    await after(STOPPED_MS + 100);
    // Taken twice (the second look), sent once; its own frame is never shown over it.
    expect([shown, stills()]).toEqual([["sharp:A"], 2]);
    stream.stop();
});

test("each frame of the stream is shown as it comes, then the sharp still once they stop", async () => {
    const { stream, shown, setPage } = setup();
    stream.start();
    for (let i = 0; i < 4; i++) {
        stream.frame(`light:${i}`);
        await Bun.sleep(30);
    }
    setPage("B");
    expect(shown).toEqual(["light:0", "light:1", "light:2", "light:3"]);
    await after(STOPPED_MS);
    expect(shown.at(-1)).toBe("sharp:B");
    // A change that comes alone later (a caret, a letter) is shown at once too, and sharpened after.
    setPage("C");
    stream.frame("light:C");
    expect(shown.at(-1)).toBe("light:C");
    await after(STOPPED_MS);
    expect(shown.slice(-2)).toEqual(["light:C", "sharp:C"]);
    stream.stop();
});

test("frames that keep coming while the still is taken are the page moving: the newest is shown, and the still follows when it stops", async () => {
    const { stream, shown, setPage, onStill } = setup({ stillMs: 60 });
    stream.start();
    // The still's own frame, and one more: the page changed.
    onStill(() => (stream.frame("light:echo"), stream.frame("light:newer"), setPage("B"), onStill(() => stream.frame("light:echo"))));
    await after(STOPPED_MS + 60);
    expect(shown).toEqual(["light:newer"]);
    await after(STOPPED_MS + 60);
    expect(shown).toEqual(["light:newer", "sharp:B"]);
    stream.stop();
});

test("a change that came with the still's own frame isn't missed: the second look sends the newer still", async () => {
    const { stream, shown, setPage, onStill } = setup({ stillMs: 40 });
    stream.start();
    // The first still was of A; the page became B as it was taken, and Chrome sent only the one frame.
    onStill(() => (stream.frame("light:echo"), setPage("B"), onStill(() => stream.frame("light:echo"))));
    await after(STOPPED_MS + 40);
    expect(shown).toEqual(["sharp:A"]);
    await after(STOPPED_MS + 40);
    expect(shown).toEqual(["sharp:A", "sharp:B"]);
    stream.stop();
});

test("stopped, or started again at another size: what was under way isn't shown after", async () => {
    const { stream, shown, onStill } = setup({ stillMs: 60 });
    stream.start();
    onStill(() => stream.stop());
    await after(STOPPED_MS + 80);
    stream.frame("light:late");
    await after(STOPPED_MS);
    expect(shown).toEqual([]);
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
