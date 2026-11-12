// Servers end to end, against a pretend one (test/helpers/fake-ssh.ts): every
// "remote" command really runs, in a home folder of the pretend server's own,
// and the Cavvy "installed" there is this checkout's. What's real: the probe,
// the copy and its checks, starting and stopping the server, signing in over
// "SSH", the tunnel, and the server's own code. What isn't: the network, and
// systemd (the pretend server has none, so Cavvy runs detached there).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { fakeSsh } from "./helpers/fake-ssh";

const iso = isolate();
const fake = fakeSsh();
const { startMockLlm } = await import("../scripts/mock-llm");
const { setUpServer, ServerBusy } = await import("../src/servers/install");
const { probeServer } = await import("../src/servers/remote");
const { offeredHostKey, trustHostKey, SshError } = await import("../src/servers/ssh");
const { ServerLink, exchangeCode } = await import("../src/servers/connect");
const { remoteStatus, revokeOverSsh, stopRemote, serviceTiming, UpdateFailed } = await import("../src/servers/service");
const { thisDesktop } = await import("../src/servers/store");
import type { BuildSource } from "../src/servers/build";
import type { LinkState } from "../src/servers/connect";
import type { ServerEntry } from "../src/servers/store";

const entry: ServerEntry = { name: "box", destination: "dev@box.example", addedAt: new Date().toISOString() };
const serverDir = join(fake.home, ".cavvy", "server");

// The pretend server's Cavvy answers with the mock model.
const mock = startMockLlm({ delayMs: 0 });
mkdirSync(join(fake.home, ".cavvy"), { recursive: true });
writeFileSync(join(fake.home, ".cavvy", "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(fake.home, ".cavvy", "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));

const A = "aaaaaaaaaaaa-1";
const B = "bbbbbbbbbbbb-2";
function source(id: string, o: { gui?: boolean; relation?: ReturnType<BuildSource["compare"]>; bundle?: () => ReturnType<typeof fake.bundle> } = {}): BuildSource & { built: number } {
    const s = {
        id,
        gui: Boolean(o.gui),
        built: 0,
        async build() {
            s.built++;
            return (o.bundle ?? (() => fake.bundle(id, { gui: o.gui })))();
        },
        compare: (theirs: string) => (theirs === id ? "same" : (o.relation ?? "older")),
    };
    return s as BuildSource & { built: number };
}

/** What a window would be: a WebSocket through the tunnel, with calls and their replies. */
class Client {
    ws: WebSocket;
    private next = 1;
    private waiting = new Map<number, (m: { result?: any; error?: { message: string } }) => void>();
    closed = Promise.withResolvers<number>();
    opened = Promise.withResolvers<boolean>();

