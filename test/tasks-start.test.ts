// Suggested tasks in the app (src/server/engine.ts tasks.start, session.suggestion; src/server/runtime.ts): an API
// model suggests one, the card's actions, and the start: checks first, the session it makes, a repeat finding the
// same session (after a restart too), worktrees, and that no server can ask for it.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { SessionSnapshot, StartTaskResult, SuggestionState } from "../src/server/protocol";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { RELAYED_SESSION_METHODS } = await import("../src/server/protocol");
const { answerPeers } = await import("../src/server/far-peers");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
const { gitArgv, gitEnv } = await import("../src/util/git");

const dirs: string[] = [];
const mock = startMockLlm({ delayMs: 0 });
afterAll(() => {
    mock.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    iso.cleanup();
});

async function until(pred: () => boolean, ms = 15_000) {
    const end = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(20);
    }
}
function git(cwd: string, ...args: string[]) {
    const r = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe", timeout: 5000 });
    if (r.exitCode) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
}

writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku", notifyAfterSeconds: 0, permissions: { allowBypass: true } }));
const sent: any[] = [];
const client = { subs: new Set<string>(), send: (m: unknown) => sent.push(m) } as never;
let engine = new Engine({ listModels: async () => [] });
engine.clients.add(client);
afterAll(() => engine.stop());
const project = realpathSync(createDemoProject(tempDir("tasks-app-"), { git: false }));
dirs.push(project);
const call = <T = any>(method: string, params: Record<string, unknown>) => engine.handle(client, method, params) as Promise<T>;

type Rt = Awaited<ReturnType<typeof engine.createSession>>;
const turns = (rt: Rt) => rt.snapshot().turns;
async function suggestingSession(mode: "acceptEdits" | "plan" | "bypassPermissions" = "acceptEdits") {
    const rt = await engine.createSession(project, { mode });
    await rt.ready;
    (client as any).subs.add(rt.id);
    await rt.send("suggestbug while you read the auth module");
    await until(() => turns(rt).length > 0 && rt.idle && turns(rt).at(-1)!.status !== "running");
    return rt;
}
const origin = (rt: Rt, sid: string) => ({ key: `${rt.id}#${sid}`, session: rt.id, title: "Reading auth" });
const params = (rt: Rt, s: SuggestionState, o: Record<string, unknown> = {}) => ({ cwd: project, title: s.title, prompt: s.prompt, model: "mock:mock-opus", mode: rt.mode, origin: origin(rt, s.id), ...o });

describe("an API model suggests a task", () => {
    test("the card's record lands in the session's state and file; the agent carries on; the sidebar and notification count it", async () => {
        const rt = await suggestingSession();
        const s = rt.snapshot().state.suggestions!;
        expect(s).toHaveLength(1);
        expect(s[0]).toMatchObject({ title: "Session timeout ignores its setting", state: "pending", why: expect.stringContaining("hard-codes 30 minutes") });
        // Its id is the tool call's: the card stands in for that call.
        const block = turns(rt).at(-1)!.blocks.find((b: any) => b.t === "tool" && b.name === "SuggestTask") as any;
        expect(block?.id).toBe(s[0]!.id);
        const text = turns(rt).at(-1)!.blocks.filter((b: any) => b.t === "text").map((b: any) => b.text).join("\n");
        expect(text).toContain("Suggested “Session timeout ignores its setting” to the user. Nothing has started");
        expect(readFileSync(rt.session.path, "utf-8")).toContain('"t":"suggestion"');
        expect(engine.summaryOf(rt).suggested).toBe(1);
        const done = sent.findLast((m) => m.type === "notify" && m.sessionId === rt.id);
        expect(done?.body).toMatch(/^Finished in .* · suggested 1 task$/);
        // The same problem again in a later turn is refused, as already suggested.
        await rt.send("suggestbug again");
        await until(() => rt.idle && turns(rt).at(-1)!.status !== "running");
        expect(rt.snapshot().state.suggestions).toHaveLength(1);
        const again = turns(rt).at(-1)!.blocks.find((b: any) => b.t === "tool" && b.name === "SuggestTask") as any;
        expect(JSON.stringify(again)).toContain("is already suggested in this session");
    });
});

describe("the card's actions (session.suggestion)", () => {
    test("claim once; dismiss and restore; failed goes back to pending with its message", async () => {
        const rt = await suggestingSession();
        const sid = rt.snapshot().state.suggestions![0]!.id;
        const act = (action: Record<string, unknown>) => call<SuggestionState>("session.suggestion", { id: rt.id, suggestionId: sid, ...action });
        expect((await act({ action: "claim" })).state).toBe("starting");
        await expect(act({ action: "claim" })).rejects.toMatchObject({ code: "not_pending" });
        expect(await act({ action: "failed", message: "box didn't answer." })).toMatchObject({ state: "pending", failed: "box didn't answer." });
        expect((await act({ action: "dismissed" })).state).toBe("dismissed");
        expect(engine.summaryOf(rt).suggested).toBeUndefined();
        expect((await act({ action: "pending" })).state).toBe("pending");
        await expect(call("session.suggestion", { id: rt.id, suggestionId: "nope", action: "claim" })).rejects.toMatchObject({ code: "not_found" });
    });

    test("a session a terminal holds: Close this session in the terminal to start it.", async () => {
        const rt = await suggestingSession();
        const file = rt.session.path;
        const id = rt.id;
        await engine.handle(client, "session.close", { id });
        await until(() => !engine.runtimes.has(id));
        // Another live process's lock on it (this test's parent stands in for a terminal).
        writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.ppid, at: Date.now() }));
        try {
            await expect(call("session.suggestion", { id, suggestionId: "x", action: "claim" })).rejects.toMatchObject({ code: "held", message: "Close this session in the terminal to start it." });
        } finally {
            rmSync(`${file}.lock`, { force: true });
        }
    });
});

