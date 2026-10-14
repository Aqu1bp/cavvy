import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { BackgroundShell, Tool, ToolContext } from "./types";
import { stripAnsi } from "../ui/ansi";
import { redact } from "../util/redact";
import { truncateMiddle, isInside } from "../util/files";
import { childEnv } from "../util/env";

export { childEnv };

const MAX_OUTPUT = 30_000;
const MAX_TIMEOUT = 600_000;
const BG_BUFFER = 1_000_000;

function pickShell(): string {
    const sh = process.env.SHELL ?? "";
    if (/\/(bash|zsh)$/.test(sh) && existsSync(sh)) return sh;
    return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

let cwdFileCounter = 0;

interface RunOpts {
    command: string;
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
    env: Record<string, string>;
    onData?: (chunk: string) => void;
}

interface RunResult {
    output: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    aborted: boolean;
    newCwd?: string;
}

export function runShell(opts: RunOpts): Promise<RunResult> {
    const cwdFile = join(tmpdir(), `harness-cwd-${process.pid}-${++cwdFileCounter}`);
    const script = `${opts.command}\n__harness_ec=$?\npwd -P > '${cwdFile}' 2>/dev/null\nexit $__harness_ec\n`;
    return new Promise((resolvePromise) => {
        const child = spawn(pickShell(), ["-c", script], {
            cwd: opts.cwd,
            env: opts.env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
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
        const onChunk = (b: Buffer) => {
            const s = b.toString("utf-8");
            if (output.length < MAX_OUTPUT * 20) output += s;
            opts.onData?.(s);
        };
        child.stdout?.on("data", onChunk);
        child.stderr?.on("data", onChunk);
        const timer = setTimeout(() => {
            timedOut = true;
            killTree();
        }, opts.timeoutMs);
        const onAbort = () => {
            aborted = true;
            killTree();
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
        child.on("close", (code, sig) => {
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
            resolvePromise({ output, exitCode: code, signal: sig, timedOut, aborted, newCwd });
        });
        child.on("error", (err) => {
            clearTimeout(timer);
            resolvePromise({ output: output + `\n${err.message}`, exitCode: 127, signal: null, timedOut, aborted, newCwd: undefined });
        });
    });
}

function cleanOutput(s: string): string {
    // Collapse carriage-return progress bars to their final state, strip ANSI.
    const lines = stripAnsi(s)
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

export const BashTool: Tool<{ command: string; description?: string; timeout?: number; run_in_background?: boolean }> = {
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
- Output over ${MAX_OUTPUT} characters is truncated in the middle.
- Never run git commands that rewrite history or push unless the user asked. Never skip hooks (--no-verify) unless asked.
- Always write a short description (5-10 words) of what the command does.`,
    parameters: {
        type: "object",
        properties: {
            command: { type: "string", description: "The command to run" },
            description: { type: "string", description: "Clear 5-10 word description of what the command does" },
            timeout: { type: "number", description: "Timeout in milliseconds (max 600000)" },
            run_in_background: { type: "boolean", description: "Run in the background and return immediately" },
        },
        required: ["command"],
    },
    title: (i) => `Bash(${(i.command ?? "").split("\n")[0]}${(i.command ?? "").includes("\n") ? " …" : ""})`,
    validate(input) {
        if (typeof input.command !== "string" || !input.command.trim()) return "command must be a non-empty string";
        return undefined;
    },
    async run(input, ctx) {
        const env = childEnv(ctx.settings.env);
        if (input.run_in_background) return startBackground(input.command, ctx, env);
        const timeoutMs = Math.min(MAX_TIMEOUT, Math.max(1000, input.timeout ?? ctx.settings.bashTimeout ?? 120_000));
        let lastProgress = 0;
        let pending = "";
        const res = await runShell({
            command: input.command,
            cwd: ctx.state.cwd,
            timeoutMs,
            signal: ctx.signal,
            env,
            onData: (chunk) => {
                pending += chunk;
                const now = Date.now();
                if (now - lastProgress > 100) {
                    ctx.onProgress?.(redact(stripAnsi(pending)));
                    pending = "";
                    lastProgress = now;
                }
            },
        });
        let notes = "";
        if (res.newCwd && res.newCwd !== ctx.state.cwd) {
            if (allowedRoots(ctx).some((r) => isInside(res.newCwd!, r))) ctx.state.cwd = res.newCwd;
            else {
                notes += `\nShell cwd was reset to ${ctx.state.projectRoot} (cd outside the workspace is not persisted).`;
                ctx.state.cwd = ctx.state.projectRoot;
            }
        }
        let out = truncateMiddle(cleanOutput(res.output), MAX_OUTPUT);
        if (res.timedOut) out += `\n\nCommand timed out after ${Math.round(timeoutMs / 1000)}s and was killed.`;
        else if (res.aborted) out += `\n\n[Command interrupted by user]`;
        else if (res.exitCode !== 0 && res.exitCode !== null) out += `\n\nExit code: ${res.exitCode}`;
        else if (res.signal) out += `\n\nTerminated by signal ${res.signal}`;
        out += notes;
        const failed = res.timedOut || (res.exitCode !== 0 && res.exitCode !== null);
        const lineCount = out.trim() ? out.trim().split("\n").length : 0;
        return {
            content: out.trim() || "(no output)",
            isError: failed && !res.aborted,
            display: {
                summary: res.timedOut ? "Timed out" : res.aborted ? "Interrupted" : lineCount === 0 ? (failed ? `Exit code ${res.exitCode}` : "(no output)") : undefined,
                body: out.trim() || undefined,
            },
        };
    },
};

const KILL_GRACE_MS = 3000;

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

function startBackground(command: string, ctx: ToolContext, env: Record<string, string>) {
    const id = `bash_${++shellCounter}`;
    const child = spawn(pickShell(), ["-c", command], { cwd: ctx.state.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const shell: BackgroundShell = {
        id,
        command,
        startedAt: Date.now(),
        output: "",
        readOffset: 0,
        exitCode: null,
        kill: (graceMs = KILL_GRACE_MS) => stopGroup(child.pid, graceMs),
    };
    const onChunk = (b: Buffer) => {
        shell.output += b.toString("utf-8");
        if (shell.output.length > BG_BUFFER) {
            const drop = shell.output.length - BG_BUFFER;
            shell.output = shell.output.slice(drop);
            shell.readOffset = Math.max(0, shell.readOffset - drop);
        }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("close", (code) => {
        shell.exitCode = code ?? -1;
    });
    child.on("error", (e) => {
        shell.output += `\n${e.message}`;
        shell.exitCode = 127;
    });
    ctx.state.shells.set(id, shell);
    return {
        content: `Started background shell ${id} (pid ${child.pid}). Use BashOutput with bash_id "${id}" to read its output and KillShell to stop it.`,
        display: { summary: `Running in background as ${id}` },
    };
}

export const BashOutputTool: Tool<{ bash_id: string; filter?: string }> = {
    name: "BashOutput",
    category: "read",
    readOnly: true,
    description: "Retrieves new output from a background shell started with Bash run_in_background. Returns only output produced since the last check, plus the shell's status. Optional filter is a regex; only matching lines are returned.",
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
        let fresh = cleanOutput(sh.output.slice(sh.readOffset));
        sh.readOffset = sh.output.length;
        if (input.filter) {
            try {
                const re = new RegExp(input.filter);
                fresh = fresh.split("\n").filter((l) => re.test(l)).join("\n");
            } catch (e) {
                return { content: `Invalid filter regex: ${(e as Error).message}`, isError: true };
            }
        }
        const status = sh.exitCode === null ? "running" : `exited with code ${sh.exitCode}`;
        return {
            content: `<status>${status}</status>\n<output>\n${truncateMiddle(fresh, MAX_OUTPUT) || "(no new output)"}\n</output>`,
            display: { summary: `${status}${fresh ? `, ${fresh.split("\n").length} new lines` : ""}`, body: fresh || undefined },
        };
    },
};

export const KillShellTool: Tool<{ shell_id: string }> = {
    name: "KillShell",
    category: "meta",
    readOnly: false,
    description: "Stops a background shell started with Bash run_in_background.",
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
}
