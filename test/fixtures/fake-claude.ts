// A stand-in for the `claude` CLI, speaking the parts of its stream-json
// protocol the harness uses: `auth status --json`, and `-p` with stream-json
// in and out (initialize, a turn with one tool call, interrupt,
// set_permission_mode, --resume). It makes no network requests.
//
// It decides like the real CLI (checked against Claude Code 2.1.300) what it
// does without asking: deny rules from --settings or the project's
// .claude/settings.json refuse, ask rules ask, reads inside the folder run,
// and in its own acceptEdits mode so do edits and file commands (rm, mv, …);
// everything else asks the host. Without --setting-sources excluding
// "project", it loads .claude/settings.json and runs its SessionStart hooks.
//
// Like Claude Code 2.1.301 (checked with stream-json probes), a result names
// the prompt it answers (user_message_uuid, from the user message's uuid); a
// turn Claude Code starts itself to pass on a background sub-agent's result
// has origin task-notification instead. A sub-agent in the background goes on
// after the turn's result: Claude Code lists what runs in the background
// (background_tasks_changed), says when the sub-agent is done
// (task_notification, with its usage), and takes one more turn with it.
//
// FAKE_LOG          each line: what it was started with, and what it received
// FAKE_LOGGED_IN=0  auth status says signed out
// FAKE_SCENARIO     write (default) | write-config | read-secret | rm | bash | leak | ask | plan | hang | write-hang | mcp | silent | agent | agent-background | agent-background-late | agent-background-stuck | agent-quiet | agent-waits | agent-renotified | agent-fails-later | agent-fails-then-reports | agent-hands-back-late
// FAKE_SECOND_SCENARIO  the scenario for its prompts after the first (default: the same)
// FAKE_BACKGROUND_MS  how long a background sub-agent goes on after the turn's result (default 300)
// FAKE_STALE_TASK=1   resumed, it first reports a background sub-agent of the earlier run as stopped, in a turn of its own with no model call (what Claude Code does for one killed with its process)
// FAKE_OLD_RESULTS=1  results don't say which prompt they answer (an older CLI)
// FAKE_LIST_FIRST=ms  a background sub-agent leaves Claude Code's background list this long before its task_notification (1: 200 ms)
// FAKE_LATE_TASK=ms   after a background sub-agent's notification, another background task is listed this long before the report turn
// FAKE_HOLD_STDOUT=1  starts a command that keeps its stdout open for a while after it exits
// FAKE_COMMAND      the "bash" scenario's command (default: npm test)
// FAKE_API_KEY_SOURCE  system/init apiKeySource (default "none": a plan)
// FAKE_IGNORE_STOP=1   ignores interrupt requests and SIGTERM
// FAKE_CRASH_ON_SECOND=1  exits without a result on its second prompt
// FAKE_MCP_CALLS     the "mcp" scenario's tool calls to servers from mcp_set_servers: [{ server?, tool, args }]
// FAKE_MCP_REFUSE=1  answers mcp_set_servers with an error, like a CLI without it
// FAKE_LOG_ENV=1     logs its whole environment at start
// FAKE_RATE_LIMIT    a JSON file: the rate_limit_info of a rate_limit_event sent after system/init
//                    (shapes from Claude Code 2.1.301, test/fixtures/limits); FAKE_RATE_LIMIT_LATE=1 sends it
//                    after the "rate-limit" scenario's error instead; FAKE_RATE_LIMIT_REPEAT=n sends it n times (as
//                    Claude Code sends one per request)
// FAKE_SCENARIO=rate-limit  the turn ends on the plan's limit (an assistant error "rate_limit", an error result)

