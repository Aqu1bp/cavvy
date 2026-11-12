// A connection to a server's Cavvy: an SSH tunnel from a port on this
// machine's loopback to the server's own, and a sign-in made over SSH.
//
// ServerLink keeps one up. When the connection drops it comes back by itself,
// on the same local port, so what was talking through it only has to try
// again. What can't come back without the user (a key refused, a host key
// that changed, Cavvy gone from the server) stops it and is said once; only
// "can't reach it" is tried for as long as it takes, since that's a laptop
// asleep or off the network.

import { randomBytes } from "crypto";
import { connect, createServer } from "net";
import { childEnv } from "../util/env";
import { NotSetUp, pairOverSsh, revokeOverSsh, StoppedThere, type Pairing } from "./service";
import { hostOf, printable, sshFailure, SshError, sshTunnelArgv } from "./ssh";
import { ServerError, thisDesktop, type ServerEntry } from "./store";

/** A port on this machine nothing listens on right now. */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = createServer();
        s.once("error", reject);
        s.listen(0, "127.0.0.1", () => {
            const a = s.address();
            const port = typeof a === "object" && a ? a.port : 0;
            s.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
        });
    });
}

/**
 * One HTTP request to this machine's own loopback, over a socket of its own.
 * Not `fetch`: with HTTP_PROXY set that would hand the request, sign-in code
 * and all, to the proxy.
 */
function loopback(port: number, method: "GET" | "POST", path: string, body: string | undefined, timeoutMs: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const socket = connect(port, "127.0.0.1");
        const chunks: Buffer[] = [];
        let size = 0;
        const timer = setTimeout(() => socket.destroy(new Error("no answer in time")), timeoutMs);
        socket.on("connect", () => {
            const payload = body ?? "";
            const about = body === undefined ? "" : `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n`;
            socket.write(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n${about}\r\n${payload}`);
        });
        socket.on("data", (d: Buffer) => {
            chunks.push(d);
            size += d.length;
            if (size > 1_000_000) socket.destroy(new Error("too long an answer"));
        });
        socket.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
        socket.on("close", () => {
            clearTimeout(timer);
            const all = Buffer.concat(chunks);
            const end = all.indexOf("\r\n\r\n");
            const head = end < 0 ? "" : all.subarray(0, end).toString("latin1");
            const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1]);
            if (!status) return reject(new Error("not an HTTP answer"));
            let rest = all.subarray(end + 4);
            if (/^transfer-encoding:\s*chunked/im.test(head)) {
                const parts: Buffer[] = [];
                for (;;) {
                    const eol = rest.indexOf("\r\n");
                    const n = eol < 0 ? 0 : parseInt(rest.subarray(0, eol).toString("latin1"), 16);
                    if (!n) break;
                    parts.push(rest.subarray(eol + 2, eol + 2 + n));
                    rest = rest.subarray(eol + 2 + n + 2);
                }
                rest = Buffer.concat(parts);
            }
            resolve({ status, body: rest.toString("utf-8") });
        });
    });
}

const STDERR_TAIL = 8000;
/** How long ssh has to connect, sign in and open the forward. */
const OPEN_MS = 30_000;

/** `ssh -N -L`: this machine's `localPort` is the server's `remotePort` while it runs. */
export class Tunnel {
    private err = "";
    private stopped = false;
    /** Settles when ssh is gone: why, unless it was stopped here. */
    readonly closed: Promise<SshError | undefined>;

    private constructor(
        private readonly entry: ServerEntry,
        private readonly proc: Bun.Subprocess<"ignore", "ignore", "pipe">,
        readonly localPort: number,
    ) {
        void (async () => {
            const d = new TextDecoder();
            try {
                for await (const chunk of proc.stderr) this.err = (this.err + d.decode(chunk, { stream: true })).slice(-STDERR_TAIL);
            } catch {
                // gone
            }
        })();
        this.closed = proc.exited.then(async () => {
            if (this.stopped) return undefined;
            // What it said last may still be on its way.
            await Bun.sleep(50);
            return sshFailure(this.err || "Connection closed by remote host", entry);
        });
    }

    /** `run`: the server run it should lead to (the one just signed in to); what answers as anything else doesn't count. */
    static async open(entry: ServerEntry, remotePort: number, o: { localPort?: number; signal?: AbortSignal; run?: string } = {}): Promise<Tunnel> {
        for (let attempt = 0; ; attempt++) {
            const localPort = o.localPort ?? (await freePort());
            const proc = Bun.spawn(sshTunnelArgv(entry, localPort, remotePort), { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: childEnv() });
            const tunnel = new Tunnel(entry, proc, localPort);
            const abort = () => void tunnel.stop();
            o.signal?.addEventListener("abort", abort, { once: true });
            try {
                const up = await Promise.race([tunnel.answers(o.run, o.signal), tunnel.closed.then((e) => e ?? new SshError("other", "Stopped."))]);
                if (up === true) return tunnel;
                await tunnel.stop();
                // The port was taken between finding it and ssh binding it: another one, a few times.
                if (up instanceof SshError && /Address already in use|cannot listen to port|Could not request local forwarding/i.test(tunnel.err) && o.localPort === undefined && attempt < 3) continue;
                throw up instanceof SshError ? up : new SshError("unreachable", `${hostOf(entry)} didn't answer in time.`);
            } finally {
                o.signal?.removeEventListener("abort", abort);
            }
        }
    }

    /** True once the server's Cavvy answers through it (as `run`, when one is expected); false when it hasn't in time. */
    private async answers(run: string | undefined, signal?: AbortSignal): Promise<boolean> {
        const until = Date.now() + OPEN_MS;
        while (Date.now() < until && !this.stopped && !signal?.aborted) {
            const now = await this.health();
            if (now !== undefined && (run === undefined || now === run)) return true;
            await Bun.sleep(150);
        }
        return false;
    }

    /** Which run of the server answers through it now ("" for one that doesn't say): undefined when nothing does. */
    async health(timeoutMs = 2000): Promise<string | undefined> {
        try {
            const r = await loopback(this.localPort, "GET", "/healthz", undefined, timeoutMs);
            if (r.status !== 200) return undefined;
            return r.body === "ok" ? "" : r.body.startsWith("ok ") ? r.body.slice(3) : undefined;
        } catch {
            return undefined;
        }
    }

    /** Stopped here, or ssh is gone: nothing goes through it any more. */
    get over(): boolean {
        return this.stopped || this.proc.exitCode !== null;
    }

    async stop(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        this.proc.kill();
        await Promise.race([this.proc.exited, Bun.sleep(2000)]);
        if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
    }
}

