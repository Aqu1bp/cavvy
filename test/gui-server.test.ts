// The GUI server end to end: a real server and WebSocket, the mock model
// (scripts/mock-llm.ts) streaming through the real provider client, and real
// tools working in a temp project.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { startServer } = await import("../src/server/server");
const { applyOp } = await import("../src/server/timeline");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
const { gitArgv, gitEnv } = await import("../src/util/git");
import type { AgentRun, Block, CliSessionsList, InteractionResponse, McpListInfo, McpStatus, ProjectScript, ServerEvent, SessionSearchResult, SessionSnapshot, SessionState, ToolBlock, Turn } from "../src/server/protocol";
import type { AgentEvent } from "../src/agent/agent";
import type { SnapshotTurn } from "../src/agent/turn-snapshots";

const TOKEN = "test-token-0123456789";
const mock = startMockLlm({ delayMs: 0 });
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));

let srv: Awaited<ReturnType<typeof startServer>>;
const projects: string[] = [];
function project(): string {
    const dir = createDemoProject(tempDir("harness-gui-proj-"), { git: false });
    projects.push(dir);
    return dir;
}

async function snapshotRepo(cwd: string) {
    const { gitArgv, gitEnv } = await import("../src/util/git");
    const env = gitEnv();
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    const init = Bun.spawnSync(gitArgv(["init", "-q", "-b", "main"]), { cwd, env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe" });
    expect(init.exitCode).toBe(0);
}

async function snapshotRecords(id: string): Promise<SnapshotTurn[]> {
    const { findSessionAnywhere } = await import("../src/agent/session");
    const file = join(dirname(findSessionAnywhere(id)!), "file-history", id, "turn-snapshots.jsonl");
    return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function commitRepo(cwd: string) {
    const git = (...args: string[]) => {
        const result = Bun.spawnSync(gitArgv(args), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
        if (result.exitCode) throw new Error(result.stderr.toString());
        return result.stdout.toString();
    };
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Harness Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", join(cwd, ".git", "hooks"));
    git("add", "-A");
    git("commit", "-q", "-m", "feat: initial project");
    return git;
}

beforeAll(async () => {
    srv = await startServer({ token: TOKEN, unloadAfterMs: 300 });
});

afterAll(async () => {
    await srv.stop();
    mock.stop();
    iso.cleanup();
});

/** A test client: requests, plus each open session's view kept up to date from its ops. */
class Client {
    ws: WebSocket;
    private next = 1;
    private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    views = new Map<string, { state: SessionState; turns: Turn[]; agents: AgentRun[]; seq: number }>();
    events: ServerEvent[] = [];
    /** Every message as it came off the wire (to check what never reaches a client). */
    raw: string[] = [];
    private listeners = new Set<() => void>();

    constructor(token = TOKEN, headers: Record<string, string> = {}, port = srv.port) {
        this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { protocols: ["harness.v1", `auth.${token}`], headers } as any);
        this.ws.onmessage = (m) => {
            this.raw.push(String(m.data));
            const msg = JSON.parse(String(m.data));
            if ("event" in msg) {
                const ev = msg.event as ServerEvent;
                this.events.push(ev);
                if (ev.type === "session.ops") {
                    const v = this.views.get(ev.sessionId);
                    if (v && ev.seq > v.seq) {
                        for (const op of ev.ops) applyOp(v, op);
                        v.seq = ev.seq;
                    }
                }
                for (const l of this.listeners) l();
                return;
            }
            const w = this.waiting.get(msg.id);
            this.waiting.delete(msg.id);
            if (msg.error) w?.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
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

    async open(method: "session.create" | "session.open" | "cliSessions.import" | "session.fork", params: Record<string, unknown>): Promise<string> {
        const snap = await this.call<SessionSnapshot>(method, params);
        this.views.set(snap.state.id, { state: snap.state, turns: snap.turns, agents: snap.agents, seq: snap.seq });
        return snap.state.id;
    }

    view(id: string) {
        return this.views.get(id)!;
    }

    /** Wait until `pred` holds for the session's view. */
    until(id: string, pred: (v: { state: SessionState; turns: Turn[] }) => boolean, ms = 10_000): Promise<void> {
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
                reject(new Error(`timed out; state: ${JSON.stringify(this.views.get(id)?.state.status)} turns: ${JSON.stringify(this.views.get(id)?.turns.map((x) => [x.status, x.blocks.map((b) => b.t === "tool" ? `${b.name}:${b.status}` : b.t)]))}`));
            }, ms);
            this.listeners.add(check);
            check();
        });
    }

    private answered = new Set<string>();

    /** Answer the next request the session makes (ops arrive a moment after replies, so skip ones already answered); `before` looks at the view as it asks. */
    async answer(id: string, response: InteractionResponse, before?: () => void) {
        const fresh = (v: { state: SessionState }) => v.state.interactions.find((i) => !this.answered.has(i.id));
        await this.until(id, (v) => Boolean(fresh(v)));
        const it = fresh(this.view(id))!;
        this.answered.add(it.id);
        expect(it.kind).toBe(response.kind);
        before?.();
        await this.call("session.respond", { id, interactionId: it.id, response });
        return it;
    }

    close() {
        this.ws.close();
    }
}

/** A fake `claude` (test/fixtures) in a folder of its own, with none of other test files' FAKE_* settings. */
function fakeClaude(): string {
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    const bin = tempDir("harness-gui-cli-");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-claude.ts")}" "$@"\n`);
    chmodSync(join(bin, "claude"), 0o755);
    return join(bin, "claude");
}

/** A fake `codex` (test/fixtures) in a folder of its own, with none of other test files' FAKE_* settings. */
function fakeCodex(): string {
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    const bin = tempDir("harness-gui-cli-");
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-codex.ts")}" "$@"\n`);
    chmodSync(join(bin, "codex"), 0o755);
    return join(bin, "codex");
}

async function client(): Promise<Client> {
    const c = new Client();
    await c.opened();
    return c;
}

const lastTurn = (v: { turns: Turn[] }) => v.turns[v.turns.length - 1]!;
const done = (v: { state: SessionState; turns: Turn[] }) => !v.state.busy && v.turns.length > 0 && lastTurn(v).status !== "running";
const tools = (t: Turn) => t.blocks.filter((b): b is ToolBlock => b.t === "tool");
const texts = (t: Turn) => t.blocks.filter((b): b is Extract<Block, { t: "text" }> => b.t === "text").map((b) => b.text).join("\n");

