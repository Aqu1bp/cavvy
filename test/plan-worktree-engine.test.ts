// Exercise the real RPC dispatch and Git operations without opening a listening socket.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";
import type { ArchiveOffer, ArchiveResult, ImplementPlanResult, SessionSnapshot } from "../src/server/protocol";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { Session } = await import("../src/agent/session");
const { gitArgv, gitEnv } = await import("../src/util/git");
const { trustFolder } = await import("../src/config/trust");
const { isInside } = await import("../src/util/files");
afterAll(() => iso.cleanup());

test("containment accepts dot-prefixed directory names while rejecting parent and sibling escapes", () => {
    const parent = join(iso.home, "repo");
    for (const sub of ["", "..app", "..app/src", "nested/..app"]) expect(isInside(join(parent, sub), parent)).toBe(true);
    for (const sub of ["..", "../outside", "../repo-sibling", "..app/../../outside"]) expect(isInside(join(parent, sub), parent)).toBe(false);
});

function git(cwd: string, ...args: string[]) {
    const r = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe", timeout: 5000 });
    if (r.exitCode) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
}
function repo(name: string, remote = true) {
    const main = join(realpathSync(iso.home), name);
    mkdirSync(main);
    writeFileSync(join(main, "README.md"), "base\n");
    git(main, "init", "-q", "-b", "main");
    git(main, "add", ".");
    git(main, "commit", "-qm", "initial");
    if (remote) {
        const bare = join(realpathSync(iso.home), `${name}.git`);
        git(main, "init", "-q", "--bare", bare);
        git(main, "remote", "add", "origin", bare);
        git(main, "push", "-q", "origin", "main");
    }
    return main;
}
async function setup(name: string, remote = true) {
    const main = repo(name, remote);
    const engine = new Engine({ listModels: async () => [] });
    const client = { subs: new Set<string>(), send: () => {} };
    engine.clients.add(client);
    const made = await engine.handle(client, "projects.createWorktree", { path: main, branch: `wt-${name}` }) as { path: string; branch: string };
    const snap = await engine.handle(client, "session.create", { cwd: made.path }) as SessionSnapshot;
    const id = snap.state.id;
    const rt = engine.runtimes.get(id)!;
    rt.session.push({ role: "user", content: [{ type: "text", text: "hello" }] });
    const call = <T = any>(method: string, params = {}) => engine.handle(client, method, { id, ...params }) as Promise<T>;
    return { main, engine, client, rt, id, wt: made.path, branch: made.branch, call };
}

