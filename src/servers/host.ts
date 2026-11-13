// The Cavvy a server runs for the machines that connect to it: `cavvy host …`.
// The machine that sets a server up puts Cavvy there and starts this
// (src/servers/install.ts); systemd keeps it running where there is one.
//
// One runs per user on a machine, however many machines connect:
//   - `<home>/server/host.lock` names the process that is it. One found there
//     is taken for the server only if it's the process the state file
//     describes (its pid and when it started), so a pid that some other
//     program got after a crash isn't adopted.
//   - It listens on loopback only. A machine reaches it through an SSH tunnel
//     and signs in with a code made over SSH (`cavvy host pair`), traded
//     through the tunnel for a token of its own. Tokens live in this process's
//     memory: a restart signs every machine out, and each signs in again over
//     SSH, which is what proves who it is. Nothing a machine keeps signs it in.
//     A token makes connections for twelve hours; one already made stays.
//   - `cavvy host` commands reach the running server over a socket in that
//     folder, which only this user can open.
//
// Agents the server runs are this same user: file permissions don't keep
// them out of that folder. The permission checker does where it's asked
// (src/permissions/bash-safety.ts), and a server is somewhere you've decided
// agents may act freely.

import { createHash, randomBytes } from "crypto";
import { chmodSync, closeSync, existsSync, openSync, readFileSync, rmSync, statSync, unlinkSync } from "fs";
import { homedir, totalmem } from "os";
import { join } from "path";
import { hold, SessionInUseError } from "../agent/session";
import { loginCommand } from "../backends/account-login";
import { AGENT_CLIS, agentCli } from "../backends/defs";
import { findCli } from "../backends/cli";
import { cachedChrome } from "../browser/chrome";
import { APP_NAME, APP_VERSION, cavvyHome, ensureDir, paths } from "../config/paths";
import { loadSettings, writeJson, type Settings } from "../config/settings";
import { sandboxEnabled, sandboxKind } from "../permissions/sandbox";
import { defaultMode, type PermissionMode } from "../permissions/modes";
import { readAgentConfig, saveAgentConfig } from "../providers/registry";
import { PROTOCOL_VERSION } from "../server/protocol";
import type { SignIns } from "../server/server";
import { childEnv } from "../util/env";
import { redact, registerSecret, unregisterSecret } from "../util/redact";
import { thisBuild, thisBuildTime } from "./build";
import { LOGIN_EXIT } from "./remote";

export const hostDir = () => join(cavvyHome(), "server");
const lockTarget = () => join(hostDir(), "host");
const stateFile = () => join(hostDir(), "state.json");
const machinesFile = () => join(hostDir(), "machines.json");
/** A socket's path has a short limit (104 bytes on macOS), which a test's temp folder can pass. */
const socketPath = () => process.env.CAVVY_HOST_SOCKET || join(hostDir(), "control.sock");

export interface HostVersion {
    version: string;
    protocol: number;
    build: string;
    /** When the build's commit was made (seconds): what orders two builds for a machine with no checkout. Left out by a build that doesn't know. */
    builtAt?: number;
}

export const hostVersion = (): HostVersion => {
    const builtAt = thisBuildTime();
    return { version: APP_VERSION, protocol: PROTOCOL_VERSION, build: thisBuild(), ...(builtAt === undefined ? {} : { builtAt }) };
};

export interface HostState extends HostVersion {
    pid: number;
    /** When that process started, as the system tells it: a pid alone can come round again. */
    start?: string;
    /** 0 until it's listening. */
    port: number;
    startedAt: string;
}

export interface HostStatus extends HostState {
    running: true;
    /** Sessions loaded, and of those: working (a restart cuts them off), and waiting for an answer (a restart drops the question). */
    sessions: number;
    working: number;
    waiting: number;
    /** Machines connected now. */
    machines: { id: string; label: string; connections: number }[];
    /** It has its GUI to serve to a browser. */
    gui: boolean;
}

/** When a process started, in whatever form the system has: only ever compared with itself. */
export function processStart(pid: number): string | undefined {
    try {
        if (process.platform === "linux") {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
            // "pid (name) state …": the name may hold spaces and brackets, so count from the last ")". Start time is field 22.
            return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || undefined;
        }
        const r = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: childEnv() });
        return (r.exitCode === 0 && r.stdout.toString().trim()) || undefined;
    } catch {
        return undefined;
    }
}

