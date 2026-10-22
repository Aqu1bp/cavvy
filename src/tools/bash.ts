import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { Readable } from "node:stream";
import { appendFileSync, closeSync, constants, createReadStream, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { BackgroundShell, Tool, ToolContext } from "./types";
import { stripAnsi } from "../ui/ansi";
import { redact, redactPrefix, knownSecrets, lineRedactor } from "../util/redact";
import { truncateMiddle, isInside } from "../util/files";
import { childEnv } from "../util/env";
import { blockedBySandbox, sandboxArgv, sandboxCacheEnv, sandboxHint, type Sandbox } from "../permissions/sandbox";
import { parseHostRule, proxyEnv, refusedHint, startProxy, type CommandProxy, type HostRule } from "../permissions/proxy";
import { finalSearch } from "../permissions/bash-safety";

export { childEnv };

const MAX_OUTPUT = 30_000;
/** Bound for the retained head and rolling tail, and for unfinished lines. */
const MAX_KEPT = MAX_OUTPUT * 20;
export const OUTPUT_FILE_LIMIT = 8 * 1024 * 1024;
const SESSION_OUTPUT_LIMIT = 64 * 1024 * 1024;
const SESSION_OUTPUT_FILES = 256;
// Properties are forwarded to the underlying Map by sub-agents' trackShells proxies.
const OUTPUT_OWNER = Symbol("shell output owner");
interface OutputOwner { dir: string; bytes: number; files: number }
type ShellMap = Map<string, BackgroundShell> & { [OUTPUT_OWNER]?: OutputOwner };
const backgroundFiles = new WeakMap<BackgroundShell, { file: OutputFile; preview: OutputPreview; offset: number }>();
let outputCounter = 0;

/** Recover artifacts from crashed processes, without touching another live process's sessions. */
function cleanupShellOutputDirs(root: string) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const pid = /^harness-output-(\d+)-/.exec(entry.name)?.[1];
        if (!entry.isDirectory() || !pid || Number(pid) === process.pid) continue;
        try { process.kill(Number(pid), 0); }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ESRCH") rmSync(join(root, entry.name), { recursive: true, force: true });
        }
    }
}

class OutputFile {
    path?: string;
    private owner?: OutputOwner;
    private initial: string[] = [];
    private initialLength = 0;
    private visibleLength = 0;
    private activated = false;
    totalBytes = 0;
    private pending = "";
    private pendingBytes = 0;
    size = 0;
    incomplete = false;
    limit?: string;
    error?: string;

    constructor(private shells: ShellMap) {}

    private create() {
        this.activated = true;
        try {
            let owner = this.shells[OUTPUT_OWNER];
            if (!owner) {
                const root = tmpdir();
                cleanupShellOutputDirs(root);
                owner = { dir: mkdtempSync(join(root, `harness-output-${process.pid}-`)), bytes: 0, files: 0 };
                this.shells[OUTPUT_OWNER] = owner;
            }
            this.owner = owner;
            if (owner.files >= SESSION_OUTPUT_FILES) {
                this.limit = `Session output file limit (${SESSION_OUTPUT_FILES}) reached; output is retained only in the preview.`;
                return;
            }
            const path = join(owner.dir, `${++outputCounter}.txt`);
            writeFileSync(path, "", { mode: 0o600 });
            this.path = path;
            owner.files++;
        } catch (e) {
            this.error = `Could not save complete output: ${redact((e as Error).message)}`;
        }
    }

    append(text: string, omitted = 0) {
        // Count consumed bytes even before a file exists, so later filtered reads don't replay them.
        this.totalBytes += Buffer.byteLength(text);
        if (!this.activated) {
            this.initial.push(text);
            const visible = text.trimEnd().length;
            if (visible) this.visibleLength = this.initialLength + visible;
            this.initialLength += text.length;
            if (!omitted && this.visibleLength <= MAX_OUTPUT && this.initialLength <= MAX_KEPT) return;
            this.create();
            text = this.initial.join("");
            this.initial = [];
        }
        if (this.error || this.limit || !this.path || !this.owner) return;
        if (omitted) {
            this.incomplete = true;
            const preview = new OutputPreview();
            preview.append(text, 0, omitted);
            text = preview.render() + "\n";
        }
        let bytes = Buffer.byteLength(text);
        // Reserve space for a visible notice, and stop at a complete, redacted line.
        if (this.size + this.pendingBytes + bytes > OUTPUT_FILE_LIMIT - 256 || this.owner.bytes + bytes > SESSION_OUTPUT_LIMIT - SESSION_OUTPUT_FILES * 256) {
            this.limit = `Output saving stopped at the ${this.owner.bytes + bytes > SESSION_OUTPUT_LIMIT - SESSION_OUTPUT_FILES * 256 ? "64 MiB session" : "8 MiB file"} limit; later output is available only in the preview.`;
            text = `\n[${this.limit}]\n`;
            bytes = Buffer.byteLength(text);
        }
        this.pending += text;
        this.pendingBytes += bytes;
        this.owner.bytes += bytes;
        if (this.pendingBytes >= MAX_PARTIAL_LINE || this.limit) this.flush();
    }

    flush() {
        if (!this.pending || this.error || !this.path) return;
        try {
            // Synchronous, bounded writes cannot queue unlimited output behind a slow disk.
            appendFileSync(this.path, this.pending);
            this.size += this.pendingBytes;
        } catch (e) {
            this.error = `Could not save complete output: ${redact((e as Error).message)}`;
        }
        this.pending = "";
        this.pendingBytes = 0;
    }

    get note() {
        const location = this.path ? `${this.incomplete || this.limit || this.error ? "Saved" : "Full"} output: ${this.path}` : "";
        return [location, this.limit, this.incomplete ? "Oversized output lines were shortened in the saved file." : undefined, this.error].filter(Boolean).join("\n");
    }

    discard() {
        if (!this.path || !this.owner) return;
        rmSync(this.path, { force: true });
        this.owner.bytes -= this.size;
        this.owner.files--;
    }
}

interface OutputPart { text: string; order: number }

/** An ordered, bounded end of the output. Pending stdout can finish after later stderr. */
class OutputWindow {
    private parts: OutputPart[] = [];
    private start = 0;
    length = 0;
    constructor(private limit: number, private head: boolean) {}

    append(part: OutputPart) {
        const last = this.parts.at(-1);
        if (this.head && this.length === this.limit && last && part.order > last.order) return;
        if (!last || part.order >= last.order) this.parts.push(part);
        else {
            let at = this.parts.length;
            while (at > this.start && this.parts[at - 1]!.order > part.order) at--;
            this.parts.splice(at, 0, part);
        }
        this.length += part.text.length;
        while (this.length > this.limit) {
            const at = this.head ? this.parts.length - 1 : this.start;
            const p = this.parts[at]!;
            const drop = Math.min(p.text.length, this.length - this.limit);
            this.length -= drop;
            if (drop === p.text.length) {
                if (this.head) this.parts.pop();
                else {
                    this.parts[this.start++] = { text: "", order: 0 };
                }
            } else this.parts[at] = { order: p.order, text: this.head ? p.text.slice(0, -drop) : p.text.slice(drop) };
        }
        if (this.start > 1024) {
            this.parts = this.parts.slice(this.start);
            this.start = 0;
        }
    }

