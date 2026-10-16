// The setup script's tickets (src/server/setup.ts) on their own, and what the
// New worktree dialog says about the script (gui/src/lib/setup.ts). The runs
// themselves are tested over RPC in gui-server.test.ts.

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";
import type { CreateWorktreeResult } from "../src/server/protocol";

const iso = isolate();
const { SETUP_TTL_MS, SetupTickets, checkGrant, setupTrusted } = await import("../src/server/setup");
const { trustFolder, trustForSession } = await import("../src/config/trust");
const { Engine } = await import("../src/server/engine");
const { Terminals } = await import("../src/server/terminals");
const { gitArgv, gitEnv } = await import("../src/util/git");
const { asksForSetup, setupNote, setupTabLabel } = await import("../gui/src/lib/setup");
afterAll(() => iso.cleanup());

const grant = (owner: object, path = "/repo/.claude/worktrees/x") => ({ owner, path, main: "/repo", project: "/repo", script: "s1", command: "bun install" });

describe("setup tickets", () => {
    test("single use, for the window that was given it, until they expire", () => {
        let now = 1_000;
        const tickets = new SetupTickets(() => now);
        const a = {};
        const b = {};
        const t1 = tickets.issue(grant(a));
        expect(t1).toMatch(/^[0-9a-f]{32}$/);
        expect(tickets.take(a, t1)).toMatchObject({ path: "/repo/.claude/worktrees/x", script: "s1", command: "bun install", expires: 1_000 + SETUP_TTL_MS });
        expect(() => tickets.take(a, t1)).toThrow(/already started/);
        const t2 = tickets.issue(grant(a));
        expect(() => tickets.take(b, t2)).toThrow(/another window/);
        expect(() => tickets.take(a, t2)).toThrow(/already started/);
        const t3 = tickets.issue(grant(a));
        now += SETUP_TTL_MS;
        expect(() => tickets.take(a, t3)).toThrow(/in time/);
        expect(tickets.size).toBe(0);
    });

    test("a window's tickets go when it does; there are never many, and stale ones are swept", () => {
        let now = 0;
        const tickets = new SetupTickets(() => now);
        const a = {};
        const b = {};
        const kept = tickets.issue(grant(b));
        for (let i = 0; i < 5; i++) tickets.issue(grant(a));
        tickets.drop(a);
        expect(tickets.size).toBe(1);
        expect(tickets.take(b, kept).owner).toBe(b);
        const issued = Array.from({ length: 100 }, () => tickets.issue(grant(a)));
        expect(tickets.size).toBe(32);
        expect(new Set(issued).size).toBe(100);
        // The oldest went first.
        expect(() => tickets.take(a, issued[0]!)).toThrow(/already started/);
        expect(tickets.take(a, issued[99]!).owner).toBe(a);
        now += SETUP_TTL_MS;
        tickets.issue(grant(a));
        expect(tickets.size).toBe(1);
    });

    test("anything but a ticket's shape is invalid", () => {
        const tickets = new SetupTickets();
        for (const bad of [undefined, null, 7, "", "abc", "A".repeat(32), "0".repeat(31), "0".repeat(33), {}]) {
            expect(() => tickets.take({}, bad)).toThrow(expect.objectContaining({ code: "invalid" }));
        }
    });
});