describe("connecting", () => {
    test("needs the token", async () => {
        const bad = new Client("wrong-token");
        await expect(bad.opened()).rejects.toThrow();
        const ok = await client();
        const hello = await ok.call("hello");
        expect(hello.protocol).toBe(1);
        ok.close();
    });

    test("the token is kept out of transcripts and the commands the server runs", async () => {
        const { redact } = await import("../src/util/redact");
        const { childEnv } = await import("../src/util/env");
        expect(redact(`token ${TOKEN}`)).not.toContain(TOKEN);
        process.env.HARNESS_GUI_TOKEN = TOKEN;
        try {
            expect(Object.values(childEnv())).not.toContain(TOKEN);
        } finally {
            delete process.env.HARNESS_GUI_TOKEN;
        }
    });

    test("--handshake: says where it listens, and stops cleanly when the app writes a line", async () => {
        const p = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "..", "src", "index.ts"), "serve", "--handshake"], { env: process.env as Record<string, string>, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        try {
            const reader = p.stdout.getReader();
            let out = "";
            while (!out.includes("\n")) out += new TextDecoder().decode((await reader.read()).value);
            const ready = JSON.parse(out.split("\n")[0]!);
            expect(ready).toMatchObject({ type: "ready" });
            expect(ready.port).toBeGreaterThan(0);
            expect(ready.token).toHaveLength(64);
            p.stdin.write("quit\n");
            await p.stdin.flush();
            const code = await Promise.race([p.exited, Bun.sleep(10_000).then(() => "still running")]);
            expect(code).toBe(0);
        } finally {
            p.kill();
        }
    }, 20_000);

    test("once it's stopping, it takes on no new work (it would outlive the server)", async () => {
        const { Engine } = await import("../src/server/engine");
        const engine = new Engine();
        const stopped = engine.stop();
        await expect(engine.handle({ subs: new Set(), send() {} }, "session.create", { cwd: project() })).rejects.toThrow(/stopping/);
        await stopped;
    });

    // These start one request while another is half way, so they talk to the engine directly.
    async function engineWithSession(o: { unloadAfterMs?: number; log?: (msg: string) => void } = {}) {
        const { Engine } = await import("../src/server/engine");
        const engine = new Engine(o);
        const c = { subs: new Set<string>(), send() {} };
        engine.clients.add(c);
        const cwd = project();
        const snap = (await engine.handle(c, "session.create", { cwd })) as SessionSnapshot;
        return { engine, c, cwd, id: snap.state.id, rt: engine.runtimes.get(snap.state.id)! };
    }

    test("session speed is capability-gated, persisted, and cannot change during a turn", async () => {
        const { engine, c, id, rt } = await engineWithSession();
        try {
            await expect(engine.handle(c, "session.setFastMode", { id, enabled: true })).rejects.toThrow(/not available/);
            await expect(engine.handle(c, "session.setFastMode", { id, enabled: "yes" })).rejects.toThrow(/boolean/);
            rt.model = { ...rt.model!, supportsFastMode: true };
            await engine.handle(c, "session.setFastMode", { id, enabled: true });
            expect(rt.snapshot().state.fastMode).toBe(true);
            expect(rt.session.fastMode).toBe(true);
            rt.busy = true;
            await expect(engine.handle(c, "session.setFastMode", { id, enabled: false })).rejects.toThrow(/response is done/);
            rt.busy = false;
            await engine.handle(c, "session.setFastMode", { id, enabled: false });
            expect(rt.snapshot().state.fastMode).toBe(false);
            expect(rt.session.fastMode).toBe(false);
        } finally { rt.busy = false; await engine.stop(); }
    });

    async function whenIdle(rt: { idle: boolean }) {
        for (let i = 0; i < 200 && !rt.idle; i++) await Bun.sleep(50);
        expect(rt.idle).toBe(true);
    }

    test("live and reopened snapshot cards keep steered turn ids and include external writes in the badge", async () => {
        const { engine, c, cwd, id, rt } = await engineWithSession();
        try {
            const { gitArgv, gitEnv } = await import("../src/util/git");
            const env = gitEnv();
            for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
            const init = Bun.spawnSync(gitArgv(["init", "-q", "-b", "main"]), { cwd, env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe" });
            expect(init.exitCode).toBe(0);
            await engine.handle(c, "projects.trust", { path: cwd, trust: true });
            rt.session.setTitle("Snapshot test");
            let calls = 0;
            rt.agent!.setModel(rt.model!, { stream: async () => {
                if (++calls === 1) {
                    writeFileSync(join(cwd, "first.txt"), "first change\n");
                    expect((await rt.send("and make the second change")).queued).toBe(true);
                    return { role: "assistant", provider: "mock", model: "mock-opus", stopReason: "tool_use", content: [{ type: "tool_call", id: "snapshot-glob", name: "Glob", input: { pattern: "*.txt" } }] };
                }
                writeFileSync(join(cwd, "second.txt"), "second change\n");
                return { role: "assistant", provider: "mock", model: "mock-opus", stopReason: "end_turn", content: [{ type: "text", text: "Done" }] };
            } } as any);
            await rt.startTurn("make the first change");
            const live = rt.snapshot();
            const promptTurns = live.turns.filter((t) => t.prompt);
            expect(promptTurns.map((t) => t.prompt!.text)).toEqual(["make the first change", "and make the second change"]);
            const snapshotIds = promptTurns.map((t) => t.snapshotId);
            expect(snapshotIds.every((n) => Number.isSafeInteger(n))).toBe(true);
            expect(new Set(snapshotIds).size).toBe(2);
            expect(live.state.filesChanged).toBe(2);
            expect((await rt.gitChanges({ scope: "turn", turnId: snapshotIds[0] })).files.map((f) => f.path)).toEqual(["first.txt"]);
            expect((await rt.gitChanges({ scope: "last-turn" })).files.map((f) => f.path)).toEqual(["second.txt"]);

            await engine.handle(c, "session.close", { id });
            const reopened = (await engine.handle(c, "session.open", { id })) as SessionSnapshot;
            expect(reopened.turns.filter((t) => t.prompt).map((t) => t.snapshotId)).toEqual(snapshotIds);
            expect(reopened.state.filesChanged).toBe(2);
            const resumed = engine.runtimes.get(id)!;
            await resumed.agent?.dispose();
            resumed.agent = undefined;
            resumed.model = undefined;
            expect((await resumed.gitChanges({ scope: "turn", turnId: snapshotIds[0] })).files.map((f) => f.path)).toEqual(["first.txt"]);
        } finally { await engine.stop(); }
    });

    for (const noAgent of [false, true]) test(`closing ${noAgent ? "a review-only" : "a normal"} session reloads snapshots written by another process before reopening`, async () => {
        const { Session } = await import("../src/agent/session");
        const { FileHistory } = await import("../src/agent/checkpoints");
        const { TurnSnapshots } = await import("../src/agent/turn-snapshots");
        const { engine, c, cwd, id, rt } = await engineWithSession();
        const answer = () => ({ role: "assistant" as const, provider: "mock", model: "mock-opus", stopReason: "end_turn" as const, content: [{ type: "text" as const, text: "Done" }] });
        try {
            await snapshotRepo(cwd);
            await engine.handle(c, "projects.trust", { path: cwd, trust: true });
            rt.session.setTitle("Snapshot handoff");
            rt.agent!.setModel(rt.model!, { stream: async () => {
                writeFileSync(join(cwd, "first.txt"), "first change\n");
                return answer();
            } } as any);
            await rt.startTurn("the GUI turn");
            const firstId = rt.snapshot().turns.at(-1)!.snapshotId!;
            const original = TurnSnapshots.for(rt.session, cwd);
            if (noAgent) {
                await rt.agent!.dispose();
                rt.agent = undefined;
            }
            await engine.handle(c, "session.close", { id });
            // Wait until the normal close has released ownership, as another process must.
            await (engine as any).closing.get(id);
            expect(engine.runtimes.has(id)).toBe(false);
            // A late turn-finally callback reads the badge after close; it must not revive the recorder.
            (rt as any).filesChanged();
            expect(TurnSnapshots.for(rt.session, cwd)).toBe(original);
            const elsewhere = Session.load(rt.session.path);
            let externalId: number;
            try {
                const history = FileHistory.for(elsewhere)!;
                externalId = history.begin();
                // A separate process has its own in-memory snapshot store.
                const snapshots = new TurnSnapshots(history.dir, cwd);
                await snapshots.begin(externalId, "the terminal turn");
                elsewhere.push({ role: "user", content: [{ type: "text", text: "the terminal turn" }], meta: { kind: "prompt", checkpoint: externalId } });
                writeFileSync(join(cwd, "external.txt"), "written while the GUI was closed\n");
                elsewhere.push(answer());
                await snapshots.end();
            } finally { elsewhere.release(); }
            const reopened = await engine.handle(c, "session.open", { id }) as SessionSnapshot;
            expect(reopened.turns.filter((t) => t.prompt).map((t) => t.snapshotId)).toEqual([firstId, externalId]);
            const resumed = engine.runtimes.get(id)!;
            for (const scope of ["turn", "last-turn"] as const) {
                const changes = await resumed.gitChanges({ scope, turnId: externalId });
                expect(changes).toMatchObject({ turnId: externalId, snapshotAvailable: true, incomplete: false });
                expect(changes.files.map((f) => f.path)).toEqual(["external.txt"]);
            }
            await resumed.ready;
            resumed.agent!.setModel(resumed.model!, { stream: async () => {
                writeFileSync(join(cwd, "third.txt"), "back in the GUI\n");
                return answer();
            } } as any);
            await resumed.startTurn("another GUI turn");
            const thirdId = resumed.snapshot().turns.at(-1)!.snapshotId!;
            expect(thirdId).toBeGreaterThan(externalId);
            expect((await resumed.gitChanges({ scope: "last-turn" })).files.map((f) => f.path)).toEqual(["third.txt"]);
            expect((await resumed.gitChanges({ scope: "turn", turnId: externalId })).files.map((f) => f.path)).toEqual(["external.txt"]);
        } finally { await engine.stop(); }
    });

    test("a steered turn cut off during close keeps its start and the preceding turn's completed diff", async () => {
        const { closeTiming } = await import("../src/server/runtime");
        const { Engine } = await import("../src/server/engine");
        const { engine, c, cwd, id, rt } = await engineWithSession();
        const restart = new Engine();
        const next = { subs: new Set<string>(), send() {} };
        restart.clients.add(next);
        const saved = closeTiming.turnMs;
        closeTiming.turnMs = 20;
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => { release = resolve; });
        let calls = 0;
        let run: Promise<void> | undefined;
        try {
            await snapshotRepo(cwd);
            await engine.handle(c, "projects.trust", { path: cwd, trust: true });
            rt.session.setTitle("Interrupted steering snapshots");
            rt.agent!.setModel(rt.model!, { stream: async () => {
                if (++calls === 1) {
                    writeFileSync(join(cwd, "first.txt"), "first change\n");
                    await rt.send("then the second change");
                    return { role: "assistant", provider: "mock", model: "mock-opus", stopReason: "tool_use", content: [{ type: "tool_call", id: "cutoff-glob", name: "Glob", input: { pattern: "*.txt" } }] };
                }
                writeFileSync(join(cwd, "second.txt"), "unfinished change\n");
                await waiting;
                return { role: "assistant", provider: "mock", model: "mock-opus", stopReason: "end_turn", content: [{ type: "text", text: "Late reply" }] };
            } } as any);
            run = rt.startTurn("make the first change");
            for (let i = 0; i < 200 && calls < 2; i++) await Bun.sleep(10);
            expect(calls).toBe(2);
            await engine.stop();
            const reopened = await restart.handle(next, "session.open", { id }) as SessionSnapshot;
            const turns = reopened.turns.filter((t) => t.prompt);
            expect(turns.map((t) => [t.prompt!.text, t.status])).toEqual([["make the first change", "done"], ["then the second change", "aborted"]]);
            expect(turns[1]!.snapshotId).toBeGreaterThan(turns[0]!.snapshotId!);
            const resumed = restart.runtimes.get(id)!;
            expect((await resumed.gitChanges({ scope: "turn", turnId: turns[0]!.snapshotId })).files.map((f) => f.path)).toEqual(["first.txt"]);
            expect(await resumed.gitChanges({ scope: "last-turn" })).toMatchObject({ turnId: turns[1]!.snapshotId, incomplete: true, snapshotAvailable: false, files: [] });
            const records = await snapshotRecords(id);
            expect(records.filter((r) => r.id === turns[1]!.snapshotId)).toHaveLength(1);
            expect(records.at(-1)!.start.tree).toBeString();
            expect(records.at(-1)!.end).toBeUndefined();
            release();
            await run;
            expect(await snapshotRecords(id)).toEqual(records);
        } finally {
            release();
            await run;
            closeTiming.turnMs = saved;
            await restart.stop();
            await engine.stop();
        }
    });

    test("commit RPCs validate requests and refuse busy and untrusted sessions", async () => {
        const { engine, c, cwd, id, rt } = await engineWithSession();
        const git = commitRepo(cwd);
        writeFileSync(join(cwd, "selected.txt"), "new\n");
        const head = git("rev-parse", "HEAD");
        const request = { id, paths: ["selected.txt"], message: "feat: selected file" };
        try {
            await rt.ready;
            for (const paths of [[], [1], ["bad\0path"], ["x".repeat(4097)], Array(1001).fill("selected.txt")]) {
                await expect(engine.handle(c, "session.gitCommit", { ...request, paths })).rejects.toMatchObject({ code: "invalid" });
                await expect(engine.handle(c, "session.gitCommitMessage", { id, paths })).rejects.toMatchObject({ code: "invalid" });
            }
            for (const message of [" ", "bad\0message", "界".repeat(22000), 12]) {
                await expect(engine.handle(c, "session.gitCommit", { ...request, message })).rejects.toMatchObject({ code: "invalid" });
            }
            for (const expectedHead of [null, "main", {}, { branch: "main" }, { detached: false }, { detached: true, branch: "main" }, { detached: true }, { detached: true, sha: "1234567" }]) {
                await expect(engine.handle(c, "session.gitCommit", { ...request, expectedHead })).rejects.toMatchObject({ code: "invalid" });
            }
            rt.busy = true;
            await expect(engine.handle(c, "session.gitCommit", request)).rejects.toMatchObject({ code: "busy", message: expect.stringContaining("still working") });
            await expect(engine.handle(c, "session.gitCommitMessage", request)).rejects.toMatchObject({ code: "busy" });
            rt.busy = false;
            rt.ws.trusted = false;
            await expect(engine.handle(c, "session.gitCommit", request)).rejects.toMatchObject({ code: "needs_trust", message: expect.stringContaining("hooks") });
            await expect(engine.handle(c, "session.gitCommitMessage", request)).rejects.toMatchObject({ code: "needs_trust" });
            expect(git("rev-parse", "HEAD")).toBe(head);
        } finally {
            rt.busy = false;
            await engine.stop();
        }
    });

    test("commit RPC refuses a branch different from the dialog snapshot", async () => {
        const { engine, c, cwd, id, rt } = await engineWithSession();
        const git = commitRepo(cwd);
        writeFileSync(join(cwd, "selected.txt"), "new\n");
        const head = git("rev-parse", "HEAD");
        const request = { id, paths: ["selected.txt"], message: "feat: selected file" };
        try {
            await rt.ready;
            git("checkout", "-q", "-b", "other");
            await expect(engine.handle(c, "session.gitCommit", {
                ...request,
                expectedHead: { branch: "main", detached: false },
            })).rejects.toMatchObject({ message: "The branch changed from main to other; reopen the dialog." });
            git("checkout", "-q", "--detach");
            await expect(engine.handle(c, "session.gitCommit", {
                ...request,
                expectedHead: { branch: "other", detached: false },
            })).rejects.toMatchObject({ message: "The branch changed from other to detached HEAD; reopen the dialog." });
            git("checkout", "-q", "other");
            await expect(engine.handle(c, "session.gitCommit", {
                ...request,
                expectedHead: { detached: true, sha: head.trim() },
            })).rejects.toMatchObject({ message: "The branch changed from detached HEAD to other; reopen the dialog." });
            expect(git("rev-parse", "HEAD")).toBe(head);
            expect(existsSync(join(cwd, ".git", "index.lock"))).toBe(false);
            const result = await engine.handle(c, "session.gitCommit", {
                ...request,
                expectedHead: { branch: "other", detached: false },
            });
            expect(result).toMatchObject({ branch: "other", subject: request.message });
        } finally {
            await engine.stop();
        }
    });

    test("commit RPC refuses a detached HEAD different from the dialog snapshot", async () => {
        const { engine, c, cwd, id, rt } = await engineWithSession();
        const git = commitRepo(cwd);
        const first = git("rev-parse", "HEAD").trim();
        git("commit", "-q", "--allow-empty", "-m", "second commit");
        const second = git("rev-parse", "HEAD").trim();
        git("checkout", "-q", "--detach", first);
        try {
            await rt.ready;
            const shown = await engine.handle(c, "session.gitChanges", { id, scope: "uncommitted" }) as { head: { sha: string } };
            expect(shown.head.sha).toBe(first);
            git("checkout", "-q", "--detach", second);
            writeFileSync(join(cwd, "selected.txt"), "new\n");
            const request = { id, paths: ["selected.txt"], message: "feat: selected file" };
            await expect(engine.handle(c, "session.gitCommit", {
                ...request,
                expectedHead: { detached: true, sha: shown.head.sha },
            })).rejects.toMatchObject({ message: `The detached HEAD changed from ${first.slice(0, 7)} to ${second.slice(0, 7)}; reopen the dialog.` });
            expect(git("rev-parse", "HEAD").trim()).toBe(second);
            expect(existsSync(join(cwd, ".git", "index.lock"))).toBe(false);
            const result = await engine.handle(c, "session.gitCommit", {
                ...request,
                expectedHead: { detached: true, sha: second },
            });
            expect(result).toMatchObject({ subject: request.message });
        } finally {
            await engine.stop();
        }
    });

    test("commit message generation uses the small model, redacts selected diffs, and never commits", async () => {
        const { registerSecret, unregisterSecret } = await import("../src/util/redact");
        const { engine, c, cwd, id, rt } = await engineWithSession();
        const git = commitRepo(cwd);
        const secret = "commit-generation-secret-abcdefghijklmnop";
        registerSecret(secret, "commit-test");
        writeFileSync(join(cwd, "selected.txt"), `selected content ${secret}\n`);
        writeFileSync(join(cwd, "other.txt"), "unselected content must not be sent\n");
        const head = git("rev-parse", "HEAD");
        const message = "feat: add selected file\n\nAn editable body.";
        let calls = 0;
        const original = rt.complete;
        rt.complete = async (system, prompt, signal, opts) => {
            calls++;
            expect(system).toContain("72 characters");
            expect(prompt).toContain("feat: initial project");
            expect(prompt).toContain("selected content");
            expect(prompt).toContain("[REDACTED commit-test]");
            expect(prompt).not.toContain(secret);
            expect(prompt).not.toContain("unselected content");
            expect(signal).toBeInstanceOf(AbortSignal);
            expect(opts?.target?.model.id).toBe("mock-haiku");
            return message;
        };
        try {
            await rt.ready;
            expect(calls).toBe(0);
            const result = await engine.handle(c, "session.gitCommitMessage", { id, paths: ["selected.txt"] });
            expect(result).toEqual({ message, model: "mock:mock-haiku" });
            expect(calls).toBe(1);
            expect(git("rev-parse", "HEAD")).toBe(head);
            expect(git("diff", "--cached", "--name-only")).toBe("");
        } finally {
            rt.complete = original;
            unregisterSecret(secret);
            await engine.stop();
        }
    });

    test("agent backends explain the small-model setting and generate messages with another provider", async () => {
        const { engine, c, cwd, id, rt } = await engineWithSession();
        const git = commitRepo(cwd);
        writeFileSync(join(cwd, "selected.txt"), "selected\n");
        const head = git("rev-parse", "HEAD");
        const original = rt.complete;
        let calls = 0;
        rt.complete = async (_system, _prompt, _signal, opts) => {
            calls++;
            expect(opts?.target?.model).toMatchObject({ provider: "mock", id: "mock-haiku" });
            expect((opts?.target?.client as { agentBackend?: boolean }).agentBackend).not.toBe(true);
            return "feat: add selected file";
        };
        try {
            await rt.ready;
            // The same capability flag exposed by both Claude Code and Codex clients.
            rt.client = Object.assign({}, rt.client, { agentBackend: true });
            for (const provider of ["claude-code", "codex"]) {
                rt.model = { ...rt.model!, provider, id: "default" };
                rt.ws.settings = { ...rt.ws.settings, smallModel: undefined };
                const before = calls;
                await expect(engine.handle(c, "session.gitCommitMessage", { id, paths: ["selected.txt"] })).rejects.toMatchObject({ code: "no_model", message: "Set a small model from another provider in Settings to generate messages." });
                expect(calls).toBe(before);
                rt.ws.settings = { ...rt.ws.settings, smallModel: "mock:mock-haiku" };
                expect(await engine.handle(c, "session.gitCommitMessage", { id, paths: ["selected.txt"] })).toEqual({ message: "feat: add selected file", model: "mock:mock-haiku" });
                expect(calls).toBe(before + 1);
            }
            expect(git("rev-parse", "HEAD")).toBe(head);
        } finally {
            rt.complete = original;
            await engine.stop();
        }
    });

    test("a commit reserves the session while its repository hook runs", async () => {
        const { engine, c, cwd, id, rt } = await engineWithSession();
        const git = commitRepo(cwd);
        writeFileSync(join(cwd, "selected.txt"), "new\n");
        const hooks = join(cwd, ".git", "hooks");
        writeFileSync(join(hooks, "pre-commit"), '#!/bin/sh\ntouch .git/commit-started\nwhile [ ! -e .git/commit-release ]; do sleep 0.02; done\n');
        chmodSync(join(hooks, "pre-commit"), 0o755);
        let pending: Promise<unknown> | undefined;
        try {
            await rt.ready;
            pending = engine.handle(c, "session.gitCommit", { id, paths: ["selected.txt"], message: "feat: selected file" });
            for (let i = 0; i < 200 && !existsSync(join(cwd, ".git", "commit-started")); i++) await Bun.sleep(10);
            expect(existsSync(join(cwd, ".git", "commit-started"))).toBe(true);
            expect(rt.idle).toBe(false);
            await expect(engine.handle(c, "session.send", { id, text: "!touch should-not-run" })).rejects.toMatchObject({ code: "busy" });
            await expect(engine.handle(c, "session.gitCommit", { id, paths: ["selected.txt"], message: "another commit" })).rejects.toMatchObject({ code: "busy" });
            expect(existsSync(join(cwd, "should-not-run"))).toBe(false);
            writeFileSync(join(cwd, ".git", "commit-release"), "");
            await pending;
            expect(rt.idle).toBe(true);
            expect(git("log", "-1", "--format=%s").trim()).toBe("feat: selected file");
        } finally {
            writeFileSync(join(cwd, ".git", "commit-release"), "");
            await pending?.catch(() => undefined);
            await engine.stop();
        }
    });

    for (const phase of ["pre-commit", "reference-transaction"]) {
        test(`stopping the engine during ${phase} cleans up the hook and index lock`, async () => {
            const { engine, c, cwd, id, rt } = await engineWithSession();
            const git = commitRepo(cwd);
            const head = git("rev-parse", "HEAD");
            const index = readFileSync(join(cwd, ".git", "index"));
            writeFileSync(join(cwd, "selected.txt"), "new\n");
            const hook = join(cwd, ".git", "hooks", phase);
            const guard = phase === "reference-transaction" ? '[ "$1" = committed ] || exit 0\n' : "";
            writeFileSync(hook, '#!/bin/sh\n' + guard + 'trap "" TERM\necho $$ > .git/commit-hook-pid\nwhile [ ! -e .git/commit-release ]; do sleep 0.02; done\n');
            chmodSync(hook, 0o755);
            let pending: Promise<unknown> | undefined;
            try {
                await rt.ready;
                pending = engine.handle(c, "session.gitCommit", { id, paths: ["selected.txt"], message: "interrupted commit" }).catch((e) => e);
                for (let i = 0; i < 200 && !existsSync(join(cwd, ".git", "commit-hook-pid")); i++) await Bun.sleep(10);
                expect(existsSync(join(cwd, ".git", "commit-hook-pid"))).toBe(true);
                const pid = Number(readFileSync(join(cwd, ".git", "commit-hook-pid"), "utf8"));
                const started = Date.now();
                await engine.stop();
                expect(Date.now() - started).toBeLessThan(6500);
                expect(existsSync(join(cwd, ".git", "index.lock"))).toBe(false);
                const alive = () => {
                    try {
                        process.kill(pid, 0);
                        return true;
                    } catch (e) {
                        if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
                        throw e;
                    }
                };
                for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(10);
                expect(alive()).toBe(false);
                if (phase === "pre-commit") {
                    expect(await pending).toMatchObject({ code: "git_cancelled" });
                    expect(git("rev-parse", "HEAD")).toBe(head);
                    expect(readFileSync(join(cwd, ".git", "index"))).toEqual(index);
                } else {
                    expect(await pending).toMatchObject({ subject: "interrupted commit" });
                    expect(git("show", "HEAD:selected.txt")).toBe("new\n");
                    expect(git("diff", "--cached")).toBe("");
                }
            } finally {
                writeFileSync(join(cwd, ".git", "commit-release"), "");
                await pending;
                await engine.stop();
            }
        }, 10_000);
    }

    test("a new chat saves its speed; an older chat without one gets the default without being written to", async () => {
        const { findSessionAnywhere } = await import("../src/agent/session");
        const { engine, c, id, rt } = await engineWithSession();
        try {
            await engine.handle(c, "session.send", { id, text: "first prompt" });
            await whenIdle(rt);
            await engine.handle(c, "session.close", { id });
            const file = findSessionAnywhere(id)!;
            const lines = readFileSync(file, "utf8").split("\n");
            expect(lines.some((l) => l.includes('"t":"fastMode"'))).toBe(true);
            // As saved before speeds were.
            const older = lines.filter((l) => !l.includes('"t":"fastMode"')).join("\n");
            writeFileSync(file, older);
            rt.ws.settings.fastMode = true;
            await engine.handle(c, "session.open", { id });
            expect(engine.runtimes.get(id)!.session.fastMode).toBe(true);
            expect(readFileSync(file, "utf8")).toBe(older);
        } finally { delete rt.ws.settings.fastMode; await engine.stop(); }
    });

    test("a message waiting for a model switch when the server stops isn't run", async () => {
        const { engine, c, cwd, id } = await engineWithSession();
        const switched = engine.handle(c, "session.setModel", { id, ref: "mock:mock-haiku", persist: false });
        const sent = engine.handle(c, "session.send", { id, text: `!touch ${join(cwd, "ran")}` });
        await engine.stop();
        await switched.catch(() => undefined);
        await expect(sent).rejects.toThrow(/closed/);
        await Bun.sleep(300);
        expect(existsSync(join(cwd, "ran"))).toBe(false);
    });

    test("a compaction asked for during a model switch runs on the new model", async () => {
        const { engine, c, id, rt } = await engineWithSession();
        await engine.handle(c, "session.send", { id, text: "first prompt" });
        await whenIdle(rt);
        const before = mock.requests.length;
        const switched = engine.handle(c, "session.setModel", { id, ref: "mock:mock-haiku", persist: false });
        await engine.handle(c, "session.compact", { id });
        await switched;
        // The compaction (with the session's tools, to reuse its cached prefix).
        expect(mock.requests.slice(before).filter((r) => r.kind !== "title").map((r) => r.model)).toEqual(["mock-haiku"]);
        await engine.stop();
    });

    test("a turn that failed shows why when the session is opened again", async () => {
        const { engine, c, id, rt } = await engineWithSession();
        try {
            await engine.handle(c, "session.send", { id, text: "reject400 this one" });
            await whenIdle(rt);
            await engine.handle(c, "session.close", { id });
            const snap = (await engine.handle(c, "session.open", { id })) as SessionSnapshot;
            const t = snap.turns.at(-1)!;
            expect(t.prompt?.text).toBe("reject400 this one");
            expect(t.status).toBe("error");
            expect(t.blocks.filter((b) => b.t === "notice").map((b) => (b as Extract<Block, { t: "notice" }>).text)).toEqual(["Mock: Invalid request: the mock refuses this one (400)"]);
        } finally {
            await engine.stop();
        }
    });

    test("spend on a model with no known price shows as unknown, then and after reopening", async () => {
        const { engine, c, id, rt } = await engineWithSession();
        try {
            await engine.handle(c, "session.send", { id, text: "first prompt" });
            await whenIdle(rt);
            // The mock's models have no prices.
            expect(rt.snapshot().state).toMatchObject({ cost: 0, costUnknown: true });
            await engine.handle(c, "session.close", { id });
            const snap = (await engine.handle(c, "session.open", { id })) as SessionSnapshot;
            expect(snap.state).toMatchObject({ cost: 0, costUnknown: true });
        } finally {
            await engine.stop();
        }
    });

    test("a greeting doesn't name the session, and a title that failed is asked for again: the next real prompt names it", async () => {
        const { engine, c, id, rt } = await engineWithSession();
        const titles = () => mock.requests.filter((r) => r.kind === "title").length;
        const titled = async () => {
            for (let i = 0; i < 100 && !rt.session.title; i++) await Bun.sleep(20);
        };
        try {
            const before = titles();
            await engine.handle(c, "session.send", { id, text: "Hi" });
            await whenIdle(rt);
            await engine.handle(c, "session.send", { id, text: "hello there!" });
            await whenIdle(rt);
            expect(titles()).toBe(before);
            // This one is asked about, and the request fails.
            await engine.handle(c, "session.send", { id, text: "an untitled one" });
            await whenIdle(rt);
            for (let i = 0; i < 100 && titles() === before; i++) await Bun.sleep(20);
            await Bun.sleep(50);
            expect(rt.session.title).toBeUndefined();
            await engine.handle(c, "session.send", { id, text: "explain the layout" });
            await whenIdle(rt);
            await titled();
            expect(rt.session.title).toBe("Explain the layout");
            expect(titles()).toBe(before + 2);
        } finally {
            await engine.stop();
        }
    });

    test("a title that fails every try comes from the first prompt that said something, and each failure is logged", async () => {
        const logged: string[] = [];
        const { engine, c, id, rt } = await engineWithSession({ log: (m) => logged.push(m) });
        const titles = () => mock.requests.filter((r) => r.kind === "title").length;
        try {
            const before = titles();
            for (const [i, text] of ["untitled: fix the login bug", "an untitled second", "still untitled"].entries()) {
                await engine.handle(c, "session.send", { id, text });
                await whenIdle(rt);
                for (let k = 0; k < 100 && logged.length <= i; k++) await Bun.sleep(20);
                expect(logged[i]).toContain(`no title (try ${i + 1} of 3)`);
                if (i < 2) expect(rt.session.title).toBeUndefined();
            }
            for (let k = 0; k < 100 && !rt.session.title; k++) await Bun.sleep(20);
            expect(rt.session.title).toBe("Untitled: fix the login bug");
            expect(titles()).toBe(before + 3);
            // Named: no more asking.
            await engine.handle(c, "session.send", { id, text: "explain the layout" });
            await whenIdle(rt);
            await Bun.sleep(50);
            expect(titles()).toBe(before + 3);
        } finally {
            await engine.stop();
        }
    });

    for (const provider of ["claude-code", "codex"] as const)
    test(`a ${provider} session with no smallModel is named from its prompt: ${provider} can't be asked for a title`, async () => {
        const { saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
        saveAgentConfig(provider, { path: provider === "codex" ? fakeCodex() : fakeClaude() });
        process.env.FAKE_SCENARIO = provider === "codex" ? "cmd" : "silent";
        const logged: string[] = [];
        const { engine, c, id, rt } = await engineWithSession({ log: (m) => logged.push(m) });
        const titles = () => mock.requests.filter((r) => r.kind === "title").length;
        try {
            await engine.handle(c, "models.list", { refresh: true });
            await engine.handle(c, "session.setModel", { id, ref: `${provider}:default`, persist: false });
            expect(rt.model?.provider).toBe(provider);
            rt.ws.settings = { ...rt.ws.settings, smallModel: undefined };
            const before = titles();
            await engine.handle(c, "session.send", { id, text: "## map the auth module\nand say how sign-in strategies are registered" });
            for (let k = 0; k < 250 && !rt.session.title; k++) await Bun.sleep(20);
            expect(rt.session.title).toBe("Map the auth module");
            expect(titles()).toBe(before);
            expect(logged).toEqual([]);
        } finally {
            await engine.stop();
            delete process.env.FAKE_SCENARIO;
            removeAgentConfig(provider);
        }
    }, 30_000);

    test("a title made from the prompt has no key in it, cut or capitalized", async () => {
        const { saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
        const { registerSecret, unregisterSecret } = await import("../src/util/redact");
        const secret = "abcdefghijklmnopqrstuvwx";
        saveAgentConfig("claude-code", { path: fakeClaude() });
        process.env.FAKE_SCENARIO = "silent";
        registerSecret(secret, "test-key");
        const { engine, c, id, rt } = await engineWithSession();
        try {
            await engine.handle(c, "models.list", { refresh: true });
            await engine.handle(c, "session.setModel", { id, ref: "claude-code:default", persist: false });
            rt.ws.settings = { ...rt.ws.settings, smallModel: undefined };
            // First (it would be capitalized), and long enough to be cut in the middle.
            await engine.handle(c, "session.send", { id, text: `${secret} investigate auth, then ${secret}${secret} and more words after it` });
            for (let k = 0; k < 250 && !rt.session.title; k++) await Bun.sleep(20);
            const title = rt.session.title!;
            expect(title).toStartWith("[REDACTED test-key] investigate auth");
            expect(title.toLowerCase()).not.toContain(secret.slice(0, 8));
        } finally {
            await engine.stop();
            unregisterSecret(secret);
            delete process.env.FAKE_SCENARIO;
            removeAgentConfig("claude-code");
        }
    }, 30_000);

    test("a turn still waiting on the model when the server stops is saved as interrupted", async () => {
        const { findSessionAnywhere } = await import("../src/agent/session");
        const { engine, c, id } = await engineWithSession();
        const before = mock.requests.length;
        await engine.handle(c, "session.send", { id, text: "hangforever please" });
        for (let i = 0; i < 200 && !mock.requests.slice(before).some((r) => r.kind === "turn"); i++) await Bun.sleep(10);
        await engine.stop();
        const lines = readFileSync(findSessionAnywhere(id)!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
        const last = lines.filter((l) => l.t === "msg").at(-1);
        expect(last.m.meta.kind).toBe("interrupt");
    });

    test("a turn still stopping when the server stops has its interrupt noted for it, once", async () => {
        const { findSessionAnywhere } = await import("../src/agent/session");
        const { closeTiming } = await import("../src/server/runtime");
        const { Engine } = await import("../src/server/engine");
        const { engine, c, cwd, id, rt } = await engineWithSession();
        await snapshotRepo(cwd);
        await engine.handle(c, "projects.trust", { path: cwd, trust: true });
        rt.ws.settings.permissions = { allow: ["Bash"] };
        // Closing outlasts the command, which stops 2s after SIGTERM (SIGKILL).
        rt.ws.settings.hooks = { SessionEnd: [{ command: "sleep 3" }] };
        const saved = closeTiming.turnMs;
        closeTiming.turnMs = 200;
        try {
            await engine.handle(c, "session.send", { id, text: "stubborn please" });
            const running = () => rt.snapshot().turns.at(-1)?.blocks.some((b) => b.t === "tool" && b.status === "running");
            for (let i = 0; i < 300 && !running(); i++) await Bun.sleep(10);
            expect(running()).toBe(true);
            await Bun.sleep(100);
            await engine.stop();
            const msgs = readFileSync(findSessionAnywhere(id)!, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.t === "msg").map((l) => l.m);
            const call = msgs.findIndex((m) => m.role === "assistant" && m.content.some((p: any) => p.type === "tool_call"));
            expect(call).toBeGreaterThan(0);
            // Its call answered, and the interrupt, as the turn would have; nothing after it.
            expect(msgs.slice(call + 1)).toHaveLength(1);
            const last = msgs.at(-1);
            expect(last.meta.kind).toBe("tool_results");
            expect(last.content[0]).toMatchObject({ type: "tool_result", toolName: "Bash", isError: true });
            expect(last.content.at(-1).text).toBe("[Request interrupted by user for tool use]");
            // The late run has settled, but cutoff did not invent a closing snapshot.
            await whenIdle(rt);
            const checkpoint = msgs[0].meta.checkpoint;
            const records = await snapshotRecords(id);
            expect(records).toHaveLength(1);
            expect(records[0]!.id).toBe(checkpoint);
            expect(records[0]!.start.tree).toBeString();
            expect(records[0]!.end).toBeUndefined();
            const resumed = new Engine();
            const next = { subs: new Set<string>(), send() {} };
            resumed.clients.add(next);
            try {
                const view = await resumed.handle(next, "session.open", { id }) as SessionSnapshot;
                expect(view.turns.at(-1)).toMatchObject({ status: "aborted", snapshotId: checkpoint });
                const changes = await resumed.runtimes.get(id)!.gitChanges({ scope: "turn", turnId: checkpoint });
                expect(changes).toMatchObject({ incomplete: true, snapshotAvailable: false, files: [] });
                expect(changes.notes?.join(" ")).toContain("without a closing snapshot");
            } finally { await resumed.stop(); }
            expect(await snapshotRecords(id)).toEqual(records);
        } finally {
            closeTiming.turnMs = saved;
        }
    }, 20_000);

    test("a session opened again while it's being closed waits for that", async () => {
        const { engine, c, cwd, id, rt } = await engineWithSession();
        await engine.handle(c, "session.send", { id, text: "first prompt" });
        await whenIdle(rt);
        const ended = join(cwd, "ended");
        rt.ws.settings.hooks = { SessionEnd: [{ command: `sleep 0.5; touch '${ended}'` }] };
        await engine.handle(c, "session.close", { id });
        expect(engine.runtimes.has(id)).toBe(false);
        await engine.handle(c, "session.open", { id });
        // Not alongside the copy still closing (whose late title or notices would land in this one).
        expect(existsSync(ended)).toBe(true);
        expect(engine.runtimes.get(id)).not.toBe(rt);
        await engine.stop();
    });

    test("a session whose window went away while it was being created is closed", async () => {
        const { Engine } = await import("../src/server/engine");
        const engine = new Engine({ unloadAfterMs: 50 });
        const c = { subs: new Set<string>(), send() {} };
        engine.clients.add(c);
        const created = engine.handle(c, "session.create", { cwd: project() });
        engine.dropClient(c);
        const id = ((await created) as SessionSnapshot).state.id;
        for (let i = 0; i < 40 && engine.runtimes.has(id); i++) await Bun.sleep(50);
        expect(engine.runtimes.has(id)).toBe(false);
        await engine.stop();
    });

    test("a short HARNESS_GUI_TOKEN is refused", () => {
        const r = Bun.spawnSync([process.execPath, "--no-env-file", join(import.meta.dir, "..", "src", "index.ts"), "serve", "--handshake"], { env: { ...process.env, HARNESS_GUI_TOKEN: "dev" } as Record<string, string>, stdin: "ignore" });
        expect(r.exitCode).toBe(1);
        expect(r.stderr.toString()).toContain("at least 16 characters");
    });

    test("refuses other origins and hosts", async () => {
        const evil = new Client(TOKEN, { Origin: "https://evil.example" });
        await expect(evil.opened()).rejects.toThrow();
        const app = new Client(TOKEN, { Origin: "tauri://localhost" });
        await app.opened();
        app.close();
        const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`, { headers: { Host: "rebound.example:80" } });
        expect(res.status).toBe(403);
    });

    test("a login link's code works once", async () => {
        const link = srv.loginUrl();
        const code = link.split("#code=")[1]!;
        const origin = `http://127.0.0.1:${srv.port}`;
        const ex = (c: string, o = origin) => fetch(`${origin}/auth/exchange`, { method: "POST", headers: { Origin: o, "Content-Type": "application/json" }, body: JSON.stringify({ code: c }) });
        expect((await ex(code, "https://evil.example")).status).toBe(403);
        const first = await ex(code);
        expect(first.status).toBe(200);
        expect(((await first.json()) as { token: string }).token).toBe(TOKEN);
        expect((await ex(code)).status).toBe(401);
    });
});

describe("sessions", () => {
    test("sessions.search finds a prompt and a reply, at the turn the session draws", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "explain the layout of the walrus module" });
        await c.until(id, done);
        const t = lastTurn(c.view(id));
        const r = await c.call("sessions.search", { query: "LAYOUT OF THE WALRUS" });
        expect(r.partial).toBe(false);
        expect(r.hits).toHaveLength(1);
        const hit = r.hits[0];
        expect(hit).toMatchObject({ id, role: "user", archived: false, seg: 0 });
        expect(hit.snippet.slice(hit.match[0], hit.match[1])).toBe("layout of the walrus");
        expect(t.pos).toEqual({ seg: 0, index: hit.index });
        expect(Math.abs(hit.at - t.startedAt!)).toBeLessThan(5000);
        // The reply: in this session's turn too (other sessions said the same).
        const replies = await c.call("sessions.search", { query: "a quick overview", limit: 200 });
        const mine = replies.hits.find((h: { id: string }) => h.id === id);
        expect(mine).toMatchObject({ role: "assistant", seg: 0 });
        expect(mine.index).toBeGreaterThan(hit.index);
        expect((await c.call("sessions.search", { query: "w" })).hits).toEqual([]);
        await expect(c.call("sessions.search", { query: "w".repeat(201) })).rejects.toThrow(/200 characters/);
        c.close();
    });

    test("a prompt streams into the timeline, and the session gets a title", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        expect(c.view(id).state.model?.ref).toBe("mock:mock-opus");
        await c.call("session.send", { id, text: "explain the layout" });
        await c.until(id, done);
        const t = lastTurn(c.view(id));
        expect(t.status).toBe("done");
        expect(t.prompt?.text).toBe("explain the layout");
        expect(texts(t)).toContain("Here's a quick overview.");
        expect(t.blocks.some((b) => b.t === "thinking")).toBe(true);
        // Cleared fields reach the client too (JSON has no undefined; they travel as null).
        expect(c.view(id).state.activity).toBeUndefined();
        expect(t.blocks.every((b) => b.t !== "tool" || b.progress === undefined)).toBe(true);
        await c.until(id, (v) => v.state.title === "Explain the layout");
        expect(c.view(id).state.persisted).toBe(true);
        const list = await c.call("sessions.list");
        expect(list.find((s: { id: string }) => s.id === id)?.title).toBe("Explain the layout");
        c.close();
    });

    test("edits ask first, run, show diffs, and survive reopening", async () => {
        const dir = project();
        const c = await client();
        const id = await c.open("session.create", { cwd: dir });
        await c.call("session.send", { id, text: "add sso (demo)" });

        const write = await c.answer(id, { kind: "permission", choice: "yes" });
        expect(write.kind === "permission" && write.heading).toBe("Create a file");
        expect(write.kind === "permission" && write.diff?.status).toBe("added");
        // The session's own agent asks: the notification needs no name.
        expect(c.events.flatMap((e) => (e.type === "notify" && e.kind === "permission" ? [e.body] : []))[0]).toBe("Wants to create a file");
        const edit = await c.answer(id, { kind: "permission", choice: "yes" });
        expect(edit.kind === "permission" && edit.diff?.added).toBeGreaterThan(0);
        const bash = await c.answer(id, { kind: "permission", choice: "yes" });
        expect(bash.kind === "permission" && bash.command).toContain("bun test");
        await c.until(id, done, 15_000);

        const t = lastTurn(c.view(id));
        expect(tools(t).map((b) => `${b.name}:${b.status}`)).toEqual(["Glob:ok", "Read:ok", "Grep:ok", "Write:ok", "Edit:ok", "Bash:ok"]);
        expect(tools(t).find((b) => b.name === "Edit")?.diff?.hunks.length).toBeGreaterThan(0);
        expect(tools(t).find((b) => b.name === "Bash")?.output).toContain("1 pass");
        expect(texts(t)).toContain("SAML single sign-on");
        expect(readFileSync(join(dir, "src/auth/index.ts"), "utf-8")).toContain("SamlProvider");
        expect(c.view(id).state.filesChanged).toBe(2);

        const changes = await c.call("session.changes", { id });
        expect(changes.files.map((f: { path: string; status: string }) => `${f.path}:${f.status}`)).toEqual(["src/auth/index.ts:modified", "src/auth/sso.ts:added"]);

        // A second window opening it sees the same thing, rebuilt from disk.
        const c2 = await client();
        await c2.open("session.open", { id });
        const live = c.view(id).turns.map((x) => tools(x).map((b) => `${b.name}:${b.status}:${b.diff?.added ?? ""}`));
        expect(c2.view(id).turns.map((x) => tools(x).map((b) => `${b.name}:${b.status}:${b.diff?.added ?? ""}`))).toEqual(live);
        c.close();
        c2.close();
    }, 30_000);

    test("a denial with feedback goes back to the model", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "demo" });
        await c.answer(id, { kind: "permission", choice: "no", feedback: "put it somewhere else" });
        await c.until(id, (v) => tools(lastTurn(v)).some((b) => b.name === "Write" && b.status === "denied"));
        await c.call("session.interrupt", { id });
        await c.until(id, done);
        c.close();
    });

    test("questions and plans wait for the user", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "ask me a question" });
        const q = await c.answer(id, { kind: "question", answers: ["OpenID Connect"] });
        expect(q.kind === "question" && q.options.length).toBe(3);
        await c.until(id, done);
        expect(texts(lastTurn(c.view(id)))).toContain("OpenID Connect");

        await c.call("session.setMode", { id, mode: "plan" });
        await c.call("session.send", { id, text: "make a plan" });
        const plan = await c.answer(id, { kind: "plan", approved: true, mode: "acceptEdits" });
        expect(plan.kind === "plan" && plan.plan).toContain("SamlProvider");
        await c.until(id, done);
        expect(c.view(id).state.mode).toBe("acceptEdits");
        expect(texts(lastTurn(c.view(id)))).toContain("Plan approved");
        c.close();
    });

    test("todos show up in the session state", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "todo please" });
        await c.until(id, done);
        expect(c.view(id).state.todos.map((t) => t.status)).toEqual(["completed", "completed", "in_progress"]);
        c.close();
    });

    test("messages sent while busy are queued, and an interrupt hands them back", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "demo" });
        await c.until(id, (v) => v.state.interactions.length > 0);
        expect((await c.call("session.send", { id, text: "and also this" })).queued).toBe(true);
        await c.until(id, (v) => v.state.queued.length === 1);
        expect(c.view(id).state.queued).toEqual(["and also this"]);
        await c.call("session.interrupt", { id });
        await c.until(id, done);
        expect(lastTurn(c.view(id)).status).toBe("aborted");
        await c.until(id, () => c.events.some((e) => e.type === "draft" && e.sessionId === id && e.text === "and also this"));
        c.close();
    });

    test("queued messages are taken out by id: an edited one comes back, images too, to the window that asked; one already gone removes nothing", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "demo" });
        await c.until(id, (v) => v.state.interactions.length > 0);
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        const gif = "R0lGODlhAQABAAAAACw=";
        // Two screenshots without text: the same as far as their text goes.
        await c.call("session.send", { id, text: "", images: [{ mediaType: "image/png", data: png }] });
        await c.call("session.send", { id, text: "", images: [{ mediaType: "image/gif", data: gif }] });
        await c.until(id, (v) => v.state.queued.length === 2);
        const [first, second] = c.view(id).state.queueIds;
        expect(c.view(id).state.queued).toEqual(["", ""]);
        expect(first).not.toBe(second);
        expect(await c.call("session.dequeue", { id, queueId: first, edit: true })).toEqual({ removed: true, text: "", images: [{ mediaType: "image/png", data: png }] });
        await c.until(id, (v) => v.state.queued.length === 1);
        expect(c.view(id).state.queueIds).toEqual([second]);
        // A click from a window that still showed the first one: the second stays.
        expect(await c.call("session.dequeue", { id, queueId: first, edit: true })).toEqual({ removed: false });
        expect(c.view(id).state.queueIds).toEqual([second]);
        // Removing (not editing) hands nothing back; nothing is broadcast as a draft either way.
        expect(await c.call("session.dequeue", { id, queueId: second })).toEqual({ removed: true });
        await c.until(id, (v) => v.state.queued.length === 0);
        expect(c.events.some((e) => e.type === "draft" && e.sessionId === id)).toBe(false);
        await c.call("session.interrupt", { id });
        await c.until(id, done);
        c.close();
    });

    test("rewind restores files and the conversation", async () => {
        const dir = project();
        const before = readFileSync(join(dir, "src/auth/index.ts"), "utf-8");
        const c = await client();
        const id = await c.open("session.create", { cwd: dir, mode: "acceptEdits" });
        await c.call("session.send", { id, text: "first prompt" });
        await c.until(id, done);
        await c.call("session.send", { id, text: "demo" });
        await c.answer(id, { kind: "permission", choice: "yes" }); // the shell command
        await c.until(id, done, 15_000);
        expect(existsSync(join(dir, "src/auth/sso.ts"))).toBe(true);

        const targets = await c.call("session.rewindTargets", { id });
        expect(targets.map((t: { text: string }) => t.text)).toEqual(["demo", "first prompt"]);
        const plan = await c.call("session.rewindPlan", { id, index: targets[0].index });
        expect(plan.restore.map((r: { path: string; action: string }) => `${r.path}:${r.action}`).sort()).toEqual(["src/auth/index.ts:write", "src/auth/sso.ts:delete"]);
        // Only the plan last shown can be carried out.
        await expect(c.call("session.rewind", { id, index: targets[0].index, planId: "nope", code: true, conversation: true })).rejects.toThrow(/changed since this was shown/);
        expect(existsSync(join(dir, "src/auth/sso.ts"))).toBe(true);
        const r = await c.call("session.rewind", { id, index: targets[0].index, planId: plan.planId, code: true, conversation: true });
        expect(r.text).toBe("demo");
        expect(existsSync(join(dir, "src/auth/sso.ts"))).toBe(false);
        expect(readFileSync(join(dir, "src/auth/index.ts"), "utf-8")).toBe(before);
        await c.until(id, (v) => v.turns.filter((t) => t.prompt).length === 1);
        c.close();
    }, 30_000);

    test("rewind leaves a file alone that changed after the plan was shown", async () => {
        const dir = project();
        const c = await client();
        const id = await c.open("session.create", { cwd: dir, mode: "acceptEdits" });
        await c.call("session.send", { id, text: "demo" });
        await c.answer(id, { kind: "permission", choice: "yes" });
        await c.until(id, done, 15_000);
        const [t] = await c.call("session.rewindTargets", { id });
        const plan = await c.call("session.rewindPlan", { id, index: t.index });
        expect(plan.restore.some((r: { path: string }) => r.path === "src/auth/index.ts")).toBe(true);
        // The user saves an edit while the dialog is open.
        writeFileSync(join(dir, "src/auth/index.ts"), "// mine\n");
        const r = await c.call("session.rewind", { id, index: t.index, planId: plan.planId, code: true, conversation: true });
        expect(r.failed.map((f: { path: string }) => f.path)).toContain("src/auth/index.ts");
        expect(readFileSync(join(dir, "src/auth/index.ts"), "utf-8")).toBe("// mine\n");
        // A plan is used once.
        await expect(c.call("session.rewind", { id, index: t.index, planId: plan.planId, code: true, conversation: false })).rejects.toThrow(/changed since this was shown/);
        c.close();
    }, 30_000);

    test("a rewind shown before another turn isn't carried out", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project(), mode: "acceptEdits" });
        await c.call("session.send", { id, text: "first prompt" });
        await c.until(id, done);
        const [t] = await c.call("session.rewindTargets", { id });
        const plan = await c.call("session.rewindPlan", { id, index: t.index });
        // Its files may have changed in ways the plan doesn't know about.
        await c.call("session.send", { id, text: "second prompt" });
        await c.until(id, (v) => done(v) && v.turns.filter((x) => x.prompt).length === 2);
        await expect(c.call("session.rewind", { id, index: t.index, planId: plan.planId, code: true, conversation: true })).rejects.toThrow(/changed since this was shown/);
        expect((await c.call("session.rewindTargets", { id })).length).toBe(2);
        c.close();
    }, 30_000);

    test("a key a !command prints in two pieces isn't shown as it streams", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: `!printf '${TOKEN.slice(0, 11)}'; sleep 0.4; printf '${TOKEN.slice(11)}\\nmore\\n'` });
        await c.until(id, done, 15_000);
        const streamed = c.events
            .flatMap((e) => (e.type === "session.ops" && e.sessionId === id ? e.ops : []))
            .flatMap((op) => (op.op === "append" && op.field === "output" ? [op.text] : []))
            .join("");
        expect(streamed).toContain("[REDACTED gui-token]");
        expect(streamed).not.toContain(TOKEN.slice(0, 11));
        const shell = lastTurn(c.view(id)).blocks.find((b) => b.t === "shell") as Extract<Block, { t: "shell" }>;
        expect(shell.output).toBe("[REDACTED gui-token]\nmore");
        c.close();
    }, 30_000);

    test("stopping a !command puts what was sent meanwhile back in the input box", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "!sleep 20" });
        await c.until(id, (v) => v.state.busy);
        expect((await c.call("session.send", { id, text: "after the command" })).queued).toBe(true);
        // A screenshot on its own, queued too.
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        expect((await c.call("session.send", { id, text: "", images: [{ mediaType: "image/png", data: png }] })).queued).toBe(true);
        await c.call("session.interrupt", { id });
        await c.until(id, () => c.events.some((e) => e.type === "draft" && e.sessionId === id && e.text === "after the command"));
        const draft = c.events.find((e) => e.type === "draft" && e.sessionId === id) as Extract<ServerEvent, { type: "draft" }>;
        expect(draft.images).toEqual([{ mediaType: "image/png", data: png }]);
        await c.until(id, (v) => done(v) && !v.state.queued.length);
        await Bun.sleep(200);
        expect(c.view(id).turns.some((t) => t.prompt?.text === "after the command")).toBe(false);
        c.close();
    }, 30_000);

    test("what was sent during /compact runs after it", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "first prompt" });
        await c.until(id, done);
        const compacting = c.call("session.compact", { id });
        const sent = c.call("session.send", { id, text: "after compacting" });
        expect((await sent).queued).toBe(true);
        await compacting;
        await c.until(id, (v) => v.turns.some((t) => t.prompt?.text === "after compacting") && done(v), 15_000);
        c.close();
    }, 30_000);

    test("a tool's full output is there after a compaction", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project(), mode: "acceptEdits" });
        await c.call("session.send", { id, text: "demo" });
        await c.answer(id, { kind: "permission", choice: "yes" });
        await c.until(id, done, 15_000);
        const tool = c.view(id).turns.flatMap(tools).find((t) => t.name === "Read")!;
        const before = (await c.call("session.toolOutput", { id, toolId: tool.id })).output;
        expect(before.length).toBeGreaterThan(0);
        await c.call("session.compact", { id });
        await c.until(id, done);
        expect((await c.call("session.toolOutput", { id, toolId: tool.id })).output).toBe(before);
        c.close();
    }, 30_000);

    test("a session no window shows and with nothing running is closed, so a terminal can open it", async () => {
        const { findSessionAnywhere } = await import("../src/agent/session");
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "first prompt" });
        await c.until(id, done);
        const lock = `${findSessionAnywhere(id)}.lock`;
        expect(existsSync(lock)).toBe(true);
        await c.call("session.close", { id });
        for (let i = 0; i < 50 && existsSync(lock); i++) await Bun.sleep(100);
        expect(existsSync(lock)).toBe(false);
        // Opened again, it's the same conversation.
        const snap = await c.call("session.open", { id });
        expect(snap.turns.some((t: Turn) => t.prompt?.text === "first prompt")).toBe(true);
        expect(existsSync(lock)).toBe(true);

        // One that's waiting for an answer stays open.
        const busy = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id: busy, text: "demo" });
        await c.until(busy, (v) => v.state.interactions.length > 0);
        await c.call("session.close", { id: busy });
        await Bun.sleep(300);
        const again = await c.call("session.open", { id: busy });
        expect(again.state.interactions.length).toBe(1);
        await c.call("session.interrupt", { id: busy });
        c.close();
    }, 30_000);

    test("one closed while it's waiting is closed once it's done, and so is one whose window went away", async () => {
        const { findSessionAnywhere } = await import("../src/agent/session");
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "demo" });
        await c.until(id, (v) => v.state.interactions.length > 0);
        const lock = `${findSessionAnywhere(id)}.lock`;
        await c.call("session.close", { id });
        await Bun.sleep(600);
        expect(existsSync(lock)).toBe(true);
        await c.call("session.interrupt", { id });
        for (let i = 0; i < 50 && existsSync(lock); i++) await Bun.sleep(100);
        expect(existsSync(lock)).toBe(false);

        const other = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id: other, text: "first prompt" });
        await c.until(other, done);
        const otherLock = `${findSessionAnywhere(other)}.lock`;
        c.close();
        for (let i = 0; i < 50 && existsSync(otherLock); i++) await Bun.sleep(100);
        expect(existsSync(otherLock)).toBe(false);
    }, 30_000);

    test("a session that isn't open can be renamed from the sidebar", async () => {
        const { findSessionAnywhere } = await import("../src/agent/session");
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "first prompt" });
        await c.until(id, done);
        const lock = `${findSessionAnywhere(id)}.lock`;
        await c.call("session.close", { id });
        for (let i = 0; i < 50 && existsSync(lock); i++) await Bun.sleep(100);
        expect(existsSync(lock)).toBe(false);
        await c.call("session.rename", { id, title: "  Renamed   from the sidebar " });
        expect(c.events.some((e) => e.type === "sessions.upsert" && e.session.id === id && e.session.title === "Renamed from the sidebar")).toBe(true);
        const list = await c.call("sessions.list", { limit: 300 });
        expect(list.find((s: { id: string }) => s.id === id)?.title).toBe("Renamed from the sidebar");
        // Still not open, and nothing holds it.
        expect(existsSync(lock)).toBe(false);
        c.close();
    }, 30_000);

    test("an answer must be one of the choices offered", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project(), mode: "acceptEdits" });
        await c.call("session.send", { id, text: "demo" });
        await c.until(id, (v) => v.state.interactions.length > 0);
        const it = c.view(id).state.interactions[0]!;
        expect(it.kind === "permission" && it.options.map((o) => o.id)).not.toContain("session-edits");
        await expect(c.call("session.respond", { id, interactionId: it.id, response: { kind: "permission", choice: "session-edits" } })).rejects.toThrow(/isn't one of the choices/);
        expect(c.view(id).state.mode).toBe("acceptEdits");
        await c.call("session.interrupt", { id });
        await c.until(id, done);
        c.close();
    }, 30_000);

    test("the model isn't switched in the middle of a turn", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "demo" });
        await c.until(id, (v) => v.state.interactions.length > 0);
        await expect(c.call("session.setModel", { id, ref: "mock:mock-haiku", persist: false })).rejects.toThrow(/once this response is done/);
        expect(c.view(id).state.model?.id).toBe("mock-opus");
        await c.call("session.interrupt", { id });
        await c.until(id, done);
        await c.call("session.setModel", { id, ref: "mock:mock-haiku", persist: false });
        c.close();
    }, 30_000);

    test("a folder with configuration needs a trust decision first", async () => {
        const dir = project();
        mkdirSync(join(dir, ".harness"), { recursive: true });
        writeFileSync(join(dir, ".harness/settings.json"), JSON.stringify({ permissions: { allow: ["Bash"] } }));
        const c = await client();
        const info = await c.call("projects.inspect", { path: dir });
        expect(info.needsTrust).toEqual([".harness/settings.json"]);
        await expect(c.call("session.create", { cwd: dir })).rejects.toThrow(/Trust the folder/);
        await c.call("projects.trust", { path: dir, trust: false });
        const id = await c.open("session.create", { cwd: dir });
        expect(c.view(id).state.trusted).toBe(false);
        c.close();
    });

    test("a slash command that fails says why in the timeline", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "/compact" });
        await c.until(id, (v) => v.turns.some((t) => t.blocks.some((b) => b.t === "notice" && b.level === "error" && /Nothing to compact/.test(b.text))));
        c.close();
    });

    test("the git view shows what a shell command changed, which Harness's own record can't", async () => {
        const dir = project();
        const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Harness Test", "-c", "user.email=test@example.invalid", ...args], { cwd: dir, stdout: "ignore", stderr: "ignore" });
        git("init", "-q", "-b", "main");
        git("add", "-A");
        git("commit", "-q", "-m", "Initial commit");
        const c = await client();
        const id = await c.open("session.create", { cwd: dir });
        await c.call("session.send", { id, text: "!echo x >> README.md" });
        await c.until(id, done);

        const r = await c.call("session.gitChanges", { id, scope: "uncommitted" });
        expect(r.repo).toBe(true);
        expect(r.files.map((f: { path: string; change: string; added: number }) => `${f.path}:${f.change}:+${f.added}`)).toEqual(["README.md:modified:+1"]);
        expect((await c.call("session.changes", { id })).files).toEqual([]);
        const b = await c.call("session.gitChanges", { id, scope: "branch", base: "main" });
        expect(b.base.ref).toBe("main");
        await expect(c.call("session.gitChanges", { id, scope: "branch", base: "--output=x" })).rejects.toThrow(/isn't a branch/);
        await expect(c.call("session.gitChanges", { id, scope: "sideways" })).rejects.toThrow(/scope/);

        const plain = await c.open("session.create", { cwd: project() });
        const p = await c.call("session.gitChanges", { id: plain, scope: "uncommitted" });
        expect([p.repo, p.reason]).toEqual([false, expect.stringMatching(/isn't a Git repository/)]);
        c.close();
    });

    test("the commit RPC commits selected files and preserves another file's staging", async () => {
        const cwd = project();
        const git = commitRepo(cwd);
        writeFileSync(join(cwd, "selected.txt"), "selected\n");
        writeFileSync(join(cwd, "with space.txt"), "second selected\n");
        writeFileSync(join(cwd, "other.txt"), "staged\n");
        git("add", "--", "other.txt");
        writeFileSync(join(cwd, "other.txt"), "unstaged\n");
        const staged = git("diff", "--cached", "--", "other.txt");
        const unstaged = git("diff", "--", "other.txt");
        const c = await client();
        try {
            const id = await c.open("session.create", { cwd });
            const message = 'feat: "two files"\n\nKeep the body verbatim.\n';
            const result = await c.call("session.gitCommit", { id, paths: ["selected.txt", "with space.txt"], message });
            expect(result).toMatchObject({ branch: "main", subject: 'feat: "two files"' });
            expect(git("rev-parse", "HEAD").trim().startsWith(result.hash)).toBe(true);
            expect(git("show", "--format=", "--name-only", "HEAD").trim().split("\n")).toEqual(["selected.txt", "with space.txt"]);
            expect(git("cat-file", "commit", "HEAD").split("\n\n").slice(1).join("\n\n")).toBe(message);
            expect(git("diff", "--cached", "--", "other.txt")).toBe(staged);
            expect(git("diff", "--", "other.txt")).toBe(unstaged);
            expect((await c.call("session.gitChanges", { id, scope: "uncommitted" })).files.map((f: { path: string }) => f.path)).toEqual(["other.txt"]);
        } finally {
            c.close();
        }
    });

    test("! runs a shell command for the user", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "!echo hi there" });
        await c.until(id, done);
        const b = lastTurn(c.view(id)).blocks[0];
        expect(b?.t === "shell" && b.output.trim()).toBe("hi there");
        expect(b?.t === "shell" && b.exitCode).toBe(0);
        c.close();
    });
});