    get text() { return this.parts.slice(this.start).map((p) => p.text).join(""); }
}

/** Only normalized, redacted lines enter these buffers; lengths are UTF-16 characters throughout. */
class OutputPreview {
    private head = new OutputWindow(MAX_KEPT * 0.4, true);
    private tail = new OutputWindow(MAX_KEPT * 0.6, false);
    private length = 0;
    private missing = 0;
    private unknownOmission = false;
    private sequence = 0;

    append(text: string, order = this.sequence++, omitted = 0) {
        this.length += text.length;
        if (omitted < 0) this.unknownOmission = true;
        else this.missing += omitted;
        this.head.append({ text, order });
        this.tail.append({ text, order });
    }

    get truncated() { return this.unknownOmission || this.length + this.missing >= MAX_KEPT; }
    get displayTruncated() { return this.truncated || cleanOutput(this.text).length > MAX_OUTPUT; }
    get text() {
        const overlap = Math.max(0, this.head.length + this.tail.length - this.length);
        return this.head.text + this.tail.text.slice(overlap);
    }

    render() {
        const text = cleanOutput(this.text);
        const missing = this.missing + Math.max(0, this.length - MAX_KEPT);
        if (!missing && !this.unknownOmission && text.length <= MAX_OUTPUT) return text;
        const head = Math.min(Math.floor(MAX_OUTPUT * 0.4), text.length);
        const tail = Math.min(MAX_OUTPUT - head, text.length - head);
        const notice = this.unknownOmission ? "output omitted; exact character count unavailable for an oversized line" : `${missing + text.length - head - tail} characters omitted`;
        return `${text.slice(0, head)}\n\n… [${notice}] …\n\n${tail ? text.slice(-tail) : ""}`;
    }
}

/**
 * The shell's own error (a glob with no match, a file it couldn't open, a
 * missing command), anywhere: after output with no newline it starts mid-line
 * (`Checking... zsh:1: no matches found`). Then status 1 may be the shell's.
 */
function shellComplaintPattern(shell = pickShell()): RegExp {
    const name = (shell.split("/").pop() ?? "").replace(/[^\w.-]/g, "");
    return new RegExp(`${name ? `${name.replace(/\./g, "\\.")}(?::\\d+)?: |` : ""}\\(eval\\):\\d+: `);
}
const MAX_TIMEOUT = 600_000;
export const BG_BUFFER = 1_000_000;
const MAX_HOSTS = 30;
/** Bound for unfinished background lines; larger Bash lines keep redacted ends. */
export const MAX_PARTIAL_LINE = 64 * 1024;

/** Read from each paced stream per turn of the event loop. */
const PACED_CHUNK = 64 * 1024;
/** Longest wait between polls of a command that printed in the last 2 s. */
const PACED_POLL_MS = 20;
/** Longest wait between polls of a command that has been quiet for long: what it prints next waits at most this. */
const PACED_IDLE_MS = 200;
/** Most a reader catching up at once (drain) takes in. */
const PACED_DRAIN = 1024 * 1024;

/** A command's output (or one of its streams): a FIFO its PacedOutput reads. */
class PacedStream extends Readable {
    /** Asked for more (_read) and not given it yet. */
    wants = false;

    constructor(private fd: number, private owner: PacedOutput) {
        super({ highWaterMark: PACED_CHUNK });
    }

    get open() {
        return this.fd >= 0;
    }

    override _read() {
        this.wants = true;
        this.owner.schedule();
    }

    /** One read of what's waiting, passed on: how many bytes. Unless `force`, only when asked for. */
    readChunk(buf: Buffer, force = false): number {
        if (this.fd < 0 || !(this.wants || force)) return 0;
        let n = 0;
        let eof = false;
        try {
            while (n < PACED_CHUNK) {
                const got = readSync(this.fd, buf, n, PACED_CHUNK - n, null);
                if (!got) {
                    eof = true;
                    break;
                }
                n += got;
            }
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            // Anything but "nothing yet" ends it, as a closed pipe would.
            if (code !== "EAGAIN" && code !== "EWOULDBLOCK") eof = true;
        }
        if (n) {
            // Before push: the stream asks for more (_read) once this is taken, maybe within push.
            this.wants = false;
            this.push(Buffer.from(buf.subarray(0, n)));
        }
        // No writer left (the command and whatever it started closed it), unless a listener stopped reading as it took this.
        if (eof && this.fd >= 0) {
            closeSync(this.fd);
            this.fd = -1;
            this.push(null);
        }
        return n;
    }

    override _destroy(err: Error | null, cb: (err?: Error | null) => void) {
        if (this.fd >= 0) closeSync(this.fd);
        this.fd = -1;
        cb(err);
    }
}

/**
 * A command's output, read at our own pace. Bun reads a pipe as fast as the command
 * writes it, buffering without limit, and a command that floods its output (`yes`)
 * keeps the event loop in that read: the server stops answering and its memory
 * balloons (#298). These are FIFOs read without blocking, a chunk of each per turn of
 * the event loop: when we fall behind, the kernel's pipe buffer fills and the command
 * waits. Bash's stdout and stderr share one FIFO, so they keep the order they were
 * written in; a Monitor's are two, read at the same moments (in order to within a poll).
 */
class PacedOutput {
    readonly streams: PacedStream[];
    private timer?: ReturnType<typeof setTimeout>;
    private immediate?: ReturnType<typeof setImmediate>;
    private idle = 0;
    private lastData = performance.now();
    /** Time owed to the rest of the server, in ms (see read). */
    private owed = 0;
    private readonly buf = Buffer.allocUnsafe(PACED_CHUNK);

    constructor(fds: number[]) {
        this.streams = fds.map((fd) => new PacedStream(fd, this));
    }

    /** Read again: not in this turn (a chunk per turn lets the server answer in between), or after the rest owed. */
    schedule() {
        if (this.timer || this.immediate) return;
        if (this.owed < 1) this.immediate = setImmediate(this.poll);
        else {
            this.timer = setTimeout(this.poll, this.owed);
            this.owed = 0;
        }
    }

    /** Its command ended: what it left is read now, not at the next poll. */
    poke() {
        if (!this.timer) return;
        this.cancel();
        this.idle = 0;
        this.poll();
    }

    /** Take in what's waiting now (up to PACED_DRAIN), not at the next poll: for a reader of its output. */
    drain() {
        this.cancel();
        for (let total = 0; total < PACED_DRAIN; ) {
            const n = this.read(true);
            if (!n) break;
            total += n;
        }
        this.owed = 0;
        if (this.waiting) this.schedule();
    }

    private get waiting() {
        return this.streams.some((s) => s.open && s.wants);
    }

    private cancel() {
        clearTimeout(this.timer);
        if (this.immediate) clearImmediate(this.immediate);
        this.timer = this.immediate = undefined;
    }

    private read(force = false): number {
        const started = performance.now();
        let n = 0;
        for (const s of this.streams) n += s.readChunk(this.buf, force);
        if (n) {
            this.idle = 0;
            this.lastData = performance.now();
            // Rest as long as handling it took (the 'data' listeners run in push) before reading
            // more: a command that never stops printing gets at most half the thread.
            this.owed += this.lastData - started;
        }
        return n;
    }

