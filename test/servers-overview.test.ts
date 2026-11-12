// The other machines' sessions, from a window (servers.overview: src/servers/watch.ts, src/servers/manager.ts,
// src/server/engine.ts), for real against the pretend server (test/helpers/fake-ssh.ts): a server's sessions are
// listed and kept up to date, what one has to tell its user reaches one window, and nothing is started there.

import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { fakeSsh } from "./helpers/fake-ssh";

setDefaultTimeout(60_000);

const iso = isolate();
const fake = fakeSsh();
const A = "aaaaaaaaaaaa-1";

const { startMockLlm } = await import("../scripts/mock-llm");
const { startServer } = await import("../src/server/server");
const { remoteStatus, stopRemote } = await import("../src/servers/service");
import type { BuildSource } from "../src/servers/build";
import type { MachineOverview } from "../src/server/protocol";

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

afterAll(async () => {
    here.ws.close();
    await mine.stop().catch(() => undefined);
    await stopRemote({ name: "box", destination: "dev@box.example", addedAt: "" }).catch(() => undefined);
    mock.stop();
    fake.cleanup();
    iso.cleanup();
});

/** A session on the server, with one finished turn, made from a connection of its own there. */
async function sessionThere(at: { url: string; token: string }, text: string): Promise<string> {
    const remote = new Window(at.url, at.token);
    expect(await remote.opened.promise).toBe(true);
    const id = (await remote.call("session.create", { cwd: tempDir("cavvy-overview-proj-") })).state.id as string;
    await remote.call("session.send", { id, text });
    await until("its turn to end", async () => (await remote.call("session.open", { id })).turns.at(-1)?.status === "done");
    remote.ws.close();
    return id;
}

test("a window is told whether there are servers at all; with none, nothing of them is asked for", async () => {
    expect((await here.call("hello", { client: "browser" })).servers).toBeUndefined();
    fake.trust("box.example");
    expect(await here.call("servers.add", { name: "box", destination: "dev@box.example" })).toMatchObject({ status: "added" });
    expect((await here.call("hello", { client: "browser" })).servers).toBe(1);
});

let there: { url: string; token: string };
let onBox: Window;

test("a server's sessions are listed, the ones waiting or working first, and kept up to date", async () => {
    const first = (await here.call("servers.overview")).machines as MachineOverview[];
    expect(first.map((m) => m.name)).toEqual(["box"]);
    await until("its sessions to be listed", () => here.machine("box")?.state === "connected");
    expect(here.machine("box")!.sessions).toEqual([]);
    // A window on the server (it asked this Cavvy to connect it there) makes a session there.
    onBox = await window();
    there = await onBox.call("servers.connect", { name: "box" });
    expect(there).toMatchObject({ status: "connected" });
    const id = await sessionThere(there, "say hi");
    await until("the session to be listed here", () => here.machine("box")?.sessions.some((s) => s.id === id && s.status === "idle") ?? false);
    // Asked again (another window, or this one reloaded): what's known already, at once.
    const second = await window();
    const again = (await second.call("servers.overview")).machines as MachineOverview[];
    expect(again[0]!.sessions.map((s) => s.id)).toEqual([id]);
    await second.close();
    // One that's working goes before one that's done.
    const remote = new Window(there.url, there.token);
    await remote.opened.promise;
    const busy = (await remote.call("session.create", { cwd: tempDir("cavvy-overview-proj-") })).state.id as string;
    await remote.call("session.send", { id: busy, text: "hangforever please" });
    await until("the working one to be first", () => here.machine("box")?.sessions[0]?.id === busy && here.machine("box")!.sessions[0]!.status === "running");
    expect(here.machine("box")!.sessions.map((s) => s.id)).toEqual([busy, id]);
    await remote.call("session.interrupt", { id: busy });
    remote.ws.close();
});