/** Trades a pairing code for the token a client connects with (`auth.<token>` on the WebSocket). */
export async function exchangeCode(localPort: number, code: string): Promise<string> {
    let r: { status: number; body: string };
    try {
        r = await loopback(localPort, "POST", "/auth/exchange", JSON.stringify({ code }), 15_000);
    } catch {
        throw new ServerError("The server didn't answer the sign-in.");
    }
    let body: { token?: unknown; error?: unknown } = {};
    try {
        body = JSON.parse(r.body) as typeof body;
    } catch {
        // said below
    }
    if (r.status !== 200 || typeof body.token !== "string" || !/^[0-9a-f]{64}$/.test(body.token)) throw new ServerError(typeof body.error === "string" ? printable(body.error) : "The server didn't accept the sign-in.");
    return body.token;
}

/** Waits `ms`, or until `signal` aborts, leaving nothing behind either way. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
    });
}

export type LinkState =
    | { state: "connecting" }
    | { state: "connected"; localPort: number; pairing: Pairing }
    /** Lost, and being tried again by itself. */
    | { state: "reconnecting"; error: SshError | ServerError; attempt: number }
    /** Over: stopped here, or it can't come back without the user (`error`). */
    | { state: "stopped"; error?: SshError | ServerError };

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];
/** How often a connection that's up is asked whether the server still answers through it. */
const HEALTH_EVERY_MS = 5000;
/** Checks in a row without an answer before the connection is made again. */
const HEALTH_MISSES = 3;
/** Failures nobody can name are tried this many times in a row, not for ever. */
const UNKNOWN_TRIES = 5;

export class ServerLink {
    private tunnel?: Tunnel;
    private port?: number;
    /** This link's sign-ins on the server, by the name each was made under: taken away when it's stopped for good. */
    private readonly client = randomBytes(8).toString("hex");
    private stopping = new AbortController();
    private current: LinkState = { state: "connecting" };
    private first?: Promise<void>;

    constructor(
        readonly entry: ServerEntry,
        private readonly o: { onState?: (s: LinkState) => void; backoffMs?: number[]; healthEveryMs?: number } = {},
    ) {}

    get state(): LinkState {
        return this.current;
    }