import { appendFileSync, existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { callTool, connect, type McpServerRef } from "./mcp-call";

const log = (o: unknown) => {
    if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\n");
};
const argv = process.argv.slice(2);
const cwd = process.cwd();
log({ argv, cwd, sawApiKey: Boolean(process.env.ANTHROPIC_API_KEY), sawOpenAiKey: Boolean(process.env.OPENAI_API_KEY) });
if (process.env.FAKE_LOG_ENV === "1") log({ env: process.env });

if (argv[0] === "auth" && argv[1] === "status") {
    const on = process.env.FAKE_LOGGED_IN !== "0";
    console.log(JSON.stringify(on ? { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty", subscriptionType: "max" } : { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }));
    process.exit(on ? 0 : 1);
}
if (process.env.FAKE_IGNORE_STOP === "1") process.on("SIGTERM", () => log({ ignored: "SIGTERM" }));
// Something it starts that holds its output open after it exits (a command left running with its stdout).
if (process.env.FAKE_HOLD_STDOUT === "1") Bun.spawn(["sleep", "8"], { stdin: "ignore", stdout: "inherit", stderr: "ignore" }).unref();

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const resume = flag("--resume");
const firstScenario = process.env.FAKE_SCENARIO ?? "write";
// FAKE_GONE_ID: a session id (a real-looking UUID) that no longer exists.
if (resume?.startsWith("gone") || (resume && resume === process.env.FAKE_GONE_ID)) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, errors: [`No conversation found with session ID: ${resume}`], usage: {}, session_id: resume });
    process.exit(1);
}

// ---- configuration, as the real CLI loads it
let mode = flag("--permission-mode") ?? "default";
const sources = flag("--setting-sources");
const loadsProject = sources === undefined || sources.split(",").includes("project");
const projectFile = join(cwd, ".claude", "settings.json");
const project: any = loadsProject && existsSync(projectFile) ? JSON.parse(readFileSync(projectFile, "utf-8")) : {};
const fromFlag: any = flag("--settings") ? JSON.parse(flag("--settings")!).permissions ?? {} : {};
const deny: string[] = [...(fromFlag.deny ?? []), ...(project.permissions?.deny ?? [])];
const askRules: string[] = [...(fromFlag.ask ?? []), ...(project.permissions?.ask ?? [])];
const allow: string[] = project.permissions?.allow ?? [];
for (const h of project.hooks?.SessionStart ?? []) for (const c of h.hooks ?? []) Bun.spawnSync(["sh", "-c", c.command]);

/** Claude Code's rule matching, for the forms the harness passes: Tool, Tool(//abs/path[/**]), Bash(prefix:*). */
function ruleHits(rule: string, tool: string, input: any): boolean {
    const m = rule.match(/^(\w+)(?:\((.*)\))?$/);
    if (!m) return false;
    const [, rTool, spec] = m;
    const kind = ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool) ? "Edit" : ["Read", "Glob", "Grep"].includes(tool) ? "Read" : tool;
    if (rTool !== kind) return false;
    if (!spec) return true;
    if (kind === "Bash") return spec.endsWith(":*") ? String(input.command).startsWith(spec.slice(0, -2)) : input.command === spec;
    if (!spec.startsWith("//")) return false;
    // Like Claude Code (2.1.268 on), symlinks are resolved: in the rule's literal folders and in the path.
    const real = (p: string) => {
        try {
            return realpathSync(p);
        } catch {
            return p;
        }
    };
    const segs = spec.slice(1).split("/");
    const firstGlob = segs.findIndex((x) => /[*?]/.test(x));
    const lit = (firstGlob < 0 ? segs : segs.slice(0, firstGlob)).join("/");
    const pats = [spec.slice(1), [real(lit), ...(firstGlob < 0 ? [] : segs.slice(firstGlob))].join("/")];
    const path = String(input.file_path ?? "");
    return pats.some((pat) => [path, real(path)].some((p) => globMatch(pat, p)));
}

// gitignore-style: ** spans folders (followed by a slash, also none), * stays within one.
function globMatch(pat: string, path: string): boolean {
    const re = pat
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "\u0000")
        .replace(/\*\*/g, "\u0001")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, "(?:.*/)?")
        .replace(/\u0001/g, ".*");
    return new RegExp(`^${re}$`).test(path);
}

const inside = (p: unknown) => typeof p === "string" && p.startsWith(cwd + "/");
const FILE_COMMANDS = /^(rm|mv|cp|mkdir|touch|sed)\b/;

/** Whether it runs a call without asking the host, in its current mode. */
function selfApproved(tool: string, input: any): boolean {
    if (allow.some((r) => ruleHits(r, tool, input))) return true;
    if (tool === "Read" && inside(input.file_path)) return true;
    if (mode === "bypassPermissions") return true;
    if (mode === "acceptEdits") {
        if (["Write", "Edit"].includes(tool) && inside(input.file_path) && !String(input.file_path).includes("/.claude/")) return true;
        if (tool === "Bash" && FILE_COMMANDS.test(String(input.command))) return true;
    }
    return false;
}

