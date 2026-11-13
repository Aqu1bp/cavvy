// Servers end to end, against a pretend one (test/helpers/fake-ssh.ts): every
// "remote" command really runs, in a home folder of the pretend server's own,
// and the Cavvy "installed" there is this checkout's. What's real: the probe,
// the copy and its checks, starting and stopping the server, signing in over
// "SSH", the tunnel, and the server's own code. What isn't: the network, and
// systemd (the pretend server has none, so Cavvy runs detached there).

import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "fs";
import { connect as tcp } from "net";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { fakeSsh } from "./helpers/fake-ssh";

// Each step is a real command on the pretend server, and some wait for a server to start or to give up: more than
// the default five seconds on a slow or busy machine.
setDefaultTimeout(60_000);

const iso = isolate();
const fake = fakeSsh();
const { startMockLlm } = await import("../scripts/mock-llm");
const { setUpServer, ServerBusy } = await import("../src/servers/install");
const { probeServer } = await import("../src/servers/remote");
const { offeredHostKey, trustHostKey, SshError } = await import("../src/servers/ssh");
const { ServerLink, exchangeCode } = await import("../src/servers/connect");
const { remoteStatus, revokeOverSsh, setUpService, stopRemote, serviceTiming, StoppedThere, UpdateFailed } = await import("../src/servers/service");
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
function source(id: string, o: { gui?: boolean; relation?: ReturnType<BuildSource["compare"]>; bundle?: () => ReturnType<typeof fake.bundle>; on?: typeof fake } = {}): BuildSource & { built: number } {
    const s = {
        id,
        gui: Boolean(o.gui),
        built: 0,
        async build() {
            s.built++;
            return (o.bundle ?? (() => (o.on ?? fake).bundle(id, { gui: o.gui })))();
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

/** The status of one raw HTTP request, with exactly these headers (a page's Host and Origin can't be set through fetch). */
function rawStatus(port: number, method: string, path: string, headers: Record<string, string>, body = ""): Promise<number> {
    return new Promise((resolve, reject) => {
        const socket = tcp(port, "127.0.0.1");
        let got = "";
        socket.on("connect", () => socket.write(`${method} ${path} HTTP/1.1\r\n${Object.entries({ Connection: "close", ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}), ...headers }).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n${body}`));
        // As soon as the status is in: the server may keep the connection open after answering.
        socket.on("data", (d) => {
            got += d.toString("latin1");
            const status = /^HTTP\/1\.1 (\d{3})/.exec(got)?.[1];
            if (!status) return;
            socket.destroy();
            resolve(Number(status));
        });
        socket.on("error", reject);
        socket.on("close", () => resolve(0));
    });
}

/** `cavvy …` as its own process, on build `build`, with no terminal to ask at. */
function spawnCavvy(build: string, args: string[]) {
    return Bun.spawn([process.execPath, "--no-env-file", `--config=${join(import.meta.dir, "..", "bunfig.toml")}`, join(import.meta.dir, "..", "src", "index.ts"), ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CAVVY_BUILD: build } as Record<string, string>,
    });
}

/** The terminals opened by inTerminal: one a test left open (it failed part way) is closed after it. */
const terminals: Bun.Subprocess[] = [];

/** `cavvy …` on build `build`, in a terminal of its own as a person runs it: what it has shown, and typing into it. */
function inTerminal(build: string, args: string[]) {
    let raw = "";
    const decoder = new TextDecoder();
    const proc = Bun.spawn([process.execPath, "--no-env-file", `--config=${join(import.meta.dir, "..", "bunfig.toml")}`, join(import.meta.dir, "..", "src", "index.ts"), ...args], {
        env: { ...process.env, CAVVY_BUILD: build, TERM: "xterm-256color" } as Record<string, string>,
        terminal: {
            cols: 120,
            rows: 30,
            data: (_terminal, bytes) => {
                raw += decoder.decode(bytes, { stream: true });
            },
        },
    });
    terminals.push(proc);
    // What a person reads: without the colours and the cursor's moves.
    const shown = () => raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g, "").replace(/\r/g, "");
    return {
        shown,
        type: (text: string) => void proc.terminal!.write(text),
        sees: (text: string) => until(`"${text}" on screen`, () => shown().includes(text)),
        async done() {
            const code = await proc.exited;
            proc.terminal!.close();
            return code;
        },
    };
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 20_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await ok()) return;
        await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
}

