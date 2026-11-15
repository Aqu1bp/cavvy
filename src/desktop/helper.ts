// The helper that reads and acts in the person's Mac apps (helper.swift): built on first use with `xcrun swiftc`
// (Xcode or its command line tools) and kept in Cavvy's home under one name and path, Cavvy Desktop Control, since
// that's what macOS shows in Privacy & Security and keeps the person's grants for. The same source built again comes
// out the same (measured: the same code hash), so a grant lasts until the helper's source changes.

import { createHash, randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "fs";
import { join } from "path";
import { paths } from "../config/paths";
import { run } from "../simulator/simctl";
import { NEVER_OFFERED, NEVER_OFFERED_NAME_PATTERNS } from "./apps";
import SOURCE from "./helper.swift" with { type: "text" };

export class DesktopError extends Error {
    constructor(
        message: string,
        /** What the helper said went wrong: "accessibility", "screen", "outside", "front", "human", "cancelled", … */
        readonly code?: string,
    ) {
        super(message);
    }
}

/** The name macOS shows for it in System Settings. */
export const HELPER_NAME = "Cavvy Desktop Control";
const BUILD_MS = 180_000;

/**
 * The helper's source, with the never-offered list compiled in: it refuses those apps itself, whatever it's sent
 * (another process running it can't give it one).
 */
export function helperSource(): string {
    const ids = NEVER_OFFERED.map((a) => JSON.stringify(a.bundleId.toLowerCase())).join(", ");
    const names = NEVER_OFFERED_NAME_PATTERNS.map((r) => JSON.stringify(r.source)).join(", ");
    return `let NEVER_IDS: Set<String> = [${ids}]\nlet NEVER_NAME_PATTERNS: [String] = [${names}]\n\n${SOURCE}`;
}

export const sourceHash = () => createHash("sha256").update(helperSource()).digest("hex").slice(0, 16);

const dir = () => join(paths.home(), "desktop");
const recordFile = () => join(dir(), "build.json");

interface BuildRecord {
    /** The source the helper there was built from. */
    hash?: string;
    /** A build macOS let use Accessibility. */
    trusted?: string;
}

function record(): BuildRecord {
    try {
        return JSON.parse(readFileSync(recordFile(), "utf8")) as BuildRecord;
    } catch {
        return {};
    }
}

function writeRecord(r: BuildRecord) {
    writeFileSync(recordFile(), JSON.stringify(r), { mode: 0o600 });
}

/** The helper had Accessibility: noted, so that a later build that hasn't can say why. */
export function noteTrusted() {
    const r = record();
    if (r.hash && r.trusted !== r.hash) writeRecord({ ...r, trusted: r.hash });
}

/** An earlier build had Accessibility and this one hasn't: macOS keeps the switch on but no longer counts it. */
export function trustedBefore(): boolean {
    const r = record();
    return Boolean(r.trusted && r.trusted !== r.hash);
}

let building: Promise<string> | undefined;

/** The helper, built when it isn't yet or its source has changed (a few seconds). */
export function helperBinary(): Promise<string> {
    const bin = join(dir(), HELPER_NAME);
    if (existsSync(bin) && record().hash === sourceHash()) return Promise.resolve(bin);
    return (building ??= build(bin).finally(() => (building = undefined)));
}

async function build(bin: string): Promise<string> {
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    const tag = randomBytes(4).toString("hex");
    const src = join(dir(), `helper-${tag}.swift`);
    // Linked under its own name, which its signature takes.
    const tmpDir = join(dir(), `.build-${tag}`);
    const tmp = join(tmpDir, HELPER_NAME);
    mkdirSync(tmpDir, { mode: 0o700 });
    writeFileSync(src, helperSource(), { mode: 0o600 });
    try {
        const r = await run(["xcrun", "swiftc", "-O", "-swift-version", "5", "-suppress-warnings", "-o", tmp, src], { timeoutMs: BUILD_MS }).catch((e: Error) => ({ code: 127, stdout: "", stderr: e.message }));
        if (r.code !== 0) {
            if (r.code === 127 || /xcrun: error|not found|no developer tools/i.test(r.stderr)) throw new DesktopError("Desktop control needs Apple's command line tools: run xcode-select --install, then try again.");
            throw new DesktopError(`Couldn't build ${HELPER_NAME}: ${(r.stderr || r.stdout).split("\n").find((l) => /error/.test(l))?.trim() ?? "swiftc failed"}`);
        }
        chmodSync(tmp, 0o700);
        // A helper still running keeps its own copy until it ends.
        renameSync(tmp, bin);
        writeRecord({ ...record(), hash: sourceHash() });
        return bin;
    } finally {
        rmSync(src, { force: true });
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

/** Tests: forget a build in progress. */
export function resetHelperBuild() {
    building = undefined;
}

// ---------------------------------------------------------------------------

/** The helper's process as Bun.spawn gives it: stdin to write, stdout to read, and fd 3, a pipe this process holds. */
interface HelperProcess {
    readonly pid: number;
    readonly stdin: { write(s: string): unknown; flush(): unknown; end(): unknown };
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stdio: (number | null | undefined)[];
    readonly exited: Promise<number>;
    kill(signal?: string): void;
}

export type Reply = Record<string, unknown> & { error?: string; code?: string; human?: number };

/** What a helper (or a fake one, in tests) does. */
export interface DesktopHelperLike {
    readonly running: boolean;
    /** The helper's own process: the person's input is counted per process. */
    readonly pid: number;
    /** How many times the person has used the mouse or keyboard since it started (as last heard). */
    readonly human: number;
    readonly ready: Promise<Reply>;
    call(command: Record<string, unknown>, timeoutMs?: number): Promise<Reply>;
    /** Stops the actions sent with this token, under way or still to come. */
    cancel(token: string): void;
    stop(): void;
    onExit(fn: () => void): void;
}

const COMMAND_MS = 20_000;

interface Pending {
    resolve: (r: Reply) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** One running helper: commands as JSON lines on its stdin, answers on its stdout. */
export class DesktopHelper implements DesktopHelperLike {
    private seq = 0;
    private pending = new Map<number, Pending>();
    private buffered = "";
    private exited = false;
    private exits: (() => void)[] = [];
    human = 0;
    readonly ready: Promise<Reply>;

    private constructor(private proc: HelperProcess) {
        let readyResolve!: (r: Reply) => void;
        let readyReject!: (e: Error) => void;
        this.ready = new Promise((res, rej) => ((readyResolve = res), (readyReject = rej)));
        this.ready.catch(() => undefined);
        const read = async () => {
            const decoder = new TextDecoder();
            for await (const chunk of proc.stdout) {
                this.buffered += decoder.decode(chunk, { stream: true });
                let nl: number;
                while ((nl = this.buffered.indexOf("\n")) >= 0) {
                    const line = this.buffered.slice(0, nl);
                    this.buffered = this.buffered.slice(nl + 1);
                    let msg: Reply & { id?: number; event?: string };
                    try {
                        msg = JSON.parse(line);
                    } catch {
                        continue;
                    }
                    if (typeof msg.human === "number") this.human = Math.max(this.human, msg.human);
                    if (msg.event === "ready") readyResolve(msg);
                    else if (typeof msg.id === "number") this.settle(msg.id, msg);
                }
            }
        };
        void read().catch(() => undefined);
        const ended = () => {
            if (this.exited) return;
            this.exited = true;
            readyReject(new DesktopError(`${HELPER_NAME} stopped.`));
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(new DesktopError(`${HELPER_NAME} stopped.`));
            }
            this.pending.clear();
            for (const fn of this.exits) fn();
        };
        void proc.exited.then(ended, ended);
    }

    /**
     * Starts the helper with a secret made for this start: written once to an extra pipe (fd 3) only this process
     * holds, then sent back as the first line on stdin. The helper takes commands only when the two agree.
     */
    static start(bin: string): DesktopHelper {
        const secret = randomBytes(32).toString("hex");
        const proc = Bun.spawn([bin], { stdio: ["pipe", "pipe", "ignore", "pipe"] }) as unknown as HelperProcess;
        // A line on fd 3, left open: Bun closes its end when the helper ends (closing it here too would close
        // whatever reuses its number by then).
        const handover = proc.stdio[3];
        if (typeof handover === "number") writeSync(handover, `${secret}\n`);
        const helper = new DesktopHelper(proc);
        helper.write(`${JSON.stringify({ op: "hello", secret })}\n`);
        return helper;
    }

    private write(line: string) {
        try {
            this.proc.stdin.write(line);
            void this.proc.stdin.flush();
        } catch {
            // Gone: its exit settles what waits.
        }
    }

    get running(): boolean {
        return !this.exited;
    }

    get pid(): number {
        return this.proc.pid;
    }

    onExit(fn: () => void) {
        this.exits.push(fn);
    }

    private settle(id: number, reply: Reply) {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (typeof reply.error === "string") p.reject(new DesktopError(reply.error, typeof reply.code === "string" ? reply.code : undefined));
        else p.resolve(reply);
    }

    call(command: Record<string, unknown>, timeoutMs = COMMAND_MS): Promise<Reply> {
        if (this.exited) return Promise.reject(new DesktopError(`${HELPER_NAME} stopped.`));
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new DesktopError("The Mac didn't answer in time.", "timeout"));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.write(`${JSON.stringify({ ...command, id })}\n`);
        });
    }

    cancel(token: string) {
        if (!this.exited) this.write(`${JSON.stringify({ op: "cancel", token })}\n`);
    }

    stop() {
        if (this.exited) return;
        try {
            void this.proc.stdin.end();
        } catch {
            // already closed
        }
        const proc = this.proc;
        setTimeout(() => {
            if (!this.exited) proc.kill("SIGKILL");
        }, 2000).unref?.();
    }
}