    /** This machine's end of the tunnel, once there's been one. It stays the same across reconnects. */
    get localPort(): number | undefined {
        return this.port;
    }

    private set(s: LinkState) {
        this.current = s;
        this.o.onState?.(s);
    }

    /** Connects, then keeps it connected. Throws if the first connection fails: nothing is retried until one has worked. */
    start(): Promise<void> {
        return (this.first ??= (async () => {
            try {
                await this.open();
            } catch (e) {
                this.set({ state: "stopped", error: e as ServerError });
                throw e;
            }
            void this.watch();
        })());
    }

    private async open(resume = false): Promise<void> {
        const signal = this.stopping.signal;
        const pairing = await pairOverSsh(this.entry, { ...thisDesktop(), client: this.client }, { signal, resume });
        this.tunnel = await Tunnel.open(this.entry, pairing.port, { localPort: this.port, signal, run: pairing.run });
        this.port = this.tunnel.localPort;
        this.set({ state: "connected", localPort: this.port, pairing });
    }

    /**
     * Settles when the server no longer answers through the tunnel as the run this machine signed in to, though
     * ssh itself is still there: Cavvy was restarted (it listens on another port now, and has forgotten every
     * sign-in), or stopped.
     */
    private async unanswered(tunnel: Tunnel, run: string): Promise<SshError> {
        const every = this.o.healthEveryMs ?? HEALTH_EVERY_MS;
        for (let misses = 0; ; ) {
            await Bun.sleep(every);
            // Its end is told another way (Tunnel.closed), and nothing is left to ask.
            if (tunnel.over) return new Promise<SshError>(() => {});
            const now = await tunnel.health(Math.min(4000, Math.max(500, every)));
            if (now !== undefined && (now === "" || now === run)) misses = 0;
            else if (now !== undefined || ++misses >= HEALTH_MISSES) return new SshError("unreachable", `Cavvy on ${this.entry.name} restarted.`);
        }
    }

    private async watch(): Promise<void> {
        let unknown = 0;
        for (;;) {
            const tunnel = this.tunnel!;
            const run = this.current.state === "connected" ? this.current.pairing.run : "";
            const lost = await Promise.race([tunnel.closed, this.unanswered(tunnel, run)]);
            if (this.stopping.signal.aborted || !lost) return;
            // ssh may still be there, carrying a port nothing listens on any more.
            await tunnel.stop();
            let error: SshError | ServerError = lost;
            for (let attempt = 1; ; attempt++) {
                const permanent = error instanceof SshError ? error.permanent : error instanceof NotSetUp || error instanceof StoppedThere;
                // Not ssh's "can't reach it": something with no name, which may never get better.
                unknown = !(error instanceof SshError) || error.kind === "other" ? unknown + 1 : 0;
                if (permanent || unknown > UNKNOWN_TRIES) return this.set({ state: "stopped", error });
                this.set({ state: "reconnecting", error, attempt });
                const backoff = this.o.backoffMs ?? BACKOFF_MS;
                await pause(backoff[Math.min(attempt - 1, backoff.length - 1)]!, this.stopping.signal);
                if (this.stopping.signal.aborted) return;
                try {
                    await this.open(true);
                    unknown = 0;
                    break;
                } catch (e) {
                    if (this.stopping.signal.aborted) return;
                    error = e instanceof ServerError ? e : new ServerError((e as Error).message);
                }
            }
        }
    }

    /** A new sign-in for one more client (a browser tab, a window), through the tunnel that's up. */
    async pair(): Promise<Pairing> {
        return pairOverSsh(this.entry, { ...thisDesktop(), client: this.client }, { signal: this.stopping.signal, resume: true });
    }

    private ending?: Promise<void>;

    /**
     * Ends it. `signOut`: what it signed in on the server stops working too, so
     * nothing a page still holds is good for whoever next listens on its port.
     * Other connections from this machine keep their own sign-ins. Asked twice,
     * it's the one ending both wait for.
     */
    stop(o: { signOut?: boolean } = {}): Promise<void> {
        return (this.ending ??= (async () => {
            const was = this.current.state;
            this.stopping.abort();
            await this.tunnel?.stop();
            if (this.current.state !== "stopped") this.set({ state: "stopped" });
            // Not held up for long by a server that can't be reached: its sign-ins end by themselves.
            if (o.signOut && was !== "stopped") await Promise.race([revokeOverSsh(this.entry, thisDesktop().id, { client: this.client }).catch(() => undefined), Bun.sleep(6000)]);
        })());
    }
}