    private poll = () => {
        this.timer = this.immediate = undefined;
        const n = this.read();
        if (!this.waiting) return;
        if (n) return this.schedule();
        // Nothing: once more next turn (more is often on its way), then less and less often: every
        // PACED_POLL_MS at most for 2 s of quiet, then growing to PACED_IDLE_MS (reached at 5 s).
        this.owed = 0;
        if (!this.idle++) return void (this.immediate = setImmediate(this.poll));
        const quiet = performance.now() - this.lastData;
        const longest = quiet < 2000 ? PACED_POLL_MS : Math.min(PACED_IDLE_MS, quiet / 25);
        this.timer = setTimeout(this.poll, Math.min(longest, 2 ** (this.idle - 2)));
    };
}

interface Fifo { read: number; write: number }
/** FIFOs made ahead: mkfifo is a process of its own, and starting a command shouldn't wait for one. */
const spareFifos: Fifo[] = [];
const SPARE_FIFOS = 4;
let makingFifos = false;
/** mkfifo failed (missing, or FIFOs unsupported here): ordinary pipes from then on. */
let noFifos = false;

/** `count` FIFOs, each open at both ends, with nothing left on disk; undefined where FIFOs can't be made. */
function pacedFifos(count: number): Fifo[] | undefined {
    if (noFifos) return undefined;
    const spares = spareFifos.length >= count ? spareFifos.splice(-count) : undefined;
    if (!makingFifos && spareFifos.length < SPARE_FIFOS) makeSpareFifos();
    if (spares) return spares;
    let dir: string | undefined;
    try {
        const made = fifoPaths(count);
        dir = made.dir;
        const r = spawnSync("mkfifo", ["-m", "600", ...made.paths], { stdio: "ignore" });
        if (r.status === 0) return openFifos(made.paths);
        // Not there, or it ran and failed; not a passing shortage (of processes, say), which can clear.
        if (r.status !== null || (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") noFifos = true;
        return undefined;
    } catch {
        return undefined;
    } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
}

function makeSpareFifos() {
    makingFifos = true;
    let dir: string | undefined;
    let settled = false;
    const done = (paths?: string[]) => {
        if (settled) return;
        settled = true;
        try {
            if (paths) spareFifos.push(...openFifos(paths));
        } catch {
            // Made again, in its turn, by the next command.
        } finally {
            if (dir) rmSync(dir, { recursive: true, force: true });
            makingFifos = false;
        }
    };
    try {
        const made = fifoPaths(SPARE_FIFOS);
        dir = made.dir;
        const maker = spawn("mkfifo", ["-m", "600", ...made.paths], { stdio: "ignore" });
        maker.once("error", () => done());
        maker.once("exit", (code) => done(code === 0 ? made.paths : undefined));
    } catch {
        // Out of descriptors or processes, say: the next command tries again.
        done();
    }
}

function fifoPaths(count: number) {
    const dir = mkdtempSync(join(tmpdir(), "harness-pipe-"));
    return { dir, paths: Array.from({ length: count }, (_, i) => join(dir, String(i))) };
}

function openFifos(paths: string[]): Fifo[] {
    const fds: number[] = [];
    try {
        return paths.map((path) => {
            // The read end first, without blocking; then the write end opens at once. The command's
            // end must block: a command whose stdout doesn't wait gets EAGAIN errors.
            const read = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
            fds.push(read);
            const write = openSync(path, constants.O_WRONLY);
            fds.push(write);
            return { read, write };
        });
    } catch (e) {
        for (const fd of fds) closeSync(fd);
        throw e;
    }
}

export interface PacedChild {
    child: ChildProcess;
    stdout: Readable;
    /** Undefined when stderr shares stdout's stream (`combined`). */
    stderr?: Readable;
    /** Like the child's "close": it exited (or failed to start) and its streams are closed. */
    onClose: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
    /** Take in what it has printed so far, now (PacedOutput.drain); ordinary pipes deliver it as it comes. */
    drain: () => void;
}

/**
 * Spawn with stdin ignored and stdout and stderr in paced pipes (PacedOutput), or in
 * ordinary pipes, as before, where FIFOs can't be made or `paced` is false. `combined`:
 * both go into one, in the order the command wrote them (as a terminal shows them).
 */
export function spawnPaced(file: string, args: string[], options: Omit<SpawnOptions, "stdio">, o: { paced?: boolean; combined?: boolean } = {}): PacedChild {
    const fifos = o.paced !== false ? pacedFifos(o.combined ? 1 : 2) : undefined;
    if (!fifos) {
        const child = spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
        return { child, stdout: child.stdout!, stderr: child.stderr!, onClose: (cb) => void child.on("close", cb), drain: () => {} };
    }
    const out = fifos[0]!;
    const err = fifos[1] ?? out;
    let child: ChildProcess;
    try {
        child = spawn(file, args, { ...options, stdio: ["ignore", out.write, err.write] });
    } catch (e) {
        for (const f of fifos) closeSync(f.read);
        throw e;
    } finally {
        // The command holds them now: the streams end when it (and what it started) closes them.
        for (const f of fifos) closeSync(f.write);
    }
    const output = new PacedOutput(fifos.map((f) => f.read));
    const [stdout, stderr] = output.streams as [PacedStream, PacedStream | undefined];
    let left = 1 + output.streams.length;
    let status: [number | null, NodeJS.Signals | null] = [null, null];
    const waiting: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
    const settle = () => {
        if (--left === 0) for (const cb of waiting) cb(...status);
    };
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        status = [code, signal];
        output.poke();
        settle();
    });
    for (const s of output.streams) s.once("close", settle);
    return {
        child,
        stdout,
        stderr,
        onClose: (cb) => void (left ? waiting.push(cb) : cb(...status)),
        drain: () => output.drain(),
    };
}

/** Strip terminal escapes across chunk boundaries without buffering unbounded OSC payloads. */
type AnsiStripper = ((chunk: string) => string) & { fork: () => AnsiStripper };
function ansiChunks(state = 0, stringState = 0): AnsiStripper {
    // text, ESC, CSI, OSC, control string, intermediate, string ESC
    const strip = (chunk: string) => {
        if (!state && !/[\x1b\x18\x1a]/.test(chunk)) return chunk;
        const parts: string[] = [];
        let start = 0;
        for (let i = 0; i < chunk.length; i++) {
            const c = chunk.charCodeAt(i);
            // Malformed terminal controls cannot hide subsequent lines (or canceled text).
            if (c === 10 || c === 13 || c === 24 || c === 26) {
                if (!state) parts.push(chunk.slice(start, i));
                if (c === 10 || c === 13) parts.push(chunk[i]!);
                state = 0;
                start = i + 1;
                continue;
            }
            if (!state) {
                if (c !== 27) continue;
                parts.push(chunk.slice(start, i));
                state = 1;
            } else if (state === 1) {
                state = c === 91 ? 2 : c === 93 ? 3 : [80, 88, 94, 95].includes(c) ? 4 : c >= 32 && c <= 47 ? 5 : 0;
            } else if (state === 2) {
                if (c >= 64 && c <= 126) state = 0;
            } else if (state === 3 || state === 4) {
                if (state === 3 && c === 7) state = 0;
                else if (c === 27) { stringState = state; state = 6; }
            } else if (state === 5) {
                if (c < 32 || c > 47) state = 0;
            } else state = c === 92 ? 0 : stringState;
            start = i + 1;
        }
        if (!state) parts.push(chunk.slice(start));
        return parts.join("");
    };
    return Object.assign(strip, { fork: () => ansiChunks(state, stringState) });
}