// Whatever a test made the pretend server do, the next one starts with it as it was: also when the test before
// timed out, and so never reached its own putting-back.
afterEach(() => {
    fake.fail();
    fake.dropSessions();
    fake.vanishSessions();
    fake.diskFree();
    fake.settings();
    fake.unhold();
    for (const proc of terminals.splice(0)) {
        if (proc.exitCode === null) proc.kill("SIGKILL");
        proc.terminal?.close();
    }
});

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

    test("only this server's own page, at the tunnel's own address, may sign in or connect", async () => {
        const port = link.localPort!;
        const here = `127.0.0.1:${port}`;
        // A page that rebinds a name to this address still sends its own name.
        expect(await rawStatus(port, "GET", "/healthz", { Host: "evil.example:80" })).toBe(403);
        expect(await rawStatus(port, "GET", "/healthz", { Host: `127.0.0.1.evil.example:${port}` })).toBe(403);
        expect(await rawStatus(port, "GET", "/healthz", { Host: here })).toBe(200);
        // A page some other local program serves can't trade a code, nor connect with a token it got hold of.
        expect(await rawStatus(port, "POST", "/auth/exchange", { Host: here, Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" }, '{"code":"x"}')).toBe(403);
        expect(await rawStatus(port, "POST", "/auth/exchange", { Host: here, Origin: `http://localhost:${port}`, "Content-Type": "application/json" }, '{"code":"x"}')).toBe(403);
        const upgrade = { Host: here, Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Protocol": `cavvy.v1, auth.${token}` };
        expect(await rawStatus(port, "GET", "/ws", { ...upgrade, Origin: "http://127.0.0.1:3000" })).toBe(403);
        expect(await rawStatus(port, "GET", "/ws", { ...upgrade, Origin: "https://evil.example" })).toBe(403);
        // The desktop app's own pages are never driven through a tunnel.
        expect(await rawStatus(port, "GET", "/browser-host", upgrade)).toBe(404);
        // The server's own page, served from this very address, is let in.
        const own = new WebSocket(`ws://${here}/ws`, { protocols: ["cavvy.v1", `auth.${token}`], headers: { Origin: `http://${here}` } } as any);
        expect(await new Promise((r) => ((own.onopen = () => r(true)), (own.onerror = () => r(false))))).toBe(true);
        own.close();
    });

    test("asking to sign in with wrong codes writes nothing on the server", async () => {
        // Names, sizes and times: nothing new, and nothing there added to.
        const list = () =>
            (readdirSync(serverDir, { recursive: true }) as string[]).sort().map((f) => {
                const st = lstatSync(join(serverDir, f));
                return `${f} ${st.isDirectory() ? "" : st.size} ${st.isDirectory() ? "" : st.mtimeMs}`;
            });
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
        const proc = spawnCavvy(A, args);
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
        expect(lines.slice(0, 4)).toEqual(["box is ready.", "Only put credentials on it that you'd accept an agent using.", "Sessions there run without asking (Bypass).", "It won't start Cavvy again after a reboot."]);
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
        // And how its sessions stand with permissions, last.
        expect(r.out.trim().split("\n").at(-1)).toMatch(/^  Sessions start in Bypass\. Auto mode('s sandbox is (on|off)| has no sandbox there)/);
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

    test("add --copy: with nothing that can go, it still says what stayed, and the server is added", async () => {
        // Only an MCP server that runs a file here, and a rule with a password in it.
        writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ mcpServers: { local: { command: "node", args: ["server.js"] }, odd: { command: "npx", args: "-y some-mcp" } }, permissions: { allow: ["Bash(curl -u admin:hunter2 https://ci.example.com:*)"] } }));
        try {
            const r = await cavvy("servers", "add", "box2", "dev@box.example", "--copy");
            expect(r.err).toBe("Connecting to box.example…\nNot copied, since they could hold a key or need this machine: 2 MCP servers and 1 permission rule.\n");
            expect(r.out.split("\n")[0]).toBe("box2 is ready.");
            expect(r.code).toBe(0);
            expect(existsSync(join(fake.home, ".cavvy", "settings.json")) && readFileSync(join(fake.home, ".cavvy", "settings.json"), "utf-8")).not.toContain("hunter2");
        } finally {
            rmSync(join(iso.home, "settings.json"), { force: true });
            await cavvy("servers", "remove", "box2");
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
            expect((await sendCopy(entry, plan)).sort()).toEqual([".cavvy/CAVVY.md", ".cavvy/commands/ship.md"]);
            expect(readFileSync(join(fake.home, ".cavvy", "CAVVY.md"), "utf-8")).toBe("From this machine.\n");
            expect(readFileSync(join(fake.home, ".cavvy", "commands", "ship.md"), "utf-8")).toBe("Ship it.\n");
            expect(readFileSync(join(fake.home, ".cavvy", "settings.json"), "utf-8")).toBe(theirs);
            expect(lstatSync(join(fake.home, ".cavvy", "CAVVY.md")).mode & 0o077).toBe(0);
            // A second time, everything is there already.
            expect(await sendCopy(entry, plan)).toEqual([]);
        } finally {
            plan.cleanup();
        }
    });

    test("--server: a connection lost part way is said, and so is not a command that failed there", async () => {
        fake.dropSessions(1500);
        try {
            const r = await cavvy("--server", "box", "-p", "hangforever please");
            expect(r.code).toBe(1);
            expect(r.err).toContain("Connection to box lost.\n");
            // Off a terminal there's no session on screen to continue.
            expect(r.err).not.toContain("Continue with");
        } finally {
            fake.dropSessions();
        }
    });

    test("--server: a Cavvy left running there by a connection lost without a word is ended by the next run", async () => {
        const gone = (pid: number) => {
            try {
                process.kill(pid, 0);
                return false;
            } catch {
                return true;
            }
        };
        // The laptop closes: ssh gives up here, and the server, which hasn't noticed, lets the Cavvy there run on.
        fake.vanishSessions(1500);
        const lost = await cavvy("--server", "box", "-p", "hangforever please");
        fake.vanishSessions();
        expect(lost.code).toBe(1);
        expect(lost.err).toContain("Connection to box lost.\n");
        const runs = join(serverDir, "runs", thisDesktop().id);
        const left = readdirSync(runs).map((id) => ({ id, pid: Number(readFileSync(join(runs, id), "utf-8").split(/\s/)[0]) })).filter((r) => !gone(r.pid));
        expect(left).toHaveLength(1);
        // It holds its session, so continuing would be refused, until the next run from this machine ends it.
        expect(await cavvy("--server", "box", "--version")).toMatchObject({ code: 0, out: "1.0.0\n" });
        await until("the one left behind to be gone", () => gone(left[0]!.pid), 10_000);
        expect(readdirSync(runs)).not.toContain(left[0]!.id);
    });

    /** This machine's runs on the pretend server whose process is alive. */
    const liveRuns = () => {
        const runs = join(serverDir, "runs", thisDesktop().id);
        return (existsSync(runs) ? readdirSync(runs) : [])
            .map((id) => ({ id, pid: Number(readFileSync(join(runs, id), "utf-8").split(/\s/)[0]) }))
            .filter((r) => {
                try {
                    process.kill(r.pid, 0);
                    return true;
                } catch {
                    return false;
                }
            });
    };
    /** Ends the runs still going on the pretend server, as their own Cavvy would on being asked to stop. */
    const endRuns = async (...procs: (ReturnType<typeof spawnCavvy> | undefined)[]) => {
        for (const r of liveRuns()) process.kill(r.pid, "SIGTERM");
        await Promise.all(procs.map((p) => p?.exited));
    };

    test("--server: a run whose terminal is still open here is left alone by the next one, and so is another machine's", async () => {
        const open = spawnCavvy(A, ["--server", "box", "-p", "hangforever please"]);
        const theirs = join(serverDir, "runs", "f".repeat(32));
        try {
            await until("it to be running there", () => liveRuns().length === 1);
            const [mine] = liveRuns();
            // Another machine's run, naming the same live process: were that folder ever looked in, this one would be ended.
            mkdirSync(theirs, { recursive: true });
            writeFileSync(join(theirs, "0123456789abcdef"), readFileSync(join(serverDir, "runs", thisDesktop().id, mine!.id)));
            expect(await cavvy("--server", "box", "--version")).toMatchObject({ code: 0, out: "1.0.0\n" });
            expect(liveRuns()).toEqual([mine!]);
            expect(readdirSync(theirs)).toEqual(["0123456789abcdef"]);
        } finally {
            await endRuns(open);
            rmSync(theirs, { recursive: true, force: true });
        }
    });

    test("--server: a run that starts while another is still connecting isn't taken by it for one that was left", async () => {
        const before = fake.calls().length;
        const held = fake.hold();
        // Its first connection, the one that ends what was left there, is slow to be made.
        const slow = spawnCavvy(A, ["--server", "box", "--version"]);
        let open: ReturnType<typeof spawnCavvy> | undefined;
        try {
            await until("its connection to start", () => fake.calls().slice(before).some((c) => c.command?.includes("echo listed")));
            held.only();
            // Meanwhile another starts, connects at once, and is running there before the first has got through.
            open = spawnCavvy(A, ["--server", "box", "-p", "hangforever please"]);
            await until("the second to be running there", () => liveRuns().length === 1);
            const [second] = liveRuns();
            held.release();
            const [out, code] = await Promise.all([new Response(slow.stdout).text(), slow.exited, new Response(slow.stderr).text()]);
            expect({ code, out }).toEqual({ code: 0, out: "1.0.0\n" });
            expect(liveRuns()).toEqual([second!]);
        } finally {
            held.release();
            await endRuns(open);
        }
    });

    test("--server after -- is the prompt's own words, and nothing goes to a server", async () => {
        const calls = fake.calls().length;
        const r = await cavvy("-p", "explain", "--", "--server", "box");
        // This machine has no model in these tests: the prompt was taken as one, here.
        expect(r.err).toContain("No model configured");
        expect(fake.calls().length).toBe(calls);
    });

    test("stop: Cavvy there stops, also when asked a second time; check says so", async () => {
        expect(await cavvy("servers", "stop", "box")).toEqual({ code: 0, out: "Cavvy on box is stopped.\n", err: "" });
        expect(await remoteStatus(entry)).toBeUndefined();
        expect(await cavvy("servers", "stop", "box")).toEqual({ code: 0, out: "Cavvy on box is stopped.\n", err: "" });
        expect((await cavvy("servers", "check")).out.split("\n")[0]).toBe("box: Cavvy isn't running there.");
    });

    test("gui --server: starts it again, gives the link, comes back after a drop with a new one, and signs out when it ends", async () => {
        const proc = spawnCavvy(A, ["gui", "--server", "box", "--no-open"]);
        let said = "";
        void (async () => {
            const d = new TextDecoder();
            for await (const chunk of proc.stderr) said += d.decode(chunk, { stream: true });
        })();
        try {
            await until("the link", () => /Open \(one-time link\): http/.test(said));
            const first = /box is at http:\/\/127\.0\.0\.1:(\d+)\n\s+Open \(one-time link\): http:\/\/127\.0\.0\.1:\d+\/#code=([\w-]+)\n\s+Ctrl\+C disconnects\. Work there keeps running\./.exec(said)!;
            expect(first).not.toBeNull();
            const port = Number(first[1]);
            const token = await exchangeCode(port, first[2]!);
            expect(await new Client(port, token).opened.promise).toBe(true);
            expect(await remoteStatus(entry)).toMatchObject({ running: true, build: A });

            fake.dropTunnel();
            await until("it to come back", () => /Reconnected to box\./.test(said));
            expect(said).toContain("Connection to box lost. Reconnecting…\n");
            // A page that gave up meanwhile, or whose sign-in ran out, has a link to sign in with: the same address, a new code.
            const again = new RegExp(`Reconnected to box\\. If the page asks you to sign in: http://127\\.0\\.0\\.1:${port}/#code=([\\w-]+)\\n`).exec(said)!;
            expect(again).not.toBeNull();
            expect(again[1]).not.toBe(first[2]);
            const second = await exchangeCode(port, again[1]!);

            proc.kill("SIGINT");
            expect(await proc.exited).toBe(0);
            // What it signed in went with it: a page left open holds nothing good for whatever listens on that port next.
            const other = new ServerLink(entry);
            await other.start();
            try {
                const s = other.state;
                if (s.state !== "connected") throw new Error("not connected");
                expect(await new Client(s.localPort, token).opened.promise).toBe(false);
                expect(await new Client(s.localPort, second).opened.promise).toBe(false);
                // This machine's other connections keep their own.
                expect(await new Client(s.localPort, await exchangeCode(s.localPort, s.pairing.code)).opened.promise).toBe(true);
            } finally {
                await other.stop();
            }
        } finally {
            proc.kill("SIGKILL");
        }
    });

    test("gui --server: the terminal window closing signs out too", async () => {
        const proc = spawnCavvy(A, ["gui", "--server", "box", "--no-open"]);
        let said = "";
        void (async () => {
            const d = new TextDecoder();
            for await (const chunk of proc.stderr) said += d.decode(chunk, { stream: true });
        })();
        try {
            await until("the link", () => /Open \(one-time link\): http/.test(said));
            const m = /http:\/\/127\.0\.0\.1:(\d+)\/#code=([\w-]+)/.exec(said)!;
            const token = await exchangeCode(Number(m[1]), m[2]!);
            proc.kill("SIGHUP");
            expect(await proc.exited).toBe(0);
            const other = new ServerLink(entry);
            await other.start();
            try {
                expect(await new Client(other.localPort!, token).opened.promise).toBe(false);
            } finally {
                await other.stop();
            }
        } finally {
            proc.kill("SIGKILL");
        }
    });

    describe("a CLI on the server that isn't signed in", () => {
        // Claude Code as far as signing in goes: signed in once its own sign-in is given the code it wants.
        const CLAUDE = `f="$HOME/.claude/.credentials.json"
case "$1 $2" in
"auth status") if [ -f "$f" ]; then echo '{"loggedIn":true,"authMethod":"oauth_token","subscriptionType":"max"}'; else echo '{"loggedIn":false}'; fi ;;
"auth login")
    echo "If the browser didn't open, visit: https://claude.example/authorize"
    printf 'Paste code here if prompted > '
    read -r code
    [ "$code" = right-code ] || { echo "Invalid code." >&2; exit 1; }
    mkdir -p "$HOME/.claude" && echo '{}' > "$f" ;;
esac`;
        const credentials = join(fake.home, ".claude", ".credentials.json");
        const providers = join(fake.home, ".cavvy", "providers.json");
        const turnedOn = () => Object.keys(JSON.parse(readFileSync(providers, "utf-8")).agents ?? {});
        const signOut = () => rmSync(join(fake.home, ".claude"), { recursive: true, force: true });
        const turnOff = () => {
            const file = JSON.parse(readFileSync(providers, "utf-8"));
            delete file.agents;
            writeFileSync(providers, JSON.stringify(file));
        };

        afterAll(() => {
            fake.install("claude");
            signOut();
            turnOff();
        });

        test("check: it's said, with the command that signs it in; with no terminal, nothing is started", async () => {
            fake.install("claude", CLAUDE);
            const r = await cavvy("servers", "check", "box");
            expect(r.out).toContain("  Claude Code isn't signed in there: cavvy servers login box\n");
            expect(r.out).not.toContain("No agent CLI is installed");
            expect(await cavvy("servers", "login", "box")).toEqual({ code: 1, out: "", err: "Signing in needs a terminal.\n" });
            expect(await cavvy("servers", "login", "box", "nope")).toMatchObject({ code: 1, err: expect.stringMatching(/^No CLI called nope\. There are: claude-code, codex/) });
            expect(await cavvy("servers", "login", "box", "codex")).toEqual({ code: 1, out: "", err: "Codex isn't installed on box. Install the Codex CLI (npm install -g @openai/codex)\n" });
        });

        test("login: the CLI's own sign-in has this terminal, and then the CLI is turned on there", async () => {
            const t = inTerminal(A, ["servers", "login", "box"]);
            await t.sees("Paste code here if prompted >");
            expect(t.shown()).toContain("Open the link Claude Code shows in a browser on this machine.");
            expect(t.shown()).toContain("https://claude.example/authorize");
            t.type("right-code\n");
            expect(await t.done()).toBe(0);
            expect(t.shown()).toContain("Claude Code is ready on box.");
            // Signed in by the CLI itself, with this terminal; and turned on in the server's Cavvy.
            expect(existsSync(credentials)).toBe(true);
            expect(turnedOn()).toEqual(["claude-code"]);
            expect((await cavvy("servers", "check", "box")).out).not.toContain("Claude Code");
            expect(await cavvy("servers", "login", "box")).toEqual({ code: 0, out: "Nothing to sign in on box.\n", err: "" });
        });

        test("login: a sign-in that's given up is said, with how to try again", async () => {
            signOut();
            const t = inTerminal(A, ["servers", "login", "box", "claude-code"]);
            await t.sees("Paste code here if prompted >");
            t.type("a wrong one\n");
            expect(await t.done()).toBe(1);
            expect(t.shown()).toContain("Claude Code isn't signed in on box. To try again: cavvy servers login box claude-code");
            expect(existsSync(credentials)).toBe(false);
        });

        test("login: one that's signed in there and not turned on is turned on, with a terminal or without", async () => {
            mkdirSync(join(fake.home, ".claude"), { recursive: true });
            writeFileSync(credentials, "{}");
            turnOff();
            expect((await cavvy("servers", "check", "box")).out).toContain("  Claude Code isn't turned on there: cavvy servers login box\n");
            expect(await cavvy("servers", "login", "box")).toEqual({ code: 0, out: "Claude Code is ready on box.\n", err: "" });
            expect(turnedOn()).toEqual(["claude-code"]);
        });

        test("login: with no terminal, the one that only needs turning on is, and the one that needs signing in is said", async () => {
            turnOff();
            // A second CLI there, not signed in: nothing of it is run, since there's nowhere to show its link.
            fake.install("codex", "echo 'run without a terminal' >&2; exit 9");
            try {
                expect((await cavvy("servers", "check", "box")).out).toContain("  Codex isn't signed in there: cavvy servers login box\n");
                expect(await cavvy("servers", "login", "box")).toEqual({ code: 1, out: "Claude Code is ready on box.\n", err: "Signing in needs a terminal.\n" });
                expect(turnedOn()).toEqual(["claude-code"]);
            } finally {
                fake.install("codex");
            }
        });

        test("login: a CLI that can't say whether it's signed in is said in its own words, not as one that isn't installed", async () => {
            turnOff();
            fake.install("claude", `case "$1 $2" in "auth status") echo "cannot read its settings" >&2; exit 1 ;; esac`);
            try {
                const t = inTerminal(A, ["servers", "login", "box", "claude-code"]);
                expect(await t.done()).toBe(1);
                expect(t.shown()).toContain("cannot read its settings");
                expect(t.shown()).toContain("Claude Code wasn't turned on on box.");
                expect(t.shown()).not.toContain("isn't installed");
                expect(turnedOn()).toEqual([]);
            } finally {
                fake.install("claude", CLAUDE);
            }
        });

        test("add: in a terminal it's offered, and what's said afterwards is the server as that left it", async () => {
            signOut();
            turnOff();
            const t = inTerminal(A, ["servers", "add", "box3", "dev@box.example", "--no-copy"]);
            try {
                await t.sees("Sign in to Claude Code on box3?");
                t.type("\r");
                await t.sees("Paste code here if prompted >");
                t.type("right-code\n");
                expect(await t.done()).toBe(0);
                const shown = t.shown();
                expect(shown).toContain("Claude Code is ready on box3.");
                // Of Claude Code, that is: other things the server lacks are said in the same words.
                expect(shown).not.toContain("Claude Code isn't");
                expect(shown).toContain("Work there: cavvy --server box3");
                expect(turnedOn()).toEqual(["claude-code"]);
            } finally {
                await cavvy("servers", "remove", "box3");
            }
        });

        test("add: said no, it's left as it is, with the command for later", async () => {
            signOut();
            turnOff();
            const t = inTerminal(A, ["servers", "add", "box3", "dev@box.example", "--no-copy"]);
            try {
                await t.sees("Sign in to Claude Code on box3?");
                t.type("\x1b");
                expect(await t.done()).toBe(0);
                expect(t.shown()).toContain("Claude Code isn't signed in there: cavvy servers login box3");
                expect(t.shown()).not.toContain("Paste code here");
                expect(existsSync(credentials)).toBe(false);
            } finally {
                await cavvy("servers", "remove", "box3");
            }
        });
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

describe("permissions on a server", () => {
    test("the Cavvy another machine put there is a server's: its sessions start in Bypass unless its settings say otherwise", async () => {
        const link = new ServerLink(entry);
        await link.start();
        try {
            const s = link.state;
            if (s.state !== "connected") throw new Error("not connected");
            const c = new Client(s.localPort, await exchangeCode(s.localPort, s.pairing.code));
            await c.opened.promise;
            expect(await c.call("settings.get", {})).toMatchObject({ defaultMode: "bypassPermissions", allowBypass: true });
            const cwd = tempDir("cavvy-servers-proj-");
            const snap = await c.call("session.create", { cwd });
            expect(snap.state).toMatchObject({ mode: "bypassPermissions", bypassAllowed: true });
            // A mode asked for is the one it gets, and it can be changed there.
            const manual = await c.call("session.create", { cwd, mode: "default" });
            expect(manual.state.mode).toBe("default");
            await c.call("session.setMode", { id: manual.state.id, mode: "bypassPermissions" });
            c.ws.close();
        } finally {
            await link.stop();
        }
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
        const link = new ServerLink(entry, { backoffMs: [50], healthEveryMs: 100 });
        await link.start();
        try {
            await stopRemote(entry);
            expect(() => process.kill(before!.pid, 0)).toThrow();
            expect(await remoteStatus(entry)).toBeUndefined();
            expect(existsSync(join(serverDir, "state.json"))).toBe(false);
            expect(existsSync(join(serverDir, "control.sock"))).toBe(false);

            // A connection that was open doesn't start it again by coming back: it was stopped on purpose.
            await until("the link to give up", () => link.state.state === "stopped");
            const s = link.state;
            expect(s.state === "stopped" && s.error).toBeInstanceOf(StoppedThere);
            expect(s.state === "stopped" && s.error?.message).toBe("Cavvy on box was stopped.");
            expect(await remoteStatus(entry)).toBeUndefined();
        } finally {
            await link.stop();
        }
    });

    test("asking to connect starts it again", async () => {
        const link = new ServerLink(entry);
        await link.start();
        try {
            expect(link.state.state).toBe("connected");
            expect(await remoteStatus(entry)).toMatchObject({ running: true, build: B });
        } finally {
            await link.stop();
        }
    });
});

describe("a server that stopped badly", () => {
    test("a lock it left, naming a pid some other program has now, doesn't keep Cavvy from starting", async () => {
        await stopRemote(entry);
        // As after losing power and a reboot: the lock and the state name a server that's gone, and the lock's pid is alive
        // (this test's own) but isn't one.
        writeFileSync(join(serverDir, "host.lock"), JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }));
        writeFileSync(join(serverDir, "state.json"), JSON.stringify({ pid: 1, start: "long ago", port: 1, build: B, version: "1.0.0", protocol: 1, startedAt: "" }));
        const link = new ServerLink(entry);
        await link.start();
        try {
            const s = await remoteStatus(entry);
            expect(s).toMatchObject({ running: true, build: B });
            expect(s!.pid).not.toBe(process.pid);
        } finally {
            await link.stop();
        }
    });

    test("a GUI that couldn't be built here doesn't have every set-up restart the server", async () => {
        const before = await remoteStatus(entry);
        // This machine means to send the GUI, and the build it makes comes without one.
        const noGui = { ...source(B), gui: true };
        const r = await setUpServer(entry, { source: noGui, confirmRestart: async () => true });
        expect(r.status.pid).toBe(before!.pid);
        expect(r.replaced).toBeUndefined();
    });
});

describe("changing what a server runs", () => {
    test("no room for a build is said before one is made", async () => {
        fake.diskFree(120);
        try {
            const d = source("dddddddddddd-4");
            await expect(setUpServer(entry, { source: d, confirmRestart: async () => true })).rejects.toThrow("There isn't room on box.example for Cavvy: it needs 400 MB free, and there are 120.");
            expect(d.built).toBe(0);
            expect(await remoteStatus(entry)).toMatchObject({ running: true, build: B });
        } finally {
            fake.diskFree();
        }
    });

    test("one at a time; a change that was cut off doesn't hold up the next", async () => {
        const marker = join(serverDir, "applying");
        // Another change under way: its shell is alive (this test's own pid stands in).
        mkdirSync(marker);
        writeFileSync(join(marker, "pid"), String(process.pid));
        await expect(setUpServer(entry, { source: source(A), confirmRestart: async () => true })).rejects.toThrow("Cavvy on box is being updated right now. Try again in a minute.");
        expect(await remoteStatus(entry)).toMatchObject({ running: true, build: B });
        // One that was killed part way: nothing has that pid any more.
        const gone = Bun.spawn(["true"]);
        await gone.exited;
        writeFileSync(join(marker, "pid"), String(gone.pid));
        const r = await setUpServer(entry, { source: source(A), confirmRestart: async () => true });
        expect(r.status).toMatchObject({ running: true, build: A });
        expect(existsSync(marker)).toBe(false);
    });
});

describe("a server with a service manager", () => {
    test("Cavvy is its service only where it would outlive the connection; where that's refused, it says what to run", async () => {
        const sys = fakeSsh({ systemd: true });
        const box: ServerEntry = { name: "sys", destination: "dev@sys.example", addedAt: new Date().toISOString() };
        try {
            sys.trust("sys.example");
            const r = await setUpServer(box, { source: source(A, { on: sys }) });
            // Lingering refused: not a service, and not left to start at the next sign-in either (it would stop with it).
            expect(r.service?.service).toBe(false);
            expect(r.service?.lingerFix).toMatch(/^sudo loginctl enable-linger \S+$/);
            expect(sys.asked()).toContain("disable cavvy.service");
            expect(sys.asked()).not.toContain("enable cavvy.service");
            expect(sys.asked()).not.toContain("start cavvy.service");
            // It runs all the same, detached.
            expect(r.status).toMatchObject({ running: true, build: A });

            sys.allowLinger(true);
            expect(await setUpService(box)).toEqual({ service: true });
            expect(sys.asked()).toContain("enable cavvy.service");

            await stopRemote(box);
            expect(await remoteStatus(box)).toBeUndefined();
            // Stopped for good: not started at boot again.
            expect(sys.asked().at(-1)).toBe("disable cavvy.service");
        } finally {
            await stopRemote(box).catch(() => undefined);
            sys.cleanup();
            process.env.CAVVY_SSH = fake.bin;
        }
    });
});
