// A server's sessions using the simulators of the user's own machine (src/tools/lent.ts, Engine.borrow and
// Engine.lend, src/servers/watch.ts), for real against the pretend server (test/helpers/fake-ssh.ts), with simctl
// faked on this machine: the call travels there and back, runs through this machine's own checks in a session of
// its own that's never listed (what it asks is shown, and told, as the session's there), and ends plainly when the
// user says no or this machine goes away.

import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { fakeSsh } from "./helpers/fake-ssh";

setDefaultTimeout(60_000);

// The pretend server has no simulators of its own (its Cavvy inherits this); this machine is given some below.
const simulatorWas = process.env.CAVVY_SIMULATOR;
process.env.CAVVY_SIMULATOR = "0";
const iso = isolate();
const fake = fakeSsh();
const A = "aaaaaaaaaaaa-1";

const { startMockLlm } = await import("../scripts/mock-llm");
const { startServer } = await import("../src/server/server");
const { stopRemote } = await import("../src/servers/service");
const simctl = await import("../src/simulator/simctl");
const { resetSimulators } = await import("../src/simulator/session");
import type { BuildSource } from "../src/servers/build";
import type { Interaction, LentSession, MachineOverview, SessionSnapshot } from "../src/server/protocol";

const mock = startMockLlm({ delayMs: 0 });
const models = { providers: JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }), settings: JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku", notifyAfterSeconds: 0 }) };
// The pretend server's home, and this machine's own.
for (const home of [join(fake.home, ".cavvy"), iso.home]) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "providers.json"), models.providers);
    writeFileSync(join(home, "settings.json"), models.settings);
}
const source: BuildSource = { id: A, gui: true, build: async () => fake.bundle(A, { gui: true }), compare: (theirs: string) => (theirs === A ? "same" : "older") } as BuildSource;

/** A window: a WebSocket to a Cavvy, with calls, their replies, and what it's told meanwhile. */
class Window {
    ws: WebSocket;
    events: any[] = [];
    private next = 1;
    private waiting = new Map<number, (m: { result?: any; error?: { message: string } }) => void>();
    opened = Promise.withResolvers<boolean>();

    constructor(url: string, token: string) {
        this.ws = new WebSocket(url, ["cavvy.v1", `auth.${token}`]);
        this.ws.onopen = () => this.opened.resolve(true);
        this.ws.onerror = () => this.opened.resolve(false);
        this.ws.onclose = () => this.opened.resolve(false);
        this.ws.onmessage = (m) => {
            const msg = JSON.parse(String(m.data));
            if (typeof msg.id !== "number") return void (msg.event && this.events.push(msg.event));
            const w = this.waiting.get(msg.id);
            this.waiting.delete(msg.id);
            // Not inside Bun's message callback (see test/gui-server.test.ts).
            setImmediate(() => w?.(msg));
        };
    }

    async call(method: string, params: unknown = {}): Promise<any> {
        const id = this.next++;
        const reply = new Promise<{ result?: any; error?: { message: string } }>((r) => this.waiting.set(id, r));
        this.ws.send(JSON.stringify({ id, method, params }));
        const m = await reply;
        if (m.error) throw new Error(m.error.message);
        // What it's told from then on starts from what it was told now.
        if (method === "servers.overview") for (const machine of m.result.machines) this.events.push({ type: "servers.overview", machine });
        return m.result;
    }

    /** Closed, and gone from the Cavvy it was a window of. */
    async close() {
        const n = mine.engine.clients.size;
        this.ws.close();
        await until("the window to be gone", () => mine.engine.clients.size < n);
    }

    /** The server's sessions as this window was last told. */
    machine(name: string): MachineOverview | undefined {
        return this.events.findLast((e) => e.type === "servers.overview" && e.machine.name === name)?.machine;
    }
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 12_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await ok()) return;
        await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
}

// Sessions no window is on are closed after a third of a second here (half a minute in the app).
// And a session a server's session is lent through, four seconds after its last call (half an hour in the app).
const mine = await startServer({ token: "mine", serverBuilds: source, unloadAfterMs: 300, guestIdleMs: 4000 });
const window = async () => {
    const w = new Window(`ws://127.0.0.1:${mine.port}/ws`, "mine");
    expect(await w.opened.promise).toBe(true);
    return w;
};
const here = await window();

