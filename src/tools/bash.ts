import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { BackgroundShell, Tool, ToolContext } from "./types";
import { stripAnsi } from "../ui/ansi";
import { redact, lineRedactor } from "../util/redact";
import { truncateMiddle, isInside } from "../util/files";
import { childEnv } from "../util/env";
import { blockedBySandbox, sandboxArgv, sandboxCacheEnv, sandboxHint, type Sandbox } from "../permissions/sandbox";
import { parseHostRule, proxyEnv, refusedHint, startProxy, type CommandProxy, type HostRule } from "../permissions/proxy";
import { finalSearch } from "../permissions/bash-safety";

export { childEnv };

const MAX_OUTPUT = 30_000;
/** Kept of a command's output before the rest is dropped. */
const MAX_KEPT = MAX_OUTPUT * 20;
/**
 * The shell's own error (a glob with no match, a file it couldn't open, a
 * missing command), anywhere: after output with no newline it starts mid-line
 * (`Checking... zsh:1: no matches found`). Then status 1 may be the shell's.
 */
function shellComplained(output: string, shell = pickShell()): boolean {
    const name = (shell.split("/").pop() ?? "").replace(/[^\w.-]/g, "");
    return new RegExp(`${name ? `${name.replace(/\./g, "\\.")}(?::\\d+)?: |` : ""}\\(eval\\):\\d+: `).test(output);
}
const MAX_TIMEOUT = 600_000;
const BG_BUFFER = 1_000_000;
const MAX_HOSTS = 30;
/** A line still being written is held back up to this long (see BashOutput), like lineRedactor's. */
const MAX_PARTIAL_LINE = 64 * 1024;

/**
 * A sandboxed command's environment: package caches it can write and, with
 * Seatbelt, its own proxy, open to the hosts it was approved with.
 */
async function sandboxedEnv(env: Record<string, string>, sandbox: Sandbox, hosts: string[] | undefined): Promise<{ env: Record<string, string>; proxy?: CommandProxy }> {
    if (sandbox.kind !== "seatbelt") return { env: { ...env, ...sandboxCacheEnv() } };
    const rules = (hosts ?? []).map(parseHostRule).filter((r): r is HostRule => r !== undefined);
    const proxy = await startProxy(rules);
    return { env: { ...env, ...sandboxCacheEnv(rules.length > 0), ...proxyEnv(proxy.url) }, proxy };
}

/** What to tell the model after a sandboxed command failed, if the sandbox looks like the reason. */
function failureHint(sandbox: Sandbox, output: string, proxy: CommandProxy | undefined): string | undefined {
    const hints = [proxy && refusedHint(proxy.refused()), blockedBySandbox(output) ? sandboxHint(sandbox.kind, output) : undefined].filter(Boolean);
    return hints.length ? hints.join("\n") : undefined;
}