describe("archive worktree RPCs without sockets", () => {
    test("clean pushed worktree is removed, branch retained, Undo cannot reopen its missing folder", async () => {
        const s = await setup("clean");
        try {
            expect(await s.call<ArchiveOffer>("session.archiveOffer")).toMatchObject({ removable: true });
            const removing = s.call<ArchiveResult>("session.archive", { archived: true, removeWorktree: true });
            await expect(s.call("session.archive", { archived: true, removeWorktree: true })).rejects.toMatchObject({ code: "busy" });
            expect(await removing).toMatchObject({ archived: true, removed: true, closed: true });
            expect(existsSync(s.wt)).toBe(false);
            expect(git(s.main, "branch", "--list", s.branch)).toContain(s.branch);
            await s.call("session.archive", { archived: false });
            await expect(s.call("session.open")).rejects.toMatchObject({ code: "folder_missing" });
        } finally { await s.engine.stop(); }
    });

    for (const kind of ["dirty", "unpushed", "no-remote"] as const) test(`${kind} is archived but kept with a reason`, async () => {
        const s = await setup(kind, kind !== "no-remote");
        try {
            if (kind !== "no-remote") writeFileSync(join(s.wt, "README.md"), "changed\n");
            if (kind === "unpushed") {
                git(s.wt, "add", ".");
                git(s.wt, "commit", "-qm", "local");
            }
            const result = await s.call<ArchiveResult>("session.archive", { archived: true, removeWorktree: true });
            expect(result).toMatchObject({ archived: true, removed: false, code: kind === "dirty" ? "dirty" : "unpushed" });
            if (result.archived) expect(result.kept).toContain(kind === "no-remote" ? "no remote" : kind === "dirty" ? "uncommitted or untracked" : "isn't on any remote");
            expect(existsSync(s.wt)).toBe(true);
        } finally { await s.engine.stop(); }
    });

    test("ignored files require the exact current token", async () => {
        const s = await setup("ignored");
        try {
            // Per-repository excludes avoid modifying a tracked file.
            writeFileSync(join(s.main, ".git", "info", "exclude"), "*.cache\n");
            writeFileSync(join(s.wt, "first.cache"), "cached");
            const first = await s.call<ArchiveResult>("session.archive", { archived: true, removeWorktree: true });
            expect(first).toMatchObject({ archived: false, ignored: ["first.cache"] });
            if (first.archived) throw new Error("expected confirmation");
            writeFileSync(join(s.wt, "second.cache"), "cached too");
            const second = await s.call<ArchiveResult>("session.archive", { archived: true, removeWorktree: true, deleteIgnored: first.confirm });
            expect(second).toMatchObject({ archived: false, ignored: ["first.cache", "second.cache"] });
            if (second.archived) throw new Error("expected updated confirmation");
            expect(await s.call("session.archive", { archived: true, removeWorktree: true, deleteIgnored: second.confirm })).toMatchObject({ removed: true });
        } finally { await s.engine.stop(); }
    });

    test("shared old sessions beyond the sidebar limit keep the worktree", async () => {
        const s = await setup("old-shared");
        try {
            const old = Session.create(s.wt);
            old.push({ role: "user", content: [{ type: "text", text: "old shared" }] });
            old.setTitle("Old shared work");
            old.release();
            // More than a sidebar page of newer sessions, in a different folder.
            for (let i = 0; i < 1001; i++) {
                const other = Session.create(s.main);
                other.push({ role: "user", content: [{ type: "text", text: `recent ${i}` }] });
                other.release();
            }
            expect(s.engine.listSessions(1000).some((x) => x.id === old.meta.id)).toBe(false);
            expect(await s.call<ArchiveOffer>("session.archiveOffer")).toMatchObject({ removable: false, reason: "“Old shared work” also works in this worktree, so it stays." });
        } finally { await s.engine.stop(); }
    });

    test("restoring another session while the archived runtime closes prevents removal", async () => {
        const s = await setup("restore-race");
        try {
            const other = Session.create(s.wt);
            other.push({ role: "user", content: [{ type: "text", text: "shared" }] });
            other.release();
            await s.call("session.archive", { id: other.meta.id, archived: true });
            const close = s.rt.close.bind(s.rt);
            s.rt.close = async () => {
                await s.call("session.archive", { id: other.meta.id, archived: false });
                await close();
            };
            expect(await s.call("session.archive", { archived: true, removeWorktree: true })).toMatchObject({ removed: false, code: "shared" });
            expect(existsSync(s.wt)).toBe(true);
        } finally { await s.engine.stop(); }
    });

    test("another window and a running session keep the worktree", async () => {
        const s = await setup("held");
        try {
            const window = { subs: new Set([s.id]), send: () => {} };
            s.engine.clients.add(window);
            expect(await s.call<ArchiveOffer>("session.archiveOffer")).toMatchObject({ removable: false, reason: expect.stringContaining("another window") });
            s.engine.clients.delete(window);
            s.rt.busy = true;
            expect(await s.call("session.archive", { archived: true, removeWorktree: true })).toMatchObject({ removed: false, code: "running" });
            s.rt.busy = false;
            expect(existsSync(s.wt)).toBe(true);
        } finally { await s.engine.stop(); }
    });

    test("trust refusal leaves the archive pending and can be retried", async () => {
        const s = await setup("trust");
        try {
            git(s.main, "config", "filter.test.clean", "cat");
            expect(await s.call<ArchiveOffer>("session.archiveOffer")).toMatchObject({ removable: true });
            await expect(s.call("session.archive", { archived: true, removeWorktree: true })).rejects.toMatchObject({ code: "needs_trust" });
            expect(s.engine.listSessions().some((x) => x.id === s.id)).toBe(true);
            trustFolder(s.wt);
            expect(await s.call("session.archive", { archived: true, removeWorktree: true })).toMatchObject({ removed: true });
        } finally { await s.engine.stop(); }
    });
});

