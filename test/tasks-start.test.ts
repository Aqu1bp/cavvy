// Suggested tasks in the app (src/server/engine.ts tasks.start, session.suggestion; src/server/runtime.ts): an API
// model suggests one, the card's actions, and the start: checks first, the session it makes, a repeat finding the
// same session (after a restart too), worktrees, and that no server can ask for it.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { SessionSnapshot, StartTaskResult, SuggestionState } from "../src/server/protocol";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { RELAYED_SESSION_METHODS } = await import("../src/server/protocol");
const { answerPeers } = await import("../src/server/far-peers");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
const { gitArgv, gitEnv } = await import("../src/util/git");
const { peerWake } = await import("../src/agent/peers");

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
async function suggestingSession(mode: "default" | "acceptEdits" | "plan" | "bypassPermissions" = "acceptEdits") {
    const rt = await engine.createSession(project, { mode });
    await rt.ready;
    (client as any).subs.add(rt.id);
    await rt.send("suggestbug while you read the auth module");
    await until(() => turns(rt).length > 0 && rt.idle && turns(rt).at(-1)!.status !== "running");
    return rt;
}
const origin = (rt: Rt, sid: string) => ({ key: `${rt.id}#${sid}`, session: rt.id, title: "Reading auth" });
const params = (rt: Rt, s: SuggestionState, o: Record<string, unknown> = {}) => ({ cwd: project, title: s.title, prompt: s.prompt, model: "mock:mock-opus", origin: origin(rt, s.id), ...o });

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

/** A repository whose UserPromptSubmit hook refuses BLOCKME, and a start of it in a new worktree; `done` puts the settings back. */
function refusingRepo() {
    const repo = realpathSync(tempDir("tasks-hook-repo-"));
    dirs.push(repo);
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "initial");
    const settings = join(iso.home, "settings.json");
    const was = readFileSync(settings, "utf-8");
    writeFileSync(settings, JSON.stringify({ ...JSON.parse(was), hooks: { UserPromptSubmit: [{ command: "grep -q BLOCKME || exit 0; echo 'not today' >&2; exit 2" }] } }));
    const start = { cwd: repo, title: "Fix the header", prompt: "BLOCKME", model: "mock:mock-opus", worktree: true, origin: { key: `s0#hook-${repo.slice(-6)}`, session: "s0", title: "x" } };
    return { repo, start, done: () => writeFileSync(settings, was) };
}

