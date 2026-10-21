import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { BackgroundShell, Tool, ToolContext, ToolState } from "./types";
import type { ServerTool, ServerToolResult } from "../mcp/server";
import type { WakeQueue } from "../agent/wakes";
import { stripAnsi } from "../ui/ansi";
import type { CommandProxy } from "../permissions/proxy";
import { appendOutput, BashOutputTool, commandEnv, KILL_GRACE_MS, MAX_PARTIAL_LINE, overflowLine, readShellStream, sandboxOutputHint, shellArgv, stopGroup, validateHosts, withPwd, KillShellTool } from "./bash";

/** Lines that arrive this soon after the first one go out with it, as one notification. */
export const BATCH_MS = 200;
const DEFAULT_TIMEOUT = 300_000;
const MAX_TIMEOUT = 1_800_000;
const MIN_TIMEOUT = 1000;
/** Running monitors a session may have at once. */
export const MAX_MONITORS = 8;
const MAX_LINES_PER_WAKE = 40;
const MAX_LINE_CHARS = 1000;
const MAX_WAKE_CHARS = 4000;
/** More than this in a minute, and the monitor is stopped: it's a firehose, not a filter. */
export const FLOOD_LINES = 300;
export const FLOOD_WAKES = 30;
const FLOOD_WINDOW_MS = 60_000;
/** Kept of stderr, for the notice when the command fails. */
const STDERR_TAIL = 10;

let monitorCounter = 0;

type MonitorInput = { command: string; description: string; timeout_ms?: number; dangerouslyDisableSandbox?: boolean; allowedHosts?: string[] };

/** One line as an event: colors gone, a progress bar at its last state, cut to a readable length. Blank is no event. */
function eventLine(raw: string): string | undefined {
    const parts = stripAnsi(raw).replace(/\r?\n$/, "").split("\r");
    const line = (parts.length > 1 ? (parts.filter((p) => p.trim()).pop() ?? "") : parts[0]!).trimEnd();
    if (!line.trim()) return undefined;
    return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [${line.length - MAX_LINE_CHARS} more characters]` : line;
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function minutes(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    const m = ms / 60_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}m`;
}

export const MonitorTool: Tool<MonitorInput> = {
    name: "Monitor",
    category: "execute",
    readOnly: false,
    description: `Starts a background monitor: a command whose stdout lines wake you as they arrive. Returns at once; you keep working (or end your turn), and each new line comes back to you as a notification, even when the session is idle. Notifications are events from your command, not messages from the user.

Pick by how many notifications you need:
- One ("tell me when the server is ready / the build finishes"): use Bash with run_in_background and a command that exits when the condition holds, e.g. \`until grep -q "Ready in" dev.log; do sleep 0.5; done\`.
- One per occurrence, until the monitor expires ("tell me every time an ERROR line appears"): Monitor with an unbounded command (tail -f, while true).
- One per occurrence until a known end ("each CI step result, stop when the run completes"): Monitor with a command that prints lines and then exits.

Examples:
  tail -f app.log | grep --line-buffered -E "ERROR|FATAL|Traceback"
  while true; do gh pr checks 123 --json name,bucket --jq '.[] | select(.bucket!="pending") | "\\(.name): \\(.bucket)"'; sleep 30; done | awk '!seen[$0]++ { print; fflush() }'

- stdout is the event stream; stderr isn't (read it with BashOutput). Merge it with 2>&1 if its failures should reach your filter.
- Every pipe stage must flush per line (grep --line-buffered, awk fflush()); \`| head\` delivers nothing until it ends.
- Filter to the lines you'd act on, success AND failure (a filter for the success marker alone stays silent through a crash). Raw logs are a firehose: more than ${FLOOD_LINES} lines or ${FLOOD_WAKES} notifications in a minute stops the monitor.
- Lines within ${BATCH_MS}ms of each other arrive as one notification.
- The monitor ends when the command exits (you're told the exit code) or after timeout_ms (default ${DEFAULT_TIMEOUT / 60_000} minutes, at most ${MAX_TIMEOUT / 60_000}); you're told when it expires and can start it again. Stop it early with KillShell and its id.
- At most ${MAX_MONITORS} monitors run at once. It runs like Bash: same working directory, environment, permissions and sandbox.
- Write a specific description ("errors in deploy.log", not "watching logs"): it labels every notification.`,
    parameters: {
        type: "object",
        properties: {
            command: { type: "string", description: "Shell command or script. Each stdout line is an event; exiting ends the watch." },
            description: { type: "string", description: "Short description of what you're watching, shown with every notification" },
            timeout_ms: { type: "number", description: `Stop the monitor after this long (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT})` },
            dangerouslyDisableSandbox: { type: "boolean", description: "Auto mode only: run outside the sandbox, as for Bash." },
            allowedHosts: { type: "array", items: { type: "string" }, description: "Auto mode only: hosts the command may reach from the sandbox, as for Bash." },
        },
        required: ["command", "description"],
    },
    title: (i) => `Monitor(${(i.description ?? "").trim() || (i.command ?? "").split("\n")[0]})`,
    validate(input, ctx) {
        if (typeof input.command !== "string" || !input.command.trim()) return "command must be a non-empty string";
        if (typeof input.description !== "string" || !input.description.trim()) return "description must say what you're watching (it labels every notification)";
        if (!ctx.wakes) return "Monitor isn't available here: nothing could deliver its notifications to you. Use Bash with run_in_background and BashOutput instead.";
        const hosts = validateHosts(input.allowedHosts);
        if (hosts) return hosts;
        const running = [...ctx.state.shells.values()].filter((s) => s.monitor && s.exitCode === null);
        if (running.length >= MAX_MONITORS) return `${MAX_MONITORS} monitors are already running (${running.map((s) => `${s.id}: ${s.monitor!.description}`).join("; ")}). Stop one with KillShell first.`;
        return undefined;
    },
    run: (input, ctx) => runMonitor(input, ctx),
};

