import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, realpathSync, utimesSync, writeFileSync } from "fs";
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
        // No Git dir to mark in: settling waits a fixed moment, which an event can outlast (one in hundreds, just
        // after a watch starts, on a Mac). It comes in a later one: what's checked is that it comes, not when.
        for (let i = 0; i < 40 && !w.changedSince(gen)?.includes("a/b/file.txt"); i++) await w.settle(50);
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

test("in a repository, settling waits for the watch to have seen everything until now, not for a guessed time", async () => {
    const root = join(realpathSync(iso.home), "repo");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    // A marker a stopped process left behind (it ended between writing and removing it).
    writeFileSync(join(root, ".git", "cavvy-watch-sync-1-1-1"), "");
    utimesSync(join(root, ".git", "cavvy-watch-sync-1-1-1"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const w = acquireWatch(root);
    try {
        await w.ready;
        expect(w.healthy).toBe(true);
        expect(readdirSync(join(root, ".git")), "a stale marker is cleared as the watch starts").toEqual([]);
        for (let i = 0; i < 20; i++) {
            const gen = w.gen;
            writeFileSync(join(root, "src", `f${i}.ts`), String(i));
            // No time allowed for the event to come: the sync's own marker, seen after it, is what it waits for.
            await w.settle(0);
            expect(w.changedSince(gen)).toContain(`src/f${i}.ts`);
        }
        expect(w.healthy).toBe(true);
        // The markers are gone again, and none of them was taken for a change.
        expect(readdirSync(join(root, ".git"))).toEqual([]);
        const gen = w.gen;
        await w.settle(0);
        expect(w.gen).toBe(gen);
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

test("a Bun whose watch can leave changes out isn't relied on", async () => {
    const { watchTrusted, WATCH_FROM_BUN } = await import("../src/agent/folder-watch");
    expect(watchTrusted(WATCH_FROM_BUN)).toBe(true);
    expect(watchTrusted("1.5.0")).toBe(true);
    expect(watchTrusted("1.3.14")).toBe(false);
    expect(watchTrusted("1.4.3")).toBe(false);
    // The one running the tests (CI's, the packaged app's) is relied on: what's above tests the watch itself.
    expect(watchTrusted()).toBe(true);
});
