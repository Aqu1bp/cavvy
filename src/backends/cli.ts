// Running the agent CLIs: finding the binary, starting it with the harness's
// child environment (provider keys removed, so the CLI uses its own sign-in),
// and talking newline-delimited JSON over its stdin/stdout.

import { existsSync, statSync } from "fs";
import { isAbsolute } from "path";
import { homedir } from "os";
import type { Subprocess } from "bun";
import { childEnv } from "../util/env";
import { redact } from "../util/redact";
import { ProviderError } from "../providers/types";
import { readAgentConfig } from "../providers/registry";
import { agentCli } from "./defs";

export interface CliInfo {
    /** Program name on PATH. */
    command: string;
    /** Product name for messages. */
    product: string;
    install: string;
    signIn: string;
}

export const CLAUDE_CLI: CliInfo = cliOf("claude-code");

export const CODEX_CLI: CliInfo = cliOf("codex");

function cliOf(id: string): CliInfo {
    const def = agentCli(id);
    if (!def) throw new Error(`No agent CLI ${id}`);
    return def.cli;
}

/** The CLI's path: the one saved with /login (`path`), or the first on PATH. */
export function findCli(providerId: string, cli: CliInfo): string | undefined {
    const configured = readAgentConfig(providerId)?.path;
    if (configured) {
        const p = configured.startsWith("~/") ? homedir() + configured.slice(1) : configured;
        if (isAbsolute(p)) return existsSync(p) && statSync(p).isFile() ? p : undefined;
        return Bun.which(p, { PATH: process.env.PATH ?? "" }) ?? undefined;
    }
    return Bun.which(cli.command, { PATH: process.env.PATH ?? "" }) ?? undefined;
}

export function requireCli(providerId: string, cli: CliInfo): string {
    const bin = findCli(providerId, cli);
    if (!bin) {
        const configured = readAgentConfig(providerId)?.path;
        throw new ProviderError(configured ? `${cli.product} isn't at ${configured} (set with /login ${providerId}).` : `${cli.product} isn't installed (no \`${cli.command}\` on PATH). ${cli.install}, sign in with \`${cli.signIn}\`, then try again.`, 401);
    }
    return bin;
}

/** Extra arguments saved for this CLI (providers.json), placed before the harness's own. */
export function extraArgs(providerId: string): string[] {
    return readAgentConfig(providerId)?.args ?? [];
}

export interface CliResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** Run a short CLI command (status checks) with arguments only, never a shell. */
export async function runCli(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> } = {}): Promise<CliResult> {
    const proc = Bun.spawn([bin, ...args], { cwd: opts.cwd ?? homedir(), env: { ...childEnv(), ...opts.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const kill = () => proc.kill();
    const timer = setTimeout(kill, opts.timeoutMs ?? 20_000);
    opts.signal?.addEventListener("abort", kill, { once: true });
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { code, stdout, stderr };
    } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", kill);
    }
}

/** The first meaningful line of a CLI's error output, redacted. */
export function cliMessage(text: string): string {
    const lines = redact(text)
        .split("\n")
        .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
        .filter((l) => l && !/^(WARNING|warning):/.test(l));
    return (lines.find((l) => /error/i.test(l)) ?? lines[0] ?? "").slice(0, 400);
}

/** Identity and plan labels are untrusted CLI output and stay out of persistent state. */
export function cliStatusString(value: unknown): string | undefined {
    return typeof value === "string" ? redact(value).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) : undefined;
}

const STDERR_TAIL = 16_000;

/** How long to wait on a CLI that's asked to stop (changeable for tests). */
export const stopTiming = {
    /** After an interrupt request, before terminating it. */
    interruptMs: 8000,
    /** After SIGTERM, before SIGKILL; and after that, before no longer reading its output. */
    killMs: 2000,
};

/** How long after a write that waited on the pipe its process's exit, if that's why it settled, is reported (JsonLinesProcess.send). */
const EXIT_SEEN_MS = 100;

/** A long-running CLI speaking JSON lines on stdin/stdout. */
export class JsonLinesProcess {
    private proc: Subprocess<"pipe", "pipe", "pipe">;
    private err = "";
    private closed = false;
    private gone = false;
    private killing = false;
    private reader?: { cancel(): Promise<void> };
    readonly exited: Promise<number>;
    readonly pid: number;
    /** Settles once its stderr has ended (and been read). */
    readonly stderrEnded: Promise<void>;