const sessionId = resume ?? `sess-${Math.random().toString(36).slice(2, 10)}`;
/** Servers added with mcp_set_servers, and the tools each lets run without asking. */
const mcpServers = new Map<string, McpServerRef & { allowed: Set<string> }>();
const pending = new Map<string, (r: any) => void>();
let interrupted = false;
let wake: (() => void) | undefined;
let seq = 0;
let prompts = 0;
/** The prompt the turn under way answers (its user message's uuid); none for a turn Claude Code starts itself. */
let answering: string | undefined;
/**
 * What the session has spent so far: like Claude Code's, each result's
 * total_cost_usd includes the earlier ones, those of the runs it resumes too.
 */
const spentFile = process.env.FAKE_LOG ? `${process.env.FAKE_LOG}.spent-${sessionId}` : undefined;
let spent = spentFile && existsSync(spentFile) ? Number(readFileSync(spentFile, "utf-8")) : 0;

function result(subtype: string, extra: Record<string, unknown> = {}) {
    const old = process.env.FAKE_OLD_RESULTS === "1";
    spent += 0.5;
    if (spentFile) writeFileSync(spentFile, String(spent));
    out({
        type: "result",
        subtype,
        is_error: subtype !== "success",
        session_id: sessionId,
        total_cost_usd: spent,
        num_turns: 1,
        ...(old ? {} : answering ? { user_message_uuid: answering, user_message_uuids: [answering] } : { user_message_uuid: null, origin: { kind: "task-notification" } }),
        ...(process.env.FAKE_FAST_MODE_END ? { fast_mode_state: process.env.FAKE_FAST_MODE_END } : {}),
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
        modelUsage: { "claude-test-1": { contextWindow: 200000 } },
        ...extra,
    });
}

/** What Claude Code says runs in the background. */
const bgTasks = new Map<string, { task_id: string; task_type: string; description: string }>();
function backgroundChanged() {
    out({ type: "system", subtype: "background_tasks_changed", tasks: [...bgTasks.values()], session_id: sessionId });
}

/** A turn Claude Code takes itself, to pass on what a background sub-agent reported. */
function followUp(textOut: string) {
    answering = undefined;
    out({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: process.env.FAKE_API_KEY_SOURCE ?? "none", permissionMode: mode });
    text(textOut);
    result("success", { result: textOut });
}

function ask(toolName: string, input: Record<string, unknown>, id: string): Promise<any> {
    const request_id = `req-${++seq}`;
    out({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: toolName, display_name: toolName, input, tool_use_id: id, permission_suggestions: [] } });
    return new Promise((resolve) => pending.set(request_id, resolve));
}

function text(t: string) {
    out({ type: "stream_event", event: { type: "message_start", message: { id: "m" } }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } }, parent_tool_use_id: null, session_id: sessionId });
}

function toolUse(id: string, name: string, input: Record<string, unknown>) {
    // Streamed first (--include-partial-messages), under the name Claude Code gives it.
    out({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name, input: {} } }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null, session_id: sessionId });
}

function toolResult(id: string, content: string, isError: boolean, structured?: unknown) {
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] }, parent_tool_use_id: null, session_id: sessionId, tool_use_result: structured });
}

/** A sub-agent's message: tagged with the Agent call it runs under. */
function sub(parent: string, role: "assistant" | "user", content: unknown[], extra: Record<string, unknown> = {}) {
    out({ type: role, message: { role, content }, parent_tool_use_id: parent, session_id: sessionId, agent_id: "agent-1", subagent_type: "general-purpose", ...extra });
}

const REPORT = "src/auth registers sign-in strategies in one list.";
const NESTED_REPORT = "Only email sign-in is tested.";
/** A token in what the sub-agent writes (redacted by its pattern). */
const SUB_TOKEN = "ya29.subagentWroteThisToken1234567890";

/**
 * An Agent call, as Claude Code 2.1.293 streams it: task_started, the
 * sub-agent's own tool calls and results, its SubagentHandback, then
 * task_notification. In the foreground the Agent call's result comes last
 * and only says where the report went; in the background it comes first
 * ("async_launched") or, with `late`, after the sub-agent's first step. In
 * the background the sub-agent goes on after the turn's result, as in
 * 2.1.301: its last step, its last words (forwarded like its tool calls),
 * task_notification with its usage and those words as the summary, and a
 * turn Claude Code takes with them. A stuck one never finishes.
 */
