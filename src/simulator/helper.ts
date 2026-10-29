// The helper that drives a booted simulator (helper.swift): built on first use with the swiftc of the user's own
// Xcode (simulators need Xcode, so it's there), kept in Cavvy's home per Xcode, and run once per device in use. Each
// build is named and signed cavvy-sim, in a folder of its own: macOS keeps Vision's text model ready for a program by
// its name and signature, so a new build doesn't load it again (half a minute or more).

import { createHash, randomBytes } from "crypto";
import { spawn, type ChildProcessByStdio } from "child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import type { Readable, Writable } from "stream";
import { paths } from "../config/paths";
import SOURCE from "./helper.swift" with { type: "text" };
import { run, SimulatorError } from "./simctl";

const BUILD_MS = 180_000;

let building = new Map<string, Promise<string>>();

/** The helper for this Xcode: built when it isn't yet (a few seconds), then reused. */
export function helperBinary(developerDir: string): Promise<string> {
    const hash = createHash("sha256").update(SOURCE).update("\0").update(developerDir).digest("hex").slice(0, 16);
    const dir = join(paths.home(), "simulator");
    const bin = join(dir, hash, "cavvy-sim");
    if (existsSync(bin)) return Promise.resolve(bin);
    let pending = building.get(bin);
    if (!pending) {
        pending = build(dir, bin, developerDir).finally(() => building.delete(bin));
        building.set(bin, pending);
    }
    return pending;
}

