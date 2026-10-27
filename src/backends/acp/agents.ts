// What differs between ACP agents beyond their def (src/backends/defs.ts): how a
// process is started for Cavvy (the environment that makes it ask), how its
// models are listed, how its own plan mode is set, and what its tool calls say
// of themselves. Everything else is src/backends/acp/connection.ts, shared.

import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { isReadOnlyCommand } from "../../permissions/bash-safety";
import type { PermissionMode } from "../../permissions/modes";
import type { Usage } from "../../providers/types";
import { canonical } from "../../util/files";
import { cliMessage, runCli } from "../cli";
import type { SpawnConfig } from "../live/types";

export interface AcpAgent {
    /** Arguments after the def's acpArgs, and environment, for a process: only what's fixed for its life. */
    spawn(cfg: SpawnConfig): { args: string[]; env: Record<string, string> };
    /** Its models' ids (passed to it verbatim), without opening a session (which would land in its history). */
    listModels(bin: string, signal?: AbortSignal): Promise<{ id: string; name?: string }[]>;
    /**
     * Whether it's signed in, without reading its sign-in (its own status command). Left out: it's signed in when it
     * starts and answers initialize.
     */
    status?(bin: string, signal?: AbortSignal): Promise<{ signedIn: boolean; description: string }>;
    /**
     * Its own plan mode, set to `plan` in Cavvy's plan mode and back to `normal` outside it: a config option
     * (`configId`), or its session mode (session/set_mode) when there's none.
     */
    planMode?: { configId?: string; plan: string; normal: string };
    /**
     * What a session is opened with in a mode (session/new, resume and load's `_meta`), for what it takes only then.
     * A mode that needs another restarts the process, which resumes the same session with it.
     */
    sessionMeta?(mode: PermissionMode): Record<string, unknown> | undefined;
    /** A tool call it says only reads, so it needn't have asked first (the tripwire skips it). `sessionId`: its session's. */
    readOnly?(toolCall: Record<string, any>, sessionId?: string): boolean;
    /**
     * What a change it made without asking does in each of Cavvy's modes (the tripwire): stops the turn, is noted in
     * the transcript, or nothing. Default: stops it, in all but bypassPermissions.
     */
    tripwire?(mode: PermissionMode): "stop" | "notice" | undefined;
    /** A turn's tokens, from its prompt's answer, where they aren't ACP's `usage` (and its context then, if it says). */
    usage?(result: any): { usage: Usage; contextTokens?: number } | undefined;
    /** What one of its own notifications (not session/update) during a turn says to the user, if anything. */
    notice?(method: string, params: any): string | undefined;
    /**
     * How a message joins its running prompt (CliConnection.steer), when not as a second session/prompt: OpenCode
     * folds that into the running one at its next step, answering both together; Grok would queue it to run after.
     */
    interject?: Interject;
    /**
     * A gate it runs before every tool call, which Cavvy registers when it opens a session and answers by its own
     * rules and mode (Grok's client PreToolUse hook). Left out: what it asks about (session/request_permission) is all.
     */
    gate?: AcpGate;
}

/** A tool call the agent's gate holds until Cavvy answers (AcpGate). */
export interface GateCall {
    /** The session it runs in: the one Cavvy opened, or one of its subagents'. */
    sessionId: string;
    /** Its tool_call's toolCallId. */
    toolUseId: string;
    /** The agent's own name for the tool. */
    toolName: string;
    input: Record<string, any>;
    /** Long strings in `input` were cut (each ends in GATE_CUT). */
    truncated: boolean;
    /** The folder it runs in, when it says. */
    cwd?: string;
    /** Run by one of its subagents, of this type. */
    subagentType?: string;
}

/** A gated call as one of Cavvy's tools, in permissionFor's (connection.ts) conventions. */
export interface GateTool {
    toolName: string;
    input: Record<string, unknown>;
    title?: string;
    /** Why it's asked about (shown in the prompt). */
    reason?: string;
    /** It can't be checked (what decides it was cut): refused with this. */
    refuse?: string;
    /** It runs somewhere else than the session's folder: always asked about. */
    elsewhere?: boolean;
    /** One of the agent's own that only reads or keeps its own state (its to-do list, its plan mode): let go. */
    free?: boolean;
}