const { findSessionAnywhere, listSessions } = await import("../src/agent/session");

describe("forking", () => {
    /** What a turn looks like in the timeline: its prompt, how it ended, its times, its tool rows and its text. */
    const shape = (t: Turn) => ({
        prompt: t.prompt,
        status: t.status,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        tools: tools(t).map((b) => ({ name: b.name, status: b.status, summary: b.summary, diff: b.diff, durationMs: b.durationMs })),
        text: texts(t),
    });
    const prompted = (v: { turns: Turn[] }) => v.turns.filter((t) => t.prompt);
    /** Without the difference between a field left out and a null one (ops travel as JSON, where undefined is null). */
    const plain = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (v === null ? undefined : v)));
    const sessionFiles = (cwd: string) => listSessions(cwd, 1000).map((s) => s.id).sort();

    /** A session with three turns: a question, an edit (with its tool rows), and one more. */
    async function threeTurns(c: Client, dir = project()) {
        const id = await c.open("session.create", { cwd: dir, mode: "acceptEdits" });
        await c.call("session.send", { id, text: "first prompt" });
        await c.until(id, done);
        await c.call("session.send", { id, text: "demo" });
        await c.answer(id, { kind: "permission", choice: "yes" }); // the shell command
        await c.until(id, done, 15_000);
        await c.call("session.send", { id, text: "third prompt" });
        await c.until(id, (v) => done(v) && prompted(v).length === 3 && Boolean(v.state.title));
        return { id, dir };
    }

    test("from an earlier turn: a new session with the conversation up to it, shown as it was, with the same model, effort and mode; the original as it was", async () => {
        const c = await client();
        const watcher = await client();
        const { id, dir } = await threeTurns(c);
        await c.call("session.setEffort", { id, effort: "high" });
        const file = findSessionAnywhere(id)!;
        const before = readFileSync(file, "utf-8");
        const orig = c.view(id);
        const demo = prompted(orig)[1]!;

        const forkId = await c.open("session.fork", { id, index: demo.prompt!.index, text: "demo", turn: demo.id });
        const fork = c.view(forkId);
        expect(forkId).not.toBe(id);
        expect(fork.state.title).toBe(`Fork of ${orig.state.title}`);
        expect(fork.state.forkOf).toEqual({ id, title: orig.state.title! });
        expect(fork.state.cwd).toBe(orig.state.cwd);
        expect(fork.state.model?.ref).toBe(orig.state.model!.ref);
        expect(fork.state.effort).toBe("high");
        expect(fork.state.mode).toBe("acceptEdits");
        expect(fork.state.fastMode).toBe(orig.state.fastMode);
        expect([fork.state.cost, fork.state.tokensIn, fork.state.tokensOut]).toEqual([0, 0, 0]);
        expect(fork.state.filesChanged).toBe(0);
        // Its timeline is the original's up to that turn: prompts, replies, tool rows with summaries and diffs, times.
        expect(plain(prompted(fork).map(shape))).toEqual(plain(prompted(orig).slice(0, 2).map(shape)));
        expect(tools(prompted(fork)[1]!).find((b) => b.name === "Edit")?.diff?.hunks.length).toBeGreaterThan(0);
        // Every window's sidebar has it; the original is untouched.
        await new Promise<void>((r) => setTimeout(r, 50));
        expect(watcher.events.some((e) => e.type === "sessions.upsert" && e.session.id === forkId && e.session.title === `Fork of ${orig.state.title}`)).toBe(true);
        expect(readFileSync(file, "utf-8")).toBe(before);
        const list = await c.call<{ id: string }[]>("sessions.list");
        expect(list.map((s) => s.id)).toEqual(expect.arrayContaining([id, forkId]));
        // No title is made up for it over "Fork of …".
        await c.call("session.send", { id: forkId, text: "what was my first message? (in the fork, MANGO)" });
        await c.until(forkId, (v) => done(v) && prompted(v).length === 3);
        expect(c.view(forkId).state.title).toBe(`Fork of ${orig.state.title}`);
        const answer = texts(lastTurn(c.view(forkId)));
        expect(answer).toContain('Your first message was "first prompt"');
        expect(answer).not.toContain("third prompt");
        // And the original goes on without anything said in the fork.
        await c.call("session.send", { id, text: "what was my first message?" });
        await c.until(id, (v) => done(v) && prompted(v).length === 4);
        const back = texts(lastTurn(c.view(id)));
        expect(back).toContain('Your first message was "first prompt"');
        expect(back).toContain("third prompt");
        expect(back).not.toContain("MANGO");
        expect(sessionFiles(dir)).toEqual([id, forkId].sort());
        c.close();
        watcher.close();
    }, 45_000);

    test("bad input is refused, and no session is made", async () => {
        const c = await client();
        const { id, dir } = await threeTurns(c);
        const [first, demo] = prompted(c.view(id));
        const fork = (p: Record<string, unknown>) => c.call("session.fork", { id, text: "demo", index: demo!.prompt!.index, turn: demo!.id, ...p });
        await expect(fork({ id: "20200101-000000-abcdef" })).rejects.toThrow(/isn't open/);
        await expect(fork({ index: "3" })).rejects.toThrow(/must be an integer/);
        await expect(fork({ index: 1.5 })).rejects.toThrow(/must be an integer/);
        await expect(fork({ index: 999 })).rejects.toThrow(/isn't one of this conversation's prompts/);
        await expect(fork({ index: -1 })).rejects.toThrow(/isn't one of this conversation's prompts/);
        // A reply, not a prompt.
        await expect(fork({ index: first!.prompt!.index! + 1 })).rejects.toThrow(/isn't one of this conversation's prompts/);
        await expect(fork({ text: undefined })).rejects.toThrow(/text must be a string/);
        await expect(fork({ turn: undefined })).rejects.toThrow(/turn must be a string/);
        // Drawn before something changed it (a rewind in another window, say).
        await expect(fork({ text: "something else" })).rejects.toThrow(/changed since this was shown/);
        await expect(fork({ turn: first!.id })).rejects.toThrow(/changed since this was shown/);
        // From before a compaction.
        await c.call("session.compact", { id });
        await c.until(id, done);
        await expect(fork({})).rejects.toThrow(/before a compaction/);
        expect(sessionFiles(dir)).toEqual([id]);
        c.close();
    }, 45_000);

    test("the running turn can't be forked; an earlier, finished one can", async () => {
        const c = await client();
        const dir = project();
        const id = await c.open("session.create", { cwd: dir });
        await c.call("session.send", { id, text: "first prompt" });
        await c.until(id, done);
        await c.call("session.send", { id, text: "ask me a question" });
        await c.until(id, (v) => v.state.interactions.length > 0);
        const [first, running] = prompted(c.view(id));
        await expect(c.call("session.fork", { id, index: running!.prompt!.index, text: running!.prompt!.text, turn: running!.id })).rejects.toThrow(/still running/);
        expect(sessionFiles(dir)).toEqual([id]);
        const forkId = await c.open("session.fork", { id, index: first!.prompt!.index, text: "first prompt", turn: first!.id });
        expect(prompted(c.view(forkId)).map((t) => t.prompt!.text)).toEqual(["first prompt"]);
        expect(c.view(forkId).state.busy).toBe(false);
        await c.answer(id, { kind: "question", answers: ["OpenID Connect"] });
        await c.until(id, done);
        c.close();
    }, 30_000);

    test("a turn rewound in another window and sent again isn't forked from the window that showed the old one", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "first prompt" });
        await c.until(id, done);
        await c.call("session.send", { id, text: "retry" });
        await c.until(id, (v) => done(v) && prompted(v).length === 2);
        const shown = prompted(c.view(id))[1]!;
        // Another window: rewound to before it, and the same prompt sent again (a new answer at the same place).
        const plan = await c.call("session.rewindPlan", { id, index: shown.prompt!.index });
        await c.call("session.rewind", { id, index: shown.prompt!.index, planId: plan.planId, code: false, conversation: true });
        await c.call("session.send", { id, text: "retry" });
        await c.until(id, (v) => done(v) && prompted(v).length === 2 && prompted(v)[1]!.id !== shown.id);
        const again = prompted(c.view(id))[1]!;
        expect(again.prompt).toEqual(shown.prompt);
        await expect(c.call("session.fork", { id, index: shown.prompt!.index, text: "retry", turn: shown.id })).rejects.toThrow(/changed since this was shown/);
        const forkId = await c.open("session.fork", { id, index: again.prompt!.index, text: "retry", turn: again.id });
        expect(prompted(c.view(forkId)).map((t) => t.prompt!.text)).toEqual(["first prompt", "retry"]);
        c.close();
    }, 30_000);

    /** A turn that finished while the message queued during it runs (waiting on a question): `first` and `queued`. */
    async function finishedWhileQueuedRuns(c: Client) {
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "pause first" });
        expect((await c.call("session.send", { id, text: "ask me a question" })).queued).toBe(true);
        await c.until(id, (v) => v.state.interactions.length > 0);
        const [first, queued] = prompted(c.view(id));
        expect(first!.status).toBe("done");
        expect(queued!.status).toBe("running");
        return { id, first: first!, queued: queued! };
    }

    test("a turn that finished while a message queued during it runs can be forked, up to that message", async () => {
        const c = await client();
        const { id, first, queued } = await finishedWhileQueuedRuns(c);
        const forkId = await c.open("session.fork", { id, index: first.prompt!.index, text: "pause first", turn: first.id });
        expect(prompted(c.view(forkId)).map((t) => t.prompt!.text)).toEqual(["pause first"]);
        expect(texts(prompted(c.view(forkId))[0]!)).toBe("Done waiting.");
        const rt = srv.engine.runtimes.get(forkId)!;
        expect(rt.session.messages.length).toBe(queued.prompt!.index);
        await expect(c.call("session.fork", { id, index: queued.prompt!.index, text: queued.prompt!.text, turn: queued.id })).rejects.toThrow(/still running/);
        await c.answer(id, { kind: "question", answers: ["OpenID Connect"] });
        await c.until(id, done);
        c.close();
    }, 30_000);

    test("while the original is working, none of its backend sessions are shared; once it's done, they are", async () => {
        const c = await client();
        const { id, first } = await finishedWhileQueuedRuns(c);
        const original = srv.engine.runtimes.get(id)!;
        // A Claude Code session that saw only the first turn, as if that turn had run on it.
        original.session.setBackendSession("claude-code", "sess-shared", first.prompt!.index + 2);
        const file = findSessionAnywhere(id)!;
        const before = readFileSync(file, "utf-8");
        const busy = await c.open("session.fork", { id, index: first.prompt!.index, text: "pause first", turn: first.id });
        expect(srv.engine.runtimes.get(busy)!.session.backends.size).toBe(0);
        expect(original.session.backends.get("claude-code")?.fork).toBeUndefined();
        expect(readFileSync(file, "utf-8")).toBe(before);

        await c.answer(id, { kind: "question", answers: ["OpenID Connect"] });
        await c.until(id, done);
        const idle = await c.open("session.fork", { id, index: first.prompt!.index, text: "pause first", turn: first.id });
        expect(srv.engine.runtimes.get(idle)!.session.backends.get("claude-code")).toEqual({ id: "sess-shared", synced: first.prompt!.index + 2, fork: true });
        expect(original.session.backends.get("claude-code")?.fork).toBe(true);
        c.close();
    }, 30_000);

    test("rewinding the fork to before the fork point restores the conversation only, and says why; the original's rewind still restores its files", async () => {
        const c = await client();
        const dir = project();
        const before = readFileSync(join(dir, "src/auth/index.ts"), "utf-8");
        const id = await c.open("session.create", { cwd: dir, mode: "acceptEdits" });
        await c.call("session.send", { id, text: "demo" });
        await c.answer(id, { kind: "permission", choice: "yes" });
        await c.until(id, done, 15_000);
        const demo = prompted(c.view(id))[0]!;
        const forkId = await c.open("session.fork", { id, index: demo.prompt!.index, text: "demo", turn: demo.id });
        await c.call("session.send", { id: forkId, text: "a prompt in the fork" });
        await c.until(forkId, (v) => done(v) && prompted(v).length === 2);

        const targets = await c.call("session.rewindTargets", { id: forkId });
        expect(targets.map((t: { text: string; forked?: boolean }) => [t.text, Boolean(t.forked)])).toEqual([
            ["a prompt in the fork", false],
            ["demo", true],
        ]);
        const plan = await c.call("session.rewindPlan", { id: forkId, index: demo.prompt!.index });
        expect(plan.forked).toBe(true);
        expect(plan.restore).toEqual([]);
        const r = await c.call("session.rewind", { id: forkId, index: demo.prompt!.index, planId: plan.planId, code: true, conversation: true });
        expect(r.restored).toEqual([]);
        expect(existsSync(join(dir, "src/auth/sso.ts"))).toBe(true);
        await c.until(forkId, (v) => prompted(v).length === 0);

        const [t] = await c.call("session.rewindTargets", { id });
        expect(t.forked).toBeUndefined();
        const own = await c.call("session.rewindPlan", { id, index: t.index });
        expect(own.restore.map((x: { path: string }) => x.path).sort()).toEqual(["src/auth/index.ts", "src/auth/sso.ts"]);
        await c.call("session.rewind", { id, index: t.index, planId: own.planId, code: true, conversation: true });
        expect(existsSync(join(dir, "src/auth/sso.ts"))).toBe(false);
        expect(readFileSync(join(dir, "src/auth/index.ts"), "utf-8")).toBe(before);
        c.close();
    }, 45_000);

    test("/fork is in the command menu", async () => {
        const c = await client();
        const cmds = await c.call<{ name: string }[]>("commands.list", { cwd: project() });
        expect(cmds.map((x) => x.name)).toContain("fork");
        c.close();
    });
});