/** The shell commands run in: the user's, if it's bash or zsh. */
export function pickShell(): string {
    const sh = process.env.SHELL ?? "";
    if (/\/(bash|zsh)$/.test(sh) && existsSync(sh)) return sh;
    return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/** `shell -c script`, inside the sandbox when there is one. */
function shellArgv(script: string, sandbox?: Sandbox): string[] {
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
    sandbox?: Sandbox;
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
        const [file, ...args] = shellArgv(script, opts.sandbox);
        const child = spawn(file!, args, {
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
            if (output.length < MAX_KEPT) output += s;
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
- Output over ${MAX_OUTPUT} characters is truncated in the middle.
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
        const hosts: unknown = input.allowedHosts;
        if (hosts !== undefined) {
            if (!Array.isArray(hosts)) return "allowedHosts must be an array of host names";
            if (hosts.length > MAX_HOSTS) return `allowedHosts can list at most ${MAX_HOSTS} hosts`;
            const bad = hosts.filter((h) => typeof h !== "string" || !parseHostRule(h));
            if (bad.length) return `allowedHosts: ${bad.map((b) => JSON.stringify(b)).join(", ")} ${bad.length === 1 ? "isn't a host" : "aren't hosts"}. List host names like registry.npmjs.org, *.example.com or example.com:8443 (no URLs, paths or bare wildcards).`;
        }
        return undefined;
    },
    async run(input, ctx) {
        // childEnv leaves out every registered secret; this session's own go back in, for its shell alone.
        let env = { ...childEnv(ctx.settings.env), ...ctx.state.secrets?.env() };
        let proxy: CommandProxy | undefined;
        if (ctx.sandbox) ({ env, proxy } = await sandboxedEnv(env, ctx.sandbox, input.allowedHosts));
        if (input.run_in_background) return startBackground(input.command, ctx, env, proxy);
        const timeoutMs = Math.min(MAX_TIMEOUT, Math.max(1000, input.timeout ?? ctx.settings.bashTimeout ?? 120_000));
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
                sandbox: ctx.sandbox,
                onData: (chunk) => {
                    ready += lines(chunk);
                    const now = Date.now();
                    if (!ready || now - lastProgress <= 100) return;
                    ctx.onProgress?.(ready);
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
        let out = truncateMiddle(cleanOutput(res.output), MAX_OUTPUT);
        const failed = res.timedOut || (res.exitCode !== 0 && res.exitCode !== null);
        // A last grep that found nothing exits 1: that's the answer, not a failure of what came before it.
        // Unless the shell complained (then the 1 may be its own), or output was dropped where it could have,
        // or the shell stopped before the end of the script (errexit, a failed special builtin): then it's not
        // the last command's 1. The line after the command records the cwd, so a cwd means it got there.
        const search = res.exitCode === 1 && !res.timedOut && !res.aborted && res.newCwd !== undefined && res.output.length < MAX_KEPT && !shellComplained(stripAnsi(res.output)) ? finalSearch(input.command, env) : undefined;
        if (res.timedOut) out += `\n\nCommand timed out after ${Math.round(timeoutMs / 1000)}s and was killed.`;
        else if (res.aborted) out += `\n\n[Command interrupted by user]`;
        else if (search) {
            const piped = search.piped ? " What was piped into it may still have failed: that doesn't change its status." : "";
            out += `${out.trim() ? "\n\n" : ""}Exit code: 1 (the last command, ${search.name}, found no matches: that's its status for no match, not an error.${piped}${out.trim() ? " The output above is everything the command printed." : ""})`;
        }
        else if (res.exitCode !== 0 && res.exitCode !== null) out += `\n\nExit code: ${res.exitCode}`;
        else if (res.signal) out += `\n\nTerminated by signal ${res.signal}`;
        out += notes;
        const hint = ctx.sandbox && failed && !res.aborted ? failureHint(ctx.sandbox, res.output, proxy) : undefined;
        if (hint) out += `\n\n${hint}`;
        const lineCount = out.trim() ? out.trim().split("\n").length : 0;
        return {
            content: out.trim() || "(no output)",
            isError: failed && !res.aborted && !search,
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

function startBackground(command: string, ctx: ToolContext, env: Record<string, string>, proxy: CommandProxy | undefined) {
    const id = `bash_${++shellCounter}`;
    const [file, ...args] = shellArgv(command, ctx.sandbox);
    let child: ReturnType<typeof spawn>;
    try {
        child = spawn(file!, args, { cwd: ctx.state.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
        proxy?.close();
        throw e;
    }
    const sandbox = ctx.sandbox;
    const shell: BackgroundShell = {
        id,
        command,
        startedAt: Date.now(),
        output: "",
        readOffset: 0,
        exitCode: null,
        sandboxed: sandbox !== undefined,
        sandboxHint: sandbox ? () => failureHint(sandbox, shell.output, proxy) : undefined,
        kill: async (graceMs = KILL_GRACE_MS) => {
            const how = await stopGroup(child.pid, graceMs);
            proxy?.close();
            return how;
        },
    };
    const onChunk = (b: Buffer) => {
        shell.output += b.toString("utf-8");
        if (shell.output.length > BG_BUFFER) {
            let drop = shell.output.length - BG_BUFFER;
            // From a line's start: the tail of a secret cut off here wouldn't be redacted.
            const nl = shell.output.indexOf("\n", drop);
            if (nl !== -1 && nl - drop < MAX_PARTIAL_LINE) drop = nl + 1;
            shell.output = shell.output.slice(drop);
            shell.readOffset = Math.max(0, shell.readOffset - drop);
        }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    // The network goes with the shell: whatever it left running loses it.
    child.on("close", (code) => {
        shell.exitCode = code ?? -1;
        proxy?.close();
    });
    child.on("error", (e) => {
        shell.output += `\n${e.message}`;
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
        // While it runs, a line still being written waits: half a secret now and half next time would each get past redaction.
        let end = sh.output.length;
        if (sh.exitCode === null) {
            const nl = sh.output.lastIndexOf("\n", end - 1);
            const lineStart = Math.max(nl + 1, sh.readOffset);
            if (end - lineStart <= MAX_PARTIAL_LINE) end = lineStart;
        }
        let fresh = cleanOutput(sh.output.slice(sh.readOffset, end));
        sh.readOffset = end;
        if (input.filter) {
            try {
                const re = new RegExp(input.filter);
                fresh = fresh.split("\n").filter((l) => re.test(l)).join("\n");
            } catch (e) {
                return { content: `Invalid filter regex: ${(e as Error).message}`, isError: true };
            }
        }
        const status = sh.exitCode === null ? "running" : `exited with code ${sh.exitCode}`;
        const failedHint = sh.exitCode !== null && sh.exitCode !== 0 ? sh.sandboxHint?.() : undefined;
        const hint = failedHint ? `\n${failedHint}` : "";
        return {
            content: `<status>${status}</status>\n<output>\n${truncateMiddle(fresh, MAX_OUTPUT) || "(no new output)"}\n</output>${hint}`,
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