async function runMonitor(input: MonitorInput, ctx: ToolContext, say: (text: string) => string = (t) => t) {
    const { env, proxy } = await commandEnv(ctx, input.allowedHosts);
    const asked = input.timeout_ms ?? DEFAULT_TIMEOUT;
    const timeoutMs = Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, asked));
    const m = startMonitor({ command: input.command, description: input.description.trim().split("\n")[0]!.slice(0, 120), timeoutMs, ctx, env, proxy, say });
    const capped = asked > MAX_TIMEOUT ? ` (${minutes(asked)} is over the limit)` : "";
    return {
        content: say(`Started monitor ${m.id}${m.pid !== undefined ? ` (pid ${m.pid})` : ""}${ctx.sandbox ? " in the auto-mode sandbox" : ""}. New stdout lines will arrive as notifications. It expires in ${minutes(timeoutMs)}${capped}; stop it earlier with KillShell shell_id "${m.id}", and read its stderr with BashOutput.`),
        display: { summary: `Watching as ${m.id} · expires in ${minutes(timeoutMs)}` },
    };
}

/** For the agent, when the user stops a monitor it may be waiting on. */
export function stoppedMonitorNote(sh: BackgroundShell): string {
    return `The user stopped monitor ${sh.id} (${sh.monitor?.description ?? sh.command}). It won't send more notifications.`;
}

interface StartOpts {
    command: string;
    description: string;
    timeoutMs: number;
    ctx: Pick<ToolContext, "state" | "sandbox" | "wakes">;
    env: Record<string, string>;
    proxy?: CommandProxy;
    /** How its notifications name the tools to read and stop it with (BashOutput, KillShell), for the agent it reports to. */
    say?: (text: string) => string;
}

