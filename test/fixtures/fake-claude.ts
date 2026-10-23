// A stand-in for the `claude` CLI, speaking the parts of its stream-json
// protocol the harness uses: `auth status --json`, and `-p` with stream-json
// in and out (initialize, a turn with one tool call, interrupt,
// set_permission_mode, --resume, --fork-session). It makes no network requests.
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
// FAKE_SCENARIO     write (default) | shell-cap-late | write-config | read-secret | rm | bash | leak | ask | plan | hang | write-hang | mcp | silent | agent | agent-background | agent-background-late | agent-background-stuck | agent-quiet | agent-waits | agent-renotified | agent-fails-later | agent-fails-then-reports | agent-hands-back-late
// FAKE_SECOND_SCENARIO  the scenario for its prompts after the first (default: the same)
// FAKE_BACKGROUND_MS  how long a background sub-agent goes on after the turn's result (default 300)
// FAKE_BACKGROUND_ASK=1  the background sub-agent asks to run a command (can_use_tool) before it ends
// FAKE_STALE_TASK=1   resumed, it reports a background sub-agent of the earlier run as stopped (before initialize is answered),
//                    then takes a turn of its own for it at once, with no model call, ahead of any prompt (what 2.1.304 does for
//                    one killed with its process, #429); =2: a background shell command of the earlier run too (its notification
//                    names the earlier process's call, as 2.1.304's does), in a turn of its own; =shell: only the shell command.
//                    FAKE_STALE_MS: those turns start this long after initialize is answered; FAKE_STALE_TURN_MS: each takes this long
// FAKE_FG_TASK=1     hang: its foreground Bash is a task (task_started, not backgrounded), and Esc's interrupt says it stopped (task_notification), as 2.1.304 does
// FAKE_SUB_COMMANDS=1  a background sub-agent runs two foreground commands before it ends, one failing and one stopped, as 2.1.304 says of them:
//                    task_started owned_by_subagent, then a task_notification naming the sub-agent's call, without owned_by_subagent
// FAKE_OLD_RESULTS=1  results don't say which prompt they answer (an older CLI)
// FAKE_LIST_FIRST=ms  a background sub-agent leaves Claude Code's background list this long before its task_notification (1: 200 ms)
// FAKE_LATE_TASK=ms   after a background sub-agent's notification, another background task is listed this long before the report turn
// FAKE_HOLD_STDOUT=1  starts a command that keeps its stdout open for a while after it exits
// FAKE_COMMAND      the "bash" scenario's command (default: npm test)
// FAKE_TIMEOUT      shell-background*: the background Bash call's timeout (ms; default none)
// FAKE_SHELL_STATUS shell-background*: how its task_notification says it ended (default completed; after it left the list)
// FAKE_SHELL_OUTPUT shell-background: what the command prints (FAKE_SHELL_OUTPUT_FROM: a file's contents), to the output file
//                   2.1.304 writes it to (<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>/<folder>/<session>/tasks; FAKE_SHELL_OUTPUT_PATH:
//                   elsewhere), which its call's result names, and its notification too (FAKE_SHELL_OUTPUT_FILE=unsaid: not;
//                   2.1.304 does both), with the exit code in its summary, as 2.1.304 says it. FAKE_SHELL_OUTPUT_LINK /
//                   _HARDLINK=<file>: the command repoints its output file to that file before it ends; FAKE_SHELL_TASKS_LINK=<dir>:
//                   its tasks folder is moved there and left as a symlink to it
// FAKE_CARRIER_AGENT_ENDS=1  the background sub-agent ends while a hidden /effort carrier's turn runs
// FAKE_STOP_TASK    hang: stop_task unanswered; reject: refused; complete-reject: the task completes, then the stop is refused;
//                   fail-first: the task fails by itself, then the stop is answered success;
//                   late: the first stop of a task goes through FAKE_STOP_MS later (default 300), and a second asked
//                   meanwhile is refused once the first is answered (it's over); complete-exit: the task completes with a
//                   report, then the process exits without answering; complete-first: the task completes (said, then
//                   off the list) just before the stop is taken, which is answered success (as Claude Code answers for a
//                   task it no longer runs; FAKE_STOP_ANSWER=error: refused), and its report turn follows FAKE_FOLLOWUP_MS later
//                   (all of it FAKE_STOP_MS after the stop is asked; default at once; FAKE_STOP_STATUS: what it says, default
//                   completed); hang-turn: unanswered, and Claude Code takes a turn of its own during which the task
//                   says it completed (FAKE_STOP_TURN_AT / _NOTIFY_AT / _RESULT_AT ms after the stop); leave-reject:
//                   the task leaves the list and the stop is refused, then its notification and report turn come
// FAKE_RESULT_DELAY_MS  shell-background*: the turn's answer comes this long after the background command is listed
// FAKE_SHELL_NOTIFY_MS  shell-background*: its task_notification comes this long after it leaves the list (default 80)
// FAKE_SHELL_MS     shell-background*: the background command finishes this long after the answer (default 150; the
//                   stuck, mixed and nested ones finish only when it's set)
// FAKE_API_KEY_SOURCE  system/init apiKeySource (default "none": a plan)
// FAKE_IGNORE_STOP=1   ignores interrupt requests and SIGTERM
// FAKE_CRASH_ON_SECOND=1  exits without a result on its second prompt
// FAKE_MCP_CALLS     the "mcp" scenario's tool calls to servers from mcp_set_servers: [{ server?, tool, args }]
// FAKE_MCP_REFUSE=1  answers mcp_set_servers with an error; hang leaves it unanswered, exit stops the CLI
// FAKE_LOG_ENV=1     logs its whole environment at start
// FAKE_TRANSCRIPTS=1 keeps each session as a transcript under its config folder's projects/ (CLAUDE_CONFIG_DIR, or
//                    ~/.claude), as Claude Code does; --resume finds only those ("No conversation found" otherwise).
//                    --fork-session copies the resumed one's. Each prompt, and each message folded into a running
//                    turn, is a line of it: {"type":"fake-sent", text, pid, home (CLAUDE_CONFIG_DIR), at}. One whose
//                    turn then fails (auth-failed, rate-limit) is in it too, as Claude Code 2.1.304 keeps it (#417).
// FAKE_INIT_DELAY_MS  a turn's system/init comes this long after it started (its "started" lifecycle went out, and
//                    the prompt is in the transcript): a window in which the prompt is taken but its turn not yet seen
// FAKE_START_DELAY_MS  a prompt waits in the queue this long (after its "queued" lifecycle) before it starts: a window in
//                    which cancel_async_message withdraws it (cancelled: true), and it never reaches the transcript
// FAKE_CANCEL_ANSWER_MS  cancel_async_message is answered this late ("never": not at all); a prompt it withdraws is
//                    said "cancelled" (command_lifecycle) at once
// FAKE_CLAUDE_ENV_FILE  a JSON file of FAKE_* settings, read again with each prompt (as fake-codex's FAKE_ENV_FILE):
//                    a test changes a live process's scenario between its turns
// FAKE_RATE_LIMIT    a JSON file: the rate_limit_info of a rate_limit_event sent after system/init
//                    (shapes from Claude Code 2.1.301, test/fixtures/limits); FAKE_RATE_LIMIT_LATE=1 sends it
//                    after the "rate-limit" scenario's error instead; FAKE_RATE_LIMIT_REPEAT=n sends it n times (as
//                    Claude Code sends one per request)
// FAKE_SCENARIO=rate-limit  the turn ends on the plan's limit (an assistant error "rate_limit", an error result; no usage)
// FAKE_SCENARIO=auth-failed  the turn ends signed out (an assistant error "authentication_failed", an error result; no usage)
// FAKE_SCENARIO=chat  (or any name not listed) the turn says something and answers, with nothing done
// Reliability cases: steering / steering-many fold stdin input between tool rounds (dropping its document blocks,
// as Claude Code 2.1.304 does: images reach the model mid-turn, PDFs don't);
// shell-background / shell-background-stuck / monitor-background report live tasks;
// partial-error / partial-error-exit / result-error separate diagnostics from replies.
// FAKE_CLAUDE_VERSION overrides the initialize version for compatibility tests (default 2.1.304; 2.1.301 with FAKE_OLD_RESULTS).
// Kept between turns, as Claude Code 2.1.304 is (docs/cli-protocol-probes.md): it never exits after a result,
// only when its stdin closes. As 2.1.304 it says when a prompt is queued, started, completed or cancelled
// (command_lifecycle), names the prompts a turn takes in its system/init (user_message_uuids), and lists its
// capabilities there (interrupt_send_now_v1; FAKE_NO_SEND_NOW=1 leaves it out). A plain interrupt stops its
// background sub-agents too (task_notification stopped), with or without a turn running; interrupt {send_now,
// message_uuid} for a queued message stops only the running turn, and the message runs next. A command it
// answers itself (/effort, /cost) is answered by a synthetic message, with no model call.
// FAKE_EXIT_IDLE_MS  exits (a crash) this long after a result when nothing else comes
// FAKE_HANG_INITIALIZE=1  never answers initialize
// FAKE_SET_MODEL_FAIL=1  answers set_model and apply_flag_settings with an error
// FAKE_SEND_NOW      "delivering" or "nothing_waiting": how it answers interrupt send_now (default: as 2.1.304)
// FAKE_IGNORE_INTERRUPT=1  answers interrupt requests but doesn't stop the turn (an unanswered stop)
// scenarios for the live layer: agent-background-hang (a background sub-agent, then a foreground command that
// runs until it's stopped), bg-shell-hang, bg-monitor-hang (the same with a background shell or
// a monitor), stream-hang (text, then waits mid-answer until stopped), agent-background-ask (a background
// sub-agent asks to run a command after the turn's result), two-shells (two background commands that finish together)
// /goal: goal_status entries in the session's transcript (as 2.1.305), and active_goal on stdout only with
// CLAUDE_CODE_REMOTE; FAKE_GOAL_HOLD=1 waits for an interrupt after the first check, FAKE_GOAL_IMPOSSIBLE=1 ends
// it judged impossible