for (const sub of ["src", "..app", "nested/..app"]) test(`implementing from ${sub} preserves real subfolders but cannot follow a checked-out symlink outside the new worktree`, async () => {
    const main = repo(`subfolder-plan-${sub.replaceAll("/", "-")}`);
    const outside = join(realpathSync(iso.home), "external-folder");
    mkdirSync(outside, { recursive: true });
    let base: string | undefined;
    if (sub === "src") {
        symlinkSync(outside, join(main, sub));
        git(main, "add", sub);
        git(main, "commit", "-qm", "symlink base");
        base = git(main, "rev-parse", "HEAD");
        git(main, "rm", sub);
    }
    // The planning branch's src is now a real folder; the requested base still has the symlink.
    mkdirSync(join(main, sub), { recursive: true });
    writeFileSync(join(main, sub, "file.ts"), "source\n");
    git(main, "add", ".");
    git(main, "commit", "-qm", "real source");
    base ??= git(main, "rev-parse", "HEAD");
    const engine = new Engine({ listModels: async () => [] });
    const client = { subs: new Set<string>(), send: () => {} };
    engine.clients.add(client);
    try {
        const rt = await engine.createSession(join(main, sub), { mode: "plan" });
        rt.session.push({ role: "user", content: [{ type: "text", text: "plan" }] });
        rt.session.addPlan("plan-id", "# Build feature\nImplement it");
        rt.session.model = "test:model";
        rt.model = { provider: "test", id: "model", supportsFastMode: true };
        rt.setEffort("high");
        rt.setFastMode(true);
        const create = engine.createSession.bind(engine);
        let prompt = "";
        engine.createSession = async (...args) => {
            const next = await create(...args);
            next.setModel = async (ref) => {
                expect(ref).toBe("test:model");
                next.model = { provider: "test", id: "model", supportsFastMode: true };
                next.session.setModel(ref);
                return true;
            };
            next.send = async (text) => {
                prompt = text;
                next.session.push({ role: "user", content: [{ type: "text", text }] });
                return { queued: false };
            };
            return next;
        };
        const result = await engine.handle(client, "session.implementPlan", { id: rt.id, branch: "implementation", base, mode: "acceptEdits" }) as ImplementPlanResult;
        expect(result.failed).toBeUndefined();
        const next = engine.runtimes.get(result.sessionId!)!;
        expect(next.ws.cwd).toBe(sub === "src" ? result.path : join(result.path, sub));
        expect(next.mode).toBe("acceptEdits");
        expect(next.settings().effort).toBe("high");
        expect(next.fastModeEnabled()).toBe(true);
        expect(next.session.model).toBe("test:model");
        expect(prompt).toContain("# Build feature");
        expect(prompt).toContain(base);
        // Both links name the plan they're for: the session can have presented others.
        expect(next.session.planLinks[0]).toMatchObject({ role: "from", session: rt.id, plan: "plan-id" });
        expect(rt.session.planLinks[0]).toMatchObject({ role: "to", session: next.id, plan: "plan-id" });
        expect(readFileSync(join(main, sub, "file.ts"), "utf8")).toBe("source\n");
    } finally { await engine.stop(); }
});