/** Longest prefix of pattern at the end of text, in linear time even for repetitive secrets. */
function prefixAtEnd(pattern: string, text: string): number {
    if (!pattern || !text) return 0;
    const failure = new Uint32Array(pattern.length);
    for (let i = 1, j = 0; i < pattern.length; i++) {
        while (j && pattern[i] !== pattern[j]) j = failure[j - 1]!;
        if (pattern[i] === pattern[j]) j++;
        failure[i] = j;
    }
    let matched = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        while (matched && (matched === pattern.length || char !== pattern[matched])) matched = failure[matched - 1]!;
        if (char === pattern[matched]) matched++;
    }
    return matched;
}

/** Publish one cleaned logical line per pipe, replacing CR progress before counting or saving it. */
function readBashStream(stream: NodeJS.ReadableStream, emit: (text: string, order: number, omitted?: number) => void, overflow: (text: string) => string, nextOrder: () => number, inspect?: (text: string) => void, progress?: (text: string) => void) {
    let pending: { text: string; order: number; omitted: number } | undefined;
    const stripChunk = ansiChunks();
    // What readShellStream emits is redacted; again after stripping, which can join a secret's parts.
    readShellStream(stream, (text, order, omitted = 0) => {
        const safe = redact(stripChunk(text));
        progress?.(safe);
        // Whole lines (a chunk's worth comes at once) with no progress to collapse: as they are.
        if (!pending && safe.endsWith("\n") && !safe.includes("\r")) return emit(safe, order, omitted);
        const delimiter = /[\r\n]/g;
        for (let start = 0; start < safe.length; ) {
            const nl = delimiter.exec(safe)?.index ?? -1;
            const segment = safe.slice(start, nl < 0 ? safe.length : nl + 1);
            start += segment.length;
            delimiter.lastIndex = start;
            const end = nl < 0 ? undefined : segment.at(-1);
            const body = end ? segment.slice(0, -1) : segment;
            if (body || !pending) pending = { text: body, order: pending?.order ?? order, omitted };
            if (end === "\n") {
                emit(pending!.text + "\n", pending!.order, pending!.omitted);
                pending = undefined;
            }
        }
    }, OUTPUT_FILE_LIMIT, overflow, nextOrder, inspect, true, true);
    stream.on("end", () => {
        if (pending) emit(pending.text, pending.order, pending.omitted);
        pending = undefined;
    });
}

/**
 * Each pipe owns its decoder and pending line: stderr mustn't split a stdout secret (or vice versa).
 * With `batch`, a chunk's complete lines go out together, in one emit (and redaction), not one per line.
 */
export function readShellStream(stream: NodeJS.ReadableStream, emit: (text: string, order: number, omitted?: number) => void, maxLine: number, overflow: (text: string) => string, nextOrder = () => 0, inspect?: (text: string) => void, keepEnds = false, batch = false) {
    let pending = "";
    let skipping = false;
    let order = 0;
    let longHead = "";
    let longTail = "";
    let tailTokenSecret = false;
    const secrets = knownSecrets();
    const context = Math.max(1, ...secrets.map((s) => s.length));
    let tailAnsi = ansiChunks();
    // Only the displayed ends plus secret context are needed after a line exceeds maxLine.
    const window = MAX_OUTPUT * 2 + context;
    const appendTail = (text: string) => {
        const joined = longTail + text;
        const cut = Math.max(0, joined.length - window);
        if (cut) {
            // Remember whether the retained window begins inside an ANSI payload.
            tailAnsi(joined.slice(0, cut));
            let start = cut;
            while (start > 0 && /[A-Za-z0-9_.-]/.test(joined[start - 1]!)) start--;
            const prefix = joined.slice(start, start + 128);
            tailTokenSecret = (start === 0 && tailTokenSecret) || redact(prefix) !== prefix;
        }
        longTail = joined.slice(cut);
    };
    const finishLong = () => {
        // Context catches secrets crossing a display cut. Suppress a leading token fragment
        // in the tail too: known-format tokens can have unbounded length.
        // Map raw display cuts through both transforms. Redaction may shrink adjacent
        // secrets, so slicing the transformed string by the raw index can expose a fragment.
        const normalize = (raw: string, cut: number, strip = ansiChunks()) => {
            const safe = redact(raw);
            const safeCut = redactPrefix(raw, cut).length;
            const prefix = strip(safe.slice(0, safeCut));
            return { text: prefix + strip(safe.slice(safeCut)), cut: prefix.length };
        };
        const headSource = normalize(longHead, MAX_OUTPUT);
        const tail = normalize(longTail, Math.max(0, longTail.length - MAX_OUTPUT), tailAnsi.fork());
        const tailSource = tail.text;
        let headCut = headSource.cut;
        let cut = tail.cut;
        // Stripping a huge escape can consume all of the raw secret-context margin.
        // Suppress fragments that could join a secret in the discarded middle.
        for (const secret of secrets) {
            headCut = Math.min(headCut, headSource.text.length - prefixAtEnd(secret, headSource.text.slice(-context)));
            cut = Math.max(cut, prefixAtEnd(tailSource.slice(0, context), secret));
        }
        const head = redactPrefix(headSource.text, headCut);
        if (tailTokenSecret) {
            const tokenEnd = /^[A-Za-z0-9_.-]*/.exec(tailSource)![0].length;
            if (tokenEnd > cut) cut = tokenEnd;
        }
        const safeTail = redact(tailSource).slice(redactPrefix(tailSource, cut).length);
        inspect?.(longHead);
        inspect?.(longTail);
        // The discarded middle was not redacted: its source length cannot be mixed with
        // sanitized character counts. A negative omission explicitly means unknown.
        emit(head + safeTail, order, -1);
        longHead = longTail = "";
        tailAnsi = ansiChunks();
        tailTokenSecret = false;
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
        // Cache both delimiters: searching for an absent CR again at every LF is quadratic.
        let lf = chunk.indexOf("\n");
        let cr = chunk.indexOf("\r");
        // The batch: complete lines from runFrom to runTo, which started no line of their own.
        let runFrom = -1;
        let runTo = 0;
        let runOrder = 0;
        const flushRun = () => {
            if (runFrom < 0) return;
            const text = chunk.slice(runFrom, runTo);
            runFrom = -1;
            inspect?.(text);
            emit(redact(text), runOrder);
        };
        for (let start = 0; start < chunk.length; ) {
            // A reader that stopped listening (a monitor that's flooding) doesn't want the rest of this chunk either.
            if ((stream as { destroyed?: boolean }).destroyed) return;
            const nl = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
            const end = nl < 0 ? chunk.length : nl + 1;
            if (batch && !skipping && !pending && nl >= 0 && end - start <= maxLine) {
                if (runFrom < 0) {
                    runFrom = start;
                    runOrder = nextOrder();
                }
                runTo = end;
            } else if (!skipping) {
                flushRun();
                if (!pending) order = nextOrder();
                pending += chunk.slice(start, end);
                if (pending.length > maxLine) {
                    if (keepEnds) {
                        longHead = pending.slice(0, window);
                        appendTail(pending);
                        overflow(pending);
                    } else emit(overflow(pending), order);
                    pending = "";
                    skipping = true;
                } else if (nl >= 0) {
                    inspect?.(pending);
                    emit(redact(pending), order);
                    pending = "";
                }
            } else if (keepEnds) {
                const text = chunk.slice(start, end);
                if (longHead.length < window) longHead += text.slice(0, window - longHead.length);
                appendTail(text);
            }
            if (nl >= 0) {
                if (skipping && keepEnds) finishLong();
                skipping = false;
            }
            start = end;
            if (lf >= 0 && lf < start) lf = chunk.indexOf("\n", start);
            if (cr >= 0 && cr < start) cr = chunk.indexOf("\r", start);
        }
        flushRun();
    });
    stream.on("end", () => {
        if (skipping && keepEnds) finishLong();
        if (pending) {
            inspect?.(pending);
            emit(redact(pending), order);
        }
        pending = "";
    });
}

