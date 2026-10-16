// A GUI session on the mock model asks for a secret (RequestSecret) and uses
// it. The value must reach the shell and nothing else: not the model, not
// any window, not the session's files, not the server's log.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { startServer } = await import("../src/server/server");
const { applyOp } = await import("../src/server/timeline");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
import type { Block, InteractionResponse, SecretInteraction, ServerEvent, SessionSnapshot, SessionState, ToolBlock, Turn } from "../src/server/protocol";

const TOKEN = "test-token-secrets-0123456789";
const mock = startMockLlm({ delayMs: 0 });
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));

const logs: string[] = [];
let srv: Awaited<ReturnType<typeof startServer>>;
const projects: string[] = [];
const project = () => {
    const dir = createDemoProject(realpathSync(tempDir("harness-gui-secret-")), { git: false });
    projects.push(dir);
    return dir;
};

beforeAll(async () => {
    srv = await startServer({ token: TOKEN, unloadAfterMs: 300, log: (m) => logs.push(m) });
});
afterAll(async () => {
    await srv.stop();
    mock.stop();
    iso.cleanup();
});

/** A window: its requests, every frame it received, and each open session's view. */
class Client {
    ws: WebSocket;
    frames: string[] = [];
    private next = 1;
    private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    views = new Map<string, { state: SessionState; turns: Turn[]; agents: any[]; seq: number }>();
    events: ServerEvent[] = [];
    private listeners = new Set<() => void>();

    constructor() {
        this.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["harness.v1", `auth.${TOKEN}`] } as any);
        this.ws.onmessage = (m) => {
            this.frames.push(String(m.data));
            const msg = JSON.parse(String(m.data));
            if ("event" in msg) {
                const ev = msg.event as ServerEvent;
                this.events.push(ev);
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
            if (msg.error) w?.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
            else w?.resolve(msg.result);
        };
    }
    opened() {
        return new Promise<void>((resolve, reject) => {
            this.ws.onopen = () => resolve();
            this.ws.onerror = () => reject(new Error("connection failed"));
        });
    }
    call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        const id = this.next++;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    }
    async open(method: "session.create" | "session.open", params: Record<string, unknown>) {
        const snap = await this.call<SessionSnapshot>(method, params);
        this.views.set(snap.state.id, { state: snap.state, turns: snap.turns, agents: snap.agents, seq: snap.seq });
        return snap.state.id;
    }
    view(id: string) {
        return this.views.get(id)!;
    }
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
                reject(new Error(`timed out; status ${this.views.get(id)?.state.status}`));
            }, ms);
            this.listeners.add(check);
            check();
        });
    }
    async secretAsk(id: string): Promise<SecretInteraction> {
        await this.until(id, (v) => v.state.interactions.some((i) => i.kind === "secret"));
        return this.view(id).state.interactions.find((i) => i.kind === "secret") as SecretInteraction;
    }
    close() {
        this.ws.close();
    }
}

async function client() {
    const c = new Client();
    await c.opened();
    return c;
}

const lastTurn = (v: { turns: Turn[] }) => v.turns[v.turns.length - 1]!;
const done = (v: { state: SessionState; turns: Turn[] }) => !v.state.busy && v.turns.length > 0 && lastTurn(v).status !== "running";
const tools = (t: Turn) => t.blocks.filter((b): b is ToolBlock => b.t === "tool");
const texts = (t: Turn) => t.blocks.filter((b): b is Extract<Block, { t: "text" }> => b.t === "text").map((b) => b.text).join("\n");
const cksum = (v: string) => Bun.spawnSync(["sh", "-c", 'printf %s "$1" | cksum | awk \'{print $1, $2}\'', "sh", v]).stdout.toString().trim();
const respond = (c: Client, id: string, interactionId: string, response: InteractionResponse | Record<string, unknown> | null) => c.call("session.respond", { id, interactionId, response });