describe("tasks.start", () => {
    test("checks before making anything: folder, model, effort, mode", async () => {
        const rt = await suggestingSession();
        const s = rt.snapshot().state.suggestions![0]!;
        const before = engine.runtimes.size;
        await expect(call("tasks.start", params(rt, s, { cwd: join(project, "nope") }))).rejects.toMatchObject({ code: "no_folder" });
        await expect(call("tasks.start", params(rt, s, { model: "nobody:x" }))).rejects.toMatchObject({ code: "model_unavailable" });
        await expect(call("tasks.start", params(rt, s, { effort: "huge" }))).rejects.toMatchObject({ code: "effort_unavailable" });
        await expect(call("tasks.start", params(rt, s, { mode: "yolo" }))).rejects.toMatchObject({ code: "invalid_mode" });
        await expect(call("tasks.start", params(rt, s, { worktree: true }))).rejects.toMatchObject({ code: "not_git" });
        // A folder with configuration that runs commands, not trusted: the window asks the user, for that folder.
        const configured = realpathSync(tempDir("tasks-config-"));
        dirs.push(configured);
        writeFileSync(join(configured, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
        await expect(call("tasks.start", params(rt, s, { cwd: configured }))).rejects.toMatchObject({ code: "needs_trust", folder: configured });
        expect(engine.runtimes.size).toBe(before);
    });

    test("a session as the user's: titled, its prompt the user's message with where it came from out of sight, no freer than the suggester; a repeat finds it, after a restart too", async () => {
        const rt = await suggestingSession("bypassPermissions");
        const s = rt.snapshot().state.suggestions![0]!;
        await call("session.suggestion", { id: rt.id, suggestionId: s.id, action: "claim" });
        const r = await call<StartTaskResult>("tasks.start", params(rt, s, { prompt: `${s.prompt}\n\nAlso check the docs.`, effort: undefined }));
        expect(r.failed).toBeUndefined();
        expect(r).toMatchObject({ title: s.title, cwd: project });
        const n = engine.runtimes.get(r.sessionId!)!;
        expect(n.title).toBe(s.title);
        // Bypass asks less than the folder's default (Manual): it gets the default.
        expect(n.mode).toBe("default");
        // Attributed to the user, not the suggesting session.
        expect(n.session.meta.startedBy).toBeUndefined();
        expect(n.session.meta.suggestedBy).toEqual(origin(rt, s.id));
        expect(n.snapshot().state.suggestedBy).toEqual(origin(rt, s.id));
        await until(() => turns(n).length > 0 && n.idle && turns(n).at(-1)!.status !== "running");
        expect(turns(n)[0]!.prompt?.text).toBe(`${s.prompt}\n\nAlso check the docs.`);
        expect(turns(n)[0]!.prompt?.from).toBeUndefined();
        const first = n.session.messages.find((m) => m.role === "user")!;
        expect(JSON.stringify(first.content)).toContain(`suggested by the agent in session ${rt.id}`);
        // Recorded on the card.
        const started = await call<SuggestionState>("session.suggestion", { id: rt.id, suggestionId: s.id, action: "started", started: { sessionId: r.sessionId, title: r.title, cwd: r.cwd, at: Date.now() } });
        expect(started).toMatchObject({ state: "started", started: { sessionId: r.sessionId } });
        // Pressed again (a second window, a retry): the same session.
        const again = await call<StartTaskResult>("tasks.start", params(rt, s));
        expect(again).toMatchObject({ sessionId: r.sessionId, existing: true });
        // Both at once: one session.
        const s2 = (await suggestingSession()).snapshot().state.suggestions![0]!;
        const rt2 = [...engine.runtimes.values()].find((x) => x.snapshot().state.suggestions?.[0]?.id === s2.id)!;
        const [x, y] = await Promise.all([call<StartTaskResult>("tasks.start", params(rt2, s2)), call<StartTaskResult>("tasks.start", params(rt2, s2))]);
        expect(x.sessionId).toBe(y.sessionId!);
        // A restart: found from what's saved, not memory.
        await engine.stop();
        engine = new Engine({ listModels: async () => [] });
        engine.clients.add(client);
        const after = await call<StartTaskResult>("tasks.start", params(rt, s));
        expect(after).toMatchObject({ sessionId: r.sessionId, existing: true, cwd: project });
    });

    test("plan counts as ask; a stricter folder default wins", async () => {
        const rt = await suggestingSession("plan");
        const s = rt.snapshot().state.suggestions![0]!;
        const r = await call<StartTaskResult>("tasks.start", params(rt, s));
        expect(engine.runtimes.get(r.sessionId!)!.mode).toBe("default");
        const rt2 = await suggestingSession("acceptEdits");
        const s2 = rt2.snapshot().state.suggestions![0]!;
        const r2 = await call<StartTaskResult>("tasks.start", params(rt2, s2, { mode: "acceptEdits" }));
        expect(engine.runtimes.get(r2.sessionId!)!.mode).toBe("default");
    });

    test("a start left halfway: waiting again when the session is opened, started where a session took it", async () => {
        const rt = await suggestingSession();
        const s = rt.snapshot().state.suggestions![0]!;
        await call("session.suggestion", { id: rt.id, suggestionId: s.id, action: "claim" });
        const id = rt.id;
        await engine.handle(client, "session.close", { id });
        await until(() => !engine.runtimes.has(id));
        const snap = await call<SessionSnapshot>("session.open", { id });
        expect(snap.state.suggestions![0]).toMatchObject({ id: s.id, state: "pending" });
        // Claimed, started elsewhere meanwhile (here: by this machine), and the window gone before it said so.
        await call("session.suggestion", { id, suggestionId: s.id, action: "claim" });
        const r = await call<StartTaskResult>("tasks.start", { cwd: project, title: s.title, prompt: s.prompt, model: "mock:mock-opus", mode: "default", origin: { key: `${id}#${s.id}`, session: id, title: "x" } });
        await engine.handle(client, "session.close", { id });
        await until(() => !engine.runtimes.has(id));
        const reopened = await call<SessionSnapshot>("session.open", { id });
        expect(reopened.state.suggestions![0]).toMatchObject({ state: "started", started: { sessionId: r.sessionId } });
    });

    test("a first prompt a UserPromptSubmit hook blocks goes back to the new session's composer", async () => {
        const blocked = realpathSync(tempDir("tasks-hook-"));
        dirs.push(blocked);
        const settings = join(iso.home, "settings.json");
        const was = readFileSync(settings, "utf-8");
        writeFileSync(settings, JSON.stringify({ ...JSON.parse(was), hooks: { UserPromptSubmit: [{ command: "echo 'not today' >&2; exit 2" }] } }));
        try {
            const drafts: any[] = [];
            const watcher = { subs: new Set<string>(), send: (m: any) => m.type === "draft" && drafts.push(m) } as never;
            engine.clients.add(watcher);
            const r = await engine.handle(watcher, "tasks.start", { cwd: blocked, title: "Fix it", prompt: "Fix the thing.", model: "mock:mock-opus", mode: "default", origin: { key: "s0#hook", session: "s0", title: "x" } }) as StartTaskResult;
            await until(() => drafts.length > 0);
            expect(drafts[0]).toMatchObject({ sessionId: r.sessionId, text: "Fix the thing." });
            expect(engine.runtimes.get(r.sessionId!)!.session.messageCount).toBe(0);
            engine.clients.delete(watcher);
        } finally {
            writeFileSync(settings, was);
        }
    });

    test("in a new worktree, on fix/<slug>, -2 when that's taken", async () => {
        const repo = realpathSync(tempDir("tasks-repo-"));
        dirs.push(repo);
        writeFileSync(join(repo, "README.md"), "base\n");
        mkdirSync(join(repo, "app"));
        writeFileSync(join(repo, "app", "x.txt"), "x\n");
        git(repo, "init", "-q", "-b", "main");
        git(repo, "add", ".");
        git(repo, "commit", "-qm", "initial");
        const o = (key: string) => ({ cwd: join(repo, "app"), title: "Login button misaligned", prompt: "Fix it.", model: "mock:mock-opus", mode: "default", worktree: true, origin: { key, session: "s0", title: "x" } });
        const a = await call<StartTaskResult>("tasks.start", o("s0#a"));
        expect(a.worktree?.branch).toBe("fix/login-button-misaligned");
        // In the same sub-folder of the worktree as the suggester worked in.
        expect(a.cwd).toBe(join(a.worktree!.path, "app"));
        expect(engine.runtimes.get(a.sessionId!)!.ws.cwd).toBe(a.cwd);
        const b = await call<StartTaskResult>("tasks.start", o("s0#b"));
        expect(b.worktree?.branch).toBe("fix/login-button-misaligned-2");
    });
});

describe("only a window can ask", () => {
    test("never relayed, and not among what a server may ask the user's computer for", async () => {
        expect(RELAYED_SESSION_METHODS as readonly string[]).not.toContain("tasks.start");
        expect(RELAYED_SESSION_METHODS as readonly string[]).not.toContain("session.suggestion");
        const here = { list: () => [], read: () => undefined, send: async () => ({}), start: async () => ({}) } as never;
        for (const op of ["tasks.start", "tasks", "session.suggestion"]) await expect(answerPeers("box", op, { id: "mac/x" }, here, new Map())).rejects.toThrow(/Unknown request|No session/);
    });
});