/**
 * A sandboxed command's environment: package caches it can write and, with
 * Seatbelt, its own proxy, open to the hosts it was approved with.
 */
export async function sandboxedEnv(env: Record<string, string>, sandbox: Sandbox, hosts: string[] | undefined): Promise<{ env: Record<string, string>; proxy?: CommandProxy }> {
    if (sandbox.kind !== "seatbelt") return { env: { ...env, ...sandboxCacheEnv() } };
    const rules = (hosts ?? []).map(parseHostRule).filter((r): r is HostRule => r !== undefined);
    const proxy = await startProxy(rules);
    return { env: { ...env, ...sandboxCacheEnv(rules.length > 0), ...proxyEnv(proxy.url) }, proxy };
}

/** Output can reveal a blocked command even when a later command exits successfully. */
export function sandboxOutputHint(sandbox: Sandbox, output: string, proxy: CommandProxy | undefined, failed = true): string | undefined {
    const hints = [proxy && refusedHint(proxy.refused()), blockedBySandbox(output, !failed) ? sandboxHint(sandbox.kind, output) : undefined].filter(Boolean);
    if (!failed && hints.length) hints.unshift("[Part of this command may have been blocked by the sandbox, even though the shell did not report failure.]");
    return hints.length ? hints.join("\n") : undefined;
}

/** What's wrong with a command's allowedHosts, if anything. */
export function validateHosts(hosts: unknown): string | undefined {
    if (hosts === undefined) return undefined;
    if (!Array.isArray(hosts)) return "allowedHosts must be an array of host names";
    if (hosts.length > MAX_HOSTS) return `allowedHosts can list at most ${MAX_HOSTS} hosts`;
    const bad = hosts.filter((h) => typeof h !== "string" || !parseHostRule(h));
    if (bad.length) return `allowedHosts: ${bad.map((b) => JSON.stringify(b)).join(", ")} ${bad.length === 1 ? "isn't a host" : "aren't hosts"}. List host names like registry.npmjs.org, *.example.com or example.com:8443 (no URLs, paths or bare wildcards).`;
    return undefined;
}

/** A command's environment: this session's secrets, and in the sandbox its caches and proxy. */
export async function commandEnv(ctx: Pick<ToolContext, "settings" | "state" | "sandbox">, hosts: string[] | undefined): Promise<{ env: Record<string, string>; proxy?: CommandProxy }> {
    // childEnv leaves out every registered secret; this session's own go back in, for its shell alone.
    const env = { ...childEnv(ctx.settings.env), ...ctx.state.secrets?.env() };
    return ctx.sandbox ? sandboxedEnv(env, ctx.sandbox, hosts) : { env };
}