/** Every file under `dir`, read as text. */
function filesUnder(dir: string): { path: string; text: string }[] {
    const out: { path: string; text: string }[] = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) out.push(...filesUnder(p));
        else if (st.isFile()) out.push({ path: p, text: readFileSync(p, "latin1") });
    }
    return out;
}

describe("asking for a secret in a GUI session", () => {
    test("provided: the shell gets it, everything else sees only its name", async () => {
        const VALUE = "test-secret-123-abc";
        const a = await client();
        const b = await client();
        const id = await a.open("session.create", { cwd: project() });
        await b.open("session.open", { id });
        const before = mock.requests.length;
        await a.call("session.send", { id, text: `use a secret, checksum ${cksum(VALUE)}` });

        const ask = await a.secretAsk(id);
        expect(ask).toMatchObject({ kind: "secret", name: "DEMO_TOKEN", purpose: "To call the demo API with curl." });
        await b.until(id, (v) => v.state.interactions.some((i) => i.id === ask.id));
        expect(a.view(id).state.status).toBe("waiting");
        const asking = tools(lastTurn(a.view(id))).find((t) => t.name === "RequestSecret")!;
        expect(asking.status).toBe("awaiting");
        const note = a.events.find((e) => e.type === "notify" && e.sessionId === id);
        expect(note).toMatchObject({ kind: "question", body: "Asks you for DEMO_TOKEN" });

        await respond(a, id, ask.id, { kind: "secret", value: VALUE });
        // The permission card shows the command as written: the variable, not its value.
        await a.until(id, (v) => v.state.interactions.some((i) => i.kind === "permission"));
        const perm = a.view(id).state.interactions.find((i) => i.kind === "permission")!;
        expect(perm.kind === "permission" && perm.command).toContain('echo "echo: $DEMO_TOKEN"');
        await respond(a, id, perm.id, { kind: "permission", choice: "yes" });
        await a.until(id, done);
        await b.until(id, (v) => v.state.interactions.length === 0 && v.state.secrets.includes("DEMO_TOKEN"));

        const turn = lastTurn(a.view(id));
        const [req, sh] = tools(turn);
        expect(req!.name).toBe("RequestSecret");
        expect(req!.status).toBe("ok");
        expect(sh!.name).toBe("Bash");
        expect((sh as any).output).toBe("echo: [REDACTED DEMO_TOKEN]\nDEMO_TOKEN=[REDACTED DEMO_TOKEN]\nSET\nMATCH");
        expect(texts(turn)).toContain("echo: [REDACTED DEMO_TOKEN]");
        expect(a.view(id).state.secrets).toEqual(["DEMO_TOKEN"]);

        // What the model got: the handle, then the redacted output.
        const bodies = mock.requests.slice(before).map((r) => r.body);
        expect(bodies.some((x) => x.includes("The user provided DEMO_TOKEN."))).toBe(true);
        expect(bodies.some((x) => x.includes("echo: [REDACTED DEMO_TOKEN]"))).toBe(true);

        // And nowhere is the value: model requests, frames to either window, the server log, any file Harness wrote.
        await Bun.sleep(100);
        for (const x of bodies) expect(x).not.toContain(VALUE);
        for (const c of [a, b]) for (const f of c.frames) expect(f).not.toContain(VALUE);
        for (const l of logs) expect(l).not.toContain(VALUE);
        const files = filesUnder(iso.home);
        expect(files.some((f) => f.path.endsWith(".jsonl"))).toBe(true);
        for (const f of files) expect({ path: f.path, leaks: f.text.includes(VALUE) }).toEqual({ path: f.path, leaks: false });
        for (const f of filesUnder(projects.at(-1)!)) expect(f.text.includes(VALUE)).toBe(false);

        // Exports carry the transcript as shown.
        const md = await a.call<{ markdown: string }>("session.export", { id });
        expect(md.markdown).toContain("[REDACTED DEMO_TOKEN]");
        expect(md.markdown).not.toContain(VALUE);

        // Forget: gone from the state in every window; an unknown name is a client error.
        await a.call("session.forgetSecret", { id, name: "DEMO_TOKEN" });
        await b.until(id, (v) => v.state.secrets.length === 0);
        await expect(a.call("session.forgetSecret", { id, name: "DEMO_TOKEN" })).rejects.toThrow(/doesn't hold a secret/);
        await expect(a.call("session.forgetSecret", { id, name: 42 })).rejects.toThrow(/name must be a string/);
        a.close();
        b.close();
    }, 30_000);

    test("declined: a clear result for the model, and the card goes away in every window", async () => {
        const a = await client();
        const b = await client();
        const id = await a.open("session.create", { cwd: project() });
        await b.open("session.open", { id });
        const before = mock.requests.length;
        await a.call("session.send", { id, text: "use a secret" });
        const ask = await a.secretAsk(id);
        await b.until(id, (v) => v.state.interactions.length === 1);
        await respond(b, id, ask.id, { kind: "secret" });
        await a.until(id, done);
        await a.until(id, (v) => v.state.interactions.length === 0);
        await b.until(id, (v) => v.state.interactions.length === 0);
        expect(texts(lastTurn(a.view(id)))).toContain("carry on without it");
        expect(a.view(id).state.secrets).toEqual([]);
        const bodies = mock.requests.slice(before).map((r) => r.body).join("\n");
        expect(bodies).toContain("The user didn't provide DEMO_TOKEN. Nothing was stored. Don't ask for it again unless the user brings it up.");
        a.close();
        b.close();
    }, 30_000);

    test("an interrupt withdraws the card and stores nothing", async () => {
        const a = await client();
        const id = await a.open("session.create", { cwd: project() });
        await a.call("session.send", { id, text: "use a secret" });
        const ask = await a.secretAsk(id);
        await a.call("session.interrupt", { id });
        await a.until(id, (v) => done(v) && v.state.interactions.length === 0);
        expect(a.view(id).state.secrets).toEqual([]);
        await expect(respond(a, id, ask.id, { kind: "secret", value: "test-secret-late-1" })).rejects.toThrow(/already answered or has expired/);
        expect(a.view(id).state.secrets).toEqual([]);
        a.close();
    }, 30_000);

    test("a malformed answer is a client error that never quotes the value, and the card stays", async () => {
        const a = await client();
        const id = await a.open("session.create", { cwd: project() });
        await a.call("session.send", { id, text: "use a secret" });
        const ask = await a.secretAsk(id);
        const bad: [unknown, RegExp][] = [
            ["abc1234", /too short/],
            [`test-secret-nul\0abc`, /NUL/],
            [`test-secret-line\nabc`, /line breaks/],
            ["x".repeat(8 * 1024 + 1), /KiB/],
            [12345678, /must be text/],
        ];
        for (const [value, re] of bad) {
            const err = await respond(a, id, ask.id, { kind: "secret", value }).then(
                () => undefined,
                (e) => e,
            );
            expect(err?.message).toMatch(re);
            expect(err?.code).toBe("bad_secret");
            if (typeof value === "string") expect(err.message).not.toContain(value);
        }
        await expect(respond(a, id, ask.id, null)).rejects.toThrow(/response must be an object/);
        await expect(respond(a, id, ask.id, { kind: "question", answers: ["x"] })).rejects.toThrow(/doesn't match/);
        expect(a.view(id).state.interactions.map((i) => i.id)).toEqual([ask.id]);
        // None of those were server errors worth a log line.
        for (const l of logs) expect(l).not.toContain("error in session.respond");
        await respond(a, id, ask.id, { kind: "secret" });
        await a.until(id, done);
        a.close();
    }, 30_000);

    test("ill-formed Unicode and control characters return bad_secret without settling the card", async () => {
        const a = await client();
        const id = await a.open("session.create", { cwd: project() });
        try {
            await a.call("session.send", { id, text: "use a secret" });
            const ask = await a.secretAsk(id);
            for (const suffix of ["\ud800", "\udc00", "\u001b", "\u007f", "\u0085", "\u2028"]) {
                const value = `zq7Xv9Lr2Wm4Kp8T${suffix}`;
                const err = await respond(a, id, ask.id, { kind: "secret", value }).then(() => undefined, (e) => e);
                expect(err?.code).toBe("bad_secret");
                expect(err.message).not.toContain(value);
                expect(a.view(id).state.interactions.map((i) => i.id)).toEqual([ask.id]);
                expect(a.view(id).state.secrets).toEqual([]);
            }
            await respond(a, id, ask.id, { kind: "secret" });
            await a.until(id, done);
        } finally {
            await a.call("session.interrupt", { id });
            a.close();
        }
    }, 30_000);

    test("marker collisions return bad_secret without settling the card", async () => {
        const a = await client();
        const id = await a.open("session.create", { cwd: project() });
        try {
            await a.call("session.send", { id, text: "use a secret" });
            const ask = await a.secretAsk(id);
            for (const value of ["DEMO_TOKEN", "REDACTED", "[REDACTED", "anthropic-key"]) {
                const err = await respond(a, id, ask.id, { kind: "secret", value }).then(() => undefined, (e) => e);
                expect(err?.code).toBe("bad_secret");
                expect(err.message).toContain("redaction marker");
                expect(err.message).not.toContain(value);
                expect(a.view(id).state.interactions.map((i) => i.id)).toEqual([ask.id]);
                expect(a.view(id).state.secrets).toEqual([]);
            }
            await respond(a, id, ask.id, { kind: "secret" });
            await a.until(id, done);
        } finally {
            await a.call("session.interrupt", { id });
            a.close();
        }
    }, 30_000);

    test("a command run with secrets (run_with_secrets) names them on its permission card, with no 'always'", async () => {
        const { BashTool } = await import("../src/tools/bash");
        const a = await client();
        const id = await a.open("session.create", { cwd: project() });
        const rt = srv.engine.runtimes.get(id)! as any;
        const answer = rt.askPermission({ tool: BashTool, input: { command: 'curl -H "Authorization: Bearer $DEPLOY_TOKEN" https://example.invalid' }, title: "RunWithSecrets(DEPLOY_TOKEN)", decision: { behavior: "ask", suggestions: [] }, secrets: ["DEPLOY_TOKEN"] });
        await a.until(id, (v) => v.state.interactions.length === 1);
        const card = a.view(id).state.interactions[0]!;
        expect(card).toMatchObject({ kind: "permission", heading: "Run a shell command with secrets", secrets: ["DEPLOY_TOKEN"], command: 'curl -H "Authorization: Bearer $DEPLOY_TOKEN" https://example.invalid' });
        expect(card.kind === "permission" && card.options.map((o) => o.id)).toEqual(["yes", "no"]);
        await respond(a, id, card.id, { kind: "permission", choice: "no" });
        expect((await answer).allow).toBe(false);
        a.close();
    });

    test("an unloaded session doesn't keep its secrets", async () => {
        const a = await client();
        const id = await a.open("session.create", { cwd: project() });
        await a.call("session.send", { id, text: "use a secret" });
        const ask = await a.secretAsk(id);
        await respond(a, id, ask.id, { kind: "secret", value: "test-secret-unload-1" });
        // Let the command finish through its permission card before checking idle unload.
        await a.until(id, (v) => v.state.interactions.some((i) => i.kind === "permission"));
        const permission = a.view(id).state.interactions.find((i) => i.kind === "permission")!;
        await respond(a, id, permission.id, { kind: "permission", choice: "yes" });
        await a.until(id, (v) => done(v) && v.state.secrets.length === 1);
        await a.call("session.close", { id });
        await Bun.sleep(100);
        a.views.delete(id);
        expect(srv.engine.runtimes.has(id)).toBe(false);
        await a.open("session.open", { id });
        expect(a.view(id).state.secrets).toEqual([]);
        a.close();
    }, 30_000);
});
