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
    test("prompts are kept by the server's hash of their images, not by turn or position", async () => {
        // A rewind reuses positions and a reopen reuses turn ids; the hash changes only with the images.
        const c = new ImageCache(4);
        expect(await c.get(promptKey("s", "hashA"), () => Promise.resolve(["A"]))).toEqual(["A"]);
        expect(await c.get(promptKey("s", "hashB"), () => Promise.resolve(["B"]))).toEqual(["B"]);
        expect(await c.get(promptKey("s", "hashA"), () => Promise.resolve(["X"]))).toEqual(["A"]);
        expect(promptKey("s1", "h")).not.toBe(promptKey("s2", "h"));
    });
});
