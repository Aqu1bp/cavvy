// Taking a plan to a new worktree, saving it, and archiving a session along
// with its managed worktree: a real server and WebSocket, the mock model
// (scripts/mock-llm.ts) presenting the plan, and temporary Git repositories.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { startServer } = await import("../src/server/server");
const { applyOp } = await import("../src/server/timeline");
const { startMockLlm } = await import("../scripts/mock-llm");
const { gitArgv, gitEnv } = await import("../src/util/git");
const { trustFolder } = await import("../src/config/trust");
import type { ArchiveOffer, ArchiveResult, ImplementPlanResult, PlanInfo, PlanInteraction, SessionSnapshot, SessionState, ToolBlock, Turn } from "../src/server/protocol";

const TOKEN = "test-token-plan-worktree";
const mock = startMockLlm({ delayMs: 0 });
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));

let srv: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
    srv = await startServer({ token: TOKEN, unloadAfterMs: 200 });
});
// Each test waits for the turns it stops to end before its client goes, so the server has nothing live to stop here
// (about 50 ms). A turn still running would be stopped and waited for (Runtime.close waits 3 s for it, then its hooks),
// which a loaded runner has taken past Bun's 5 s hook limit (#7): the budget covers that too, so a slow stop is slow, not a failure.
afterAll(async () => {
    await srv.stop();
    mock.stop();
    iso.cleanup();
}, { timeout: 30_000 });

type View = { state: SessionState; turns: Turn[]; seq: number; agents: [] };

class Client {
    ws: WebSocket;
    private next = 1;
    private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    views = new Map<string, View>();
    private listeners = new Set<() => void>();
    constructor() {
        this.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["cavvy.v1", `auth.${TOKEN}`] } as any);
        this.ws.onmessage = (m) => {
            const msg = JSON.parse(String(m.data));
            if ("event" in msg) {
                const ev = msg.event;
                if (ev.type === "session.ops") {
                    const v = this.views.get(ev.sessionId);
                    if (v && ev.seq > v.seq) {
                        for (const op of ev.ops) applyOp(v as any, op);
                        v.seq = ev.seq;
                    }
                }
                for (const l of this.listeners) l();
                return;
            }
            const w = this.waiting.get(msg.id);
            this.waiting.delete(msg.id);
            if (msg.error) w?.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, folder: msg.error.folder }));
            else w?.resolve(msg.result);
        };
    }
    opened(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ws.onopen = () => resolve();
            this.ws.onerror = () => reject(new Error("connection failed"));
        });
    }
    call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        const id = this.next++;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    }
    async open(method: "session.create" | "session.open", params: Record<string, unknown>): Promise<string> {
        const snap = await this.call<SessionSnapshot>(method, params);
        this.views.set(snap.state.id, { state: snap.state, turns: snap.turns, agents: [], seq: snap.seq });
        return snap.state.id;
    }
    view(id: string) {
        return this.views.get(id)!;
    }
    until(id: string, pred: (v: View) => boolean, ms = 10_000): Promise<void> {
        return new Promise((resolve, reject) => {
            const check = () => {
                const v = this.views.get(id);
                if (v && pred(v)) {
                    this.listeners.delete(check);
                    clearTimeout(t);
                    resolve();
                }
            };
            const t = setTimeout(() => {
                this.listeners.delete(check);
                reject(new Error(`timed out: ${JSON.stringify(this.views.get(id)?.state.status)}`));
            }, ms);
            this.listeners.add(check);
            check();
        });
    }
    close() {
        this.ws.close();
    }
}

async function client(): Promise<Client> {
    const c = new Client();
    await c.opened();
    return c;
}

const lastTurn = (v: { turns: Turn[] }) => v.turns[v.turns.length - 1]!;
const done = (v: View) => !v.state.busy && v.turns.length > 0 && lastTurn(v).status !== "running";
const tools = (t: Turn) => t.blocks.filter((b): b is ToolBlock => b.t === "tool");

function git(cwd: string, ...args: string[]): string {
    const r = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Cavvy Test", "-c", "user.email=test@example.invalid", ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
}