function agentCall(background: boolean, late = false, stuck = false) {
    const id = "toolu_agent";
    const input = { description: "Map auth", prompt: "Read src/auth and report.", subagent_type: "general-purpose", ...(background ? { run_in_background: true } : {}) };
    const launched = () =>
        out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "Async agent launched successfully. (This tool result is internal metadata.)\nagentId: agent-1" }] }] }, parent_tool_use_id: null, session_id: sessionId, tool_use_result: { isAsync: true, status: "async_launched", agentId: "agent-1" } });
    toolUse(id, "Agent", input);
    if (background) {
        bgTasks.set("agent-1", { task_id: "agent-1", task_type: "local_agent", description: input.description });
        backgroundChanged();
    }
    out({ type: "system", subtype: "task_started", task_id: "agent-1", tool_use_id: id, description: input.description, is_backgrounded: background, session_id: sessionId });
    if (background && !late) launched();
    sub(id, "user", [{ type: "text", text: input.prompt }]);
    sub(id, "assistant", [{ type: "tool_use", id: "toolu_sub_read", name: "Read", input: { file_path: join(cwd, "auth.ts") } }]);
    sub(id, "user", [{ type: "tool_result", tool_use_id: "toolu_sub_read", content: "export const strategies = [];", is_error: false }]);
    out({ type: "system", subtype: "task_progress", task_id: "agent-1", tool_use_id: id, description: "Reading auth.ts", usage: { total_tokens: 1200, tool_uses: 1, duration_ms: 20 }, last_tool_name: "Read", session_id: sessionId });
    if (background && late) launched();
    if (!background) {
        // A file it writes (the diff shows), and an agent of its own, whose report goes to it.
        const note = join(cwd, "notes.txt");
        const content = `token = ${SUB_TOKEN}\n`;
        sub(id, "assistant", [{ type: "tool_use", id: "toolu_sub_write", name: "Write", input: { file_path: note, content } }]);
        sub(id, "user", [{ type: "tool_result", tool_use_id: "toolu_sub_write", content: `File created successfully at: ${note}`, is_error: false }], { tool_use_result: { type: "create", filePath: note, content, originalFile: null } });
        sub(id, "assistant", [{ type: "tool_use", id: "toolu_nested", name: "Agent", input: { description: "Check tests", prompt: "Which sign-ins are tested?", subagent_type: "general-purpose" } }]);
        sub("toolu_nested", "assistant", [{ type: "tool_use", id: "toolu_nested_handback", name: "SubagentHandback", input: { message: NESTED_REPORT } }]);
        sub(id, "user", [{ type: "tool_result", tool_use_id: "toolu_nested", content: [{ type: "text", text: 'This agent\'s report was delivered to you as a message from "agent-2".' }] }]);
    }
    sub(id, "assistant", [{ type: "tool_use", id: "toolu_sub_glob", name: "Glob", input: { pattern: "src/auth/**" } }]);
    if (background) {
        if (!stuck) afterResult = () => setTimeout(() => void backgroundAgentEnds(id), Number(process.env.FAKE_BACKGROUND_MS ?? 300));
        return;
    }
    // The Glob never gets a result: it's left open when the sub-agent ends.
    sub(id, "assistant", [{ type: "tool_use", id: "toolu_handback", name: "SubagentHandback", input: { message: REPORT } }]);
    sub(id, "user", [{ type: "tool_result", tool_use_id: "toolu_handback", content: [{ type: "text", text: '{"success":true,"message":"Report delivered to your caller."}' }] }]);
    out({ type: "system", subtype: "task_notification", task_id: "agent-1", tool_use_id: id, status: "completed", summary: 'This agent\'s report was delivered to you as a message from "agent-1".', handback: "send", handback_report: { text: REPORT }, usage: { total_tokens: 2345, tool_uses: 4, duration_ms: 40 }, session_id: sessionId });
    const pointer = 'This agent\'s report was delivered to you as a message from "agent-1" (its SubagentHandback call). Read it there; it is not repeated here.';
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: pointer }] }] }, parent_tool_use_id: null, session_id: sessionId, tool_use_result: { status: "completed", agentId: "agent-1", handback: "send", handbackReport: { text: REPORT } } });
}

/** A turn's continuation once its result is out (a sub-agent in the background going on). */
let afterResult: (() => void) | undefined;