export interface AcpGate {
    /** The agent's request that holds a tool call until Cavvy answers. */
    method: string;
    /**
     * Seconds it waits for an answer before it goes on without one (it fails open). Cavvy answers well before
     * (gateDeadlineMs). Settable for tests.
     */
    timeoutS: number;
    /** What registers it: in session/new, resume and load's `_meta`, in every mode. */
    register(): Record<string, unknown>;
    /** The call a request holds. Undefined: none (another hook event), let go. Throws when it can't be read. */
    call(params: any): GateCall | undefined;
    /** The call a permission request (its toolCall) asks about, as the gate holds one: to tell it's the one the gate let go. */
    asked?(toolCall: any): GateCall | undefined;
    /** It as Cavvy's tool; undefined for one of its own Cavvy has no tool for (checked by the agent's name). */
    tool(call: GateCall, cwd: string): GateTool | undefined;
    /** Answers: go on as it would (its own permission flow follows), or refuse with a reason the model reads. */
    allow(): Record<string, unknown>;
    deny(reason: string): Record<string, unknown>;
    /** One of its notifications saying a subagent started: the subagent's session, and what its asks are labelled. */
    subagent?(method: string, params: any): { sessionId: string; label: string } | undefined;
    /** A file Cavvy's plan mode lets it write (its plan file). `sessionId`: the session Cavvy opened. */
    planFile?(path: string, sessionId: string | undefined): boolean;
}

/** How long Cavvy takes at most to answer a gate: 15 s before the agent would give up and go on, or half its wait. */
export function gateDeadlineMs(timeoutS: number): number {
    return Math.max(timeoutS * 500, (timeoutS - 15) * 1000);
}

/** The tag that ends a string cut from a hook's input (Grok's hooks guide: "Input"). */
export const GATE_CUT = "[truncated]";

/** A message sent into a running prompt by a request of the agent's own, which takes text only. */
export interface Interject {
    /** The request: text into the session's running prompt. */
    request(sessionId: string, text: string): { method: string; params: Record<string, unknown> };
    /**
     * One that reaches it once nothing runs runs as a prompt of its own, which no session/prompt answers: a
     * notification that says a prompt started running (its id and text).
     */
    started(method: string, params: any): { id: string; text: string } | undefined;
    /** A notification that says a prompt ended: its id, and an answer as session/prompt's would be (its stop reason and tokens). */
    ended(method: string, params: any): { id: string; answer: any } | undefined;
    /** How long, after the turn's prompt answers, to watch for one it started so (a steer that came as it was ending). */
    graceMs: number;
    /**
     * Its own record of the session, which says what it took. `size`: where it ends now (undefined: there's none).
     * `taken`: the texts it took in the prompt `promptId` from `since` on (unknown: in the last it says ended, and
     * after), and whether it says that prompt `ended`: until then, those it says so far. Throws when it can't be read.
     */
    record?: { size(sessionId: string): number | undefined; taken(sessionId: string, since: number, promptId?: string): { texts: string[]; ended: boolean } };
}

/** OpenCode's permission keys: asked about, or allowed (they only read, or keep its to-do list). */
const OPENCODE_ASK = ["*", "edit", "bash", "webfetch", "websearch", "external_directory", "task"] as const;
const OPENCODE_ALLOW = ["read", "glob", "grep", "list", "todowrite", "todoread"] as const;
/** Its own agents a session runs as, or hands work to. */
const OPENCODE_AGENTS = ["build", "general", "explore"] as const;

/**
 * What makes OpenCode ask Cavvy before it edits, runs a command, fetches or goes outside the folder: by default it
 * asks about nothing (opencode-1.19.4-default-noask.jsonl). Verified on OpenCode 1.19.4
 * (opencode-1.19.4-precedence-*.jsonl, and `opencode agent list`):
 * - OPENCODE_CONFIG_CONTENT's keys beat the same keys in a user's or project's config set to allow.
 * - Permission objects merge by key, each keeping the place of the first layer that named it, and the last
 *   matching rule wins: so a user's allow for a key not named here (`"mymcp_*": "allow"`) would stand. The same
 *   set again under each agent comes after every global rule, so its `*` wins there. A user's own
 *   `agent.<name>.permission` allows can still win; the tripwire stops a turn where one did.
 * - Under the plan agent, a global ask would turn its built-in edit deny into an ask: its deny goes after the set.
 *   Its plan files are asked about (OpenCode allows them), so Cavvy's plan mode decides those too.
 * - OPENCODE_DISABLE_PROJECT_CONFIG=1 keeps the project's opencode.json out: in a folder the user hasn't trusted.
 */