function readState(): HostState | undefined {
    try {
        const s = JSON.parse(readFileSync(stateFile(), "utf-8")) as Partial<HostState>;
        return typeof s.pid === "number" && typeof s.port === "number" ? (s as HostState) : undefined;
    } catch {
        return undefined;
    }
}

/** The pid is the server the state file describes, not some other program that has its number now. */
function isHost(pid: number): boolean {
    const s = readState();
    return s?.pid === pid && s.start !== undefined && processStart(pid) === s.start;
}

// ---------------------------------------------------------------------------
// Sign-ins.

const CODE_TTL_MS = 120_000;
/** How long a token can make new connections. A machine signs in again whenever its link to the server is made anew. */
const TOKEN_TTL_MS = 12 * 3600_000;
const MAX_CODES = 32;
const MAX_TOKENS = 256;
const MACHINE_ID = /^[0-9a-f]{32}$/;
/** One of a machine's connections to the server (connect.ts ServerLink), so its sign-ins can be taken away alone. */
const CLIENT_ID = /^[0-9a-f]{16}$/;

const digest = (s: string) => createHash("sha256").update(s).digest("hex");

interface Grant {
    machine: string;
    client?: string;
    expires: number;
    /** A token's own text, so it stops being redacted once it's no good. */
    secret?: string;
}

export class MachineSignIns implements SignIns {
    private codes = new Map<string, Grant>();
    private tokens = new Map<string, Grant>();

    constructor(private now: () => number = Date.now) {}

    private prune() {
        const t = this.now();
        for (const [k, g] of this.codes) if (g.expires < t) this.codes.delete(k);
        for (const [k, g] of this.tokens) if (g.expires < t) this.drop(k);
    }

    private drop(key: string) {
        unregisterSecret(this.tokens.get(key)?.secret);
        this.tokens.delete(key);
    }

    /** A code that signs `machine` in, once, within two minutes. `client`: which of its connections asks. */
    pair(machine: string, client?: string): string {
        this.prune();
        // Each is made by someone already signed in over SSH; the oldest go so they can't pile up.
        while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value!);
        const code = randomBytes(24).toString("base64url");
        this.codes.set(digest(code), { machine, client, expires: this.now() + CODE_TTL_MS });
        return code;
    }

    redeem(code: string): string | undefined {
        this.prune();
        const key = digest(code);
        const grant = this.codes.get(key);
        if (!grant) return undefined;
        this.codes.delete(key);
        while (this.tokens.size >= MAX_TOKENS) this.drop(this.tokens.keys().next().value!);
        const token = randomBytes(32).toString("hex");
        // Kept out of transcripts and tool output, like the desktop app's own token.
        registerSecret(token, "sign-in");
        this.tokens.set(digest(token), { machine: grant.machine, client: grant.client, expires: this.now() + TOKEN_TTL_MS, secret: token });
        return token;
    }

    check(token: string): { machine: string; client?: string } | undefined {
        if (!/^[0-9a-f]{64}$/.test(token)) return undefined;
        const key = digest(token);
        const grant = this.tokens.get(key);
        if (!grant) return undefined;
        if (grant.expires < this.now()) {
            this.drop(key);
            return undefined;
        }
        return { machine: grant.machine, client: grant.client };
    }

    /** What signs `machine` in stops working: all of it, or what one of its clients was given. */
    revoke(machine: string, client?: string) {
        const theirs = (g: Grant) => g.machine === machine && (client === undefined || g.client === client);
        for (const [k, g] of this.codes) if (theirs(g)) this.codes.delete(k);
        for (const [k, g] of this.tokens) if (theirs(g)) this.drop(k);
    }
}

/** What machines have signed in called themselves, for `status`. Not what lets them in. */
function machineLabels(): Record<string, { label: string; at: string }> {
    try {
        const data = JSON.parse(readFileSync(machinesFile(), "utf-8")) as Record<string, { label?: unknown; at?: unknown }>;
        const out: Record<string, { label: string; at: string }> = {};
        for (const [id, m] of Object.entries(data)) if (MACHINE_ID.test(id) && typeof m?.label === "string" && typeof m.at === "string") out[id] = { label: m.label, at: m.at };
        return out;
    } catch {
        return {};
    }
}