/** A repository with a few files, and (with `origin`) a bare remote its main branch is pushed to. */
function repo(name: string, o: { origin?: boolean } = {}): string {
    const root = realpathSync(tempDir("cavvy-plan-"));
    const path = join(root, name);
    mkdirSync(join(path, "src", "auth"), { recursive: true });
    writeFileSync(join(path, "src", "auth", "index.ts"), "export const strategies = [emailStrategy];\n");
    writeFileSync(join(path, "README.md"), "# demo\n");
    git(path, "init", "-q", "-b", "main");
    git(path, "add", "-A");
    git(path, "commit", "-q", "-m", "Initial commit");
    if (o.origin) {
        const bare = join(root, "origin.git");
        git(root, "init", "-q", "--bare", bare);
        git(path, "remote", "add", "origin", bare);
        git(path, "push", "-q", "origin", "main");
    }
    return path;
}

/** A session in `cwd` that has presented the mock's SSO plan, from `before` mode. */
async function planningSession(c: Client, cwd: string, before = "acceptEdits") {
    const id = await c.open("session.create", { cwd, mode: before });
    await c.call("session.setEffort", { id, effort: "high" });
    await c.call("session.setMode", { id, mode: "plan" });
    await c.call("session.send", { id, text: "make a plan" });
    await c.until(id, (v) => v.state.interactions.some((i) => i.kind === "plan"));
    const it = c.view(id).state.interactions.find((i) => i.kind === "plan") as PlanInteraction;
    return { id, it };
}

const status = (cwd: string) => git(cwd, "status", "--porcelain", "--", ".", ":(exclude).claude");

