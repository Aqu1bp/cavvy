import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findBin, inhibitorCommand, KeepAwake, type InhibitorSpawn } from "../src/agent/keep-awake";

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
/** Every command is found, where it's named. */
const anywhere = (bin: string) => bin;

describe("keep awake", () => {
    test("starts one inhibitor while anything works, and stops it when nothing does", () => {
        const f = fakeSpawner();
        const k = new KeepAwake({ platform: "darwin", pid: 4242, spawn: f.spawn, enabled: () => true, find: anywhere });
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
        const k = new KeepAwake({ platform: "linux", pid: 1, spawn: f.spawn, enabled: () => true, find: anywhere });
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
        const k = new KeepAwake({ platform: "darwin", pid: 1, spawn: f.spawn, enabled: () => on, find: anywhere });
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
        const k = new KeepAwake({ platform: "linux", pid: 1, spawn: (argv) => (spawns++, f.spawn(argv)), enabled: () => on, find: anywhere });
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
        const k = new KeepAwake({ platform: "linux", pid: 1, spawn: f.spawn, enabled: () => true, find: anywhere });
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
        const k = new KeepAwake({ platform: "darwin", pid: 1, spawn: f.spawn, enabled: () => true, find: anywhere });
        k.set("s", true);
        k.set("s", false);
        await tick();
        expect(k.available()).toBe(true);
        k.set("s", true);
        expect(f.running()).toHaveLength(1);
    });

    test("no command on this platform: unavailable, nothing started", () => {
        const f = fakeSpawner();
        const k = new KeepAwake({ platform: "win32", pid: 1, spawn: f.spawn, enabled: () => true, find: anywhere });
        k.set("s", true);
        expect(f.started).toHaveLength(0);
        expect(k.available()).toBe(false);
    });

    test("not found: unavailable, nothing started, and it says so", () => {
        const f = fakeSpawner();
        const logs: string[] = [];
        const k = new KeepAwake({ platform: "linux", pid: 1, spawn: f.spawn, enabled: () => true, find: () => undefined, log: (m) => logs.push(m) });
        expect(k.available()).toBe(false);
        k.set("s", true);
        expect(f.started).toHaveLength(0);
        expect(logs).toEqual(["Keeping the computer awake: systemd-inhibit isn't installed."]);
    });

    test("what's checked is what's run: the found paths", () => {
        const f = fakeSpawner();
        const found: string[] = [];
        const k = new KeepAwake({ platform: "linux", pid: 1, spawn: f.spawn, enabled: () => true, find: (b) => (found.push(b), `/found/${b}`) });
        expect(k.available()).toBe(true);
        k.set("s", true);
        expect(f.started[0]!.argv).toEqual(["/found/systemd-inhibit", "--what=idle:sleep", "--who=Cavvy", "--why=Agents are working", "--mode=block", "/found/cat"]);
        // Looked up once.
        expect(found).toEqual(["systemd-inhibit", "cat"]);
    });
});

describe("finding the inhibitor", () => {
    const tool = (dir: string, name: string, body = "#!/bin/sh\nexit 0\n", mode = 0o755) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, name), body);
        chmodSync(join(dir, name), mode);
        return join(dir, name);
    };

    test("the system's own copy first, else the first on PATH; a path as it is", () => {
        const root = mkdtempSync(join(tmpdir(), "cavvy-findbin-"));
        try {
            const system = join(root, "usr-bin");
            const login = join(root, "login-bin");
            const inLogin = tool(login, "systemd-inhibit");
            expect(findBin("systemd-inhibit", { dirs: [system], PATH: login })).toBe(inLogin);
            const inSystem = tool(system, "systemd-inhibit");
            expect(findBin("systemd-inhibit", { dirs: [system], PATH: login })).toBe(inSystem);
            // Not executable: not it.
            tool(join(root, "other"), "plain", "x", 0o644);
            expect(findBin("plain", { dirs: [join(root, "other")], PATH: "" })).toBeUndefined();
            expect(findBin(inLogin)).toBe(inLogin);
            expect(findBin(join(root, "nope"))).toBeUndefined();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("only on the PATH adopted after start (the login shell's): found, and that one runs", async () => {
        const root = mkdtempSync(join(tmpdir(), "cavvy-findbin-"));
        const PATH = process.env.PATH;
        try {
            const marker = join(root, "ran");
            // Stands in for systemd-inhibit: notes it ran, then holds like it does until its stdin closes.
            tool(join(root, "login-bin"), "systemd-inhibit", `#!/bin/sh\necho "$@" > "${marker}"\nexec cat\n`);
            process.env.PATH = `${join(root, "login-bin")}:${PATH}`;
            const k = new KeepAwake({ platform: "linux", pid: 1, enabled: () => true, find: (b) => findBin(b, { dirs: b === "cat" ? undefined : [] }) });
            expect(k.available()).toBe(true);
            k.set("s", true);
            expect(k.holding).toBe(true);
            for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(20);
            expect(existsSync(marker)).toBe(true);
            k.set("s", false);
            expect(k.holding).toBe(false);
        } finally {
            process.env.PATH = PATH;
            rmSync(root, { recursive: true, force: true });
        }
    });
});
