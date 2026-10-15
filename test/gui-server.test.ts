// The GUI server end to end: a real server and WebSocket, the mock model
// (scripts/mock-llm.ts) streaming through the real provider client, and real
// tools working in a temp project.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { startServer } = await import("../src/server/server");
const { applyOp } = await import("../src/server/timeline");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
import type { Block, InteractionResponse, ServerEvent, SessionSnapshot, SessionState, ToolBlock, Turn } from "../src/server/protocol";

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
    srv = await startServer({ token: TOKEN });
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
    views = new Map<string, { state: SessionState; turns: Turn[]; seq: number }>();
    events: ServerEvent[] = [];
    private listeners = new Set<() => void>();

    constructor(token = TOKEN, headers: Record<string, string> = {}) {
        this.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["harness.v1", `auth.${token}`], headers } as any);
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
        this.views.set(snap.state.id, { state: snap.state, turns: snap.turns, seq: snap.seq });
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
        const r = await c.call("session.rewind", { id, index: targets[0].index, code: true, conversation: true });
        expect(r.text).toBe("demo");
        expect(existsSync(join(dir, "src/auth/sso.ts"))).toBe(false);
        expect(readFileSync(join(dir, "src/auth/index.ts"), "utf-8")).toBe(before);
        await c.until(id, (v) => v.turns.filter((t) => t.prompt).length === 1);
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