export function opencodeEnv(trusted: boolean): Record<string, string> {
    const set: Record<string, unknown> = Object.fromEntries([...OPENCODE_ASK.map((k) => [k, "ask"]), ...OPENCODE_ALLOW.map((k) => [k, "allow"])]);
    const { edit: _, ...rest } = set;
    const agent: Record<string, unknown> = Object.fromEntries(OPENCODE_AGENTS.map((a) => [a, { permission: set }]));
    agent.plan = { permission: { ...rest, edit: { "*": "deny", ".opencode/plans/*.md": "ask" } } };
    return {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: set, agent }),
        ...(trusted ? {} : { OPENCODE_DISABLE_PROJECT_CONFIG: "1" }),
    };
}

const OPENCODE: AcpAgent = {
    // The same in every mode: a mode change needs no restart. Cavvy decides each ask by its mode then.
    spawn: (cfg) => ({ args: ["--cwd", cfg.cwd], env: opencodeEnv(cfg.trusted) }),
    // `opencode models`: provider/model, one a line (about half a second).
    async listModels(bin, signal) {
        const r = await runCli(bin, ["models"], { signal, timeoutMs: 30_000 });
        if (r.code !== 0) throw new Error(`opencode models failed: ${r.stderr.trim().split("\n").pop() ?? `exit code ${r.code}`}`);
        return r.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => /^[\w.-]+\/\S+$/.test(l))
            .map((id) => ({ id }));
    },
    planMode: { configId: "mode", plan: "plan", normal: "build" },
};

