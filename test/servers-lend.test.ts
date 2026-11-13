// A server's sessions using the simulators of the user's own machine (src/tools/lent.ts, Engine.borrow and
// Engine.lend, src/servers/watch.ts), for real against the pretend server (test/helpers/fake-ssh.ts), with simctl
// faked on this machine: the call travels there and back, runs through this machine's own checks in a session of
// its own, and ends plainly when the user says no or this machine goes away.

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
import type { MachineOverview, SessionSnapshot } from "../src/server/protocol";

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
/** This machine's session that a server's session is lent tools through. */
const known = new Set<string>();
/** The one made since the last was taken: each session there gets its own here. */
const guest = () => here.events.find((e) => e.type === "sessions.upsert" && e.session.title.startsWith("box: ") && !known.has(e.session.id))?.session as { id: string; title: string } | undefined;
async function nextGuest(): Promise<{ id: string; title: string }> {
    await until("this machine's session for it", () => Boolean(guest()));
    const g = guest()!;
    known.add(g.id);
    return g;
}

let there: { url: string; token: string };
let remote: Window;

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

test("a call from a session there runs here, after this machine's own asking, in a session named for it; the result goes back", async () => {
    const id = (await remote.call("session.create", { cwd: tempDir("cavvy-lend-proj-") })).state.id as string;
    await remote.call("session.send", { id, text: "simulator please" });
    // The server's own asking first (it starts in Manual here), then this machine's.
    expect((await answer(remote, id, "yes")).kind).toBe("permission");
    const mineId = (await nextGuest()).id;
    // Named for the server and the session there (the title the mock model gives any such session).
    expect(here.events.findLast((e) => e.type === "sessions.upsert" && e.session.id === mineId).session.title).toBe("box: Check the app in the simulator");
    expect(ran.some((a) => a[2] === "boot")).toBe(false);
    const asked = await answer(here, mineId, "yes");
    expect(JSON.stringify(asked)).toContain("SimulatorControl(boot)");
    await until("the turn there to end", async () => (await lastTurn(remote, id)).status === "done");
    // It ran here: this machine's simctl was asked about this machine's device, which the server knows nothing of,
    // and the server's model read what this machine said.
    expect(ran.some((a) => a.join(" ") === "xcrun simctl bootstatus AAAA -b")).toBe(true);
    const turn = await lastTurn(remote, id);
    expect(turn.blocks.find((b) => b.t === "tool")).toMatchObject({ name: "SimulatorControl", output: expect.stringContaining("AAAA") });
    expect(textOf(turn)).toContain("I couldn't find Settings on the screen: ");
    // And it's noted here, in the session it ran in.
    const mine = (await here.call("session.open", { id: mineId })) as SessionSnapshot;
    expect(JSON.stringify(mine.turns)).toContain("SimulatorControl(boot)");
    // Long after, with no window on it here: the same session there is still lent through the same session here.
    await here.call("session.close", { id: mineId }).catch(() => undefined);
    await Bun.sleep(1500);
    const before = ran.filter((a) => a[2] === "bootstatus").length;
    await remote.call("session.send", { id, text: "simulator once again" });
    await until("the second turn there to end", async () => (await remote.call("session.open", { id })).turns.length === 2 && (await lastTurn(remote, id)).status === "done");
    // It ran here again (allowed for this session the first time, on both machines, as the tool is anywhere),
    // and no second session was made here for it.
    expect(ran.filter((a) => a[2] === "bootstatus").length).toBe(before + 1);
    expect(guest()).toBeUndefined();
});

test("the user's no here is what the session there is told; this machine going away ends a call that waits", async () => {
    const seen = new Set<string>();
    const id = (await remote.call("session.create", { cwd: tempDir("cavvy-lend-proj-") })).state.id as string;
    await remote.call("session.send", { id, text: "simulator again" });
    await answer(remote, id, "yes");
    await answer(here, (await nextGuest()).id, "no", seen);
    await until("the turn there to end", async () => (await lastTurn(remote, id)).status === "done");
    expect(JSON.stringify(await lastTurn(remote, id))).toContain("declined");

    const second = (await remote.call("session.create", { cwd: tempDir("cavvy-lend-proj-") })).state.id as string;
    await remote.call("session.send", { id: second, text: "simulator once more" });
    await answer(remote, second, "yes");
    const waits = (await nextGuest()).id;
    // While this machine's question waits, its Cavvy stops listening to the server (as when it quits): only that
    // connection goes, so what the session there is told can still be read through the window's own.
    await until("the question here", async () => ((await here.call("session.open", { id: waits })) as SessionSnapshot).state.interactions.length > 0);
    (mine.engine as any).serverLinks.watches.get("box").stop();
    await until("the turn there to end", async () => (await lastTurn(remote, second)).status === "done");
    expect(JSON.stringify(await lastTurn(remote, second))).toContain("went away before it answered");
    // And the question here is withdrawn: nobody waits for its answer.
    await until("the question here to go", async () => ((await here.call("session.open", { id: waits })) as SessionSnapshot).state.interactions.length === 0);
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
    // All for one session there: one session here, however many came at once.
    const rows = () => new Set(here.events.filter((e) => e.type === "sessions.upsert" && e.session.title === "box: limits").map((e) => e.session.id));
    // Shown to the window though it never asked anything (every call here only read, or was refused).
    await until("its session here to be shown", () => rows().size > 0);
    expect(rows().size).toBe(1);
});

test("the session here that a session there is lent through can be deleted, and goes by itself once it has sat unused", async () => {
    const id = (session: string) => here.events.findLast((e) => e.type === "sessions.upsert" && e.session.title === `box: ${session}`)?.session.id as string | undefined;
    const call = (session: string) => (mine.engine as any).lend("box", { tool: "SimulatorSnapshot", input: {}, session: { id: session, title: session } }, new AbortController().signal);
    // The test before used up this minute's calls for the server: a new minute.
    (mine.engine as any).lentAt.clear();
    await call("one");
    await until("its session here", () => Boolean(id("one")));
    const first = id("one")!;
    // Nothing was ever said in it, so there's no file to put in the trash: deleting it just closes it.
    await here.call("session.delete", { id: first });
    expect(here.events.some((e) => e.type === "sessions.remove" && e.id === first)).toBe(true);
    expect(((await here.call("sessions.list", { limit: 200 })) as { id: string }[]).some((x) => x.id === first)).toBe(false);
    // The session there goes on being lent to, through a new one here.
    here.events.length = 0;
    await call("one");
    await until("another session here", () => Boolean(id("one")) && id("one") !== first);
    const second = id("one")!;
    // Unused for a while (four seconds here), with no window on it: gone, without being asked to.
    await until("it to be closed", () => here.events.some((e) => e.type === "sessions.remove" && e.id === second), 15_000);
    expect(mine.engine.runtimes.has(second)).toBe(false);
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
    } finally {
        await engine.stop();
    }
});