function noteMachine(id: string, label: string | undefined) {
    const all = machineLabels();
    if (label === undefined) delete all[id];
    else all[id] = { label, at: new Date().toISOString() };
    const kept = Object.entries(all)
        .sort((a, b) => b[1].at.localeCompare(a[1].at))
        .slice(0, 64);
    try {
        writeJson(machinesFile(), Object.fromEntries(kept), 0o600);
    } catch {
        // only names
    }
}

const cleanLabel = (v: unknown) =>
    String(v ?? "")
        .replace(/[^\w .-]/g, "")
        .trim()
        .slice(0, 60) || "a machine";

// ---------------------------------------------------------------------------
// Talking to the running server from another `cavvy host` command.

async function control<T>(path: string, body?: unknown, timeoutMs = 5000): Promise<T | undefined> {
    if (!existsSync(socketPath())) return undefined;
    try {
        const r = await fetch(`http://cavvy${path}`, { unix: socketPath(), method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
        if (!r.ok) return undefined;
        return (await r.json()) as T;
    } catch {
        return undefined;
    }
}

/** The server running for this user, if one answers. */
export function hostStatus(): Promise<HostStatus | undefined> {
    return control<HostStatus>("/status");
}

// ---------------------------------------------------------------------------
// `cavvy host run`

function die(msg: string): never {
    process.stderr.write(`${APP_NAME}: ${msg}\n`);
    process.exit(1);
}

/**
 * Makes this process the server here, or says which process already is
 * (-1: one that's claiming it this moment and never finished).
 *
 * A lock can name a process that's running and isn't the server: the server
 * died without letting go (the machine lost power, it was killed), and after
 * a reboot some other program has its pid. The session lock this builds on
 * only gives way to a pid that's gone, so that lock is removed here, under the
 * same guard file that keeps two starters from each removing the other's.
 */
function claim(): number | undefined {
    const lock = `${lockTarget()}.lock`;
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            hold(lockTarget());
            return undefined;
        } catch (e) {
            if (!(e instanceof SessionInUseError)) throw e;
            // Another is claiming it this moment.
            if (e.pid < 0) {
                Bun.sleepSync(400);
                continue;
            }
            if (isHost(e.pid)) return e.pid;
            // One that's only just started hasn't written what it is yet.
            if (attempt < 2) {
                Bun.sleepSync(400);
                continue;
            }
            removeForeignLock(lock, e.pid);
        }
    }
    return -1;
}

/** Removes the lock if it still names `pid` and that still isn't the server. */
function removeForeignLock(lock: string, pid: number) {
    const guard = `${lock}.takeover`;
    let fd: number;
    try {
        fd = openSync(guard, "wx", 0o600);
    } catch {
        // Another starter is at it; one that crashed doing so left this behind.
        try {
            if (Date.now() - statSync(guard).mtimeMs > 10_000) unlinkSync(guard);
        } catch {
            // gone meanwhile
        }
        return;
    }
    try {
        const named = Number((JSON.parse(readFileSync(lock, "utf-8")) as { pid?: unknown }).pid);
        if (named === pid && !isHost(pid)) unlinkSync(lock);
    } catch {
        // gone, or not a lock: the next attempt sees what's there
    } finally {
        closeSync(fd);
        try {
            unlinkSync(guard);
        } catch {
            // already gone
        }
    }
}

export interface HostRunEnv {
    fallbackModel?: string;
    notes: string[];
}

