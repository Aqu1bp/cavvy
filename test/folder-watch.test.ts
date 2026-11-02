import { afterAll, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { acquireWatch, releaseWatch } = await import("../src/agent/folder-watch");
afterAll(() => iso.cleanup());

test("a watch kept on its worker is relied on once it's started, and has what changed once settled", async () => {
    const root = join(realpathSync(iso.home), "watched");
    mkdirSync(join(root, "a/b"), { recursive: true });
    const w = acquireWatch(root);
    try {
        // Not started yet: not relied on, and not taken for failed either.
        expect(w.healthy).toBe(false);
        expect(w.broken).toBe(false);
        await w.ready;
        expect(w.healthy).toBe(true);
        const gen = w.gen;
        // What was before it started isn't told apart: looked at whole.
        expect(w.changedSince(gen - 1)).toBeUndefined();
        writeFileSync(join(root, "a/b/file.txt"), "x");
        await w.settle(30);
        expect(w.gen).toBeGreaterThan(gen);
        expect(w.changedSince(gen)).toContain("a/b/file.txt");
        // The same watch for the same folder.
        const again = acquireWatch(root);
        expect(again).toBe(w);
        releaseWatch(again);
    } finally {
        releaseWatch(w);
    }
});

test("a folder that can't be watched says so, and is let go of for one started afresh", async () => {
    const w = acquireWatch(join(iso.home, "not-there"));
    await w.ready;
    expect(w.healthy).toBe(false);
    expect(w.broken).toBe(true);
    // Settling doesn't wait for a worker that has nothing to say.
    await w.settle(10);
    const next = acquireWatch(join(iso.home, "not-there"));
    expect(next).not.toBe(w);
    releaseWatch(next);
    releaseWatch(w);
});
