// A stand-in for `codex app-server`: newline-delimited JSON-RPC with the
// requests, notifications and approval requests the harness uses. A turn
// says something, does one thing (a command by default), and finishes. No
// network.
//
// Like the real CLI (checked against Codex 0.162.1), it asks for approval
// only where its approval policy says so: under "untrusted" for every
// command (`cat` included) and for edits outside a writable sandbox; under
// "on-request" with a workspace-write sandbox it runs commands itself; under
// "never" it asks for nothing. With FAKE_CODEX_TRUSTS=1 it trusts the project
// and loads .codex/config.toml (its model), unless -c projects=… marks the
// folder untrusted.
//
// FAKE_LOG            each line: what it was started with, and what it received (threadMcp: a new thread's mcp_servers)
// FAKE_ACCOUNT        chatgpt (default) | apikey | none
// FAKE_DECLINE=1      offer "decline" among the command's availableDecisions
// FAKE_REVIEW_DENY=1  with approvalsReviewer auto_review, the command leaves the sandbox and Codex's
//                     reviewer turns it down (the client isn't asked); FAKE_REVIEW_NO_COMPLETED=1 leaves out
//                     its item/autoApprovalReview/completed event; FAKE_REVIEW_MIXED=1 adds several more
//                     verdicts, out of step
// FAKE_COMMAND        the command the "cmd" scenario runs (default: touch x); FAKE_COMMAND_SCRIPT the whole
//                     script, where Codex's parsed commandActions leave part of it out; FAKE_COMMAND_RAW
//                     the command exactly as Codex shows it (its shell wrapper, quoted); FAKE_COMMAND_CWD its folder
// It serves turns until stdin closes, as `codex app-server` does: a live session (#219) keeps one across turns.
// The first log line has its pid.
// FAKE_CODEX_SCENARIOS  one scenario per turn, comma-separated (turn n takes the nth, the last one after that)
// FAKE_SCENARIO=bg     the turn starts FAKE_BG_COUNT (default 1) commands that keep running after it (unified exec
//                     terminals with a processId), says so and ends; each ends by itself FAKE_BG_MS (default 300; "never")
//                     later with item/completed (FAKE_BG_EXIT exit code, default 0; FAKE_BG_STAGGER_MS apart). thread/backgroundTerminals/list and
//                     /terminate (only with capabilities.experimentalApi, as 0.163) list and end them; FAKE_TERMINATE_LATE=1:
//                     the command finished by itself just before the terminate (it answers terminated: false)
// FAKE_SCENARIO=bgagent  the turn spawns a sub-agent (thread thr-bg-n) whose turn keeps working after the turn: until
//                     turn/interrupt names its thread, or FAKE_BG_MS (default 300; "never"); FAKE_AGENT_PARENT=hang: the
//                     turn itself works on too, until interrupted; FAKE_CHILD_ASK=1: the sub-agent asks to run a command
//                     FAKE_CHILD_ASK_MS (default 50) in, after its parent's turn is over unless that hangs (as 0.163's
//                     did, #310); the answer is logged (childAsked), and it ends the sub-agent's turn: completed once
//                     approved, else interrupted (as Codex does)
// FAKE_SCENARIO=hang   the turn runs a foreground command (FAKE_HANG_PHASE=tool, default) or streams text
//                     (FAKE_HANG_PHASE=stream) until interrupted (or FAKE_HANG_MS, default 10000)
// FAKE_ENV_FILE       a JSON file of FAKE_* settings, read again with every message: a test changes them between
//                     turns of one live app-server as it would between per-turn ones (only those read per turn)
// FAKE_CRASH_FILE     exits (code 3) as soon as this file exists (and removes it): a crash on demand
// FAKE_IDLE_LIMIT_MS  after a turn ends, sends FAKE_LIMIT_UPDATE's account/rateLimits/updated this much later (idle)
// FAKE_SCENARIO       cmd (default) | rename | perms | slow | mcp | subagent | elicit | web | steps (command, message, command, answer)
//                     | edit (a patch, then work until steered; FAKE_EDIT_FILE, FAKE_EDIT_TEXT, FAKE_EDIT_WAIT)
//                     subagent: Codex's own sub-agent (spawnAgent, then wait): its thread runs a command (which
//                     asks from its thread under untrusted), says something, answers and has usage of its own;
//                     FAKE_CHILD_EARLY=1 sends its first events before the spawn says which thread is whose;
//                     FAKE_RESUME_AGENT=1 resumes the sub-agent (of an earlier turn) instead of spawning it;
//                     FAKE_CHILD_TWICE=1 messages it after it answered, and it works again (=silent: and is
//                     interrupted before it answers)
//                     elicit: an MCP tool call Codex asks about (an elicitation of its own, FAKE_ELICIT=approval,
//                     the default), or an MCP server's form (FAKE_ELICIT=form) or link (FAKE_ELICIT=url)
//                     web: a web search whose query comes only when it completes
// FAKE_PHASES=1       agent messages say their phase (commentary, final_answer), as current models' do
// FAKE_CODEX_SCENARIO  overrides FAKE_SCENARIO here (a fake Claude Code and Codex in one test)
// FAKE_ONE_TURN=1     turn/start is refused while a turn of the thread runs ("a turn is already running")
// FAKE_REJECT_CONFIG=1  thread/start and thread/resume fail when given config, like a Codex that can't parse it
// FAKE_HANG_INIT=1    never answers initialize, and ignores SIGTERM
// FAKE_PERMS          the permissions the "perms" scenario asks for (JSON)
// FAKE_THREAD_TIER     the service tier a resumed thread is already on (e.g. priority from an earlier turn);
// FAKE_CONFIG_TIER     the tier Codex's own config gives a new thread
// FAKE_CODEX_SKILL    a skill of Codex's own that skills/list reports; FAKE_NO_SKILLS=1: an older Codex, without skills/extraRoots/set
// FAKE_SLOW_RESUME, FAKE_SLOW_TURN_START  milliseconds before answering thread/resume, turn/start
// FAKE_TURN_MS        how long every turn works before it answers
// FAKE_STEER_MS       turn/steer is answered that many ms late (refused with FAKE_STEER_FAIL)
// FAKE_STEER_DELAY_MS  milliseconds before answering turn/steer (refused then, with FAKE_STEER_FAIL)
// FAKE_FAIL_TURN_START_AT=n  the nth turn/start fails (no turn starts)
// FAKE_TERMINATE_LATE  1: a terminated command had finished by itself (terminated: false); fail: failed by itself;
//                     after: not terminated, gone from the list, and its own end (a failure) comes after the answer
// FAKE_WHOLE_TURN_AT=n  the nth turn/start's turn runs to its end before turn/start answers
// FAKE_CHILD_REPORT   a bgagent sub-agent's last answer, said as it ends
// FAKE_STARTED_FIRST=1  a turn's turn/started goes out before turn/start's answer
// FAKE_STEER_WAKES=1  turn/steer is refused unless its expectedTurnId is the turn running now; in the "slow"
//                     scenario a steer ends the first turn's wait, and its answer repeats what was steered
// FAKE_MCP_CALLS      the "mcp" scenario's calls to servers from the thread's config: [{ server?, tool, args }]
// FAKE_RATE_LIMITS    a JSON file: account/rateLimits/read's result (without it, the method is unknown, as to an
//                     older Codex); FAKE_LIMIT_UPDATE a JSON file: an account/rateLimits/updated's params, sent as a
//                     turn starts (shapes from Codex 0.163.0's schema and a capture, test/fixtures/limits)
//                     (FAKE_LIMIT_REPEAT=n: n times)
// FAKE_RATE_LIMITS_RELEASE  hold the read's snapshot and turn until this file exists (cross-session races)
// FAKE_CODEX_REROUTED_FIRST=1  FAKE_CODEX_REROUTED applies only to the first turn
// FAKE_SCENARIO=usage-limit  the turn fails on the plan's limit (codexErrorInfo usageLimitExceeded)
// FAKE_GOAL_TURNS     thread goals (thread/goal/get, set, clear): while one is active, each turn that ends (and
//                     making it active while idle) starts another of Codex's own, until this many have run
//                     (default 2) and it's complete;
//                     FAKE_NO_GOALS=1: an older Codex without them; FAKE_GOAL_RACE=1: the first turn/start while the goal is
//                     active loses to a turn Codex starts itself (refused); the usage-limit scenario stops it (usageLimited)
// FAKE_USER_MCP       config/read's mcp_servers: the user's own servers (JSON); FAKE_NO_CONFIG_READ=1 fails config/read
// FAKE_USER_PLUGINS / FAKE_PROJECT_PLUGINS  config/read's plugins table per layer (JSON), as Codex 0.163 reports native plugins
// FAKE_CONFIG_LAYERS  overrides config/read provenance (JSON)
// Hooks: like Codex 0.163, hooks given with -c hooks=… run only when hooks.state trusts them by the hash Codex
//                     computes (sha256 of the normalized handler as sorted JSON). A trusted PreToolUse mcp_tool hook
//                     calls its server's tool before the command, with its input's ${…} placeholders filled in; a
//                     deny stops the command (no item), an allow with updatedInput runs the rewrite (and asks about
//                     it, under the policy). hooks/list reports them. FAKE_NO_HOOKS=1: hooks/list is unknown and no
//                     hook runs (a Codex before 0.160); FAKE_HOOK_SERVER_DOWN=1: the hook's call fails (Codex goes on,
//                     and reports the run failed)
//
// Token usage is each thread's running total, kept beside the log as Codex keeps it with the thread. Like
// Codex 0.163 (checked against it with a stand-in model server), it reports the last usage again on
// thread/resume (with the earlier turn's id) and when a compaction starts.

import { createHash } from "crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { callTool, connect, type McpServerRef } from "./mcp-call";