import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { callTool, connect, type McpServerRef } from "./mcp-call";

const log = (o: unknown) => {
    if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\n");
};
const argv = process.argv.slice(2);
/** Each --plugin-dir's skills, as <plugin>:<folder>. */
function pluginSkills(): string[] {
    return argv.flatMap((a, i) => {
        if (a !== "--plugin-dir") return [];
        const dir = argv[i + 1]!;
        const name = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf-8")).name;
        // A plugin can have no skills (only commands, hooks…).
        return existsSync(join(dir, "skills")) ? readdirSync(join(dir, "skills")).map((f) => `${name}:${f}`) : [];
    });
}
const cwd = process.cwd();
log({ pid: process.pid, argv, cwd, sawApiKey: Boolean(process.env.ANTHROPIC_API_KEY), sawOpenAiKey: Boolean(process.env.OPENAI_API_KEY), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR, codexHome: process.env.CODEX_HOME, sawOauthToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) });
if (process.env.FAKE_LOG_ENV === "1") log({ env: process.env });
// What --agents gave it (a file under -p), read at start as Claude Code does.
if (argv.includes("--agents")) {
    const file = argv[argv.indexOf("--agents") + 1]!;
    log({ agents: existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : null, agentsFile: file });
}

if (argv[0] === "auth" && argv[1] === "status") {
    const on = process.env.FAKE_LOGGED_IN !== "0";
    console.log(JSON.stringify(on ? { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty", subscriptionType: process.env.FAKE_PLAN ?? "max", ...(process.env.FAKE_EMAIL ? { email: process.env.FAKE_EMAIL } : {}) } : { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }));
    process.exit(on ? 0 : 1);
}
if (argv[0] === "auth" && argv[1] === "login") process.exit(0);
// FAKE_EXIT_AFTER_MS: the CLI goes away that long after it starts, whatever it's doing (a crash).
if (process.env.FAKE_EXIT_AFTER_MS) setTimeout(() => process.exit(3), Number(process.env.FAKE_EXIT_AFTER_MS));
// A one-off (--tools "" with a system prompt): the question's answer is FAKE_ONEOFF_ANSWER, as one result.
if (argv.includes("--tools") && argv[argv.indexOf("--tools") + 1] === "" && argv.includes("--system-prompt")) {
    let buf = "";
    for await (const chunk of Bun.stdin.stream()) {
        buf += new TextDecoder().decode(chunk);
        if (!buf.includes("\n")) continue;
        const m = JSON.parse(buf.split("\n")[0]!);
        log({ oneOff: { system: argv[argv.indexOf("--system-prompt") + 1], prompt: m.message?.content?.[0]?.text, model: argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : undefined } });
        const fail = process.env.FAKE_ONEOFF_FAIL;
        process.stdout.write(JSON.stringify({ type: "result", subtype: fail ? "error_during_execution" : "success", is_error: Boolean(fail), result: fail ?? process.env.FAKE_ONEOFF_ANSWER ?? '{"ok": true}' }) + "\n");
        process.exit(0);
    }
    process.exit(1);
}
if (process.env.FAKE_IGNORE_STOP === "1") process.on("SIGTERM", () => log({ ignored: "SIGTERM" }));
// Something it starts that holds its output open after it exits (a command left running with its stdout).
if (process.env.FAKE_HOLD_STDOUT === "1") Bun.spawn(["sleep", "8"], { stdin: "ignore", stdout: "inherit", stderr: "ignore" }).unref();

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
/** As 2.1.304's system/init lists them. */
const CAPABILITIES = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", ...(process.env.FAKE_NO_SEND_NOW === "1" ? [] : ["interrupt_send_now_v1"])];
/** A prompt's place in its queue, as 2.1.304 says it (not older ones: FAKE_OLD_RESULTS). */
const lifecycle = (uuid: string | undefined, state: string) => {
    if (uuid && process.env.FAKE_OLD_RESULTS !== "1") out({ type: "command_lifecycle", command_uuid: uuid, state, uuid: `lc-${Math.random().toString(36).slice(2)}`, session_id: sessionIdOf() });
};
let sessionIdOf = () => "";
const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const resume = flag("--resume");
const startedAt = Date.now();
/** FAKE_CLAUDE_ENV_FILE's settings, as the test has them now (one written before this process started: it has them already). */
function syncEnv() {
    const f = process.env.FAKE_CLAUDE_ENV_FILE;
    if (!f || !existsSync(f) || statSync(f).mtimeMs < startedAt) return;
    let env: Record<string, string>;
    try {
        env = JSON.parse(readFileSync(f, "utf-8"));
    } catch {
        return;
    }
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_") && !(k in env) && k !== "FAKE_CLAUDE_ENV_FILE" && k !== "FAKE_LOG") delete process.env[k];
    Object.assign(process.env, env);
}
const firstScenario = () => process.env.FAKE_SCENARIO ?? "write";
// FAKE_GONE_ID: a session id (a real-looking UUID) that no longer exists.
if (resume?.startsWith("gone") || (resume && resume === process.env.FAKE_GONE_ID)) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, errors: [`No conversation found with session ID: ${resume}`], usage: {}, session_id: resume });
    process.exit(1);
}
/** FAKE_TRANSCRIPTS: the folder this project's transcripts are in, as Claude Code names it. */
const transcripts = process.env.FAKE_TRANSCRIPTS === "1" ? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")) : undefined;
if (transcripts && resume && !existsSync(join(transcripts, `${resume}.jsonl`))) {
    log({ transcriptMissing: join(transcripts, `${resume}.jsonl`) });
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

// --fork-session (with --resume): a copy of the session goes on, under a new id.
const sessionId = resume && !argv.includes("--fork-session") ? resume : `${resume ? "fork" : "sess"}-${Math.random().toString(36).slice(2, 10)}`;
sessionIdOf = () => sessionId;
if (transcripts) {
    mkdirSync(transcripts, { recursive: true });
    // A fork starts with what the session it copies had.
    if (resume && sessionId !== resume) writeFileSync(join(transcripts, `${sessionId}.jsonl`), readFileSync(join(transcripts, `${resume}.jsonl`)));
    appendFileSync(join(transcripts, `${sessionId}.jsonl`), JSON.stringify({ sessionId, pid: process.pid }) + "\n");
}
/** FAKE_TRANSCRIPTS: what the model was sent, as a line of the session's transcript (see the top). */
function recordSent(text: string) {
    if (!transcripts) return;
    appendFileSync(join(transcripts, `${sessionId}.jsonl`), JSON.stringify({ type: "fake-sent", text, pid: process.pid, home: process.env.CLAUDE_CONFIG_DIR ?? null, at: Date.now() }) + "\n");
}
/** A turn is running, and the prompt it answers. */
let busy = false;
/** Prompts waiting behind the running turn, and those withdrawn (cancel_async_message) before they ran. */
const waiting = new Set<string>();
const withdrawn = new Set<string>();
/** Withdrawn prompts whose "cancelled" lifecycle went out already (FAKE_CANCEL_ANSWER_MS). */
const cancelledSaid = new Set<string>();
let idleExit: ReturnType<typeof setTimeout> | undefined;
/** FAKE_EXIT_IDLE_MS: it goes away (a crash) a while after a turn, when nothing else came. */
function armIdleExit() {
    clearTimeout(idleExit);
    if (process.env.FAKE_EXIT_IDLE_MS && !busy && !waiting.size) idleExit = setTimeout(() => process.exit(3), Number(process.env.FAKE_EXIT_IDLE_MS));
}
/** Its background sub-agents, stopped (a plain interrupt does this, with or without a turn running). */
function killAgents() {
    let any = false;
    for (const [id, t] of [...bgTasks]) {
        if (t.task_type !== "local_agent") continue;
        any = true;
        bgTasks.delete(id);
        stoppedTasks.add(id);
        out({ type: "system", subtype: "task_updated", task_id: id, patch: { status: "killed" }, session_id: sessionId });
        out({ type: "system", subtype: "task_notification", task_id: id, tool_use_id: "toolu_agent", status: "stopped", summary: "Map auth", session_id: sessionId });
    }
    if (any) backgroundChanged();
}
/** Servers added with mcp_set_servers, and the tools each lets run without asking. */
const mcpServers = new Map<string, McpServerRef & { allowed: Set<string> }>();
const pending = new Map<string, (r: any) => void>();
let interrupted = false;
let wake: (() => void) | undefined;
let seq = 0;
let prompts = 0;
/** The prompt the turn under way answers (its user message's uuid); none for a turn Claude Code starts itself. */
let answering: string | undefined;
// A busy CLI folds these into the current turn, rather than starting concurrent turns.
let steering: { uuid?: string; text: string; images?: number }[] | undefined;
/** FAKE_GOAL_HOLD=1: the goal's second turn waits for an interrupt. */
let goalRelease: (() => void) | undefined;
let steeringWake: (() => void) | undefined;
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
        usage: process.env.FAKE_CACHE_1H
            ? // A subscription's turn: its history written to the one-hour cache.
              { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: Number(process.env.FAKE_CACHE_1H), cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: Number(process.env.FAKE_CACHE_1H) } }
            : { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
        modelUsage: { [process.env.FAKE_RESOLVED_MODEL ?? "claude-test-1"]: { contextWindow: 200000 } },
        ...extra,
    });
}