describe("implementing a plan in a new worktree", () => {
    test("a worktree on a new branch, a session there like the planning one, links both ways, and the planning session stops", async () => {
        const main = repo("implement");
        const head = git(main, "rev-parse", "HEAD");
        const c = await client();
        const { id, it } = await planningSession(c, main);

        const info = await c.call<PlanInfo>("session.planInfo", { id, toolId: it.toolId });
        expect(info.plan).toContain("SamlProvider");
        expect(info.title).toBe("add SSO");
        expect(info.pending).toBe(true);
        expect(info.git).toEqual({ main, branch: "add-sso", base: "main" });
        // The mode it was in before planning, not plan.
        expect(info.mode).toBe("acceptEdits");
        expect(info.modeWhy).toContain("before it started planning");
        expect(info.savePath).toStartWith(join(iso.home, "plans", "implement"));

        const r = await c.call<ImplementPlanResult>("session.implementPlan", { id, toolId: info.id, branch: info.git!.branch, mode: info.mode });
        expect(r.failed).toBeFalsy();
        expect(r.path).toBe(join(main, ".claude", "worktrees", "add-sso"));
        expect(git(main, "rev-parse", "add-sso")).toBe(head);
        expect(git(r.path, "branch", "--show-current")).toBe("add-sso");

        const planner = c.view(id).state;
        const next = await c.open("session.open", { id: r.sessionId! });
        const st = c.view(next).state;
        expect(st.cwd).toBe(r.path);
        expect(st.mode).toBe("acceptEdits");
        expect(st.effort).toBe("high");
        expect(st.model?.ref).toBe(planner.model!.ref);
        expect(st.fastMode).toBe(planner.fastMode);
        const prompt = c.view(next).turns.find((t) => t.prompt)!.prompt!.text;
        expect(prompt).toStartWith("Implement the plan below.");
        expect(prompt).toContain(id);
        expect(prompt).toContain(`Folder: ${r.path}`);
        expect(prompt).toContain("Branch: add-sso (new, started from main (");
        expect(prompt).toContain(`Paths in the plan under ${main} mean the same files under ${r.path}`);
        expect(prompt).toContain("Add `SamlProvider` in `src/auth/sso.ts`");
        expect(st.planLinks).toMatchObject([{ role: "from", session: id, folder: main, path: r.path, branch: "add-sso", base: "main", plan: info.id }]);

        // The card was answered without approving: the planning session stopped, still planning, and changed nothing.
        await c.until(id, (v) => done(v) && !v.state.interactions.length);
        expect(c.view(id).state.mode).toBe("plan");
        expect(tools(lastTurn(c.view(id))).find((b) => b.name === "ExitPlanMode")?.summary).toBe("Plan handed off to a new session");
        expect(c.view(id).state.planLinks).toMatchObject([{ role: "to", session: r.sessionId, path: r.path, branch: "add-sso", plan: info.id }]);
        expect(status(main)).toBe("");
        expect(readFileSync(join(main, "src", "auth", "index.ts"), "utf8")).toBe("export const strategies = [emailStrategy];\n");

        // The links survive closing and reopening both sessions.
        await c.call("session.interrupt", { id: next });
        await c.until(next, done);
        c.close();
        await Bun.sleep(600);
        const d = await client();
        const again = await d.open("session.open", { id });
        expect(d.view(again).state.planLinks).toMatchObject([{ role: "to", session: r.sessionId, branch: "add-sso", plan: info.id }]);
        // The plan itself too, after the card is gone.
        expect(d.view(again).state.plan).toMatchObject({ id: info.id, title: "add SSO" });
        expect((await d.call<PlanInfo>("session.planInfo", { id: again })).plan).toContain("SamlProvider");
        const reopened = await d.open("session.open", { id: r.sessionId! });
        expect(d.view(reopened).state.planLinks).toMatchObject([{ role: "from", session: id, path: r.path }]);
        d.close();
    });

    test("from the side panel once the card is answered, in a subfolder, with the user's default mode", async () => {
        const main = repo("later");
        const c = await client();
        const sub = join(main, "src");
        // Started in plan mode: what came before isn't known, so the default (Manual) is used.
        const id = await c.open("session.create", { cwd: sub, mode: "plan" });
        await c.call("session.send", { id, text: "make a plan" });
        await c.until(id, (v) => v.state.interactions.length > 0);
        await c.call("session.respond", { id, interactionId: c.view(id).state.interactions[0]!.id, response: { kind: "plan", approved: false, feedback: "not yet" } });
        await c.until(id, done);
        const info = await c.call<PlanInfo>("session.planInfo", { id });
        expect(info.pending).toBe(false);
        expect(info.mode).toBe("default");
        const r = await c.call<ImplementPlanResult>("session.implementPlan", { id, branch: "later/sso", mode: "auto" });
        expect(r.path).toBe(join(main, ".claude", "worktrees", "later-sso"));
        const next = await c.open("session.open", { id: r.sessionId! });
        // Where the planning session worked, in the new worktree.
        expect(c.view(next).state.cwd).toBe(join(r.path, "src"));
        expect(c.view(next).state.mode).toBe("auto");
        await c.call("session.interrupt", { id: next });
        await c.until(next, done);
        c.close();
    });

    test("failures: an existing branch, a bad base, plan mode, a folder that isn't a repository", async () => {
        const main = repo("fails");
        git(main, "branch", "taken");
        const c = await client();
        const { id } = await planningSession(c, main);
        await expect(c.call("session.implementPlan", { id, branch: "taken", mode: "default" })).rejects.toMatchObject({ code: "branch_exists" });
        await expect(c.call("session.implementPlan", { id, branch: "fresh", base: "nope", mode: "default" })).rejects.toMatchObject({ code: "bad_base" });
        await expect(c.call("session.implementPlan", { id, branch: "fresh", mode: "plan" })).rejects.toMatchObject({ code: "invalid_mode" });
        await expect(c.call("session.implementPlan", { id, toolId: "unknown", branch: "fresh", mode: "default" })).rejects.toMatchObject({ code: "no_plan" });
        await expect(c.call("session.implementPlan", { id, branch: "x".repeat(201), mode: "default" })).rejects.toMatchObject({ code: "invalid" });
        expect(existsSync(join(main, ".claude", "worktrees", "fresh"))).toBe(false);
        // Nothing was answered: the card still waits.
        expect(c.view(id).state.interactions).toHaveLength(1);
        await c.call("session.interrupt", { id });
        await c.until(id, done);

        const plain = realpathSync(tempDir("cavvy-plan-plain-"));
        writeFileSync(join(plain, "a.ts"), "");
        const other = await planningSession(c, plain);
        const info = await c.call<PlanInfo>("session.planInfo", { id: other.id });
        expect(info.git).toBeFalsy();
        expect(info.notGit).toContain("isn't in a Git repository");
        await expect(c.call("session.implementPlan", { id: other.id, branch: "x", mode: "default" })).rejects.toMatchObject({ code: "not_git" });
        await c.call("session.interrupt", { id: other.id });
        await c.until(other.id, done);
        c.close();
    });

    test("needs trust: the repository's config, or the new worktree's own project config", async () => {
        const main = repo("trusty");
        git(main, "config", "filter.evil.smudge", "cat");
        const c = await client();
        const { id } = await planningSession(c, main);
        await expect(c.call("session.implementPlan", { id, branch: "t1", mode: "default" })).rejects.toMatchObject({ code: "needs_trust", folder: main });
        trustFolder(main);
        git(main, "config", "--unset", "filter.evil.smudge");
        await c.call("session.interrupt", { id });
        await c.until(id, done);

        // Project config checked in: the worktree is made, but its session waits for trust. Nothing is deleted.
        const repo2 = repo("configured");
        // Project config is the folder's own: the session will work in src/, as the planning one does.
        mkdirSync(join(repo2, "src", ".cavvy"));
        writeFileSync(join(repo2, "src", ".cavvy", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "true" }] }] } }));
        git(repo2, "add", "-A");
        git(repo2, "commit", "-q", "-m", "config");
        // The planning folder itself is trusted; the new worktree, a different folder, isn't (until trusted).
        trustFolder(join(repo2, "src"));
        const p2 = await planningSession(c, join(repo2, "src"));
        const r = await c.call<ImplementPlanResult>("session.implementPlan", { id: p2.id, branch: "configured", mode: "default" });
        expect(r.sessionId).toBeFalsy();
        expect(r.failed).toMatchObject({ code: "needs_trust", folder: join(r.path, "src") });
        expect(existsSync(r.path)).toBe(true);
        expect(c.view(p2.id).state.interactions).toHaveLength(1);
        // Trusted, the session starts in the worktree already made.
        await c.call("projects.trust", { path: r.failed!.folder, trust: true });
        await expect(c.call("session.implementPlan", { id: p2.id, branch: "configured", mode: "default" })).rejects.toMatchObject({ code: "branch_exists" });
        await expect(c.call("session.implementPlan", { id: p2.id, branch: "other", mode: "default", resume: r.path })).rejects.toMatchObject({ code: "not_managed" });
        const again = await c.call<ImplementPlanResult>("session.implementPlan", { id: p2.id, branch: "configured", mode: "default", resume: r.path });
        expect(again.sessionId).toBeDefined();
        await c.until(p2.id, (v) => done(v) && !v.state.interactions.length);
        const started = await c.open("session.open", { id: again.sessionId! });
        await c.call("session.interrupt", { id: started });
        await c.until(started, done);
        c.close();
    });
});