/** The shell commands run in: the user's, if it's bash or zsh. */
export function pickShell(): string {
    const sh = process.env.SHELL ?? "";
    if (/\/(bash|zsh)$/.test(sh) && existsSync(sh)) return sh;
    return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/** `shell -c script`, inside the sandbox when there is one. */
export function shellArgv(script: string, sandbox?: Sandbox): string[] {
    return sandbox ? sandboxArgv(sandbox, pickShell(), script) : [pickShell(), "-c", script];
}

let cwdFileCounter = 0;

interface RunOpts {
    command: string;
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
    env: Record<string, string>;
    onData?: (chunk: string) => void;
    outputFile?: OutputFile;
    sandbox?: Sandbox;
    /** Read its output at our pace (spawnPaced; the pacedOutput setting). */
    paced?: boolean;
}

interface RunResult {
    output: string;
    preview: string;
    previewTruncated: boolean;
    /** Capture facts before redaction can shrink output or hide a shell diagnostic. */
    outputTruncated: boolean;
    shellError: boolean;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    aborted: boolean;
    newCwd?: string;
}

/** The shell's own idea of where it is: an inherited PWD can spell the directory differently (or through a symlink). */
export function withPwd(env: Record<string, string>, cwd: string): Record<string, string> {
    const { OLDPWD: _, ...rest } = env;
    return { ...rest, PWD: cwd };
}

export function runShell(opts: RunOpts): Promise<RunResult> {
    const cwdFile = join(tmpdir(), `harness-cwd-${process.pid}-${++cwdFileCounter}`);
    const script = `${opts.command}\n__harness_ec=$?\npwd -P > '${cwdFile}' 2>/dev/null\nexit $__harness_ec\n`;
    return new Promise((resolvePromise) => {
        const [file, ...args] = shellArgv(script, opts.sandbox);
        const { child, stdout, stderr, onClose } = spawnPaced(file!, args, { cwd: opts.cwd, env: withPwd(opts.env, opts.cwd), detached: true }, { paced: opts.paced, combined: true });
        const preview = new OutputPreview();
        let rawLength = 0;
        let outputTruncated = false;
        let shellError = false;
        const complaint = shellComplaintPattern();
        const inspect = (text: string) => {
            rawLength = Math.min(MAX_KEPT, rawLength + text.length);
            if (rawLength >= MAX_KEPT) outputTruncated = true;
            if (!shellError) shellError = complaint.test(stripAnsi(text));
        };
        let timedOut = false;
        let aborted = false;
        const killTree = () => {
            if (child.pid === undefined) return;
            try {
                process.kill(-child.pid, "SIGTERM");
            } catch {
                // already gone
            }
            setTimeout(() => {
                try {
                    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
                } catch {
                    // already gone
                }
            }, 2000).unref?.();
        };
        let sequence = 0;
        const nextOrder = () => sequence++;
        const onChunk = (text: string, order: number, omitted = 0) => {
            preview.append(text, order, omitted);
            opts.outputFile?.append(text, omitted);
            if (preview.truncated) outputTruncated = true;
        };
        const overflow = () => {
            outputTruncated = true;
            return `[Output line omitted: exceeds ${MAX_KEPT} characters]\n`;
        };
        for (const stream of [stdout, stderr]) if (stream) readBashStream(stream, onChunk, overflow, nextOrder, inspect, opts.onData);
        const timer = setTimeout(() => {
            timedOut = true;
            killTree();
        }, opts.timeoutMs);
        const onAbort = () => {
            aborted = true;
            killTree();
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
        onClose((code, sig) => {
            clearTimeout(timer);
            opts.signal.removeEventListener("abort", onAbort);
            let newCwd: string | undefined;
            try {
                if (existsSync(cwdFile)) {
                    newCwd = readFileSync(cwdFile, "utf-8").trim() || undefined;
                    rmSync(cwdFile, { force: true });
                }
            } catch {
                // ignore
            }
            opts.outputFile?.flush();
            resolvePromise({ output: preview.text, preview: preview.render(), previewTruncated: preview.displayTruncated, outputTruncated, shellError, exitCode: code, signal: sig, timedOut, aborted, newCwd });
        });
        child.on("error", (err) => {
            clearTimeout(timer);
            resolvePromise({ output: preview.text + `\n${err.message}`, preview: preview.render() + `\n${err.message}`, previewTruncated: preview.displayTruncated, outputTruncated, shellError, exitCode: 127, signal: null, timedOut, aborted, newCwd: undefined });
        });
    });
}

export function cleanOutput(s: string): string {
    // Collapse carriage-return progress bars to their final state, strip ANSI.
    const lines = stripAnsi(redact(s))
        .split("\n")
        .map((l) => {
            const parts = l.split("\r");
            return parts.length > 1 ? (parts.filter((p) => p.length).pop() ?? "") : l;
        });
    return redact(lines.join("\n").replace(/\s+$/, ""));
}

function allowedRoots(ctx: ToolContext): string[] {
    return [ctx.state.projectRoot, ...(ctx.settings.permissions?.additionalDirectories ?? [])];
}

let shellCounter = 0;

export const BashTool: Tool<{ command: string; description?: string; timeout?: number; run_in_background?: boolean; dangerouslyDisableSandbox?: boolean; allowedHosts?: string[] }> = {
    name: "Bash",
    category: "execute",
    readOnly: false,
    description: `Executes a shell command and returns its combined stdout/stderr.

- The working directory persists between calls (cd works), but shell variables and functions do not.
- Quote paths that contain spaces with double quotes.
- Prefer the dedicated tools over shell equivalents: Glob instead of find/ls -R, Grep instead of grep/rg, Read instead of cat/head/tail, Edit/Write instead of sed/echo redirection.
- Chain dependent commands with && ; run independent read-only commands as parallel Bash calls in one response.
- Commands run non-interactively with no stdin: avoid editors, pagers and prompts (use -y / --yes / --no-edit flags).
- timeout is in milliseconds (default 120000, max 600000).
- run_in_background: true starts long-running processes (dev servers, watchers) and returns immediately; read their output with BashOutput and stop them with KillShell. Don't use '&' yourself.
- Output over ${MAX_OUTPUT} characters shows the head and tail, with a path to the redacted output file for Read/Grep (saving is limited to 8 MiB per command and 64 MiB per session).
- Never run git commands that rewrite history or push unless the user asked. Never skip hooks (--no-verify) unless asked.
- In auto mode commands run in a sandbox with no network except localhost. A command that needs the network (installing packages, cloning, downloading) lists the hosts it needs in allowedHosts: ["registry.npmjs.org"] for npm, pnpm or bun, ["pypi.org", "files.pythonhosted.org"] for pip or uv, the host in the URL for curl or git clone. They're reviewed with the command and open for it alone; a refused connection names the host to add.
- Always write a short description (5-10 words) of what the command does.`,
    parameters: {
        type: "object",
        properties: {
            command: { type: "string", description: "The command to run" },
            description: { type: "string", description: "Clear 5-10 word description of what the command does" },
            timeout: { type: "number", description: "Timeout in milliseconds (max 600000)" },
            run_in_background: { type: "boolean", description: "Run in the background and return immediately" },
            dangerouslyDisableSandbox: {
                type: "boolean",
                description:
                    "Auto mode only: run outside the sandbox (which has no network except localhost and the hosts in allowedHosts, and allows writes only in the project and temp directories). Set it only after a command failed because of the sandbox for a reason other than a missing host, or when it needs SSH keys, stored credentials or other programs; the command then goes to the safety reviewer.",
            },
            allowedHosts: {
                type: "array",
                items: { type: "string" },
                description:
                    'Auto mode only: hosts this command may reach from the sandbox, e.g. ["registry.npmjs.org"]. Host names, optionally with a port (example.com:8443) or a leading wildcard (*.example.com). The safety reviewer sees them with the command; they\'re open for this command only.',
            },
        },
        required: ["command"],
    },
    title: (i) => `Bash(${(i.command ?? "").split("\n")[0]}${(i.command ?? "").includes("\n") ? " …" : ""})`,
    validate(input) {
        if (typeof input.command !== "string" || !input.command.trim()) return "command must be a non-empty string";
        return validateHosts(input.allowedHosts);
    },
    async run(input, ctx) {
        const { env, proxy } = await commandEnv(ctx, input.allowedHosts);
        if (input.run_in_background) return startBackground(input.command, ctx, env, proxy);
        const timeoutMs = Math.min(MAX_TIMEOUT, Math.max(1000, input.timeout ?? ctx.settings.bashTimeout ?? 120_000));
        const outputFile = new OutputFile(ctx.state.shells);
        let lastProgress = 0;
        const lines = lineRedactor(stripAnsi);
        let ready = "";
        let res: RunResult;
        try {
            res = await runShell({
                command: input.command,
                cwd: ctx.state.cwd,
                timeoutMs,
                signal: ctx.signal,
                env,
                outputFile,
                sandbox: ctx.sandbox,
                paced: ctx.settings.pacedOutput !== false,
                onData: (chunk) => {
                    // Cut it back now and then, not for every chunk: each cut copies what's kept.
                    ready += lines(chunk);
                    if (ready.length > 2 * MAX_KEPT) ready = ready.slice(-MAX_KEPT);
                    const now = Date.now();
                    if (!ready || now - lastProgress <= 100) return;
                    ctx.onProgress?.(ready.slice(-MAX_KEPT));
                    ready = "";
                    lastProgress = now;
                },
            });
        } finally {
            proxy?.close();
        }
        let notes = "";
        if (res.newCwd && res.newCwd !== ctx.state.cwd) {
            if (allowedRoots(ctx).some((r) => isInside(res.newCwd!, r))) ctx.state.cwd = res.newCwd;
            else {
                notes += `\nShell cwd was reset to ${ctx.state.projectRoot} (cd outside the workspace is not persisted).`;
                ctx.state.cwd = ctx.state.projectRoot;
            }
        }
        let out = res.preview;
        if (res.previewTruncated) out += `\n\n${outputFile.note}`;
        else outputFile.discard();
        const failed = res.timedOut || (res.exitCode !== 0 && res.exitCode !== null);
        // A last grep that found nothing exits 1: that's the answer, not a failure of what came before it.
        // Unless the shell complained (then the 1 may be its own), or output was dropped where it could have,
        // or the shell stopped before the end of the script (errexit, a failed special builtin): then it's not
        // the last command's 1. The line after the command records the cwd, so a cwd means it got there.
        const search = res.exitCode === 1 && !res.timedOut && !res.aborted && res.newCwd !== undefined && !res.outputTruncated && !res.shellError ? finalSearch(input.command, env) : undefined;
        if (res.timedOut) out += `\n\nCommand timed out after ${Math.round(timeoutMs / 1000)}s and was killed.`;
        else if (res.aborted) out += `\n\n[Command interrupted by user]`;
        else if (search) {
            const piped = search.piped ? " What was piped into it may still have failed: that doesn't change its status." : "";
            out += `${out.trim() ? "\n\n" : ""}Exit code: 1 (the last command, ${search.name}, found no matches: that's its status for no match, not an error.${piped}${out.trim() ? " The output above is everything the command printed." : ""})`;
        }
        else if (res.exitCode !== 0 && res.exitCode !== null) out += `\n\nExit code: ${res.exitCode}`;
        else if (res.signal) out += `\n\nTerminated by signal ${res.signal}`;
        out += notes;
        const hint = ctx.sandbox && !res.aborted ? sandboxOutputHint(ctx.sandbox, res.output, proxy, failed) : undefined;
        if (hint) out += `\n\n${hint}`;
        const lineCount = out.trim() ? out.trim().split("\n").length : 0;
        return {
            content: out.trim() || "(no output)",
            isError: !!(failed && !res.aborted && !search),
            display: {
                summary: res.timedOut ? "Timed out" : res.aborted ? "Interrupted" : lineCount === 0 ? (failed ? `Exit code ${res.exitCode}` : "(no output)") : undefined,
                body: out.trim() || undefined,
            },
        };
    },
};

export const KILL_GRACE_MS = 3000;

/** Whether any process in the group is still alive. */
function groupAlive(pid: number): boolean {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
}

/**
 * SIGTERM the process group, give it `graceMs` to exit, then SIGKILL
 * whatever is left (a server stuck in its shutdown handler would otherwise
 * keep running, and holding its port, after we stopped tracking it).
 */
export async function stopGroup(pid: number | undefined, graceMs: number): Promise<"gone" | "stopped" | "killed"> {
    if (pid === undefined || !groupAlive(pid)) return "gone";
    try {
        process.kill(-pid, "SIGTERM");
    } catch {
        return "gone";
    }
    for (const until = Date.now() + graceMs; Date.now() < until; ) {
        await new Promise((r) => setTimeout(r, 50));
        if (!groupAlive(pid)) return "stopped";
    }
    try {
        process.kill(-pid, "SIGKILL");
    } catch {
        return "stopped";
    }
    for (let i = 0; i < 20 && groupAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    return "killed";
}

/** A background line too long to keep. */
export const overflowLine = () => "[Output line omitted: exceeds 64 KiB]\n";

/**
 * The last BG_BUFFER characters, kept in the pieces they came in. Appending costs the piece,
 * not the buffer (one string would be copied whole for every line); reading joins them.
 */
export class OutputRing {
    private parts: string[] = [];
    private first = 0;
    /** Evicted characters at the start of the first part. */
    private skip = 0;
    private joined?: string;
    length = 0;

    /** How many characters were evicted from the front. */
    append(text: string): number {
        if (!text) return 0;
        this.parts.push(text);
        this.length += text.length;
        this.joined = undefined;
        if (this.length <= BG_BUFFER) return 0;
        let drop = this.length - BG_BUFFER;
        // Only redacted, complete lines enter the ring; evict whole lines for readability.
        const nl = this.newline(drop);
        if (nl !== -1 && nl - drop < MAX_PARTIAL_LINE) drop = nl + 1;
        this.length -= drop;
        for (let left = drop; left; ) {
            const rest = this.parts[this.first]!.length - this.skip;
            if (left < rest) {
                this.skip += left;
                break;
            }
            left -= rest;
            this.parts[this.first++] = "";
            this.skip = 0;
        }
        if (this.first > 1024 && this.first * 2 > this.parts.length) {
            this.parts = this.parts.slice(this.first);
            this.first = 0;
        }
        return drop;
    }

    /** The first newline at or after `from`, looking no further than MAX_PARTIAL_LINE past it. */
    private newline(from: number): number {
        let base = 0;
        for (let i = this.first; i < this.parts.length && base < from + MAX_PARTIAL_LINE; i++) {
            const start = i === this.first ? this.skip : 0;
            const part = this.parts[i]!;
            const end = base + part.length - start;
            if (end > from) {
                const at = part.indexOf("\n", start + Math.max(0, from - base));
                if (at !== -1) return base + at - start;
            }
            base = end;
        }
        return -1;
    }

    get text(): string {
        if (this.joined === undefined) {
            const live = this.parts.slice(this.first);
            if (live.length) live[0] = live[0]!.slice(this.skip);
            this.joined = live.join("");
            this.parts = [this.joined];
            this.first = this.skip = 0;
        }
        return this.joined;
    }
}

const rings = new WeakMap<BackgroundShell, OutputRing>();

/** Into a background shell's output ring, which keeps the last BG_BUFFER characters. */
export function appendOutput(shell: BackgroundShell, text: string) {
    let ring = rings.get(shell);
    if (!ring) {
        const own = new OutputRing();
        own.append(shell.output);
        rings.set(shell, own);
        // Its output is the ring's, joined when read.
        Object.defineProperty(shell, "output", { get: () => own.text, enumerable: true, configurable: true });
        ring = own;
    }
    const drop = ring.append(text);
    if (drop) shell.readOffset = Math.max(0, shell.readOffset - drop);
}

function startBackground(command: string, ctx: ToolContext, env: Record<string, string>, proxy: CommandProxy | undefined) {
    const id = `bash_${++shellCounter}`;
    const outputFile = new OutputFile(ctx.state.shells);
    const [file, ...args] = shellArgv(command, ctx.sandbox);
    let spawned: PacedChild;
    try {
        spawned = spawnPaced(file!, args, { cwd: ctx.state.cwd, env: withPwd(env, ctx.state.cwd), detached: true }, { paced: ctx.settings.pacedOutput !== false, combined: true });
    } catch (e) {
        proxy?.close();
        throw e;
    }
    const { child, stdout, stderr, onClose, drain } = spawned;
    const closed = new Promise<void>((resolve) => onClose(() => resolve()));
    const sandbox = ctx.sandbox;
    const shell: BackgroundShell = {
        id,
        command,
        startedAt: Date.now(),
        output: "",
        readOffset: 0,
        exitCode: null,
        sandboxed: sandbox !== undefined,
        sandboxHint: sandbox ? () => sandboxOutputHint(sandbox, shell.output, proxy, shell.exitCode !== null && shell.exitCode !== 0) : undefined,
        drain,
        kill: async (graceMs = KILL_GRACE_MS) => {
            const how = await stopGroup(child.pid, graceMs);
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 250); })]);
            clearTimeout(timer);
            // A detached descendant can retain the pipes after the tracked group is gone.
            stdout.destroy();
            stderr?.destroy();
            await closed;
            proxy?.close();
            return how;
        },
    };
    const saved = { file: outputFile, preview: new OutputPreview(), offset: 0 };
    backgroundFiles.set(shell, saved);
    let sequence = 0;
    const nextOrder = () => sequence++;
    const onChunk = (text: string, order = nextOrder(), omitted = 0) => {
        appendOutput(shell, text);
        saved.preview.append(text, order, omitted);
        outputFile.append(text, omitted);
    };
    for (const stream of [stdout, stderr]) if (stream) readBashStream(stream, onChunk, overflowLine, nextOrder);
    // The network goes with the shell: whatever it left running loses it.
    onClose((code) => {
        outputFile.flush();
        shell.exitCode = code ?? -1;
        proxy?.close();
    });
    child.on("error", (e) => {
        onChunk(`\n${redact(e.message)}`);
        outputFile.flush();
        shell.exitCode = 127;
        proxy?.close();
    });
    ctx.state.shells.set(id, shell);
    return {
        content: `Started background shell ${id} (pid ${child.pid})${ctx.sandbox ? " in the auto-mode sandbox" : ""}. Use BashOutput with bash_id "${id}" to read its output and KillShell to stop it.`,
        display: { summary: `Running in background as ${id}` },
    };
}