describe("using a plan through an installed CLI", () => {
    // A fake `claude` (test/fixtures) on PATH, as an installed Claude Code would be.
    let bin = "";
    beforeAll(() => {
        bin = dirname(fakeClaude());
    });
    const PATH = process.env.PATH;
    const claudeCode = async (c: Client) => (await c.call<any[]>("providers.list")).find((p) => p.id === "claude-code");

    afterAll(() => {
        process.env.PATH = PATH;
        delete process.env.FAKE_LOGGED_IN;
    });

    test("Claude Code is offered as a plan, checked with the CLI, and can be turned off", async () => {
        const c = await client();
        process.env.PATH = `${bin}:${PATH}`;
        let pr = await claudeCode(c);
        expect(pr).toMatchObject({ configured: false, requiresKey: false, agentCli: { installed: true, signIn: "claude auth login", plan: "Claude subscription" } });

        process.env.FAKE_LOGGED_IN = "0";
        await expect(c.call("providers.connectCli", { provider: "claude-code" })).rejects.toThrow(/isn't signed in. Run `claude auth login`/);
        expect((await claudeCode(c)).configured).toBe(false);

        delete process.env.FAKE_LOGGED_IN;
        const r = await c.call("providers.connectCli", { provider: "claude-code" });
        expect(r.description).toBeTruthy();
        expect(r.warning).toBeFalsy();
        pr = await claudeCode(c);
        expect(pr).toMatchObject({ configured: true, source: "your plan" });

        await c.call("providers.removeKey", { provider: "claude-code" });
        expect((await claudeCode(c)).configured).toBe(false);
        c.close();
    });

    test("a CLI that isn't installed says how to get it", async () => {
        const c = await client();
        process.env.PATH = "/nonexistent";
        expect((await claudeCode(c)).agentCli.installed).toBe(false);
        await expect(c.call("providers.connectCli", { provider: "claude-code" })).rejects.toThrow(/isn't installed. Install Claude Code/);
        await expect(c.call("providers.connectCli", { provider: "openai" })).rejects.toThrow(/isn't used through a CLI/);
        await expect(c.call("providers.setKey", { key: " " })).rejects.toThrow(/Paste a key first/);
        process.env.PATH = PATH;
        c.close();
    });
});

describe("continuing a Claude Code session", () => {
    test("the project's CLI sessions are listed, and one imports into an open session that resumes it", async () => {
        const { claudeSession } = await import("./helpers/cli-stores");
        const { realpathSync } = await import("fs");
        const { saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
        const cwd = project();
        // The synthetic store isolate() set up; the CLI records the folder's real path.
        const { id } = claudeSession(process.env.CLAUDE_CONFIG_DIR!, { cwd: realpathSync(cwd), turns: [{ prompt: "map the auth module", reply: "Here's the map.", tools: [["Read", { file_path: "src/auth.ts" }]] }], title: "Auth map" });
        saveAgentConfig("claude-code", { path: fakeClaude() });
        const c = await client();
        try {
            const list = await c.call<CliSessionsList>("cliSessions.list", { cwd });
            expect(list.sources.map((s) => [s.source, s.enabled])).toEqual([["claude-code", true], ["codex", false]]);
            expect(list.sessions).toEqual([expect.objectContaining({ source: "claude-code", id, title: "Auth map", messages: 3, recent: true })]);
            const sid = await c.open("cliSessions.import", { cwd, source: "claude-code", id });
            const v = c.view(sid);
            expect(v.turns[0]!.blocks[0]).toMatchObject({ t: "imported", source: "Claude Code" });
            expect(v.turns[1]).toMatchObject({ imported: true, prompt: { text: "map the auth module" } });
            expect(v.turns[1]!.prompt!.index).toBeUndefined();
            // The palette can find an imported reply, including after archive,
            // then open it at its turn rather than the unpositioned import banner.
            await c.call("session.archive", { id: sid, archived: true });
            const found = await c.call("sessions.search", { query: "Here's the map." });
            const hit = found.hits.find((h: { id: string }) => h.id === sid);
            expect(hit).toMatchObject({ id: sid, archived: true, role: "assistant", seg: 0, index: 1 });
            await c.open("session.open", { id: hit.id, cwd: hit.cwd });
            const opened = c.view(sid).turns;
            expect(opened[0]!.pos).toBeUndefined();
            const target = opened.filter((t) => t.pos && (t.pos.seg < hit.seg || (t.pos.seg === hit.seg && t.pos.index <= hit.index))).at(-1)!;
            expect(target).toMatchObject({ imported: true, pos: { seg: 0, index: 0 }, prompt: { text: "map the auth module" } });
            expect(texts(target)).toContain("Here's the map.");
            expect(target.prompt!.index).toBeUndefined();
            await c.call("session.archive", { id: sid, archived: false });
            await expect(c.call("cliSessions.import", { cwd, source: "claude-code", id: "../etc" })).rejects.toThrow(/session id/);
            const again = await c.call<CliSessionsList>("cliSessions.list", { cwd });
            expect(again.sessions[0]!.harnessId).toBe(sid);
            await c.call("session.send", { id: sid, text: "now the tests" });
            await c.answer(sid, { kind: "permission", choice: "yes" });
            await c.until(sid, (x) => done(x) && x.turns.length > 2, 30_000);
            const t = lastTurn(c.view(sid));
            expect(t.prompt).toMatchObject({ text: "now the tests", index: 2 });
        } finally {
            c.close();
            removeAgentConfig("claude-code");
        }
    }, 45_000);
});

describe("sub-agents", () => {
    const byName = (v: { agents: AgentRun[] }) => [...v.agents].sort((a, b) => a.description.localeCompare(b.description));

    test("each Task sub-agent shows with its model, activity and report", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.send", { id, text: "Use agents to review the auth module and its tests" });
        await c.until(id, done, 20_000);
        const v = c.view(id);
        const [tests, auth] = byName(v);
        expect([auth, tests].map((a) => [a!.description, a!.agentType, a!.model, a!.status, a!.taskId])).toEqual([
            ["Map the auth module", "explore", "mock:mock-haiku", "done", undefined],
            ["Find gaps in sign-in tests", "explore", "mock:mock-sonnet", "done", undefined],
        ]);
        // What it said and did, in order, with each tool's result.
        expect(auth!.blocks.map((b) => (b.t === "tool" ? `${b.name}:${b.status}` : b.t === "text" ? b.text.split("\n")[0] : b.t))).toEqual([
            "I'll start with the auth module.",
            "Glob:ok",
            "Read:ok",
            "Read:ok",
            "Grep:ok",
            "Sign-in strategies are registered in one list:",
        ]);
        expect(auth!.toolCount).toBe(4);
        expect(auth!.tokens).toBeGreaterThan(0);
        expect(auth!.prompt).toContain("Subtask: read src/auth");
        expect(auth!.report).toStartWith("Sign-in strategies are registered");
        expect(tests!.report).toStartWith("Only email sign-in is tested");
        expect(auth!.endedAt).toBeGreaterThanOrEqual(auth!.startedAt);
        // The calls in the turn are marked as sub-agents.
        expect(tools(lastTurn(v)).filter((b) => b.agent).map((b) => b.name)).toEqual(["Task", "Task"]);

        // Only delegated tasks can be stopped on their own; a Task stops with the turn.
        await expect(c.call("session.stopAgent", { id, agentId: auth!.id })).rejects.toThrow(/stops with the turn/);
        expect(await c.call("session.stopAgent", { id })).toEqual({ stopped: 0 });

        // After a restart they come back from their calls: the report, not the activity.
        const restarted = await startServer({ token: TOKEN });
        try {
            const c2 = new Client(TOKEN, {}, restarted.port);
            await c2.opened();
            const snap = await c2.call<SessionSnapshot>("session.open", { id });
            expect([...snap.agents].sort((a, b) => a.description.localeCompare(b.description)).map((a) => [a.description, a.status, a.replayed, a.blocks.length, a.report?.slice(0, 20)])).toEqual([
                ["Find gaps in sign-in tests", "done", true, 0, "Only email sign-in i"],
                ["Map the auth module", "done", true, 0, "Sign-in strategies a"],
            ]);
            c2.close();
        } finally {
            await restarted.stop();
        }
        c.close();
    }, 30_000);

    test("a task Claude Code delegates to another model shows as an agent, with the id that stops it", async () => {
        const { saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
        const { DELEGATE_TOOL } = await import("../src/agent/delegation");
        saveAgentConfig("claude-code", { path: fakeClaude() });
        process.env.FAKE_SCENARIO = "mcp";
        process.env.FAKE_MCP_CALLS = JSON.stringify([{ tool: "delegate", args: { task: "Subtask: read src/auth and report how sign-in strategies are registered.", description: "Map auth", model: "mock:mock-haiku", agent: "explore" } }]);
        try {
            const c = await client();
            await c.call("models.list", { refresh: true });
            const id = await c.open("session.create", { cwd: project() });
            await c.call("session.setModel", { id, ref: "claude-code:default", persist: false });
            await c.call("session.send", { id, text: "map the auth module" });
            await c.until(id, done, 30_000);
            const v = c.view(id);
            expect(v.agents).toHaveLength(1);
            const a = v.agents[0]!;
            expect(a).toMatchObject({ taskId: "task-1", description: "Map auth", agentType: "explore", model: "mock:mock-haiku", status: "done" });
            expect(a.report).toStartWith("Sign-in strategies are registered");
            expect(a.blocks.filter((b) => b.t === "tool").map((b) => (b as ToolBlock).name)).toEqual(["Glob", "Read", "Read", "Grep"]);
            expect(tools(lastTurn(v)).find((b) => b.name === DELEGATE_TOOL)?.agent).toBe(true);
            // It's over, so there's nothing left to stop.
            expect(await c.call("session.stopAgent", { id, agentId: a.id })).toEqual({ stopped: 0 });
            c.close();
        } finally {
            delete process.env.FAKE_SCENARIO;
            delete process.env.FAKE_MCP_CALLS;
            removeAgentConfig("claude-code");
        }
    }, 45_000);

    test("a delegated Codex task's own sub-agent is an agent of its own under the task: its steps, its report, asking as itself", async () => {
        const { saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
        const claude = fakeClaude();
        const codex = fakeCodex();
        saveAgentConfig("claude-code", { path: claude });
        saveAgentConfig("codex", { path: codex });
        process.env.FAKE_SCENARIO = "mcp";
        process.env.FAKE_CODEX_SCENARIO = "subagent";
        process.env.FAKE_MCP_CALLS = JSON.stringify([{ tool: "delegate", args: { task: "Count the files in src.", description: "Count", model: "codex:gpt-test" } }]);
        try {
            const c = await client();
            await c.call("models.list", { refresh: true });
            const id = await c.open("session.create", { cwd: project() });
            await c.call("session.setModel", { id, ref: "claude-code:default", persist: false });
            await c.call("session.send", { id, text: "count the files" });
            // Its sub-agent's command asks (Manual mode): as that sub-agent, under the task, and it's the one waiting.
            let during: unknown;
            const ask = await c.answer(id, { kind: "permission", choice: "yes" }, () => {
                during = c.view(id).agents.map((a) => [a.description, a.status]);
            });
            await c.until(id, done, 30_000);
            const v = c.view(id);
            expect(v.agents.map((a) => a.description)).toEqual(["Count", "Count the files"]);
            const [task, sub] = v.agents as [AgentRun, AgentRun];
            expect([task.taskId, task.model, task.status, task.parentId]).toEqual(["task-1", "codex:gpt-test", "done", undefined]);
            // Shown under the task's call to it, on the task's model, with what it did and what it answered.
            expect([sub.parentId, sub.turnId, sub.model, sub.status, sub.taskId, sub.report]).toEqual([task.id, task.turnId, "codex:gpt-test", "done", undefined, "CHILD_REPORT: 2 files."]);
            expect(task.blocks.some((b) => b.id === sub.id && b.t === "tool" && b.agent)).toBe(true);
            expect(sub.blocks.map((b) => (b.t === "tool" ? `${b.name}:${b.status}` : b.t === "text" ? b.text : b.t === "notice" ? `${b.level}: ${b.text}` : b.t))).toEqual(["info: Codex: Model metadata for `gpt-test` not found.", "error: child stream hiccup", "Bash:ok", "CHILD_REPORT: 2 files."]);
            expect(sub.toolCount).toBe(1);
            expect(sub.tokens).toBe(5050);
            // The task's own steps don't take in its sub-agent's.
            expect(task.blocks.flatMap((b) => (b.t === "tool" ? [b.name] : []))).toEqual(["Task", "wait"]);
            // Its call's row in the turn opens it; the row doesn't carry its steps over again with each one.
            const patches = c.events.flatMap((e) => (e.type === "session.ops" ? e.ops : [])).filter((o) => o.op === "block.patch" && o.blockId === task.id);
            expect(patches.length).toBeGreaterThan(0);
            expect(patches.some((o) => o.op === "block.patch" && "sub" in o.patch)).toBe(false);
            expect(ask.kind === "permission" && [ask.toolName, ask.agentLabel, ask.agentId]).toEqual(["Bash", "Count (codex:gpt-test) › Count the files", sub.id]);
            expect(during).toEqual([
                ["Count", "running"],
                ["Count the files", "waiting"],
            ]);
            // The notification says who asks.
            const note = c.events.find((e) => e.type === "notify" && e.kind === "permission");
            expect(note?.type === "notify" && note.body).toBe('Sub-agent "Count (codex:gpt-test) › Count the files" wants to run a shell command');
            c.close();
        } finally {
            delete process.env.FAKE_SCENARIO;
            delete process.env.FAKE_CODEX_SCENARIO;
            delete process.env.FAKE_MCP_CALLS;
            removeAgentConfig("claude-code");
            removeAgentConfig("codex");
        }
    }, 45_000);

    test("a delegated Codex task's own sub-agent asking after the turn is over keeps asking, as the task does", async () => {
        const { saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
        const claude = fakeClaude();
        const codex = fakeCodex();
        saveAgentConfig("claude-code", { path: claude });
        saveAgentConfig("codex", { path: codex });
        process.env.FAKE_SCENARIO = "mcp";
        process.env.FAKE_CODEX_SCENARIO = "subagent";
        // In the background, then a while waiting on it: the sub-agent asks during Claude Code's turn, which ends while it goes on.
        process.env.FAKE_MCP_CALLS = JSON.stringify([
            { tool: "delegate", args: { task: "Count the files in src.", description: "Count", model: "codex:gpt-test", wait: false } },
            { tool: "task_status", args: { task_id: "task-1", wait_seconds: 2 } },
        ]);
        try {
            const c = await client();
            await c.call("models.list", { refresh: true });
            const id = await c.open("session.create", { cwd: project() });
            await c.call("session.setModel", { id, ref: "claude-code:default", persist: false });
            await c.call("session.send", { id, text: "count the files" });
            await c.until(id, (v) => done(v) && v.state.interactions.length > 0, 20_000);
            await Bun.sleep(200);
            const v = c.view(id);
            expect(v.state.status).toBe("waiting");
            const sub = v.agents.find((a) => a.parentId)!;
            const ask = v.state.interactions[0]!;
            expect(ask.kind === "permission" && [ask.agentId, sub.status]).toEqual([sub.id, "waiting"]);
            await c.answer(id, { kind: "permission", choice: "yes" });
            await c.until(id, (x) => x.agents.length === 2 && x.agents.every((a) => a.status === "done"), 20_000);
            expect(c.view(id).agents.map((a) => [a.description, a.report?.split("\n")[0]])).toEqual([
                ["Count", "Finished."],
                ["Count the files", "CHILD_REPORT: 2 files."],
            ]);
            c.close();
        } finally {
            delete process.env.FAKE_SCENARIO;
            delete process.env.FAKE_CODEX_SCENARIO;
            delete process.env.FAKE_MCP_CALLS;
            removeAgentConfig("claude-code");
            removeAgentConfig("codex");
        }
    }, 45_000);

    /** A turn on the fake Claude Code in a scenario; the session's view once it's over. */
    async function claudeCodeTurn(scenario: string) {
        const { saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
        saveAgentConfig("claude-code", { path: fakeClaude() });
        process.env.FAKE_SCENARIO = scenario;
        try {
            const c = await client();
            await c.call("models.list", { refresh: true });
            const id = await c.open("session.create", { cwd: project() });
            await c.call("session.setModel", { id, ref: "claude-code:default", persist: false });
            await c.call("session.send", { id, text: "map the auth module" });
            await c.until(id, done, 30_000);
            const v = c.view(id);
            c.close();
            return v;
        } finally {
            delete process.env.FAKE_SCENARIO;
            removeAgentConfig("claude-code");
        }
    }

    test("Claude Code's own sub-agent finishes: its chip, its tools and its handed-back report", async () => {
        const v = await claudeCodeTurn("agent");
        expect(v.agents).toHaveLength(1);
        const a = v.agents[0]!;
        expect([a.description, a.status, a.taskId]).toEqual(["Map auth", "done", undefined]);
        expect(a.endedAt).toBeGreaterThanOrEqual(a.startedAt);
        // The tokens Claude Code says it used.
        expect(a.tokens).toBe(2345);
        // Its tool calls finish too; one it never got a result for is closed with it.
        expect(a.blocks.map((b) => (b.t === "tool" ? `${b.name}:${b.status}` : b.t === "text" ? b.text : b.t))).toEqual(["Read:ok", "Write:ok", "Task:ok", "Glob:error", "src/auth registers sign-in strategies in one list."]);
        const subTools = a.blocks.filter((b): b is ToolBlock => b.t === "tool");
        // What it wrote shows as a diff, with the token in it redacted.
        const write = subTools.find((b) => b.name === "Write")!;
        const diff = JSON.stringify(write.diff);
        expect(diff).toContain("google-token");
        expect(diff).not.toContain("ya29.subagentWroteThisToken1234567890");
        // An agent of its own: its report, not where Claude Code delivered it.
        expect(subTools.find((b) => b.name === "Task")!.output).toBe("Only email sign-in is tested.");
        // The same on the chip and on the call.
        expect(a.report).toBe("src/auth registers sign-in strategies in one list.");
        const call = tools(lastTurn(v)).find((b) => b.name === "Task")!;
        expect([call.status, call.agent, call.output]).toEqual(["ok", true, "src/auth registers sign-in strategies in one list."]);
    }, 45_000);

    for (const [scenario, when] of [
        ["agent-background", "launched first"],
        ["agent-background-late", "launched after its first step"],
    ])
        test(`Claude Code's sub-agent in the background (${when}) keeps the turn going until it reports back`, async () => {
            const v = await claudeCodeTurn(scenario);
            expect(v.agents).toHaveLength(1);
            const a = v.agents[0]!;
            const REPORT = "src/auth registers sign-in strategies in one list.";
            expect([a.description, a.status, a.report, a.tokens]).toEqual(["Map auth", "done", REPORT, 4321]);
            expect(a.blocks.map((b) => (b.t === "tool" ? `${b.name}:${b.status}` : b.t === "text" ? b.text : b.t))).toEqual(["Read:ok", "Glob:ok", REPORT]);
            // A sub-agent row in the transcript, open while it ran, with its report rather than the launch note.
            const call = tools(lastTurn(v)).find((b) => b.agent)!;
            expect([call.name, call.status, call.output]).toEqual(["Task", "ok", REPORT]);
            expect(call.durationMs).toBeGreaterThanOrEqual(250);
            expect(texts(lastTurn(v))).toContain("The explorer reported back");
        }, 45_000);

    test("Claude Code's background sub-agent that never finishes: the turn stops waiting, and says so", async () => {
        const { backgroundTiming } = await import("../src/backends/claude-code");
        const saved = { ...backgroundTiming };
        backgroundTiming.maxWaitMs = 500;
        try {
            const v = await claudeCodeTurn("agent-background-stuck");
            expect(v.agents.map((a) => [a.status, a.report])).toEqual([["stopped", undefined]]);
            const notices = lastTurn(v).blocks.flatMap((b) => (b.t === "notice" ? [b.text] : []));
            expect(notices.some((n) => /^Stopped waiting for 1 background sub-agent/.test(n))).toBe(true);
        } finally {
            Object.assign(backgroundTiming, saved);
        }
    }, 45_000);

    test("a Claude Code session shows its context: the window Claude Code reports, and the tokens in it", async () => {
        const v = await claudeCodeTurn("agent-quiet");
        expect(v.state.model?.contextWindow).toBe(200000);
        expect(v.state.contextTokens).toBe(1015);
    }, 45_000);

    test("a Claude Code turn with no reply says so instead of ending blank", async () => {
        const v = await claudeCodeTurn("silent");
        expect(lastTurn(v).blocks.map((b) => (b.t === "notice" ? b.text : b.t))).toEqual(["Claude Code ended the turn without a reply."]);
    }, 45_000);

    test("Claude Code's sub-agent that shows nothing before it finishes still gets a chip with its report", async () => {
        const v = await claudeCodeTurn("agent-quiet");
        expect(v.agents).toHaveLength(1);
        const a = v.agents[0]!;
        expect([a.status, a.report]).toEqual(["done", "src/auth registers sign-in strategies in one list."]);
        expect(a.blocks.map((b) => (b.t === "text" ? b.text : b.t))).toEqual(["src/auth registers sign-in strategies in one list."]);
        expect(tools(lastTurn(v)).find((b) => b.name === "Task")!.output).toBe("src/auth registers sign-in strategies in one list.");
    }, 45_000);

    test("Claude Code's sub-agent said to be finished before its report: no step left running, and the later report", async () => {
        const v = await claudeCodeTurn("agent-waits");
        expect(v.agents).toHaveLength(1);
        const a = v.agents[0]!;
        expect([a.status, a.report]).toEqual(["done", "src/auth registers sign-in strategies in one list."]);
        // The step after it was said to be finished isn't shown (nothing would ever close it).
        expect(a.blocks.map((b) => (b.t === "tool" ? `${b.name}:${b.status}` : b.t === "text" ? b.text : b.t))).toEqual(["Read:ok", "Task:ok", "src/auth registers sign-in strategies in one list."]);
        // An agent of its own whose report is only in its result.
        expect(a.blocks.find((b): b is ToolBlock => b.t === "tool" && b.name === "Task")!.output).toBe("Only email sign-in is tested.");
        expect(tools(lastTurn(v)).find((b) => b.name === "Task")!.output).toBe("src/auth registers sign-in strategies in one list.");
    }, 45_000);

    test("Claude Code saying again how its sub-agent ended replaces what it said: the later report", async () => {
        const v = await claudeCodeTurn("agent-renotified");
        expect(v.agents).toHaveLength(1);
        const a = v.agents[0]!;
        expect([a.status, a.report]).toEqual(["done", "src/auth registers sign-in strategies in one list."]);
        expect(a.blocks.map((b) => (b.t === "tool" ? `${b.name}:${b.status}` : b.t === "text" ? b.text : b.t))).toEqual(["Read:ok", "A first look: one list of strategies.", "src/auth registers sign-in strategies in one list."]);
    }, 45_000);

    test("Claude Code's sub-agent handing back its report after it was said to be finished: that's its report", async () => {
        const v = await claudeCodeTurn("agent-hands-back-late");
        expect(v.agents).toHaveLength(1);
        const a = v.agents[0]!;
        expect([a.status, a.report]).toEqual(["done", "src/auth registers sign-in strategies in one list."]);
        expect(a.blocks.map((b) => (b.t === "tool" ? `${b.name}:${b.status}` : b.t === "text" ? b.text : b.t))).toEqual(["Read:ok", "src/auth registers sign-in strategies in one list."]);
    }, 45_000);

    test("Claude Code saying again how its sub-agent ended replaces what it said: failed after all", async () => {
        const v = await claudeCodeTurn("agent-fails-later");
        // With no report, what its call says now is its report (the call said otherwise before).
        expect(v.agents.map((a) => [a.status, a.report])).toEqual([["failed", "The sub-agent failed."]]);
        // Its call's row says so too, not what it said first.
        const call = tools(lastTurn(v)).find((b) => b.name === "Task")!;
        expect([call.status, call.output]).toEqual(["error", "The sub-agent failed."]);
    }, 45_000);

    test("Claude Code's sub-agent failing, then its report coming: the report, and its row still says it failed", async () => {
        const v = await claudeCodeTurn("agent-fails-then-reports");
        expect(v.agents.map((a) => [a.status, a.report])).toEqual([["failed", "src/auth registers sign-in strategies in one list."]]);
        const call = tools(lastTurn(v)).find((b) => b.name === "Task")!;
        expect([call.status, call.output]).toEqual(["error", "src/auth registers sign-in strategies in one list."]);
    }, 45_000);

    for (const early of [undefined, "all"])
    test(`Codex's own sub-agent${early ? " that did everything before the spawn said whose it was" : ""}: a chip with its tools and its answer as the report, asking as itself; the reply and context are the main thread's`, async () => {
        const { saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
        saveAgentConfig("codex", { path: fakeCodex() });
        process.env.FAKE_SCENARIO = "subagent";
        if (early) process.env.FAKE_CHILD_EARLY = early;
        try {
            const c = await client();
            const id = await c.open("session.create", { cwd: project() });
            await c.call("session.setModel", { id, ref: "codex:default", persist: false });
            await c.call("session.send", { id, text: "count the files with a sub-agent" });
            // Its command asks (Manual mode), naming it.
            const ask = await c.answer(id, { kind: "permission", choice: "yes" });
            await c.until(id, done, 30_000);
            const v = c.view(id);
            // Asked before Codex said whose thread it is, it's a sub-agent of Codex's, not yet that chip.
            expect(ask.kind === "permission" && [ask.toolName, ask.agentLabel, ask.agentId]).toEqual(early ? ["Bash", "Codex sub-agent", undefined] : ["Bash", "Count the files", v.agents[0]?.id]);
            expect(v.agents).toHaveLength(1);
            const a = v.agents[0]!;
            expect([a.description, a.status, a.report]).toEqual(["Count the files", "done", "CHILD_REPORT: 2 files."]);
            // Its tokens, even those Codex reported before the spawn said whose they were.
            expect(a.tokens).toBe(5050);
            // Its warning and error show on its chip, not as the session's.
            expect(a.blocks.map((b) => (b.t === "tool" ? `${b.name}:${b.status}` : b.t === "text" ? b.text : b.t === "notice" ? `${b.level}: ${b.text}` : b.t))).toEqual(["info: Codex: Model metadata for `gpt-test` not found.", "error: child stream hiccup", "Bash:ok", "CHILD_REPORT: 2 files."]);
            const turn = lastTurn(v);
            expect(turn.blocks.filter((b) => b.t === "notice")).toEqual([]);
            expect(tools(turn).map((b) => [b.name, b.agent ?? false])).toEqual([["Task", true], ["wait", false]]);
            const said = turn.blocks.flatMap((b) => (b.t === "text" ? [b.text] : [])).join("\n");
            expect(said).toContain("Finished.");
            for (const not of ["Looking around.", "CHILD_REPORT"]) expect(said).not.toContain(not);
            expect(v.state.contextTokens).toBe(150);
            c.close();
        } finally {
            delete process.env.FAKE_SCENARIO;
            delete process.env.FAKE_CHILD_EARLY;
            removeAgentConfig("codex");
        }
    }, 45_000);

    for (const twice of ["1", "silent"])
    test(`Codex's own sub-agent messaged after it answered: running again, asking as itself, and ${twice === "1" ? "its new answer is its report" : "stopped before answering, its earlier answer isn't its report"}`, async () => {
        const { saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
        saveAgentConfig("codex", { path: fakeCodex() });
        process.env.FAKE_SCENARIO = "subagent";
        process.env.FAKE_CHILD_TWICE = twice;
        try {
            const c = await client();
            const id = await c.open("session.create", { cwd: project() });
            await c.call("session.setModel", { id, ref: "codex:default", persist: false });
            await c.call("session.send", { id, text: "count the files, then the tests" });
            await c.answer(id, { kind: "permission", choice: "yes" });
            // Its second turn's command: the chip it asks from is working again.
            let during: unknown;
            const ask = await c.answer(id, { kind: "permission", choice: "yes" }, () => {
                const a = c.view(id).agents[0];
                during = a && [a.status, a.endedAt, a.report];
            });
            await c.until(id, done, 30_000);
            const v = c.view(id);
            expect(v.agents).toHaveLength(1);
            const a = v.agents[0]!;
            expect(ask.kind === "permission" && [ask.agentLabel, ask.agentId]).toEqual(["Count the files", a.id]);
            expect(during).toEqual(["waiting", undefined, undefined]);
            expect([a.status, a.report]).toEqual(twice === "1" ? ["done", "CHILD_REPORT: 3 tests."] : ["stopped", undefined]);
            expect(a.blocks.flatMap((b) => (b.t === "tool" ? [`${b.name}:${b.status}`] : []))).toEqual(["Bash:ok", "Bash:ok"]);
            // Where its latest turn starts: what the chip takes its last words from (the first answer is before it).
            const from = a.blocks.findIndex((b) => b.id === a.turnAfter);
            expect(a.blocks.slice(0, from + 1).some((b) => b.t === "text" && b.text === "CHILD_REPORT: 2 files.")).toBe(true);
            expect(a.blocks.slice(from + 1).some((b) => b.t === "text" && b.text === "CHILD_REPORT: 2 files.")).toBe(false);
            c.close();
        } finally {
            delete process.env.FAKE_SCENARIO;
            delete process.env.FAKE_CHILD_TWICE;
            removeAgentConfig("codex");
        }
    }, 45_000);

    test("a delegated agent working past the turn keeps asking; stopping it withdraws the request", async () => {
        const { saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
        saveAgentConfig("claude-code", { path: fakeClaude() });
        process.env.FAKE_SCENARIO = "mcp";
        // In the background, then a while waiting on it: the task asks during Claude Code's turn, which ends while it goes on.
        process.env.FAKE_MCP_CALLS = JSON.stringify([
            { tool: "delegate", args: { task: "Subtask: write a note in NOTES.md.", description: "Write a note", model: "mock:mock-haiku", wait: false } },
            { tool: "task_status", args: { task_id: "task-1", wait_seconds: 2 } },
        ]);
        try {
            const c = await client();
            const dir = project();
            const id = await c.open("session.create", { cwd: dir });
            await c.call("session.setModel", { id, ref: "claude-code:default", persist: false });
            await c.call("session.send", { id, text: "get a note written" });
            // Its Write asks (Manual mode), naming it, and it shows as waiting, after the turn is over.
            await c.until(id, (v) => done(v) && v.state.interactions.length > 0 && v.agents[0]?.status === "waiting", 20_000);
            await Bun.sleep(200);
            const v = c.view(id);
            expect(v.state.status).toBe("waiting");
            const ask = v.state.interactions[0]!;
            expect(ask.kind === "permission" && [ask.toolName, ask.agentLabel, ask.agentId]).toEqual(["Write", "Write a note (mock:mock-haiku)", v.agents[0]!.id]);
            expect(v.agents[0]!.activity).toBe("Waiting for approval");
            // Its notification says who asks: not the session's own agent.
            expect(c.events.flatMap((e) => (e.type === "notify" && e.kind === "permission" ? [e.body] : []))).toEqual(['Sub-agent "Write a note (mock:mock-haiku)" wants to create a file']);

            expect(await c.call("session.stopAgent", { id, agentId: v.agents[0]!.id })).toEqual({ stopped: 1 });
            await c.until(id, (x) => x.state.interactions.length === 0 && x.agents[0]?.status === "stopped", 10_000);
            expect(existsSync(join(dir, "NOTES.md"))).toBe(false);
            c.close();
        } finally {
            delete process.env.FAKE_SCENARIO;
            delete process.env.FAKE_MCP_CALLS;
            removeAgentConfig("claude-code");
        }
    }, 45_000);
});

describe("reopening a Claude Code session", () => {
    /** A session on the fake Claude Code: one turn in `scenario`, in `mode`. */
    async function claudeCodeSession(scenario: string, mode: string) {
        const { saveAgentConfig } = await import("../src/providers/registry");
        saveAgentConfig("claude-code", { path: fakeClaude() });
        process.env.FAKE_SCENARIO = scenario;
        const c = await client();
        await c.call("models.list", { refresh: true });
        const dir = project();
        const id = await c.open("session.create", { cwd: dir });
        await c.call("session.setModel", { id, ref: "claude-code:default", persist: false });
        await c.call("session.setMode", { id, mode });
        await c.call("session.send", { id, text: "map the auth module" });
        await c.until(id, done, 30_000);
        return { c, id, dir };
    }
    async function cleanup() {
        const { removeAgentConfig } = await import("../src/providers/registry");
        delete process.env.FAKE_SCENARIO;
        removeAgentConfig("claude-code");
    }
    /** The session as a fresh server opens it (after a restart, or once it was unloaded). */
    async function reopened(id: string, opts: { allowBypass?: boolean } = {}) {
        const restarted = await startServer({ token: TOKEN, ...opts });
        try {
            const c2 = new Client(TOKEN, {}, restarted.port);
            await c2.opened();
            const snap = await c2.call<SessionSnapshot>("session.open", { id });
            c2.close();
            return snap;
        } finally {
            await restarted.stop();
        }
    }
    const step = (b: Block) => (b.t === "tool" ? [b.id, b.name, b.title, b.status, b.summary, b.output, b.agent, b.startedAt, b.durationMs, b.input] : b.t === "text" || b.t === "thinking" ? [b.t, b.text] : [b.t]);

    test("its turns come back as they were shown: the steps, the sub-agents and what they did, the mode, model and context", async () => {
        try {
            const { c, id } = await claudeCodeSession("agent", "auto");
            const live = structuredClone(c.view(id));
            expect(live.state.mode).toBe("auto");
            expect(live.state.contextTokens).toBeGreaterThan(0);
            expect(live.agents).toHaveLength(1);
            const snap = await reopened(id);
            // Each step where it was, with its title, result and timing (notices aren't kept).
            expect(snap.turns.map((t) => t.blocks.filter((b) => b.t !== "notice").map(step))).toEqual(live.turns.map((t) => t.blocks.filter((b) => b.t !== "notice").map(step)));
            expect(snap.turns.map((t) => [t.status, t.startedAt, t.endedAt])).toEqual(live.turns.map((t) => [t.status, t.startedAt, t.endedAt]));
            // The sub-agent with what it said and did, not only its report.
            const [was, now] = [live.agents[0]!, snap.agents[0]!];
            expect(snap.agents).toHaveLength(1);
            expect([now.id, now.turnId, now.description, now.status, now.report, now.startedAt, now.endedAt, now.toolCount, now.replayed]).toEqual([was.id, snap.turns[0]!.id, was.description, was.status, was.report, was.startedAt, was.endedAt, was.toolCount, true]);
            expect(now.blocks.map((b) => (b.t === "tool" ? `${b.name}:${b.status}` : b.t === "text" ? b.text : b.t))).toEqual(was.blocks.map((b) => (b.t === "tool" ? `${b.name}:${b.status}` : b.t === "text" ? b.text : b.t)));
            // The session as it was left: its mode, its model (in the snapshot itself), and how full its context was.
            expect([snap.state.mode, snap.state.model?.ref, snap.state.contextTokens]).toEqual(["auto", "claude-code:default", live.state.contextTokens]);
            // What other models are given of the turn is as before: the reply, and a note of what was done.
            const { findSessionAnywhere } = await import("../src/agent/session");
            const lines = readFileSync(findSessionAnywhere(id)!, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
            const reply = lines.filter((l) => l.t === "msg" && l.m.role === "assistant").map((l) => l.m.content.map((p: { type: string; text: string }) => [p.type, p.text]));
            expect(reply).toEqual([[["text", "Working on it.\n\nAll done."], ["text", "[Claude Code used: Task(Map auth)]"]]]);
            c.close();
        } finally {
            await cleanup();
        }
    }, 60_000);

    test("a Codex turn's progress messages come back as they were, each between its commands, and its answer on its own", async () => {
        const { saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
        saveAgentConfig("codex", { path: fakeCodex() });
        process.env.FAKE_SCENARIO = "steps";
        try {
            const c = await client();
            const id = await c.open("session.create", { cwd: project() });
            await c.call("session.setModel", { id, ref: "codex:default", persist: false });
            await c.call("session.send", { id, text: "look around" });
            await c.until(id, done, 30_000);
            const seq = (blocks: Block[]) => blocks.filter((b) => b.t === "text" || b.t === "tool").map((b) => (b.t === "tool" ? `tool:${b.status}` : b.text));
            const live = seq(lastTurn(c.view(id)).blocks);
            expect(live).toEqual(["Running it.", "tool:ok", "Checked the first.", "tool:ok", "Finished."]);
            const snap = await reopened(id);
            expect(seq(snap.turns.at(-1)!.blocks)).toEqual(live);
            c.close();
        } finally {
            delete process.env.FAKE_SCENARIO;
            removeAgentConfig("codex");
        }
    }, 45_000);

    test("after Claude Code compacts its own context, later turns still come back (the transcript itself wasn't compacted)", async () => {
        try {
            const { c, id } = await claudeCodeSession("write", "acceptEdits");
            const hitFor = async (query: string) => (await c.call<SessionSearchResult>("sessions.search", { query, limit: 200 })).hits.find((h) => h.id === id)!;
            const target = (turns: Turn[], h: { seg: number; index: number }) => turns.filter((t) => t.pos && (t.pos.seg < h.seg || (t.pos.seg === h.seg && t.pos.index <= h.index))).at(-1)!;
            const before = await hitFor("map the auth module");
            expect(target(c.view(id).turns, before).prompt?.text).toBe("map the auth module");
            await c.call("session.compact", { id });
            await c.until(id, (v) => v.turns.some((t) => t.blocks.some((b) => b.t === "compact")));
            const after = await hitFor("map the auth module");
            expect(after).toMatchObject({ seg: 0, index: 0, at: before.at });
            const first = target(c.view(id).turns, after);
            expect(first.prompt?.text).toBe("map the auth module");
            expect(first.startedAt).toBe(after.at);
            expect(c.view(id).turns.find((t) => !t.prompt && t.blocks.some((b) => b.t === "compact"))!.pos).toBeUndefined();
            // (Calls of their own: the fake's ids are the same each turn.)
            process.env.FAKE_SCENARIO = "agent";
            await c.call("session.send", { id, text: "and the tests?" });
            await c.until(id, (v) => done(v) && v.turns.filter((t) => t.prompt).length === 2, 30_000);
            const live = structuredClone(c.view(id));
            const next = await hitFor("and the tests?");
            expect(next).toMatchObject({ seg: 0, index: 2 });
            expect(target(live.turns, next)).toMatchObject({ prompt: { text: "and the tests?" }, startedAt: next.at });
            // Its history is all still there: nothing is out of reach of rewind.
            expect(live.turns.filter((t) => t.prompt).map((t) => [t.prompt!.text, t.prompt!.index, Boolean(t.archived)])).toEqual([
                ["map the auth module", 0, false],
                ["and the tests?", 2, false],
            ]);
            expect((await c.call<any[]>("session.rewindTargets", { id })).map((t) => t.index)).toEqual([2, 0]);
            const snap = await reopened(id);
            const prompted = (v: { turns: Turn[] }) => v.turns.filter((t) => t.prompt).map((t) => [t.prompt!.text, t.pos, t.startedAt, t.endedAt, t.blocks.filter((b) => b.t !== "notice").map(step)]);
            expect(prompted(snap)).toEqual(prompted(live));
            expect(target(snap.turns, after).prompt?.text).toBe("map the auth module");
            expect(target(snap.turns, next).prompt?.text).toBe("and the tests?");
            expect(tools(snap.turns.find((t) => t.prompt?.text === "and the tests?")!).map((b) => `${b.name}:${b.status}`)).toEqual(["Task:ok"]);
            expect(snap.agents.map((a) => [a.description, a.status, a.blocks.length > 0])).toEqual([["Map auth", "done", true]]);
            c.close();
        } finally {
            await cleanup();
        }
    }, 60_000);

    test("a delegated sub-agent that outlives its turn comes back as it ended, and so does its row in that turn", async () => {
        const { saveAgentConfig } = await import("../src/providers/registry");
        saveAgentConfig("claude-code", { path: fakeClaude() });
        process.env.FAKE_SCENARIO = "mcp";
        // In the background: its Write asks (Manual mode) after Claude Code's turn is over.
        process.env.FAKE_MCP_CALLS = JSON.stringify([{ tool: "delegate", args: { task: "Subtask: write a note in NOTES.md.", description: "Write a note", model: "mock:mock-haiku", wait: false } }]);
        const run = (a: AgentRun) => [a.id, a.description, a.status, a.blocks.map((b) => (b.t === "tool" ? `${b.name}:${b.status}` : b.t))];
        try {
            const c = await client();
            const id = await c.open("session.create", { cwd: project() });
            await c.call("session.setModel", { id, ref: "claude-code:default", persist: false });
            await c.call("session.send", { id, text: "get a note written" });
            await c.until(id, (v) => done(v) && v.agents[0]?.status === "waiting", 20_000);
            await c.answer(id, { kind: "permission", choice: "yes" });
            await c.until(id, (v) => v.agents[0]?.status === "done", 20_000);
            await Bun.sleep(200);
            const live = structuredClone(c.view(id));
            expect(live.agents.map(run)).toEqual([[live.agents[0]!.id, "Write a note", "done", ["text", "Write:ok", "text"]]]);
            const snap = await reopened(id);
            expect(snap.agents.map(run)).toEqual(live.agents.map(run));
            // The call's row as it was last shown, not as it was when the turn ended.
            const call = (v: { turns: Turn[] }) => tools(v.turns[0]!).map((b) => [b.name, b.status, b.sub?.toolCount, b.sub?.tools.map((x) => `${x.name}:${x.status}`)]);
            expect(call(snap)).toEqual(call(live));
            c.close();
        } finally {
            delete process.env.FAKE_MCP_CALLS;
            await cleanup();
        }
    }, 60_000);

    test("one still working when the server stops comes back stopped, with what it had done", async () => {
        const { saveAgentConfig } = await import("../src/providers/registry");
        saveAgentConfig("claude-code", { path: fakeClaude() });
        process.env.FAKE_SCENARIO = "mcp";
        process.env.FAKE_MCP_CALLS = JSON.stringify([{ tool: "delegate", args: { task: "Subtask: write a note in NOTES.md.", description: "Write a note", model: "mock:mock-haiku", wait: false } }]);
        const own = await startServer({ token: TOKEN });
        try {
            const c = new Client(TOKEN, {}, own.port);
            await c.opened();
            // The mock model listed (it isn't cached), so there's someone to delegate to.
            await c.call("models.list", { refresh: true });
            const id = await c.open("session.create", { cwd: project() });
            await c.call("session.setModel", { id, ref: "claude-code:default", persist: false });
            await c.call("session.send", { id, text: "get a note written" });
            await c.until(id, (v) => done(v) && v.agents[0]?.status === "waiting", 20_000);
            const was = structuredClone(c.view(id).agents[0]!);
            c.close();
            await own.stop();
            const [now] = (await reopened(id)).agents;
            expect([now?.description, now?.status, now?.blocks.map((b) => (b.t === "tool" ? b.name : b.t))]).toEqual(["Write a note", "stopped", was.blocks.map((b) => (b.t === "tool" ? b.name : b.t))]);
            expect(was.blocks.some((b) => b.t === "tool" && b.name === "Write")).toBe(true);
        } finally {
            delete process.env.FAKE_MCP_CALLS;
            await own.stop().catch(() => undefined);
            await cleanup();
        }
    }, 60_000);

    test("the mode it was left in, changed after its turns too; but bypass isn't taken up again without being chosen", async () => {
        try {
            const { c, id } = await claudeCodeSession("write", "acceptEdits");
            expect((await reopened(id)).state.mode).toBe("acceptEdits");
            await c.call("session.setMode", { id, mode: "plan" });
            c.close();
            expect((await reopened(id)).state.mode).toBe("plan");
            const { findSessionAnywhere } = await import("../src/agent/session");
            const file = findSessionAnywhere(id)!;
            const log = join(dirname(file), "ui", `${id}.jsonl`);
            writeFileSync(log, readFileSync(log, "utf-8") + JSON.stringify({ t: "state", mode: "bypassPermissions" }) + "\n");
            // Not even where it's allowed.
            expect((await reopened(id, { allowBypass: true })).state.mode).toBe("default");
        } finally {
            await cleanup();
        }
    }, 60_000);

    test("rewinding past turns of another model and Claude Code: files Harness restores go back whole, and the model is told which", async () => {
        const { saveAgentConfig } = await import("../src/providers/registry");
        const log = join(tempDir("harness-gui-log-"), "claude.log");
        try {
            const dir = project();
            const before = readFileSync(join(dir, "src/auth/index.ts"), "utf-8");
            const c = await client();
            const id = await c.open("session.create", { cwd: dir, mode: "acceptEdits" });
            await c.call("session.setModel", { id, ref: "mock:mock-opus", persist: false });
            await c.call("session.send", { id, text: "demo" });
            await c.answer(id, { kind: "permission", choice: "yes" }); // the shell command
            await c.until(id, done, 15_000);
            saveAgentConfig("claude-code", { path: fakeClaude() });
            process.env.FAKE_SCENARIO = "write";
            await c.call("models.list", { refresh: true });
            await c.call("session.setModel", { id, ref: "claude-code:default", persist: false });
            await c.call("session.send", { id, text: "write the notes" });
            await c.until(id, (v) => done(v) && v.turns.filter((t) => t.prompt).length === 2, 30_000);
            // Claude Code changing a file Harness changed before (the fake only writes out.txt itself).
            writeFileSync(join(dir, "src/auth/index.ts"), readFileSync(join(dir, "src/auth/index.ts"), "utf-8") + "// from Claude Code\n");
            const targets = await c.call<any[]>("session.rewindTargets", { id });
            expect(targets.map((t) => [t.text, t.backends])).toEqual([
                ["write the notes", ["Claude Code"]],
                ["demo", undefined],
            ]);
            const plan = await c.call("session.rewindPlan", { id, index: targets[1].index });
            expect([plan.restore.map((r: { path: string; outside: boolean }) => `${r.path}:${r.outside}`).sort(), plan.backends]).toEqual([["src/auth/index.ts:true", "src/auth/sso.ts:false"], ["Claude Code"]]);
            await c.call("session.rewind", { id, index: targets[1].index, planId: plan.planId, code: true, conversation: true });
            // The whole file went back, Claude Code's change in it too; what it wrote elsewhere stays.
            expect(readFileSync(join(dir, "src/auth/index.ts"), "utf-8")).toBe(before);
            expect(existsSync(join(dir, "out.txt"))).toBe(true);
            process.env.FAKE_LOG = log;
            await c.call("session.send", { id, text: "and now?" });
            await c.until(id, (v) => done(v) && v.turns.filter((t) => t.prompt).length === 1, 30_000);
            const sent = readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.received?.type === "user").map((l) => JSON.stringify(l.received.message.content));
            expect(sent.at(-1)).toContain("weren't undone (rewind can't restore them), except in these files, which were restored to how they were then:\\n- src/auth/index.ts\\n- src/auth/sso.ts");
            c.close();
        } finally {
            delete process.env.FAKE_LOG;
            await cleanup();
        }
    }, 60_000);

    test("rewind says what Claude Code changed isn't tracked, rather than that nothing changed", async () => {
        try {
            const { c, id, dir } = await claudeCodeSession("write", "acceptEdits");
            expect(existsSync(join(dir, "out.txt"))).toBe(true);
            const targets = await c.call<any[]>("session.rewindTargets", { id });
            expect(targets.map((t) => [t.index, t.tracked, t.files, t.backends])).toEqual([[0, true, 0, ["Claude Code"]]]);
            const plan = await c.call("session.rewindPlan", { id, index: 0 });
            expect([plan.restore, plan.backends]).toEqual([[], ["Claude Code"]]);
            await c.call("session.rewind", { id, index: 0, planId: plan.planId, code: false, conversation: true });
            // Its change is still there; the next turn is told so.
            expect(existsSync(join(dir, "out.txt"))).toBe(true);
            const log = join(tempDir("harness-gui-log-"), "claude.log");
            process.env.FAKE_LOG = log;
            await c.call("session.send", { id, text: "and now?" });
            await c.until(id, (v) => done(v) && v.turns.length === 1 && v.turns[0]!.prompt?.text === "and now?", 30_000);
            const sent = readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.received?.type === "user").map((l) => JSON.stringify(l.received.message.content));
            expect(sent.at(-1)).toContain("changes Claude Code made to files after that point weren't undone");
            c.close();
        } finally {
            delete process.env.FAKE_LOG;
            await cleanup();
        }
    }, 60_000);

    /** The session's history as a model is given it next (the file's messages, rewinds applied). */
    async function history(id: string): Promise<any[]> {
        const { findSessionAnywhere } = await import("../src/agent/session");
        const out: any[] = [];
        for (const l of readFileSync(findSessionAnywhere(id)!, "utf-8").trim().split("\n").map((x) => JSON.parse(x))) {
            if (l.t === "msg") out.push(l.m);
            else if (l.t === "rewind") out.length = l.count;
        }
        return out;
    }
    /** What a fake CLI was started with and sent (FAKE_LOG). */
    const logged = (log: string) => readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const sentPrompts = (log: string) => logged(log).filter((l) => l.received?.type === "user").map((l) => JSON.stringify(l.received.message.content));
    const working = (v: { turns: Turn[] }) => v.turns.length > 0 && tools(lastTurn(v)).map((b) => `${b.name}:${b.status}`).join() === "Write:ok,Bash:running";
    const shown = (t: Turn) => t.blocks.filter((b) => b.t !== "notice").map((b) => (b.t === "tool" ? `${b.name}:${b.status}` : b.t === "text" ? b.text : b.t));

    /** A Claude Code turn under way in a server of its own, part way: it wrote a file, and a command of it is running. */
    async function partWay(port: number, git = false) {
        const c = new Client(TOKEN, {}, port);
        await c.opened();
        const cwd = project();
        if (git) {
            await snapshotRepo(cwd);
            await c.call("projects.trust", { path: cwd, trust: true });
        }
        const id = await c.open("session.create", { cwd, mode: "acceptEdits" });
        await c.call("session.setModel", { id, ref: "claude-code:default", persist: false });
        await c.call("session.send", { id, text: "write it, then wait" });
        await c.until(id, working, 20_000);
        return { c, id };
    }

    /** Cut off part way, it comes back interrupted (never done), with what it did; its history says so once. */
    async function expectCutOff(id: string, was: { turns: Turn[] }) {
        const snap = await reopened(id);
        expect(snap.turns.map((t) => [t.prompt?.text, t.status])).toEqual([["write it, then wait", "aborted"]]);
        expect(shown(snap.turns[0]!)).toEqual(["Working on it.", "Write:ok", "Bash:error"]);
        expect(tools(snap.turns[0]!)[0]!.durationMs).toBe(tools(lastTurn(was))[0]!.durationMs);
        const h = await history(id);
        expect(h.filter((m) => m.role === "user").map((m) => m.meta?.kind)).toEqual(["prompt", "interrupt"]);
        expect(h.at(-1).meta.kind).toBe("interrupt");
        // Opened again, nothing more is added.
        await reopened(id);
        expect((await history(id)).length).toBe(h.length);
    }

    test("a turn the server stops part way comes back interrupted, with what it had done", async () => {
        const { saveAgentConfig } = await import("../src/providers/registry");
        saveAgentConfig("claude-code", { path: fakeClaude() });
        process.env.FAKE_SCENARIO = "write-hang";
        const own = await startServer({ token: TOKEN });
        try {
            const { c, id } = await partWay(own.port);
            const was = structuredClone(c.view(id));
            c.close();
            await own.stop();
            await expectCutOff(id, was);
        } finally {
            await own.stop().catch(() => undefined);
            await cleanup();
        }
    }, 60_000);

    test("a turn that ended after a message sent while its tools ran isn't taken for one cut off", async () => {
        const c = await client();
        const id = await c.open("session.create", { cwd: project() });
        await c.call("session.setModel", { id, ref: "mock:mock-opus", persist: false });
        await c.call("session.send", { id, text: "demo" });
        await c.until(id, (v) => v.state.interactions.length > 0);
        expect(await c.call("session.send", { id, text: "and the docs" })).toEqual({ queued: true });
        // Declined: it ends there, with the message riding along with the results.
        await c.answer(id, { kind: "permission", choice: "no" });
        await c.until(id, done);
        const live = structuredClone(c.view(id));
        c.close();
        const snap = await reopened(id);
        expect((await history(id)).some((m) => m.meta?.kind === "interrupt")).toBe(false);
        expect(snap.turns.map((t) => [t.prompt?.text, t.status])).toEqual(live.turns.map((t) => [t.prompt?.text, t.status]));
    }, 60_000);

    test("one cut off by the server being killed comes back the same, and Claude Code is told when it goes on", async () => {
        const { saveAgentConfig } = await import("../src/providers/registry");
        saveAgentConfig("claude-code", { path: fakeClaude() });
        process.env.FAKE_SCENARIO = "write-hang";
        const log = join(tempDir("harness-gui-log-"), "claude.log");
        // The server in a process of its own, to kill outright (the fake CLI it starts exits once its stdin closes).
        const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "gui-server-child.ts")], { env: { ...process.env, CHILD_TOKEN: TOKEN }, stdout: "pipe", stderr: "ignore" });
        try {
            const first = await child.stdout.getReader().read();
            const { port } = JSON.parse(new TextDecoder().decode(first.value).split("\n")[0]!);
            const { c, id } = await partWay(port, true);
            const was = structuredClone(c.view(id));
            const checkpoint = (await history(id))[0].meta.checkpoint;
            const records = await snapshotRecords(id);
            expect(records).toHaveLength(1);
            expect(records[0]!.id).toBe(checkpoint);
            expect(records[0]!.start.tree).toBeString();
            expect(records[0]!.end).toBeUndefined();
            // What it shows is in the log within a moment, not only once the turn ends.
            await Bun.sleep(200);
            // Its record says which prompt it's of.
            const { findSessionAnywhere } = await import("../src/agent/session");
            const ui = readFileSync(join(dirname(findSessionAnywhere(id)!), "ui", `${id}.jsonl`), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
            expect(ui.some((r) => r.t === "turn" && r.index === 0 && typeof r.prompt === "string")).toBe(true);
            child.kill("SIGKILL");
            await child.exited;
            c.close();
            await expectCutOff(id, was);
            // Claude Code goes on in its own session, told that its turn there was cut off.
            process.env.FAKE_SCENARIO = "write";
            process.env.FAKE_LOG = log;
            const again = await startServer({ token: TOKEN });
            try {
                const c2 = new Client(TOKEN, {}, again.port);
                await c2.opened();
                await c2.open("session.open", { id });
                expect(c2.view(id).turns[0]).toMatchObject({ status: "aborted", snapshotId: checkpoint });
                const changes = await c2.call("session.gitChanges", { id, scope: "turn", turnId: checkpoint });
                expect(changes).toMatchObject({ incomplete: true, snapshotAvailable: false, files: [] });
                expect(changes.notes.join(" ")).toContain("without a closing snapshot");
                await c2.call("session.send", { id, text: "and now?" });
                await c2.until(id, (v) => done(v) && v.turns.filter((t) => t.prompt).length === 2, 30_000);
                const started = logged(log).find((l) => l.argv?.includes("--resume"));
                expect(started).toBeDefined();
                expect(sentPrompts(log).at(-1)).toContain("was cut off");
                // What other models are given is the history, which says so already.
                expect(JSON.stringify((await history(id)).at(-2))).not.toContain("was cut off");
                const turns = c2.view(id).turns.filter((t) => t.prompt);
                expect(turns[0]).toMatchObject({ status: "aborted", snapshotId: checkpoint });
                expect(turns[1]!.snapshotId).toBeGreaterThan(checkpoint);
                const continued = await snapshotRecords(id);
                expect(continued.filter((r) => r.id === checkpoint)).toEqual(records);
                expect(continued.at(-1)).toMatchObject({ id: turns[1]!.snapshotId });
                expect(continued.at(-1)!.end?.tree).toBeString();
                c2.close();
            } finally {
                await again.stop();
            }
        } finally {
            child.kill("SIGKILL");
            delete process.env.FAKE_LOG;
            await cleanup();
        }
    }, 90_000);

    test("the effort it was left at comes back too; choosing the mode it already has tells the model nothing new", async () => {
        const log = join(tempDir("harness-gui-log-"), "claude.log");
        try {
            const { c, id } = await claudeCodeSession("write", "acceptEdits");
            await c.call("session.setEffort", { id, effort: "high" });
            c.close();
            expect((await reopened(id)).state.effort).toBe("high");
            process.env.FAKE_LOG = log;
            const again = await startServer({ token: TOKEN });
            try {
                const c2 = new Client(TOKEN, {}, again.port);
                await c2.opened();
                await c2.open("session.open", { id });
                // Picked again, as one would after a reopen that showed Manual.
                await c2.call("session.setMode", { id, mode: "acceptEdits" });
                await c2.call("session.send", { id, text: "and now?" });
                await c2.until(id, (v) => done(v) && v.turns.filter((t) => t.prompt).length === 2, 30_000);
                expect(sentPrompts(log).at(-1)).not.toContain("switched the permission mode");
                // The effort it runs with is the one it was left at.
                expect(logged(log).filter((l) => l.argv).at(-1).argv.join(" ")).toContain("--effort high");
                // Another mode is news.
                await c2.call("session.setMode", { id, mode: "default" });
                await c2.call("session.send", { id, text: "and then?" });
                await c2.answer(id, { kind: "permission", choice: "yes" }); // its Write, in Manual
                await c2.until(id, (v) => done(v) && v.turns.filter((t) => t.prompt).length === 3, 30_000);
                expect(sentPrompts(log).at(-1)).toContain("switched the permission mode");
                c2.close();
            } finally {
                await again.stop();
            }
        } finally {
            delete process.env.FAKE_LOG;
            await cleanup();
        }
    }, 90_000);
});

describe("terminal WebSocket transport", () => {
    // A plain shell with an empty home: none of the user's own startup files run.
    const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME };
    beforeAll(() => { process.env.SHELL = "/bin/sh"; process.env.HOME = tempDir("terminal-home-"); });
    afterAll(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
    test("streams only to its owning window and closes the shell on disconnect", async () => {
        const a = await client(); const b = await client();
        const id = "transport-terminal";
        const output = () => a.events.filter((e) => e.type === "terminal.data" && e.id === id).map((e) => e.data).join("");
        const waitFor = async (check: () => boolean) => {
            const deadline = Date.now() + 5000;
            while (!check()) { if (Date.now() > deadline) throw new Error("Terminal transport timed out"); await Bun.sleep(20); }
        };
        try {
            await a.call("terminal.open", { id, cwd: project(), cols: 80, rows: 24 });
            await expect(b.call("terminal.write", { id, data: "exit\n" })).rejects.toThrow("not open");
            await a.call("terminal.resize", { id, cols: 99, rows: 33 });
            await a.call("terminal.write", { id, data: "printf '__owner_shell__%s\\n' $$; stty size\n" });
            await waitFor(() => /__owner_shell__\d+\r?\n/.test(output()) && output().includes("33 99"));
            const pid = Number(output().match(/__owner_shell__(\d+)/)![1]);
            expect(b.events.some((e) => e.type === "terminal.data" && e.id === id)).toBe(false);
            a.close();
            await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
            await expect(b.call("terminal.close", { id })).rejects.toThrow("not open");
        } finally { a.close(); b.close(); }
    }, 15_000);
});

describe("project scripts", () => {
    // Run in a plain shell with an empty home, as above.
    const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME };
    beforeAll(() => { process.env.SHELL = "/bin/sh"; process.env.HOME = tempDir("scripts-home-"); });
    afterAll(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
    const waitFor = async (check: () => boolean, what = "project script") => {
        const deadline = Date.now() + 8000;
        while (!check()) { if (Date.now() > deadline) throw new Error(`${what} timed out`); await Bun.sleep(20); }
    };
    /** A repository with a linked worktree, both by their real paths. */
    async function repoWithWorktree() {
        const { gitArgv, gitEnv } = await import("../src/util/git");
        const git = (cwd: string, ...args: string[]) => {
            const r = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Harness Test", "-c", "user.email=test@example.invalid", ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
            if (r.exitCode !== 0) throw new Error(r.stderr.toString());
        };
        const base = realpathSync(tempDir("harness-gui-scripts-"));
        const main = join(base, "repo");
        const linked = join(base, "repo-wt");
        mkdirSync(main);
        git(main, "init", "-b", "main");
        git(main, "commit", "--allow-empty", "-m", "Initial commit");
        git(main, "worktree", "add", "-b", "wt", linked);
        return { main, linked };
    }

    test("define, edit, reorder and delete over RPC; other windows hear of each change", async () => {
        const a = await client(); const b = await client();
        try {
            const { main, linked } = await repoWithWorktree();
            expect(await a.call("scripts.list", { cwd: main })).toEqual({ project: main, scripts: [] });
            const dev = await a.call<ProjectScript>("scripts.save", { cwd: linked, name: " dev ", command: "bun run dev", icon: "play" });
            expect(dev).toMatchObject({ name: "dev", command: "bun run dev", icon: "play" });
            await waitFor(() => b.events.some((e) => e.type === "scripts.changed" && e.project === main), "scripts.changed");
            // Defined in the worktree, listed in the main checkout too.
            expect((await b.call("scripts.list", { cwd: main })).scripts).toEqual([dev]);
            const test = await b.call<ProjectScript>("scripts.save", { cwd: main, name: "test", command: "bun test" });
            const edited = await a.call<ProjectScript>("scripts.save", { cwd: main, id: dev.id, name: "dev", command: "bun run dev --hot", icon: null });
            expect(edited).toEqual({ id: dev.id, name: "dev", command: "bun run dev --hot" });
            expect((await a.call("scripts.reorder", { cwd: linked, ids: [test.id, dev.id] })).scripts.map((s: ProjectScript) => s.name)).toEqual(["test", "dev"]);
            expect(await a.call("scripts.delete", { cwd: main, id: test.id })).toBeNull();
            expect((await b.call("scripts.list", { cwd: linked })).scripts).toEqual([edited]);
            // Deleted in one window, edited in the other.
            await expect(b.call("scripts.save", { cwd: main, id: test.id, name: "test", command: "x" })).rejects.toThrow("no longer exists");
        } finally { a.close(); b.close(); }
    });

    test("bad input is rejected with a message the GUI can show", async () => {
        const c = await client();
        try {
            const dir = project();
            await c.call("scripts.save", { cwd: dir, name: "Lint", command: "eslint ." });
            await expect(c.call("scripts.save", { cwd: dir, name: "lint", command: "x" })).rejects.toThrow(/already has a script named “Lint”/);
            await expect(c.call("scripts.save", { cwd: dir, name: "", command: "x" })).rejects.toThrow(/Give the script a name/);
            await expect(c.call("scripts.save", { cwd: dir, name: "two", command: "echo a\necho b" })).rejects.toThrow(/single line/);
            await expect(c.call("scripts.save", { cwd: dir, name: "esc", command: "echo \u001b[2J" })).rejects.toThrow(/control characters/);
            await expect(c.call("scripts.save", { cwd: dir, name: "long", command: "x".repeat(5000) })).rejects.toThrow(/at most 2000/);
            await expect(c.call("scripts.save", { cwd: dir, name: "icon", command: "x", icon: "rocket" })).rejects.toThrow(/Unknown script icon/);
            await expect(c.call("scripts.save", { cwd: "relative", name: "a", command: "x" })).rejects.toThrow(/absolute path/);
            await expect(c.call("scripts.list", { cwd: join(dir, "missing") })).rejects.toThrow(/no longer exists/);
            await expect(c.call("scripts.reorder", { cwd: dir, ids: [] })).rejects.toThrow(/changed in another window/);
            expect((await c.call("scripts.list", { cwd: dir })).scripts.map((s: ProjectScript) => s.name)).toEqual(["Lint"]);
        } finally { c.close(); }
    });

    test("runs the stored command visibly in a terminal in the session's folder, and leaves the shell open", async () => {
        const c = await client(); const other = await client();
        try {
            const { main, linked } = await repoWithWorktree();
            const s = await c.call<ProjectScript>("scripts.save", { cwd: main, name: "where", command: "printf '__%s__\\n' ran; pwd" });
            // Listing and saving never start anything.
            expect(c.events.some((e) => e.type.startsWith("terminal."))).toBe(false);
            const id = "script-terminal";
            const output = () => c.events.filter((e) => e.type === "terminal.data" && e.id === id).map((e) => (e as { data: string }).data).join("");
            const heard = other.events.length;
            const result = await c.call("scripts.run", { id, cwd: linked, script: s.id, cols: 90, rows: 24 });
            await c.call("terminal.arm", { id });
            expect(result).toMatchObject({ id, script: s });
            // In the worktree it was run from, not the main checkout where it was defined.
            await waitFor(() => output().includes(`__ran__\r\n${linked}\r\n`));
            expect(output()).toContain("printf '__%s__\\n' ran; pwd");
            await c.call("terminal.write", { id, data: "printf '__%s__\\n' still-open\n" });
            await waitFor(() => output().includes("__still-open__\r\n"));
            expect(c.events.some((e) => e.type === "terminal.exit" && e.id === id)).toBe(false);
            // Only the window that ran it sees its output; it's remembered as the last one run.
            expect(other.events.some((e) => e.type === "terminal.data")).toBe(false);
            await waitFor(() => other.events.slice(heard).some((e) => e.type === "scripts.changed" && e.project === main), "last-used broadcast");
            expect((await other.call("scripts.list", { cwd: main })).lastUsed).toBe(s.id);
            await c.call("terminal.close", { id });
        } finally { c.close(); other.close(); }
    }, 20_000);

    test("a script that doesn't exist, or a folder that's gone, opens no terminal", async () => {
        const c = await client();
        try {
            const dir = project();
            const s = await c.call<ProjectScript>("scripts.save", { cwd: dir, name: "x", command: "echo x" });
            await expect(c.call("scripts.run", { id: "no-script", cwd: dir, script: "missing-id", cols: 80, rows: 24 })).rejects.toThrow(/no longer exists/);
            await expect(c.call("scripts.run", { id: "no-folder", cwd: join(dir, "gone"), script: s.id, cols: 80, rows: 24 })).rejects.toThrow(/no longer exists/);
            await expect(c.call("terminal.write", { id: "no-script", data: "x" })).rejects.toThrow("not open");
            await expect(c.call("terminal.write", { id: "no-folder", data: "x" })).rejects.toThrow("not open");
        } finally { c.close(); }
    });

    test("a Ctrl+C the window held while the script was starting, sent as soon as it opens, stops it being typed", async () => {
        const c = await client();
        try {
            const dir = project();
            const s = await c.call<ProjectScript>("scripts.save", { cwd: dir, name: "never", command: "printf '__%s__\\n' typed" });
            const id = "held-ctrl-c";
            const output = () => c.events.filter((e) => e.type === "terminal.data" && e.id === id).map((e) => (e as { data: string }).data).join("");
            await c.call("scripts.run", { id, cwd: dir, script: s.id, cols: 80, rows: 24 });
            await c.call("terminal.write", { id, data: "\x03" });
            await c.call("terminal.arm", { id });
            await Bun.sleep(3400);
            await c.call("terminal.write", { id, data: "printf '__%s__\\n' mine\n" });
            await waitFor(() => output().includes("__mine__\r\n"));
            expect(output()).not.toContain("__typed__");
            await c.call("terminal.close", { id });
        } finally { c.close(); }
    }, 20_000);

    test("running a script in a project with entries this Harness can't use leaves the file as it was", async () => {
        const c = await client();
        const file = join(iso.home, "scripts.json");
        const saved = existsSync(file) ? readFileSync(file, "utf-8") : undefined;
        try {
            const dir = realpathSync(project());
            const text = JSON.stringify({ version: 1, projects: { [dir]: { scripts: [{ id: "good", name: "good", command: "printf '__%s__\\n' good" }, { id: "odd", name: "odd", command: "echo", icon: "rocket", future: true }] } } }, null, 2);
            writeFileSync(file, text);
            expect((await c.call("scripts.list", { cwd: dir })).scripts.map((x: ProjectScript) => x.id)).toEqual(["good"]);
            const id = "kept-run";
            await c.call("scripts.run", { id, cwd: dir, script: "good", cols: 80, rows: 24 });
            await c.call("terminal.arm", { id });
            await waitFor(() => c.events.some((e) => e.type === "terminal.data" && e.id === id && e.data.includes("__good__")));
            // Remembering it as the last one run is skipped rather than rewriting what it didn't understand.
            await Bun.sleep(200);
            expect(readFileSync(file, "utf-8")).toBe(text);
            await c.call("terminal.close", { id });
        } finally {
            if (saved === undefined) rmSync(file, { force: true }); else writeFileSync(file, saved);
            c.close();
        }
    }, 20_000);

    test("respects the terminal limit with a clear message", async () => {
        const c = await client();
        const ids = Array.from({ length: 12 }, (_, i) => `limit-${i}`);
        try {
            const dir = project();
            const s = await c.call<ProjectScript>("scripts.save", { cwd: dir, name: "x", command: "true" });
            for (const id of ids) await c.call("terminal.open", { id, cwd: dir, cols: 80, rows: 24 });
            await expect(c.call("scripts.run", { id: "one-too-many", cwd: dir, script: s.id, cols: 80, rows: 24 })).rejects.toThrow(/Close a terminal before opening another/);
        } finally {
            for (const id of ids) await c.call("terminal.close", { id }).catch(() => {});
            c.close();
        }
    }, 20_000);
});

describe("CLI accounts over RPC", () => {
    test("add, unsigned status, rename, defaults, busy switch and confined removal", async () => {
        const { saveAgentConfig } = await import("../src/providers/registry");
        saveAgentConfig("claude-code", { path: fakeClaude() });
        saveAgentConfig("codex", { path: fakeCodex() });
        process.env.FAKE_LOGGED_IN = "0";
        process.env.FAKE_ACCOUNT = "none";
        const c = await client();
        try {
            for (const provider of ["claude-code", "codex"]) {
                const a = await c.call("accounts.add", { provider, id: "rpc-personal", name: "Personal" });
                expect(existsSync(a.folder)).toBe(true);
                const listed = await c.call<any[]>("accounts.list", { provider, refresh: true });
                expect(listed.find((v) => v.id === a.id)).toMatchObject({ signedIn: false, description: "not signed in", folder: a.folder });
                const log = join(tempDir("account-login-log-"), "starts.jsonl");
                process.env.FAKE_LOG = log;
                const terminalId = `login-${provider}`;
                await c.call("terminal.open", { id: terminalId, cwd: "/ignored", cols: 80, rows: 24, login: { provider, accountId: a.id, env: { CODEX_HOME: "/client-must-not-control-this" } } });
                const deadline = Date.now() + 5000;
                while (!c.events.some((e) => e.type === "terminal.exit" && e.id === terminalId)) {
                    if (Date.now() > deadline) throw new Error("Login fixture did not exit");
                    await Bun.sleep(10);
                }
                const starts = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((v) => v.argv);
                const login = starts.find((v) => v.argv.includes("login"));
                expect(login.argv).toEqual(provider === "codex" ? ["login"] : ["auth", "login"]);
                expect(login[provider === "codex" ? "codexHome" : "claudeConfigDir"]).toBe(a.folder);
                expect(login[provider === "codex" ? "claudeConfigDir" : "codexHome"]).toBeUndefined();
                delete process.env.FAKE_LOG;
                await c.call("accounts.rename", { provider, id: a.id, name: "Work" });
                expect((await c.call<any[]>("accounts.list", { provider })).find((v) => v.id === a.id).name).toBe("Work");
                await c.call("accounts.setDefault", { provider, id: a.id });
                const session = await c.open("session.create", { cwd: project() });
                expect(c.view(session).state.accounts?.[provider]).toBe(a.id);
                await c.call("session.setAccount", { id: session, provider, accountId: "default" });
                await c.until(session, (v) => v.state.accounts?.[provider] === "default");
                await expect(c.call("accounts.remove", { provider, id: a.id, confirmedFolder: "wrong" })).rejects.toMatchObject({ code: "invalid" });
                await c.call("accounts.remove", { provider, id: a.id, confirmedFolder: a.folder });
                expect(existsSync(a.folder)).toBe(false);
                await expect(c.call("accounts.remove", { provider, id: "default", confirmedFolder: "/" })).rejects.toMatchObject({ code: "invalid" });
                await expect(c.call("accounts.add", { provider, id: "../bad", name: "Bad" })).rejects.toMatchObject({ code: "invalid" });
                await expect(c.call("accounts.add", { provider, id: "badfolder", name: "Bad", folder: "/tmp/../bad" })).rejects.toMatchObject({ code: "invalid" });
            }
            const id = await c.open("session.create", { cwd: project() });
            await c.call("session.send", { id, text: "demo" });
            await c.until(id, (v) => v.state.interactions.length > 0);
            await expect(c.call("session.setAccount", { id, provider: "codex", accountId: "default" })).rejects.toMatchObject({ code: "busy" });
            await c.call("session.interrupt", { id });
        } finally {
            delete process.env.FAKE_LOGGED_IN;
            delete process.env.FAKE_ACCOUNT;
            delete process.env.FAKE_LOG;
            c.close();
        }
    }, 30_000);
});
describe("notes to the model on what changed", () => {
    async function freshSession() {
        const { Engine } = await import("../src/server/engine");
        const engine = new Engine({});
        const c = { subs: new Set<string>(), send() {} };
        engine.clients.add(c);
        const snap = (await engine.handle(c, "session.create", { cwd: project() })) as SessionSnapshot;
        const id = snap.state.id;
        const rt = engine.runtimes.get(id)!;
        // The mock model, whatever earlier tests left as the default.
        await engine.handle(c, "session.setModel", { id, ref: "mock:mock-opus", persist: false });
        /** The prompt as the model got it: its text and the notes that went with it. */
        const send = async (text: string) => {
            await engine.handle(c, "session.send", { id, text });
            const sent = () => rt.session.messages.find((m) => m.role === "user" && m.meta?.kind === "prompt" && m.meta.display === text);
            for (let i = 0; i < 200 && !(sent() && rt.idle); i++) await Bun.sleep(50);
            expect(rt.idle).toBe(true);
            return sent()!.content.flatMap((p) => (p.type === "text" ? [p.text] : []));
        };
        return { engine, c, id, rt, send };
    }

    test("a model and mode picked before the first prompt are where the session starts: no switch to tell of then, only after", async () => {
        const { engine, c, id, send } = await freshSession();
        try {
            await engine.handle(c, "session.setModel", { id, ref: "mock:mock-haiku", persist: false });
            await engine.handle(c, "session.setMode", { id, mode: "acceptEdits" });
            expect(await send("first prompt")).toEqual(["first prompt"]);
            // Once the conversation is going, a switch is news.
            await engine.handle(c, "session.setModel", { id, ref: "mock:mock-opus", persist: false });
            await engine.handle(c, "session.setMode", { id, mode: "default" });
            const second = (await send("second prompt")).join("\n");
            expect(second).toContain("The user switched the model to");
            expect(second).toContain("The user switched the permission mode to");
        } finally {
            await engine.stop();
        }
    });

    test("plan mode picked before the first prompt is still said: the model has to know it may only plan", async () => {
        const { engine, c, id, send } = await freshSession();
        try {
            await engine.handle(c, "session.setMode", { id, mode: "plan" });
            // Picked again (the GUI lets you), it's still said.
            await engine.handle(c, "session.setMode", { id, mode: "plan" });
            expect((await send("first prompt")).join("\n")).toContain("Plan mode is now active.");
        } finally {
            await engine.stop();
        }
    });

    test("plan mode picked and left again before the first prompt leaves nothing to tell, whatever the mode is next", async () => {
        const { engine, c, id, send } = await freshSession();
        try {
            // Back to where it was, then straight from plan mode to another.
            for (const mode of ["plan", "default", "plan", "acceptEdits"]) await engine.handle(c, "session.setMode", { id, mode });
            expect(await send("first prompt")).toEqual(["first prompt"]);
        } finally {
            await engine.stop();
        }
    });

    test("after a rewind to the first prompt, a switch before resending takes back what the rewind queued: it starts afresh", async () => {
        const { engine, c, id, rt, send } = await freshSession();
        try {
            await send("first prompt");
            await engine.handle(c, "session.setModel", { id, ref: "mock:mock-haiku", persist: false });
            const plan = (await engine.handle(c, "session.rewindPlan", { id, index: 0 })) as { planId: string };
            await engine.handle(c, "session.rewind", { id, index: 0, planId: plan.planId, code: false, conversation: true });
            expect(rt.session.messages).toEqual([]);
            await engine.handle(c, "session.setModel", { id, ref: "mock:mock-sonnet", persist: false });
            await engine.handle(c, "session.setMode", { id, mode: "acceptEdits" });
            expect(await send("again")).toEqual(["again"]);
        } finally {
            await engine.stop();
        }
    });
});

describe("a sub-agent's own sub-agents", () => {
    test("a rewind that keeps a sub-agent keeps its own sub-agent with it", async () => {
        const { Engine } = await import("../src/server/engine");
        const engine = new Engine({});
        const c = { subs: new Set<string>(), send() {} };
        engine.clients.add(c);
        try {
            const snap = (await engine.handle(c, "session.create", { cwd: project() })) as SessionSnapshot;
            const id = snap.state.id;
            const rt = engine.runtimes.get(id)!;
            await engine.handle(c, "session.setModel", { id, ref: "mock:mock-opus", persist: false });
            const idle = async () => {
                for (let i = 0; i < 200 && !(rt.idle && !rt.busy); i++) await Bun.sleep(50);
                expect(rt.idle).toBe(true);
            };
            await engine.handle(c, "session.send", { id, text: "Use agents to review the auth module and its tests" });
            for (let i = 0; i < 200 && rt.snapshot().agents.length < 2; i++) await Bun.sleep(50);
            await idle();
            const auth = rt.snapshot().agents.find((a) => a.description === "Map the auth module")!;
            // As a sub-agent on Codex shows its own: a Task in its activity, then what that one does.
            const emit = (e: AgentEvent) => rt.agent!.options.host.emit({ type: "subagent", parentId: auth.id, label: "Map the auth module", event: e });
            emit({ type: "tool_start", call: { type: "tool_call", id: "inner-1", name: "Task", input: { description: "Check the tests", prompt: "" } }, title: "Task(Check the tests)" });
            const inner = (e: AgentEvent) => emit({ type: "subagent", parentId: "inner-1", label: "Check the tests", event: e });
            inner({ type: "text", text: "Two tests." });
            inner({ type: "turn_end", reason: "done" });
            expect(rt.snapshot().agents.map((a) => [a.description, a.parentId])).toContainEqual(["Check the tests", auth.id]);
            await engine.handle(c, "session.send", { id, text: "and now?" });
            for (let i = 0; i < 200 && rt.snapshot().turns.filter((t) => t.prompt).length < 2; i++) await Bun.sleep(50);
            await idle();
            const targets = (await engine.handle(c, "session.rewindTargets", { id })) as { index: number; text: string }[];
            expect(targets[0]!.text).toBe("and now?");
            const plan = (await engine.handle(c, "session.rewindPlan", { id, index: targets[0]!.index })) as { planId: string };
            await engine.handle(c, "session.rewind", { id, index: targets[0]!.index, planId: plan.planId, code: false, conversation: true });
            const v = rt.snapshot();
            const kept = v.agents.find((a) => a.id === auth.id)!;
            const sub = v.agents.find((a) => a.id === "inner-1");
            // Still under it, in its turn (with that turn's new id), with what it did.
            expect([sub?.parentId, sub?.turnId, sub?.status, sub?.report]).toEqual([auth.id, kept.turnId, "done", "Two tests."]);
            expect(v.turns.some((t) => t.id === kept.turnId)).toBe(true);
        } finally {
            await engine.stop();
        }
    }, 30_000);
});

describe("a project's MCP servers (.mcp.json approval)", () => {
    const FIXTURE = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");
    /** The fixture MCP server; it leaves its pid in `marker` the moment it starts. */
    const fx = (marker: string, env: Record<string, string> = {}) => ({ command: process.execPath, args: ["--no-env-file", FIXTURE], env: { MCP_FIXTURE_ERA: "legacy", MCP_FIXTURE_MARKER: marker, ...env } });
    const writeMcp = (dir: string, servers: Record<string, unknown>) => writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
    const srvOf = (v: { state: SessionState }, name = "srv"): McpStatus | undefined => v.state.mcp.find((m) => m.name === name);
    const starts = (marker: string) => (existsSync(marker) ? readFileSync(marker, "utf-8").trim().split("\n").length : 0);
    const alive = (pid: number) => {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    };
    const until = async (cond: () => boolean, ms = 5000) => {
        for (const end = Date.now() + ms; Date.now() < end && !cond(); ) await Bun.sleep(25);
        return cond();
    };

    async function mcpProject(servers: (dir: string) => Record<string, unknown>, trust = true) {
        const dir = project();
        writeMcp(dir, servers(dir));
        const c = await client();
        await c.call("projects.trust", { path: dir, trust });
        const id = await c.open("session.create", { cwd: dir });
        return { dir, c, id, marker: join(dir, "started") };
    }

    test("the card shows what will run; approving it connects live, in every session of the folder", async () => {
        const { dir, c, id, marker } = await mcpProject((d) => ({ srv: fx(join(d, "started")) }));
        await c.until(id, (v) => srvOf(v)?.status === "needs-approval");
        const c2 = await client();
        const id2 = await c2.open("session.create", { cwd: dir });

        const list = await c.call<McpListInfo>("session.mcp", { id });
        expect(list.trusted).toBe(true);
        expect(list.savedIn).toBe(join(dir, ".harness", "settings.local.json"));
        expect(list.meaning).toContain("Harness's own models");
        const card = list.servers.find((s) => s.name === "srv")!;
        expect(card).toMatchObject({ source: "project", status: "needs-approval", transport: "stdio", command: process.execPath, args: ["--no-env-file", FIXTURE], cwd: realpathSync(dir), envNames: ["MCP_FIXTURE_ERA", "MCP_FIXTURE_MARKER"], declaredIn: join(dir, ".mcp.json"), approval: { state: "needs-approval", reason: "new" } });

        // A fingerprint that isn't what the card showed approves nothing, and says what would run now.
        const stale = await c.call<{ approved: boolean; list: McpListInfo }>("session.mcpApprove", { id, name: "srv", fingerprint: "v1:" + "0".repeat(64) });
        expect(stale.approved).toBe(false);
        expect(stale.list.servers[0]!.fingerprint).toBe(card.fingerprint);
        await expect(c.call("session.mcpApprove", { id, name: "nope", fingerprint: card.fingerprint })).rejects.toMatchObject({ code: "unknown" });
        await Bun.sleep(300);
        expect(existsSync(marker)).toBe(false);

        const r = await c.call<{ approved: boolean }>("session.mcpApprove", { id, name: "srv", fingerprint: card.fingerprint });
        expect(r.approved).toBe(true);
        await c.until(id, (v) => srvOf(v)?.status === "connected" && srvOf(v)!.tools > 0);
        await c2.until(id2, (v) => srvOf(v)?.status === "connected");
        expect(srvOf(c.view(id))!.approval).toEqual({ state: "approved" });
        expect(JSON.parse(readFileSync(join(dir, ".harness", "settings.local.json"), "utf-8")).approvedMcpjsonServers.srv).toBe(card.fingerprint);
        c.close();
        c2.close();
    }, 20_000);

    test("reject keeps it off; it can be approved later through the same card", async () => {
        const { c, id, marker } = await mcpProject((d) => ({ srv: fx(join(d, "started")) }));
        await c.until(id, (v) => srvOf(v)?.status === "needs-approval");
        const after = await c.call<McpListInfo>("session.mcpReject", { id, name: "srv" });
        expect(after.servers[0]).toMatchObject({ status: "disabled", approval: { state: "rejected" } });
        await c.until(id, (v) => srvOf(v)?.approval?.state === "rejected");
        await c.call("session.mcpReconnect", { id, name: "srv" });
        await Bun.sleep(400);
        expect(existsSync(marker)).toBe(false);

        const r = await c.call<{ approved: boolean }>("session.mcpApprove", { id, name: "srv", fingerprint: after.servers[0]!.fingerprint });
        expect(r.approved).toBe(true);
        await c.until(id, (v) => srvOf(v)?.status === "connected");
        c.close();
    }, 20_000);

    test("revoke stops it (the process goes) and it asks again", async () => {
        const { c, id, marker } = await mcpProject((d) => ({ srv: fx(join(d, "started")) }));
        const card = (await c.call<McpListInfo>("session.mcp", { id, name: "srv" })).servers[0]!;
        await c.call("session.mcpApprove", { id, name: "srv", fingerprint: card.fingerprint });
        await c.until(id, (v) => srvOf(v)?.status === "connected");
        const pid = Number(readFileSync(marker, "utf-8").trim());
        expect(alive(pid)).toBe(true);
        const after = await c.call<McpListInfo>("session.mcpRevoke", { id, name: "srv" });
        expect(after.servers[0]).toMatchObject({ status: "needs-approval" });
        expect(await until(() => !alive(pid))).toBe(true);
        await c.until(id, (v) => srvOf(v)?.status === "needs-approval");
        await expect(c.call("session.mcpRevoke", { id, name: "srv" })).rejects.toMatchObject({ code: "not_needed" });
        c.close();
    }, 20_000);

    test("reconnect brings a failed server back; after its command changes, reconnecting asks again instead", async () => {
        const { dir, c, id, marker } = await mcpProject((d) => ({ srv: fx(join(d, "started"), { MCP_FIXTURE_FAIL_IF: join(d, "fail") }) }));
        writeFileSync(join(dir, "fail"), "");
        const card = (await c.call<McpListInfo>("session.mcp", { id })).servers[0]!;
        await c.call("session.mcpApprove", { id, name: "srv", fingerprint: card.fingerprint });
        await c.until(id, (v) => srvOf(v)?.status === "failed");
        const failedError = (await c.call<McpListInfo>("session.mcp", { id })).servers[0]!.error!;
        expect(failedError).toContain("fixture told to fail");
        // Line breaks stay line breaks in an error (commands and args show them as ⟨U+000A⟩).
        expect(failedError).toContain("\n");
        expect(failedError).not.toContain("⟨U+000A⟩");

        rmSync(join(dir, "fail"));
        await c.call("session.mcpReconnect", { id, name: "srv" });
        await c.until(id, (v) => srvOf(v)?.status === "connected");
        const pid = Number(readFileSync(marker, "utf-8").trim().split("\n").pop());

        const ran = starts(marker);
        const changed = fx(marker, { MCP_FIXTURE_FAIL_IF: join(dir, "fail") });
        writeMcp(dir, { srv: { ...changed, args: [...changed.args, "--changed"] } });
        const after = await c.call<McpListInfo>("session.mcpReconnect", { id, name: "srv" });
        expect(after.servers[0]).toMatchObject({ status: "needs-approval", approval: { state: "needs-approval", reason: "changed" } });
        expect(after.servers[0]!.why).toContain("changed since you approved it");
        await c.until(id, (v) => srvOf(v)?.approval?.reason === "changed");
        expect(await until(() => !alive(pid))).toBe(true);
        await Bun.sleep(300);
        expect(starts(marker)).toBe(ran);

        // A new session in the folder sees the same.
        const c2 = await client();
        const id2 = await c2.open("session.create", { cwd: dir });
        expect(srvOf(c2.view(id2))?.status).toBe("needs-approval");
        c.close();
        c2.close();
    }, 20_000);

    test("a folder trusted only for having had nothing to protect: approving asks for the user's trust first", async () => {
        // Nothing to protect when the session opens, so it's trusted for this run only.
        const dir = project();
        const c = await client();
        const id = await c.open("session.create", { cwd: dir });
        expect(c.view(id).state.trusted).toBe(true);
        const marker = join(dir, "started");
        writeMcp(dir, { srv: fx(marker) });

        const list = await c.call<McpListInfo>("session.mcp", { id });
        expect(list.trusted).toBe(true);
        expect(list.userTrusted).toBe(false);
        const card = list.servers.find((s) => s.name === "srv")!;
        expect(card.status).toBe("needs-approval");
        await expect(c.call("session.mcpApprove", { id, name: "srv", fingerprint: card.fingerprint })).rejects.toMatchObject({ code: "needs_trust" });
        await c.call("session.mcpReconnect", { id, name: "srv" });
        await Bun.sleep(400);
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(join(dir, ".harness", "settings.local.json"))).toBe(false);

        // The existing trust flow works for a workspace already trusted in that weaker sense.
        await c.call("projects.trust", { path: dir, trust: true });
        const after = await c.call<McpListInfo>("session.mcp", { id });
        expect(after.userTrusted).toBe(true);
        const r = await c.call<{ approved: boolean }>("session.mcpApprove", { id, name: "srv", fingerprint: after.servers.find((s) => s.name === "srv")!.fingerprint });
        expect(r.approved).toBe(true);
        await c.until(id, (v) => srvOf(v)?.status === "connected");
        c.close();
    }, 20_000);

    test("an untrusted folder: nothing from .mcp.json is read, starts, or can be approved", async () => {
        const { c, id, marker } = await mcpProject((d) => ({ srv: fx(join(d, "started")) }), false);
        expect(c.view(id).state.trusted).toBe(false);
        expect(srvOf(c.view(id))).toBeUndefined();
        const list = await c.call<McpListInfo>("session.mcp", { id });
        expect(list.trusted).toBe(false);
        expect(list.servers.find((s) => s.name === "srv")).toBeUndefined();
        const fp = "v1:" + "0".repeat(64);
        await expect(c.call("session.mcpApprove", { id, name: "srv", fingerprint: fp })).rejects.toMatchObject({ code: "untrusted" });
        await expect(c.call("session.mcpReject", { id, name: "srv" })).rejects.toMatchObject({ code: "untrusted" });
        await expect(c.call("session.mcpRevoke", { id, name: "srv" })).rejects.toMatchObject({ code: "untrusted" });
        await expect(c.call("session.mcpReconnect", { id, name: "srv" })).rejects.toMatchObject({ code: "unknown" });
        await Bun.sleep(400);
        expect(existsSync(marker)).toBe(false);
        c.close();
    }, 20_000);

    test("an env value never reaches the client: not in results, events or state, nor anything saved", async () => {
        const SENTINEL = "sentinel-env-value-" + Math.random().toString(36).slice(2);
        const { dir, c, id } = await mcpProject((d) => {
            const base = fx(join(d, "started"), { SENTINEL_TOKEN: SENTINEL, MCP_FIXTURE_STDERR_ENV: "SENTINEL_TOKEN", MCP_FIXTURE_FAIL_IF: join(d, ".mcp.json") });
            return { srv: { ...base, args: [...base.args, `--token=${SENTINEL}`] } };
        });
        const list = await c.call<McpListInfo>("session.mcp", { id });
        expect(list.servers[0]!.masked).toBe(true);
        expect(list.servers[0]!.envNames).toContain("SENTINEL_TOKEN");
        await c.call("session.mcpApprove", { id, name: "srv", fingerprint: list.servers[0]!.fingerprint });
        // It prints the value to stderr and exits: the error shown is masked.
        await c.until(id, (v) => srvOf(v)?.status === "failed");
        const failed = (await c.call<McpListInfo>("session.mcp", { id, name: "srv" })).servers[0]!;
        expect(failed.error).toContain("[REDACTED env SENTINEL_TOKEN]");
        await c.call("session.mcpReconnect", { id, name: "srv" });
        await c.until(id, (v) => srvOf(v)?.status === "failed");
        expect(c.view(id).state.model?.provider).toBe("mock");
        await c.call("session.send", { id, text: "explain the layout" });
        await c.until(id, done);
        await c.call("session.mcpRevoke", { id, name: "srv" });
        await c.call("session.mcpReject", { id, name: "srv" });

        expect(c.raw.length).toBeGreaterThan(5);
        for (const m of c.raw) expect(m).not.toContain(SENTINEL);
        // Nor the local settings (only a keyed hash), the session's transcript, or anything else in the harness home.
        const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
        for (const f of [...files(join(dir, ".harness")), ...files(iso.home)]) expect(readFileSync(f, "utf-8")).not.toContain(SENTINEL);
        c.close();
    }, 30_000);
});