/**
 * The background sub-agent's last step and words, Claude Code saying it's
 * done, and the turn it takes with its report. With FAKE_LIST_FIRST=1 it
 * stops listing the sub-agent a while before it says it's done; with
 * FAKE_LATE_TASK=1 another background task runs for a while before that turn.
 */
async function backgroundAgentEnds(id: string) {
    sub(id, "user", [{ type: "tool_result", tool_use_id: "toolu_sub_glob", content: "src/auth/index.ts", is_error: false }]);
    sub(id, "assistant", [{ type: "text", text: REPORT }]);
    out({ type: "system", subtype: "task_updated", task_id: "agent-1", patch: { status: "completed" }, session_id: sessionId });
    const unlist = () => {
        bgTasks.delete("agent-1");
        backgroundChanged();
    };
    const listFirst = Number(process.env.FAKE_LIST_FIRST ?? 0);
    if (listFirst) {
        unlist();
        await Bun.sleep(listFirst === 1 ? 200 : listFirst);
    }
    out({ type: "system", subtype: "task_notification", task_id: "agent-1", tool_use_id: id, status: "completed", output_file: "/tmp/agent-1.output", summary: REPORT, usage: { total_tokens: 4321, tool_uses: 2, duration_ms: 300 }, session_id: sessionId });
    if (!listFirst) unlist();
    const lateTask = Number(process.env.FAKE_LATE_TASK ?? 0);
    if (lateTask) {
        bgTasks.set("workflow-1", { task_id: "workflow-1", task_type: "local_workflow", description: "Check the tests" });
        backgroundChanged();
        await Bun.sleep(lateTask);
        bgTasks.delete("workflow-1");
        backgroundChanged();
    }
    followUp("The explorer reported back: sign-in strategies are registered in one list.");
}

/**
 * A sub-agent nothing of which shows before Claude Code says it finished: no
 * task_started, no steps of its own. The report is only in the notification.
 */
function agentQuiet() {
    const id = "toolu_agent";
    toolUse(id, "Agent", { description: "Map auth", prompt: "Read src/auth and report.", subagent_type: "general-purpose" });
    out({ type: "system", subtype: "task_notification", task_id: "agent-1", tool_use_id: id, status: "completed", summary: "", handback: "send", handback_report: { text: REPORT }, session_id: sessionId });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: 'This agent\'s report was delivered to you as a message from "agent-1".' }] }] }, parent_tool_use_id: null, session_id: sessionId, tool_use_result: { status: "completed", agentId: "agent-1" } });
}

/**
 * A sub-agent Claude Code first says has finished while it still waits on work
 * of its own (no report yet): a step of its own after that, then a second
 * notification with the report, which its Agent call's result doesn't carry.
 * An agent of its own hands its report back only in its result.
 */
function agentWaits() {
    const id = "toolu_agent";
    toolUse(id, "Agent", { description: "Map auth", prompt: "Read src/auth and report.", subagent_type: "general-purpose" });
    out({ type: "system", subtype: "task_started", task_id: "agent-1", tool_use_id: id, description: "Map auth", is_backgrounded: false, session_id: sessionId });
    sub(id, "assistant", [{ type: "tool_use", id: "toolu_sub_read", name: "Read", input: { file_path: join(cwd, "auth.ts") } }]);
    sub(id, "user", [{ type: "tool_result", tool_use_id: "toolu_sub_read", content: "export const strategies = [];", is_error: false }]);
    sub(id, "assistant", [{ type: "tool_use", id: "toolu_nested", name: "Agent", input: { description: "Check tests", prompt: "Which sign-ins are tested?", subagent_type: "general-purpose" } }]);
    sub(id, "user", [{ type: "tool_result", tool_use_id: "toolu_nested", content: [{ type: "text", text: 'This agent\'s report was delivered to you as a message from "agent-2".' }] }], { tool_use_result: { status: "completed", agentId: "agent-2", handback: "send", handbackReport: { text: NESTED_REPORT } } });
    const notify = (extra: Record<string, unknown>) => out({ type: "system", subtype: "task_notification", task_id: "agent-1", tool_use_id: id, status: "completed", summary: "Waiting on its own background work.", ...extra, session_id: sessionId });
    notify({});
    sub(id, "assistant", [{ type: "tool_use", id: "toolu_sub_glob", name: "Glob", input: { pattern: "src/auth/**" } }]);
    notify({ handback: "send", handback_report: { text: REPORT } });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: 'This agent\'s report was delivered to you as a message from "agent-1".' }] }] }, parent_tool_use_id: null, session_id: sessionId, tool_use_result: { status: "completed", agentId: "agent-1" } });
}