export const BashOutputTool: Tool<{ bash_id: string; filter?: string }> = {
    name: "BashOutput",
    category: "read",
    readOnly: true,
    description: "Retrieves new output from a background shell started with Bash run_in_background, or from a monitor (stdout and stderr). Returns only output produced since the last check, plus the shell's status. Optional filter is a regex; only matching lines are returned. Large output shows its head and tail, with the redacted output file path for Read/Grep. Saving is limited to 8 MiB per command and 64 MiB per session.",
    parameters: {
        type: "object",
        properties: {
            bash_id: { type: "string", description: "The background shell id (e.g. bash_1)" },
            filter: { type: "string", description: "Optional regex to filter output lines" },
        },
        required: ["bash_id"],
    },
    title: (i) => `BashOutput(${i.bash_id ?? ""})`,
    async run(input, ctx) {
        const sh = ctx.state.shells.get(input.bash_id);
        if (!sh) return { content: `No background shell with id ${input.bash_id}. Active: ${[...ctx.state.shells.keys()].join(", ") || "none"}`, isError: true };
        let re: RegExp | undefined;
        try {
            if (input.filter) re = new RegExp(input.filter);
        } catch (e) {
            return { content: `Invalid filter regex: ${(e as Error).message}`, isError: true };
        }
        // Validate first: a bad regex must not advance either cursor.
        sh.drain?.();
        const saved = backgroundFiles.get(sh);
        let fresh: string;
        let outputNote = "";
        let outputError: string | undefined;
        const endOffset = sh.output.length;
        if (saved) {
            saved.file.flush();
            const start = saved.offset;
            const end = saved.file.size;
            const snapshot = saved.preview;
            // Consume the in-memory snapshot before yielding; disk failures cannot consume future output.
            saved.preview = new OutputPreview();
            saved.offset = saved.file.totalBytes;
            sh.readOffset = endOffset;
            if (snapshot.displayTruncated) outputNote = saved.file.note;
            fresh = snapshot.render();
            if (re) {
                const filterRetained = () => {
                    if (snapshot.truncated) outputNote += "\nFilter searched only the retained head and tail; the saved output is incomplete or unavailable.";
                    return truncateMiddle(cleanOutput(snapshot.text).split("\n").filter((line) => re.test(line)).join("\n"), MAX_OUTPUT);
                };
                if (saved.file.path && !saved.file.error && !saved.file.incomplete && !saved.file.limit && end > start) {
                    try {
                        const preview = new OutputPreview();
                        const stream = createReadStream(saved.file.path, { start, end: end - 1, encoding: "utf8" });
                        let pending = "";
                        for await (const chunk of stream) {
                            const lines = (pending + chunk).split("\n");
                            pending = lines.pop()!;
                            for (const line of lines) if (re.test(line)) preview.append(line + "\n");
                        }
                        if (pending && re.test(pending)) preview.append(pending);
                        fresh = preview.render();
                    } catch (e) {
                        outputError = `Could not read saved output: ${redact((e as Error).message)}`;
                        if (snapshot.displayTruncated) outputNote += `\n${outputError}`;
                        fresh = filterRetained();
                    }
                } else fresh = filterRetained();
            }
        } else {
            fresh = cleanOutput(sh.output.slice(sh.readOffset, endOffset));
            if (re) fresh = fresh.split("\n").filter((line) => re.test(line)).join("\n");
            fresh = truncateMiddle(fresh, MAX_OUTPUT);
            sh.readOffset = endOffset;
        }
        const status = sh.exitCode === null ? "running" : `exited with code ${sh.exitCode}`;
        const outputHint = sh.sandboxed ? sh.sandboxHint?.() : undefined;
        const hint = outputHint ? `\n${outputHint}` : "";
        return {
            content: `<status>${status}</status>\n<output>\n${fresh || "(no new output)"}\n</output>${outputNote ? `\n\n${outputNote}` : ""}${hint}`,
            isError: false,
            display: { summary: `${status}${fresh ? `, ${fresh.split("\n").length} new lines` : ""}`, body: fresh || undefined },
        };
    },
};