const log = (o: unknown) => {
    if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\n");
};
const argv = process.argv.slice(2);
const cwd = process.cwd();
log({ argv, pid: process.pid, sawOpenAiKey: Boolean(process.env.OPENAI_API_KEY), sawApiKey: Boolean(process.env.ANTHROPIC_API_KEY), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR, codexHome: process.env.CODEX_HOME, sawOauthToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) });
if (argv[0] === "login") process.exit(0);
if (argv[0] !== "app-server") {
    console.error("fake codex: only app-server");
    process.exit(2);
}
if (process.env.FAKE_HANG_INIT === "1") process.on("SIGTERM", () => log({ ignored: "SIGTERM" }));

/** The project's own config, if it trusts the project (and wasn't told not to). */
function projectModel(): string | undefined {
    if (process.env.FAKE_CODEX_TRUSTS !== "1") return undefined;
    const overrides = argv.filter((_, i) => argv[i - 1] === "-c").join("\n");
    if (overrides.includes(`${JSON.stringify(cwd)}={trust_level="untrusted"}`)) return undefined;
    const f = join(cwd, ".codex", "config.toml");
    return existsSync(f) ? readFileSync(f, "utf-8").match(/model\s*=\s*"([^"]+)"/)?.[1] : undefined;
}

/** FAKE_ENV_FILE's settings, as the test has them now. */
const startedAt = Date.now();
function syncEnv() {
    const f = process.env.FAKE_ENV_FILE;
    // Written before this process started: its environment has it already (and may be newer, set for it alone).
    if (!f || !existsSync(f) || statSync(f).mtimeMs < startedAt) return;
    let env: Record<string, string>;
    try {
        env = JSON.parse(readFileSync(f, "utf-8"));
    } catch {
        return;
    }
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_") && !(k in env) && k !== "FAKE_ENV_FILE" && k !== "FAKE_LOG") delete process.env[k];
    Object.assign(process.env, env);
}
syncEnv();
const baseScenario = () => process.env.FAKE_CODEX_SCENARIO ?? process.env.FAKE_SCENARIO ?? "cmd";
/** The scenario of turn `turnId` (turn-n): FAKE_CODEX_SCENARIOS's nth, else the one for all. */
function scenarioOf(turnId: string): string {
    const list = process.env.FAKE_CODEX_SCENARIOS?.split(",").map((x) => x.trim()).filter(Boolean);
    if (!list?.length) return baseScenario();
    const n = Number(turnId.split("-").pop());
    return list[Math.min(Math.max(1, Number.isFinite(n) ? n : 1), list.length) - 1]!;
}

if (process.env.FAKE_CRASH_FILE) {
    const f = process.env.FAKE_CRASH_FILE;
    setInterval(() => {
        if (!existsSync(f)) return;
        rmSync(f, { force: true });
        log({ crashed: process.pid });
        process.exit(3);
    }, 10);
}

/** initialize asked for experimentalApi (thread/backgroundTerminals/* need it). */
let experimental = false;
/** Commands still running after their turn (unified exec terminals), by processId. */
const terminals = new Map<string, { threadId: string; turnId: string; item: any; timer?: ReturnType<typeof setTimeout> }>();
let processSeq = 40000;
function endTerminal(processId: string, status: string, exitCode: number, output: string) {
    const t = terminals.get(processId);
    if (!t) return;
    terminals.delete(processId);
    if (t.timer) clearTimeout(t.timer);
    log({ terminalEnded: { processId, status, exitCode } });
    notify("item/completed", { threadId: t.threadId, turnId: t.turnId, item: { ...t.item, status, exitCode, aggregatedOutput: output } });
}

/** Hooks given with -c hooks={…} (inline TOML, the subset JSON with = can write). */
const hookConfig: any = (() => {
    const arg = argv.find((a, i) => argv[i - 1] === "-c" && a.startsWith("hooks="));
    return arg ? JSON.parse(arg.slice("hooks=".length).replace(/"=(?=[[{"\d-]|true|false)/g, '":')) : undefined;
})();
const sortedJson = (v: any): any => (Array.isArray(v) ? v.map(sortedJson) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedJson(v[k])])) : v);
/** Codex's hooks from them (PreToolUse, SubagentStart, SubagentStop), each with its key, hash and whether its state trusts it. */
const HOOK_LABELS: Record<string, string> = { PreToolUse: "pre_tool_use", SubagentStart: "subagent_start", SubagentStop: "subagent_stop" };
const nativeHooks = Object.entries(HOOK_LABELS).flatMap(([event, label]) =>
    (hookConfig?.[event] ?? []).flatMap((g: any, gi: number) =>
        (g.hooks ?? []).map((h: any, hi: number) => {
            const normalized = { ...h, timeout: h.timeout ?? 600, ...(h.type === "command" ? { async: Boolean(h.async) } : {}) };
            const hash = `sha256:${createHash("sha256").update(JSON.stringify(sortedJson({ event_name: label, ...(g.matcher ? { matcher: g.matcher } : {}), hooks: [normalized] }))).digest("hex")}`;
            const key = `/<session-flags>/config.toml:${label}:${gi}:${hi}`;
            return { event, key, handler: h, hash, trusted: hookConfig.state?.[key]?.trusted_hash === hash };
        }),
    ),
);
const preToolUseHooks = nativeHooks.filter((h) => h.event === "PreToolUse");
const camel = (label: string) => label.replace(/_(\w)/g, (_, c) => c.toUpperCase());

/** A sub-agent event's trusted mcp_tool hooks, as Codex runs them: their answers, parsed. A missing placeholder fails the hook. */
async function subagentHooks(event: "SubagentStart" | "SubagentStop", threadId: string, turnId: string, input: Record<string, unknown>): Promise<any[]> {
    if (process.env.FAKE_NO_HOOKS === "1") return [];
    const answers: any[] = [];
    for (const h of nativeHooks.filter((x) => x.event === event && x.trusted && x.handler.type === "mcp_tool")) {
        const ev: Record<string, unknown> = { ...input, turn_id: turnId, session_id: threadId, cwd, hook_event_name: event };
        let missing = "";
        const fill = (v: any): any => (typeof v === "string" && /^\$\{(\w+)\}$/.test(v) ? (v.slice(2, -1) in ev ? ev[v.slice(2, -1)] : ((missing = v), undefined)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v);
        const args = fill(h.handler.input ?? {});
        const run = { id: `${HOOK_LABELS[event]}:${h.key}`, eventName: camel(HOOK_LABELS[event]!), handlerType: "mcpTool", source: "sessionFlags", sourcePath: "/<session-flags>/config.toml" };
        const server = mcpServers.get(h.handler.server);
        if (missing || !server) {
            notify("hook/completed", { threadId, turnId, run: { ...run, status: "failed", entries: [{ kind: "error", text: missing ? `hook input placeholder ${missing} is missing` : "not connected" }] } });
            continue;
        }
        const r = await callTool(server, h.handler.tool, args, { threadId });
        log({ hookCalled: { tool: h.handler.tool, input: args, answer: r.text } });
        answers.push(r.text.trim() ? JSON.parse(r.text) : {});
        notify("hook/completed", { threadId, turnId, run: { ...run, status: "completed", entries: [] } });
    }
    return answers;
}

/** Codex's PreToolUse for a call: each trusted mcp_tool hook calls its tool; the last rewrite wins, a deny stops it. */
async function preToolUse(threadId: string, turnId: string, toolName: string, toolInput: Record<string, unknown>, callId: string): Promise<{ deny?: string; updatedInput?: Record<string, unknown> }> {
    if (process.env.FAKE_NO_HOOKS === "1") return {};
    let updatedInput: Record<string, unknown> | undefined;
    for (const h of preToolUseHooks) {
        if (!h.trusted || h.handler.type !== "mcp_tool") continue;
        const event: Record<string, unknown> = { tool_name: toolName, tool_input: toolInput, tool_use_id: callId, turn_id: turnId, session_id: threadId, cwd, hook_event_name: "PreToolUse" };
        const fill = (v: any): any => (typeof v === "string" && /^\$\{(\w+)\}$/.test(v) ? event[v.slice(2, -1)] : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v);
        const run = { id: `pre-tool-use:${h.key}:${callId}`, eventName: "preToolUse", handlerType: "mcpTool", source: "sessionFlags", sourcePath: "/<session-flags>/config.toml" };
        notify("hook/started", { threadId, turnId, run: { ...run, status: "running" } });
        const server = mcpServers.get(h.handler.server);
        let text = "";
        try {
            if (!server || process.env.FAKE_HOOK_SERVER_DOWN === "1") throw new Error(`MCP server ${h.handler.server} isn't connected`);
            const r = await callTool(server, h.handler.tool, fill(h.handler.input ?? {}), { threadId });
            if (r.isError) throw new Error(r.text);
            text = r.text;
            log({ hookCalled: { tool: h.handler.tool, input: fill(h.handler.input ?? {}), answer: text } });
        } catch (e) {
            // Codex goes on with the call when a hook fails.
            notify("hook/completed", { threadId, turnId, run: { ...run, status: "failed", entries: [{ kind: "error", text: (e as Error).message }] } });
            continue;
        }
        const out = text.trim() ? JSON.parse(text)?.hookSpecificOutput : undefined;
        if (out?.permissionDecision === "deny") {
            notify("hook/completed", { threadId, turnId, run: { ...run, status: "blocked", entries: [{ kind: "feedback", text: out.permissionDecisionReason }] } });
            return { deny: String(out.permissionDecisionReason ?? "") };
        }
        if (out?.permissionDecision === "allow" && out.updatedInput) updatedInput = out.updatedInput;
        notify("hook/completed", { threadId, turnId, run: { ...run, status: "completed", entries: [] } });
    }
    return updatedInput ? { updatedInput } : {};
}
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const pending = new Map<number, (r: any) => void>();
let serverSeq = 100;
let turnSeq = 0;
/** Each thread's service tier, as Codex keeps it ("priority", "flex", or null for standard). */
// Codex keeps a thread's tier with the thread, so it outlives this process: kept beside the log.
const tierFile = process.env.FAKE_LOG ? process.env.FAKE_LOG + ".tiers.json" : undefined;
const tiers = new Map<string, string | null>(tierFile && existsSync(tierFile) ? Object.entries(JSON.parse(readFileSync(tierFile, "utf8"))) : []);
// As 0.163 does: no tier (or null, which clears one) is reported as "default".
const setTier = (id: string, tier: unknown) => {
    tiers.set(id, typeof tier === "string" ? tier : "default");
    if (tierFile) writeFileSync(tierFile, JSON.stringify(Object.fromEntries(tiers)));
};
let current: { threadId: string; turnId: string; interrupted: boolean; wake?: () => void; steered?: string[]; done?: boolean } | undefined;
/** Sub-agents' turns still working (bgagent), by their thread. */
const childTurns = new Map<string, { turnId: string; stop: (status: string) => void }>();
type Tokens = { totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
/** Each thread's token usage: its running total, its last response's, and the turn that was in. */
const usageFile = process.env.FAKE_LOG ? process.env.FAKE_LOG + ".usage.json" : undefined;
const usageOf = new Map<string, { total: Tokens; last: Tokens; turnId: string }>(usageFile && existsSync(usageFile) ? Object.entries(JSON.parse(readFileSync(usageFile, "utf8"))) : []);
const tokens = (input: number, cached: number, output: number, reasoning = 0): Tokens => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: reasoning });
/** A response's usage: added to the thread's total, and reported. */
function spend(threadId: string, turnId: string, last: Tokens) {
    const was = usageOf.get(threadId)?.total;
    const total = was ? (Object.fromEntries(Object.entries(was).map(([k, v]) => [k, v + last[k as keyof Tokens]])) as Tokens) : last;
    usageOf.set(threadId, { total, last, turnId });
    if (usageFile) writeFileSync(usageFile, JSON.stringify(Object.fromEntries(usageOf)));
    if (process.env.FAKE_CODEX_REROUTED && (process.env.FAKE_CODEX_REROUTED_FIRST !== "1" || turnSeq === 1)) notify("model/rerouted", { threadId, turnId, toModel: process.env.FAKE_CODEX_REROUTED });
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total, last, modelContextWindow: 400000 } });
}
/** The thread's usage as it last was, reported again (no new spend). */
function repeatUsage(threadId: string, turnId?: string) {
    const u = usageOf.get(threadId);
    if (u) notify("thread/tokenUsage/updated", { threadId, turnId: turnId ?? u.turnId, tokenUsage: { total: u.total, last: u.last, modelContextWindow: 400000 } });
}
const phase = (p: string) => (process.env.FAKE_PHASES === "1" ? { phase: p } : {});
/** MCP servers from the thread's config, connected at thread start. */
const mcpServers = new Map<string, McpServerRef>();

