// A GUI session on the mock model suggests a task (SuggestTask), over the same socket a window uses: the suggestion in
// the session's state and its row's count, Start as the card does it (gui/src/state/suggestions.ts: claim, tasks.start,
// started), in a new worktree or not, Dismiss and Restore, a second Start refused, a failed one put back, and all of it
// still there once the session is loaded again.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();

const { startServer } = await import("../src/server/server");
const { applyOp } = await import("../src/server/timeline");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
const { startSuggestion } = await import("../gui/src/state/suggestions");
const { RpcError } = await import("../gui/src/lib/rpc");
import type { ServerEvent, SessionSnapshot, SessionState, SessionSummary, SuggestionState, ToolBlock, Turn } from "../src/server/protocol";
import type { StartCalls, StartPick } from "../gui/src/state/suggestions";

const TOKEN = "test-token-suggest-0123456789";
const mock = startMockLlm({ delayMs: 0 });
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku", permissions: { allowBypass: true } }));

let srv: Awaited<ReturnType<typeof startServer>>;
const project = (git = true) => createDemoProject(realpathSync(tempDir("cavvy-gui-suggest-")), { git });

beforeAll(async () => {
    srv = await startServer({ token: TOKEN, unloadAfterMs: 300, log: () => undefined });
});
afterAll(async () => {
    await srv.stop();
    mock.stop();
    iso.cleanup();
});

type View = { state: SessionState; turns: Turn[]; agents: unknown[]; seq: number };

/** A window: its requests, and each open session's view as the ops it's sent leave it. */
class Client {
    ws: WebSocket;
    private next = 1;
    private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    views = new Map<string, View>();
    events: ServerEvent[] = [];
    private listeners = new Set<() => void>();

    constructor() {
        this.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["cavvy.v1", `auth.${TOKEN}`] } as any);
        this.ws.onmessage = (m) => {
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
            // As the window's own connection makes them: the card tells failures apart by their codes.
            if (msg.error) w?.reject(new RpcError(msg.error.message, msg.error.code, msg.error.folder));
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
    async create(cwd: string) {
        const snap = await this.call<SessionSnapshot>("session.create", { cwd });
        this.views.set(snap.state.id, { state: snap.state, turns: snap.turns, agents: snap.agents, seq: snap.seq });
        return snap.state.id;
    }
    async open(id: string) {
        const snap = await this.call<SessionSnapshot>("session.open", { id });
        this.views.set(id, { state: snap.state, turns: snap.turns, agents: snap.agents, seq: snap.seq });
        return this.views.get(id)!;
    }
    view(id: string) {
        return this.views.get(id)!;
    }
    until(id: string, pred: (v: View) => boolean, what = "that", ms = 10_000): Promise<void> {
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
                reject(new Error(`timed out waiting for ${what}; suggestions ${JSON.stringify(this.views.get(id)?.state.suggestions)}`));
            }, ms);
            this.listeners.add(check);
            check();
        });
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
const done = (v: View) => !v.state.busy && v.turns.length > 0 && lastTurn(v).status !== "running";
const suggestions = (v: View) => v.state.suggestions ?? [];
/** The session's row, as the sidebar lists it. */
const summary = async (c: Client, id: string) => (await c.call<SessionSummary[]>("sessions.list", {})).find((s) => s.id === id);

/** The card's Start, as the window does it, over this client's socket (both machines are this server here). */
const calls = (c: Client): StartCalls => ({
    suggestion: (params) => c.call("session.suggestion", params),
    link: async () => ({ call: ((method: string, params: Record<string, unknown>) => c.call(method, params)) as never }),
    trust: () => undefined,
    again: () => undefined,
});
const pick = (id: string, s: SuggestionState, v: View, extra: Partial<StartPick> = {}): StartPick => ({
    sessionId: id,
    from: { title: v.state.title ?? "", on: undefined },
    suggestion: s,
    on: undefined,
    cwd: v.state.cwd,
    title: s.title,
    prompt: s.prompt ?? "",
    model: "mock:mock-opus",
    worktree: true,
    ...extra,
});

/** A session whose agent has suggested a task (two, with `twice`), its turn over. */
async function suggested(c: Client, opts: { git?: boolean; twice?: boolean } = {}) {
    const id = await c.create(project(opts.git ?? true));
    await c.call("session.send", { id, text: `fix the docs, suggestdemo${opts.twice ? " twice" : ""}` });
    await c.until(id, (v) => done(v) && suggestions(v).length >= (opts.twice ? 2 : 1), "the suggestion");
    return id;
}