    constructor(bin: string, args: string[], opts: { cwd: string; env?: Record<string, string> }) {
        this.proc = Bun.spawn([bin, ...args], { cwd: opts.cwd, env: { ...childEnv(), ...opts.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        this.exited = this.proc.exited;
        this.pid = this.proc.pid;
        void this.exited.then(() => (this.gone = true));
        this.stderrEnded = this.drainStderr();
    }

    private async drainStderr() {
        const d = new TextDecoder();
        try {
            for await (const chunk of this.proc.stderr) this.err = (this.err + d.decode(chunk, { stream: true })).slice(-STDERR_TAIL);
        } catch {
            // the process went away
        }
    }

    /** What the CLI wrote to stderr (the end of it), redacted. */
    stderr(): string {
        return redact(this.err);
    }

    /**
     * Write one line to its stdin. True once all of it is written; false when it couldn't be: closed, or the
     * process went away before taking it all. A line the pipe can't take at once (an image) waits on it: Bun's
     * write hands back a promise, which rejects with EPIPE when the reader is gone, or settles as it exits
     * (with what went so far), a moment before the exit is reported. So a write that waited counts only if the
     * process is still there a moment later (EXIT_SEEN_MS). Calls stay in order: each line is buffered whole
     * when it's called.
     */
    async send(obj: unknown): Promise<boolean> {
        if (this.closed || this.gone) return false;
        const sink = this.proc.stdin;
        const written = (async () => {
            const w = sink.write(JSON.stringify(obj) + "\n");
            let waited = w instanceof Promise;
            await w;
            for (let i = 0; i < 1000; i++) {
                const f = sink.flush();
                const n = await f;
                if (f instanceof Promise) waited = true;
                else if (!n) break;
            }
            if (!waited) return true;
            return !(await Promise.race([this.exited.then(() => true), Bun.sleep(EXIT_SEEN_MS).then(() => false)]));
        })();
        try {
            // Its exit settles it too, should the pipe's promises never.
            return await Promise.race([written, this.exited.then(() => false)]);
        } catch {
            // it exited; reading its output says why
            return false;
        } finally {
            written.catch(() => {});
        }
    }

    /** Close stdin: the CLI finishes and exits. */
    end() {
        if (this.closed) return;
        this.closed = true;
        try {
            this.proc.stdin.end();
        } catch {
            // already gone
        }
    }

    /**
     * Each line of stdout that is a JSON object; other lines go with stderr. Ends when stdout does, or after
     * kill(). With `quietAfterExitMs`: also once the process has exited and nothing more comes for that long
     * (a child it started may hold stdout open). Only time spent waiting for output counts, so output already
     * written is all read, however slowly the caller takes it.
     */
    async *messages(o: { quietAfterExitMs?: number } = {}): AsyncGenerator<Record<string, any>> {
        const d = new TextDecoder();
        let buf = "";
        const reader = (this.reader = this.proc.stdout.getReader());
        // One watch for the whole read, not one per chunk (that would hold every chunk until the exit).
        let waitingSince: number | undefined;
        let finished = false;
        let quietTimer: ReturnType<typeof setTimeout> | undefined;
        const quiet = o.quietAfterExitMs;
        if (quiet !== undefined) {
            void this.exited.then(() => {
                const exitedAt = Date.now();
                const check = () => {
                    if (finished) return;
                    const since = waitingSince === undefined ? undefined : Math.max(waitingSince, exitedAt);
                    // Gone, and nothing more for that long while we waited: what's still held open won't be read.
                    if (since !== undefined && Date.now() - since >= quiet) return void reader.cancel().catch(() => {});
                    quietTimer = setTimeout(check, since === undefined ? quiet : quiet - (Date.now() - since)) as ReturnType<typeof setTimeout>;
                };
                check();
            });
        }
        try {
            while (true) {
                let r: Awaited<ReturnType<typeof reader.read>>;
                try {
                    waitingSince = Date.now();
                    r = await reader.read();
                } catch {
                    break;
                } finally {
                    waitingSince = undefined;
                }
                if (r.done) break;
                buf += d.decode(r.value, { stream: true });
                let i: number;
                while ((i = buf.indexOf("\n")) >= 0) {
                    const line = buf.slice(0, i).trim();
                    buf = buf.slice(i + 1);
                    if (!line) continue;
                    let msg: unknown;
                    try {
                        msg = JSON.parse(line);
                    } catch {
                        this.err = (this.err + line + "\n").slice(-STDERR_TAIL);
                        continue;
                    }
                    if (msg && typeof msg === "object" && !Array.isArray(msg)) yield msg as Record<string, any>;
                }
            }
        } finally {
            finished = true;
            clearTimeout(quietTimer);
        }
    }

    /** End stdin, give it `graceMs` to exit, then terminate it. */
    async stop(graceMs = 3000): Promise<void> {
        this.end();
        const gone = await Promise.race([this.exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
        if (!gone) await this.kill();
    }

    /**
     * SIGTERM; SIGKILL if it's still running after a grace period; and if its
     * output still hasn't ended (a child of it holds the pipe), stop reading
     * it, so nothing waiting on it hangs.
     */
    async kill(): Promise<void> {
        this.closed = true;
        if (this.killing) return;
        this.killing = true;
        if (!this.gone) this.proc.kill("SIGTERM");
        const exited = () => Promise.race([this.exited.then(() => true), Bun.sleep(stopTiming.killMs).then(() => false)]);
        if (!(await exited())) this.proc.kill("SIGKILL");
        await exited();
        await this.reader?.cancel().catch(() => {});
    }
}

/** A short, readable title for a shell command. */
export function commandTitle(cmd: string): string {
    const one = cmd.replace(/\s+/g, " ").trim();
    return `Bash(${one.length > 120 ? one.slice(0, 117) + "…" : one})`;
}