async function startMcp(config: any) {
    for (const [name, cfg] of Object.entries<any>(config?.mcp_servers ?? {})) {
        if (!cfg?.url) continue;
        const s = { url: cfg.url, headers: cfg.http_headers ?? {} };
        try {
            const c = await connect(s);
            mcpServers.set(name, s);
            log({ mcpConnected: name, instructions: c.instructions, tools: c.tools.map((t: any) => t.name), approvalMode: cfg.default_tools_approval_mode, toolTimeoutSec: cfg.tool_timeout_sec });
        } catch (e) {
            log({ mcpFailed: name, error: (e as Error).message });
        }
    }
}

function serverRequest(method: string, params: unknown): Promise<any> {
    const id = ++serverSeq;
    out({ id, method, params });
    return new Promise((resolve) => pending.set(id, resolve));
}

const notify = (method: string, params: unknown) => out({ method, params });
/** Each thread's goal, kept beside the log as Codex keeps it with the thread. */
type Goal = { threadId: string; objective: string; status: string; tokenBudget: null; tokensUsed: number; timeUsedSeconds: number; createdAt: number; updatedAt: number; turns: number };
const goalFile = process.env.FAKE_LOG ? process.env.FAKE_LOG + ".goals.json" : undefined;
const goals = new Map<string, Goal>(goalFile && existsSync(goalFile) ? Object.entries(JSON.parse(readFileSync(goalFile, "utf8"))) : []);
const saveGoals = () => goalFile && writeFileSync(goalFile, JSON.stringify(Object.fromEntries(goals)));
const goalOut = ({ turns: _turns, ...g }: Goal) => g;
let lastPolicy: any = {};
/** FAKE_GOAL_RACE refuses one turn/start, the first it can. */
let racedOnce = false;
let turnStarts = 0;
let refusals = 0;
let startFailures = 0;
let wholeTurns = 0;
/** Turns whose turn/started went out before turn/start answered (FAKE_STARTED_FIRST). */
const startedEarly = new Set<string>();
/** A thread started or resumed with a policy: the goal's turns Codex starts itself run under it, until a turn/start gives another. */
function threadPolicy(p: any) {
    const sandbox: Record<string, string> = { "danger-full-access": "dangerFullAccess", "workspace-write": "workspaceWrite", "read-only": "readOnly" };
    lastPolicy = { approvalPolicy: p.approvalPolicy, sandboxPolicy: { type: sandbox[p.sandbox] }, approvalsReviewer: p.approvalsReviewer };
}
let delayedLimits: (() => void) | undefined;
let releasedLimits: Promise<void> | undefined;

