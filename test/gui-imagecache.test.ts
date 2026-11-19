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

    test("peeking asks for nothing and keeps the order", async () => {
        const c = new ImageCache(2);
        const asked: string[] = [];
        const load = (k: string) => () => (asked.push(k), Promise.resolve([k]));
        expect(c.peek("a")).toBeUndefined();
        await c.get("a", load("a"));
        await c.get("b", load("b"));
        expect(await c.peek("a")).toEqual(["a"]);
        await c.get("c", load("c")); // still drops a: peeking didn't make it recent
        expect(c.peek("a")).toBeUndefined();
        expect(asked).toEqual(["a", "b", "c"]);
    });

    test("bounded by size too: the least recently used goes until the rest fit, the newest stays", async () => {
        const c = new ImageCache<string>(10, 10, (v) => v.length);
        const asked: string[] = [];
        const load = (v: string) => () => (asked.push(v), Promise.resolve([v]));
        await c.get("a", load("aaaa"));
        await c.get("b", load("bbbb"));
        await c.get("a", load("aaaa")); // a is now the most recent
        await c.get("c", load("cccc")); // 12 > 10: drops b
        expect(c.size).toBe(2);
        expect(c.peek("b")).toBeUndefined();
        await c.get("d", load("d".repeat(20))); // over on its own: the rest go, it stays
        expect(c.size).toBe(1);
        expect(await c.peek("d")).toEqual(["d".repeat(20)]);
        await c.get("a", load("aaaa")); // asked again; d goes
        expect(c.peek("d")).toBeUndefined();
        expect(asked).toEqual(["aaaa", "bbbb", "cccc", "d".repeat(20), "aaaa"]);
    });

    test("an older load that ends late doesn't push out newer ones", async () => {
        const cache = new ImageCache<string>(10, 10, (v) => v.length);
        let finish!: (v: string[]) => void;
        const slow = cache.get("old", () => new Promise((r) => (finish = r)));
        await cache.get("new", async () => ["12345"]);
        finish(["123456789"]);
        await slow;
        await Promise.resolve();
        expect(cache.peek("new")).toBeDefined();
        expect(cache.peek("old")).toBeUndefined();
    });

    test("a failure frees nothing it didn't hold", async () => {
        const c = new ImageCache<string>(10, 10, (v) => v.length);
        await c.get("a", () => Promise.resolve(["aaaaaa"]));
        await expect(c.get("x", () => Promise.reject(new Error("gone")))).rejects.toThrow("gone");
        await Bun.sleep(0);
        await c.get("b", () => Promise.resolve(["bbbb"]));
        expect(c.size).toBe(2);
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