const DEVICES = JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: "AAAA", name: "iPhone 17", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" }] } });
/** What this machine's simctl was asked. */
const ran: string[][] = [];
simctl.setAvailability({ ok: true, developerDir: "/Applications/Xcode.app/Contents/Developer" });
simctl.setRunner(async (args) => {
    ran.push(args);
    if (args.join(" ") === "xcrun simctl list devices -j") return { code: 0, stdout: DEVICES, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
});

afterAll(async () => {
    simctl.setAvailability(undefined);
    simctl.setRunner(undefined);
    resetSimulators();
    if (simulatorWas === undefined) delete process.env.CAVVY_SIMULATOR;
    else process.env.CAVVY_SIMULATOR = simulatorWas;
    here.ws.close();
    await mine.stop().catch(() => undefined);
    await stopRemote({ name: "box", destination: "dev@box.example", addedAt: "" }).catch(() => undefined);
    mock.stop();
    fake.cleanup();
    iso.cleanup();
});

/** The next thing a session asks its user, answered. */
async function answer(w: Window, id: string, choice: "yes" | "no", seen = new Set<string>()) {
    let asked: SessionSnapshot["state"]["interactions"][number] | undefined;
    await until(`session ${id} to ask`, async () => {
        asked = ((await w.call("session.open", { id })) as SessionSnapshot).state.interactions.find((i) => !seen.has(i.id));
        return Boolean(asked);
    });
    seen.add(asked!.id);
    await w.call("session.respond", { id, interactionId: asked!.id, response: { kind: "permission", choice } });
    return asked!;
}

const lastTurn = async (w: Window, id: string) => ((await w.call("session.open", { id })) as SessionSnapshot).turns.at(-1)!;
const textOf = (turn: SessionSnapshot["turns"][number]) => turn.blocks.map((b) => (b.t === "text" ? b.text : "")).join("\n");
/** What this machine has for a session on the server, as its windows on that server were last told. */
const told = (session: string) => here.events.findLast((e) => e.type === "offers.session" && e.name === "box" && e.sessionId === session)?.lent as LentSession | undefined;
/** The same, asked for. */
const lentTo = (session: string) => here.call("offers.session", { name: "box", sessionId: session }) as Promise<LentSession>;
/** The next thing this machine asks its user for a session on the server, answered here. */
async function answerLent(session: string, choice: "yes" | "no", seen = new Set<string>()): Promise<Interaction> {
    let lent: LentSession | undefined;
    await until(`this machine to ask for ${session}`, async () => {
        lent = await lentTo(session);
        return lent.asks.some((i) => !seen.has(i.id));
    });
    const asked = lent!.asks.find((i) => !seen.has(i.id))!;
    seen.add(asked.id);
    await here.call("session.respond", { id: lent!.id, interactionId: asked.id, response: { kind: "permission", choice } });
    return asked;
}

let there: { url: string; token: string };
let remote: Window;
/** A session on the server, in Manual whatever a server's sessions start in: its own asking comes first, then this machine's. */
async function sessionThere(): Promise<string> {
    const id = (await remote.call("session.create", { cwd: tempDir("cavvy-lend-proj-") })).state.id as string;
    await remote.call("session.setMode", { id, mode: "default" });
    return id;
}

test("a server with no simulators is lent this machine's: its sessions have the tools once this machine is connected", async () => {
    fake.trust("box.example");
    expect(await here.call("servers.add", { name: "box", destination: "dev@box.example" })).toMatchObject({ status: "added" });
    await here.call("servers.overview");
    await until("this machine to be connected there", () => here.machine("box")?.state === "connected");
    there = await here.call("servers.connect", { name: "box" });
    remote = new Window(there.url, there.token);
    expect(await remote.opened.promise).toBe(true);
    // This machine's own Cavvy is lent nothing by anyone who connects to it.
    await expect(here.call("offers.set", { kinds: ["simulator"] })).rejects.toThrow("This machine isn't lent tools.");
});

test("a call from a session there runs here, after this machine's own asking, shown and told as that session's; the result goes back", async () => {
    const id = await sessionThere();
    await remote.call("session.send", { id, text: "simulator please" });
    // The server's own asking first (sessionThere puts it in Manual), then this machine's.
    expect((await answer(remote, id, "yes")).kind).toBe("permission");
    expect(ran.some((a) => a[2] === "boot")).toBe(false);
    // This machine's asking is its windows' to show, in the session there, and says whose it is.
    const asked = await answerLent(id, "yes");
    expect(JSON.stringify(asked)).toContain("SimulatorControl(boot)");
    expect(asked.kind === "permission" && asked.where).toBe("On this Mac");
    const mineId = told(id)!.id!;
    // It's told as the session there, by its name (the title the mock model gives any such session), by this machine.
    const rang = here.events.find((e) => e.type === "servers.notify" && e.lent);
    expect([rang.name, rang.sessionId, rang.kind, rang.title]).toEqual(["box", id, "permission", "Check the app in the simulator"]);
    // The session here that it runs in is never one of this machine's own to list.
    expect(here.events.some((e) => (e.type === "sessions.upsert" && e.session.id === mineId) || (e.type === "notify" && e.sessionId === mineId))).toBe(false);
    expect(((await here.call("sessions.list", { limit: 200 })) as { id: string }[]).some((x) => x.id === mineId)).toBe(false);
    await until("the turn there to end", async () => (await lastTurn(remote, id)).status === "done");
    // It ran here: this machine's simctl was asked about this machine's device, which the server knows nothing of,
    // and the server's model read what this machine said.
    expect(ran.some((a) => a.join(" ") === "xcrun simctl bootstatus AAAA -b")).toBe(true);
    const turn = await lastTurn(remote, id);
    // What it said is this machine's own (how far a start gets past the faked simctl differs by machine: there's no
    // Xcode on a Linux one), and it reached the session there as the tool's result.
    const result = turn.blocks.find((b) => b.t === "tool") as { name: string; output?: string };
    expect([result.name, Boolean(result.output)]).toEqual(["SimulatorControl", true]);
    expect(textOf(turn)).toContain("I couldn't find Settings on the screen: ");
    // Answered: nothing waits here any more.
    await until("the asking to be over", () => told(id)!.asks.length === 0);
    // Long after: the same session there is still lent through the same session here.
    await Bun.sleep(1500);
    const before = ran.filter((a) => a[2] === "bootstatus").length;
    await remote.call("session.send", { id, text: "simulator once again" });
    await until("the second turn there to end", async () => (await remote.call("session.open", { id })).turns.length === 2 && (await lastTurn(remote, id)).status === "done");
    // It ran here again (allowed for this session the first time, on both machines, as the tool is anywhere),
    // and no second session was made here for it.
    expect(ran.filter((a) => a[2] === "bootstatus").length).toBe(before + 1);
    expect((await lentTo(id)).id).toBe(mineId);
});

test("the Simulator turned off here while a session there waits for this machine's answer: the question goes, and the session is told why", async () => {
    const id = await sessionThere();
    await remote.call("session.send", { id, text: "simulator before it's off" });
    await answer(remote, id, "yes");
    await until("the question here", async () => (await lentTo(id)).asks.length > 0);
    await here.call("settings.update", { patch: { simulator: false } });
    try {
        await until("the turn there to end", async () => (await lastTurn(remote, id)).status === "done");
        expect(JSON.stringify(await lastTurn(remote, id))).toContain("Your Mac's Simulator isn't available now");
        await until("the question here to go", async () => (await lentTo(id)).asks.length === 0);
    } finally {
        await here.call("settings.update", { patch: { simulator: true } });
    }
    // Turned on again, it's lent again: a session there has the tools once more.
    await until("the server to be lent it again", async () => {
        const again = await sessionThere();
        await remote.call("session.send", { id: again, text: "simulator once it's back" });
        // It has the tool when its own asking about the call comes; without it the turn ends on "No such tool".
        let has = false;
        await until("that session to ask, or to end", async () => {
            const now = ((await remote.call("session.open", { id: again })) as SessionSnapshot);
            has = now.state.interactions.length > 0;
            return has || now.turns.at(-1)?.status === "done";
        });
        return has;
    });
});

test("the user's no here is what the session there is told; this machine going away ends a call that waits", async () => {
    const seen = new Set<string>();
    const id = await sessionThere();
    await remote.call("session.send", { id, text: "simulator again" });
    await answer(remote, id, "yes");
    await answerLent(id, "no", seen);
    await until("the turn there to end", async () => (await lastTurn(remote, id)).status === "done");
    expect(JSON.stringify(await lastTurn(remote, id))).toContain("declined");

    const second = await sessionThere();
    await remote.call("session.send", { id: second, text: "simulator once more" });
    await answer(remote, second, "yes");
    // While this machine's question waits, its Cavvy stops listening to the server (as when it quits): only that
    // connection goes, so what the session there is told can still be read through the window's own.
    await until("the question here", async () => (await lentTo(second)).asks.length > 0);
    // A window that comes late (reloaded, say) learns of it too, whichever session it shows.
    expect(((await here.call("offers.asking", { name: "box" })) as { sessionId: string }[]).map((a) => a.sessionId)).toEqual([second]);
    (mine.engine as any).serverLinks.watches.get("box").stop();
    await until("the turn there to end", async () => (await lastTurn(remote, second)).status === "done");
    expect(JSON.stringify(await lastTurn(remote, second))).toContain("went away before it answered");
    // And the question here is withdrawn: nobody waits for its answer.
    await until("the question here to go", async () => (await lentTo(second)).asks.length === 0);
    expect(told(second)!.asks).toEqual([]);
    remote.ws.close();
});

test("a screenshot taken on the lending machine is kept on this one, and the result names this one's file", async () => {
    const { keptHere } = await import("../src/tools/simulator-tools");
    const { paths } = await import("../src/config/paths");
    // A one-pixel PNG, as the lender's result carries it, with the lender's own path in its words.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const theirs = "/Users/me/.cavvy/screenshots/2026-11-13T00-00-00-000Z-abcd.png";
    const r = await keptHere({ content: `Screenshot of the simulator, 390×844: a pixel in it is a point, as SimulatorAct's x and y are. Saved as ${theirs}: to show it to the user, put ![what it shows](${theirs}) in your last message.`, images: [{ type: "image", mediaType: "image/png", data: png }] });
    expect(r.content).not.toContain(theirs);
    const mine = /Saved as (\S+): to show it to the user, put !\[what it shows\]\((\S+)\) in your last message\.$/.exec(r.content)!;
    expect(mine[1]).toBe(mine[2]);
    expect(mine[1]!.startsWith(join(paths.home(), "screenshots"))).toBe(true);
    expect(readFileSync(mine[1]!).length).toBeGreaterThan(20);
    // What has no picture is passed on as it came.
    const plain = { content: "iPhone 17e is running.", isError: false };
    expect(await keptHere(plain)).toBe(plain);
});

/** A call as the server sends one, straight to this machine's lending (Engine.lend), for a session there. */
const lendHere = (tool: string, input: Record<string, unknown>, session = "20261113-000000-aaaaaa") => (mine.engine as any).lend("box", { tool, input, session: { id: session, title: "limits" } }, new AbortController().signal) as Promise<{ text: string; isError?: boolean }>;

test("only what's lent, in bounds: no other tool, no file of this machine's opened, only so many calls a minute", async () => {
    expect(await lendHere("Bash", { command: "id" })).toEqual({ text: "Bash isn't something your Mac lends.", isError: true });
    // Refused before anything is asked of the user, and without a word about what's on this machine.
    expect(await lendHere("SimulatorControl", { action: "open_url", url: "file:///etc/hosts" })).toMatchObject({ isError: true, text: expect.stringContaining("can't open a file: address on your Mac") });
    const none = await lendHere("SimulatorControl", { action: "install", app: "/no/such/Thing.app" });
    expect([none.isError, none.text]).toEqual([true, "There's no app at that path on your Mac. It has to be built there first."]);
    // Reading is let through a hundred and twenty times a minute for one server, then not.
    const answers = await Promise.all(Array.from({ length: 125 }, () => lendHere("SimulatorControl", { action: "list" })));
    const refused = answers.filter((a) => a.text.startsWith("That's more simulator calls in a minute"));
    expect(refused.length).toBeGreaterThanOrEqual(5);
    expect(answers.filter((a) => !a.isError).length).toBeGreaterThan(100);
    // All for one session there: one session here, however many came at once, and the windows on the server know
    // of it though it never asked anything (every call here only read, or was refused).
    const ids = () => new Set(here.events.filter((e) => e.type === "offers.session" && e.sessionId === "20261113-000000-aaaaaa" && e.lent.id).map((e) => e.lent.id));
    await until("its session here to be known", () => ids().size > 0);
    expect(ids().size).toBe(1);
});

test("the session here that a session there is lent through goes by itself once it has sat unused, and the next call gets another", async () => {
    const call = (session: string) => (mine.engine as any).lend("box", { tool: "SimulatorSnapshot", input: {}, session: { id: session, title: session } }, new AbortController().signal);
    // The test before used up this minute's calls for the server: a new minute.
    (mine.engine as any).lentAt.clear();
    await call("one");
    await until("its session here", () => Boolean(told("one")?.id));
    const first = told("one")!.id!;
    // Unused for a while (four seconds here): gone, and the windows on the server are told there's none.
    await until("it to be closed", () => told("one")!.id === undefined, 15_000);
    expect(mine.engine.runtimes.has(first)).toBe(false);
    expect((await lentTo("one")).id).toBeUndefined();
    // The session there goes on being lent to, through a new one here.
    await call("one");
    await until("another session here", () => Boolean(told("one")?.id));
    expect(told("one")!.id).not.toBe(first);
});

test("a session that's only looked at has nothing made for it here; once the user starts a device in its pane there's one, shown in the windows on that server", async () => {
    (mine.engine as any).lentAt.clear();
    const sessions = mine.engine.runtimes.size;
    // Looked at, however often: what could be started is said, and nothing is made.
    for (let i = 0; i < 3; i++) {
        const looked = await lentTo("by-hand");
        expect([looked.offered, looked.id, looked.asks, looked.state?.status, looked.state?.devices.map((d) => d.udid)]).toEqual([true, undefined, [], "off", ["AAAA"]]);
    }
    expect(mine.engine.runtimes.size).toBe(sessions);
    const opened = (await here.call("offers.session", { name: "box", sessionId: "by-hand", title: "By hand", open: true })) as LentSession;
    expect(typeof opened.id).toBe("string");
    expect((await lentTo("by-hand")).id).toBe(opened.id);
    // Its folder isn't one of the user's projects, and it's in no list of sessions.
    expect(JSON.stringify(await here.call("projects.recent"))).not.toContain("guests");
    expect(((await here.call("sessions.list", { limit: 200 })) as { id: string }[]).some((x) => x.id === opened.id)).toBe(false);
    // What its simulator does is told to this machine's windows that are on that server, though none has it open.
    here.events.length = 0;
    await here.call("simulator.command", { id: opened.id, command: "select", udid: "AAAA" });
    await until("its simulator to be told of", () => here.events.some((e) => e.type === "simulator.state" && e.sessionId === opened.id));
    // The pane asks this machine about it by that id, as it would about a session here.
    const state = await here.call("simulator.state", { id: opened.id });
    expect([state.status, state.devices.map((d: { udid: string }) => d.udid)]).toEqual(["off", ["AAAA"]]);
    // What the agent there does next is done on the same one.
    await (mine.engine as any).lend("box", { tool: "SimulatorControl", input: { action: "list" }, session: { id: "by-hand", title: "By hand" } }, new AbortController().signal);
    expect((await lentTo("by-hand")).id).toBe(opened.id);
    // Only for the user's own servers, and sessions that could be ones.
    await expect(here.call("offers.session", { name: "nowhere", sessionId: "by-hand" })).rejects.toThrow("No server is called nowhere.");
    await expect(here.call("offers.session", { name: "box", sessionId: "../x" })).rejects.toThrow("That isn't a session's id.");
    // A server's own Cavvy lends nothing.
    const at = await here.call("servers.connect", { name: "box" });
    const onIt = new Window(at.url, at.token);
    expect(await onIt.opened.promise).toBe(true);
    await expect(onIt.call("offers.session", { name: "box", sessionId: "by-hand" })).rejects.toThrow("This machine lends nothing.");
    onIt.ws.close();
});

test("a call this machine can't take now is answered, not left waiting: over four at once, or too long", async () => {
    const { MachineWatch } = await import("../src/servers/watch");
    const results: { callId: string; text: string; isError?: boolean }[] = [];
    const srv = Bun.serve({
        port: 0,
        fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
        websocket: {
            message(ws, raw) {
                const m = JSON.parse(String(raw));
                if (m.method === "offers.result") return void results.push(m.params);
                if (m.method !== "sessions.list") return;
                ws.send(JSON.stringify({ id: m.id, result: [] }));
                // Once, on the list of those in play (the archived are asked for after it).
                if (m.params?.archived) return;
                for (let i = 0; i < 6; i++) ws.send(JSON.stringify({ event: { type: "offers.call", callId: `c${i}`, tool: "SimulatorControl", input: { action: "boot" }, session: { id: `s${i}`, title: "t" } } }));
                ws.send(JSON.stringify({ event: { type: "offers.call", callId: "long", tool: "SimulatorAct", input: { action: "type", text: "x".repeat(20_000) }, session: { id: "s9", title: "t" } } }));
                ws.send(JSON.stringify({ event: { type: "offers.call", callId: "odd", tool: 7, input: {}, session: { id: "../x" } } }));
            },
        },
    });
    const started: string[] = [];
    // The user never answers the first four.
    const watch = new MachineWatch("box", { reach: async () => ({ status: "connected", url: `ws://127.0.0.1:${srv.port}/ws`, token: "t" }), changed: () => {}, notice: () => {}, lends: () => ["simulator"], lend: (c) => (started.push(c.session.id), new Promise(() => {})) });
    watch.start();
    try {
        await until("the ones turned away to be answered", () => results.length === 4);
        expect(started).toEqual(["s0", "s1", "s2", "s3"]);
        expect(results.map((r) => [r.callId, r.isError, r.text.split(" ").slice(0, 5).join(" ")])).toEqual([
            ["c4", true, "Your Mac is still on"],
            ["c5", true, "Your Mac is still on"],
            ["long", true, "That call's input is too"],
            ["odd", true, "That call isn't one your"],
        ]);
    } finally {
        watch.stop();
        void srv.stop(true);
    }
});

test("two of the user's machines can lend to one server: one leaving doesn't take the tools away while the other is there", async () => {
    const { Engine } = await import("../src/server/engine");
    const { lent } = await import("../src/tools/lent");
    const engine = new Engine({ away: true });
    const client = () => {
        const events: any[] = [];
        const c = { subs: new Set<string>(), send: (e: any) => void events.push(e), events };
        engine.clients.add(c as never);
        return c;
    };
    const a = client();
    const b = client();
    try {
        await engine.handle(a as never, "offers.set", { kinds: ["simulator"] });
        await engine.handle(b as never, "offers.set", { kinds: ["simulator", "something-else"] });
        expect(lent("simulator")).toBe(true);
        // A call goes to the one that said so last, and ends when that one leaves.
        const answer = engine.borrow({ id: "s1", title: "t", firstPrompt: () => undefined, ws: { cwd: "/srv/app" } } as never, "SimulatorSnapshot", {}, new AbortController().signal);
        expect([a.events.length, b.events.map((e) => e.type)]).toEqual([0, ["offers.call"]]);
        engine.dropClient(b as never);
        expect(await answer).toEqual({ content: "Your Mac's Cavvy went away before it answered.", isError: true });
        // The other still lends: sessions keep the tools, and the next call goes to it.
        expect(lent("simulator")).toBe(true);
        void engine.borrow({ id: "s1", title: "t", firstPrompt: () => undefined, ws: { cwd: "/srv/app" } } as never, "SimulatorSnapshot", {}, new AbortController().signal);
        expect(a.events.map((e) => e.type)).toEqual(["offers.call"]);
        engine.dropClient(a as never);
        expect(lent("simulator")).toBe(false);
        // With nobody lending any more, a call says what to do about it (a CLI there keeps its tools for as long as it runs).
        expect((await engine.borrow({ id: "s1", title: "t", firstPrompt: () => undefined, ws: { cwd: "/srv/app" } } as never, "SimulatorSnapshot", {}, new AbortController().signal)).content).toStartWith("This runs on your Mac, and Cavvy there isn't connected to this machine right now.");
    } finally {
        await engine.stop();
    }
});

test("on a machine with no simulators, a session that's lent to sends its call to the lender; one that isn't runs it here", async () => {
    const { SIMULATOR_TOOLS } = await import("../src/tools/simulator-tools");
    const list = SIMULATOR_TOOLS.find((t) => t.name === "SimulatorControl")!;
    const ctx = (state: object) => ({ state: { cwd: "/tmp", projectRoot: "/tmp", ...state }, settings: {}, signal: new AbortController().signal }) as never;
    simctl.setAvailability({ ok: false, error: "Simulators need macOS." });
    try {
        // A server's session (it has `lends`), whether or not a Mac is connected just now: the lender's answer, or the engine's word that none is there.
        expect(await list.run({ action: "list" }, ctx({ lends: { call: async (tool: string) => ({ content: `from the lender: ${tool}` }) } }))).toEqual({ content: "from the lender: SimulatorControl" });
        // A session of this machine's own (no `lends`): it runs here, whatever comes of that (the faked simctl
        // answers; a Mac whose Xcode isn't usable says so), with not a word about another machine.
        expect((await list.run({ action: "list" }, ctx({}))).content).toStartWith("Simulators:");
    } finally {
        simctl.setAvailability({ ok: true, developerDir: "/Applications/Xcode.app/Contents/Developer" });
    }
});

test("the Simulator turned off on the Mac while it's connected: the session there is told that, not that the Mac went away", async () => {
    const { Engine } = await import("../src/server/engine");
    const { MachineWatch } = await import("../src/servers/watch");
    const { lent } = await import("../src/tools/lent");
    const engine = new Engine({ away: true });
    // A server's Cavvy, as far as a connection to it goes: its messages handed to the engine.
    const srv = Bun.serve<{ client: any }, never>({
        port: 0,
        fetch: (req, s) => (s.upgrade(req, { data: { client: undefined } }) ? undefined : new Response("no")),
        websocket: {
            open(ws) {
                ws.data.client = { subs: new Set(), send: (ev: unknown) => void ws.send(JSON.stringify({ event: ev })) };
                engine.clients.add(ws.data.client);
            },
            async message(ws, raw) {
                const m = JSON.parse(String(raw));
                if (m.method === "sessions.list") return void ws.send(JSON.stringify({ id: m.id, result: [] }));
                ws.send(JSON.stringify({ id: m.id, result: (await engine.handle(ws.data.client, m.method, m.params).catch(() => null)) ?? null }));
            },
            close: (ws) => engine.dropClient(ws.data.client),
        },
    });
    let kinds = ["simulator"];
    const watch = new MachineWatch("box", { reach: async () => ({ status: "connected", url: `ws://127.0.0.1:${srv.port}/ws`, token: "t" }), changed: () => {}, notice: () => {}, lends: () => kinds, lend: async () => ({ text: "ran" }) });
    watch.start();
    try {
        await until("the Mac to be lending", () => lent("simulator"));
        kinds = [];
        const told = await engine.borrow({ id: "s1", title: "t", firstPrompt: () => undefined, ws: { cwd: "/srv/app" } } as never, "SimulatorSnapshot", {}, new AbortController().signal);
        expect(told).toEqual({ content: "Your Mac's Simulator isn't available now: it's turned off in Cavvy's settings there, or Xcode isn't set up.", isError: true });
        // And the server's sessions stop being offered what can't run.
        await until("the tools to be taken away", () => !lent("simulator"));
    } finally {
        watch.stop();
        void srv.stop(true);
        await engine.stop();
    }
});

test("asks from one server ring the user a few times a minute, then once more to say there are others", async () => {
    (mine.engine as any).lentAt.clear();
    await lendHere("SimulatorControl", { action: "list" }, "20261113-000000-bbbbbb");
    const guestRt = [...mine.engine.runtimes.values()].find((r: any) => r.guestOf === "box" && r.guestSession?.id === "20261113-000000-bbbbbb")!;
    here.events.length = 0;
    for (let i = 0; i < 10; i++) mine.engine.notify(guestRt as never, "permission", `Wants to tap ${i}`);
    await until("them to arrive", () => here.events.filter((e) => e.type === "servers.notify").length >= 7);
    await Bun.sleep(200);
    // Each told as the session there.
    expect(new Set(here.events.filter((e) => e.type === "servers.notify").map((e) => [e.name, e.sessionId, e.title, e.lent].join())).size).toBe(1);
    // A window that comes late (reloaded, say) learns which sessions there this machine asks for: none now, since
    // these were only told of, not asked.
    expect(await here.call("offers.asking", { name: "box" })).toEqual([]);
    expect(here.events.find((e) => e.type === "servers.notify")).toMatchObject({ name: "box", sessionId: "20261113-000000-bbbbbb", title: "limits", lent: true });
    const rang = () => here.events.filter((e) => e.type === "servers.notify").map((e) => e.body);
    expect(rang()).toEqual(["Wants to tap 0", "Wants to tap 1", "Wants to tap 2", "Wants to tap 3", "Wants to tap 4", "Wants to tap 5", "More from box is waiting for you."]);
    // The user answers one (they're there): what the server's sessions ask next rings again, from the start.
    here.events.length = 0;
    (mine.engine as any).guestAnswered("box");
    mine.engine.notify(guestRt as never, "permission", "Wants to tap again");
    await until("it to ring", () => rang().length === 1);
    expect(rang()).toEqual(["Wants to tap again"]);
});

test("each call runs under this machine's mode as it is now, not the one it had when the session there first used it", async () => {
    (mine.engine as any).lentAt.clear();
    const session = "20261113-000000-cccccc";
    // The session here for it is made while this machine is in Manual.
    await lendHere("SimulatorControl", { action: "list" }, session);
    await here.call("settings.update", { patch: { allowBypass: true, defaultMode: "bypassPermissions" } });
    try {
        const before = ran.length;
        // Nothing is asked (nobody answers here): it goes straight to the device.
        const free = await lendHere("SimulatorControl", { action: "boot", device: "iPhone 17" }, session);
        expect([free.text.includes("declined"), ran.slice(before).some((a) => a[2] === "bootstatus")]).toEqual([false, true]);
        // Back in Manual: the same session's next call asks, though this machine didn't when it began there.
        await here.call("settings.update", { patch: { defaultMode: "default" } });
        const seen = new Set<string>();
        const asked = lendHere("SimulatorControl", { action: "shutdown" }, session);
        await answerLent(session, "no", seen);
        expect((await asked).text).toContain("declined");
        // Bypass again, then only "Allow bypass mode" turned off (the mode set stays Bypass): it asks, as a session
        // that starts now would, and nothing is said over and over in the session here.
        await here.call("settings.update", { patch: { defaultMode: "bypassPermissions" } });
        await lendHere("SimulatorControl", { action: "boot", device: "iPhone 17" }, session);
        await here.call("settings.update", { patch: { allowBypass: false } });
        const guest = [...mine.engine.runtimes.values()].find((r: any) => r.guestOf === "box" && r.guestSession?.id === session) as any;
        const notices = () => JSON.stringify(guest.view ?? guest.session.messages ?? "").split("Bypass mode is off").length - 1;
        const said = notices();
        const again = lendHere("SimulatorControl", { action: "shutdown" }, session);
        await answerLent(session, "no", seen);
        expect([(await again).text.includes("declined"), guest.mode]).toEqual([true, "default"]);
        // And the next: the session here is in Manual, the mode set is still Bypass, and nothing says so each call.
        const next = lendHere("SimulatorControl", { action: "shutdown" }, session);
        await answerLent(session, "no", seen);
        expect([(await next).text.includes("declined"), guest.mode, notices() - said]).toEqual([true, "default", 0]);
    } finally {
        await here.call("settings.update", { patch: { allowBypass: false, defaultMode: "default" } });
    }
});

test("this machine's Cavvy quitting while its question waits: the session there is told it went away, not that the user said no", async () => {
    // An earlier test stopped this machine listening to the server: it listens again, and lends.
    (mine.engine as any).serverLinks.watches.delete("box");
    await here.call("servers.overview");
    await until("this machine to be connected there", () => here.machine("box")?.state === "connected");
    remote = new Window(there.url, there.token);
    expect(await remote.opened.promise).toBe(true);
    const id = await sessionThere();
    await remote.call("session.send", { id, text: "simulator at the end" });
    await answer(remote, id, "yes");
    await until("the question here", async () => (await lentTo(id)).asks.length > 0);
    // Quitting ends this machine's way to the server too, so what the session there was told is read from its record.
    await mine.engine.stop();
    const record = () => [...new Bun.Glob(`**/${id}.jsonl`).scanSync({ cwd: join(fake.home, ".cavvy"), absolute: true })].map((f) => readFileSync(f, "utf8")).join("");
    await until("the session there to be told", () => record().includes("went away before it answered"));
    expect(record()).not.toContain("declined this tool call");
});