    constructor(port: number, token: string) {
        this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["cavvy.v1", `auth.${token}`]);
        this.ws.onopen = () => this.opened.resolve(true);
        this.ws.onerror = () => this.opened.resolve(false);
        this.ws.onclose = (e) => {
            this.opened.resolve(false);
            this.closed.resolve(e.code);
        };
        this.ws.onmessage = (m) => {
            const msg = JSON.parse(String(m.data));
            if (typeof msg.id !== "number") return;
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

afterAll(async () => {
    await stopRemote(entry).catch(() => undefined);
    mock.stop();
    fake.cleanup();
    iso.cleanup();
});

describe("a server's host key", () => {
    test("one this machine doesn't know is refused; shown and trusted, only that key is saved", async () => {
        const refused = await probeServer(entry).catch((e) => e);
        expect(refused).toBeInstanceOf(SshError);
        expect(refused.kind).toBe("host-unknown");
        expect(refused.permanent).toBe(true);
        expect(fake.knownHosts()).toBe("");

        const key = await offeredHostKey(entry);
        expect(key.fingerprints).toHaveLength(1);
        expect(key.fingerprints[0]).toMatch(/^SHA256:[A-Za-z0-9+/]{43} \(ED25519\)$/);
        // Looking at the key trusted nothing.
        expect(fake.knownHosts()).toBe("");
        trustHostKey(entry, key);
        expect(fake.knownHosts().trim().split("\n")).toEqual(key.lines);

        const facts = await probeServer(entry);
        expect(facts).toMatchObject({ os: "Linux", arch: "x86_64", libc: "glibc 2.39", home: fake.home, systemd: false, builds: [] });
    });

    test("one that changed is refused, with the command that removes the old one", async () => {
        fake.changeHostKey();
        try {
            const refused = await probeServer(entry).catch((e) => e);
            expect(refused).toBeInstanceOf(SshError);
            expect(refused.kind).toBe("host-changed");
            expect(refused.message).toBe("box.example's identity changed.");
            expect(refused.fix).toMatch(/^ssh-keygen -R box\.example -f \S+known_hosts$/);
        } finally {
            fake.restoreHostKey();
        }
    });

    test("no connection could accept a key by itself, ask for a password, or read the destination as an option", () => {
        const calls = fake.calls().filter((c) => !c.flags.includes("-G"));
        expect(calls.length).toBeGreaterThan(3);
        for (const c of calls) {
            expect(c.separated).toBe(true);
            expect(c.opts.BatchMode).toBe("yes");
            // The one look at an unknown key signs in as nobody, into a file of its own.
            if (c.opts.StrictHostKeyChecking !== "yes") expect(c.opts).toMatchObject({ StrictHostKeyChecking: "no", PreferredAuthentications: "none", PubkeyAuthentication: "no", GlobalKnownHostsFile: "/dev/null" });
            expect(c.opts.ControlPath).toBe("none");
        }
    });
});

describe("a server that can't be connected to", () => {
    test.each([
        ["timeout", "unreachable", "Can't reach box.example.", false],
        ["refused", "unreachable", "Can't reach box.example.", false],
        ["dns", "unreachable", "Can't reach box.example.", false],
        ["closed", "unreachable", "Can't reach box.example.", false],
        ["auth", "auth", "box.example refused your SSH keys.", true],
    ] as const)("%s: %s", async (how, kind, message, permanent) => {
        fake.fail(how);
        try {
            const e = await probeServer(entry).catch((x) => x);
            expect(e).toBeInstanceOf(SshError);
            expect({ kind: e.kind, message: e.message, permanent: e.permanent }).toEqual({ kind, message, permanent });
        } finally {
            fake.fail();
        }
    });
});

describe("setting a server up", () => {
    test("a copy that isn't what was sent is refused, and nothing is installed", async () => {
        const bad = source(A, { bundle: () => ({ ...fake.bundle(A), sha256: "0".repeat(64) }) });
        await expect(setUpServer(entry, { source: bad })).rejects.toThrow(/isn't the one sent.*Nothing was installed/);
        expect(readdirSync(join(serverDir, "builds"))).toEqual([]);
        expect(await remoteStatus(entry).catch((e) => e.message)).toBe("Cavvy isn't set up on box.example.");
    });

    test("a build that doesn't run there is refused, and nothing is installed", async () => {
        const bad = source(A, { bundle: () => fake.bundle(A, { broken: true }) });
        await expect(setUpServer(entry, { source: bad })).rejects.toThrow(/Cavvy doesn't run on box\.example: .*Exec format error/);
        expect(readdirSync(join(serverDir, "builds"))).toEqual([]);
    });

    test("the build is copied, checked, started, and said to be running", async () => {
        const steps: string[] = [];
        const copied: number[] = [];
        const a = source(A, { gui: true });
        const r = await setUpServer(entry, { source: a, progress: { step: (t) => steps.push(t), copied: (sent, total) => copied.push(sent / total) } });
        expect(steps).toEqual(["Copying Cavvy to box…", "Starting Cavvy on box…"]);
        expect(copied.at(-1)).toBe(1);
        expect(r.status).toMatchObject({ running: true, build: A, sessions: 0, working: 0, waiting: 0, gui: true });
        expect(r.status.port).toBeGreaterThan(0);
        // No service manager on the pretend server: it says so, and there's nothing to tell the user to run.
        expect(r.service).toEqual({ service: false, lingerFix: undefined });
        expect(r.replaced).toBeUndefined();
        expect(readlinkSync(join(serverDir, "current"))).toBe(`builds/${A}`);
        expect(readdirSync(join(serverDir, "builds"))).toEqual([A]);
        // Its folder is the user's alone, and so is what's in it.
        expect(lstatSync(serverDir).mode & 0o077).toBe(0);
        for (const f of ["state.json", "control.sock", "host.lock"]) expect(lstatSync(join(serverDir, f)).mode & 0o077).toBe(0);
    });

    test("set up again on the same build, nothing is copied or restarted", async () => {
        const before = await remoteStatus(entry);
        const a = source(A, { gui: true });
        const r = await setUpServer(entry, { source: a });
        expect(a.built).toBe(0);
        expect(r.status.pid).toBe(before!.pid);
    });

    test("a server on a newer build keeps it: another machine's Cavvy isn't put back over it", async () => {
        const before = await remoteStatus(entry);
        const older = source(B, { relation: "newer" });
        const r = await setUpServer(entry, { source: older });
        expect(r.kept).toBe("newer");
        expect(older.built).toBe(0);
        expect(r.status).toMatchObject({ build: A, pid: before!.pid });
    });
});

describe("connecting", () => {
    let link: InstanceType<typeof ServerLink>;
    const states: LinkState[] = [];
    let client: Client;
    let token: string;

    test("a machine signs in over SSH and talks to the server through the tunnel", async () => {
        link = new ServerLink(entry, { onState: (s) => states.push(s), backoffMs: [50] });
        await link.start();
        const s = link.state;
        if (s.state !== "connected") throw new Error(`not connected: ${s.state}`);
        expect(s.pairing).toMatchObject({ build: A, gui: true });
        token = await exchangeCode(s.localPort, s.pairing.code);
        // The code was good once.
        await expect(exchangeCode(s.localPort, s.pairing.code)).rejects.toThrow(/expired/);
        client = new Client(s.localPort, token);
        expect(await client.opened.promise).toBe(true);
        const hello = await client.call("hello");
        expect(hello).toMatchObject({ homeDir: fake.home, protocol: 1 });
        expect((await remoteStatus(entry))!.machines).toEqual([{ id: thisDesktop().id, label: thisDesktop().label, connections: 1 }]);
        // The page the server's GUI is, from the tunnel's own address.
        const page = await fetch(`http://127.0.0.1:${s.localPort}/`);
        expect(await page.text()).toContain('<div id="root">');
    });

    test("a token nobody was given isn't let in", async () => {
        const stranger = new Client(link.localPort!, "f".repeat(64));
        expect(await stranger.opened.promise).toBe(false);
    });

    test("asking to sign in with wrong codes writes nothing on the server", async () => {
        const list = () => readdirSync(serverDir, { recursive: true }).sort();
        const before = list();
        const tries = await Promise.all(Array.from({ length: 40 }, (_, i) => fetch(`http://127.0.0.1:${link.localPort}/auth/exchange`, { method: "POST", body: JSON.stringify({ code: `wrong-${i}` }) }).then((r) => r.status)));
        expect(new Set(tries)).toEqual(new Set([401]));
        expect(list()).toEqual(before);
    });

    test("a connection that drops comes back by itself, on the same port", async () => {
        const port = link.localPort!;
        states.length = 0;
        expect(fake.dropTunnel()).toBe(true);
        await until("the link to come back", () => states.some((s) => s.state === "reconnecting") && link.state.state === "connected");
        expect(link.localPort).toBe(port);
        // What was signed in before still is: the server didn't restart.
        const again = new Client(port, token);
        expect(await again.opened.promise).toBe(true);
        again.ws.close();
    });

    test("one that can't come back without the user stops, and isn't tried again", async () => {
        fake.fail("auth");
        try {
            states.length = 0;
            fake.dropTunnel();
            await until("the link to stop", () => link.state.state === "stopped");
            const s = link.state;
            expect(s.state === "stopped" && s.error instanceof SshError && s.error.kind).toBe("auth");
            const calls = fake.calls().length;
            await Bun.sleep(400);
            expect(fake.calls().length).toBe(calls);
        } finally {
            fake.fail();
        }
    });

    test("the machine going away leaves the server running", async () => {
        await link.stop();
        const s = await remoteStatus(entry);
        expect(s).toMatchObject({ running: true, build: A });
    });

    test("removing a machine signs it out: its connections close and its token stops working", async () => {
        const fresh = new ServerLink(entry);
        await fresh.start();
        try {
            const s = fresh.state;
            if (s.state !== "connected") throw new Error("not connected");
            const t = await exchangeCode(s.localPort, s.pairing.code);
            const c = new Client(s.localPort, t);
            expect(await c.opened.promise).toBe(true);
            await revokeOverSsh(entry, thisDesktop().id);
            expect(await c.closed.promise).toBe(4001);
            expect(await new Client(s.localPort, t).opened.promise).toBe(false);
            expect((await remoteStatus(entry))!.machines).toEqual([]);
        } finally {
            await fresh.stop();
        }
    });
});

describe("the terminal's commands", () => {
    /** `cavvy …` as its own process, on the build the pretend server runs, with no terminal to ask at. */
    async function cavvy(...args: string[]): Promise<{ code: number; out: string; err: string }> {
        const proc = Bun.spawn([process.execPath, "--no-env-file", `--config=${join(import.meta.dir, "..", "bunfig.toml")}`, join(import.meta.dir, "..", "src", "index.ts"), ...args], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, CAVVY_BUILD: A } as Record<string, string>,
        });
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { code, out, err };
    }

    test("with none added, it says how to add one", async () => {
        expect(await cavvy("servers")).toEqual({ code: 0, out: "No servers yet. Add one: cavvy servers add <name> <user@host>\n", err: "" });
    });

    test("add: a server this machine hasn't connected to isn't added without its key being checked", async () => {
        const r = await cavvy("servers", "add", "other", "dev@other.example", "--no-copy");
        expect(r.code).toBe(1);
        expect(r.out).toBe("");
        expect(r.err).toMatch(/^Connecting to other\.example…\nother\.example isn't a server this machine has connected to before\.\n  Its key: SHA256:\S+ \(ED25519\)\n  Run this in a terminal to check it and trust it\.\n$/);
        expect((await cavvy("servers")).out).toContain("No servers yet");
    });

    test("add: a server that's reachable and set up is saved, with what it's missing", async () => {
        const r = await cavvy("servers", "add", "box", "dev@box.example", "--no-copy");
        expect(r.err).toBe("Connecting to box.example…\n");
        const lines = r.out.trim().split("\n");
        expect(lines.slice(0, 3)).toEqual(["box is ready.", "Only put credentials on it that you'd accept an agent using.", "It won't start Cavvy again after a reboot."]);
        expect(lines).toContain("No agent CLI is installed there (Claude Code, Codex). Models with an API key work without one.");
        expect(lines.at(-1)).toBe("Work there: cavvy --server box   or   cavvy gui --server box");
        expect(r.code).toBe(0);
        expect(await cavvy("servers")).toMatchObject({ code: 0, out: "box\tdev@box.example\n" });
        expect((await cavvy("servers", "add", "box", "dev@elsewhere.example")).err).toBe("There's already a server named box.\n");
    });

    test("check: says it's running and what's missing", async () => {
        const r = await cavvy("servers", "check");
        expect(r.out.split("\n")[0]).toBe("box: Cavvy is running.");
        expect(r.out).toContain("  It won't start Cavvy again after a reboot.");
        expect(r.out).not.toContain("different version");
    });

    test("--server: the rest of the line runs there, in the folder named", async () => {
        expect(await cavvy("--server", "box", "--version")).toEqual({ code: 0, out: "1.0.0\n", err: "" });
        const proj = tempDir("cavvy-servers-there-");
        writeFileSync(join(proj, "here.txt"), "x");
        const models = await cavvy("--server", `box:${proj}`, "models");
        expect(models.code).toBe(0);
        expect(models.out).toContain("mock");
        expect(await cavvy("--server", "box:/no/such/folder", "--version")).toEqual({ code: 1, out: "", err: "No folder /no/such/folder there.\n" });
        expect(await cavvy("--server", "nope", "--version")).toEqual({ code: 1, out: "", err: "No server named nope. You have: box.\n" });
        expect((await cavvy("--server")).err).toContain("--server needs a server's name");
    });

    test("--server: a server that can't be reached is said in plain words, with ssh's own line under it", async () => {
        fake.fail("timeout");
        try {
            expect(await cavvy("--server", "box", "--version")).toEqual({ code: 1, out: "", err: "Can't reach box.example.\n  ssh: connect to host box.example port 22: Operation timed out\n" });
        } finally {
            fake.fail();
        }
    });

    test("the one-time copy puts settings there and never replaces what the server has", async () => {
        const { planCopy, sendCopy } = await import("../src/servers/copy");
        writeFileSync(join(iso.home, "CAVVY.md"), "From this machine.\n");
        mkdirSync(join(iso.home, "commands"), { recursive: true });
        writeFileSync(join(iso.home, "commands", "ship.md"), "Ship it.\n");
        // The server has settings of its own already (the mock model's).
        const theirs = readFileSync(join(fake.home, ".cavvy", "settings.json"), "utf-8");
        const plan = planCopy({ model: "anthropic:claude" });
        try {
            expect(await sendCopy(entry, plan)).toBe(2);
            expect(readFileSync(join(fake.home, ".cavvy", "CAVVY.md"), "utf-8")).toBe("From this machine.\n");
            expect(readFileSync(join(fake.home, ".cavvy", "commands", "ship.md"), "utf-8")).toBe("Ship it.\n");
            expect(readFileSync(join(fake.home, ".cavvy", "settings.json"), "utf-8")).toBe(theirs);
            expect(lstatSync(join(fake.home, ".cavvy", "CAVVY.md")).mode & 0o077).toBe(0);
            // A second time, everything is there already.
            expect(await sendCopy(entry, plan)).toBe(0);
        } finally {
            plan.cleanup();
        }
    });

    test("remove: it's forgotten here, this machine is signed out there, and the line to put it back is given", async () => {
        const r = await cavvy("servers", "remove", "box");
        expect(r).toEqual({ code: 0, out: "Removed box.\nTo put it back: cavvy servers add box dev@box.example\n", err: "" });
        expect((await cavvy("servers")).out).toContain("No servers yet");
        expect(fake.calls().some((c) => c.command?.includes("host revoke --machine"))).toBe(true);
        // Cavvy there keeps running: other machines may be using it.
        expect(await remoteStatus(entry)).toMatchObject({ running: true, build: A });
    });
});

describe("updating a server", () => {
    test("one that's waiting for an answer is asked about first; said no, it's left as it is", async () => {
        const link = new ServerLink(entry);
        await link.start();
        try {
            const s = link.state;
            if (s.state !== "connected") throw new Error("not connected");
            const c = new Client(s.localPort, await exchangeCode(s.localPort, s.pairing.code));
            await c.opened.promise;
            const cwd = tempDir("cavvy-servers-proj-");
            const snap = await c.call("session.create", { cwd });
            await c.call("session.send", { id: snap.state.id, text: "a question please" });
            await until("the session to be waiting", async () => (await remoteStatus(entry))!.waiting === 1);

            const asked: unknown[] = [];
            const b = source(B);
            const left = await setUpServer(entry, { source: b, confirmRestart: async (busy) => (asked.push(busy), false) }).catch((e) => e);
            expect(left).toBeInstanceOf(ServerBusy);
            expect(asked).toEqual([{ working: 0, waiting: 1 }]);
            expect(b.built).toBe(0);
            expect(await remoteStatus(entry)).toMatchObject({ build: A, waiting: 1 });
        } finally {
            await link.stop();
        }
    });

    test("said yes, the new build runs, the old server having stopped first; a machine connected through it all signs in again", async () => {
        const before = await remoteStatus(entry);
        const link = new ServerLink(entry, { backoffMs: [50], healthEveryMs: 100 });
        await link.start();
        try {
            const was = link.state;
            if (was.state !== "connected") throw new Error("not connected");
            const oldToken = await exchangeCode(was.localPort, was.pairing.code);

            const r = await setUpServer(entry, { source: source(B), confirmRestart: async () => true });
            expect(r.replaced).toBe(A);
            expect(r.status).toMatchObject({ build: B, waiting: 0 });
            expect(r.status.pid).not.toBe(before!.pid);
            // The one before is really gone, not still closing its sessions beside the new one.
            expect(() => process.kill(before!.pid, 0)).toThrow();
            expect(readlinkSync(join(serverDir, "current"))).toBe(`builds/${B}`);

            // ssh never dropped, but the server behind the tunnel is another run, on another port.
            await until("the link to find the new server", () => link.state.state === "connected" && link.state.pairing.run !== was.pairing.run);
            const now = link.state;
            if (now.state !== "connected") throw new Error("not connected");
            expect(now.localPort).toBe(was.localPort);
            expect(now.pairing.build).toBe(B);
            // The restart forgot every sign-in; the new code signs this machine in again.
            expect(await new Client(now.localPort, oldToken).opened.promise).toBe(false);
            expect(await new Client(now.localPort, await exchangeCode(now.localPort, now.pairing.code)).opened.promise).toBe(true);
        } finally {
            await link.stop();
        }
    });

    test("a build that doesn't start is taken back: the one before runs again", async () => {
        const C = "cccccccccccc-3";
        // Answers as itself when tried, and then never runs as a server.
        const dud = `#!/bin/sh\nif [ "$1 $2" = "host version" ]; then echo '{"version":"1.0.0","protocol":1,"build":"${C}"}'; exit 0; fi\nexit 3\n`;
        const bundle = () => {
            const stage = tempDir("cavvy-servers-dud-");
            writeFileSync(join(stage, "cavvy"), dud, { mode: 0o755 });
            const out = join(stage, "bundle.tar.gz");
            if (Bun.spawnSync(["tar", "-czf", out, "-C", stage, "cavvy"]).exitCode !== 0) throw new Error("tar failed");
            return { ...fake.bundle(C), bundle: out, sha256: new Bun.CryptoHasher("sha256").update(dud).digest("hex") };
        };
        serviceTiming.startWaitSeconds = 2;
        try {
            const failed = await setUpServer(entry, { source: source(C, { bundle }) }).catch((e) => e);
            expect(failed).toBeInstanceOf(UpdateFailed);
            expect(failed.message).toBe("Cavvy didn't start on box.example, so it's back on the version before.");
            expect(failed.status).toMatchObject({ running: true, build: B });
        } finally {
            serviceTiming.startWaitSeconds = 40;
        }
        expect(await remoteStatus(entry)).toMatchObject({ running: true, build: B });
        expect(readlinkSync(join(serverDir, "current"))).toBe(`builds/${B}`);
    });

    test("stopping it waits until it's gone, and leaves nothing that says it's running", async () => {
        const before = await remoteStatus(entry);
        await stopRemote(entry);
        expect(() => process.kill(before!.pid, 0)).toThrow();
        expect(await remoteStatus(entry)).toBeUndefined();
        expect(existsSync(join(serverDir, "state.json"))).toBe(false);
        expect(existsSync(join(serverDir, "control.sock"))).toBe(false);
    });
});
