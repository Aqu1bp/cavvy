// Shared helpers for the protocol probes (#219 PR 0). Standalone: no Cavvy imports, so a probe
// exercises the CLIs exactly as a bare client would. Every frame in and out is logged to a JSONL file:
//   {"t": ms since start, "dir": "in"|"out"|"err"|"note", "frame": <parsed json | string>}
// "in" is what the CLI wrote to us, "out" is what we wrote to it.
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SCRATCH = process.env.PROBE_SCRATCH ?? "/tmp/live-probes-scratch";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scrub anything that looks like an account email, an org, account, user or install id, or a token before it is written. */
export function scrub<T>(v: T): T {
    const s = JSON.stringify(v)
        .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
        .replace(/\b(sk|sess|ghp|gho|xox[a-z])-[A-Za-z0-9_-]{16,}/g, "<token>")
        .replace(/(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g, "<jwt>")
        .replace(/("(?:[A-Za-z]*(?:account|org|organization|user|workspace|chatgpt|tenant|installation|device|machine)_?(?:id|uuid))"\s*:\s*)"[^"]*"/gi, '$1"<id>"')
        .replace(/("(?:email|name|display_?name)"\s*:\s*)"[^"]*@[^"]*"/gi, '$1"<email>"')
        .replace(/\/Users\/[^/"\s]+/g, "/Users/<user>")
        // claude.ai's synced skills and plugins sit in a folder named for the organization and account (<org>_<account>).
        .replace(/\/synced\/[0-9a-f]{8}-[0-9a-f-]{27}_[0-9a-f]{8}-[0-9a-f-]{27}/gi, "/synced/<org>_<account>")
        .replace(/\baquibs?-macbook-pro(\.local)?\b/gi, "<host>")
        .replace(/("balance"\s*:\s*)"[^"]*"/g, '$1"<n>"')
        .replace(/\baquib\b/gi, "<user>");
    return JSON.parse(s);
}

/** Keeps fixtures small: long strings are cut, long arrays keep their first items. The raw frames stay intact in memory. */
export function trim(v: any, depth = 0): any {
    if (typeof v === "string") return v.length > 500 ? `${v.slice(0, 500)}...[${v.length - 500} more chars]` : v;
    if (Array.isArray(v)) return v.length > 6 ? [...v.slice(0, 3).map((x) => trim(x, depth + 1)), `...[${v.length - 3} more items]`] : v.map((x) => trim(x, depth + 1));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, depth + 1)]));
    return v;
}

export class Log {
    private t0 = Date.now();
    readonly frames: { t: number; dir: string; frame: any }[] = [];
    constructor(readonly file: string) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "");
    }
    add(dir: "in" | "out" | "err" | "note", frame: unknown) {
        const e = { t: Date.now() - this.t0, dir, frame };
        this.frames.push(e);
        appendFileSync(this.file, JSON.stringify(trim(scrub(e))) + "\n");
        if (process.env.PROBE_VERBOSE) console.error(`[${e.t}] ${dir} ${JSON.stringify(scrub(frame)).slice(0, 220)}`);
    }
    note(text: string, extra?: unknown) {
        this.add("note", extra === undefined ? text : { text, ...(extra as object) });
        console.error(`# ${text}`);
    }
}

/** A child process speaking JSON lines; logs every frame. */
export class JsonProc {
    readonly proc;
    readonly frames: any[] = [];
    private waiters: { test: (f: any) => boolean; resolve: (f: any) => void }[] = [];
    exitCode: number | null = null;
    readonly exited: Promise<number>;
    constructor(readonly log: Log, cmd: string[], opts: { cwd: string; env?: Record<string, string> }) {
        this.proc = Bun.spawn(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        this.exited = this.proc.exited.then((c) => ((this.exitCode = c), log.note(`process exited with code ${c}`), c));
        void this.readOut();
        void this.readErr();
    }
    get pid() {
        return this.proc.pid;
    }
    private async readOut() {
        const d = new TextDecoder();
        let buf = "";
        for await (const chunk of this.proc.stdout) {
            buf += d.decode(chunk, { stream: true });
            let i: number;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (!line) continue;
                let f: any;
                try {
                    f = JSON.parse(line);
                } catch {
                    this.log.add("in", line);
                    continue;
                }
                this.frames.push(f);
                this.log.add("in", f);
                for (const w of [...this.waiters]) if (w.test(f)) (this.waiters = this.waiters.filter((x) => x !== w), w.resolve(f));
            }
        }
    }
    private async readErr() {
        const d = new TextDecoder();
        for await (const chunk of this.proc.stderr) this.log.add("err", d.decode(chunk));
    }
    send(obj: unknown) {
        this.log.add("out", obj);
        this.proc.stdin.write(JSON.stringify(obj) + "\n");
        this.proc.stdin.flush();
    }
    /** Resolves with the first frame (already seen after index `from`, or future) matching `test`; undefined on timeout. */
    waitFor(test: (f: any) => boolean, timeoutMs: number, from = 0): Promise<any | undefined> {
        const seen = this.frames.slice(from).find(test);
        if (seen) return Promise.resolve(seen);
        return new Promise((resolve) => {
            const w = { test, resolve: (f: any) => (clearTimeout(timer), resolve(f)) };
            const timer = setTimeout(() => ((this.waiters = this.waiters.filter((x) => x !== w)), resolve(undefined)), timeoutMs);
            this.waiters.push(w);
        });
    }
    alive() {
        return this.exitCode === null;
    }
    async kill() {
        if (this.alive()) {
            this.proc.kill();
            await Promise.race([this.exited, sleep(2000)]);
            if (this.alive()) this.proc.kill(9);
        }
    }
}

/** Whether a pid is still running (signal 0). */
export function pidAlive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export const fixture = (name: string) => `${new URL("../../test/fixtures/protocol/", import.meta.url).pathname}${name}.jsonl`;