describe("checking a setup grant at use time", () => {
    test("requires the user's trust, for the main checkout or the new folder", () => {
        const root = realpathSync(mkdtempSync(join(iso.home, "trust-")));
        const main = join(root, "main");
        const path = join(root, "worktree");
        mkdirSync(main);
        mkdirSync(path);
        trustForSession(main);
        trustForSession(path);
        expect(setupTrusted(main, path)).toBe(false);
        trustFolder(path);
        expect(setupTrusted(main, path)).toBe(true);
        expect(setupTrusted(main, join(root, "other"))).toBe(false);
        trustFolder(main);
        expect(setupTrusted(main, join(root, "other"))).toBe(true);
    });

    test("rejects a changed script, project, cwd or folder; accepts the original grant", () => {
        const main = realpathSync(mkdtempSync(join(iso.home, "grant-")));
        const path = join(main, "worktree");
        mkdirSync(path);
        trustFolder(main);
        const g = { ...grant({}, path), main, project: main, expires: Date.now() + SETUP_TTL_MS };
        const script = { id: "s1", name: "install", command: "bun install", runOnWorktreeCreate: true };
        const found = { project: main, script };
        expect(() => checkGrant(g, path, found)).not.toThrow();
        expect(() => checkGrant(g, main, found)).toThrow(/only in the worktree/);
        expect(() => checkGrant(g, path, { ...found, project: "/another" })).toThrow(/isn't the project's setup script/);
        expect(() => checkGrant(g, path, { ...found, script: { ...script, id: "other" } })).toThrow(/isn't the project's setup script/);
        expect(() => checkGrant(g, path, { ...found, script: { ...script, runOnWorktreeCreate: false } })).toThrow(/no longer marked/);
        expect(() => checkGrant(g, path, { ...found, script: { ...script, command: "make" } })).toThrow(/command changed/);
        rmSync(path, { recursive: true });
        expect(() => checkGrant(g, path, found)).toThrow(/folder is gone/);
        mkdirSync(join(main, "replacement"));
        symlinkSync(join(main, "replacement"), path);
        expect(() => checkGrant(g, path, found)).toThrow(/folder is gone/);
    });
});