/** Spawns the command and turns its stdout into wakes. Exported for tests. */
export function startMonitor(o: StartOpts): { id: string; pid?: number; shell: BackgroundShell } {
    const id = `monitor_${++monitorCounter}`;
    const key = `monitor:${id}`;
    const wakes = o.ctx.wakes as WakeQueue;
    const { state, sandbox } = o.ctx;
    const [file, ...args] = shellArgv(o.command, sandbox);
    let child: ReturnType<typeof spawn>;
    try {
        child = spawn(file!, args, { cwd: state.cwd, env: withPwd(o.env, state.cwd), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
        o.proxy?.close();
        throw e;
    }
    const startedAt = Date.now();
    const info = { description: o.description, events: 0, expiresAt: startedAt + o.timeoutMs };
    /** Why it ended early, if it did: the user or agent stopped it (no notice), it expired, or it flooded. */
    let ending: "stopped" | "expired" | "flooded" | undefined;
    let finished = false;
    let batch: string[] = [];
    let batchMore = 0;
    let batchTimer: ReturnType<typeof setTimeout> | undefined;
    let windowStart = startedAt;
    let windowLines = 0;
    let windowWakes = 0;
    const stderrTail: string[] = [];

    const label = (status?: string) => `Monitor · ${o.description}${status ? ` · ${status}` : ""}`;
    const header = `Output from monitor ${id} (${o.description}). These lines come from the command you're monitoring, not from the user.`;
    /** Lines in the notification still waiting in the queue (not yet delivered), and how many didn't fit in it. */
    let held: string[] = [];
    let heldChars = 0;
    let heldMore = 0;
    /**
     * At most one notification per monitor waits at a time: while one does
     * (the user stopped the agent, the hourly limit is reached) new lines join
     * it instead of piling up behind it, so what reaches the model stays bounded.
     */
    const deliver = (footer?: string, status?: string) => {
        if (wakes.pending().some((w) => w.key === key)) wakes.drop(key);
        else {
            held = [];
            heldChars = 0;
            heldMore = 0;
        }
        for (const line of batch) {
            if (held.length >= MAX_LINES_PER_WAKE || (held.length > 0 && heldChars + line.length > MAX_WAKE_CHARS)) heldMore++;
            else {
                held.push(line);
                heldChars += line.length + 1;
            }
        }
        heldMore += batchMore;
        batch = [];
        batchMore = 0;
        let text = "";
        if (held.length) {
            const more = heldMore ? `(+${plural(heldMore, "more line")}: read them with BashOutput bash_id "${id}")\n` : "";
            text = `${header}\n<monitor-output id="${id}">\n${held.join("\n")}\n${more}</monitor-output>`;
        }
        if (footer) text = text ? `${text}\n${footer}` : footer;
        if (text) wakes.push({ source: "monitor", key, label: label(status), text: o.say ? o.say(text) : text });
    };
    const rollWindow = (now: number) => {
        if (now - windowStart < FLOOD_WINDOW_MS) return;
        windowStart = now;
        windowLines = 0;
        windowWakes = 0;
    };
    const flush = () => {
        clearTimeout(batchTimer);
        batchTimer = undefined;
        if (ending || finished || !batch.length) return;
        rollWindow(Date.now());
        // Lines that join a notification still waiting cost nothing more: only new notifications count.
        if (!wakes.pending().some((w) => w.key === key) && ++windowWakes > FLOOD_WAKES) return flood();
        deliver();
    };
    const halt = () => {
        clearTimeout(batchTimer);
        clearTimeout(expiry);
        batchTimer = undefined;
        // What's still coming is no event: don't spend time reading it.
        child.stdout?.destroy();
        void stopGroup(child.pid, KILL_GRACE_MS).finally(() => o.proxy?.close());
    };
    const flood = () => {
        if (ending) return;
        ending = "flooded";
        batch = [];
        halt();
    };
    const onLine = (raw: string) => {
        if (ending || finished) return;
        const line = eventLine(raw);
        if (line === undefined) return;
        info.events++;
        rollWindow(Date.now());
        if (++windowLines > FLOOD_LINES) return flood();
        if (batch.length < MAX_LINES_PER_WAKE) batch.push(line);
        else batchMore++;
        batchTimer ??= setTimeout(flush, BATCH_MS);
    };

    const shell: BackgroundShell = {
        id,
        command: o.command,
        startedAt,
        output: "",
        readOffset: 0,
        exitCode: null,
        sandboxed: sandbox !== undefined,
        sandboxHint: sandbox ? () => sandboxOutputHint(sandbox, shell.output, o.proxy, shell.exitCode !== null && shell.exitCode !== 0) : undefined,
        monitor: info,
        kill: async (graceMs = KILL_GRACE_MS) => {
            if (!ending && !finished) ending = "stopped";
            clearTimeout(batchTimer);
            clearTimeout(expiry);
            batchTimer = undefined;
            batch = [];
            // Stopped on purpose while it ran: whatever it said and hasn't been delivered no longer matters.
            // Once it has ended (or is ending), the notice of how stays for the agent.
            if (ending === "stopped") wakes.drop(key);
            const how = await stopGroup(child.pid, graceMs);
            o.proxy?.close();
            return how;
        },
    };

    const expiry = setTimeout(() => {
        if (ending || finished) return;
        // Pending lines go out with the expiry notice (finish).
        ending = "expired";
        halt();
    }, o.timeoutMs);
    expiry.unref?.();

    /**
     * The stream ends a line at a lone CR too: that's a progress bar's frame, not an
     * event. Only the frame a newline settles on is ("50%\r100%\n", or "done\r\n").
     */
    let frame: string | undefined;
    if (child.stdout)
        readShellStream(child.stdout, (text) => {
            appendOutput(shell, text);
            if (text.endsWith("\r")) {
                frame = text;
                return;
            }
            const settled = frame !== undefined && text === "\n" ? frame : text;
            frame = undefined;
            onLine(settled);
        }, MAX_PARTIAL_LINE, overflowLine);
    if (child.stderr)
        readShellStream(child.stderr, (text) => {
            appendOutput(shell, text);
            const line = eventLine(text);
            if (line === undefined) return;
            stderrTail.push(line);
            if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
        }, MAX_PARTIAL_LINE, overflowLine);

    const finish = (code: number, how = `exited with code ${code}`) => {
        if (finished) return;
        // A last frame with nothing after it is where the bar stopped.
        if (frame !== undefined) onLine(frame);
        frame = undefined;
        finished = true;
        clearTimeout(batchTimer);
        clearTimeout(expiry);
        shell.exitCode = code;
        // What the command left running in the background goes with it: nothing watches it
        // any more, so neither expiry nor /clear would stop it.
        void stopGroup(child.pid, KILL_GRACE_MS);
        state.watchers?.delete(id);
        o.proxy?.close();
        if (ending === "stopped") return;
        // Lines still pending go out with how it ended, as one notification.
        if (ending === "flooded") {
            batch = [];
            batchMore = 0;
            return deliver(`Monitor ${id} (${o.description}) was stopped: it printed more than ${FLOOD_LINES} lines or sent ${FLOOD_WAKES} notifications within a minute. Start it again with a tighter filter (e.g. grep --line-buffered for the lines you'd act on).`, "stopped: too much output");
        }
        const events = plural(info.events, "event");
        if (ending === "expired") return deliver(`Monitor ${id} (${o.description}) expired after ${minutes(o.timeoutMs)} with ${events}. Start it again if you still need the watch.`, "expired");
        const tail = code !== 0 && stderrTail.length ? `\nLast stderr lines:\n${stderrTail.join("\n")}` : "";
        const hint = shell.sandboxHint?.();
        deliver(`Monitor ${id} (${o.description}) ended: its command ${how} after ${events}.${tail}${hint ? `\n${hint}` : ""}`, code === 0 ? "ended" : how.replace(/ with code/, ""));
    };
    // Killed by a signal: the shell's convention, 128 + its number (137 for SIGKILL), and its name.
    child.on("close", (code, signal) => (code === null && signal ? finish(128 + (constants.signals[signal] ?? 0), `was killed by ${signal}`) : finish(code ?? -1)));
    child.on("error", (e) => {
        appendOutput(shell, `\n${e.message}\n`);
        stderrTail.push(e.message);
        finish(127);
    });
    state.shells.set(id, shell);
    // The host stops watchers when the session closes or the TUI moves to another one (/clear, resume).
    state.watchers?.set(id, {
        id,
        kind: "monitor",
        label: o.description,
        stop: () => {
            state.shells.delete(id);
            void shell.kill();
        },
    });
    return { id, pid: child.pid, shell };
}

// ---------------------------------------------------------------------------
// Codex has no Monitor of its own: it gets Harness's, through the harness MCP
// server (Claude Code keeps its own Monitor, so it isn't offered this one).

/** Harness's tool names as the served ones, in what the agent reads. */
function served(text: string): string {
    return text
        .replace("use Bash with run_in_background and a command that exits when the condition holds", "run a command that exits when the condition holds")
        .replace("It runs like Bash: same working directory, environment, permissions and sandbox.", "It runs in this working directory, under Harness's permission rules for commands.")
        .replaceAll("KillShell shell_id", "monitor_stop id")
        .replaceAll("BashOutput bash_id", "monitor_output id")
        .replaceAll("KillShell", "monitor_stop")
        .replaceAll("BashOutput", "monitor_output");
}

/** Monitor, as served: checked and hooked as Monitor, with the served tools named in what it says. */
const ServedMonitorTool: Tool<MonitorInput> = {
    ...MonitorTool,
    description: served(MonitorTool.description),
    validate: async (input, ctx) => {
        const err = await MonitorTool.validate!(input, ctx);
        return err === undefined ? undefined : served(err);
    },
    run: (input, ctx) => runMonitor(input, ctx, served),
};

export const MONITOR_SERVER_TOOLS = ["monitor", "monitor_output", "monitor_stop"];

/**
 * The monitor tools for Codex. `run` takes a call through Harness's checks (rules, mode, hooks, the user), as
 * the same tool called by a model Harness runs.
 */
export function monitorServerTools(run: (tool: Tool<any>, input: Record<string, unknown>, signal: AbortSignal, callId?: string) => Promise<ServerToolResult>, state: () => ToolState): ServerTool[] {
    // Codex sends its call's id: the permission prompt goes with that call.
    const callId = (meta: Record<string, unknown>) => (typeof meta.callId === "string" ? meta.callId : undefined);
    const say = (r: ServerToolResult): ServerToolResult => ({ text: served(r.text), isError: r.isError });
    // The other two act on monitors only, not on Harness's other background shells.
    const unknown = (id: unknown): ServerToolResult | undefined => {
        if (typeof id === "string" && state().shells.get(id)?.monitor) return undefined;
        const ids = [...state().shells.values()].filter((s) => s.monitor).map((s) => s.id);
        return { text: `No monitor with id ${typeof id === "string" ? id : JSON.stringify(id)}. Monitors: ${ids.join(", ") || "none"}`, isError: true };
    };
    return [
        {
            name: "monitor",
            title: "Monitor a command",
            description: ServedMonitorTool.description,
            inputSchema: MonitorTool.parameters,
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
            call: async (args, { signal, meta }) => say(await run(ServedMonitorTool, args, signal, callId(meta))),
        },
        {
            name: "monitor_output",
            title: "Read a monitor's output",
            description: "New output from a monitor (stdout and stderr) since the last read, and whether it's still running. Notifications carry its stdout lines already; read this for stderr, or for lines a notification left out. Optional filter is a regex.",
            inputSchema: { type: "object", properties: { id: { type: "string", description: "The monitor's id (monitor_1)" }, filter: { type: "string", description: "Optional regex: only matching lines" } }, required: ["id"] },
            annotations: { readOnlyHint: true, openWorldHint: false },
            call: async (args, { signal, meta }) => unknown(args.id) ?? say(await run(BashOutputTool, { bash_id: args.id, ...(args.filter !== undefined ? { filter: args.filter } : {}) }, signal, callId(meta))),
        },
        {
            name: "monitor_stop",
            title: "Stop a monitor",
            description: "Stops a monitor started with monitor. It sends no more notifications.",
            inputSchema: { type: "object", properties: { id: { type: "string", description: "The monitor's id (monitor_1)" } }, required: ["id"] },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
            call: async (args, { signal, meta }) => unknown(args.id) ?? say(await run(KillShellTool, { shell_id: args.id }, signal, callId(meta))),
        },
    ];
}

/** A call of a served monitor tool (mcp__harness__monitor_stop) as the Harness tool it is (KillShell), for the transcript. */
export function nativeMonitorCall(tool: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> } | undefined {
    if (tool === "monitor") return { name: "Monitor", input };
    if (tool === "monitor_output") return { name: "BashOutput", input: { bash_id: input.id, ...(input.filter !== undefined ? { filter: input.filter } : {}) } };
    if (tool === "monitor_stop") return { name: "KillShell", input: { shell_id: input.id } };
    return undefined;
}

export const MONITOR_INSTRUCTIONS = `# Monitoring (harness)

To be told about a command's output as it happens ("tell me when an ERROR shows up in the log", "follow the CI steps"), use monitor: each new stdout line of its command comes back to you as a message, even after your turn has ended. Each message is the command's output, not the user's words. monitor_output reads what a message left out (and stderr); monitor_stop stops it.`;