describe("saving a plan", () => {
    test("by default in the Cavvy home, privately; or a chosen file; never overwriting without asking", async () => {
        const main = repo("save");
        const c = await client();
        const { id } = await planningSession(c, main);
        const info = await c.call<PlanInfo>("session.planInfo", { id });
        const saved = await c.call<{ path: string }>("session.savePlan", { id });
        expect(saved.path).toBe(info.savePath);
        expect(saved.path).toMatch(/plans\/save\/\d{4}-\d\d-\d\d-add-sso\.md$/);
        expect(readFileSync(saved.path, "utf8")).toContain("SamlProvider");
        expect(statSync(saved.path).mode & 0o777).toBe(0o600);
        // The next default doesn't collide.
        expect((await c.call<PlanInfo>("session.planInfo", { id })).savePath).toEndWith("-add-sso-2.md");

        const rel = await c.call<{ path: string }>("session.savePlan", { id, path: "docs/plans/sso.md" });
        expect(rel.path).toBe(join(main, "docs", "plans", "sso.md"));
        await expect(c.call("session.savePlan", { id, path: "docs/plans/sso.md" })).rejects.toMatchObject({ code: "file_exists" });
        writeFileSync(rel.path, "mine\n");
        await expect(c.call("session.savePlan", { id, path: join(main, "docs", "plans", "sso.md") })).rejects.toMatchObject({ code: "file_exists" });
        expect(readFileSync(rel.path, "utf8")).toBe("mine\n");
        await c.call("session.savePlan", { id, path: "docs/plans/sso.md", replace: true });
        expect(readFileSync(rel.path, "utf8")).toContain("SamlProvider");
        await c.call("session.interrupt", { id });
        await c.until(id, done);
        c.close();
    });

    test("refuses escapes, links out, .git and other names, writing nothing outside", async () => {
        const main = repo("escape");
        const outside = realpathSync(tempDir("cavvy-plan-outside-"));
        symlinkSync(outside, join(main, "linked"));
        symlinkSync(join(outside, "target.md"), join(main, "link.md"));
        const c = await client();
        const { id } = await planningSession(c, main);
        const refused = async (path: string, code: string) => expect(c.call("session.savePlan", { id, path })).rejects.toMatchObject({ code });
        await refused("../escape.md", "path_outside");
        await refused("docs/../../escape.md", "path_outside");
        await refused(join(outside, "abs.md"), "path_outside");
        await refused("linked/x.md", "path_outside");
        await refused("link.md", "path_outside");
        await refused(".git/x.md", "path_outside");
        await refused("notes.txt", "bad_name");
        await refused(".md", "bad_name");
        await refused("a\0b.md", "invalid");
        expect(lstatSync(join(main, "link.md")).isSymbolicLink()).toBe(true);
        expect(existsSync(join(outside, "target.md"))).toBe(false);
        expect(existsSync(join(outside, "x.md"))).toBe(false);
        expect(existsSync(join(outside, "abs.md"))).toBe(false);
        expect(existsSync(join(main, "..", "escape.md"))).toBe(false);
        expect(existsSync(join(main, ".git", "x.md"))).toBe(false);
        // A link replaced only with `replace` is still never written through.
        await expect(c.call("session.savePlan", { id, path: "link.md", replace: true })).rejects.toMatchObject({ code: "path_outside" });
        expect(existsSync(join(outside, "target.md"))).toBe(false);
        await c.call("session.interrupt", { id });
        await c.until(id, done);
        c.close();
    });
});

