import { describe, expect, test } from "bun:test";
import { inhibitorCommand, KeepAwake, type InhibitorSpawn } from "../src/agent/keep-awake";

/** A spawner that records what it started, each started one ending when told to (or by itself, via end()). */
function fakeSpawner(o: { missing?: boolean } = {}) {
    const started: { argv: string[]; stopped: boolean; end: () => void }[] = [];
    const spawn: InhibitorSpawn = (argv) => {
        if (o.missing) throw new Error("ENOENT");
        let end!: () => void;
        const exited = new Promise<void>((r) => (end = r));
        const p = { argv, stopped: false, end };
        started.push(p);
        return {
            exited,
            stop() {
                p.stopped = true;
                end();
            },
        };
    };
    return { spawn, started, running: () => started.filter((p) => !p.stopped) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("keep awake", () => {
    test("starts one inhibitor while anything works, and stops it when nothing does", () => {
        const f = fakeSpawner();
        const k = new KeepAwake({ platform: "darwin", pid: 4242, spawn: f.spawn, enabled: () => true });
        const a = {};
        const b = {};
        k.set(a, true);
        expect(f.started.map((p) => p.argv)).toEqual([["/usr/bin/caffeinate", "-i", "-w", "4242"]]);
        k.set(b, true);
        k.set(a, true);
        expect(f.started).toHaveLength(1);
        k.set(a, false);
        expect(f.running()).toHaveLength(1);
        k.set(b, false);
        expect(f.running()).toHaveLength(0);
        expect(k.holding).toBe(false);
        // Working again: a new one.
        k.set(a, true);
        expect(f.started).toHaveLength(2);
        expect(k.holding).toBe(true);
        k.releaseAll([a, b]);
        expect(f.running()).toHaveLength(0);
    });

    test("a session going idle that wasn't working changes nothing", () => {
        const f = fakeSpawner();
        const k = new KeepAwake({ platform: "linux", pid: 1, spawn: f.spawn, enabled: () => true });
        k.set("x", false);
        expect(f.started).toHaveLength(0);
    });

    test("Linux holds a systemd-inhibit lock on idle and sleep", () => {
        expect(inhibitorCommand("linux", 7)).toEqual(["systemd-inhibit", "--what=idle:sleep", "--who=Cavvy", "--why=Agents are working", "--mode=block", "cat"]);
        expect(inhibitorCommand("win32", 7)).toBeUndefined();
    });

    test("off in settings: nothing starts; turned on while working, it starts; off again, it stops", () => {
        const f = fakeSpawner();
        let on = false;
        const k = new KeepAwake({ platform: "darwin", pid: 1, spawn: f.spawn, enabled: () => on });
        k.set("s", true);
        expect(f.started).toHaveLength(0);
        on = true;
        k.refresh();
        expect(f.running()).toHaveLength(1);
        on = false;
        k.refresh();
        expect(f.running()).toHaveLength(0);
    });

    test("not installed: no crash, unavailable, not tried again until the setting is turned off and on", () => {
        const f = fakeSpawner({ missing: true });
        let on = true;
        let spawns = 0;
        const k = new KeepAwake({ platform: "linux", pid: 1, spawn: (argv) => (spawns++, f.spawn(argv)), enabled: () => on, installed: () => true });
        k.set("s", true);
        expect(k.available()).toBe(false);
        k.set("s", false);
        k.set("s", true);
        expect(spawns).toBe(1);
        on = false;
        k.refresh();
        on = true;
        k.refresh();
        expect(spawns).toBe(2);
    });

    test("refused (it ends by itself): unavailable, and not started again", async () => {
        const f = fakeSpawner();
        const k = new KeepAwake({ platform: "linux", pid: 1, spawn: f.spawn, enabled: () => true, installed: () => true });
        k.set("s", true);
        expect(k.available()).toBe(true);
        f.started[0]!.end();
        await tick();
        expect(k.holding).toBe(false);
        expect(k.available()).toBe(false);
        k.set("s", false);
        k.set("s", true);
        expect(f.started).toHaveLength(1);
    });

    test("stopped on purpose isn't taken for refused", async () => {
        const f = fakeSpawner();
        const k = new KeepAwake({ platform: "darwin", pid: 1, spawn: f.spawn, enabled: () => true, installed: () => true });
        k.set("s", true);
        k.set("s", false);
        await tick();
        expect(k.available()).toBe(true);
        k.set("s", true);
        expect(f.running()).toHaveLength(1);
    });

    test("no command on this platform: unavailable, nothing started", () => {
        const f = fakeSpawner();
        const k = new KeepAwake({ platform: "win32", pid: 1, spawn: f.spawn, enabled: () => true, installed: () => true });
        k.set("s", true);
        expect(f.started).toHaveLength(0);
        expect(k.available()).toBe(false);
    });
});