/** What Claude Code says runs in the background. */
const bgTasks = new Map<string, { task_id: string; task_type: string; description: string }>();
/** Tasks stopped by the host (stop_task): they don't finish or report later. */
const stoppedTasks = new Set<string>();
/** FAKE_STOP_TASK=late: each task's first stop, answered later. */
const lateStops = new Map<string, Promise<void>>();
function backgroundChanged() {
    out({ type: "system", subtype: "background_tasks_changed", tasks: [...bgTasks.values()], session_id: sessionId });
}

/** A turn Claude Code takes itself, to pass on what a background sub-agent reported. */
function followUp(textOut: string): void | Promise<void> {
    answering = undefined;
    interrupted = false;
    out({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: process.env.FAKE_API_KEY_SOURCE ?? "none", permissionMode: mode, capabilities: CAPABILITIES });
    // FAKE_BACKGROUND_ASK=1  a background sub-agent asks to run a command before it ends
// FAKE_WAKE_TOOL=1: the report turn reads something first (a tool round, where messages can steer it).
    // (Each step takes a moment, as the model's requests do: time for the turn to be adopted, and a message to come in.)
    // FAKE_WAKE_TEXT_MS: the report turn says its words that late.
    if (process.env.FAKE_WAKE_TEXT_MS)
        return Bun.sleep(Number(process.env.FAKE_WAKE_TEXT_MS)).then(() => {
            text(textOut);
            result("success", { result: textOut });
        });
    if (process.env.FAKE_WAKE_TOOL === "1") {
        return Bun.sleep(200).then(async () => {
            toolUse("toolu_wake_read", "Read", { file_path: join(cwd, "README.md") });
            toolResult("toolu_wake_read", "read complete", false);
            await Bun.sleep(300);
            text(textOut);
            result("success", { result: textOut });
        });
    }
    // FAKE_WAKE_HANG=1: the report turn runs a command until it's stopped.
    if (process.env.FAKE_WAKE_HANG === "1") {
        text("Looking into the report.");
        toolUse("toolu_wake_hang", "Bash", { command: "sleep 1000" });
        return new Promise<void>((r) => (wake = r)).then(() => {
            if (interrupted) {
                toolResult("toolu_wake_hang", "The user doesn't want to proceed with this tool use.", true);
                return void result("error_during_execution", { terminal_reason: "aborted_tools" });
            }
            text(textOut);
            result("success", { result: textOut });
        });
    }
    text(textOut);
    result("success", { result: textOut });
}

function ask(toolName: string, input: Record<string, unknown>, id: string): Promise<any> {
    const request_id = `req-${++seq}`;
    out({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: toolName, display_name: toolName, input, tool_use_id: id, permission_suggestions: [] } });
    return new Promise((resolve) => pending.set(request_id, resolve));
}

let replies = 0;
function text(t: string) {
    out({ type: "stream_event", event: { type: "message_start", message: { id: "m" } }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }, parent_tool_use_id: null, session_id: sessionId });
    // FAKE_GROWING_CONTEXT=1: each reply reads more context than the last, as a real turn's do.
    const input = process.env.FAKE_GROWING_CONTEXT === "1" ? 10 * ++replies : 10;
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }], usage: { input_tokens: input, output_tokens: 5, cache_read_input_tokens: process.env.FAKE_CACHE_1H ? 0 : 1000, cache_creation_input_tokens: Number(process.env.FAKE_CACHE_1H ?? 0) } }, parent_tool_use_id: null, session_id: sessionId });
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
    // FAKE_AGENT_DESC: the call's description (the task's label).
    const input = { description: process.env.FAKE_AGENT_DESC ?? "Map auth", prompt: "Read src/auth and report.", subagent_type: "general-purpose", ...(background ? { run_in_background: true } : {}) };
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
    if (stoppedTasks.has("agent-1")) return;
    // FAKE_BACKGROUND_ASK=1: first it asks to run a command (after its turn, maybe one the user stopped).
    if (process.env.FAKE_BACKGROUND_ASK === "1") {
        const input = { command: "npm test", description: "Run tests" };
        sub(id, "assistant", [{ type: "tool_use", id: "toolu_sub_bash", name: "Bash", input }]);
        const request_id = `req-${++seq}`;
        out({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: "Bash", display_name: "Bash", input, tool_use_id: "toolu_sub_bash", agent_id: "agent-1", permission_suggestions: [] } });
        const r: any = await new Promise((resolve) => pending.set(request_id, resolve));
        log({ backgroundAsk: r.behavior });
        sub(id, "user", [{ type: "tool_result", tool_use_id: "toolu_sub_bash", content: r.behavior === "allow" ? "ok" : String(r.message), is_error: r.behavior !== "allow" }]);
        if (stoppedTasks.has("agent-1")) return;
    }
    if (process.env.FAKE_SUB_COMMANDS === "1") {
        // Its own foreground commands: one fails, one is stopped (as 2.1.304 says of them, frames from a live probe).
        for (const [n, status, command] of [[1, "failed", "sh -c 'sleep 6; exit 3'"], [2, "stopped", "python3 -c 'import time; time.sleep(240)'"]] as const) {
            const call = `toolu_sub_cmd${n}`;
            sub(id, "assistant", [{ type: "tool_use", id: call, name: "Bash", input: { command } }]);
            out({ type: "system", subtype: "task_started", task_id: `sub-cmd-${n}`, tool_use_id: call, description: command, is_backgrounded: false, owned_by_subagent: true, parent_task_id: "agent-1", task_type: "local_bash", session_id: sessionId });
            out({ type: "system", subtype: "task_notification", task_id: `sub-cmd-${n}`, tool_use_id: call, status, output_file: "", summary: command, session_id: sessionId });
            sub(id, "user", [{ type: "tool_result", tool_use_id: call, content: status === "failed" ? "Exit code 3" : "Command was stopped", is_error: true }]);
        }
    }
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
    queueWake("The explorer reported back: sign-in strategies are registered in one list.");
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

