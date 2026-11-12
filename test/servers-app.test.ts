// Servers from a window: the calls the GUI makes to its own Cavvy (src/servers/manager.ts through
// src/server/engine.ts), run for real against the pretend server (test/helpers/fake-ssh.ts): adding one, its
// host key, connecting a window to the Cavvy there through the tunnel, a dropped tunnel, stopping and removing.

import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";
import { fakeSsh } from "./helpers/fake-ssh";

setDefaultTimeout(60_000);

const iso = isolate();
const fake = fakeSsh();
const A = "aaaaaaaaaaaa-1";

const { startMockLlm } = await import("../scripts/mock-llm");
const { startServer } = await import("../src/server/server");
const { setUpServer } = await import("../src/servers/install");
const { stopRemote } = await import("../src/servers/service");
import type { BuildSource } from "../src/servers/build";
import type { ServerEntry } from "../src/servers/store";

const mock = startMockLlm({ delayMs: 0 });
mkdirSync(join(fake.home, ".cavvy"), { recursive: true });
writeFileSync(join(fake.home, ".cavvy", "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(fake.home, ".cavvy", "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));

// With its GUI beside it, as a build made on this machine has: nothing is missing that a second set-up would send.
const source: BuildSource = { id: A, gui: true, build: async () => fake.bundle(A, { gui: true }), compare: (theirs: string) => (theirs === A ? "same" : "older") } as BuildSource;
// The pretend server, with Cavvy on it, as a machine that was set up before under another name.
const first: ServerEntry = { name: "first", destination: "dev@first.example", addedAt: new Date().toISOString() };
fake.trust("first.example");
await setUpServer(first, { source });

/** A window: a WebSocket to a Cavvy, with calls, their replies, and what it's told meanwhile. */
class Window {
    ws: WebSocket;
    events: any[] = [];
    private next = 1;
    private waiting = new Map<number, (m: { result?: any; error?: { message: string } }) => void>();
    opened = Promise.withResolvers<boolean>();
    closed = Promise.withResolvers<number>();

    constructor(url: string, token: string) {
        this.ws = new WebSocket(url, ["cavvy.v1", `auth.${token}`]);
        this.ws.onopen = () => this.opened.resolve(true);
        this.ws.onerror = () => this.opened.resolve(false);
        this.ws.onclose = (e) => {
            this.opened.resolve(false);
            this.closed.resolve(e.code);
        };
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
        return m.result;
    }
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 20_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await ok()) return;
        await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
}

// This machine's own Cavvy: its build is the one the pretend server has, so nothing is compiled or copied.
const mine = await startServer({ token: "mine", serverBuilds: source });
const here = new Window(`ws://127.0.0.1:${mine.port}/ws`, "mine");
expect(await here.opened.promise).toBe(true);

afterEach(() => {
    fake.fail();
    fake.unhold();
});

afterAll(async () => {
    here.ws.close();
    await mine.stop().catch(() => undefined);
    await stopRemote(first).catch(() => undefined);
    mock.stop();
    fake.cleanup();
    iso.cleanup();
});