/**
 * A sub-agent in the background Claude Code says more than once how it ended,
 * each time replacing what it said before. First it's finished while it waits
 * on work of its own (no report); then it failed, or it's finished with a first
 * report and then the one that replaces it, or it hands its report back itself
 * (after it was said to be finished) and then is said to be finished with it.
 */
function agentRenotified(how: "replaced" | "failed" | "failed-reported" | "handed-back") {
    const id = "toolu_agent";
    toolUse(id, "Agent", { description: "Map auth", prompt: "Read src/auth and report.", subagent_type: "general-purpose", run_in_background: true });
    out({ type: "system", subtype: "task_started", task_id: "agent-1", tool_use_id: id, description: "Map auth", is_backgrounded: true, session_id: sessionId });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "Async agent launched successfully.\nagentId: agent-1" }] }] }, parent_tool_use_id: null, session_id: sessionId, tool_use_result: { isAsync: true, status: "async_launched", agentId: "agent-1" } });
    sub(id, "assistant", [{ type: "tool_use", id: "toolu_sub_read", name: "Read", input: { file_path: join(cwd, "auth.ts") } }]);
    sub(id, "user", [{ type: "tool_result", tool_use_id: "toolu_sub_read", content: "export const strategies = [];", is_error: false }]);
    const notify = (status: string, report?: string) => out({ type: "system", subtype: "task_notification", task_id: "agent-1", tool_use_id: id, status, summary: "", ...(report ? { handback: "send", handback_report: { text: report } } : {}), session_id: sessionId });
    if (how === "failed-reported") {
        notify("failed");
        return notify("failed", REPORT);
    }
    notify("completed");
    if (how === "failed") return notify("failed");
    if (how === "handed-back") sub(id, "assistant", [{ type: "tool_use", id: "toolu_handback", name: "SubagentHandback", input: { message: REPORT } }]);
    else notify("completed", "A first look: one list of strategies.");
    notify("completed", REPORT);
}

/** What running the call does (only what the scenarios need). */
function execute(tool: string, input: any): { content: string; structured?: unknown } {
    if (tool === "Write") {
        writeFileSync(input.file_path, String(input.content));
        return { content: `File created successfully at: ${input.file_path}`, structured: { type: "create", filePath: input.file_path, content: input.content, originalFile: null } };
    }
    if (tool === "Read") return { content: readFileSync(input.file_path, "utf-8") };
    const cmd = String(input.command);
    if (cmd.startsWith("rm ")) {
        unlinkSync(join(cwd, cmd.slice(3).trim()));
        return { content: "" };
    }
    if (cmd.startsWith("cat ")) return { content: readFileSync(join(cwd, cmd.slice(4).trim()), "utf-8") };
    return { content: "ok" };
}

/** One tool call, decided like the real CLI. False when the turn was stopped. */
async function use(id: string, tool: string, input: any): Promise<boolean> {
    toolUse(id, tool, input);
    if (deny.some((r) => ruleHits(r, tool, input))) {
        toolResult(id, `Permission to use ${tool} has been denied by your permission settings.`, true);
        return true;
    }
    if (!askRules.some((r) => ruleHits(r, tool, input)) && selfApproved(tool, input)) {
        const r = execute(tool, input);
        toolResult(id, r.content, false, r.structured);
        return true;
    }
    const r = await ask(tool, input, id);
    if (r.behavior === "allow") {
        const x = execute(tool, r.updatedInput ?? input);
        toolResult(id, x.content, false, x.structured);
        return true;
    }
    toolResult(id, String(r.message), true);
    if (r.interrupt) {
        result("error_during_execution", { errors: ["interrupted by the permission handler"] });
        return false;
    }
    return true;
}

let staleReported = false;