describe("archiving a session in a managed worktree", () => {
    /** A managed worktree, a session in it with a message, and the client showing it. */
    async function inWorktree(o: { origin?: boolean; name: string }) {
        const main = repo(o.name, { origin: o.origin });
        const c = await client();
        const made = await c.call<{ path: string; branch: string }>("projects.createWorktree", { path: main, branch: `wt-${o.name}` });
        const id = await c.open("session.create", { cwd: made.path });
        await c.call("session.send", { id, text: "hello" });
        await c.until(id, done);
        return { main, c, id, wt: made.path, branch: made.branch };
    }

    test("pushed and clean: offered, removed, branch kept; Undo brings back only the session", async () => {
        const { main, c, id, wt, branch } = await inWorktree({ origin: true, name: "pushed" });
        // The branch's commit is on origin/main.
        const offer = await c.call<ArchiveOffer>("session.archiveOffer", { id });
        expect(offer).toEqual({ worktree: { path: wt, branch, main }, removable: true });
        const [r, twice] = await Promise.allSettled([c.call<ArchiveResult>("session.archive", { id, archived: true, removeWorktree: true }), c.call("session.archive", { id, archived: true, removeWorktree: true })]);
        expect(twice).toMatchObject({ status: "rejected", reason: { code: "busy" } });
        expect(r).toMatchObject({ status: "fulfilled", value: { archived: true, removed: true, closed: true, main } });
        expect(existsSync(wt)).toBe(false);
        expect(git(main, "branch", "--list", branch)).toContain(branch);
        const archived = await c.call<{ id: string }[]>("sessions.list", { archived: true });
        expect(archived.some((s) => s.id === id)).toBe(true);
        // Undo: the session comes back, the worktree doesn't, and opening it says why.
        await c.call("session.archive", { id, archived: false });
        expect((await c.call<{ id: string }[]>("sessions.list", {})).some((s) => s.id === id)).toBe(true);
        expect(existsSync(wt)).toBe(false);
        await expect(c.call("session.open", { id })).rejects.toMatchObject({ code: "folder_missing" });
        c.close();
    });

    test("uncommitted changes: archived, kept, and why", async () => {
        const { c, id, wt } = await inWorktree({ origin: true, name: "dirty" });
        writeFileSync(join(wt, "README.md"), "changed\n");
        expect((await c.call<ArchiveOffer>("session.archiveOffer", { id })).removable).toBe(true);
        const r = await c.call<ArchiveResult>("session.archive", { id, archived: true, removeWorktree: true });
        expect(r).toMatchObject({ archived: true, removed: false, code: "dirty" });
        expect(r.archived && r.kept).toContain("uncommitted or untracked changes");
        expect(readFileSync(join(wt, "README.md"), "utf8")).toBe("changed\n");
        c.close();
    });

    test("commits on no remote branch: not offered; kept even if asked", async () => {
        const { c, id, wt, main } = await inWorktree({ origin: true, name: "unpushed" });
        writeFileSync(join(wt, "new.ts"), "x\n");
        git(wt, "add", "-A");
        git(wt, "commit", "-q", "-m", "local work");
        const offer = await c.call<ArchiveOffer>("session.archiveOffer", { id });
        expect(offer.removable).toBe(false);
        expect(offer.reason).toContain("a commit that isn't on any remote branch");
        const r = await c.call<ArchiveResult>("session.archive", { id, archived: true, removeWorktree: true });
        expect(r).toMatchObject({ archived: true, removed: false, code: "unpushed" });
        expect(existsSync(wt)).toBe(true);
        // Pushed later, it can go (from the picker; the branch stays).
        expect(git(main, "branch", "--list", "wt-unpushed")).toContain("wt-unpushed");
        c.close();
    });

    test("a repository with no remote: kept, in those words", async () => {
        const { c, id, wt } = await inWorktree({ name: "noremote" });
        const offer = await c.call<ArchiveOffer>("session.archiveOffer", { id });
        expect(offer).toMatchObject({ removable: false });
        expect(offer.reason).toContain("This repository has no remote");
        const r = await c.call<ArchiveResult>("session.archive", { id, archived: true, removeWorktree: true });
        expect(r).toMatchObject({ archived: true, removed: false, code: "unpushed" });
        expect(existsSync(wt)).toBe(true);
        c.close();
    });

    test("ignored files wait for the token for exactly them; nothing happens until then", async () => {
        const main = repo("ignored", { origin: true });
        writeFileSync(join(main, ".gitignore"), ".env\n");
        git(main, "add", "-A");
        git(main, "commit", "-q", "-m", "ignore");
        git(main, "push", "-q", "origin", "main");
        const c = await client();
        const made = await c.call<{ path: string }>("projects.createWorktree", { path: main, branch: "wt-ignored" });
        writeFileSync(join(made.path, ".env"), "SECRET=1\n");
        const id = await c.open("session.create", { cwd: made.path });
        await c.call("session.send", { id, text: "hello" });
        await c.until(id, done);
        const first = await c.call<ArchiveResult>("session.archive", { id, archived: true, removeWorktree: true });
        expect(first).toMatchObject({ archived: false, ignored: [".env"], total: 1 });
        if (first.archived) throw new Error("unreachable");
        // Not archived, still open here.
        expect((await c.call<{ id: string }[]>("sessions.list", {})).some((s) => s.id === id)).toBe(true);
        await c.call("session.send", { id, text: "still here" });
        await c.until(id, (v) => done(v) && v.turns.length === 2);
        expect(await c.call<ArchiveResult>("session.archive", { id, archived: true, removeWorktree: true, deleteIgnored: "0".repeat(64) })).toMatchObject({ archived: false });
        expect(await c.call<ArchiveResult>("session.archive", { id, archived: true, removeWorktree: true, deleteIgnored: first.confirm })).toMatchObject({ archived: true, removed: true });
        expect(existsSync(made.path)).toBe(false);
        c.close();
    });

    test("another session in the worktree, or this one still running: not offered, not removed", async () => {
        const { c, id, wt } = await inWorktree({ origin: true, name: "shared" });
        const other = await c.open("session.create", { cwd: wt });
        await c.call("session.send", { id: other, text: "hello again" });
        await c.until(other, done);
        await c.call("session.rename", { id: other, title: "The other one" });
        const offer = await c.call<ArchiveOffer>("session.archiveOffer", { id });
        expect(offer).toMatchObject({ removable: false });
        expect(offer.reason).toContain("“The other one” also works in this worktree");
        expect(await c.call<ArchiveResult>("session.archive", { id, archived: true, removeWorktree: true })).toMatchObject({ archived: true, removed: false, code: "shared" });
        expect(existsSync(wt)).toBe(true);

        // With the other one archived, this one still working (waiting to be allowed to write a file).
        await c.call("session.archive", { id, archived: false });
        await c.call("session.archive", { id: other, archived: true });
        await c.call("session.setMode", { id, mode: "default" });
        await c.call("session.send", { id, text: "demo" });
        await c.until(id, (v) => v.state.interactions.length > 0);
        const busy = await c.call<ArchiveOffer>("session.archiveOffer", { id });
        expect(busy).toMatchObject({ removable: false });
        expect(busy.reason).toContain("still working");
        expect(await c.call<ArchiveResult>("session.archive", { id, archived: true, removeWorktree: true })).toMatchObject({ archived: true, removed: false, code: "running" });
        expect(existsSync(wt)).toBe(true);
        await c.call("session.interrupt", { id });
        await c.until(id, done);
        c.close();
    });

    test("a session not in a managed worktree archives as before", async () => {
        const main = repo("plainarchive");
        const c = await client();
        const id = await c.open("session.create", { cwd: main });
        await c.call("session.send", { id, text: "hello" });
        await c.until(id, done);
        expect(await c.call<ArchiveOffer>("session.archiveOffer", { id })).toEqual({ removable: false });
        expect(await c.call("session.archive", { id, archived: true })).toBeNull();
        await expect(c.call("session.archive", { id, archived: true, removeWorktree: true })).rejects.toMatchObject({ code: "not_managed" });
        c.close();
    });
});