describe("servers, from a window", () => {
    let there: { url: string; token: string };

    test("adding one: its key is shown first and saved only on the user's word; then it's set up and listed", async () => {
        expect(await here.call("servers.list")).toEqual({ servers: [{ name: "first", destination: "dev@first.example", connected: false }].slice(0, 0) });
        const asked = await here.call("servers.add", { name: "box", destination: "dev@box.example" });
        expect(asked).toMatchObject({ status: "unknown-host", unknown: { host: "box.example", fingerprints: [expect.stringMatching(/^SHA256:\S+ \(ED25519\)$/)] } });
        expect(fake.knownHosts()).not.toContain("box.example");
        expect((await here.call("servers.list")).servers).toEqual([]);
        // A yes to some other key than the one shown is no yes.
        await expect(here.call("servers.add", { name: "box", destination: "dev@box.example", trust: ["SHA256:someOtherKey (ED25519)"] })).rejects.toThrow("That key is no longer the one on offer. Try again.");

        const again = await here.call("servers.add", { name: "box", destination: "dev@box.example" });
        const added = await here.call("servers.add", { name: "box", destination: "dev@box.example", trust: again.unknown.fingerprints });
        expect(added).toMatchObject({ status: "added", name: "box" });
        expect(fake.knownHosts()).toContain("box.example ");
        expect((await here.call("servers.list")).servers).toEqual([{ name: "box", destination: "dev@box.example", connected: false }]);
        // What was happening was said to the window that asked.
        expect(here.events.filter((e) => e.type === "servers.progress").map((e) => e.text)).toContain("Connecting to box.example…");
        expect(await here.call("servers.add", { name: "box", destination: "dev@elsewhere.example" })).toEqual({ status: "failed", problem: { message: "There's already a server named box." } });
        expect(await here.call("servers.add", { name: "Not A Name", destination: "dev@box.example" })).toMatchObject({ status: "failed", problem: { message: expect.stringContaining("A server's name is lowercase") } });
    });

    test("one that can't be reached is said in plain words, with ssh's own line", async () => {
        fake.fail("timeout");
        expect(await here.call("servers.connect", { name: "box" })).toEqual({ status: "failed", problem: { message: "Can't reach box.example.", detail: "ssh: connect to host box.example port 22: Operation timed out" } });
        expect(await here.call("servers.connect", { name: "nope" })).toMatchObject({ status: "failed", problem: { message: expect.stringContaining("No server named nope") } });
    });

    test("what it has and lacks", async () => {
        const check = await here.call("servers.check", { name: "box" });
        expect(check).toMatchObject({ running: true, current: true, git: expect.any(Boolean), service: false });
        expect(check.clis.map((c: any) => c.id)).toContain("claude-code");
        expect(check.clis.every((c: any) => c.installed === false)).toBe(true);
    });

    test("connecting: a window reaches the Cavvy there through the tunnel, signed in; that Cavvy offers no servers of its own", async () => {
        const r = await here.call("servers.connect", { name: "box" });
        expect(r).toEqual({ status: "connected", url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/), token: expect.stringMatching(/^[\w-]{20,}$/) });
        there = r;
        expect((await here.call("servers.list")).servers).toEqual([{ name: "box", destination: "dev@box.example", connected: true }]);
        const remote = new Window(r.url, r.token);
        expect(await remote.opened.promise).toBe(true);
        expect(await remote.call("hello", { client: "browser" })).toMatchObject({ protocol: expect.any(Number) });
        await expect(remote.call("servers.list")).rejects.toThrow("Servers are managed from your own machine.");
        // Asked again, with the connection up: the same address and sign-in, and no second connection.
        const calls = fake.calls().length;
        expect(await here.call("servers.connect", { name: "box" })).toEqual(r);
        expect(fake.calls().length).toBe(calls);
        remote.ws.close();
    });

    test("a tunnel that drops comes back on the same address, and every window is told both", async () => {
        here.events.length = 0;
        expect(fake.dropTunnel()).toBe(true);
        await until("the windows to be told it's back", () => here.events.some((e) => e.type === "servers.link" && e.state === "connected"));
        expect(here.events.filter((e) => e.type === "servers.link").map((e) => [e.name, e.state])).toEqual([
            ["box", "reconnecting"],
            ["box", "connected"],
        ]);
        // The Cavvy there didn't restart, so what signed the window in still does.
        expect(await here.call("servers.connect", { name: "box" })).toEqual(there);
        const remote = new Window(there.url, there.token);
        expect(await remote.opened.promise).toBe(true);
        remote.ws.close();
    });

    test("stopped there, the windows are told; opening it starts it again, with a new sign-in", async () => {
        here.events.length = 0;
        await here.call("servers.stop", { name: "box" });
        expect(await here.call("servers.check", { name: "box" })).toMatchObject({ running: false });
        expect((await here.call("servers.list")).servers[0].connected).toBe(false);
        const r = await here.call("servers.connect", { name: "box" });
        expect(r.status).toBe("connected");
        expect(r.token).not.toBe(there.token);
        const old = new Window(r.url, there.token);
        expect(await old.opened.promise).toBe(false);
        const remote = new Window(r.url, r.token);
        expect(await remote.opened.promise).toBe(true);
        remote.ws.close();
        there = r;
    });

    test("updating: level already, it says so and the window signs in again", async () => {
        expect(await here.call("servers.update", { name: "box" })).toEqual({ status: "updated" });
        expect((await here.call("servers.list")).servers[0].connected).toBe(false);
        const r = await here.call("servers.connect", { name: "box" });
        expect(r.status).toBe("connected");
        const remote = new Window(r.url, r.token);
        expect(await remote.opened.promise).toBe(true);
        remote.ws.close();
        there = r;
        await expect(here.call("servers.update", { name: "nope" })).rejects.toThrow("No server named nope");
    });

    test("disconnecting signs this Cavvy out there and leaves the Cavvy there running", async () => {
        await here.call("servers.disconnect", { name: "box" });
        expect((await here.call("servers.list")).servers[0].connected).toBe(false);
        expect(await here.call("servers.check", { name: "box" })).toMatchObject({ running: true });
        // Its sign-in is gone with it: through a new connection, the old one opens nothing.
        const r = await here.call("servers.connect", { name: "box" });
        expect(r.status).toBe("connected");
        const old = new Window(r.url, there.token);
        expect(await old.opened.promise).toBe(false);
    });

    test("removing: forgotten here, signed out there; undone, it's listed again and opens with a new sign-in", async () => {
        expect(await here.call("servers.remove", { name: "box" })).toEqual({ signedOut: true });
        expect((await here.call("servers.list")).servers).toEqual([]);
        await expect(here.call("servers.check", { name: "box" })).rejects.toThrow("No server named box");

        expect(await here.call("servers.restore", { name: "box" })).toBeNull();
        expect((await here.call("servers.list")).servers).toEqual([{ name: "box", destination: "dev@box.example", connected: false }]);
        // Once: there's nothing left to put back.
        await expect(here.call("servers.restore", { name: "box" })).rejects.toThrow("box can't be put back. Add it again.");
        const r = await here.call("servers.connect", { name: "box" });
        expect(r.status).toBe("connected");
        const remote = new Window(r.url, r.token);
        expect(await remote.opened.promise).toBe(true);
        remote.ws.close();
        expect(await here.call("servers.remove", { name: "box" })).toEqual({ signedOut: true });
    });
});