export async function hostRun(args: string[], env: HostRunEnv): Promise<void> {
    let port: number | undefined;
    let loginEnv = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === "--login-env") loginEnv = true;
        else if (a === "--port") {
            port = Number(args[++i]);
            if (!Number.isInteger(port) || port < 0 || port > 65535) die("--port must be a port number");
        } else die(`unknown option ${a}`);
    }
    const dir = ensureDir(hostDir());
    chmodSync(dir, 0o700);
    const other = claim();
    if (other !== undefined && other > 0) {
        process.stderr.write(`${APP_NAME}: a server is already running here (pid ${other}).\n`);
        process.exit(0);
    }
    // Not "already running": nothing is, and whatever starts servers should know this one didn't.
    if (other !== undefined) die(`couldn't take ${lockTarget()}.lock. Delete it if no Cavvy server is running here.`);
    const base = { pid: process.pid, start: processStart(process.pid), startedAt: new Date().toISOString(), ...hostVersion() };
    /** This run, as machines tell it from the one before (it's in every health check, so nothing secret). */
    const run = `${process.pid}-${Date.now().toString(36)}`;
    const writeState = (p: number) => writeJson(stateFile(), { ...base, port: p } satisfies HostState, 0o600);
    writeState(0);

    const log = (msg: string) => process.stderr.write(`[${APP_NAME} host] ${redact(msg)}\n`);
    if (loginEnv) {
        const { adoptLoginPath } = await import("../server/login-env");
        await adoptLoginPath(paths.loginPath());
    }
    const { startServer } = await import("../server/server");
    const { defaultStatic } = await import("../server/cli");
    // What a CLI that isn't signed in is told to do says it's to be done here.
    (await import("../backends/account-login")).signInsOnServer();
    const signIns = new MachineSignIns();
    // The GUI that came with this build. CAVVY_GUI_DIST, when set, is the only place looked in (tests name the build's own).
    const named = process.env.CAVVY_GUI_DIST;
    const staticDir = named === undefined ? defaultStatic() : existsSync(join(named, "index.html")) ? named : undefined;
    const srv = await startServer({ host: "127.0.0.1", port, signIns, run, staticDir, startCwd: homedir(), fallbackModel: env.fallbackModel, log, away: true });
    for (const n of env.notes) log(`note: ${n}`);

    let stopping = false;
    let controlServer: ReturnType<typeof Bun.serve> | undefined;
    const shutdown = async (code = 0) => {
        if (stopping) return;
        stopping = true;
        log("stopping");
        // Sessions get the time to close their CLIs and shells; systemd's own limit is longer (service.ts).
        const timer = setTimeout(() => process.exit(code), 20_000);
        controlServer?.stop(true);
        await srv.stop().catch(() => undefined);
        clearTimeout(timer);
        rmSync(socketPath(), { force: true });
        rmSync(stateFile(), { force: true });
        process.exit(code);
    };
    process.on("SIGINT", () => void shutdown(0));
    process.on("SIGTERM", () => void shutdown(0));
    process.on("SIGHUP", () => void shutdown(0));
    process.on("unhandledRejection", (e) => log(`internal error: ${(e as Error)?.stack ?? String(e)}`));

    const status = (): HostStatus => {
        const labels = machineLabels();
        return { running: true, ...base, port: srv.port, ...srv.engine.activity(), machines: [...srv.machines()].map(([id, connections]) => ({ id, label: labels[id]?.label ?? "a machine", connections })), gui: Boolean(staticDir) };
    };
    rmSync(socketPath(), { force: true });
    controlServer = Bun.serve({
        unix: socketPath(),
        async fetch(req) {
            const path = new URL(req.url).pathname;
            if (req.method === "GET" && path === "/status") return Response.json(status());
            if (req.method !== "POST") return new Response("Not found", { status: 404 });
            let body: Record<string, unknown> = {};
            try {
                const parsed: unknown = await req.json();
                if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
            } catch {
                // no body
            }
            const machine = typeof body.machine === "string" && MACHINE_ID.test(body.machine) ? body.machine : undefined;
            const client = typeof body.client === "string" && CLIENT_ID.test(body.client) ? body.client : undefined;
            if (path === "/pair") {
                if (!machine) return Response.json({ error: "A machine id is 32 hex digits." }, { status: 400 });
                noteMachine(machine, cleanLabel(body.label));
                return Response.json({ code: signIns.pair(machine, client), port: srv.port, run, gui: Boolean(staticDir), ...hostVersion() });
            }
            if (path === "/revoke") {
                if (!machine) return Response.json({ error: "A machine id is 32 hex digits." }, { status: 400 });
                signIns.revoke(machine, client);
                // The machine itself is forgotten only when all of it is signed out.
                if (!client) noteMachine(machine, undefined);
                return Response.json({ closed: srv.dropMachine(machine, client) });
            }
            if (path === "/connect-cli") {
                // A CLI signed in here by `host login`: turned on as the GUI's own Connect does, which checks it again.
                const provider = typeof body.provider === "string" && agentCli(body.provider) ? body.provider : undefined;
                if (!provider) return Response.json({ error: "Not an agent CLI." }, { status: 400 });
                try {
                    await srv.engine.connectCli(provider);
                    return Response.json({ ok: true });
                } catch (e) {
                    return Response.json({ ok: false, error: redact((e as Error)?.message ?? String(e)) });
                }
            }
            if (path === "/stop") {
                setTimeout(() => void shutdown(0), 50);
                return Response.json({ pid: process.pid });
            }
            return new Response("Not found", { status: 404 });
        },
    });
    chmodSync(socketPath(), 0o600);
    writeState(srv.port);
    log(`running (pid ${process.pid}, build ${base.build})`);
}