describe("tasks.start", () => {
    test("checks before making anything: folder, model, effort", async () => {
        const rt = await suggestingSession();
        const s = rt.snapshot().state.suggestions![0]!;
        const before = engine.runtimes.size;
        await expect(call("tasks.start", params(rt, s, { cwd: join(project, "nope") }))).rejects.toMatchObject({ code: "no_folder" });
        await expect(call("tasks.start", params(rt, s, { model: "nobody:x" }))).rejects.toMatchObject({ code: "model_unavailable" });
        await expect(call("tasks.start", params(rt, s, { effort: "huge" }))).rejects.toMatchObject({ code: "effort_unavailable" });
        await expect(call("tasks.start", params(rt, s, { worktree: true }))).rejects.toMatchObject({ code: "not_git" });
        // A folder with configuration that runs commands, not trusted: the window asks the user, for that folder.
        const configured = realpathSync(tempDir("tasks-config-"));
        dirs.push(configured);
        writeFileSync(join(configured, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
        await expect(call("tasks.start", params(rt, s, { cwd: configured }))).rejects.toMatchObject({ code: "needs_trust", folder: configured });
        expect(engine.runtimes.size).toBe(before);
    });

    test("a session as the user's: titled, its prompt the user's message with where it came from out of sight, in the folder's default mode; a repeat finds it, after a restart too", async () => {
        const rt = await suggestingSession("bypassPermissions");
        const s = rt.snapshot().state.suggestions![0]!;
        await call("session.suggestion", { id: rt.id, suggestionId: s.id, action: "claim" });
        const r = await call<StartTaskResult>("tasks.start", params(rt, s, { prompt: `${s.prompt}\n\nAlso check the docs.`, effort: undefined }));
        expect(r.failed).toBeUndefined();
        expect(r).toMatchObject({ title: s.title, cwd: project });
        const n = engine.runtimes.get(r.sessionId!)!;
        expect(n.title).toBe(s.title);
        // A Bypass suggester, a Manual default: Manual.
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
        expect(JSON.stringify(first.content)).not.toContain("new worktree");
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

    test("the folder's default mode, whatever the suggesting session's is", async () => {
        const rt = await suggestingSession("plan");
        const s = rt.snapshot().state.suggestions![0]!;
        const r = await call<StartTaskResult>("tasks.start", params(rt, s));
        expect(engine.runtimes.get(r.sessionId!)!.mode).toBe("default");
        const rt2 = await suggestingSession("acceptEdits");
        const s2 = rt2.snapshot().state.suggestions![0]!;
        // A mode from an older window is ignored.
        const r2 = await call<StartTaskResult>("tasks.start", params(rt2, s2, { mode: "bypassPermissions" }));
        expect(engine.runtimes.get(r2.sessionId!)!.mode).toBe("default");
    });

    test("a start left halfway: a fresh claim stays; one gone quiet waits again when the session is opened, or is started where a session took it", async () => {
        const rt = await suggestingSession();
        const s = rt.snapshot().state.suggestions![0]!;
        await call("session.suggestion", { id: rt.id, suggestionId: s.id, action: "claim" });
        const id = rt.id;
        const close = async () => {
            await engine.handle(client, "session.close", { id });
            await until(() => !engine.runtimes.has(id));
        };
        /** The claim a minute old, as one whose window went away. */
        const age = () => {
            const r = engine.runtimes.get(id)!.session.suggestions.get(s.id)!;
            engine.runtimes.get(id)!.session.setSuggestion({ ...r, claimedAt: Date.now() - 61_000 });
        };
        await close();
        // Fresh: its window may still be starting it.
        expect((await call<SessionSnapshot>("session.open", { id })).state.suggestions![0]).toMatchObject({ state: "starting" });
        age();
        await close();
        const snap = await call<SessionSnapshot>("session.open", { id });
        expect(snap.state.suggestions![0]).toMatchObject({ id: s.id, state: "pending" });
        // Claimed, started elsewhere meanwhile (here: by this machine), and the window gone before it said so.
        await call("session.suggestion", { id, suggestionId: s.id, action: "claim" });
        const r = await call<StartTaskResult>("tasks.start", { cwd: project, title: s.title, prompt: s.prompt, model: "mock:mock-opus", origin: { key: `${id}#${s.id}`, session: id, title: "x" } });
        age();
        await engine.handle(client, "session.close", { id });
        await until(() => !engine.runtimes.has(id));
        const reopened = await call<SessionSnapshot>("session.open", { id });
        expect(reopened.state.suggestions![0]).toMatchObject({ state: "started", started: { sessionId: r.sessionId } });
    });

    test("a first prompt a UserPromptSubmit hook refuses fails the start: the session goes, and Start again makes another", async () => {
        const folder = realpathSync(tempDir("tasks-hook-"));
        dirs.push(folder);
        const settings = join(iso.home, "settings.json");
        const was = readFileSync(settings, "utf-8");
        writeFileSync(settings, JSON.stringify({ ...JSON.parse(was), hooks: { UserPromptSubmit: [{ command: "grep -q BLOCKME || exit 0; sleep 0.3; echo 'not today' >&2; exit 2" }] } }));
        try {
            const drafts: any[] = [];
            const heard: any[] = [];
            const watcher = { subs: new Set<string>(), send: (m: any) => (heard.push(m), m.type === "draft" && drafts.push(m)) } as never;
            engine.clients.add(watcher);
            const start = { cwd: folder, title: "Fix it", prompt: "BLOCKME: fix the thing.", model: "mock:mock-opus", origin: { key: "s0#hook", session: "s0", title: "x" } };
            const before = new Set(engine.runtimes.keys());
            const starting = engine.handle(watcher, "tasks.start", start);
            // While the hook decides, the session isn't listed.
            await until(() => [...engine.runtimes.values()].some((x) => x.session.meta.suggestedBy?.key === "s0#hook" && x.busy));
            const made = [...engine.runtimes.values()].find((x) => x.session.meta.suggestedBy?.key === "s0#hook")!;
            const madeDir = dirname(made.session.path);
            const madeId = made.id;
            expect(((await engine.handle(watcher, "sessions.list", {})) as { id: string }[]).some((x) => x.id === madeId)).toBe(false);
            await expect(starting).rejects.toMatchObject({ code: "blocked", message: "Prompt blocked by hook: not today" });
            // Nothing of it is left on disk either.
            for (const f of [`${madeId}.jsonl`, join("ui", `${madeId}.jsonl`), join("file-history", madeId), join("state", `${madeId}.json`)]) expect(existsSync(join(madeDir, f))).toBe(false);
            // No session left behind: not loaded, not listed, nothing in its composer; no window was told of it, its
            // turn's end not notified (notifyAfterSeconds is 0 here).
            expect([...engine.runtimes.keys()].filter((id) => !before.has(id))).toEqual([]);
            expect(heard.filter((m) => m.sessionId === madeId || m.session?.id === madeId || m.id === madeId)).toEqual([]);
            const listed = (await engine.handle(watcher, "sessions.list", {})) as { cwd: string }[];
            expect(listed.some((x) => x.cwd === folder)).toBe(false);
            expect(drafts).toEqual([]);
            // The prompt edited on the card: Start again makes the session, and counts it.
            const r = (await engine.handle(watcher, "tasks.start", { ...start, prompt: "Fix the thing." })) as StartTaskResult;
            expect(r.failed).toBeUndefined();
            const n = engine.runtimes.get(r.sessionId!)!;
            await until(() => n.session.messageCount > 0);
            const again = (await engine.handle(watcher, "tasks.start", start)) as StartTaskResult;
            expect(again).toMatchObject({ sessionId: r.sessionId, existing: true });
            engine.clients.delete(watcher);
        } finally {
            writeFileSync(settings, was);
        }
    });

    test("refused once something else was sent to it: started, the prompt back in its composer, as soon as that run ends", async () => {
        const folder = realpathSync(tempDir("tasks-hook-sent-"));
        dirs.push(folder);
        const settings = join(iso.home, "settings.json");
        const was = readFileSync(settings, "utf-8");
        // Refuses the first prompt after 1.5 s; lets the next through after 2 s.
        writeFileSync(settings, JSON.stringify({ ...JSON.parse(was), hooks: { UserPromptSubmit: [{ command: "grep -q FOLLOWUP && { sleep 2; exit 0; }; sleep 1.5; echo 'not today' >&2; exit 2" }] } }));
        try {
            const drafts: any[] = [];
            const watcher = { subs: new Set<string>(), send: (m: any) => m.type === "draft" && drafts.push(m) } as never;
            engine.clients.add(watcher);
            const starting = engine.handle(watcher, "tasks.start", { cwd: folder, title: "Fix it", prompt: "Fix the other thing.", model: "mock:mock-opus", origin: { key: "s0#hook-sent", session: "s0", title: "x" } }) as Promise<StartTaskResult>;
            await until(() => [...engine.runtimes.values()].some((x) => x.session.meta.suggestedBy?.key === "s0#hook-sent" && x.busy));
            const n = [...engine.runtimes.values()].find((x) => x.session.meta.suggestedBy?.key === "s0#hook-sent")!;
            await Bun.sleep(200);
            // The user's message, sent while it works: queued behind the first prompt.
            await n.send("FOLLOWUP: and more.");
            const r = await starting;
            // Answered as the refused run ended, before the message behind it was taken (its hook takes 2 s).
            expect(n.session.messageCount).toBe(0);
            expect(r).toMatchObject({ sessionId: n.id });
            expect(r.failed).toBeUndefined();
            expect(drafts).toEqual([expect.objectContaining({ sessionId: n.id, text: "Fix the other thing." })]);
            await until(() => n.idle && n.session.messageCount > 0);
            expect(engine.runtimes.get(n.id)).toBe(n);
            expect(((await engine.handle(watcher, "sessions.list", {})) as { id: string }[]).some((x) => x.id === n.id)).toBe(true);
            engine.clients.delete(watcher);
        } finally {
            writeFileSync(settings, was);
        }
    });

    test("another session's message during the wait: refused, it stays, and the message is delivered", async () => {
        const folder = realpathSync(tempDir("tasks-hook-wake-"));
        dirs.push(folder);
        const settings = join(iso.home, "settings.json");
        const was = readFileSync(settings, "utf-8");
        writeFileSync(settings, JSON.stringify({ ...JSON.parse(was), hooks: { UserPromptSubmit: [{ command: "sleep 1; echo 'not today' >&2; exit 2" }] } }));
        try {
            const drafts: any[] = [];
            const watcher = { subs: new Set<string>(), send: (m: any) => m.type === "draft" && drafts.push(m) } as never;
            engine.clients.add(watcher);
            const starting = engine.handle(watcher, "tasks.start", { cwd: folder, title: "Fix it", prompt: "Fix it.", model: "mock:mock-opus", origin: { key: "s0#hook-wake", session: "s0", title: "x" } }) as Promise<StartTaskResult>;
            await until(() => [...engine.runtimes.values()].some((x) => x.session.meta.suggestedBy?.key === "s0#hook-wake" && x.busy));
            const n = [...engine.runtimes.values()].find((x) => x.session.meta.suggestedBy?.key === "s0#hook-wake")!;
            // As SendToSession delivers it (session-peers.ts deliverTo): a wake, not a queued message.
            n.toolState.wakes!.push(peerWake({ id: "s9", title: "Other" }, "What did you find?"));
            const r = await starting;
            expect(r).toMatchObject({ sessionId: n.id });
            expect(drafts).toEqual([expect.objectContaining({ sessionId: n.id, text: "Fix it." })]);
            await until(() => n.idle && n.session.messageCount > 0);
            expect(JSON.stringify(n.session.messages)).toContain("What did you find?");
            engine.clients.delete(watcher);
        } finally {
            writeFileSync(settings, was);
        }
    });

    test("a hook slower than the bound: started, and a refusal after it puts the prompt back in the session, still listed", async () => {
        const folder = realpathSync(tempDir("tasks-hook-slow-"));
        dirs.push(folder);
        const settings = join(iso.home, "settings.json");
        const was = readFileSync(settings, "utf-8");
        // It refuses no sooner than 3 s in, within its own timeout; the bound is cut to 0.5 s here.
        writeFileSync(settings, JSON.stringify({ ...JSON.parse(was), hooks: { UserPromptSubmit: [{ command: "sleep 3; echo 'not today' >&2; exit 2", timeout: 20 }] } }));
        // Kept redacted, as a transcript keeps it.
        const token = `ghp_${"a".repeat(36)}`;
        const kept = "Fix it. [REDACTED github-token]";
        const o = (engine as any).o;
        o.taskVerdictMaxMs = 500;
        try {
            const drafts: any[] = [];
            const watcher = { subs: new Set<string>(), send: (m: any) => m.type === "draft" && drafts.push(m) } as never;
            engine.clients.add(watcher);
            const r = (await engine.handle(watcher, "tasks.start", { cwd: folder, title: "Fix it", prompt: `Fix it. ${token}`, model: "mock:mock-opus", origin: { key: "s0#hook-slow", session: "s0", title: "x" } })) as StartTaskResult;
            const n = engine.runtimes.get(r.sessionId!)!;
            // Answered before the hook did.
            expect(r.failed).toBeUndefined();
            expect(drafts).toEqual([]);
            expect(n.busy).toBe(true);
            // Another window has it open, and its connection drops before the refusal.
            const away = { subs: new Set<string>(), window: "win-2", send: () => undefined } as any;
            engine.clients.add(away);
            const seen = (await engine.handle(away, "session.open", { id: n.id })) as SessionSnapshot;
            engine.clients.delete(away);
            away.subs.clear();
            await until(() => drafts.length > 0 && n.idle);
            // Back (the same window, a new connection, with what it missed): the prompt goes in its box, once.
            const backGot: any[] = [];
            for (let k = 0; k < 2; k++) {
                const back = { subs: new Set<string>(), window: "win-2", send: (m: any) => m.type === "draft" && backGot.push(m) } as any;
                engine.clients.add(back);
                const res = (await engine.handle(back, "session.open", { id: n.id, since: { epoch: seen.epoch, seq: seen.seq } })) as any;
                expect(res.resumed).toBe(true);
                engine.clients.delete(back);
                back.subs.clear();
            }
            expect(backGot).toEqual([expect.objectContaining({ sessionId: n.id, text: kept })]);
            expect(drafts).toEqual([expect.objectContaining({ sessionId: n.id, text: kept })]);
            expect(readFileSync(join(iso.home, "gui.json"), "utf-8")).not.toContain(token);
            // Empty, but still there for the card to open: loaded and listed.
            expect(n.session.messageCount).toBe(0);
            expect(engine.runtimes.get(n.id)).toBe(n);
            expect(((await engine.handle(watcher, "sessions.list", {})) as { id: string }[]).some((x) => x.id === n.id)).toBe(true);
            // Closed once no window shows it, and after a restart: still listed, and the prompt goes back in its box once
            // to each window (a reload is another), until a window's box has it.
            const win = () => {
                const got: any[] = [];
                const w = { subs: new Set<string>(), send: (m: any) => m.type === "draft" && got.push(m) } as any;
                return { w, got };
            };
            const open = async (e: typeof engine, w: any) => {
                e.clients.add(w);
                expect(((await e.handle(w, "sessions.list", {})) as { id: string; title: string }[]).find((x) => x.id === n.id)).toMatchObject({ title: "Fix it" });
                expect(((await e.handle(w, "session.open", { id: n.id })) as SessionSnapshot).state.id).toBe(n.id);
            };
            const close = async (e: typeof engine, w: any) => {
                await e.handle(w, "session.close", { id: n.id });
                await until(() => !e.runtimes.has(n.id));
            };
            await close(engine, watcher);
            // The window that was sent it at the refusal, opening it three times: not again.
            for (let k = 0; k < 3; k++) {
                await open(engine, watcher);
                await close(engine, watcher);
            }
            expect(drafts).toHaveLength(1);
            // A reload (another window), three times too: once.
            const a = win();
            for (let k = 0; k < 3; k++) {
                await open(engine, a.w);
                await close(engine, a.w);
            }
            expect(a.got).toEqual([expect.objectContaining({ sessionId: n.id, text: kept })]);
            engine.clients.delete(watcher);
            engine.clients.delete(a.w);
            // After a restart: still listed, and the prompt still kept.
            await engine.stop();
            engine = new Engine({ listModels: async () => [] });
            engine.clients.add(client);
            const b = win();
            await open(engine, b.w);
            expect(b.got).toEqual([expect.objectContaining({ sessionId: n.id, text: kept })]);
            // Its box has it now (the window keeps it): a window opening it later isn't sent it, so a cleared box stays clear.
            await engine.handle(b.w, "session.draft", { id: n.id, present: true });
            await close(engine, b.w);
            const c = win();
            await open(engine, c.w);
            expect(c.got).toEqual([]);
            await close(engine, c.w);
            engine.clients.delete(b.w);
            engine.clients.delete(c.w);
        } finally {
            delete o.taskVerdictMaxMs;
            writeFileSync(settings, was);
        }
    });

    test("a session emptied by a rewind: its row hears the suggestion went", async () => {
        const rt = await suggestingSession();
        expect(rt.snapshot().state.suggestions).toHaveLength(1);
        const rows = () => sent.filter((m) => m.type === "sessions.upsert" && m.session.id === rt.id).map((m) => m.session);
        await until(() => rows().at(-1)?.suggested === 1);
        const targets = (await call<{ index: number }[]>("session.rewindTargets", { id: rt.id }));
        const plan = await call<{ planId: string }>("session.rewindPlan", { id: rt.id, index: targets[0]!.index });
        await call("session.rewind", { id: rt.id, index: targets[0]!.index, planId: plan.planId, code: false, conversation: true });
        expect(rt.session.messageCount).toBe(0);
        await until(() => rows().at(-1)?.suggested === undefined);
    });

    test("a model the session can't take once it's made: model_unavailable, and the session goes", async () => {
        const folder = realpathSync(tempDir("tasks-model-"));
        dirs.push(folder);
        const e = engine as any;
        const check = e.checkTaskModel;
        // Past the check before anything is made (as a model gone from the list in between would be).
        e.checkTaskModel = async () => undefined;
        try {
            const before = new Set(engine.runtimes.keys());
            await expect(call("tasks.start", { cwd: folder, title: "Fix it", prompt: "Fix it.", model: "nobody:x", origin: { key: "s0#model", session: "s0", title: "x" } })).rejects.toMatchObject({ code: "model_unavailable" });
            expect([...engine.runtimes.keys()].filter((id) => !before.has(id))).toEqual([]);
        } finally {
            e.checkTaskModel = check;
        }
    });

    test("refused in a new worktree: the worktree stays, and Start again starts in it", async () => {
        const { start, repo, done } = refusingRepo();
        try {
            const r = await call<StartTaskResult>("tasks.start", start);
            expect(r.sessionId).toBeUndefined();
            expect(r.failed).toMatchObject({ code: "blocked", message: "Prompt blocked by hook: not today" });
            expect(r.worktree?.branch).toBe("fix/the-header");
            // The window lost the path (reloaded while it ran): the start remembers it.
            const again = await call<StartTaskResult>("tasks.start", { ...start, prompt: "Fix it." });
            expect(again.failed).toBeUndefined();
            expect(again.worktree).toEqual(r.worktree);
            expect(engine.runtimes.get(again.sessionId!)!.ws.cwd).toBe(r.worktree!.path);
        } finally {
            done();
        }
    });

    test("a remembered worktree with changes in it, or a session in it, isn't gone on in: a new one is made", async () => {
        const { start, repo, done } = refusingRepo();
        try {
            // One remembered isn't gone on in once there are changes in it, or a session is in it: a new one is made.
            const other = { ...start, origin: { key: "s0#hook-wt2", session: "s0", title: "x" } };
            const first = await call<StartTaskResult>("tasks.start", other);
            writeFileSync(join(first.worktree!.path, "README.md"), "changed\n");
            const dirty = await call<StartTaskResult>("tasks.start", other);
            expect(dirty.failed?.code).toBe("blocked");
            expect(dirty.worktree!.path).not.toBe(first.worktree!.path);
            const open = await engine.createSession(dirty.worktree!.path);
            const busy = await call<StartTaskResult>("tasks.start", other);
            expect(busy.worktree!.path).not.toBe(dirty.worktree!.path);
            expect(engine.runtimes.get(open.id)).toBe(open);
        } finally {
            done();
        }
    });

    test("nor one whose branch has commits since, or one since removed", async () => {
        const { start, repo, done } = refusingRepo();
        try {
            // Nor once its branch has commits of its own since: a new one is made, the commit left where it is.
            const third = { ...start, origin: { key: "s0#hook-wt3", session: "s0", title: "x" } };
            const left = await call<StartTaskResult>("tasks.start", third);
            writeFileSync(join(left.worktree!.path, "NOTES.md"), "mine\n");
            git(left.worktree!.path, "add", ".");
            git(left.worktree!.path, "commit", "-qm", "the user's");
            const committed = git(left.worktree!.path, "rev-parse", "HEAD");
            const after = await call<StartTaskResult>("tasks.start", third);
            expect(after.worktree!.path).not.toBe(left.worktree!.path);
            expect(git(left.worktree!.path, "rev-parse", "HEAD")).toBe(committed);
            // A clean one at the commit it was left at is still gone on in.
            const kept = await call<StartTaskResult>("tasks.start", third);
            expect(kept.worktree).toEqual(after.worktree);
            // The window's own path to one that's since been removed: a new one, not a failure Try again repeats.
            git(repo, "worktree", "remove", "--force", kept.worktree!.path);
            const fresh = await call<StartTaskResult>("tasks.start", { ...third, resume: kept.worktree!.path });
            expect(fresh.failed?.code).toBe("blocked");
            expect(fresh.worktree!.path).not.toBe(kept.worktree!.path);
        } finally {
            done();
        }
    });

    test("the window's own worktree path is held to the same checks", async () => {
        const { start, repo, done } = refusingRepo();
        try {
            // The window's own path (as the card sends it after a refusal) is held to the same checks: changes in it, a
            // commit since, a session in it: a new one each time.
            const fifth = { ...start, origin: { key: "s0#hook-wt5", session: "s0", title: "x" } };
            const w1 = await call<StartTaskResult>("tasks.start", fifth);
            writeFileSync(join(w1.worktree!.path, "README.md"), "changed\n");
            const w2 = await call<StartTaskResult>("tasks.start", { ...fifth, resume: w1.worktree!.path });
            expect(w2.failed?.code).toBe("blocked");
            expect(w2.worktree!.path).not.toBe(w1.worktree!.path);
            writeFileSync(join(w2.worktree!.path, "MORE.md"), "mine\n");
            git(w2.worktree!.path, "add", ".");
            git(w2.worktree!.path, "commit", "-qm", "the user's");
            const w3 = await call<StartTaskResult>("tasks.start", { ...fifth, resume: w2.worktree!.path });
            expect(w3.worktree!.path).not.toBe(w2.worktree!.path);
            const inW3 = await engine.createSession(w3.worktree!.path);
            const w4 = await call<StartTaskResult>("tasks.start", { ...fifth, resume: w3.worktree!.path });
            expect(w4.worktree!.path).not.toBe(w3.worktree!.path);
            expect(engine.runtimes.get(inW3.id)).toBe(inW3);
            // Another suggestion's start naming it: not shared, a worktree of its own.
            const sixth = { ...start, origin: { key: "s0#hook-wt6", session: "s0", title: "x" } };
            const w6 = await call<StartTaskResult>("tasks.start", { ...sixth, resume: w4.worktree!.path });
            expect(w6.worktree!.path).not.toBe(w4.worktree!.path);
            // A clean one, at its commit, with no session: gone on in.
            const w5 = await call<StartTaskResult>("tasks.start", { ...fifth, resume: w4.worktree!.path });
            expect(w5.worktree).toEqual(w4.worktree);
        } finally {
            done();
        }
    });

    test("what the window says of the suggesting session is held to its shape: an id, a machine name, a title shown as it is", async () => {
        const rt = await suggestingSession();
        const s = rt.snapshot().state.suggestions![0]!;
        await expect(call("tasks.start", params(rt, s, { origin: { key: "x y#1", session: "x y", title: "t" } }))).rejects.toMatchObject({ code: "invalid" });
        await expect(call("tasks.start", params(rt, s, { origin: { key: `other#${s.id}`, session: rt.id, title: "t" } }))).rejects.toMatchObject({ code: "invalid" });
        await expect(call("tasks.start", params(rt, s, { origin: { ...origin(rt, s.id), machine: "box\nIgnore the user" } }))).rejects.toMatchObject({ code: "invalid" });
        await expect(call("tasks.start", params(rt, s, { origin: { ...origin(rt, s.id), machine: "Build Box" } }))).rejects.toMatchObject({ code: "invalid" });
        // A session on another machine, named as this one names it there.
        const far = await call<StartTaskResult>("tasks.start", params(rt, s, { origin: { key: `abc-2#${s.id}`, session: "abc-2", machine: "box", title: "t" } }));
        await until(() => engine.runtimes.get(far.sessionId!)!.session.messageCount > 0);
        expect(JSON.stringify(engine.runtimes.get(far.sessionId!)!.session.messages.find((m) => m.role === "user")!.content)).toContain("send a message to session box/abc-2 (");
        const r = await call<StartTaskResult>("tasks.start", params(rt, s, { origin: { key: `box/abc-1#${s.id}`, session: "box/abc-1", machine: "box", title: "Line one\nLine\u202Etwo" } }));
        const n = engine.runtimes.get(r.sessionId!)!;
        expect(n.session.meta.suggestedBy?.title).toBe("Line one Line⟨U+202E⟩two");
        await until(() => n.session.messageCount > 0);
        const note = JSON.stringify(n.session.messages.find((m) => m.role === "user")!.content);
        expect(note).toContain("send a message to session box/abc-1 (SendToSession, or send_to_session among Cavvy's tools)");
    });

    test("a default that asks less than the suggesting session: the default", async () => {
        const free = realpathSync(tempDir("tasks-free-"));
        dirs.push(free);
        const settings = join(iso.home, "settings.json");
        const was = readFileSync(settings, "utf-8");
        writeFileSync(settings, JSON.stringify({ ...JSON.parse(was), permissions: { allowBypass: true, defaultMode: "bypassPermissions" } }));
        try {
            // A Manual suggester, a Bypass default: Bypass, as a session the user makes there gets.
            const rt = await suggestingSession("default");
            const s = rt.snapshot().state.suggestions![0]!;
            const r = await call<StartTaskResult>("tasks.start", params(rt, s, { cwd: free, mode: "default" }));
            const made = await call<SessionSnapshot>("session.create", { cwd: free });
            expect(made.state.mode).toBe("bypassPermissions");
            expect(engine.runtimes.get(r.sessionId!)!.mode).toBe("bypassPermissions");
        } finally {
            writeFileSync(settings, was);
        }
    });

    test("how a start went is recorded even when the suggesting session closed meanwhile", async () => {
        const rt = await suggestingSession();
        const s = rt.snapshot().state.suggestions![0]!;
        const claimed = await call<SuggestionState>("session.suggestion", { id: rt.id, suggestionId: s.id, action: "claim" });
        const id = rt.id;
        (client as any).subs.delete(id);
        await engine.handle(client, "session.close", { id });
        await until(() => !engine.runtimes.has(id));
        const r = await call<SuggestionState>("session.suggestion", { id, suggestionId: s.id, action: "started", claimedAt: claimed.claimedAt, started: { sessionId: "s-new", title: "T", cwd: project, at: 1, machine: "box" } });
        expect(r).toMatchObject({ state: "started", started: { sessionId: "s-new" } });
        const snap = await call<SessionSnapshot>("session.open", { id });
        expect(snap.state.suggestions![0]).toMatchObject({ state: "started" });
    });

    test("3 a turn: a queued message the run takes up is a turn of its own", async () => {
        const rt = await suggestingSession();
        const host = rt.toolState.suggest!;
        const r = rt as any;
        r.turnId = "turn-a";
        for (const t of ["A", "B"]) expect(host.suggest({ title: t, prompt: "p", why: "w" }, `a-${t}`)).toEqual({ ok: true });
        expect(host.suggest({ title: "C", prompt: "p", why: "w" }, "a-C")).toEqual({ ok: true });
        expect(host.suggest({ title: "D", prompt: "p", why: "w" }, "a-D")).toEqual({ error: expect.stringContaining("3 tasks this turn") });
        r.turnId = "turn-b";
        expect(host.suggest({ title: "D", prompt: "p", why: "w" }, "b-D")).toEqual({ ok: true });
        r.turnId = undefined;
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
        const o = (key: string) => ({ cwd: join(repo, "app"), title: "Login button misaligned", prompt: "Fix it.", model: "mock:mock-opus", worktree: true, origin: { key, session: "s0", title: "x" } });
        const a = await call<StartTaskResult>("tasks.start", o("s0#a"));
        expect(a.worktree?.branch).toBe("fix/login-button-misaligned");
        // In the same sub-folder of the worktree as the suggester worked in.
        expect(a.cwd).toBe(join(a.worktree!.path, "app"));
        const na = engine.runtimes.get(a.sessionId!)!;
        expect(na.ws.cwd).toBe(a.cwd);
        // Its agent is told the paths the prompt names in the main checkout are this worktree's.
        await until(() => na.session.messageCount > 0);
        const note = JSON.stringify(na.session.messages.find((m) => m.role === "user")!.content);
        expect(note).toContain(`You're working in a new worktree of ${repo}, at ${a.worktree!.path}: paths in ${repo} outside this worktree mean the same files here.`);
        const b = await call<StartTaskResult>("tasks.start", o("s0#b"));
        expect(b.worktree?.branch).toBe("fix/login-button-misaligned-2");
        // One that's only on a remote is taken too.
        const bare = realpathSync(tempDir("tasks-remote-"));
        dirs.push(bare);
        git(bare, "init", "-q", "--bare");
        git(repo, "remote", "add", "origin", bare);
        git(repo, "push", "-q", "origin", "main:fix/login-button-misaligned-3");
        git(repo, "fetch", "-q", "origin");
        const c = await call<StartTaskResult>("tasks.start", o("s0#c"));
        expect(c.worktree?.branch).toBe("fix/login-button-misaligned-4");
        // A branch named "fix" leaves no room under fix/ (git can't have fix beside fix/…: the earlier ones go first).
        for (const w of [a, b, c]) git(repo, "worktree", "remove", "--force", w.worktree!.path);
        git(repo, "worktree", "prune");
        git(repo, "branch", "-D", "fix/login-button-misaligned", "fix/login-button-misaligned-2", "fix/login-button-misaligned-4");
        git(repo, "branch", "fix");
        expect((await call<StartTaskResult>("tasks.start", o("s0#d"))).worktree?.branch).toBe("fix-login-button-misaligned");
        // A remote whose name has a "/" in it counts too.
        const team = realpathSync(tempDir("tasks-team-"));
        dirs.push(team);
        git(team, "init", "-q", "--bare");
        git(repo, "remote", "add", "team/build", team);
        git(repo, "push", "-q", "team/build", "main:fix-login-button-misaligned-2");
        git(repo, "fetch", "-q", "team/build");
        expect((await call<StartTaskResult>("tasks.start", o("s0#e"))).worktree?.branch).toBe("fix-login-button-misaligned-3");
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