async function build(dir: string, bin: string, developerDir: string): Promise<string> {
    mkdirSync(dirname(bin), { recursive: true, mode: 0o700 });
    const tag = randomBytes(4).toString("hex");
    const src = join(dir, `helper-${tag}.swift`);
    // Linked under its own name, which its signature takes.
    const tmpDir = join(dirname(bin), `.build-${tag}`);
    const tmp = join(tmpDir, basename(bin));
    mkdirSync(tmpDir, { mode: 0o700 });
    writeFileSync(src, SOURCE, { mode: 0o600 });
    try {
        const r = await run(["xcrun", "swiftc", "-O", "-swift-version", "5", "-suppress-warnings", "-o", tmp, src], { timeoutMs: BUILD_MS, env: { DEVELOPER_DIR: developerDir } });
        if (r.code !== 0) throw new SimulatorError(`Couldn't build Cavvy's simulator helper with this Xcode: ${(r.stderr || r.stdout).split("\n").find((l) => /error/.test(l))?.trim() ?? "swiftc failed"}`);
        chmodSync(tmp, 0o700);
        // Another Cavvy may have built it meanwhile: either copy will do.
        renameSync(tmp, bin);
        // Builds for an earlier Cavvy or Xcode go (one still running keeps its copy until it ends), and so do those
        // named by their hash, from before.
        for (const name of readdirSync(dir)) if (/^(cavvy-sim-)?[0-9a-f]{16}$/.test(name) && join(dir, name) !== dirname(bin)) rmSync(join(dir, name), { recursive: true, force: true });
        return bin;
    } finally {
        rmSync(src, { force: true });
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

/** Tests: forget builds in progress. */
export function resetHelperBuilds() {
    building = new Map();
}

// ---------------------------------------------------------------------------

/** The screen's size in device pixels, and how many pixels make a point. */
export interface ScreenSize {
    width: number;
    height: number;
    scale: number;
}

export interface HelperEvents {
    frame(jpeg: Uint8Array, size: ScreenSize): void;
    size(size: ScreenSize): void;
    /** Another tool has taken the device's input (see helper.swift): it doesn't come back until the device restarts. */
    taken(): void;
    exit(error: string | undefined): void;
}

type Reply = Record<string, unknown> & { error?: string };

interface Pending {
    resolve: (r: Reply & { png?: Uint8Array }) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** How long a command may take; describing a busy screen can take a few seconds. */
const COMMAND_MS = 20_000;

/** One running helper, attached to one booted device. */
export class SimHelper {
    private seq = 0;
    private pending = new Map<number, Pending>();
    /** What's come from the helper and not been read yet: joined once a whole message is in, not on each chunk. */
    private chunks: Buffer[] = [];
    private buffered = 0;
    private exited = false;
    private lastError?: string;
    size?: ScreenSize;
    /** Another tool has the device's input: what's sent to it goes nowhere. */
    inputTaken = false;
    readonly ready: Promise<ScreenSize>;

    private constructor(
        private child: ChildProcessByStdio<Writable, Readable, Readable>,
        private events: Partial<HelperEvents>,
    ) {
        let readyResolve!: (s: ScreenSize) => void;
        let readyReject!: (e: Error) => void;
        this.ready = new Promise((res, rej) => ((readyResolve = res), (readyReject = rej)));
        this.ready.catch(() => undefined);
        child.stdout.on("data", (d: Buffer) => this.read(d, readyResolve));
        child.stderr.on("data", () => undefined);
        child.stdin.on("error", () => undefined);
        child.on("exit", () => {
            this.exited = true;
            const error = this.lastError ?? "The simulator helper stopped.";
            readyReject(new SimulatorError(error));
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(new SimulatorError(error));
            }
            this.pending.clear();
            this.events.exit?.(this.lastError);
        });
    }

    static start(bin: string, developerDir: string, udid: string, events: Partial<HelperEvents>): SimHelper {
        const child = spawn(bin, [developerDir, udid], { stdio: ["pipe", "pipe", "pipe"] });
        return new SimHelper(child, events);
    }

    get running(): boolean {
        return !this.exited;
    }

    private read(chunk: Buffer, ready: (s: ScreenSize) => void) {
        this.chunks.push(chunk);
        this.buffered += chunk.length;
        while (this.buffered >= 5) {
            if (this.chunks[0]!.length < 5) this.chunks = [Buffer.concat(this.chunks)];
            const length = this.chunks[0]!.readUInt32BE(1);
            if (this.buffered < 5 + length) break;
            const buffer = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
            const type = String.fromCharCode(buffer[0]!);
            const payload = buffer.subarray(5, 5 + length);
            const rest = buffer.subarray(5 + length);
            this.chunks = rest.length ? [rest] : [];
            this.buffered = rest.length;
            if (type === "F") {
                if (this.size) this.events.frame?.(payload, this.size);
            } else if (type === "S") {
                const headerLength = payload.readUInt32BE(0);
                const meta = JSON.parse(payload.subarray(4, 4 + headerLength).toString("utf8")) as Reply & { id: number };
                this.settle(meta.id, { ...meta, png: new Uint8Array(payload.subarray(4 + headerLength)) });
            } else if (type === "J") {
                let msg: Reply & { id?: number; event?: string };
                try {
                    msg = JSON.parse(payload.toString("utf8"));
                } catch {
                    continue;
                }
                if (msg.event === "ready" || msg.event === "size") {
                    this.size = { width: Number(msg.width), height: Number(msg.height), scale: Number(msg.scale) || 1 };
                    if (msg.event === "ready") ready(this.size);
                    else this.events.size?.(this.size);
                } else if (msg.event === "input") {
                    if (msg.taken === true) this.taken();
                } else if (msg.event === "error") {
                    this.lastError = String(msg.message ?? "The simulator helper failed.");
                } else if (typeof msg.id === "number") this.settle(msg.id, msg);
            }
        }
    }

    private settle(id: number, reply: Reply & { png?: Uint8Array }) {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (reply.taken === true) this.taken();
        if (typeof reply.error === "string") p.reject(new SimulatorError(reply.error));
        else p.resolve(reply);
    }

    private taken() {
        if (this.inputTaken) return;
        this.inputTaken = true;
        this.events.taken?.();
    }

    /** Sends a command and waits for its answer. */
    call(command: Record<string, unknown>, timeoutMs = COMMAND_MS): Promise<Reply & { png?: Uint8Array }> {
        if (this.exited) return Promise.reject(new SimulatorError(this.lastError ?? "The simulator helper stopped."));
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new SimulatorError("The simulator didn't answer in time."));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
        });
    }

    /** Sends a command nobody waits for (a touch moving: the next one follows at once). Its failure is ignored. */
    send(command: Record<string, unknown>) {
        if (!this.exited) void this.call(command).catch(() => undefined);
    }

    stop() {
        if (this.exited) return;
        this.child.stdin.end();
        const child = this.child;
        setTimeout(() => {
            if (!this.exited) child.kill("SIGKILL");
        }, 2000).unref?.();
    }
}