async function runTurn(threadId: string, turnId: string, policy: { approvalPolicy?: string; sandboxPolicy?: { type?: string }; approvalsReviewer?: string }) {
    const scenario = scenarioOf(turnId);
    const t: NonNullable<typeof current> = { threadId, turnId, interrupted: false };
    current = t;
    const finish = (status: string) => {
        t.done = true;
        const g = goals.get(threadId);
        const going = g?.status === "active" && status === "completed";
        if (going) {
            g.turns++;
            g.tokensUsed += 150;
            if (g.turns >= Number(process.env.FAKE_GOAL_TURNS ?? 2)) g.status = "complete";
            saveGoals();
            notify("thread/goal/updated", { threadId, turnId, goal: goalOut(g) });
        }
        notify("turn/completed", { threadId, turn: { id: turnId, status, error: null } });
        if (process.env.FAKE_IDLE_LIMIT_MS && process.env.FAKE_LIMIT_UPDATE) setTimeout(() => notify("account/rateLimits/updated", JSON.parse(readFileSync(process.env.FAKE_LIMIT_UPDATE!, "utf-8"))), Number(process.env.FAKE_IDLE_LIMIT_MS));
        // Still active: Codex goes on with it by itself, unless a turn has started since.
        const goOn = () => void ((!current || current.done) && runTurn(threadId, `turn-${++turnSeq}`, lastPolicy));
        // FAKE_GOAL_CONTINUE_MS: how soon (default 5; 0: at once, before anything else is read).
        if (going && g.status === "active") process.env.FAKE_GOAL_CONTINUE_MS === "0" ? goOn() : setTimeout(goOn, Number(process.env.FAKE_GOAL_CONTINUE_MS ?? 5));
    };
    if (!startedEarly.delete(turnId)) notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
    for (let i = 0; process.env.FAKE_LIMIT_UPDATE && i < Number(process.env.FAKE_LIMIT_REPEAT ?? 1); i++) notify("account/rateLimits/updated", JSON.parse(readFileSync(process.env.FAKE_LIMIT_UPDATE, "utf-8")));
    // Answer an earlier read after the push, before completing the turn.
    delayedLimits?.();
    delayedLimits = undefined;
    await releasedLimits;
    if (process.env.FAKE_TURN_MS) await Bun.sleep(Number(process.env.FAKE_TURN_MS));
    if (scenario === "usage-limit") {
        const error = { message: "You've hit your usage limit. Upgrade to Pro or try again later.", codexErrorInfo: "usageLimitExceeded", additionalDetails: null };
        notify("error", { error, willRetry: false, threadId, turnId });
        t.done = true;
        // Its goal stops there too.
        const g = goals.get(threadId);
        if (g?.status === "active") {
            g.status = "usageLimited";
            saveGoals();
            notify("thread/goal/updated", { threadId, turnId, goal: goalOut(g) });
        }
        return notify("turn/completed", { threadId, turn: { id: turnId, status: "failed", error } });
    }
    notify("item/started", { threadId, turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text: "", ...phase("commentary") } });
    notify("item/agentMessage/delta", { threadId, turnId, itemId: `msg-${turnId}`, delta: "Running it." });
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text: "Running it.", ...phase("commentary") } });
    if (process.env.FAKE_CODEX_LIMIT_UPDATE) notify("account/rateLimits/updated", JSON.parse(process.env.FAKE_CODEX_LIMIT_UPDATE));
    if (process.env.FAKE_LIMIT_ERROR === "1") {
        notify("turn/completed", { threadId, turn: { id: turnId, status: "failed", error: { message: "Usage cap", codexErrorInfo: "usageLimitExceeded" } } });
        return;
    }
    if (scenario === "bg") {
        // Commands that keep running after the turn (Codex 0.163's unified exec, yield_time_ms short of their end).
        for (let i = 0; i < Number(process.env.FAKE_BG_COUNT ?? 1); i++) {
            const processId = String(++processSeq);
            const shown = process.env.FAKE_BG_COMMAND ?? `sleep 1; echo bg ${i + 1}`;
            const item = { type: "commandExecution", id: `exec-${turnId}-${i + 1}`, command: `/bin/zsh -lc '${shown}'`, cwd, status: "inProgress", processId, source: "unifiedExecStartup", commandActions: [{ type: "unknown", command: shown }], aggregatedOutput: null, exitCode: null };
            notify("item/started", { threadId, turnId, item });
            const term: { threadId: string; turnId: string; item: any; timer?: ReturnType<typeof setTimeout> } = { threadId, turnId, item };
            terminals.set(processId, term);
            log({ terminalStarted: { processId, itemId: item.id } });
            if (process.env.FAKE_BG_MS !== "never") term.timer = setTimeout(() => endTerminal(processId, Number(process.env.FAKE_BG_EXIT ?? 0) === 0 ? "completed" : "failed", Number(process.env.FAKE_BG_EXIT ?? 0), `bg ${i + 1} done\n`), Number(process.env.FAKE_BG_MS ?? 300) + i * Number(process.env.FAKE_BG_STAGGER_MS ?? 0));
        }
        notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg2-${turnId}`, text: "Started it in the background.", ...phase("final_answer") } });
        spend(threadId, turnId, tokens(120, 20, 30, 5));
        return finish(t.interrupted ? "interrupted" : "completed");
    }
    if (scenario === "bgagent") {
        const child = `thr-bg-${turnSeq}`;
        const childTurn = `turn-bg-${turnSeq}`;
        const spawn = { type: "collabAgentToolCall", id: `spawn-${turnId}`, tool: "spawnAgent", status: "inProgress", senderThreadId: threadId, receiverThreadIds: [] as string[], prompt: "Watch the build.", model: "", reasoningEffort: "medium", agentsStates: {} };
        notify("item/started", { threadId, turnId, item: spawn });
        notify("item/completed", { threadId, turnId, item: { ...spawn, status: "completed", receiverThreadIds: [child], model: "gpt-test", agentsStates: { [child]: { status: "running", message: null } } } });
        notify("turn/started", { threadId: child, turn: { id: childTurn, rootTurnId: turnId, status: "inProgress" } });
        notify("item/completed", { threadId: child, turnId: childTurn, item: { type: "agentMessage", id: `c-${childTurn}`, text: "Watching.", phase: "commentary" } });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stop = (status: string) => {
            if (!childTurns.delete(child)) return;
            if (timer) clearTimeout(timer);
            log({ childEnded: { thread: child, status } });
            // FAKE_CHILD_REPORT: what it says last (its answer), as it ends.
            if (process.env.FAKE_CHILD_REPORT && status === "completed") notify("item/completed", { threadId: child, turnId: childTurn, item: { type: "agentMessage", id: `c-end-${childTurn}`, text: process.env.FAKE_CHILD_REPORT, phase: "final_answer" } });
            notify("turn/completed", { threadId: child, turn: { id: childTurn, rootTurnId: turnId, status, error: null } });
        };
        childTurns.set(child, { turnId: childTurn, stop });
        log({ childStarted: { thread: child, turn: childTurn } });
        if (process.env.FAKE_BG_MS !== "never") timer = setTimeout(() => stop("completed"), Number(process.env.FAKE_BG_MS ?? 300));
        if (process.env.FAKE_CHILD_ASK === "1")
            setTimeout(async () => {
                if (!childTurns.has(child)) return;
                const command = "touch probe-A.txt";
                const r = await serverRequest("item/commandExecution/requestApproval", { threadId: child, turnId: childTurn, itemId: `ask-${childTurn}`, command, cwd, commandActions: [{ type: "unknown", command }], availableDecisions: ["accept", "decline", "cancel"] });
                log({ childAsked: { thread: child, decision: r?.decision } });
                stop(r?.decision === "accept" ? "completed" : "interrupted");
            }, Number(process.env.FAKE_CHILD_ASK_MS ?? 50));
        if (process.env.FAKE_AGENT_PARENT === "hang") {
            await new Promise<void>((r) => (t.wake = r));
            return finish(t.interrupted ? "interrupted" : "completed");
        }
        notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg2-${turnId}`, text: "It works on in the background.", ...phase("final_answer") } });
        return finish("completed");
    }
    if (scenario === "hang") {
        // Works until interrupted: in a foreground command (tool), or streaming its answer (stream).
        const stream = process.env.FAKE_HANG_PHASE === "stream";
        const cmd = { type: "commandExecution", id: `hang-${turnId}`, command: "/bin/zsh -lc 'sleep 60'", cwd, status: "inProgress", commandActions: [{ type: "unknown", command: "sleep 60" }], aggregatedOutput: null, exitCode: null };
        if (!stream) notify("item/started", { threadId, turnId, item: cmd });
        else notify("item/started", { threadId, turnId, item: { type: "agentMessage", id: `stream-${turnId}`, text: "" } });
        const until = Date.now() + Number(process.env.FAKE_HANG_MS ?? 10000);
        let woken = false;
        const wake = new Promise<void>((r) => (t.wake = () => ((woken = true), r())));
        while (!t.interrupted && Date.now() < until) {
            if (stream) notify("item/agentMessage/delta", { threadId, turnId, itemId: `stream-${turnId}`, delta: "more " });
            await Promise.race([wake, Bun.sleep(20)]);
            if (woken && !t.interrupted) {
                // A steer: it heard it, and goes on.
                woken = false;
                log({ hangSteered: t.steered ?? [] });
            }
        }
        log({ hangEnded: { turnId, interrupted: t.interrupted } });
        if (!stream) notify("item/completed", { threadId, turnId, item: { ...cmd, status: t.interrupted ? "failed" : "completed", exitCode: t.interrupted ? -1 : 0, aggregatedOutput: "" } });
        else notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `stream-${turnId}`, text: "more more" } });
        return finish(t.interrupted ? "interrupted" : "completed");
    }
    if (scenario === "slow" && turnSeq === 1) {
        // The first turn works until interrupted (or a while).
        await Promise.race([new Promise<void>((r) => (t.wake = r)), Bun.sleep(5000)]);
        // FAKE_STEER_WAKES=1: a steer ends the wait, and the answer says what it heard.
        if (t.steered?.length && !t.interrupted) notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg-heard-${turnId}`, text: `Heard: ${t.steered.join(" | ")}` } });
        return finish(t.interrupted ? "interrupted" : "completed");
    }
    if (scenario === "steps") {
        // What a long turn sends: a progress message between its commands, then the answer.
        const ran = (n: number) => {
            const cmd = { type: "commandExecution", id: `cmd${n}-${turnId}`, command: `/bin/zsh -lc 'ls ${n}'`, cwd, status: "inProgress", commandActions: [{ type: "listFiles", command: `ls ${n}` }], aggregatedOutput: null, exitCode: null };
            notify("item/started", { threadId, turnId, item: cmd });
            notify("item/completed", { threadId, turnId, item: { ...cmd, status: "completed", exitCode: 0, aggregatedOutput: "ok\n" } });
        };
        ran(1);
        notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg-mid-${turnId}`, text: "Checked the first.", ...phase("commentary") } });
        ran(2);
        spend(threadId, turnId, tokens(120, 20, 30, 5));
        notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg2-${turnId}`, text: "Finished.", ...phase("final_answer") } });
        return finish("completed");
    }
    if (scenario === "edit") {
        // A patch to FAKE_EDIT_FILE (default a.ts) writing FAKE_EDIT_TEXT; then (FAKE_EDIT_WAIT ms, default 3000)
        // it works on, until steered (with FAKE_STEER_WAKES=1), and its answer repeats what it heard.
        const path = join(cwd, process.env.FAKE_EDIT_FILE ?? "a.ts");
        writeFileSync(path, process.env.FAKE_EDIT_TEXT ?? "");
        const change = { type: "fileChange", id: `fc-${turnId}`, changes: [{ path, kind: { type: "update", move_path: null }, diff: "@@" }], status: "inProgress" };
        notify("item/started", { threadId, turnId, item: change });
        notify("item/completed", { threadId, turnId, item: { ...change, status: "completed" } });
        await Promise.race([new Promise<void>((r) => (t.wake = r)), Bun.sleep(Number(process.env.FAKE_EDIT_WAIT ?? 3000))]);
        log({ steered: t.steered ?? [] });
        notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg-heard-${turnId}`, text: t.steered?.length ? `Heard: ${t.steered.join(" | ")}` : "Done." } });
        return finish(t.interrupted ? "interrupted" : "completed");
    }
    let decision: string | undefined = "accept";
    if (scenario === "mcp") {
        const calls: { server?: string; tool: string; args: Record<string, unknown> }[] = JSON.parse(process.env.FAKE_MCP_CALLS ?? "[]");
        const results: string[] = [];
        for (const [i, c] of calls.entries()) {
            const server = c.server ?? [...mcpServers.keys()][0] ?? "none";
            const s = mcpServers.get(server);
            const item = { type: "mcpToolCall", id: `mcp-${turnId}-${i}`, server, tool: c.tool, arguments: c.args, status: "inProgress", result: null, error: null };
            notify("item/started", { threadId, turnId, item });
            if (!s) {
                notify("item/completed", { threadId, turnId, item: { ...item, status: "failed", error: { message: `unknown MCP server ${server}` } } });
                results.push(`(no server ${server})`);
                continue;
            }
            // Codex's PreToolUse hooks run before every tool call, MCP ones too.
            const hooked = await preToolUse(threadId, turnId, `mcp__${server}__${c.tool}`, c.args, item.id);
            if (hooked.deny !== undefined) {
                notify("item/completed", { threadId, turnId, item: { ...item, status: "failed", error: { message: hooked.deny } } });
                results.push(`(denied: ${hooked.deny})`);
                continue;
            }
            // Codex sends the call's id in the request's _meta.
            const r = await callTool(s, c.tool, c.args, { callId: item.id });
            log({ mcpResult: { tool: c.tool, ...r } });
            notify("item/completed", { threadId, turnId, item: { ...item, status: r.isError ? "failed" : "completed", result: { content: [{ type: "text", text: r.text }], isError: r.isError } } });
            results.push(r.text);
            if (t.interrupted) return finish("interrupted");
        }
        notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg2-${turnId}`, text: results.join("\n---\n") } });
        return finish("completed");
    }
    if (scenario === "subagent") {
        const child = "thr-child";
        const childTurn = `turn-c${turnSeq}`;
        // FAKE_SUBAGENT_V2=1: as multi_agent_v2 announces one, with an item naming its thread rather than a spawn call.
        const v2 = process.env.FAKE_SUBAGENT_V2 === "1";
        const spawn = { type: "collabAgentToolCall", id: `spawn-${turnId}`, tool: "spawnAgent", status: "inProgress", senderThreadId: threadId, receiverThreadIds: [] as string[], prompt: "Count the files\nin src, then report.", model: "", reasoningEffort: "medium", agentsStates: {} };
        const activity = (kind: string) => ({ type: "subAgentActivity", id: `act-${kind}-${turnId}`, kind, agentThreadId: child, agentPath: "/root/count_files", model: "gpt-test", reasoningEffort: "medium" });
        // FAKE_RESUME_AGENT=1: the sub-agent is one of an earlier turn's, resumed (v2: messaged again).
        const resume = process.env.FAKE_RESUME_AGENT === "1";
        if (resume) Object.assign(spawn, { id: `resume-${turnId}`, tool: "resumeAgent", receiverThreadIds: [child], prompt: null });
        const begins = resume ? "interacted" : "started";
        if (v2) {
            notify("item/started", { threadId, turnId, item: activity(begins) });
            notify("item/completed", { threadId, turnId, item: activity(begins) });
        } else notify("item/started", { threadId, turnId, item: spawn });
        const childStarts = async () => {
            // Codex's SubagentStart: what its hooks add goes to the sub-agent, ahead of its prompt.
            const started = await subagentHooks("SubagentStart", child, childTurn, { agent_id: child, agent_type: "default" });
            const context = started.map((a) => a?.hookSpecificOutput?.additionalContext).filter(Boolean);
            if (context.length) log({ subagentContext: context });
            notify("turn/started", { threadId: child, turn: { id: childTurn, rootTurnId: turnId, status: "inProgress" } });
            notify("item/agentMessage/delta", { threadId: child, turnId: childTurn, itemId: "c-msg1", delta: "Looking around." });
            notify("item/completed", { threadId: child, turnId: childTurn, item: { type: "agentMessage", id: "c-msg1", text: "Looking around.", phase: "commentary" } });
            // FAKE_CHILD_MCP={tool,args}: the sub-agent calls one of the harness's MCP tools.
            if (process.env.FAKE_CHILD_MCP) {
                const c = JSON.parse(process.env.FAKE_CHILD_MCP);
                const server = [...mcpServers.keys()][0] ?? "none";
                const item = { type: "mcpToolCall", id: `c-mcp-${turnId}`, server, tool: c.tool, arguments: c.args, status: "inProgress", result: null, error: null };
                notify("item/started", { threadId: child, turnId: childTurn, item });
                const r = await callTool(mcpServers.get(server)!, c.tool, c.args, { callId: item.id });
                log({ mcpResult: { tool: c.tool, ...r } });
                notify("item/completed", { threadId: child, turnId: childTurn, item: { ...item, status: r.isError ? "failed" : "completed", result: { content: [{ type: "text", text: r.text }], isError: r.isError } } });
            }
        };
        // FAKE_CHILD_EARLY=1: its first events come before the spawn says whose thread it is; =all: all of them.
        const early = process.env.FAKE_CHILD_EARLY;
        if (early === "1" || early === "all") await childStarts();
        if (early === "all") await childRest();
        if (!v2) notify("item/completed", { threadId, turnId, item: { ...spawn, status: "completed", receiverThreadIds: [child], model: "gpt-test", agentsStates: { [child]: { status: "pendingInit", message: null } } } });
        const wait = { type: "collabAgentToolCall", id: `wait-${turnId}`, tool: "wait", status: "inProgress", senderThreadId: threadId, receiverThreadIds: [child], prompt: null, model: null, reasoningEffort: null, agentsStates: {} };
        if (!v2) notify("item/started", { threadId, turnId, item: wait });
        if (!early) await childStarts();
        if (early !== "all") await childRest();
        if (v2) {
            notify("item/started", { threadId, turnId, item: activity("completed") });
            notify("item/completed", { threadId, turnId, item: activity("completed") });
        } else notify("item/completed", { threadId, turnId, item: { ...wait, status: "completed", agentsStates: { [child]: { status: "completed", message: "CHILD_REPORT: 2 files." } } } });
        // FAKE_CHILD_TWICE=1: messaged after it answered, the sub-agent works again (a second turn of its thread).
        const twice = process.env.FAKE_CHILD_TWICE;
        if (twice === "1" || twice === "silent") {
            const send = { type: "collabAgentToolCall", id: `send-${turnId}`, tool: "sendInput", status: "inProgress", senderThreadId: threadId, receiverThreadIds: [child], prompt: "Now count the tests.", model: null, reasoningEffort: null, agentsStates: {} };
            notify("item/started", { threadId, turnId, item: send });
            notify("item/completed", { threadId, turnId, item: { ...send, status: "completed" } });
            const again = `${childTurn}b`;
            notify("turn/started", { threadId: child, turn: { id: again, rootTurnId: turnId, status: "inProgress" } });
            const cmd = { type: "commandExecution", id: `c-cmd2-${turnId}`, command: "/bin/zsh -lc 'touch z'", cwd, status: "inProgress", commandActions: [{ type: "unknown", command: "touch z" }], aggregatedOutput: null, exitCode: null };
            notify("item/started", { threadId: child, turnId: again, item: cmd });
            const runsItself = policy.approvalPolicy === "never" || (policy.approvalPolicy === "on-request" && policy.sandboxPolicy?.type === "workspaceWrite");
            const d = runsItself ? "accept" : (await serverRequest("item/commandExecution/requestApproval", { threadId: child, turnId: again, itemId: cmd.id, command: cmd.command, cwd, commandActions: cmd.commandActions, availableDecisions: ["accept", "decline", "cancel"] }))?.decision;
            notify("item/completed", { threadId: child, turnId: again, item: { ...cmd, status: d === "accept" ? "completed" : "declined", exitCode: d === "accept" ? 0 : null, aggregatedOutput: d === "accept" ? "ok\n" : null } });
            if (twice === "silent") notify("turn/completed", { threadId: child, turn: { id: again, rootTurnId: turnId, status: "interrupted", error: null } });
            else {
                notify("item/completed", { threadId: child, turnId: again, item: { type: "agentMessage", id: "c-msg3", text: "CHILD_REPORT: 3 tests.", phase: "final_answer" } });
                notify("turn/completed", { threadId: child, turn: { id: again, rootTurnId: turnId, status: "completed", error: null } });
            }
        }
        async function childRest() {
            // What only concerns the sub-agent's thread: a warning, an error it recovers from, a compaction.
            notify("warning", { threadId: child, message: "Model metadata for `gpt-test` not found." });
            notify("error", { threadId: child, turnId: childTurn, willRetry: false, error: { message: "child stream hiccup" } });
            notify("thread/compacted", { threadId: child, turnId: childTurn });
            const cmd = { type: "commandExecution", id: `c-cmd-${turnId}`, command: "/bin/zsh -lc 'touch y'", cwd, status: "inProgress", commandActions: [{ type: "unknown", command: "touch y" }], aggregatedOutput: null, exitCode: null };
            notify("item/started", { threadId: child, turnId: childTurn, item: cmd });
            notify("item/commandExecution/outputDelta", { threadId: child, turnId: childTurn, itemId: cmd.id, delta: "working\n" });
            const runsItself = policy.approvalPolicy === "never" || (policy.approvalPolicy === "on-request" && policy.sandboxPolicy?.type === "workspaceWrite");
            if (process.env.FAKE_REVIEW_APPROVE === "1") {
                notify("item/autoApprovalReview/completed", { threadId: child, turnId: childTurn, reviewId: `rev-${childTurn}`, targetItemId: cmd.id, action: { type: "command", command: cmd.command }, review: { status: "approved", riskLevel: "low", rationale: "The delegated task needs this command." } });
                notify("guardianWarning", { threadId: child, message: "Automatic approval review approved (risk: low, authorization: high): The delegated task needs this command." });
            }
            const childDecision = runsItself ? "accept" : (await serverRequest("item/commandExecution/requestApproval", { threadId: child, turnId: childTurn, itemId: cmd.id, command: cmd.command, cwd, commandActions: cmd.commandActions, availableDecisions: ["accept", "decline", "cancel"] }))?.decision;
            log({ childRan: childDecision === "accept" });
            notify("item/completed", { threadId: child, turnId: childTurn, item: { ...cmd, status: childDecision === "accept" ? "completed" : "declined", exitCode: childDecision === "accept" ? 0 : null, aggregatedOutput: childDecision === "accept" ? "ok\n" : null } });
            spend(child, childTurn, tokens(5000, 1000, 50));
            notify("item/completed", { threadId: child, turnId: childTurn, item: { type: "agentMessage", id: "c-msg2", text: "CHILD_REPORT: 2 files.", phase: "final_answer" } });
            // Codex's SubagentStop: a block keeps the sub-agent going, its reason as the next prompt; once.
            let last = "CHILD_REPORT: 2 files.";
            for (let active = false; ; active = true) {
                const stopped = await subagentHooks("SubagentStop", child, childTurn, { agent_id: child, agent_type: "default", stop_hook_active: active, last_assistant_message: last });
                const block = stopped.find((a) => a?.decision === "block");
                if (!block || active) break;
                log({ subagentKeptGoing: block.reason });
                last = "CHILD_REPORT: checked again.";
                notify("item/completed", { threadId: child, turnId: childTurn, item: { type: "agentMessage", id: "c-msg2b", text: last, phase: "final_answer" } });
            }
            notify("turn/completed", { threadId: child, turn: { id: childTurn, rootTurnId: turnId, status: "completed", error: null } });
        }
    } else if (scenario === "elicit") {
        const kind = process.env.FAKE_ELICIT ?? "approval";
        const item = { type: "mcpToolCall", id: `mcp-${turnId}`, server: "probe", tool: "write_thing", arguments: { what: "x" }, status: "inProgress", result: null, error: null };
        notify("item/started", { threadId, turnId, item });
        // FAKE_ELICIT_OTHER_CALL=1: another call of the same server, with the same arguments, still open (started after it).
        if (process.env.FAKE_ELICIT_OTHER_CALL === "1") notify("item/started", { threadId, turnId, item: { ...item, id: `mcp-read-${turnId}`, tool: "read_thing" } });
        // As Codex 0.163 sends them: its own question before an MCP tool call, or a server's form or link passed on.
        const params =
            kind === "approval"
                ? { threadId, turnId, serverName: "probe", mode: "form", _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_description: "Writes a thing", tool_params: { what: "x" } }, message: 'Allow the probe MCP server to run tool "write_thing"?', requestedSchema: { type: "object", properties: {} } }
                : kind === "url"
                  ? { threadId, turnId, serverName: "probe", mode: "url", _meta: null, message: "Sign in to Probe.", url: "https://probe.example/login", elicitationId: "el-1" }
                  : { threadId, turnId, serverName: "probe", mode: "form", _meta: null, message: "Which color?", requestedSchema: { type: "object", properties: JSON.parse(process.env.FAKE_ELICIT_FIELDS ?? '{"color":{"type":"string","enum":["red","blue"],"enumNames":["Red","Blue"]},"count":{"type":"integer","title":"How many"},"ok":{"type":"boolean","title":"Sure?"},"tags":{"type":"array","items":{"anyOf":[{"const":"a","title":"Tag A"},{"const":"b","title":"Tag B"}]}},"note":{"type":"string","title":"Note"}}'), required: ["color"] } };
        const r = await serverRequest("mcpServer/elicitation/request", params);
        log({ elicitation: r });
        const ok = r?.action === "accept";
        const error = r?.action === "decline" ? { message: "user rejected MCP tool call" } : r?.action === "cancel" ? { message: "user cancelled MCP tool call" } : null;
        notify("item/completed", { threadId, turnId, item: { ...item, status: ok ? "completed" : "failed", error: ok ? null : error, result: ok ? { content: [{ type: "text", text: `wrote ${JSON.stringify(r?.content)}` }] } : null } });
    } else if (scenario === "web") {
        const ws = { type: "webSearch", id: `ws-${turnId}`, query: "", action: { type: "other" }, results: null };
        notify("item/started", { threadId, turnId, item: ws });
        notify("item/completed", { threadId, turnId, item: { ...ws, query: "bun test runner", action: { type: "search", query: "bun test runner", queries: ["bun test runner"] } } });
    } else if (scenario === "rename") {
        const change = { type: "fileChange", id: `fc-${turnId}`, changes: [{ path: join(cwd, "a.txt"), kind: { type: "update", move_path: join(cwd, "secrets", "a.txt") }, diff: "" }], status: "inProgress" };
        if (process.env.FAKE_UNANNOUNCED !== "1") notify("item/started", { threadId, turnId, item: change });
        decision = (await serverRequest("item/fileChange/requestApproval", { threadId, turnId, itemId: change.id, reason: null, grantRoot: null }))?.decision;
        notify("item/completed", { threadId, turnId, item: { ...change, status: decision === "accept" ? "completed" : "declined" } });
    } else if (scenario === "perms") {
        const permissions = process.env.FAKE_PERMS ? JSON.parse(process.env.FAKE_PERMS) : { network: null, fileSystem: { read: null, write: [join(cwd, "secrets")] } };
        const r = await serverRequest("item/permissions/requestApproval", { threadId, turnId, itemId: `p-${turnId}`, cwd, reason: "needs to write there", permissions });
        log({ granted: r });
    } else {
        let shown = process.env.FAKE_COMMAND ?? "touch x";
        let script = process.env.FAKE_COMMAND_SCRIPT ?? shown;
        const hooked = await preToolUse(threadId, turnId, "Bash", { command: script }, `cmd-${turnId}`);
        if (hooked.deny !== undefined) {
            // Blocked before it starts: no item, the model hears why.
            log({ ran: false, command: shown, blockedByHook: hooked.deny });
            spend(threadId, turnId, tokens(120, 20, 30, 5));
            notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg2-${turnId}`, text: process.env.FAKE_FINAL_TEXT ?? "Finished.", ...phase("final_answer") } });
            return finish(t.interrupted ? "interrupted" : "completed");
        }
        if (hooked.updatedInput) shown = script = String(hooked.updatedInput.command);
        const cmd = { type: "commandExecution", id: `cmd-${turnId}`, command: process.env.FAKE_COMMAND_RAW && !hooked.updatedInput ? process.env.FAKE_COMMAND_RAW : `/bin/zsh -lc '${script}'`, cwd: process.env.FAKE_COMMAND_CWD ?? cwd, status: "inProgress", commandActions: [{ type: "unknown", command: shown }], aggregatedOutput: null, exitCode: null };
        const approve = () => {
            if (process.env.FAKE_REVIEW_APPROVE !== "1") return;
            const review = { threadId, turnId, reviewId: `rev-${turnId}`, targetItemId: cmd.id, action: { type: "command", command: shown, cwd: cmd.cwd, source: "shell" } };
            notify("item/autoApprovalReview/started", { ...review, review: { status: "inProgress" } });
            if (process.env.FAKE_REVIEW_NO_COMPLETED !== "1") notify("item/autoApprovalReview/completed", { ...review, review: { status: "approved", riskLevel: "low", rationale: process.env.FAKE_REVIEW_RATIONALE ?? "The user requested this local test." } });
            notify("guardianWarning", { threadId, message: "Automatic approval review approved (risk: low, authorization: high): The user requested this local test." });
            if (process.env.FAKE_REVIEW_MULTIPLE === "1") {
                const completed = { ...review, reviewId: `rev-second-${turnId}`, review: { status: "approved", riskLevel: "medium", rationale: "The user also requested cleanup." } };
                notify("item/autoApprovalReview/completed", completed);
                notify("item/autoApprovalReview/completed", completed);
                notify("item/autoApprovalReview/completed", { ...completed, reviewId: "no-target", targetItemId: null });
                notify("guardianWarning", { threadId, message: "Automatic approval review approved (risk: medium, authorization: high): The user also requested cleanup." });
                for (const reason of ["A standalone approval.", "Another standalone approval."]) notify("guardianWarning", { threadId, message: `Automatic approval review approved (risk: low, authorization: high): ${reason}` });
            }
        };
        if (process.env.FAKE_REVIEW_TIMING === "before") approve();
        notify("item/started", { threadId, turnId, item: cmd });
        if (!process.env.FAKE_REVIEW_TIMING) approve();
        // Its own policy: in a workspace-write sandbox with on-request, or never, it just runs it.
        const runsItself = policy.approvalPolicy === "never" || (policy.approvalPolicy === "on-request" && policy.sandboxPolicy?.type === "workspaceWrite");
        if (process.env.FAKE_REVIEW_DENY === "1" && policy.approvalsReviewer === "auto_review") {
            const review = { threadId, turnId, reviewId: `rev-${turnId}`, targetItemId: cmd.id, startedAtMs: 1, action: { type: "command", command: shown, cwd: cmd.cwd, source: "shell" } };
            notify("item/autoApprovalReview/started", { ...review, review: { status: "inProgress" } });
            if (process.env.FAKE_REVIEW_NO_COMPLETED !== "1") notify("item/autoApprovalReview/completed", { ...review, completedAtMs: 2, decisionSource: "agent", review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "It sends the project to an unknown host." } });
            // What Codex 0.163 also says about every verdict, and about the reviewer itself.
            notify("guardianWarning", { threadId, message: "Automatic approval review approved (risk: low, authorization: high): The user asked for it." });
            notify("guardianWarning", { threadId, message: "Automatic approval review denied (risk: high, authorization: low): It sends the project to an unknown host." });
            notify("guardianWarning", { threadId, message: "Automatic approval review failed: the reviewer didn't answer" });
            if (process.env.FAKE_REVIEW_MIXED === "1") {
                // Several actions, out of step: B's no comes only as its verdict line, before A's; a timeout
                // (no reason) and then C's no; the same reason as A's from a sub-agent's thread.
                const denied = (why: string, thread = threadId) => notify("guardianWarning", { threadId: thread, message: `Automatic approval review denied (risk: high, authorization: low): ${why}` });
                notify("item/autoApprovalReview/completed", { ...review, reviewId: "rev-a", completedAtMs: 3, decisionSource: "agent", review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "A: deletes the home folder." } });
                denied("B: pushes to main.");
                denied("A: deletes the home folder.");
                notify("item/autoApprovalReview/completed", { ...review, reviewId: "rev-t", completedAtMs: 4, decisionSource: "agent", review: { status: "timedOut" } });
                denied("C: posts the token.");
                denied("A: deletes the home folder.", "thr-sub");
            }
            decision = "decline";
        } else if (!runsItself) {
            const r = await serverRequest("item/commandExecution/requestApproval", {
                threadId,
                turnId,
                itemId: cmd.id,
                command: cmd.command,
                cwd: cmd.cwd,
                commandActions: cmd.commandActions,
                // What Codex 0.162 offers in untrusted mode. Like Codex, the answer isn't checked against it.
                availableDecisions: process.env.FAKE_DECLINE === "1" ? ["accept", "acceptForSession", "decline", "cancel"] : ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: shown.split(" ") } }, "cancel"],
            });
            decision = r?.decision;
        }
        log({ ran: decision === "accept", command: shown });
        if (decision === "accept") notify("item/completed", { threadId, turnId, item: { ...cmd, status: "completed", exitCode: 0, aggregatedOutput: "ok\n" } });
        else notify("item/completed", { threadId, turnId, item: { ...cmd, status: "declined" } });
        if (process.env.FAKE_REVIEW_TIMING === "after") approve();
    }
    spend(threadId, turnId, tokens(120, 20, 30, 5));
    if (decision === "cancel" || t.interrupted) return finish("interrupted");
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg2-${turnId}`, text: process.env.FAKE_FINAL_TEXT ?? "Finished.", ...phase("final_answer") } });
    finish("completed");
}

/** Like Codex: each extra root's <folder>/SKILL.md, named by its frontmatter, at its real path; and one of its own (FAKE_CODEX_SKILL). */
let extraRoots: string[] = [];
function listSkills() {
    const out: { name: string; description: string; path: string; scope: string; enabled: boolean }[] = [];
    if (process.env.FAKE_CODEX_SKILL) out.push({ name: process.env.FAKE_CODEX_SKILL, description: "Codex's own", path: `/codex/skills/${process.env.FAKE_CODEX_SKILL}/SKILL.md`, scope: "system", enabled: true });
    for (const root of extraRoots) {
        for (const folder of existsSync(root) ? readdirSync(root) : []) {
            const file = join(root, folder, "SKILL.md");
            if (!existsSync(file)) continue;
            const name = readFileSync(file, "utf-8").match(/^name:\s*(\S+)/m)?.[1] ?? folder;
            out.push({ name, description: "", path: realpathSync(file), scope: "user", enabled: true });
        }
    }
    return out;
}

async function handle(m: any) {
    syncEnv();
    log({ received: m });
    if (m.method === undefined) {
        const r = pending.get(m.id);
        pending.delete(m.id);
        r?.(m.result);
        return;
    }
    const reply = (result: unknown) => out({ id: m.id, result });
    const fail = (message: string) => out({ id: m.id, error: { code: -32600, message } });
    const p = m.params ?? {};
    if ((m.method === "thread/start" || m.method === "thread/resume") && p.config?.mcp_servers?.harness?.url && process.env.FAKE_REJECT_CONFIG === "1") return fail("invalid config: unknown field `default_tools_approval_mode`");
    switch (m.method) {
        case "initialize":
            if (process.env.FAKE_HANG_INIT === "1") return;
            experimental = p.capabilities?.experimentalApi === true;
            return reply({ userAgent: "fake-codex/0.0.1", codexHome: "/tmp/none", platformFamily: "unix", platformOs: "linux" });
        case "hooks/list":
            if (process.env.FAKE_NO_HOOKS === "1") return out({ id: m.id, error: { code: -32601, message: "Method not found: hooks/list" } });
            return reply({ data: (p.cwds?.length ? p.cwds : [cwd]).map((dir: string) => ({ cwd: dir, warnings: [], errors: [], hooks: nativeHooks.map((h: any, i: number) => ({ key: h.key, eventName: camel(HOOK_LABELS[h.event]!), handlerType: h.handler.type === "mcp_tool" ? "mcpTool" : "command", ...(h.handler.type === "mcp_tool" ? { server: h.handler.server, tool: h.handler.tool } : { command: h.handler.command }), matcher: null, timeoutSec: 600, sourcePath: "/<session-flags>/config.toml", source: "sessionFlags", displayOrder: i, enabled: true, isManaged: false, currentHash: h.hash, trustStatus: h.trusted ? "trusted" : "untrusted" })) })) });
        case "config/read":
            if (process.env.FAKE_NO_CONFIG_READ === "1") return fail("config/read failed: invalid configuration");
            const userMcp = JSON.parse(process.env.FAKE_USER_MCP ?? "{}");
            const projectMcp = JSON.parse(process.env.FAKE_PROJECT_MCP ?? "{}");
            const userPlugins = JSON.parse(process.env.FAKE_USER_PLUGINS ?? "null");
            const projectPlugins = JSON.parse(process.env.FAKE_PROJECT_PLUGINS ?? "null");
            const plugins = userPlugins || projectPlugins ? { plugins: { ...userPlugins, ...projectPlugins } } : {};
            return reply({
                config: { model: null, mcp_servers: { ...userMcp, ...projectMcp }, ...plugins },
                origins: {},
                ...(process.env.FAKE_NO_CONFIG_LAYERS === "1" ? {} : { layers: process.env.FAKE_CONFIG_LAYERS ? JSON.parse(process.env.FAKE_CONFIG_LAYERS) : [
                    // Highest precedence first, as Codex 0.163 lists them.
                    { name: { type: "project", dotCodexFolder: `${cwd}/.codex` }, config: { mcp_servers: projectMcp, ...(projectPlugins ? { plugins: projectPlugins } : {}) } },
                    { name: { type: "user", file: "/tmp/fake/config.toml" }, config: { mcp_servers: userMcp, ...(userPlugins ? { plugins: userPlugins } : {}) } },
                ] }),
            });
        case "initialized":
            return;
        case "account/read": {
            const a = process.env.FAKE_ACCOUNT ?? "chatgpt";
            return reply(a === "none" ? { account: null, requiresOpenaiAuth: true } : a === "apikey" ? { account: { type: "apiKey" }, requiresOpenaiAuth: true } : { account: { type: "chatgpt", email: process.env.FAKE_EMAIL ?? "me@example.com", planType: process.env.FAKE_PLAN ?? "plus" }, requiresOpenaiAuth: true });
        }
        case "model/list":
            return reply({
                data: [
                    { id: "gpt-hidden", model: "gpt-hidden", displayName: "Hidden", hidden: true, isDefault: false, supportedReasoningEfforts: [], inputModalities: ["text"] },
                    { id: "gpt-other", model: "gpt-other", displayName: "Other", hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }], inputModalities: ["text"] },
                    // As Codex 0.163 lists it: the tier is "priority", the legacy field still says "fast".
                    { serviceTiers: [{ id: "priority", name: "Fast", description: "Fast service" }], additionalSpeedTiers: ["fast"], defaultServiceTier: null, id: "gpt-test", model: "gpt-test", displayName: "GPT Test", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], inputModalities: ["text", "image"] },
                ],
                nextCursor: null,
            });
        case "thread/start":
            log({ threadMcp: p.config?.mcp_servers ?? null });
            // A one-off: an ephemeral thread answering one question (FAKE_ONEOFF_ANSWER).
            if (p.ephemeral) {
                log({ oneOffThread: { baseInstructions: p.baseInstructions, config: p.config, approvalPolicy: p.approvalPolicy, sandbox: p.sandbox, cwd: p.cwd } });
                return reply({ thread: { id: "thr-oneoff" }, model: p.model ?? "gpt-test" });
            }
            threadPolicy(p);
            await startMcp(p.config);
            setTier("thr-new", "serviceTier" in p ? p.serviceTier : (process.env.FAKE_CONFIG_TIER ?? null));
            // A new thread starts with no usage.
            usageOf.delete("thr-new");
            return reply({ thread: { id: "thr-new" }, model: projectModel() ?? p.model ?? "gpt-test", serviceTier: tiers.get("thr-new") ?? "default" });
        case "thread/resume":
            if (process.env.FAKE_SLOW_RESUME) await Bun.sleep(Number(process.env.FAKE_SLOW_RESUME));
            if (String(p.threadId).startsWith("gone") || p.threadId === process.env.FAKE_GONE_ID) return fail(`thread not found: ${p.threadId}`);
            threadPolicy(p);
            await startMcp(p.config);
            if (!tiers.has(p.threadId)) setTier(p.threadId, process.env.FAKE_THREAD_TIER ?? null);
            if ("serviceTier" in p) setTier(p.threadId, p.serviceTier);
            reply({ thread: { id: p.threadId }, model: projectModel() ?? p.model ?? "gpt-test", serviceTier: tiers.get(p.threadId) ?? "default" });
            // The thread's last usage again, with that earlier turn's id.
            repeatUsage(p.threadId);
            return;
        case "thread/fork": {
            // A copy of the thread, under a new id. Like Codex 0.163's, it carries on the thread's running
            // usage total (its next report's total includes what the original spent), and reports nothing now.
            if (String(p.threadId).startsWith("gone")) return fail(`thread not found: ${p.threadId}`);
            await startMcp(p.config);
            const id = `thr-fork-${Math.random().toString(36).slice(2, 8)}`;
            const u = usageOf.get(p.threadId);
            if (u) {
                usageOf.set(id, { ...u });
                if (usageFile) writeFileSync(usageFile, JSON.stringify(Object.fromEntries(usageOf)));
            }
            return reply({ thread: { id }, model: projectModel() ?? p.model ?? "gpt-test", serviceTier: "default" });
        }
        case "turn/start": {
            if (p.threadId === "thr-oneoff") {
                log({ oneOffPrompt: p.input?.[0]?.text });
                reply({ turn: { id: "turn-oneoff", status: "inProgress" } });
                const fail = process.env.FAKE_ONEOFF_FAIL;
                if (!fail) notify("item/completed", { threadId: "thr-oneoff", turnId: "turn-oneoff", item: { type: "agentMessage", id: "o-msg", text: process.env.FAKE_ONEOFF_ANSWER ?? '{"ok": true}', phase: "final_answer" } });
                notify("turn/completed", { threadId: "thr-oneoff", turn: { id: "turn-oneoff", status: fail ? "failed" : "completed", error: fail ? { message: fail } : null } });
                break;
            }
            // FAKE_FAIL_TURN_START_AT=n: the nth turn/start fails, and nothing starts.
            if (process.env.FAKE_FAIL_TURN_START_AT && ++startFailures === Number(process.env.FAKE_FAIL_TURN_START_AT)) return fail("Codex couldn't start the turn");
            // FAKE_ONE_TURN=1: one turn at a time, as a thread runs them; another turn/start meanwhile is refused.
            if (process.env.FAKE_ONE_TURN === "1" && current && !current.done && current.threadId === p.threadId) return fail("a turn is already running");
            // FAKE_GOAL_RACE=1: with the goal active, Codex has just started its own next turn, and refuses this one.
            const raced = goals.get(p.threadId);
            // FAKE_REFUSE_TURN_START_AT=n: the nth turn/start is refused that way, the goal active or not (its pause not taken in yet).
            if (process.env.FAKE_REFUSE_TURN_START_AT && ++refusals === Number(process.env.FAKE_REFUSE_TURN_START_AT) && (!current || current.done)) {
                void runTurn(p.threadId, `turn-${++turnSeq}`, lastPolicy);
                return fail("a turn is already running");
            }
            if (process.env.FAKE_GOAL_RACE === "1" && !racedOnce && raced?.status === "active" && (!current || current.done)) {
                racedOnce = true;
                void runTurn(p.threadId, `turn-${++turnSeq}`, lastPolicy);
                return fail("a turn is already running");
            }
            // Like Codex's: a value (or null) changes the thread's tier from this turn on; leaving it out keeps it.
            if ("serviceTier" in p) setTier(p.threadId, p.serviceTier);
            const turnId = `turn-${++turnSeq}`;
            lastPolicy = p;
            if (process.env.FAKE_SLOW_TURN_START && turnSeq === 1) await Bun.sleep(Number(process.env.FAKE_SLOW_TURN_START));
            // FAKE_SLOW_TURN_START_AT=n:ms: the nth turn/start answers that late.
            const slowAt = process.env.FAKE_SLOW_TURN_START_AT?.split(":").map(Number);
            if (slowAt && ++turnStarts === slowAt[0]) await Bun.sleep(slowAt[1]!);
            // FAKE_STARTED_FIRST=1: the turn's turn/started goes out before turn/start's answer.
            if (process.env.FAKE_STARTED_FIRST === "1") {
                startedEarly.add(turnId);
                notify("turn/started", { threadId: p.threadId, turn: { id: turnId, status: "inProgress" } });
            }
            // FAKE_WHOLE_TURN_AT=n: the nth turn/start's turn runs to its end before turn/start answers.
            if (process.env.FAKE_WHOLE_TURN_AT && ++wholeTurns === Number(process.env.FAKE_WHOLE_TURN_AT)) {
                await runTurn(p.threadId, turnId, p);
                return reply({ turn: { id: turnId, status: "inProgress" } });
            }
            reply({ turn: { id: turnId, status: "inProgress" } });
            void runTurn(p.threadId, turnId, p);
            return;
        }
        case "skills/extraRoots/set":
            // A Codex from before skills/extraRoots/set (FAKE_NO_SKILLS=1).
            if (process.env.FAKE_NO_SKILLS === "1") return fail(`unknown method ${m.method}`);
            extraRoots = p.extraRoots;
            return reply({});
        case "skills/list":
            return reply({ data: [{ cwd: p.cwds?.[0] ?? cwd, skills: listSkills(), errors: [] }] });
        case "thread/backgroundTerminals/list":
            if (!experimental) return fail(`${m.method} requires experimentalApi capability`);
            return reply({ data: [...terminals.entries()].filter(([, t]) => t.threadId === p.threadId).map(([processId, t]) => ({ itemId: t.item.id, processId, command: t.item.command, cwd, osPid: null, cpuPercent: null, rssKb: null })), nextCursor: null });
        case "thread/backgroundTerminals/terminate": {
            if (!experimental) return fail(`${m.method} requires experimentalApi capability`);
            const pid = String(p.processId);
            if (!terminals.has(pid)) return reply({ terminated: false });
            log({ terminated: pid });
            // It had just finished by itself (=fail: failed by itself, exit code 1).
            if (process.env.FAKE_TERMINATE_LATE === "1" || process.env.FAKE_TERMINATE_LATE === "fail") {
                const failed = process.env.FAKE_TERMINATE_LATE === "fail";
                endTerminal(pid, failed ? "failed" : "completed", failed ? 1 : 0, failed ? "boom\n" : "finished first\n");
                return reply({ terminated: false });
            }
            // =after: it's ending by itself: not terminated, gone from the list, and its end comes a moment later.
            if (process.env.FAKE_TERMINATE_LATE === "after") {
                const t = terminals.get(pid)!;
                terminals.delete(pid);
                reply({ terminated: false });
                setTimeout(() => {
                    terminals.set(pid, t);
                    endTerminal(pid, "failed", 1, "boom\n");
                }, 150);
                return;
            }
            reply({ terminated: true });
            return endTerminal(pid, "failed", -1, "");
        }
        case "turn/interrupt":
            // FAKE_IGNORE_INTERRUPT=1: answers, and the turn goes on.
            if (process.env.FAKE_IGNORE_INTERRUPT === "1") return reply({});
            log({ interrupt: { threadId: p.threadId, turnId: p.turnId } });
            // A sub-agent's turn (bgagent): only that one stops.
            if (childTurns.get(p.threadId)?.turnId === p.turnId) {
                childTurns.get(p.threadId)!.stop("interrupted");
                return reply({});
            }
            if (current) {
                current.interrupted = true;
                current.wake?.();
            }
            return reply({});
        case "turn/steer":
            // FAKE_STEER_MS: answered that late (as FAKE_STEER_FAIL says), and other requests go on meanwhile.
            if (process.env.FAKE_STEER_MS) {
                setTimeout(() => (process.env.FAKE_STEER_FAIL ? fail("no active turn to steer") : reply({ turnId: p.expectedTurnId })), Number(process.env.FAKE_STEER_MS));
                return;
            }
            // FAKE_STEER_DELAY_MS: answered this late (refused then, with FAKE_STEER_FAIL).
            if (process.env.FAKE_STEER_DELAY_MS) await Bun.sleep(Number(process.env.FAKE_STEER_DELAY_MS));
            // FAKE_STEER_FAIL: the turn has already ended.
            if (process.env.FAKE_STEER_FAIL) return fail("no active turn to steer");
            if (process.env.FAKE_STEER_WAKES === "1") {
                // As Codex checks it: only the turn running now takes it.
                if (!current || current.done || current.turnId !== p.expectedTurnId) return fail("expected turn does not match the active turn");
                (current.steered ??= []).push(p.input?.[0]?.text ?? "");
                current.wake?.();
            }
            return reply({ turnId: p.expectedTurnId });
        case "thread/compact/start": {
            reply({});
            // As 0.163 runs it: a turn, which first reports the usage as it was, then the compaction's.
            const turnId = `turn-${++turnSeq}`;
            notify("turn/started", { threadId: p.threadId, turn: { id: turnId, status: "inProgress" } });
            notify("item/started", { threadId: p.threadId, turnId, item: { type: "contextCompaction", id: `cc-${turnId}` } });
            repeatUsage(p.threadId, turnId);
            spend(p.threadId, turnId, tokens(400, 0, 40));
            notify("item/completed", { threadId: p.threadId, turnId, item: { type: "contextCompaction", id: `cc-${turnId}` } });
            notify("turn/completed", { threadId: p.threadId, turn: { id: turnId, status: "completed", error: null } });
            return;
        }
        case "thread/goal/get":
            if (process.env.FAKE_NO_GOALS === "1") return fail(`unknown method ${m.method}`);
            return reply({ goal: goals.has(p.threadId) ? goalOut(goals.get(p.threadId)!) : null });
        case "thread/goal/set": {
            if (process.env.FAKE_NO_GOALS === "1") return fail(`unknown method ${m.method}`);
            const was = goals.get(p.threadId);
            if (!was && !p.objective) return fail("no goal to update");
            const now = Math.floor(Date.now() / 1000);
            const g: Goal = { ...(was ?? { threadId: p.threadId, objective: "", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: now, updatedAt: now, turns: 0 }), ...(p.objective ? { objective: p.objective } : {}), ...(p.status ? { status: p.status } : {}), updatedAt: now };
            goals.set(p.threadId, g);
            saveGoals();
            reply({ goal: goalOut(g) });
            notify("thread/goal/updated", { threadId: p.threadId, turnId: null, goal: goalOut(g) });
            // Made active while the thread is idle: Codex goes on with it by itself.
            if (g.status === "active" && (!current || current.done)) setTimeout(() => void runTurn(p.threadId, `turn-${++turnSeq}`, lastPolicy), 5);
            return;
        }
        case "thread/goal/clear": {
            if (process.env.FAKE_NO_GOALS === "1") return fail(`unknown method ${m.method}`);
            const had = goals.delete(p.threadId);
            saveGoals();
            reply({ cleared: had });
            if (had) notify("thread/goal/cleared", { threadId: p.threadId });
            return;
        }
        case "account/rateLimits/read":
            if (process.env.FAKE_CODEX_LIMIT_READ) return reply(JSON.parse(process.env.FAKE_CODEX_LIMIT_READ));
            if (!process.env.FAKE_RATE_LIMITS) return fail(`unknown method ${m.method}`);
            if (process.env.FAKE_RATE_LIMITS_RELEASE) {
                const snapshot = JSON.parse(readFileSync(process.env.FAKE_RATE_LIMITS, "utf-8"));
                const release = process.env.FAKE_RATE_LIMITS_RELEASE;
                releasedLimits = (async () => {
                    const until = Date.now() + 5000;
                    while (!existsSync(release) && Date.now() < until) await Bun.sleep(5);
                    reply(snapshot);
                    log({ limitsReadReplied: true });
                })();
                return;
            }
            if (process.env.FAKE_RATE_LIMITS_DELAY === "1") {
                delayedLimits = () => reply(JSON.parse(readFileSync(process.env.FAKE_RATE_LIMITS!, "utf-8")));
                return;
            }
            return reply(JSON.parse(readFileSync(process.env.FAKE_RATE_LIMITS, "utf-8")));
        default:
            return fail(`unknown method ${m.method}`);
    }
}

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
    buf += new TextDecoder().decode(chunk);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) void handle(JSON.parse(line));
    }
}
if (process.env.FAKE_HANG_INIT === "1") await new Promise(() => {});
// Stdin closed: the app-server exits (its background terminals and timers with it).
process.exit(0);