async function turn(content: any[], uuid?: string) {
    interrupted = false;
    if (++prompts === 2 && process.env.FAKE_CRASH_ON_SECOND === "1") process.exit(3);
    if (resume && process.env.FAKE_STALE_TASK === "1" && !staleReported) {
        // The earlier run's background sub-agent, killed with it: a turn of its own, with no model call, before the prompt's.
        staleReported = true;
        out({ type: "system", subtype: "task_notification", task_id: "agent-0", status: "stopped", output_file: "", summary: 'Background agent "Map auth" didn\'t finish before the previous session ended', session_id: sessionId });
        answering = undefined;
        out({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: process.env.FAKE_API_KEY_SOURCE ?? "none", permissionMode: mode });
        result("success", { result: "", num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
        await Bun.sleep(50);
    }
    answering = uuid;
    const scenario = prompts > 1 && process.env.FAKE_SECOND_SCENARIO ? process.env.FAKE_SECOND_SCENARIO : firstScenario;
    // slash_commands: its built-ins and skills, named as 2.1.301 names them (a plugin's skills as plugin:skill).
    out({ ...(process.env.FAKE_FAST_MODE_END ? { fast_mode_state: "on" } : {}), type: "system", subtype: "init", session_id: sessionId, apiKeySource: process.env.FAKE_API_KEY_SOURCE ?? "none", permissionMode: mode, slash_commands: ["code-review", "simplify", "compact", "context", "design:ux-copy"] });
    // Slash commands are Claude Code's own: /compact compacts the session.
    if (String(content.find((c) => c?.type === "text")?.text ?? "").startsWith("/compact")) {
        out({ type: "system", subtype: "compact_boundary", session_id: sessionId });
        return result("success", { result: "" });
    }
    const rateLimit = () => {
        for (let i = 0; process.env.FAKE_RATE_LIMIT && i < Number(process.env.FAKE_RATE_LIMIT_REPEAT ?? 1); i++) out({ type: "rate_limit_event", rate_limit_info: JSON.parse(readFileSync(process.env.FAKE_RATE_LIMIT, "utf-8")), session_id: sessionId });
    };
    if (process.env.FAKE_RATE_LIMIT_LATE !== "1") rateLimit();
    if (scenario === "rate-limit") {
        out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "You've hit your limit" }] }, error: "rate_limit", parent_tool_use_id: null, session_id: sessionId });
        if (process.env.FAKE_RATE_LIMIT_LATE === "1") rateLimit();
        return result("success", { is_error: true, result: "You've hit your limit" });
    }
    // A reply with nothing in it.
    if (scenario === "silent") return result("success", { result: "", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    text("Working on it.");
    let go = true;
    if (scenario === "write") go = await use("toolu_1", "Write", { file_path: join(cwd, "out.txt"), content: "hi\n" });
    else if (scenario === "write-config") go = await use("toolu_c", "Write", { file_path: join(cwd, ".claude", "settings.json"), content: "{}" });
    else if (scenario === "read-secret") go = await use("toolu_r", "Read", { file_path: join(cwd, "secret.txt") });
    else if (scenario === "rm") go = await use("toolu_rm", "Bash", { command: "rm victim.txt", description: "Remove it" });
    else if (scenario === "bash") go = await use("toolu_b", "Bash", { command: process.env.FAKE_COMMAND ?? "npm test", description: "Run tests" });
    else if (scenario === "leak") go = await use("toolu_l", "Bash", { command: "cat secret.txt" });
    else if (scenario === "agent-quiet") agentQuiet();
    else if (scenario === "agent-waits") agentWaits();
    else if (scenario === "agent-renotified") agentRenotified("replaced");
    else if (scenario === "agent-fails-later") agentRenotified("failed");
    else if (scenario === "agent-fails-then-reports") agentRenotified("failed-reported");
    else if (scenario === "agent-hands-back-late") agentRenotified("handed-back");
    else if (scenario.startsWith("agent")) agentCall(scenario !== "agent", scenario === "agent-background-late", scenario === "agent-background-stuck");
    else if (scenario === "mcp") {
        const calls: { server?: string; tool: string; args: Record<string, unknown> }[] = JSON.parse(process.env.FAKE_MCP_CALLS ?? "[]");
        const results: string[] = [];
        for (const [i, c] of calls.entries()) {
            const name = c.server ?? [...mcpServers.keys()][0] ?? "none";
            const s = mcpServers.get(name);
            const id = `toolu_m${prompts}_${i}`;
            const tool = `mcp__${name}__${c.tool}`;
            toolUse(id, tool, c.args);
            if (!s) {
                toolResult(id, `No such tool available: ${tool}`, true);
                results.push(`(no ${tool})`);
                continue;
            }
            // Its policy for the server's tools: always_allow runs without asking.
            if (!s.allowed.has(c.tool)) {
                const r = await ask(tool, c.args, id);
                if (r.behavior !== "allow") {
                    toolResult(id, String(r.message), true);
                    results.push(`(denied ${tool})`);
                    continue;
                }
            }
            const r = await callTool(s, c.tool, c.args);
            log({ mcpResult: { tool: c.tool, ...r } });
            toolResult(id, r.text, r.isError);
            results.push(r.text);
        }
        text(results.join("\n---\n"));
        return result("success", { result: results.join("\n---\n") });
    }
    else if (scenario === "ask") {
        const input = { questions: [{ question: "Which color?", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }], multiSelect: false }] };
        toolUse("toolu_q", "AskUserQuestion", input);
        const r = await ask("AskUserQuestion", input, "toolu_q");
        toolResult("toolu_q", JSON.stringify(r), r.behavior !== "allow");
    } else if (scenario === "plan") {
        const input = { plan: "1. Do the thing" };
        toolUse("toolu_p", "ExitPlanMode", input);
        const r = await ask("ExitPlanMode", input, "toolu_p");
        toolResult("toolu_p", JSON.stringify(r), r.behavior !== "allow");
    } else if (scenario === "hang") {
        toolUse("toolu_h", "Bash", { command: "sleep 1000" });
        await new Promise<void>((r) => (wake = r));
        if (interrupted) return result("error_during_execution", { errors: ["Request interrupted by user"] });
    } else if (scenario === "write-hang") {
        // Something done, then a command that runs until it's stopped.
        if (!(await use("toolu_wh", "Write", { file_path: join(cwd, "out.txt"), content: "hi\n" }))) return;
        toolUse("toolu_wh2", "Bash", { command: "sleep 1000" });
        await new Promise<void>((r) => (wake = r));
        if (interrupted) return result("error_during_execution", { errors: ["Request interrupted by user"] });
    }
    if (!go) return;
    text("All done.");
    result("success", { result: "All done." });
    const then = afterResult;
    afterResult = undefined;
    then?.();
}

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
    buf += new TextDecoder().decode(chunk);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        log({ received: m });
        if (m.type === "control_request") {
            const sub = m.request?.subtype;
            if (sub === "initialize") {
                out({
                    type: "control_response",
                    response: {
                        subtype: "success",
                        request_id: m.request_id,
                        response: {
                            claude_code_version: "2.1.301",
                            models: [
                                { value: "default", supportsFastMode: true, resolvedModel: "claude-test-1", displayName: "Default (recommended)", supportedEffortLevels: ["low", "high"] },
                                { value: "sonnet", resolvedModel: "claude-test-2", displayName: "Sonnet", supportedEffortLevels: ["low", "high"] },
                            ],
                            account: { tokenSource: "none" },
                        },
                    },
                });
            } else if (sub === "mcp_set_servers") {
                if (process.env.FAKE_MCP_REFUSE === "1") {
                    out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "Unsupported control request subtype: mcp_set_servers" } });
                    continue;
                }
                // Like the CLI: connect to each, then answer.
                const errors: Record<string, string> = {};
                for (const [name, cfg] of Object.entries<any>(m.request.servers ?? {})) {
                    if (cfg.type !== "http") continue;
                    const s = { url: cfg.url, headers: cfg.headers ?? {}, allowed: new Set<string>((cfg.tools ?? []).filter((t: any) => t.permission_policy === "always_allow").map((t: any) => t.name)) };
                    try {
                        const c = await connect(s);
                        mcpServers.set(name, s);
                        log({ mcpConnected: name, instructions: c.instructions, tools: c.tools.map((t: any) => t.name) });
                    } catch (e) {
                        errors[name] = (e as Error).message;
                    }
                }
                out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { added: [...mcpServers.keys()], removed: [], errors } } });
            } else if (sub === "interrupt") {
                if (process.env.FAKE_IGNORE_STOP === "1") continue;
                interrupted = true;
                out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
                wake?.();
            } else {
                if (sub === "set_permission_mode") mode = m.request.mode;
                out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
            }
        } else if (m.type === "control_response") {
            const r = pending.get(m.response?.request_id);
            pending.delete(m.response?.request_id);
            r?.(m.response?.response ?? {});
        } else if (m.type === "user") void turn(m.message?.content ?? [], typeof m.uuid === "string" ? m.uuid : undefined);
    }
}
// stdin closed: like the real CLI, exit once nothing's left to do (unless it's stuck).
if (process.env.FAKE_IGNORE_STOP === "1") await new Promise(() => {});
