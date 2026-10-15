// The GUI server end to end: a real server and WebSocket, the mock model
// (scripts/mock-llm.ts) streaming through the real provider client, and real
// tools working in a temp project.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { startServer } = await import("../src/server/server");
const { applyOp } = await import("../src/server/timeline");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
import type { AgentRun, Block, InteractionResponse, ServerEvent, SessionSnapshot, SessionState, ToolBlock, Turn } from "../src/server/protocol";

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
    private listeners = new Set<() => void>();

    constructor(token = TOKEN, headers: Record<string, string> = {}, port = srv.port) {
        this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { protocols: ["harness.v1", `auth.${token}`], headers } as any);
        this.ws.onmessage = (m) => {
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

    async open(method: "session.create" | "session.open", params: Record<string, unknown>): Promise<string> {
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

    /** Answer the next request the session makes (ops arrive a moment after replies, so skip ones already answered). */
    async answer(id: string, response: InteractionResponse) {
        const fresh = (v: { state: SessionState }) => v.state.interactions.find((i) => !this.answered.has(i.id));
        await this.until(id, (v) => Boolean(fresh(v)));
        const it = fresh(this.view(id))!;
        this.answered.add(it.id);
        expect(it.kind).toBe(response.kind);
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
    async function engineWithSession(o: { unloadAfterMs?: number } = {}) {
        const { Engine } = await import("../src/server/engine");
        const engine = new Engine(o);
        const c = { subs: new Set<string>(), send() {} };
        engine.clients.add(c);
        const cwd = project();
        const snap = (await engine.handle(c, "session.create", { cwd })) as SessionSnapshot;
        return { engine, c, cwd, id: snap.state.id, rt: engine.runtimes.get(snap.state.id)! };
    }

    async function whenIdle(rt: { idle: boolean }) {
        for (let i = 0; i < 200 && !rt.idle; i++) await Bun.sleep(50);
        expect(rt.idle).toBe(true);
    }

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
            await c.call("session.setModel", { id, ref: "claude-code:default" });
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
            await c.call("session.setModel", { id, ref: "claude-code:default" });
            await c.call("session.send", { id, text: "get a note written" });
            // Its Write asks (Manual mode), naming it, and it shows as waiting, after the turn is over.
            await c.until(id, (v) => done(v) && v.state.interactions.length > 0 && v.agents[0]?.status === "waiting", 20_000);
            await Bun.sleep(200);
            const v = c.view(id);
            expect(v.state.status).toBe("waiting");
            const ask = v.state.interactions[0]!;
            expect(ask.kind === "permission" && [ask.toolName, ask.agentLabel, ask.agentId]).toEqual(["Write", "Write a note (mock:mock-haiku)", v.agents[0]!.id]);
            expect(v.agents[0]!.activity).toBe("Waiting for approval");

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