export const KillShellTool: Tool<{ shell_id: string }> = {
    name: "KillShell",
    category: "meta",
    readOnly: false,
    description: "Stops a background shell started with Bash run_in_background, or a monitor started with Monitor.",
    parameters: {
        type: "object",
        properties: { shell_id: { type: "string", description: "The background shell id to kill" } },
        required: ["shell_id"],
    },
    title: (i) => `KillShell(${i.shell_id ?? ""})`,
    async run(input, ctx) {
        const sh = ctx.state.shells.get(input.shell_id);
        if (!sh) return { content: `No background shell with id ${input.shell_id}`, isError: true };
        const how = await sh.kill();
        ctx.state.shells.delete(input.shell_id);
        if (how === "killed") return { content: `Killed ${input.shell_id} (it didn't exit on SIGTERM, so it was sent SIGKILL)`, display: { summary: "Killed (forced)" } };
        if (how === "gone") return { content: `${input.shell_id} had already exited${sh.exitCode !== null ? ` with code ${sh.exitCode}` : ""}`, display: { summary: "Already exited" } };
        return { content: `Killed ${input.shell_id}`, display: { summary: "Killed" } };
    },
};

/** On exit: a shorter grace period, so quitting stays quick. */
export async function killAllShells(ctx: { state: { shells: Map<string, BackgroundShell> } }, graceMs = 1500) {
    const shells = [...ctx.state.shells.values()];
    ctx.state.shells.clear();
    await Promise.all(shells.map((sh) => sh.kill(graceMs)));
    const map = ctx.state.shells as ShellMap;
    const owner = map[OUTPUT_OWNER];
    if (owner) {
        rmSync(owner.dir, { recursive: true, force: true });
        delete map[OUTPUT_OWNER];
    }
}