/** Hooks the host registered in initialize (SDK callbacks): run like Claude Code's, by sending hook_callback. */
let sdkHooks: Record<string, { matcher?: string; hookCallbackIds: string[] }[]> = {};
function sdkHook(event: string, input: Record<string, unknown>): Promise<any[]> {
    const ids = (sdkHooks[event] ?? []).filter((g) => !g.matcher || g.matcher === "*" || g.matcher.split("|").includes(String(input.tool_name ?? input.source))).flatMap((g) => g.hookCallbackIds);
    return Promise.all(
        ids.map((callback_id) => {
            const request_id = `req-${++seq}`;
            out({ type: "control_request", request_id, request: { subtype: "hook_callback", callback_id, input: { session_id: sessionId, cwd, hook_event_name: event, permission_mode: mode, ...input }, tool_use_id: input.tool_use_id } });
            return new Promise((resolve) => pending.set(request_id, resolve));
        }),
    ).then((answers) => (log({ hookAnswers: { event, answers } }), answers));
}

/** One tool call, decided like the real CLI. False when the turn was stopped. */
async function use(id: string, tool: string, input: any): Promise<boolean> {
    toolUse(id, tool, input);
    const pre = await sdkHook("PreToolUse", { tool_name: tool, tool_input: input, tool_use_id: id });
    const refused = pre.find((r) => r?.hookSpecificOutput?.permissionDecision === "deny");
    if (refused) {
        toolResult(id, String(refused.hookSpecificOutput.permissionDecisionReason ?? "Denied by a hook"), true);
        return true;
    }
    if (sdkHooks.PostToolUse) {
        const run = execute;
        const done = (r: { content: string }) => sdkHook("PostToolUse", { tool_name: tool, tool_input: input, tool_use_id: id, tool_response: r.content });
        if (!deny.some((r) => ruleHits(r, tool, input)) && !askRules.some((r) => ruleHits(r, tool, input)) && selfApproved(tool, input)) {
            const r = run(tool, input);
            toolResult(id, r.content, false, r.structured);
            await done(r);
            return true;
        }
    }
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

/** A wake turn, after whatever turn runs now (Claude Code runs one at a time). */
function queueWake(textOut: string) {
    turnTail = turnTail.then(async () => {
        busy = true;
        try {
            await followUp(textOut);
        } finally {
            busy = false;
            armIdleExit();
        }
    });
}

/** A background task ends by itself: its frames as 2.1.304 sends them, then the turn that reports it. */
function finishTask(id: string, description: string) {
    if (stoppedTasks.has(id) || !bgTasks.has(id)) return;
    bgTasks.delete(id);
    out({ type: "system", subtype: "task_updated", task_id: id, patch: { status: "completed" }, session_id: sessionId });
    out({ type: "system", subtype: "task_notification", task_id: id, status: "completed", summary: `Background command "${description}" completed (exit code 0)`, session_id: sessionId });
    backgroundChanged();
    queueWake(`${description}: done.`);
}

/** FAKE_STALE_TASK: what the earlier run left behind, as its reports' summaries (and the call each names). */
function staleReports(): { task_id: string; tool_use_id?: string; summary: string }[] {
    const agent = { task_id: "agent-0", summary: 'Background agent "Map auth" didn\'t finish before the previous session ended' };
    const shell = { task_id: "shell-0", tool_use_id: "toolu_earlier_shell", summary: "Background shell command didn't finish before the previous session ended" };
    const which = process.env.FAKE_STALE_TASK;
    return which === "1" ? [agent] : which === "2" ? [agent, shell] : which === "shell" ? [shell] : [];
}

/**
 * Resumed with FAKE_STALE_TASK, as Claude Code 2.1.304 does (probed for #429; test/fixtures/protocol/claude-311-c2-resume.jsonl):
 * each report of what the earlier run left behind is said before initialize is answered, then each gets a turn of its
 * own at once, with no model call (num_turns 0, nothing spent), ahead of any prompt. Its init names no prompt; its
 * result has origin task-notification.
 */
function staleTurns() {
    const reports = resume ? staleReports() : [];
    if (!reports.length) return;
    for (const r of reports) out({ type: "system", subtype: "task_notification", ...r, status: "stopped", output_file: "", uuid: `n-${r.task_id}`, session_id: sessionId });
    turnTail = turnTail.then(async () => {
        // FAKE_STALE_MS: they start this long after initialize is answered (a prompt sent meanwhile is queued behind them).
        if (process.env.FAKE_STALE_MS) await Bun.sleep(Number(process.env.FAKE_STALE_MS));
        for (const _ of reports) {
            busy = true;
            out({ type: "system", subtype: "init", capabilities: CAPABILITIES, session_id: sessionId, apiKeySource: process.env.FAKE_API_KEY_SOURCE ?? "none", permissionMode: mode });
            // FAKE_STALE_TURN_MS: how long each takes (an Esc meanwhile).
            if (process.env.FAKE_STALE_TURN_MS) await Bun.sleep(Number(process.env.FAKE_STALE_TURN_MS));
            out({ type: "result", subtype: "success", is_error: false, session_id: sessionId, total_cost_usd: spent, num_turns: 0, duration_api_ms: 0, result: "", user_message_uuid: null, origin: { kind: "task-notification" }, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
            busy = false;
        }
    });
}

async function turn(content: any[], uuid?: string) {
    interrupted = false;
    if (++prompts === 2 && process.env.FAKE_CRASH_ON_SECOND === "1") process.exit(3);
    answering = uuid;
    syncEnv();
    const scenario = prompts > 1 && process.env.FAKE_SECOND_SCENARIO ? process.env.FAKE_SECOND_SCENARIO : firstScenario();
    // Taken: in the transcript from here on.
    recordSent(content.map((c) => c?.text ?? "").join(""));
    // FAKE_INIT_DELAY_MS: the turn has started (its "started" lifecycle is out), its system/init comes this much later.
    if (process.env.FAKE_INIT_DELAY_MS) await Bun.sleep(Number(process.env.FAKE_INIT_DELAY_MS));
    // slash_commands: its built-ins and skills, named as 2.1.301 names them (a plugin's skills as plugin:skill, as --plugin-dir's are).
    out({ ...(process.env.FAKE_FAST_MODE_END ? { fast_mode_state: "on" } : {}), ...(uuid && process.env.FAKE_OLD_RESULTS !== "1" ? { user_message_uuids: [uuid] } : {}), capabilities: CAPABILITIES, type: "system", subtype: "init", session_id: sessionId, apiKeySource: process.env.FAKE_API_KEY_SOURCE ?? "none", permissionMode: mode, slash_commands: [...(process.env.FAKE_SLASH_COMMANDS ? JSON.parse(process.env.FAKE_SLASH_COMMANDS) : ["code-review", "simplify", "compact", "context", "design:ux-copy"]), ...pluginSkills()] });
    // Commands it answers itself: a synthetic message, no model call, nothing spent.
    const said = String(content.find((c) => c?.type === "text")?.text ?? "");
    if (/^\/(effort|cost)\s*$/.test(said)) {
        // FAKE_CARRIER_AGENT_ENDS=1: the background sub-agent ends (and reports) while this turn runs.
        if (process.env.FAKE_CARRIER_AGENT_ENDS === "1" && bgTasks.has("agent-1")) await backgroundAgentEnds("toolu_agent");
        const reply = said.startsWith("/effort") ? "Usage: /effort <low|medium|high|xhigh|max|auto>" : "Total cost: $0.00";
        out({ type: "assistant", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: reply }], usage: { input_tokens: 0, output_tokens: 0 } }, parent_tool_use_id: null, session_id: sessionId });
        out({ type: "result", subtype: "success", is_error: false, session_id: sessionId, total_cost_usd: spent, num_turns: 0, result: reply, user_message_uuid: uuid ?? null, user_message_uuids: uuid ? [uuid] : [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
        return;
    }
    // Slash commands are Claude Code's own: /compact compacts the session.
    if (String(content.find((c) => c?.type === "text")?.text ?? "").startsWith("/compact")) {
        out({ type: "system", subtype: "compact_boundary", session_id: sessionId });
        // As Claude Code does after compacting: SessionStart with source compact.
        await sdkHook("SessionStart", { source: "compact" });
        return result("success", { result: "" });
    }
    // /goal is Claude Code's own too, and the loop runs inside the one query. As 2.1.305 does, it records the goal in
    // the session's transcript (goal_status entries) and reports it on stdout (active_goal) only in a remote session.
    const goal = String(content.find((c) => c?.type === "text")?.text ?? "").match(/^\/goal(?:\s+([\s\S]*))?$/);
    if (goal) {
        const condition = (goal[1] ?? "").trim();
        const setAt = Date.now();
        const report = (value: unknown) => process.env.CLAUDE_CODE_REMOTE && out({ type: "active_goal", value, uuid: `g-${Date.now()}`, session_id: sessionId });
        const transcript = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
        const record = (attachment: Record<string, unknown>) => {
            mkdirSync(dirname(transcript), { recursive: true });
            appendFileSync(transcript, JSON.stringify({ type: "attachment", uuid: `a-${Math.random()}`, timestamp: new Date().toISOString(), sessionId, attachment: { type: "goal_status", ...attachment } }) + "\n");
        };
        // The goal set now, from the transcript as Claude Code's own resume reads it.
        const current = () => {
            const lines = existsSync(transcript) ? readFileSync(transcript, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
            const last = lines.reverse().find((e) => e.attachment?.type === "goal_status")?.attachment;
            return last && !last.met && !last.failed ? (last.condition as string) : undefined;
        };
        if (!condition || condition === "clear") {
            const was = current();
            if (condition && was) record({ met: true, sentinel: true, condition: was });
            report(null);
            return result("success", { result: condition ? (was ? "Goal cleared" : "No goal set") : was ? `Goal: ${was}` : "No goal set" });
        }
        record({ met: false, sentinel: true, condition });
        report({ condition, iterations: 0, set_at: setAt, tokens_at_start: 0 });
        text("Working toward the goal.");
        record({ met: false, condition, reason: "The tests haven't run yet." });
        report({ condition, iterations: 1, set_at: setAt, tokens_at_start: 0, last_reason: "The tests haven't run yet." });
        if (process.env.FAKE_GOAL_HOLD === "1") await new Promise<void>((r) => (goalRelease = r));
        if (interrupted) return result("success", { result: "" });
        text("Ran the tests: they pass.");
        if (process.env.FAKE_GOAL_IMPOSSIBLE === "1") record({ met: false, failed: true, condition, reason: "There is no test suite.", iterations: 2, durationMs: 5, tokens: 10 });
        else record({ met: true, condition, reason: "The tests pass.", iterations: 2, durationMs: 5, tokens: 10 });
        report(null);
        return result("success", { result: "Goal achieved" });
    }
    if (process.env.FAKE_CLAUDE_LIMIT_INFO) out({ type: "rate_limit_event", rate_limit_info: JSON.parse(process.env.FAKE_CLAUDE_LIMIT_INFO) });
    if (process.env.FAKE_LIMIT_ERROR === "1") {
        out({ type: "assistant", error: "rate_limit", message: { role: "assistant", content: [] } });
        return result("error_during_execution", { is_error: true, result: "Limit reached" });
    }
    const rateLimit = () => {
        for (let i = 0; process.env.FAKE_RATE_LIMIT && i < Number(process.env.FAKE_RATE_LIMIT_REPEAT ?? 1); i++) out({ type: "rate_limit_event", rate_limit_info: JSON.parse(readFileSync(process.env.FAKE_RATE_LIMIT, "utf-8")), session_id: sessionId });
        // Some requests repeat the rejection without its window or reset time.
        if (process.env.FAKE_RATE_LIMIT_SPARSE === "1") out({ type: "rate_limit_event", rate_limit_info: { status: "rejected" }, session_id: sessionId });
        if (process.env.FAKE_RATE_LIMIT_FOLLOWUP) out({ type: "rate_limit_event", rate_limit_info: JSON.parse(readFileSync(process.env.FAKE_RATE_LIMIT_FOLLOWUP, "utf-8")), session_id: sessionId });
    };
    if (process.env.FAKE_RATE_LIMIT_LATE !== "1") rateLimit();
    // A request refused before any model read it (signed out, the plan's limit): as Claude Code 2.1.304 says it (checked
    // against a local stub API answering 401 and 429), a synthetic message and a result with nothing used. It keeps
    // the prompt in its transcript all the same, and sends it again on resume (#407).
    const unread = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    if (scenario === "rate-limit" || scenario.startsWith("partial-error")) {
        const partial = scenario.startsWith("partial-error");
        if (partial) text("The first check passed.");
        out({ type: "assistant", message: { role: "assistant", ...(partial ? {} : { model: "<synthetic>", usage: unread }), content: [{ type: "text", text: "You've hit your limit" }] }, error: "rate_limit", parent_tool_use_id: null, session_id: sessionId });
        if (process.env.FAKE_RATE_LIMIT_LATE === "1") rateLimit();
        if (scenario === "partial-error-exit") process.exit(3);
        return result("success", { is_error: true, result: "You've hit your limit", ...(partial ? {} : { usage: unread }) });
    }
    if (scenario === "result-error") return result("error_during_execution", { errors: ["CLI diagnostic: execution failed"], usage: {} });
    if (scenario === "auth-failed") {
        out({ type: "assistant", message: { role: "assistant", model: "<synthetic>", usage: unread, content: [{ type: "text", text: "Invalid API key" }] }, error: "authentication_failed", parent_tool_use_id: null, session_id: sessionId });
        return result("success", { is_error: true, result: "Invalid API key", usage: unread });
    }
    // A reply with nothing in it.
    if (scenario === "silent") return result("success", { result: "", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    text("Working on it.");
    let go = true;
    if (scenario === "steering" || scenario === "steering-many") {
        steering = [];
        for (let round = 0; round < (scenario === "steering-many" ? 66 : 1); round++) {
            const count = steering.length;
            const next = new Promise<void>((r) => (steeringWake = r));
            toolUse(`toolu_safe_${round}`, "Read", { file_path: join(cwd, "README.md") });
            toolResult(`toolu_safe_${round}`, "read complete", false);
            await Promise.race([next, Bun.sleep(scenario === "steering-many" ? 100 : 800)]);
            if (steering.length === count) break;
        }
        const folded = steering;
        steering = undefined;
        steeringWake = undefined;
        log({ foldedBeforeResult: folded.map((m) => m.text), foldedImages: folded.reduce((n, m) => n + (m.images ?? 0), 0) });
        text(folded.length ? `Adjusted: ${folded.map((m) => m.text).join(" | ")}` : "No steering received before result.");
        return result("success", { user_message_uuids: [uuid, ...folded.map((m) => m.uuid)].slice(-64) });
    }
    if (scenario === "monitor-repeated-reports") {
        bgTasks.set("monitor-1", { task_id: "monitor-1", task_type: "monitor_mcp", description: "Watch checks" });
        backgroundChanged();
        text("Monitoring checks.");
        result("success");
        let reports = 0;
        // Notifications start native report turns while the Monitor remains running.
        // Stdin keeps the fake alive; shutdown must also stop its report timer.
        // FAKE_MONITOR_REPORTS: that many, then no more.
        const most = Number(process.env.FAKE_MONITOR_REPORTS ?? Infinity);
        const timer = setInterval(() => (reports < most ? followUp(`Monitor notification ${++reports}.`) : clearInterval(timer)), 40);
        timer.unref();
        return;
    }
    if (scenario === "shell-cap-late") {
        // A sub-agent keeps the wait going; a command it starts later gets its own cap, not what's left of the wait's.
        agentCall(true);
        const finishAgent = afterResult;
        afterResult = undefined;
        text("Waiting for the sub-agent.");
        result("success");
        finishAgent?.();
        setTimeout(() => {
            bgTasks.set("B", { task_id: "B", task_type: "local_bash", description: "Command B" });
            backgroundChanged();
            setTimeout(async () => {
                if (stoppedTasks.has("B")) return;
                bgTasks.delete("B");
                backgroundChanged();
                out({ type: "system", subtype: "task_notification", task_id: "B", status: "completed", summary: "B done", session_id: sessionId });
                await Bun.sleep(40);
                followUp("Command B completed with its results.");
            }, 200);
        }, 500);
        return;
    }
    if (scenario.startsWith("shell-grace-")) {
        const add = (id: string) => bgTasks.set(id, { task_id: id, task_type: id === "B" && scenario === "shell-grace-replace" ? "monitor_mcp" : "local_bash", description: `Command ${id}` });
        const finishB = () => setTimeout(() => {
            bgTasks.delete("B");
            backgroundChanged();
            followUp("Command B completed with its results.");
        }, scenario === "shell-grace-overlap" || scenario === "shell-grace-replace" ? 180 : 80);
        if (scenario === "shell-grace-queued" && prompts > 1) {
            // The new answer comes after A's original deadline, with a fresh B.
            await Bun.sleep(400);
            bgTasks.delete("A");
            add("B");
            backgroundChanged();
            text("Waiting for B.");
            result("success");
            finishB();
            return;
        }
        const renew = scenario === "shell-grace-renew";
        add(renew ? "B" : "A");
        backgroundChanged();
        text(renew ? "Waiting for B." : "Waiting for A.");
        result("success");
        if (scenario === "shell-grace-queued") return;
        setTimeout(async () => {
            if (scenario === "shell-grace-turn" || renew) {
                answering = undefined;
                out({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: "none" });
                await Bun.sleep(400);
            }
            if (scenario !== "shell-grace-overlap") bgTasks.delete("A");
            if (!renew) add("B");
            backgroundChanged();
            if (scenario === "shell-grace-turn" || renew) { text("Waiting for B."); result("success"); }
            finishB();
        }, scenario === "shell-grace-turn" || renew ? 40 : 180);
        return;
    }
    if (scenario.startsWith("shell-background") || scenario.startsWith("monitor-background")) {
        const type = scenario.startsWith("monitor-background") ? "monitor_mcp" : "local_bash";
        const nested = scenario === "shell-background-nested";
        // Where 2.1.304 writes it: <CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>/<the folder's real path, sanitized>/<session>/tasks
        // (a sanitized path past 200 characters cut there, with "-" and the path's hash: String.hashCode, base 36).
        const slug = (path: string) => {
            const s = path.replace(/[^a-zA-Z0-9]/g, "-");
            let h = 0;
            for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0;
            return s.length <= 200 ? s : `${s.slice(0, 200)}-${Math.abs(h).toString(36)}`;
        };
        const shellOutput = process.env.FAKE_SHELL_OUTPUT !== undefined && type === "local_bash" && !nested ? (process.env.FAKE_SHELL_OUTPUT_PATH ?? join(realpathSync(process.env.CLAUDE_CODE_TMPDIR || "/tmp"), `claude-${process.getuid?.() ?? 0}`, slug(realpathSync(cwd)), sessionId, "tasks", "background-1.output")) : undefined;
        if (nested) {
            agentCall(true);
            afterResult?.();
            afterResult = undefined;
        }
        if (type === "local_bash") {
            const input = { command: process.env.FAKE_COMMAND ?? "sleep 150; echo done", description: "Wait for checks", run_in_background: true, ...(process.env.FAKE_TIMEOUT ? { timeout: Number(process.env.FAKE_TIMEOUT) } : {}) };
            if (nested) sub("toolu_agent", "assistant", [{ type: "tool_use", id: "background-tool", name: "Bash", input }]);
            else toolUse("background-tool", "Bash", input);
            out({ type: "system", subtype: "task_started", task_id: "background-1", tool_use_id: "background-tool", is_backgrounded: true, session_id: sessionId });
            if (nested) sub("toolu_agent", "user", [{ type: "tool_result", tool_use_id: "background-tool", content: "Command running in background", is_error: false }]);
            else if (shellOutput) {
                // FAKE_SHELL_OUTPUT: its output goes to a file, which the call's result names, as 2.1.304's does.
                mkdirSync(dirname(shellOutput), { recursive: true });
                writeFileSync(shellOutput, "");
                toolResult("background-tool", `Command running in background with ID: background-1. Output is being written to: ${shellOutput}. You will be notified when it completes. To check interim output, use Read on that file path.`, false, { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: "background-1" });
            } else toolResult("background-tool", "Command running in background", false);
        }
        if (scenario === "shell-background-mixed") {
            agentCall(true);
            const finishAgent = afterResult;
            afterResult = undefined;
            finishAgent?.();
        }
        bgTasks.set("background-1", { task_id: "background-1", task_type: type, description: "Wait for checks" });
        backgroundChanged();
        if (process.env.FAKE_RESULT_DELAY_MS) await Bun.sleep(Number(process.env.FAKE_RESULT_DELAY_MS));
        text("Waiting for checks.");
        result("success");
        if (process.env.FAKE_SHELL_MS || !["shell-background-stuck", "shell-background-mixed", "shell-background-nested", "monitor-background-stuck"].includes(scenario)) setTimeout(async () => {
            if (stoppedTasks.has("background-1")) return;
            bgTasks.delete("background-1");
            backgroundChanged();
            await Bun.sleep(Number(process.env.FAKE_SHELL_NOTIFY_MS ?? 80));
            const status = process.env.FAKE_SHELL_STATUS ?? "completed";
            if (shellOutput && type === "local_bash" && !nested) {
                writeFileSync(shellOutput, process.env.FAKE_SHELL_OUTPUT_FROM ? readFileSync(process.env.FAKE_SHELL_OUTPUT_FROM) : process.env.FAKE_SHELL_OUTPUT!);
                // The command repoints its own output file before it ends: a symlink, or a hard link, to another file
                // (FAKE_SHELL_OUTPUT_LINK / _HARDLINK); or its tasks folder a symlink to another one (FAKE_SHELL_TASKS_LINK).
                if (process.env.FAKE_SHELL_OUTPUT_LINK) {
                    unlinkSync(shellOutput);
                    symlinkSync(process.env.FAKE_SHELL_OUTPUT_LINK, shellOutput);
                } else if (process.env.FAKE_SHELL_OUTPUT_HARDLINK) {
                    unlinkSync(shellOutput);
                    linkSync(process.env.FAKE_SHELL_OUTPUT_HARDLINK, shellOutput);
                } else if (process.env.FAKE_SHELL_TASKS_LINK) {
                    renameSync(dirname(shellOutput), process.env.FAKE_SHELL_TASKS_LINK);
                    symlinkSync(process.env.FAKE_SHELL_TASKS_LINK, dirname(shellOutput));
                }
                // As 2.1.304 says it: the file named (or not: FAKE_SHELL_OUTPUT_FILE=unsaid), the exit code in the summary.
                out({ type: "system", subtype: "task_notification", task_id: "background-1", tool_use_id: "background-tool", status, output_file: process.env.FAKE_SHELL_OUTPUT_FILE === "unsaid" ? "" : shellOutput, summary: `Background command "Wait for checks" ${status === "failed" ? "failed" : "completed"} (exit code ${status === "failed" ? 1 : 0})`, session_id: sessionId });
            }
            // Shell/Monitor notifications may have no tool_use_id.
            else out({ type: "system", subtype: "task_notification", task_id: "background-1", status, summary: "Checks passed", session_id: sessionId });
            await Bun.sleep(80);
            queueWake("Background checks passed.");
        }, Number(process.env.FAKE_SHELL_MS ?? 150));
        return;
    }
    if (scenario === "agent-background-hang" || scenario === "bg-shell-hang" || scenario === "bg-monitor-hang" || scenario === "stream-hang") {
        if (scenario === "agent-background-hang") {
            agentCall(true);
            // The sub-agent goes on (and ends) by itself, whatever the turn does.
            const ends = afterResult;
            afterResult = undefined;
            ends?.();
        } else if (scenario !== "stream-hang") {
            const monitor = scenario === "bg-monitor-hang";
            const id = monitor ? "monitor-1" : "background-1";
            if (!monitor) {
                toolUse("background-tool", "Bash", { command: "sleep 150; echo done", description: "Wait for checks", run_in_background: true });
                out({ type: "system", subtype: "task_started", task_id: id, tool_use_id: "background-tool", is_backgrounded: true, task_type: "local_bash", session_id: sessionId });
                toolResult("background-tool", `Command running in background with ID: ${id}`, false);
            }
            bgTasks.set(id, { task_id: id, task_type: monitor ? "monitor_mcp" : "local_bash", description: monitor ? "Watch checks" : "Wait for checks" });
            backgroundChanged();
            if (process.env.FAKE_SHELL_MS) setTimeout(() => finishTask(id, monitor ? "Watch checks" : "Wait for checks"), Number(process.env.FAKE_SHELL_MS));
        }
        if (scenario === "stream-hang") out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Counting: 1, 2, 3" } }, parent_tool_use_id: null, session_id: sessionId });
        else toolUse("toolu_h", "Bash", { command: "sleep 1000" });
        await new Promise<void>((r) => (wake = r));
        if (interrupted) {
            if (scenario !== "stream-hang") toolResult("toolu_h", "The user doesn't want to proceed with this tool use.", true);
            return result("error_during_execution", { terminal_reason: scenario === "stream-hang" ? "aborted_streaming" : "aborted_tools" });
        }
        text("Done.");
        return result("success", { result: "Done." });
    }
    if (scenario === "two-shells") {
        for (const id of ["background-1", "background-2"]) {
            toolUse(`tool-${id}`, "Bash", { command: `sleep 1; echo ${id}`, description: `Check ${id}`, run_in_background: true });
            out({ type: "system", subtype: "task_started", task_id: id, tool_use_id: `tool-${id}`, is_backgrounded: true, task_type: "local_bash", session_id: sessionId });
            toolResult(`tool-${id}`, `Command running in background with ID: ${id}`, false);
            bgTasks.set(id, { task_id: id, task_type: "local_bash", description: `Check ${id}` });
        }
        backgroundChanged();
        text("Started two checks.");
        result("success", { result: "Started two checks." });
        // Both end at once: a report turn for each, one after the other.
        setTimeout(() => {
            finishTask("background-1", "Check background-1");
            finishTask("background-2", "Check background-2");
        }, Number(process.env.FAKE_SHELL_MS ?? 150));
        return;
    }
    if (scenario === "agent-background-ask") {
        const id = "toolu_agent";
        toolUse(id, "Agent", { description: "Map auth", prompt: "Run the tests.", subagent_type: "general-purpose", run_in_background: true });
        bgTasks.set("agent-1", { task_id: "agent-1", task_type: "local_agent", description: "Map auth" });
        backgroundChanged();
        out({ type: "system", subtype: "task_started", task_id: "agent-1", tool_use_id: id, description: "Map auth", is_backgrounded: true, session_id: sessionId });
        out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "Async agent launched successfully.\nagentId: agent-1" }] }] }, parent_tool_use_id: null, session_id: sessionId, tool_use_result: { isAsync: true, status: "async_launched", agentId: "agent-1" } });
        text("Started it.");
        result("success", { result: "Started it." });
        // After the turn: the sub-agent asks to run a command, and reports once it has an answer.
        setTimeout(async () => {
            const input = { command: "npm test", description: "Run tests" };
            sub(id, "assistant", [{ type: "tool_use", id: "toolu_sub_bash", name: "Bash", input }]);
            const request_id = `req-${++seq}`;
            out({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: "Bash", display_name: "Bash", input, tool_use_id: "toolu_sub_bash", agent_id: "agent-1", permission_suggestions: [] } });
            const r: any = await new Promise((resolve) => pending.set(request_id, resolve));
            log({ backgroundAsk: r.behavior });
            sub(id, "user", [{ type: "tool_result", tool_use_id: "toolu_sub_bash", content: r.behavior === "allow" ? "ok" : String(r.message), is_error: r.behavior !== "allow" }]);
            if (stoppedTasks.has("agent-1")) return;
            bgTasks.delete("agent-1");
            out({ type: "system", subtype: "task_updated", task_id: "agent-1", patch: { status: "completed" }, session_id: sessionId });
            out({ type: "system", subtype: "task_notification", task_id: "agent-1", tool_use_id: id, status: "completed", summary: `Tests: ${r.behavior}`, session_id: sessionId });
            backgroundChanged();
            queueWake(`The sub-agent's command was ${r.behavior === "allow" ? "allowed" : "denied"}.`);
        }, 100);
        return;
    }
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
    else if (scenario === "native-agent-write") {
        // A sub-agent's Write, asked with its agent_id as Claude Code does (its task_started names the agent's type).
        const id = "toolu_agent";
        const type = process.env.FAKE_AGENT_TYPE ?? "writer";
        toolUse(id, "Agent", { description: "Write it", prompt: "Write x.txt", subagent_type: type });
        out({ type: "system", subtype: "task_started", task_id: "agent-1", tool_use_id: id, description: "Write it", subagent_type: type, is_backgrounded: false, session_id: sessionId });
        const input = { file_path: join(cwd, "x.txt"), content: "hi" };
        sub(id, "assistant", [{ type: "tool_use", id: "toolu_w", name: "Write", input }]);
        const request_id = `req-${++seq}`;
        out({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: "Write", display_name: "Write", input, tool_use_id: "toolu_w", agent_id: "agent-1", permission_suggestions: [] } });
        const r: any = await new Promise((resolve) => pending.set(request_id, resolve));
        log({ agentWrite: r.behavior });
        sub(id, "user", [{ type: "tool_result", tool_use_id: "toolu_w", content: r.behavior === "allow" ? "Wrote x.txt" : String(r.message), is_error: r.behavior !== "allow" }]);
        toolResult(id, "Done.", false);
        text("Done.");
        return result("success", { result: "Done." });
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
        const fgTask = process.env.FAKE_FG_TASK === "1";
        if (fgTask) out({ type: "system", subtype: "task_started", task_id: "fg-1", tool_use_id: "toolu_h", description: "Sleep for a while", is_backgrounded: false, task_type: "local_bash", session_id: sessionId });
        await new Promise<void>((r) => (wake = r));
        if (interrupted && fgTask) out({ type: "system", subtype: "task_notification", task_id: "fg-1", tool_use_id: "toolu_h", status: "stopped", output_file: "", summary: "Sleep for a while", session_id: sessionId });
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