test("a trust retry retains the selected base in both session links and the implementation prompt", async () => {
    const main = repo("retry-base");
    const source = join(main, "src");
    mkdirSync(join(source, ".cavvy"), { recursive: true });
    writeFileSync(join(source, ".cavvy", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "true" }] }] } }));
    git(main, "add", ".");
    git(main, "commit", "-qm", "project config");
    git(main, "branch", "release-v2");
    trustFolder(source);
    const engine = new Engine({ listModels: async () => [] });
    const client = { subs: new Set<string>(), send() {} };
    engine.clients.add(client);
    try {
        const rt = await engine.createSession(source, { mode: "plan" });
        rt.session.addPlan("plan-id", "# Implement the release");
        rt.session.model = "test:model";
        const create = engine.createSession.bind(engine);
        let prompt = "";
        engine.createSession = async (...args) => {
            const next = await create(...args);
            next.setModel = async () => true;
            next.send = async (text) => { prompt = text; return { queued: false }; };
            return next;
        };
        const params = { id: rt.id, branch: "implementation", base: "release-v2", mode: "default" };
        const first = await engine.handle(client, "session.implementPlan", params) as ImplementPlanResult;
        expect(first.failed).toMatchObject({ code: "needs_trust", folder: join(first.path, "src") });
        expect(first.sessionId).toBeUndefined();
        await engine.handle(client, "projects.trust", { path: first.failed!.folder, trust: true });
        const retry = await engine.handle(client, "session.implementPlan", { ...params, resume: first.path }) as ImplementPlanResult;
        expect(retry.failed).toBeUndefined();
        expect(retry.path).toBe(first.path);
        const next = engine.runtimes.get(retry.sessionId!)!;
        expect(rt.session.planLinks).toMatchObject([{ role: "to", base: "release-v2" }]);
        expect(next.session.planLinks).toMatchObject([{ role: "from", base: "release-v2" }]);
        expect(prompt).toContain("release-v2");
        expect(git(retry.path, "rev-parse", "HEAD")).toBe(git(main, "rev-parse", "release-v2"));
    } finally { await engine.stop(); }
});

test("projects.removeWorktree keeps a worktree an idle terminal session is in (no session lock yet)", async () => {
    const main = repo("present");
    const engine = new Engine({ listModels: async () => [] });
    const client = { subs: new Set<string>(), send: () => {} };
    const made = await engine.handle(client, "projects.createWorktree", { path: main, branch: "wt-present" }) as { path: string };
    // A `cavvy -w` in a terminal that hasn't sent anything: only its presence mark.
    const script = `const { markPresent } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/worktrees.ts"))}); if (!markPresent(process.argv[1])) process.exit(2); console.log("ready"); await Bun.sleep(30000);`;
    const other = Bun.spawn([process.execPath, "-e", script, made.path], { stdout: "pipe" });
    try {
        expect(new TextDecoder().decode((await other.stdout.getReader().read()).value)).toContain("ready");
        await expect(engine.handle(client, "projects.removeWorktree", { path: main, worktree: made.path })).rejects.toMatchObject({ code: "in_use" });
        expect(existsSync(made.path)).toBe(true);
    } finally {
        other.kill();
        await other.exited;
    }
    expect(await engine.handle(client, "projects.removeWorktree", { path: main, worktree: made.path })).toMatchObject({ removed: true });
});

test("GUI removal asks again just before Git removes it: a terminal session that opened during the checks keeps it", async () => {
    const main = repo("late-present");
    const engine = new Engine({ listModels: async () => [] });
    const client = { subs: new Set<string>(), send: () => {} };
    const made = await engine.handle(client, "projects.createWorktree", { path: main, branch: "wt-late" }) as { path: string };
    const script = `const { markPresent } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/worktrees.ts"))}); if (!markPresent(process.argv[1])) process.exit(2); console.log("ready"); await Bun.sleep(30000);`;
    let other: ReturnType<typeof Bun.spawn> | undefined;
    try {
        // The caller's own last checks run after the plan: a `cavvy -w` starts there meanwhile.
        const removing = (engine as any).removeWorktree(main, made.path, undefined, async () => {
            other = Bun.spawn([process.execPath, "-e", script, made.path], { stdout: "pipe" });
            expect(new TextDecoder().decode((await (other.stdout as ReadableStream<Uint8Array>).getReader().read()).value)).toContain("ready");
        });
        await expect(removing).rejects.toMatchObject({ code: "in_use" });
        expect(existsSync(made.path)).toBe(true);
    } finally {
        other?.kill();
        await other?.exited;
    }
});