/** `grok models`: whether it's signed in (its first line), and its models (about a second and a half). */
async function grokModels(bin: string, signal?: AbortSignal): Promise<{ said: string; models: string[] }> {
    const r = await runCli(bin, ["models"], { signal, timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`grok models failed: ${cliMessage(r.stderr) || `exit code ${r.code}`}`);
    const lines = r.stdout.split("\n");
    // "You are logged in with grok.com." or "You are not authenticated.", then "  * grok-4.7 (default)", "  - grok-4.6".
    const said = lines.find((l) => l.trim())?.trim() ?? "";
    const models = lines.flatMap((l) => l.match(/^\s*[*-]\s+([\w.:/-]+)/)?.[1] ?? []);
    return { said, models };
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

const grokHome = () => (process.env.GROK_HOME ? resolve(process.env.GROK_HOME) : join(homedir(), ".grok"));

/**
 * Grok's plan file for the session: <GROK_HOME>/sessions/<its folder for the cwd>/<session id>/plan.md, GROK_HOME
 * ~/.grok by default (grok-1.0.70-plan-mode.jsonl). As the path is spelled (`.` and `..` resolved, not symlinks),
 * and where it leads is that file: a link elsewhere to it (a git hook, say) isn't, nor is one there that leads out.
 */
function grokPlanFile(path: string, sessionId: string | undefined): boolean {
    if (!sessionId || !isAbsolute(path)) return false;
    const sessions = join(grokHome(), "sessions");
    const real = canonical(sessions);
    const shaped = (rel: string[]) => rel.length === 3 && rel[0] !== ".." && rel[1] === sessionId && rel[2] === "plan.md";
    // Its home may be spelled through a link (GROK_HOME in /tmp on macOS): either spelling of it.
    const rel = [sessions, real].map((d) => relative(d, resolve(path)).split(sep)).find(shaped);
    return rel !== undefined && canonical(path) === join(real, ...rel);
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/**
 * Grok's record of a session, <GROK_HOME>/sessions/<its folder for the cwd>/<id>/updates.jsonl: found by the id, as
 * the folder is the cwd as given (links not resolved), encoded its own way (grok-1.0.70-steer-file.jsonl).
 */
function grokRecord(sessionId: string): string | undefined {
    // Grok resolves a relative one against its own cwd, not Cavvy's.
    if (process.env.GROK_HOME && !isAbsolute(process.env.GROK_HOME)) throw new Error("GROK_HOME is relative");
    const root = join(grokHome(), "sessions");
    const dir = /^[\w-]+$/.test(sessionId) && existsSync(root) ? readdirSync(root).find((d) => existsSync(join(root, d, sessionId))) : undefined;
    if (!dir) return undefined;
    // Where it leads is that file, as grokPlanFile's: not out of the sessions folder through a link.
    const file = join(root, dir, sessionId, "updates.jsonl");
    if (canonical(file) !== join(canonical(root), dir, sessionId, "updates.jsonl")) throw new Error("its record leads out of its sessions folder");
    return file;
}

/**
 * An interjection it took is a user_message_chunk with _meta.interjection in its record, and a prompt's end its
 * turn_completed, written after (grok-1.0.70-steer-marker.jsonl): some 35 ms after a cancelled prompt's answer.
 */
const GROK_RECORD: NonNullable<Interject["record"]> = {
    size(sessionId) {
        const file = grokRecord(sessionId);
        return file === undefined ? undefined : existsSync(file) ? statSync(file).size : 0;
    },
    taken(sessionId, since, promptId) {
        const file = grokRecord(sessionId);
        if (!file) throw new Error("no record of the session");
        // Not blocked on a FIFO with no writer.
        const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
        const from = Math.max(0, since - 1);
        let text: string;
        try {
            const st = fstatSync(fd);
            if (!st.isFile()) throw new Error("its record isn't a file");
            const size = st.size;
            if (size < since || size - from > 32 << 20) throw new Error(`its record is ${size} bytes, the turn's from ${since}`);
            const buf = Buffer.alloc(size - from);
            readSync(fd, buf, 0, buf.length, from);
            text = buf.toString("utf8");
        } finally {
            closeSync(fd);
        }
        // From the turn's first whole line, to the last (one being written has no newline yet).
        const lines = (since > 0 ? text.slice(text.indexOf("\n") + 1) : text).split("\n").slice(0, -1);
        let taken: string[] = [];
        let last: string[] = [];
        for (const line of lines) {
            const u = line.trim() ? JSON.parse(line)?.params?.update : undefined;
            if (u?.sessionUpdate === "turn_completed") {
                if (promptId && u.prompt_id === promptId) return { texts: taken, ended: true };
                // Another prompt's end: what came before was its, but for the last one's with no id to tell.
                [last, taken] = [taken, []];
            } else if (u?.sessionUpdate === "user_message_chunk" && u._meta?.interjection === true) {
                const t = u.content?._meta?.displayText ?? String(u.content?.text ?? "").match(/<user_query>\n([\s\S]*?)\n<\/user_query>/)?.[1];
                if (typeof t !== "string") throw new Error("an interjection without its text");
                taken.push(t);
            }
        }
        return { texts: promptId ? taken : [...last, ...taken], ended: false };
    },
};

/**
 * Grok's client PreToolUse hook (Grok Build 1.0.70: scripts/probes/acp-grok-hooks.ts,
 * test/fixtures/protocol/grok-1.0.70-hook-*.jsonl). Registered in session/new or resume's
 * `_meta["x.ai/hooks"]`, it sends `_x.ai/hooks/run` before every tool call, read-only ones too, its subagents' too
 * (with their own sessionId and subagentType), in every one of its modes: ~30 ms after the call's pending tool_call,
 * with toolUseId its toolCallId. `{}` lets the call go on through its own permission flow (in its default mode, a
 * session/request_permission for it follows); `{decision: "deny", reason}` fails it, and the model reads the reason.
 * It waits `timeout` seconds (30 by default; `timeoutS` it ignores), then goes on: so does a reply it can't read.
 */
const GROK_GATE: AcpGate = {
    method: "_x.ai/hooks/run",
    // Its documented longest.
    timeoutS: 600,
    register() {
        return { "x.ai/hooks": { PreToolUse: [{ matcher: "*", hookCallbackIds: ["cavvy-gate"], timeout: this.timeoutS, timeoutS: this.timeoutS }] } };
    },
    call(p) {
        if (!p || typeof p !== "object") throw new Error("no parameters");
        // Only PreToolUse is registered; anything that names a tool is held, whatever the event says.
        if (p.toolName === undefined && p.hookEventName !== "pre_tool_use") return undefined;
        if (typeof p.toolName !== "string" || !p.toolName) throw new Error("no tool name");
        if (typeof p.sessionId !== "string" || !p.sessionId) throw new Error("no session");
        const input = p.toolInput && typeof p.toolInput === "object" && !Array.isArray(p.toolInput) ? p.toolInput : {};
        return {
            sessionId: p.sessionId,
            toolUseId: typeof p.toolUseId === "string" ? p.toolUseId : "",
            toolName: p.toolName,
            input,
            // Anything but a plain false: maybe cut.
            truncated: p.toolInputTruncated !== false,
            ...(str(p.cwd) && isAbsolute(p.cwd) ? { cwd: p.cwd } : {}),
            ...(str(p.subagentType) ? { subagentType: p.subagentType } : {}),
        };
    },
    // Its ask names its tool in _meta, and has the hook's input with the variant its updates add.
    asked(t) {
        const name = t?._meta?.["x.ai/tool"]?.name;
        if (!str(name) || !t.rawInput || typeof t.rawInput !== "object") return undefined;
        const { variant: _, ...input } = t.rawInput;
        return { sessionId: str(t._meta["x.ai/requestingSessionId"]) ?? "", toolUseId: str(t.toolCallId) ?? "", toolName: name, input, truncated: false };
    },
    tool: grokTool,
    allow: () => ({}),
    // `{decision: "allow"}` would be an unknown decision to it (logged, and let go): `{}` allows.
    deny: (reason) => ({ decision: "deny", reason }),
    // _x.ai/session_notification subagent_spawned, from the session that started it, before the subagent's first call.
    subagent(method, p) {
        const u = p?.update;
        if (method !== "_x.ai/session_notification" || u?.sessionUpdate !== "subagent_spawned" || !str(u.child_session_id)) return undefined;
        return { sessionId: u.child_session_id, label: str(u.description) ?? str(u.subagent_type) ?? "Grok subagent" };
    },
    planFile: grokPlanFile,
};

/**
 * A call Grok's gate holds, as Cavvy's tool (its names: the hooks guide's alias table, ~/.grok/docs/user-guide/10-hooks.md,
 * and the tool list in its available_commands_update's _meta). Any other (scheduler_create, monitor, workflow,
 * image_gen, ...) is checked as the agent's own tool: asked about in Manual, refused in Plan.
 * Paths are made absolute against the folder it runs in. A string Grok cut (only one over 4 KiB is) can't be checked
 * where it decides: refused; where it's only shown (an edit's text), the call is checked by its path alone.
 */
function grokTool(call: GateCall, cwd: string): GateTool | undefined {
    const i = call.input;
    const here = call.cwd ?? cwd;
    const at = (p: string) => (isAbsolute(p) ? p : resolve(here, p));
    const cut = (v: unknown) => call.truncated && typeof v === "string" && v.endsWith(GATE_CUT);
    const path = (...keys: string[]) => keys.map((k) => str(i[k])).find(Boolean);
    const tooLong = (what: string): GateTool => ({ toolName: "", input: {}, refuse: `${what} is too long for Cavvy to check in full. Do it in smaller steps.` });
    switch (call.toolName) {
        case "run_terminal_command": {
            const command = str(i.command);
            if (!command) return undefined;
            if (cut(command)) return tooLong("The command");
            // Run in another folder than Cavvy's (a subagent's own cwd, a worktree): Cavvy's checks assume its own.
            const elsewhere = Boolean(call.cwd && canonical(call.cwd) !== canonical(cwd));
            return { toolName: "Bash", input: { command, ...(str(i.description) && !cut(i.description) ? { description: i.description } : {}) }, ...(elsewhere ? { elsewhere, reason: `It runs in ${call.cwd}.` } : {}) };
        }
        case "write": {
            const file = path("file_path", "path");
            if (!file) return undefined;
            if (cut(file)) return tooLong("The path");
            // Its whole new content: the yes covers that content only.
            if (typeof i.content === "string" && !cut(i.content)) return { toolName: "Write", input: { file_path: at(file), content: i.content } };
            // Still a Write (Write rules cover it), checked by its path.
            return { toolName: "Write", input: { file_path: at(file) }, reason: "Its new content is too long to show here." };
        }
        case "search_replace":
        case "hashline_edit": {
            const file = path("file_path", "path", "target_file");
            if (!file) return undefined;
            if (cut(file)) return tooLong("The path");
            const strings = typeof i.old_string === "string" && typeof i.new_string === "string" && !cut(i.old_string) && !cut(i.new_string);
            if (call.toolName === "search_replace" && strings) return { toolName: "Edit", input: { file_path: at(file), old_string: i.old_string, new_string: i.new_string, ...(i.replace_all === true ? { replace_all: true } : {}) } };
            return { toolName: "Edit", input: { file_path: at(file) } };
        }
        case "read_file": {
            const file = path("target_file", "file_path", "path");
            if (!file) return undefined;
            return cut(file) ? tooLong("The path") : { toolName: "Read", input: { file_path: at(file) } };
        }
        case "list_dir": {
            const dir = path("target_directory", "path", "directory", "dir") ?? ".";
            return cut(dir) ? tooLong("The path") : { toolName: "LS", input: { path: at(dir) } };
        }
        case "grep": {
            const pattern = path("pattern", "query", "regex");
            if (!pattern) return undefined;
            const dir = path("path", "target_directory", "directory");
            if (cut(pattern) || cut(dir)) return tooLong("The search");
            return { toolName: "Grep", input: { pattern, ...(dir ? { path: at(dir) } : {}) } };
        }
        case "web_search": {
            const query = path("query", "search_term");
            return query ? { toolName: "WebSearch", input: { query } } : undefined;
        }
        case "web_fetch": {
            const url = path("url");
            if (!url) return undefined;
            return cut(url) ? tooLong("The address") : { toolName: "WebFetch", input: { url } };
        }
        // Its own bookkeeping: its to-do list, a look at its tools, at a command or subagent of its own (or stopping
        // one), its schedules, a question for the user, its plan mode (Cavvy's plan mode follows Cavvy's).
        case "todo_write":
        case "search_tool":
        case "get_command_or_subagent_output":
        case "kill_command_or_subagent":
        case "scheduler_list":
        case "ask_user_question":
        case "enter_plan_mode":
        case "exit_plan_mode":
            return { toolName: call.toolName, input: i, free: true };
        case "spawn_subagent":
            // Its subagent's calls come through the gate too, each decided as they come.
            return { toolName: "Task", input: { description: str(i.description) ?? "subagent", prompt: typeof i.prompt === "string" ? i.prompt : "", subagent_type: str(i.subagent_type) ?? str(i.agent_type) ?? "general-purpose" } };
    }
    // An MCP server's tool, <server>__<tool>: Cavvy's rules name it mcp__<server>__<tool>.
    if (/^[\w-]+__[\w-]+$/.test(call.toolName) && !call.toolName.startsWith("mcp__")) return { toolName: `mcp__${call.toolName}`, input: i };
    return undefined;
}

/**
 * Grok Build 1.0.70 (`grok agent --no-leader stdio`): test/fixtures/protocol/grok-1.0.70-*.jsonl. Its own permission
 * settings (and the user's Claude Code ones, which it reads) can't be overridden from here: Cavvy's gate (GROK_GATE)
 * holds every call it makes until Cavvy's rules and mode decide it. Cavvy's mode also picks Grok's: plan its plan
 * mode, auto its auto reviewer (the gate lets everything go), any other its default mode.
 */
const GROK: AcpAgent = {
    spawn: () => ({ args: [], env: {} }),
    async listModels(bin, signal) {
        return (await grokModels(bin, signal)).models.map((id) => ({ id }));
    },
    async status(bin, signal) {
        const { said } = await grokModels(bin, signal);
        // Signed out it says "You are not authenticated." (with an empty GROK_HOME), and session/new answers -32000.
        if (/not (authenticated|logged in|signed in)/i.test(said)) return { signedIn: false, description: "not signed in" };
        const m = said.match(/logged in with (.+?)\.?$/i);
        return { signedIn: true, description: m ? `signed in with ${m[1]}` : said || "signed in" };
    },
    // session/set_mode plan and default (grok-1.0.70-controls.jsonl). Plan mode lasts across session/resume
    // (grok-1.0.70-plan-resume.jsonl), so it's set on every session opened.
    planMode: { plan: "plan", normal: "default" },
    // Its auto reviewer, only when a session is opened: session/new or session/resume with _meta.autoMode
    // (grok-1.0.70-auto-new.jsonl, -auto-on-resume.jsonl). It doesn't last: a session resumed without it asks again
    // (-auto-off-resume.jsonl). set_mode "auto" does nothing (-plan-resume.jsonl). Cavvy's gate with every open, in
    // every mode: it lasts across set_mode, not into another process (grok-1.0.70-hook-resume*.jsonl).
    sessionMeta: (mode) => ({ ...GROK_GATE.register(), ...(mode === "auto" ? { autoMode: true } : {}) }),
    // Its read tools say read_only; its shell tool never does (`sleep` too), though it runs read-only commands
    // without asking. Nor does it ask about its own plan file in plan mode.
    readOnly: (t, sessionId) =>
        t._meta?.["x.ai/tool"]?.read_only === true ||
        (t.kind === "execute" && typeof t.rawInput?.command === "string" && isReadOnlyCommand(t.rawInput.command)) ||
        (t.kind === "edit" && typeof t.rawInput?.file_path === "string" && grokPlanFile(t.rawInput.file_path, sessionId)),
    // Every call goes through Cavvy's gate first, whatever its own settings (and the user's Claude Code ones) say.
    // One that ran with neither the gate nor an ask got past it: the turn stops. Not in auto (its reviewer decides,
    // the gate lets everything go) or bypass (anything goes).
    tripwire: (mode) => (mode === "auto" || mode === "bypassPermissions" ? undefined : "stop"),
    gate: GROK_GATE,
    // Its answer's _meta: the turn's total over its model calls (`usage`, input counting cache reads), and the last
    // call's context (totalTokens). costUsdTicks' unit isn't documented: no cost.
    usage(r) {
        const m = r?._meta;
        if (!m || typeof m !== "object") return undefined;
        const u = m.usage && typeof m.usage === "object" ? m.usage : m;
        const cached = n(u.cachedReadTokens);
        const written = n(u.cacheCreationTokens);
        const usage: Usage = { inputTokens: Math.max(0, n(u.inputTokens) - cached - written), outputTokens: n(u.outputTokens) };
        if (cached) usage.cacheReadTokens = cached;
        if (written) usage.cacheWriteTokens = written;
        if (n(u.reasoningTokens)) usage.reasoningTokens = n(u.reasoningTokens);
        return { usage, ...(n(m.totalTokens) ? { contextTokens: n(m.totalTokens) } : {}) };
    },
    // An image too small for it is dropped before it's sent (grok-1.0.70-image.jsonl).
    notice(method, p) {
        const u = p?.update;
        if (method !== "_x.ai/session_notification" || u?.sessionUpdate !== "image_dropped") return undefined;
        const notes = Array.isArray(u.notes) ? u.notes.filter((x: unknown) => typeof x === "string") : [];
        // "Image 1 was dropped before send: too small (16×16 = 256 px); images must have at least 512 total pixels."
        return notes.join(" ") || "Grok Build dropped an image it couldn't take.";
    },
    // A second session/prompt waits in its queue for the running one to end (grok-1.0.70-concurrent-prompt.jsonl).
    // _x.ai/interject joins the running one at its next step: after a tool, or once the answer being written is done,
    // with another model call (grok-1.0.70-steer.jsonl, -steer-late.jsonl). Its answer is {status: "queued"}, the
    // turn's prompt answers once for all of it, and a stop drops one not yet taken (-steer-cancel.jsonl). With
    // nothing running it starts a prompt of its own (-steer-params.jsonl): _x.ai/queue/changed names it running with
    // the text, and its turn_completed ends it. Nothing live says it took one: its own record does (GROK_RECORD), read
    // when a turn is stopped, once it says the prompt ended (a second at most), to hand back only what it didn't take.
    interject: {
        request: (sessionId, text) => ({ method: "_x.ai/interject", params: { sessionId, text } }),
        started: (method, p) => (method === "_x.ai/queue/changed" && typeof p?.runningPromptId === "string" && typeof p.runningText === "string" ? { id: p.runningPromptId, text: p.runningText } : undefined),
        ended(method, p) {
            const u = p?.update;
            if (method !== "_x.ai/session_notification" || u?.sessionUpdate !== "turn_completed" || typeof u.prompt_id !== "string") return undefined;
            return { id: u.prompt_id, answer: { stopReason: u.stop_reason, _meta: { usage: u.usage } } };
        },
        graceMs: 500,
        record: GROK_RECORD,
    },
};

const AGENTS: Record<string, AcpAgent> = { opencode: OPENCODE, grok: GROK };

export function acpAgent(id: string): AcpAgent {
    const a = AGENTS[id];
    if (!a) throw new Error(`No ACP agent ${id}`);
    return a;
}