describe("a suggested task in a GUI session", () => {
    test("the call is in the turn, the suggestion in the state, pending, and the row counts it", async () => {
        const a = await client();
        const id = await suggested(a);
        const v = a.view(id);
        const call = lastTurn(v).blocks.find((b): b is ToolBlock => b.t === "tool" && b.name === "SuggestTask");
        expect(call).toBeDefined();
        const [s] = suggestions(v);
        expect(s).toMatchObject({ id: call!.id, title: "Fix the flaky login test", state: "pending" });
        expect(s!.prompt).toContain("bun test ./test/login.test.ts");
        expect((await summary(a, id))?.suggested).toBe(1);
        a.close();
    });

    test("Start in a new worktree: a session there with the prompt as its first message; the card says it started", async () => {
        const a = await client();
        const id = await suggested(a);
        const s = suggestions(a.view(id))[0]!;
        const out = await startSuggestion(pick(id, s, a.view(id), { title: "Fix the login test" }), calls(a));
        expect(out.kind).toBe("started");
        await a.until(id, (v) => suggestions(v)[0]?.state === "started", "started");
        const started = suggestions(a.view(id))[0]!.started!;
        expect(started.worktree?.branch).toMatch(/^fix\//);
        expect(existsSync(started.worktree!.path)).toBe(true);
        expect(started.title).toBe("Fix the login test");
        const made = await a.open(started.sessionId);
        expect(made.state.cwd).toBe(started.cwd);
        // The turn may still be on its way: its prompt is the suggestion's, as the user's own message.
        await a.until(started.sessionId, (v) => Boolean(v.turns[0]?.prompt), "its first turn");
        expect(a.view(started.sessionId).turns[0]!.prompt!.text).toContain("test/login.test.ts is flaky");
        expect((await summary(a, id))?.suggested ?? 0).toBe(0);
        // A second Start (another window's) is refused: it isn't pending.
        await expect(a.call("session.suggestion", { id, suggestionId: s.id, action: "claim" })).rejects.toMatchObject({ code: "not_pending" });
        a.close();
    });

    test("Start without a worktree: in the session's own folder", async () => {
        const a = await client();
        const id = await suggested(a);
        const s = suggestions(a.view(id))[0]!;
        const out = await startSuggestion(pick(id, s, a.view(id), { worktree: false }), calls(a));
        expect(out.kind).toBe("started");
        await a.until(id, (v) => suggestions(v)[0]?.state === "started", "started");
        const started = suggestions(a.view(id))[0]!.started!;
        expect(started.worktree).toBeUndefined();
        expect(started.cwd).toBe(a.view(id).state.cwd);
        a.close();
    });

    test("a server's suggestion started on this computer: the record says so, kept through the server", async () => {
        const a = await client();
        const id = await suggested(a);
        const v = a.view(id);
        const s = suggestions(v)[0]!;
        // As a window does it when the suggesting session is on a server ("box") and the task starts here.
        const out = await startSuggestion(pick(id, s, v, { from: { title: v.state.title ?? "", on: "box" }, worktree: false }), calls(a));
        expect(out.kind).toBe("started");
        await a.until(id, (x) => suggestions(x)[0]?.state === "started", "started");
        expect(suggestions(a.view(id))[0]!.started!.machine).toMatch(/^This (Mac|computer)$/);
        const { startedOn } = await import("../gui/src/state/suggestions");
        expect(startedOn("not-listed", { ...suggestions(a.view(id))[0]!.started!, sessionId: "not-listed-either" })).toBeUndefined();
        expect(startedOn("not-listed", { ...suggestions(a.view(id))[0]!.started!, sessionId: "not-listed-either", machine: "box" })).toBe("box");
        a.close();
    });

    test("this computer's suggestion started on a server: the server takes it, and its agent is told where to ask", async () => {
        const a = await client();
        const id = await suggested(a);
        const v = a.view(id);
        const s = suggestions(v)[0]!;
        // This server stands in for server "box"; the suggesting session is this computer's.
        const out = await startSuggestion(pick(id, s, v, { on: "box", worktree: false }), calls(a));
        expect(out.kind).toBe("started");
        const made = (out as { started: { sessionId: string } }).started.sessionId;
        const rt = srv.engine.runtimes.get(made)!;
        for (let i = 0; i < 200 && !rt.session.messages.length; i++) await Bun.sleep(20);
        // Named as the server names the user's computer, so send_to_session reaches it from there.
        const { HOME_NAME } = await import("../src/server/far-peers");
        expect(JSON.stringify(rt.session.messages[0]?.content)).toContain(`session ${HOME_NAME}/${id} `);
        a.close();
    });

    test("a folder that isn't there: not started, back to pending, and the card says why", async () => {
        const a = await client();
        const id = await suggested(a);
        const s = suggestions(a.view(id))[0]!;
        const out = await startSuggestion(pick(id, s, a.view(id), { cwd: "/nope/not-here" }), calls(a));
        expect(out).toMatchObject({ kind: "failed", message: expect.stringContaining("No folder /nope/not-here on") });
        await a.until(id, (v) => suggestions(v)[0]?.state === "pending" && Boolean(suggestions(v)[0]?.failed), "put back");
        a.close();
    });

    test("Dismiss and Restore, and both survive the session being loaded again", async () => {
        const a = await client();
        const id = await suggested(a, { twice: true });
        const [first, second] = suggestions(a.view(id));
        await a.call("session.suggestion", { id, suggestionId: first!.id, action: "dismissed" });
        await a.until(id, (v) => suggestions(v)[0]?.state === "dismissed", "dismissed");
        expect((await summary(a, id))?.suggested).toBe(1);
        await a.call("session.suggestion", { id, suggestionId: first!.id, action: "pending" });
        await a.until(id, (v) => suggestions(v)[0]?.state === "pending", "restored");
        await a.call("session.suggestion", { id, suggestionId: second!.id, action: "dismissed" });
        await a.until(id, (v) => suggestions(v)[1]?.state === "dismissed", "dismissed");
        // Unloaded (no window has it open), then opened again from its file.
        a.close();
        for (let i = 0; i < 200 && srv.engine.runtimes.has(id); i++) await Bun.sleep(20);
        expect(srv.engine.runtimes.has(id)).toBe(false);
        const b = await client();
        const v = await b.open(id);
        expect(suggestions(v).map((s) => [s.title, s.state])).toEqual([
            ["Fix the flaky login test", "pending"],
            ["Fix the settings page typo", "dismissed"],
        ]);
        b.close();
    });
});
