// The GUI's image cache (gui/src/lib/imagecache.ts): each image asked for once
// while it's kept, failures never kept, the least recently used dropped first.

import { describe, expect, test } from "bun:test";
import { ImageCache, promptKey } from "../gui/src/lib/imagecache";

describe("ImageCache", () => {
    test("the same key is asked for once", async () => {
        const c = new ImageCache(4);
        let asked = 0;
        const load = () => (asked++, Promise.resolve(["a"]));
        expect(await c.get("k", load)).toEqual(["a"]);
        expect(await c.get("k", load)).toEqual(["a"]);
        expect(asked).toBe(1);
    });

    test("a failure isn't kept: the next request asks again", async () => {
        const c = new ImageCache(4);
        await expect(c.get("k", () => Promise.reject(new Error("gone")))).rejects.toThrow("gone");
        await Bun.sleep(0);
        expect(await c.get("k", () => Promise.resolve(["b"]))).toEqual(["b"]);
    });

    test("bounded: the least recently used goes first", async () => {
        const c = new ImageCache(2);
        const asked: string[] = [];
        const load = (k: string) => () => (asked.push(k), Promise.resolve([k]));
        await c.get("a", load("a"));
        await c.get("b", load("b"));
        await c.get("a", load("a")); // a is now the most recent
        await c.get("c", load("c")); // drops b
        expect(c.size).toBe(2);
        await c.get("a", load("a"));
        await c.get("b", load("b"));
        expect(asked).toEqual(["a", "b", "c", "b"]);
    });
});

describe("what makes an image the same image", () => {
    test("a prompt rewound and sent again at the same position is another turn, so it's asked for again", async () => {
        const c = new ImageCache(4);
        const pos = { seg: 0, index: 3 };
        expect(promptKey("s", { id: "t1", pos })).not.toBe(promptKey("s", { id: "t9", pos }));
        expect(await c.get(promptKey("s", { id: "t1", pos }), () => Promise.resolve(["A"]))).toEqual(["A"]);
        expect(await c.get(promptKey("s", { id: "t9", pos }), () => Promise.resolve(["B"]))).toEqual(["B"]);
        expect(await c.get(promptKey("s", { id: "t1", pos }), () => Promise.resolve(["X"]))).toEqual(["A"]);
    });

    test("the same turn in another session, or at another position, is another key", () => {
        const pos = { seg: 0, index: 3 };
        expect(promptKey("s1", { id: "t", pos })).not.toBe(promptKey("s2", { id: "t", pos }));
        expect(promptKey("s", { id: "t", pos })).not.toBe(promptKey("s", { id: "t", pos: { seg: 1, index: 3 } }));
    });
});
