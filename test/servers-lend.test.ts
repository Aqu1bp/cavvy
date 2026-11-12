// A server's sessions using the simulators of the user's own machine (src/tools/lent.ts, Engine.borrow and
// Engine.lend, src/servers/watch.ts), for real against the pretend server (test/helpers/fake-ssh.ts), with simctl
// faked on this machine: the call travels there and back, runs through this machine's own checks in a session of
// its own, and ends plainly when the user says no or this machine goes away.

import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { fakeSsh } from "./helpers/fake-ssh";

setDefaultTimeout(60_000);

// The pretend server has no simulators of its own (its Cavvy inherits this); this machine is given some below.
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

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 30_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await ok()) return;
        await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
}

const mine = await startServer({ token: "mine", serverBuilds: source });
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
    delete process.env.CAVVY_SIMULATOR;
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
    // It ran here: this machine's simctl started this machine's device, and the server's model read what it said.
    expect(ran.some((a) => a.join(" ") === "xcrun simctl boot AAAA")).toBe(true);
    expect(textOf(await lastTurn(remote, id))).toContain("I couldn't find Settings on the screen: Started iPhone 17");
    // And it's noted here, in the session it ran in.
    const mine = (await here.call("session.open", { id: mineId })) as SessionSnapshot;
    expect(JSON.stringify(mine.turns)).toContain("SimulatorControl(boot)");
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
    // While this machine's question waits, its connection there is closed on the user's word.
    await until("the question here", async () => ((await here.call("session.open", { id: waits })) as SessionSnapshot).state.interactions.length > 0);
    await here.call("servers.disconnect", { name: "box" });
    await until("the turn there to end", async () => (await lastTurn(remote, second)).status === "done");
    expect(JSON.stringify(await lastTurn(remote, second))).toContain("went away before it answered");
    // And the question here is withdrawn: nobody waits for its answer.
    await until("the question here to go", async () => ((await here.call("session.open", { id: waits })) as SessionSnapshot).state.interactions.length === 0);
    remote.ws.close();
});