// ---------------------------------------------------------------------------
// What a server has for agents to use: `cavvy host check`.

export interface HostCheck {
    /** `on`: turned on in this Cavvy, so its models are offered (left out by a server from before it was said). */
    clis: { id: string; product: string; installed: boolean; signedIn?: boolean; on?: boolean; install: string; signIn: string }[];
    git: boolean;
    gh: { installed: boolean; signedIn?: boolean };
    /** A Chrome the Browser tool can drive. */
    browser: boolean;
    /** The sandbox Cavvy's own models' commands can run in, if this machine has one that works. */
    sandbox?: string;
    /** That sandbox is in use (Linux's is off until its settings turn it on). Left out by a server from before it was said. */
    sandboxOn?: boolean;
    /** The permission mode sessions start in there. Left out by a server from before it was said. */
    mode?: PermissionMode;
    memMb: number;
}

async function runs(argv: string[], timeoutMs = 15_000): Promise<boolean> {
    try {
        const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: childEnv() });
        const timer = setTimeout(() => proc.kill(), timeoutMs);
        const code = await proc.exited;
        clearTimeout(timer);
        return code === 0;
    } catch {
        return false;
    }
}

const expandHome = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export async function hostCheck(): Promise<HostCheck> {
    const which = (name: string) => Bun.which(name, { PATH: process.env.PATH ?? "" });
    const clis = await Promise.all(
        AGENT_CLIS.map(async (def) => {
            const installed = Boolean(findCli(def.id, def.cli));
            let signedIn: boolean | undefined;
            if (installed && def.id === "claude-code") {
                const { claudeStatus } = await import("../backends/claude-code");
                signedIn = await claudeStatus().then(
                    (s) => s.loggedIn,
                    () => undefined,
                );
            } else if (installed && def.account) {
                // The file its sign-in leaves in its own folder.
                const folder = process.env[def.account.configDirEnv] || expandHome(def.account.defaultFolder);
                signedIn = def.account.credentialFiles.some((f) => existsSync(join(folder, f)));
            }
            return { id: def.id, product: def.cli.product, installed, signedIn, on: Boolean(readAgentConfig(def.id)), install: def.cli.install, signIn: def.cli.signIn };
        }),
    );
    const gh = which("gh");
    // This user's own settings: no project is open here.
    let settings: Settings = {};
    try {
        settings = loadSettings(homedir(), { trusted: false });
    } catch {
        // unreadable: as none
    }
    let browser = false;
    try {
        browser = cachedChrome(settings.browser?.executable).ok;
    } catch {
        browser = false;
    }
    return {
        clis,
        git: Boolean(which("git")),
        gh: { installed: Boolean(gh), signedIn: gh ? await runs([gh, "auth", "status", "--hostname", "github.com"]) : undefined },
        browser,
        sandbox: sandboxKind(),
        sandboxOn: sandboxEnabled(settings.sandbox),
        mode: defaultMode(settings, homedir()).mode,
        memMb: Math.round(totalmem() / 1024 / 1024),
    };
}

// ---------------------------------------------------------------------------
// Signing a CLI in here, from the terminal of a machine that came in over SSH: `cavvy host login <cli>`.

/**
 * Makes an agent CLI usable here: signs it in with its own sign-in, in this terminal, when it isn't, then turns it
 * on in Cavvy so its models are offered. Cavvy never sees what's typed: the CLI has the terminal.
 */