let turnTail = Promise.resolve();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
    buf += new TextDecoder().decode(chunk);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        // `proc`: the process that received it (its start line has its pid, argv and homes).
        log({ received: m, proc: process.pid });
        if (m.type === "control_request") {
            const sub = m.request?.subtype;
            // FAKE_HANG_INITIALIZE=1: never answers initialize (a CLI stuck starting).
            if (sub === "initialize" && process.env.FAKE_HANG_INITIALIZE === "1") continue;
            if (sub === "initialize") {
                sdkHooks = m.request.hooks ?? {};
                staleTurns();
                out({
                    type: "control_response",
                    response: {
                        subtype: "success",
                        request_id: m.request_id,
                        response: {
                            // An older CLI's (FAKE_OLD_RESULTS) names no prompt in a turn's init: one before 2.1.304.
                            claude_code_version: process.env.FAKE_CLAUDE_VERSION ?? (process.env.FAKE_OLD_RESULTS === "1" ? "2.1.301" : "2.1.304"),
                            models: [
                                { value: "default", supportsFastMode: true, resolvedModel: "claude-test-1", displayName: "Default (recommended)", supportedEffortLevels: ["low", "high"] },
                                { value: "sonnet", resolvedModel: "claude-test-2", displayName: "Sonnet", supportedEffortLevels: ["low", "high"] },
                            ],
                            account: { tokenSource: "none" },
                        },
                    },
                });
            } else if (sub === "mcp_set_servers") {
                if (process.env.FAKE_MCP_REFUSE === "hang") continue;
                if (process.env.FAKE_MCP_REFUSE === "exit") process.exit(3);
                if (process.env.FAKE_MCP_REFUSE === "1") {
                    out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "Unsupported control request subtype: mcp_set_servers" } });
                    continue;
                }
                // Like the CLI: replace the dynamic delegation set, connect, then answer.
                mcpServers.clear();
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
            } else if (sub === "stop_task") {
                if (process.env.FAKE_STOP_TASK === "hang") continue;
                // ends-first: the task finished by itself as the stop came; the stop is refused (nothing left to stop).
                if (process.env.FAKE_STOP_TASK === "ends-first") {
                    const t = bgTasks.get(m.request.task_id);
                    if (t) finishTask(t.task_id, t.description);
                    out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: `No running task ${m.request.task_id}` } });
                    continue;
                }
                if (process.env.FAKE_STOP_TASK === "complete-exit") {
                    bgTasks.delete(m.request.task_id);
                    backgroundChanged();
                    out({ type: "system", subtype: "task_notification", task_id: m.request.task_id, ...(m.request.task_id === "agent-1" ? { tool_use_id: "toolu_agent" } : {}), status: "completed", summary: "Finished just now", handback: "send", handback_report: { text: "Auth keeps its strategies in one list." }, session_id: sessionId });
                    setTimeout(() => process.exit(0), 50);
                    continue;
                }
                // The task completes (with its report) just before the stop is processed; Claude Code answers
                // success for a task it no longer runs (probe: stop_task of an unknown id -> success), then takes its report turn.
                if (process.env.FAKE_STOP_TASK === "complete-first") {
                    const tid = m.request.task_id;
                    setTimeout(() => {
                        bgTasks.delete(tid);
                        out({ type: "system", subtype: "task_notification", task_id: tid, ...(tid === "agent-1" ? { tool_use_id: "toolu_agent" } : {}), status: process.env.FAKE_STOP_STATUS ?? "completed", summary: "Explorer report: auth keeps strategies in one list.", session_id: sessionId });
                        backgroundChanged();
                        out(process.env.FAKE_STOP_ANSWER === "error" ? { type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "No running task" } } : { type: "control_response", response: { subtype: "success", request_id: m.request_id } });
                        setTimeout(() => followUp("Follow-up: the explorer reported back."), Number(process.env.FAKE_FOLLOWUP_MS ?? 100));
                    }, Number(process.env.FAKE_STOP_MS ?? 0));
                    continue;
                }
                // Never answered: a turn of Claude Code's own starts, and during it (after the stop's timeout) the task
                // says it completed (FAKE_STOP_TURN_AT, FAKE_STOP_NOTIFY_AT, FAKE_STOP_RESULT_AT after the stop).
                if (process.env.FAKE_STOP_TASK === "hang-turn") {
                    const tid = m.request.task_id;
                    setTimeout(() => out({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: "none", permissionMode: mode }), Number(process.env.FAKE_STOP_TURN_AT ?? 200));
                    setTimeout(() => {
                        bgTasks.delete(tid);
                        backgroundChanged();
                        out({ type: "system", subtype: "task_notification", task_id: tid, status: "completed", summary: "Checks passed", session_id: sessionId });
                    }, Number(process.env.FAKE_STOP_NOTIFY_AT ?? 600));
                    setTimeout(() => {
                        answering = undefined;
                        text("A turn of its own.");
                        result("success", { result: "A turn of its own." });
                    }, Number(process.env.FAKE_STOP_RESULT_AT ?? 700));
                    continue;
                }
                // The task leaves the list (it ended) and the stop is refused; its notification and report turn come after.
                if (process.env.FAKE_STOP_TASK === "leave-reject") {
                    const tid = m.request.task_id;
                    bgTasks.delete(tid);
                    backgroundChanged();
                    out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "No running task" } });
                    setTimeout(() => out({ type: "system", subtype: "task_notification", task_id: tid, status: "completed", summary: "Checks passed", session_id: sessionId }), 60);
                    setTimeout(() => followUp("Follow-up: the checks passed."), Number(process.env.FAKE_FOLLOWUP_MS ?? 120));
                    continue;
                }
                if (process.env.FAKE_STOP_TASK === "late") {
                    const id = m.request.task_id;
                    const first = lateStops.get(id);
                    if (first) {
                        void first.then(() => out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "No running task" } }));
                        continue;
                    }
                    lateStops.set(id, Bun.sleep(Number(process.env.FAKE_STOP_MS ?? 300)).then(() => {
                        bgTasks.delete(id);
                        stoppedTasks.add(id);
                        backgroundChanged();
                        out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
                        out({ type: "system", subtype: "task_notification", task_id: id, status: "stopped", summary: "Stopped by host", session_id: sessionId });
                    }));
                    continue;
                }
                // fail-first: the task fails by itself just as it's asked to stop; the stop is answered success all the same
                // (as Claude Code answers for a task it no longer runs).
                if (process.env.FAKE_STOP_TASK === "fail-first") {
                    const tid = m.request.task_id;
                    bgTasks.delete(tid);
                    backgroundChanged();
                    out({ type: "system", subtype: "task_notification", task_id: tid, status: "failed", summary: "Failed by itself", session_id: sessionId });
                    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
                    continue;
                }
                // The task completes just as it's asked to stop: it leaves the list, says it completed, and the stop fails.
                if (process.env.FAKE_STOP_TASK === "complete-reject") {
                    bgTasks.delete(m.request.task_id);
                    backgroundChanged();
                    out({ type: "system", subtype: "task_notification", task_id: m.request.task_id, ...(m.request.task_id === "agent-1" ? { tool_use_id: "toolu_agent" } : {}), status: "completed", summary: "Finished just now", session_id: sessionId });
                    out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "No running task" } });
                    continue;
                }
                if (process.env.FAKE_STOP_TASK === "reject") {
                    out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "stop failed" } });
                    continue;
                }
                if (bgTasks.has(m.request.task_id)) out({ type: "system", subtype: "task_updated", task_id: m.request.task_id, patch: { status: "killed" }, session_id: sessionId });
                bgTasks.delete(m.request.task_id);
                stoppedTasks.add(m.request.task_id);
                // As in Claude Code: stopping a sub-agent kills the shells it started (shell-background-nested's).
                if (m.request.task_id === "agent-1" && process.env.FAKE_SCENARIO === "shell-background-nested" && bgTasks.delete("background-1")) stoppedTasks.add("background-1");
                backgroundChanged();
                out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
                out({ type: "system", subtype: "task_notification", task_id: m.request.task_id, status: "stopped", summary: "Stopped by host", session_id: sessionId });
            } else if (sub === "interrupt") {
                if (process.env.FAKE_IGNORE_STOP === "1") continue;
                if (m.request.send_now === true) {
                    // Send now: the queued message goes next, the running turn makes way; nothing else stops.
                    const target = m.request.message_uuid;
                    const said = process.env.FAKE_SEND_NOW ?? (busy && typeof target === "string" && waiting.has(target) ? "stopped" : "nothing_waiting");
                    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { still_queued: [...waiting], send_now: said } } });
                    if (said === "stopped") {
                        interrupted = true;
                        wake?.();
                        goalRelease?.();
                    }
                    continue;
                }
                out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { still_queued: [] } } });
                if (process.env.FAKE_IGNORE_INTERRUPT === "1") continue;
                // As 2.1.304: a plain interrupt stops its background sub-agents too, turn or no turn.
                killAgents();
                if (!busy) continue;
                interrupted = true;
                wake?.();
                goalRelease?.();
            } else if (sub === "cancel_async_message") {
                const target = String(m.request.message_uuid ?? "");
                const had = waiting.delete(target);
                if (had) withdrawn.add(target);
                const answer = () => out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { cancelled: had } } });
                const late = process.env.FAKE_CANCEL_ANSWER_MS;
                if (!late) answer();
                else {
                    // Its lifecycle says it's dropped at once; the answer comes later, or never.
                    if (had) {
                        lifecycle(target, "cancelled");
                        cancelledSaid.add(target);
                    }
                    if (late !== "never") setTimeout(answer, Number(late));
                }
            } else if ((sub === "set_model" || sub === "apply_flag_settings") && process.env.FAKE_SET_MODEL_FAIL === "1") {
                out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: `${sub} failed` } });
            } else {
                if (sub === "set_permission_mode") mode = m.request.mode;
                out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
            }
        } else if (m.type === "control_response") {
            const r = pending.get(m.response?.request_id);
            pending.delete(m.response?.request_id);
            r?.(m.response?.response ?? {});
        } else if (m.type === "user") {
            if (steering) {
                // As Claude Code 2.1.304 does (test/fixtures/protocol/claude-2.1.304-steer-pdf-dropped.jsonl): a
                // mid-turn message's document blocks never reach the model; its images do.
                const dropped = m.message.content.filter((b: any) => b?.type === "document").length;
                if (dropped) log({ droppedMidTurnDocuments: dropped });
                steering.push({ uuid: m.uuid, text: m.message.content.map((b: any) => b.text ?? "").join(""), images: m.message.content.filter((b: any) => b?.type === "image").length });
                recordSent(steering.at(-1)!.text);
                steeringWake?.();
            } else {
                const uuid = typeof m.uuid === "string" ? m.uuid : undefined;
                clearTimeout(idleExit);
                if (uuid) {
                    waiting.add(uuid);
                    lifecycle(uuid, "queued");
                }
                turnTail = turnTail.then(async () => {
                    // FAKE_START_DELAY_MS: the prompt waits in the queue this long before it starts (it can be withdrawn meanwhile).
                    syncEnv();
                    if (process.env.FAKE_START_DELAY_MS) await Bun.sleep(Number(process.env.FAKE_START_DELAY_MS));
                    if (uuid && withdrawn.has(uuid)) return cancelledSaid.has(uuid) ? undefined : lifecycle(uuid, "cancelled");
                    if (uuid) waiting.delete(uuid);
                    busy = true;
                    lifecycle(uuid, "started");
                    try {
                        await turn(m.message?.content ?? [], uuid);
                    } finally {
                        busy = false;
                        lifecycle(uuid, "completed");
                        armIdleExit();
                    }
                });
            }
        }
    }
}
// stdin closed: like the real CLI, exit once nothing's left to do (unless it's stuck).
if (process.env.FAKE_IGNORE_STOP === "1") await new Promise(() => {});