// Exercise the actual RPC dispatch and Git operations without a listening socket.
// Only the terminal boundary is replaced: the PTY/marker assertions live in gui-server.test.ts.
describe("setup RPC dispatch without sockets", () => {
    async function fixture(trusted = true) {
        const main = realpathSync(mkdtempSync(join(iso.home, "rpc-repo-")));
        for (const args of [["init", "-q", "-b", "main"], ["commit", "--allow-empty", "-qm", "Initial commit"]]) {
            const result = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Harness Test", "-c", "user.email=test@example.invalid", ...args]), {
                cwd: main, env: { ...gitEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe",
            });
            if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        }
        const engine = new Engine({});
        const client = { subs: new Set<string>(), send() {} };
        engine.clients.add(client);
        const opened = spyOn(Terminals.prototype, "open").mockImplementation((_owner, id, cwd) => ({ id, cwd }));
        if (trusted) await engine.handle(client, "projects.trust", { path: main, trust: true });
        const script = await engine.handle(client, "scripts.save", { cwd: main, name: "install", command: "touch setup-ran", runOnWorktreeCreate: true });
        let next = 0;
        return {
            main, engine, client, opened, script,
            create: (extra: Record<string, unknown> = { setup: true }) => engine.handle(client, "projects.createWorktree", { path: main, branch: `setup-${++next}`, ...extra }),
            run: (made: CreateWorktreeResult, owner = client) => engine.handle(owner, "scripts.run", { id: `terminal-${++next}`, cwd: made.path, script: script.id, cols: 80, rows: 24, setup: made.setup?.ticket }),
            close: async () => { opened.mockRestore(); await engine.stop(); },
        };
    }

    test("creates before opening a terminal, passes the command once, and keeps manual script runs unchanged", async () => {
        const f = await fixture();
        try {
            const made = await f.create();
            expect(made.setup?.script).toEqual(f.script);
            expect(f.opened).not.toHaveBeenCalled();
            await f.run(made);
            expect(f.opened).toHaveBeenCalledWith(f.client, expect.any(String), made.path, 80, 24, { input: "touch setup-ran\r" });
            expect((await f.engine.handle(f.client, "scripts.list", { cwd: f.main })).lastUsed).toBeUndefined();
            await expect(f.run(made)).rejects.toMatchObject({ code: "setup_refused" });
            expect(f.opened).toHaveBeenCalledTimes(1);
            await f.engine.handle(f.client, "scripts.run", { id: "manual", cwd: f.main, script: f.script.id, cols: 80, rows: 24 });
            expect(f.opened).toHaveBeenCalledTimes(2);
        } finally { await f.close(); }
    });

    test("omitted or false setup and automatic trust never grant a run", async () => {
        const f = await fixture(false);
        try {
            trustForSession(f.main);
            expect((await f.engine.handle(f.client, "projects.inspect", { path: f.main })).trusted).toBe(true);
            expect((await f.engine.handle(f.client, "scripts.setupInfo", { cwd: f.main })).trusted).toBe(false);
            const untrusted = await f.create();
            expect(untrusted.setup).toBeUndefined();
            expect(untrusted.setupError).toMatch(/haven't trusted/);
            await expect(f.engine.handle(f.client, "scripts.run", { id: "forged", cwd: untrusted.path, script: f.script.id, cols: 80, rows: 24, setup: "0".repeat(32) })).rejects.toMatchObject({ code: "setup_refused" });
            await f.engine.handle(f.client, "projects.trust", { path: f.main, trust: true });
            for (const extra of [{}, { setup: false }]) {
                const made = await f.create(extra);
                expect(made.setup).toBeUndefined();
                expect(made.setupError).toBeUndefined();
            }
            await f.engine.handle(f.client, "scripts.save", { cwd: f.main, ...f.script, runOnWorktreeCreate: false });
            expect((await f.create()).setup).toBeUndefined();
            expect(f.engine.setups.size).toBe(0);
            expect(f.opened).not.toHaveBeenCalled();
            // A deliberate click keeps its existing behavior, even without user trust.
            writeFileSync(join(iso.home, "trusted.json"), JSON.stringify({ dirs: [] }));
            await f.engine.handle(f.client, "scripts.run", { id: "clicked", cwd: f.main, script: f.script.id, cols: 80, rows: 24 });
            expect(f.opened).toHaveBeenCalledTimes(1);
        } finally { await f.close(); }
    });

    test("other connections, reconnects, expiration and changed scripts cannot reach the terminal", async () => {
        const f = await fixture();
        try {
            const other = { subs: new Set<string>(), send() {} };
            f.engine.clients.add(other);
            await expect(f.run(await f.create(), other)).rejects.toThrow(/another window/);
            const late = await f.create();
            f.engine.setups.now = () => Date.now() + SETUP_TTL_MS;
            await expect(f.run(late)).rejects.toThrow(/in time/);
            f.engine.setups.now = Date.now;
            const edited = await f.create();
            await f.engine.handle(f.client, "scripts.save", { cwd: f.main, ...f.script, command: "touch changed" });
            await expect(f.run(edited)).rejects.toThrow(/command changed/);
            const unmarked = await f.create();
            await f.engine.handle(f.client, "scripts.save", { cwd: f.main, ...f.script, runOnWorktreeCreate: false });
            await expect(f.run(unmarked)).rejects.toThrow(/no longer marked/);
            await f.engine.handle(f.client, "scripts.save", { cwd: f.main, ...f.script });
            const reconnected = await f.create();
            f.engine.dropClient(f.client);
            expect(f.engine.setups.size).toBe(0);
            await expect(f.run(reconnected, other)).rejects.toMatchObject({ code: "setup_refused" });
            expect(f.opened).not.toHaveBeenCalled();
        } finally { await f.close(); }
    });

    test("trust revocation and terminal failure preserve the created worktree; failures consume tickets", async () => {
        const f = await fixture();
        try {
            const revoked = await f.create();
            const file = join(iso.home, "trusted.json");
            const trusted = JSON.parse(readFileSync(file, "utf8")) as { dirs: string[] };
            writeFileSync(file, JSON.stringify({ dirs: trusted.dirs.filter((path) => path !== f.main) }));
            await expect(f.run(revoked)).rejects.toThrow(/isn't trusted/);
            expect(f.opened).not.toHaveBeenCalled();
            trustFolder(f.main);
            const full = await f.create();
            f.opened.mockImplementation(() => { throw new Error("Close a terminal before opening another"); });
            await expect(f.run(full)).rejects.toThrow(/Close a terminal/);
            await expect(f.run(full)).rejects.toMatchObject({ code: "setup_refused" });
            const listed = await f.engine.handle(f.client, "projects.worktrees", { path: f.main });
            for (const made of [revoked, full]) {
                expect(existsSync(made.path)).toBe(true);
                expect(listed.some((entry) => entry.path === made.path)).toBe(true);
            }
        } finally { await f.close(); }
    });

    test("invalid parameters create neither a worktree nor a terminal", async () => {
        const f = await fixture();
        try {
            for (const setup of [null, "true", 1, {}, []]) await expect(f.create({ setup })).rejects.toMatchObject({ code: "invalid" });
            for (const setup of [null, 1, "short", "g".repeat(32), "0".repeat(33)]) {
                await expect(f.engine.handle(f.client, "scripts.run", { id: "bad", cwd: f.main, script: f.script.id, cols: 80, rows: 24, setup })).rejects.toMatchObject({ code: "invalid" });
            }
            await expect(f.engine.handle(f.client, "scripts.save", { cwd: f.main, ...f.script, runOnWorktreeCreate: "true" })).rejects.toMatchObject({ code: "invalid" });
            for (const cwd of [7, "x".repeat(4097)]) await expect(f.engine.handle(f.client, "scripts.setupInfo", { cwd })).rejects.toMatchObject({ code: "invalid" });
            expect(await f.engine.handle(f.client, "projects.worktrees", { path: f.main })).toHaveLength(1);
            expect(f.opened).not.toHaveBeenCalled();
        } finally { await f.close(); }
    });

    test("inspection never starts setup, and unreadable scripts never undo creation", async () => {
        const f = await fixture();
        const file = join(iso.home, "scripts.json");
        const before = readFileSync(file, "utf8");
        try {
            const made = await f.create({});
            for (const path of [f.main, made.path]) {
                await f.engine.handle(f.client, "projects.inspect", { path });
                await f.engine.handle(f.client, "projects.worktrees", { path });
                await f.engine.handle(f.client, "scripts.setupInfo", { cwd: path });
            }
            expect(f.engine.setups.size).toBe(0);
            writeFileSync(file, "{broken");
            await expect(f.engine.handle(f.client, "scripts.setupInfo", { cwd: f.main })).rejects.toThrow();
            const broken = await f.create();
            expect(broken.setup).toBeUndefined();
            expect(broken.setupError).toBeTruthy();
            expect(existsSync(broken.path)).toBe(true);
            expect((await f.engine.handle(f.client, "projects.worktrees", { path: f.main })).some((entry) => entry.path === broken.path)).toBe(true);
            expect(f.opened).not.toHaveBeenCalled();
        } finally { writeFileSync(file, before); await f.close(); }
    });
});

describe("what the New worktree dialog says", () => {
    const script = { id: "s1", name: "install", command: "bun install && cp ../../../.env ." };

    test("runs, unless skipped, only for a marked script in a trusted repository", () => {
        expect(setupNote(undefined)).toEqual({ kind: "loading" });
        expect(setupNote({ main: "/repo", trusted: true })).toEqual({ kind: "none" });
        expect(setupNote({ main: "/repo", trusted: false })).toEqual({ kind: "none" });
        expect(setupNote({ main: "/repo", script, trusted: true })).toEqual({ kind: "runs", script });
        expect(setupNote({ main: "/repo", script, trusted: false })).toEqual({ kind: "untrusted", script, main: "/repo" });
        expect(setupNote({ main: "/repo", script, trusted: true }, "scripts.json is broken")).toEqual({ kind: "error", message: "scripts.json is broken" });
        expect(asksForSetup(setupNote({ main: "/repo", script, trusted: true }), false)).toBe(true);
        expect(asksForSetup(setupNote({ main: "/repo", script, trusted: true }), true)).toBe(false);
        for (const note of [setupNote(undefined), setupNote({ main: "/repo", trusted: true }), setupNote({ main: "/repo", script, trusted: false }), setupNote(undefined, "error")]) {
            expect(asksForSetup(note, false)).toBe(false);
        }
    });

    test("the tab is named after the worktree's folder", () => {
        expect(setupTabLabel("/repo/.claude/worktrees/feat-x")).toBe("Setup · feat-x");
        expect(setupTabLabel("/elsewhere/feat-y/")).toBe("Setup · feat-y");
    });
});