async function hostLogin(id: string | undefined): Promise<number> {
    const def = id ? agentCli(id) : undefined;
    if (!def) {
        process.stderr.write(`login needs one of: ${AGENT_CLIS.map((d) => d.id).join(", ")}\n`);
        return LOGIN_EXIT.unknown;
    }
    const { adoptLoginPath } = await import("../server/login-env");
    // Found where the server finds it: with what the login shell puts on PATH.
    await (await adoptLoginPath(paths.loginPath())).answered;
    const { checkAgentCli } = await import("../backends");
    // Ctrl+C while the CLI's own sign-in has the terminal is the CLI's to take (it ends, and what it left is looked
    // at below). At any other moment it stops this, and says so by its exit code: not a connection that was lost.
    let signingIn = false;
    process.on("SIGINT", () => {
        if (!signingIn) process.exit(LOGIN_EXIT.stopped);
    });
    // A check that fails says nothing about whether the CLI is there: its own words are passed on.
    const status = async () => {
        try {
            return await checkAgentCli(def.id);
        } catch (e) {
            process.stderr.write(`${redact((e as Error)?.message ?? String(e))}\n`);
            return undefined;
        }
    };
    let st = await status();
    if (!st) return LOGIN_EXIT.problem;
    if (!st.installed) return LOGIN_EXIT.notInstalled;
    if (st.problem) {
        process.stderr.write(`${redact(st.problem)}\n`);
        return LOGIN_EXIT.problem;
    }
    if (!st.signedIn) {
        // With no terminal there's nowhere for its link to show or its code to be typed.
        if (!process.stdin.isTTY) return LOGIN_EXIT.notSignedIn;
        const command = loginCommand(def.id, "default", { away: true });
        signingIn = true;
        const proc = Bun.spawn(command.argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: command.env });
        await proc.exited;
        signingIn = false;
        st = await status();
        if (!st) return LOGIN_EXIT.problem;
        if (!st.signedIn) return LOGIN_EXIT.notSignedIn;
    }
    // The Cavvy running here turns it on itself, so its models are offered at once. With none running (or one from
    // before it could be asked), it's turned on for the next one to find.
    const r = await control<{ ok: boolean; error?: string }>("/connect-cli", { provider: def.id }, 60_000);
    if (!r) saveAgentConfig(def.id);
    else if (!r.ok) {
        process.stderr.write(`${redact(r.error ?? `Couldn't turn ${def.name} on.`)}\n`);
        return LOGIN_EXIT.problem;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// `cavvy host <command>`

/** Exit code for "no server is running here": told apart from a command that failed. */
export const NOT_RUNNING = 3;

export async function hostCommand(args: string[], env: HostRunEnv): Promise<number> {
    const sub = args[0];
    const rest = args.slice(1);
    const flag = (name: string) => {
        const i = rest.indexOf(name);
        return i >= 0 ? rest[i + 1] : undefined;
    };
    const print = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");
    if (sub === "run") {
        await hostRun(rest, env);
        // Runs until it's stopped.
        return new Promise<number>(() => {});
    }
    if (sub === "version") {
        print(hostVersion());
        return 0;
    }
    if (sub === "status") {
        const s = await hostStatus();
        print(s ?? { running: false, ...hostVersion() });
        return s ? 0 : NOT_RUNNING;
    }
    if (sub === "pair") {
        const machine = flag("--machine");
        if (!machine || !MACHINE_ID.test(machine)) die("pair needs --machine <id>");
        const r = await control<Record<string, unknown>>("/pair", { machine, label: flag("--label"), client: flag("--client") });
        if (!r) return NOT_RUNNING;
        print(r);
        return 0;
    }
    if (sub === "revoke") {
        const machine = flag("--machine");
        if (!machine || !MACHINE_ID.test(machine)) die("revoke needs --machine <id>");
        const r = await control<Record<string, unknown>>("/revoke", { machine, client: flag("--client") });
        // With no server running, nothing signs that machine in anyway.
        print(r ?? { closed: 0 });
        return 0;
    }
    if (sub === "stop") {
        const r = await control<{ pid: number }>("/stop", {});
        if (!r) return NOT_RUNNING;
        // Until it's really gone: whatever starts the next one mustn't find this one still closing its sessions.
        const start = processStart(r.pid);
        for (let i = 0; i < 300; i++) {
            if (!start || processStart(r.pid) !== start) return 0;
            await Bun.sleep(100);
        }
        die(`the server (pid ${r.pid}) didn't stop within 30 seconds.`);
    }
    if (sub === "check") {
        const { adoptLoginPath } = await import("../server/login-env");
        // As the server sees it: with the tools your login shell puts on PATH.
        await (await adoptLoginPath(paths.loginPath())).answered;
        print(await hostCheck());
        return 0;
    }
    if (sub === "login") return hostLogin(rest[0]);
    process.stderr.write(`Usage: ${APP_NAME} host <run|status|pair|revoke|stop|check|login|version>\n\nWhat a server runs for the machines that connect to it. \`${APP_NAME} servers\` on your own machine sets it up.\n`);
    return sub === undefined || sub === "-h" || sub === "--help" ? 0 : 1;
}