test("what a session there has to tell its user reaches one window here, unless a window is on that server", async () => {
    const said = (w: Window) => w.events.filter((e) => e.type === "servers.notify");
    // A window is on box: it hears it from there, so nothing is passed on here.
    await sessionThere(there, "say hi");
    await Bun.sleep(500);
    expect(said(here)).toEqual([]);
    // That window gone, the next one is passed on, to one window only.
    await onBox.close();
    const other = await window();
    await other.call("servers.overview");
    const id = await sessionThere(there, "say hi");
    await until("it to be said", () => said(here).length + said(other).length > 0);
    await Bun.sleep(300);
    expect([...said(here), ...said(other)]).toEqual([{ type: "servers.notify", name: "box", sessionId: id, kind: "done", title: expect.any(String), body: expect.stringMatching(/^Finished in /) }]);
    await other.close();
});

test("with windows only on servers, what this computer's own session has to say goes to one of them", async () => {
    const away = await window();
    await away.call("servers.connect", { name: "box" });
    await away.call("servers.overview");
    // No window here shows this computer's sessions: `here` asked for the servers' too, so it's taken out of the way.
    await here.close();
    expect([...mine.engine.clients].map((c) => c.machine)).toEqual(["box"]);
    const id = (await away.call("session.create", { cwd: tempDir("cavvy-overview-proj-") })).state.id as string;
    await away.call("session.send", { id, text: "say hi" });
    await until("it to be said", () => away.events.some((e) => e.type === "servers.notify" && e.sessionId === id));
    expect(away.events.find((e) => e.type === "servers.notify" && e.sessionId === id)).toEqual({ type: "servers.notify", sessionId: id, kind: "done", title: expect.any(String), body: expect.stringMatching(/^Finished in /) });
    await away.close();
});

test("a server that was stopped is said to be, and isn't started by being watched; removed, it's gone from the list", async () => {
    const w = await window();
    await w.call("servers.overview");
    await until("it to be connected", () => w.machine("box")?.state === "connected");
    // With a session working there, which would otherwise go on being shown as working.
    const remote = new Window(there.url, there.token);
    await remote.opened.promise;
    const busy = (await remote.call("session.create", { cwd: tempDir("cavvy-overview-proj-") })).state.id as string;
    await remote.call("session.send", { id: busy, text: "hangforever please" });
    await until("it to be shown working", () => w.machine("box")?.sessions.some((s) => s.id === busy && s.status === "running") ?? false);
    await w.call("servers.stop", { name: "box" });
    await until("it to be said stopped", () => w.machine("box")?.state === "stopped");
    expect(w.machine("box")!.sessions).toEqual([]);
    await Bun.sleep(1000);
    expect(await remoteStatus({ name: "box", destination: "dev@box.example", addedAt: "" })).toBeUndefined();
    // Started again by the user, from a window: its sessions are listed again at once, not when the next look is due.
    expect(await w.call("servers.connect", { name: "box" })).toMatchObject({ status: "connected" });
    await until("it to be listed again", () => w.machine("box")?.state === "connected", 10_000);
    // Disconnected on the user's word: it stays apart, said so, until they open it again.
    await w.call("servers.disconnect", { name: "box" });
    await until("it to be said disconnected", () => w.machine("box")?.state === "disconnected");
    await Bun.sleep(500);
    expect((await w.call("servers.list")).servers).toEqual([{ name: "box", destination: "dev@box.example", connected: false }]);
    expect(await w.call("servers.connect", { name: "box" })).toMatchObject({ status: "connected" });
    await until("it to be listed once more", () => w.machine("box")?.state === "connected", 10_000);
    await w.call("servers.remove", { name: "box" });
    await until("it to be gone", () => w.machine("box")?.state === "removed");
    expect((await w.call("servers.overview")).machines).toEqual([]);
    w.ws.close();
});

test("a servers file that can't be read doesn't keep a window from starting", async () => {
    const file = join(iso.home, "servers.json");
    const was = readFileSync(file, "utf-8");
    writeFileSync(file, '{"servers":[');
    try {
        const w = await window();
        const hello = await w.call("hello", { client: "browser" });
        expect([typeof hello.version, hello.servers]).toEqual(["string", undefined]);
        w.ws.close();
    } finally {
        writeFileSync(file, was);
    }
});
