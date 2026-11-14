// A GUI session on the mock model asks the user to sign in (RequestSignIn), over the same socket a window uses:
// the card that changes in place, the turn that carries on once the status check passes, Later and the wake that
// follows, and that the code and the token reach windows but never the model or the session's files.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { acmeRecipe, fakeSignInCli } from "../scripts/fake-signin-cli";

const iso = isolate();
const acme = fakeSignInCli(tempDir("cavvy-gui-signin-cli-"));
process.env.PATH = `${acme.bin}:${process.env.PATH}`;

const { startServer } = await import("../src/server/server");
const { applyOp } = await import("../src/server/timeline");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
import type { Block, ServerEvent, SessionSnapshot, SessionState, SignInInteraction, ToolBlock, Turn } from "../src/server/protocol";

const TOKEN = "test-token-signin-0123456789";
const mock = startMockLlm({ delayMs: 0 });
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku", permissions: { allowBypass: true }, signIns: [acmeRecipe("device", { token: { run: "acme login --token" } })] }));

let srv: Awaited<ReturnType<typeof startServer>>;
const project = () => createDemoProject(realpathSync(tempDir("cavvy-gui-signin-")), { git: false });

beforeAll(async () => {
    srv = await startServer({ token: TOKEN, unloadAfterMs: 300, log: () => undefined });
});
afterAll(async () => {
    await srv.stop();
    mock.stop();
    iso.cleanup();
});
beforeEach(() => acme.reset());

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
        this.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["cavvy.v1", `auth.${TOKEN}`] } as any);
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
    async open(params: Record<string, unknown>) {
        const snap = await this.call<SessionSnapshot>("session.create", params);
        this.views.set(snap.state.id, { state: snap.state, turns: snap.turns, agents: snap.agents, seq: snap.seq });
        return snap.state.id;
    }
    view(id: string) {
        return this.views.get(id)!;
    }
    until(id: string, pred: (v: { state: SessionState; turns: Turn[] }) => boolean, what = "that", ms = 10_000): Promise<void> {
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
                reject(new Error(`timed out waiting for ${what}; status ${this.views.get(id)?.state.status}, card ${JSON.stringify(this.views.get(id)?.state.interactions[0])}`));
            }, ms);
            this.listeners.add(check);
            check();
        });
    }
    /** The sign-in card, once it shows `step`. */
    async card(id: string, step: SignInInteraction["step"], also: (i: SignInInteraction) => boolean = () => true): Promise<SignInInteraction> {
        const find = (v: { state: SessionState }) => v.state.interactions.find((i): i is SignInInteraction => i.kind === "signin" && i.step === step && also(i));
        await this.until(id, (v) => Boolean(find(v)), `the ${step} card`);
        return find(this.view(id))!;
    }
    heard(pred: (e: ServerEvent) => boolean, what: string, ms = 8000): Promise<ServerEvent> {
        return new Promise((resolve, reject) => {
            const check = () => {
                const e = this.events.find(pred);
                if (!e) return;
                this.listeners.delete(check);
                clearTimeout(t);
                resolve(e);
            };
            const t = setTimeout(() => {
                this.listeners.delete(check);
                reject(new Error(`never heard ${what}`));
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
const done = (v: { state: SessionState; turns: Turn[] }) => !v.state.busy && v.turns.length > 0 && lastTurn(v).status !== "running";
const tools = (t: Turn) => t.blocks.filter((b): b is ToolBlock => b.t === "tool");
const texts = (t: Turn) => t.blocks.filter((b): b is Extract<Block, { t: "text" }> => b.t === "text").map((b) => b.text).join("\n");
const step = (c: Client, id: string, interactionId: string, action: Record<string, unknown>) => c.call("session.respond", { id, interactionId, response: { kind: "signin", ...action } });

function filesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) out.push(...filesUnder(p));
        else if (st.isFile()) out.push(readFileSync(p, "latin1"));
    }
    return out;
}

describe("a sign-in in a GUI session", () => {
    test("the card changes in place, every window sees it, and the turn carries on once it's signed in", async () => {
        const a = await client();
        const b = await client();
        const id = await a.open({ cwd: project() });
        b.views.set(id, structuredClone(a.view(id)));
        await b.call("session.open", { id });
        await a.call("session.send", { id, text: "signin acme" });

        const ask = await a.card(id, "ask");
        expect(ask).toMatchObject({ kind: "signin", name: "Acme", target: "acme", canToken: true });
        expect(ask.machine).toBeUndefined();
        expect(a.view(id).state.status).toBe("waiting");
        expect(tools(lastTurn(a.view(id)))[0]).toMatchObject({ name: "RequestSignIn", status: "awaiting" });
        // The sidebar's row, and a notification that says what for.
        const note = await a.heard((e) => e.type === "notify" && e.sessionId === id, "the notification");
        expect(note).toMatchObject({ kind: "question", body: "Sign in to Acme" });

        await step(a, id, ask.id, { action: "start" });
        const code = await b.card(id, "code");
        // The same card, moved on: the other window's too.
        expect(code.id).toBe(ask.id);
        expect(code).toMatchObject({ code: "WXYZ-1234", url: "https://acme.example/device", site: "acme.example/device" });
        expect(a.view(id).state.interactions).toHaveLength(1);

        acme.approve("me@example.com");
        await a.until(id, done, "the turn's end");
        expect(a.view(id).state.interactions).toEqual([]);
        await b.until(id, (v) => !v.state.interactions.length, "the card gone from the other window");
        const turn = lastTurn(a.view(id));
        expect(texts(turn)).toContain("Carrying on. Signed in to Acme as me@example.com.");
        expect(tools(turn)[0]).toMatchObject({ name: "RequestSignIn", title: "RequestSignIn(acme)", status: "ok", output: "Signed in to Acme as me@example.com.", summary: "Signed in as me@example.com" });
        // The code went to the windows, and nowhere that's kept or that the model reads.
        expect(a.frames.some((f) => f.includes("WXYZ-1234"))).toBe(true);
        expect(JSON.stringify(a.view(id).turns)).not.toContain("WXYZ-1234");
        for (const text of filesUnder(iso.home)) expect(text).not.toContain("WXYZ-1234");
        a.close();
        b.close();
    });

    test("a token is passed to the CLI's own sign-in: a bad one stays in the card, and neither is kept or told to the model", async () => {
        const c = await client();
        const id = await c.open({ cwd: project() });
        await c.call("session.send", { id, text: "signin acme" });
        const ask = await c.card(id, "ask");
        await step(c, id, ask.id, { action: "token" });
        await c.card(id, "token");
        await step(c, id, ask.id, { action: "submit", value: "wrong-token-999" });
        const bad = await c.card(id, "token", (i) => Boolean(i.error));
        expect(bad.error).toContain("Bad credentials");
        expect(bad.error).not.toContain("wrong-token-999");
        await step(c, id, ask.id, { action: "submit", value: "good-token-123" });
        await c.until(id, done, "the turn's end");
        expect(texts(lastTurn(c.view(id)))).toContain("Signed in to Acme as token-user.");
        // Sent by this window, and in nothing it received back.
        for (const secret of ["wrong-token-999", "good-token-123"]) {
            expect(c.frames.some((f) => f.includes(secret))).toBe(false);
            for (const text of filesUnder(iso.home)) expect(text).not.toContain(secret);
        }
        c.close();
    });

    test("Later ends the wait; the sign-in stays listed, and coming back to it and signing in wakes the agent", async () => {
        const c = await client();
        const id = await c.open({ cwd: project() });
        await c.call("session.send", { id, text: "signin acme" });
        const ask = await c.card(id, "ask");
        await step(c, id, ask.id, { action: "later" });
        await c.until(id, done, "the turn's end");
        expect(texts(lastTurn(c.view(id)))).toContain("the user chose Later");
        expect(c.view(id).state.interactions).toEqual([]);
        expect(c.view(id).state.watches).toEqual([{ id: "sign-in::acme", kind: "sign-in", label: "Sign in to Acme" }]);
        expect(c.view(id).state.status).toBe("idle");

        await c.call("session.signIn", { id, watchId: "sign-in::acme" });
        // Its card again, with no tool call behind it. (One that takes a token asks how; any other starts at once.)
        const again = await c.card(id, "ask");
        expect(c.view(id).state.status).toBe("waiting");
        expect(again.toolId).toBeUndefined();
        await step(c, id, again.id, { action: "start" });
        await c.card(id, "code");
        const before = c.view(id).turns.length;
        acme.approve("back@example.com");
        await c.until(id, (v) => v.turns.length > before && done(v), "the wake's turn");
        const wake = lastTurn(c.view(id));
        expect(wake.prompt?.text).toBe("Signed in to Acme");
        expect(texts(wake)).toContain("Noted.");
        expect(c.view(id).state.watches).toEqual([]);
        expect(c.view(id).state.interactions).toEqual([]);
        c.close();
    }, 20_000);

    test("dismissed, it's no longer listed, and its card can't be brought back", async () => {
        const c = await client();
        const id = await c.open({ cwd: project() });
        await c.call("session.send", { id, text: "signin acme" });
        await step(c, id, (await c.card(id, "ask")).id, { action: "later" });
        await c.until(id, (v) => done(v) && Boolean(v.state.watches?.length), "the listed sign-in");
        await c.call("session.stopWatch", { id, watchId: "sign-in::acme" });
        await c.until(id, (v) => !v.state.watches?.length, "nothing listed");
        await expect(c.call("session.signIn", { id, watchId: "sign-in::acme" })).rejects.toThrow("no longer waiting");
        c.close();
    });

    test("stopping the turn takes the card with it; a late step is refused", async () => {
        const c = await client();
        const id = await c.open({ cwd: project() });
        await c.call("session.send", { id, text: "signin acme" });
        const ask = await c.card(id, "ask");
        await step(c, id, ask.id, { action: "start" });
        await c.card(id, "code");
        await c.call("session.interrupt", { id });
        await c.until(id, (v) => done(v) && !v.state.interactions.length, "the card gone");
        expect(c.view(id).state.watches ?? []).toEqual([]);
        await expect(step(c, id, ask.id, { action: "start" })).rejects.toThrow("already answered or has expired");
        // The command that waited for the page went with it.
        acme.approve();
        await Bun.sleep(200);
        expect(acme.signedIn()).toBeUndefined();
        c.close();
    });

    test("only a card's own steps are taken, and an answer of another kind isn't one", async () => {
        const c = await client();
        const id = await c.open({ cwd: project() });
        await c.call("session.send", { id, text: "signin acme" });
        const ask = await c.card(id, "ask");
        await expect(step(c, id, ask.id, { action: "run", value: "id" })).rejects.toThrow("isn't something this card does");
        await expect(c.call("session.respond", { id, interactionId: ask.id, response: { kind: "secret", value: "abcdefgh12345" } })).rejects.toThrow("doesn't match");
        expect(c.view(id).state.interactions).toHaveLength(1);
        await step(c, id, ask.id, { action: "later" });
        await c.until(id, done, "the turn's end");
        c.close();
    });

    test("a window's own feature asks (publishing found GitHub signed out): the card with no turn behind it, answered when the user is done", async () => {
        const c = await client();
        const id = await c.open({ cwd: project() });
        const asked = c.call<string>("session.askSignIn", { id, target: "acme" });
        const ask = await c.card(id, "ask");
        expect(ask.toolId).toBeUndefined();
        expect(c.view(id).state.status).toBe("waiting");
        expect(c.view(id).turns).toHaveLength(0);
        await step(c, id, ask.id, { action: "start" });
        await c.card(id, "code");
        acme.approve();
        expect(await asked).toBe("signed-in");
        await c.until(id, (v) => !v.state.interactions.length && v.state.status === "idle", "the card gone");
        // No agent was waiting: nothing wakes one.
        await Bun.sleep(400);
        expect(c.view(id).turns).toHaveLength(0);
        // Signed in already: nothing to show. And only what Cavvy has a sign-in for: a window names it, never a command.
        expect(await c.call<string>("session.askSignIn", { id, target: "acme" })).toBe("cannot");
        await expect(c.call("session.askSignIn", { id, target: "rm -rf" })).rejects.toThrow("no sign-in for that");
        c.close();
    });

    test("an agent that meets a signed-out CLI and doesn't ask: the user is asked all the same when its turn ends, and it carries on once they've signed in", async () => {
        const c = await client();
        const id = await c.open({ cwd: project() });
        await c.call("session.setMode", { id, mode: "bypassPermissions" });
        // As agents write it: the command as a whole succeeds, whatever the CLI said.
        await c.call("session.send", { id, text: 'justrun: acme status 2>&1; echo "exit=$?"' });
        const ask = await c.card(id, "ask");
        // The turn is over, with the agent's own words; the card has no tool call behind it.
        expect(ask.toolId).toBeUndefined();
        await c.until(id, done, "the turn's end");
        expect(texts(lastTurn(c.view(id)))).toContain("You'll have to sign in yourself.");
        expect(tools(lastTurn(c.view(id))).map((t) => t.name)).toEqual(["Bash"]);
        // Put off: listed, and the next turn that runs into it shows no second card.
        await step(c, id, ask.id, { action: "later" });
        await c.until(id, (v) => v.state.watches.length === 1 && !v.state.interactions.length, "the line");
        await c.call("session.send", { id, text: "justrun: acme status | cat" });
        await c.until(id, (v) => v.turns.length === 2 && done(v), "the second turn");
        await Bun.sleep(300);
        expect(c.view(id).state.interactions).toEqual([]);
        expect(c.view(id).state.watches).toHaveLength(1);
        // Signed in from the line: the agent is told once, and carries on.
        await c.call("session.signIn", { id, watchId: c.view(id).state.watches[0]!.id });
        await step(c, id, (await c.card(id, "ask")).id, { action: "start" });
        await c.card(id, "code");
        acme.approve("me@example.com");
        await c.until(id, (v) => v.turns.length === 3 && done(v), "the wake's turn", 15_000);
        expect(lastTurn(c.view(id)).prompt?.text).toBe("Signed in to Acme");
        expect(c.view(id).state.watches).toEqual([]);
        await Bun.sleep(400);
        expect(c.view(id).turns).toHaveLength(3);
        c.close();
    }, 30_000);

    test("an agent that does ask isn't asked over: Later is the answer for that turn", async () => {
        const c = await client();
        const id = await c.open({ cwd: project() });
        await c.call("session.send", { id, text: "signin acme" });
        await step(c, id, (await c.card(id, "ask")).id, { action: "later" });
        await c.until(id, done, "the turn's end");
        await Bun.sleep(300);
        expect(c.view(id).state.interactions).toEqual([]);
        c.close();
    });

    test("a card left up for the user doesn't hold the session's scheduled prompts back", async () => {
        const c = await client();
        const id = await c.open({ cwd: project() });
        await c.call("session.send", { id, text: "schedule the tests" });
        await c.until(id, (v) => done(v) && v.state.schedules.length === 1, "the schedule");
        const asked = c.call<string>("session.askSignIn", { id, target: "acme" });
        const ask = await c.card(id, "ask");
        // Due now, with the card still up: it runs beside it, as a wake does.
        await c.call("session.schedule", { id, scheduleId: c.view(id).state.schedules[0]!.id, action: "run" });
        await c.until(id, (v) => v.turns.length === 2 && done(v), "the scheduled turn");
        expect(c.view(id).state.interactions.map((i) => i.id)).toEqual([ask.id]);
        await step(c, id, ask.id, { action: "later" });
        expect(await asked).toBe("later");
        c.close();
    });

    test("this machine brings a port over only for a sign-in of its own that names it: a card can't have it listen anywhere", async () => {
        const { saveServer, removeServer } = await import("../src/servers/store");
        saveServer({ name: "far", destination: "dev@far.example", addedAt: new Date().toISOString() });
        const c = await client();
        try {
            // No sign-in here calls a port: GitHub's doesn't, nor the user's own device-code one.
            for (const target of ["gh", "acme", "nope"]) await expect(c.call("servers.forward", { name: "far", port: 8085, target })).rejects.toThrow("This machine has no sign-in that uses that port.");
            await expect(c.call("servers.forward", { name: "far", port: 8085 })).rejects.toThrow();
        } finally {
            removeServer("far");
            c.close();
        }
    });

    test("a sign-in Cavvy doesn't know: the command is typed into a terminal for the user, not run, and Done is their word", async () => {
        const c = await client();
        const cwd = project();
        const id = await c.open({ cwd });
        await c.call("session.send", { id, text: "signin zzcli: zzcli auth login" });
        const card = await c.card(id, "command");
        expect(card).toMatchObject({ name: "zzcli", command: "zzcli auth login", canSave: true });
        await c.call("terminal.open", { id: "signin-term-1", cwd, cols: 100, rows: 20, signIn: { session: id, interaction: card.id } });
        await c.call("terminal.arm", { id: "signin-term-1" });
        const typed = (e: ServerEvent) => e.type === "terminal.data" && e.id === "signin-term-1";
        const out = () => c.events.filter(typed).map((e) => (e as { data: string }).data).join("");
        await c.heard(() => out().includes("zzcli auth login"), "the command typed");
        // Typed, and left for the user's Enter: the shell hasn't run it.
        await Bun.sleep(300);
        expect(out()).not.toContain("command not found");
        await c.call("terminal.close", { id: "signin-term-1" });
        await step(c, id, card.id, { action: "ran" });
        await c.card(id, "command", (i) => i.ran === true);
        await step(c, id, card.id, { action: "done" });
        await c.until(id, done, "the turn's end");
        expect(texts(lastTurn(c.view(id)))).toContain("The sign-in to zzcli was done, but Cavvy has no way to check it.");
        // A stale card's id opens a plain terminal: nothing is typed for it.
        await c.call("terminal.open", { id: "signin-term-2", cwd, cols: 100, rows: 20, signIn: { session: id, interaction: card.id } });
        await c.call("terminal.arm", { id: "signin-term-2" }).catch(() => undefined);
        await Bun.sleep(400);
        expect(c.events.filter((e) => e.type === "terminal.data" && e.id === "signin-term-2").map((e) => (e as { data: string }).data).join("")).not.toContain("zzcli");
        await c.call("terminal.close", { id: "signin-term-2" });
        c.close();
    });
});
