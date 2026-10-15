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

export interface CliInfo {
    /** Program name on PATH. */
    command: string;
    /** Product name for messages. */
    product: string;
    install: string;
    signIn: string;
}

export const CLAUDE_CLI: CliInfo = {
    command: "claude",
    product: "Claude Code",
    install: "Install Claude Code (https://code.claude.com/docs/en/setup)",
    signIn: "claude auth login",
};

export const CODEX_CLI: CliInfo = {
    command: "codex",
    product: "Codex",
    install: "Install the Codex CLI (npm install -g @openai/codex)",
    signIn: "codex login",
};

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
export async function runCli(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CliResult> {
    const proc = Bun.spawn([bin, ...args], { cwd: opts.cwd ?? homedir(), env: childEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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

const STDERR_TAIL = 16_000;

/** How long to wait on a CLI that's asked to stop (changeable for tests). */
export const stopTiming = {
    /** After an interrupt request, before terminating it. */
    interruptMs: 8000,
    /** After SIGTERM, before SIGKILL; and after that, before no longer reading its output. */
    killMs: 2000,
};

/** A long-running CLI speaking JSON lines on stdin/stdout. */
export class JsonLinesProcess {
    private proc: Subprocess<"pipe", "pipe", "pipe">;
    private err = "";
    private closed = false;
    private gone = false;
    private killing = false;
    private reader?: { cancel(): Promise<void> };
    readonly exited: Promise<number>;

    constructor(bin: string, args: string[], opts: { cwd: string }) {
        this.proc = Bun.spawn([bin, ...args], { cwd: opts.cwd, env: childEnv(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        this.exited = this.proc.exited;
        void this.exited.then(() => (this.gone = true));
        void this.drainStderr();
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

    send(obj: unknown) {
        if (this.closed) return;
        try {
            this.proc.stdin.write(JSON.stringify(obj) + "\n");
            this.proc.stdin.flush();
        } catch {
            // it exited; reading its output says why
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

    /** Each line of stdout that is a JSON object; other lines go with stderr. Ends when stdout does, or after kill(). */
    async *messages(): AsyncGenerator<Record<string, any>> {
        const d = new TextDecoder();
        let buf = "";
        const reader = (this.reader = this.proc.stdout.getReader());
        while (true) {
            let r: Awaited<ReturnType<typeof reader.read>>;
            try {
                r = await reader.read();
            } catch {
                break;
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
