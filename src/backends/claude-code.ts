// Claude Code as an agent backend: the user's own installed `claude`, signed
// in by the user (their Claude plan, or whatever they set up in Claude Code).
//
// Each turn starts `claude -p` with stream-json input and output, the protocol
// Anthropic documents for driving Claude Code from another program (the Agent
// SDK speaks it too). Claude Code runs the turn with its own system prompt,
// tools and context management; the harness shows the stream and answers the
// permission prompts Claude Code sends over stdio (can_use_tool). Sessions
// continue with --resume.
//
// Claude Code runs sub-agents in the background by default. Their result
// comes after the turn's: Claude Code says what runs in the background
// (background_tasks_changed), when each is done (task_notification), and then
// takes a turn of its own with the report (a result with origin
// task-notification). So a run lasts until the prompts it sent are answered
// (each result names the prompt it answers, by the uuid it was sent with) and
// nothing it waits for is left in the background. Sub-agents and workflows
// run until they're done or the user stops them, as in Claude Code (no limit
// by default: backgroundTiming.maxWaitMs); background commands until their
// own timeout or the grace for one without.
//
// What this never does: read, copy or forward Claude Code's credentials (its
// keychain entry, ~/.claude/.credentials.json, CLAUDE_CODE_OAUTH_TOKEN), call
// Anthropic's API with them, or change the binary. Anthropic's terms allow an
// end user to sign in to the unmodified Claude Code binary with their own
// subscription, and forbid other programs collecting or routing requests
// through those credentials. The harness's own provider keys are removed from
// the CLI's environment (childEnv), so it can't be pointed at one of those.

import type { HookConfig } from "../config/settings";
import { backendMatcher, claudeCodeHookOutput, type HookEvent } from "../agent/hooks";
import { homedir } from "os";
import type { AssistantMessage, ChatRequest, ImagePart, ModelInfo, PdfPart, Usage } from "../providers/types";
import { ONE_OFF_TIMEOUT_MS, oneOffAnswer, oneOffPrompt, oneOffRefusal } from "./one-off";
import { ProviderError } from "../providers/types";
import type { ProviderDef } from "../providers/registry";
import type { PlanLimits } from "../server/protocol";
import { limitAccountLabel, limitNews, mergeLimits, parseClaudeRateLimit, resetPhrase, resetSentence } from "./limits";
import { accountEnv, defaultAccount } from "../providers/accounts";
import { signInAdvice } from "./account-login";
import { accountProtectionFolders } from "./account-permissions";
import type { PermissionMode } from "../permissions/modes";
import type { ToolDisplay } from "../tools/types";
import { diffLines, diffStats } from "../util/diff";
import { parseRule, pathPattern } from "../permissions/rules";
import { APP_TITLE, paths } from "../config/paths";
import { redact } from "../util/redact";
import { cliCommandNames } from "../commands/custom";
import { formatSkill } from "../agent/skills";
import { CLAUDE_PREFIX, claudeNames, claudePrompt, forClaudeCode, skillFolder } from "./native-skills";
import { CLAUDE_CLI, JsonLinesProcess, cliMessage, cliStatusString, commandTitle, extraArgs, requireCli, runCli, stopTiming } from "./cli";
import { claudeMcpPolicy } from "./claude-mcp-policy";
import { writeAgentsFile } from "./claude-agents";
import { backendModel, type AgentBackendClient, type BackgroundStop, type SessionHost, type TurnSink, type BackendResult, type BackendTurn, type SteerMessage, type BackendWake } from "./types";
import type { BackgroundTaskInfo } from "./live/info";
import type { TurnEndReason } from "../agent/agent";
import type { NativeGoal } from "../agent/goal";
import { ClaudeGoalWatch, claudeTranscriptFile } from "./claude-goal";
import { ClaudeLive } from "./claude-live";
import type { AgentCliStatus } from "./index";

/** checkAgentCli, imported when it's asked for (index.ts imports this file). */
async function checkAgentCliLazy(providerId: string, signal?: AbortSignal, accountId?: string): Promise<AgentCliStatus> {
    return (await import("./index")).checkAgentCli(providerId, signal, accountId);
}

/** How often the transcript is looked at for the goal's progress while Claude Code runs. */
const GOAL_POLL_MS = 400;

/** How long each turn waits for approved MCP servers and delegation before sending the prompt (changeable for tests). */
export const attachTiming = { timeoutMs: 30_000 };

/** Waiting on Claude Code's background work once the prompt is answered (changeable for tests). */
export const backgroundTiming = {
    /**
     * A cap on the wait for sub-agents, workflows and other background work, across report turns; none by
     * default, as Claude Code has none: they run until they're done or the user stops them (Esc). It doesn't
     * stop a command still within its own timeout. Tests set one.
     */
    maxWaitMs: Number.POSITIVE_INFINITY,
    /**
     * The cap for background commands without a timeout of their own and for monitors, across report turns:
     * a monitor's grace starts again with each report, so one that reports often would otherwise keep the run
     * going for good. A command still within its own timeout isn't cut short. (At most maxWaitMs, when that's set.)
     */
    commandsMaxWaitMs: 60 * 60_000,
    /** After Claude Code exits, how long its output may stay quiet before it's no longer read (a child it started may hold it open). */
    exitDrainMs: 2000,
    /** The grace for a background command that passes no timeout, and for monitors: Claude Code's default background timeout. */
    commandWaitMs: 30 * 60_000,
    /** The most a background command's own timeout can give it: Claude Code's maximum background timeout. */
    commandMaxTimeoutMs: 2 * 60 * 60_000,
    /** A selective stop must answer promptly, or shutdown is the only safe fallback. */
    stopTimeoutMs: 5000,
    /** After one ends, how long Claude Code has to start its turn with the report before the run ends without it. */
    settleMs: 3000,
    /** How often to look for messages the user sent meanwhile (they go to Claude Code in the same run). */
    pollMs: 300,
};

/** The grace for a background command without a timeout of its own, and for monitors: the setting (seconds), else the default. */
export function claudeBackgroundWaitMs(seconds: unknown): number {
    return typeof seconds === "number" && seconds >= 0 && Number.isFinite(seconds * 1000) ? seconds * 1000 : backgroundTiming.commandWaitMs;
}

/**
 * A background Bash call's own timeout (ms): in Claude Code, how long the
 * command may run in the background (capped at commandMaxTimeoutMs where
 * it's used). Undefined when the call passed none or doesn't run in the
 * background (then the grace above applies).
 */
export function claudeCommandTimeoutMs(input: Record<string, unknown>): number | undefined {
    const t = input.timeout;
    if (input.run_in_background !== true || typeof t !== "number" || !(t > 0) || !Number.isFinite(t)) return undefined;
    return t;
}

/** A duration for a notice or the prompt: minutes from one up, else seconds. */
const span = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.ceil(ms / 1000)}s`);

/** Deliberately conservative command heuristic, never run on an agent's prose. */
export function longLivedClaudeCommand(command: string): boolean {
    return command.split(/(?:&&|\|\||[;\n])/).some((part) => {
        const words = part.trim().split(/\s+/).map((w) => w.replace(/^["']|["']$/g, ""));
        while (words[0] === "env" || /^[A-Za-z_][A-Za-z_0-9]*=/.test(words[0] ?? "")) words.shift();
        const exe = words[0]?.split("/").at(-1);
        if (["echo", "printf"].includes(exe ?? "")) return false;
        // Honor explicit disabling values and later overrides (e.g. --watch --no-watch).
        let watch = false;
        for (const word of words) {
            if (word === "--no-watch") watch = false;
            else if (word === "--watch") watch = true;
            else if (word.startsWith("--watch=")) watch = !["", "false", "0"].includes(word.slice(8).replace(/^["']|["']$/g, "").toLowerCase());
        }
        if (watch) return true;
        if (exe === "tail") return words.some((w) => /^-(?:[^-]*[fF]|-follow)(?:$|=)/.test(w));
        if (["dev", "serve", "start", "watch"].includes(exe ?? "")) return true;
        if (exe === "vite") return !words.slice(1).some((w) => ["build", "optimize", "--help", "--version", "-h", "-v"].includes(w));
        if (["bun", "npm", "pnpm", "yarn"].includes(exe ?? "")) {
            const script = words[1] === "run" ? words[2] : words[1];
            return /^(?:dev|serve|start|watch)(?::[\w-]+)?$/.test(script ?? "");
        }
        return false;
    });
}

interface BackgroundWork {
    id?: string;
    agent: boolean;
    /** Shell or Monitor: subject to the shorter grace. */
    commandTask?: boolean;
    monitor?: boolean;
    command?: string;
    /** A background Bash command's own timeout (ms), and when it started: it may run until then. */
    timeoutMs?: number;
    started?: number;
    /** A sub-agent's Agent call. */
    toolUseId?: string;
    label: string;
}

/** What a background sub-agent's Agent call says when it ends without a report. */
export const LAUNCH_END: Record<string, string> = {
    done: "Claude Code passed on no report from this sub-agent.",
    error: "The sub-agent failed.",
    aborted: "The sub-agent was stopped before it reported back.",
};

/** A sub-agent that ended this way failed or was stopped: its call's row says so, as its chip does. */
export const endedBadly = (reason: TurnEndReason) => reason !== "done" && reason !== "max_turns";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Claude Code's tools that change files, off for a read-only sub-agent. */
const READ_ONLY_DENY = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
/** Claude Code's own scheduling, which needs its process to stay up between turns. */
export const CLAUDE_SCHEDULE_TOOLS = ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup"];

const STREAM_ARGS = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];

/**
 * Claude Code's modes for the harness's. Not acceptEdits for acceptEdits:
 * Claude Code's own also runs file commands (rm, mv, sed) without asking,
 * where the harness's still asks for shell commands. It runs in default mode
 * instead, and the harness approves its edits inside the workspace itself.
 */
export const MODES: Record<PermissionMode, string> = {
    default: "default",
    acceptEdits: "default",
    plan: "plan",
    auto: "auto",
    bypassPermissions: "bypassPermissions",
};

export interface ClaudeStatus {
    loggedIn: boolean;
    /** oauth_token (a Claude plan), api_key, or how else Claude Code authenticates. */
    authMethod?: string;
    apiProvider?: string;
    email?: string;
    subscriptionType?: string;
}

/** `claude auth status --json`: Claude Code's own report of its sign-in. */
export async function claudeStatus(providerId = "claude-code", signal?: AbortSignal, accountId?: string): Promise<ClaudeStatus> {
    const bin = requireCli(providerId, CLAUDE_CLI);
    const r = await runCli(bin, ["auth", "status", "--json"], { signal, timeoutMs: 20_000, env: accountEnv(providerId, accountId) });
    let j: Record<string, unknown> | undefined;
    try {
        j = JSON.parse(r.stdout);
    } catch {
        // older versions print text
    }
    if (!j || typeof j !== "object") {
        if (/not (logged|signed) in/i.test(r.stdout || r.stderr)) return { loggedIn: false };
        if (r.code !== 0) throw new ProviderError(`claude auth status failed: ${cliMessage(r.stderr || r.stdout) || `exit ${r.code}`}`);
        return { loggedIn: !/not (logged|signed) in/i.test(r.stdout) };
    }
    const str = (k: string) => cliStatusString(j![k]);
    return { loggedIn: j.loggedIn === true, authMethod: str("authMethod"), apiProvider: str("apiProvider"), email: str("email"), subscriptionType: str("subscriptionType") };
}

export function describeClaudeAuth(s: ClaudeStatus): string {
    if (!s.loggedIn) return "not signed in";
    const via = s.apiProvider && s.apiProvider !== "firstParty" ? ` via ${s.apiProvider}` : "";
    if (s.authMethod === "api_key") return `signed in with an API key${via} (usage is billed to that key, not a plan)`;
    if (s.authMethod === "oauth_token" || s.subscriptionType) return `signed in with your Claude account${s.subscriptionType ? ` (${s.subscriptionType})` : ""}${via}`;
    return `signed in${s.authMethod ? ` (${s.authMethod})` : ""}${via}`;
}

/** Noninteractive fast mode via --settings was added in 2.1.205. */
export function claudeFastModeVersion(version: unknown): boolean {
    return claudeVersionAtLeast(version, 205);
}

export function claudeVersionAtLeast(version: unknown, minPatch: number): boolean {
    if (typeof version !== "string") return false;
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!m) return false;
    const [major, minor, patch] = m.slice(1).map(Number) as [number, number, number];
    return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= minPatch)));
}

/**
 * The harness's prompt hooks for the events Claude Code runs, in Claude Code's
 * own settings format: it asks its own small model, as it would for one of
 * its own prompt hooks. A model named as a harness model (provider:model) is
 * left to Claude Code's default.
 */
export function claudePromptHooks(hooks: BackendTurn["hooks"]): { hooks?: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]> } {
    const out: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]> = {};
    for (const [event, list] of Object.entries(hooks ?? {}) as [string, HookConfig[]][]) {
        const groups = list
            .filter((h) => h.type === "prompt" && h.prompt)
            .map((h) => ({
                ...(h.matcher ? { matcher: backendMatcher(event, h.matcher) } : {}),
                hooks: [{ type: "prompt", prompt: h.prompt, timeout: h.timeout ?? 30, ...(h.model && !h.model.includes(":") ? { model: h.model } : {}), ...(h.if ? { if: h.if } : {}), ...(h.statusMessage ? { statusMessage: h.statusMessage } : {}) }],
            }));
        if (groups.length) out[event] = groups;
    }
    return Object.keys(out).length ? { hooks: out } : {};
}

let requestSeq = 0;
export const requestId = () => `harness-${Date.now().toString(36)}-${(++requestSeq).toString(36)}`;

export class ClaudeCodeBackend implements AgentBackendClient {
    readonly agentBackend = true as const;
    /** Turns running now: the main agent's, and sub-agents' on Claude Code. */
    private turns = new Set<ClaudeTurn>();
    /**
     * What each Claude Code session had spent at the end of its last run here:
     * a resumed run's totals include it. (Not kept across restarts: the first
     * resumed run after one counts the earlier runs' spend again.)
     */
    private spent = new Map<string, number>();
    /** Each limit window's last status and reset, so "close to the limit" is said once for each (Claude Code repeats it per request). */
    private limitSeen = new Map<string, string>();
    /** The sessions' live processes (src/backends/claude-live.ts), made at the first live turn. */
    private _live?: ClaudeLive;
    /** It takes over turns Claude Code starts by itself (its live sessions'). */
    readonly adoptsTurns = true;

    constructor(readonly def: ProviderDef) {}

    get live(): ClaudeLive {
        return (this._live ??= new ClaudeLive(this.def, { spending: this.spent, limitSeen: this.limitSeen }, async (accountId, signal) => ({ status: await checkAgentCliLazy(this.def.id, signal, accountId) }), (signal) => this.listModels(signal)));
    }

    /**
     * A one-off request (a prompt hook, MCP sampling, a title): Claude Code
     * answers it with its own model and sign-in, in a session of its own with
     * no tools, settings, MCP servers or session file. Its token limit isn't
     * one Claude Code takes, so maxTokens is left to the model.
     */
    async stream(req: ChatRequest): Promise<AssistantMessage> {
        const refused = oneOffRefusal(this.def.name, req);
        if (refused) throw refused;
        const bin = requireCli(this.def.id, CLAUDE_CLI);
        const model = req.model.id === "default" ? [] : ["--model", req.model.id];
        const args = [...extraArgs(this.def.id), ...STREAM_ARGS, "--tools", "", "--disable-slash-commands", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", req.system, ...model];
        const proc = new JsonLinesProcess(bin, args, { cwd: homedir(), env: accountEnv(this.def.id, defaultAccount(this.def.id)) });
        const kill = () => void proc.kill();
        req.signal?.addEventListener("abort", kill, { once: true });
        const timer = setTimeout(kill, ONE_OFF_TIMEOUT_MS);
        try {
            proc.send({ type: "user", message: { role: "user", content: [{ type: "text", text: oneOffPrompt(req) }] }, parent_tool_use_id: null, session_id: "" });
            for await (const m of proc.messages()) {
                if (m.type !== "result") continue;
                if (m.is_error || m.subtype !== "success") throw new ProviderError(`${this.def.name}: ${cliMessage(String(m.result ?? m.subtype ?? "the request failed"))}`);
                return oneOffAnswer(this.def.id, req.model.id, typeof m.result === "string" ? m.result : "");
            }
            if (req.signal?.aborted) throw new ProviderError("Interrupted");
            throw new ProviderError(`${this.def.name} exited without answering${proc.stderr() ? `: ${cliMessage(proc.stderr())}` : ""}`);
        } finally {
            clearTimeout(timer);
            req.signal?.removeEventListener("abort", kill);
            void proc.kill();
        }
    }

    /**
     * Claude Code's model list, from its initialize reply: the CLI starts and
     * answers without making any API request.
     */
    async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
        const bin = requireCli(this.def.id, CLAUDE_CLI);
        // No settings, MCP servers or session file: this only asks for the list.
        const proc = new JsonLinesProcess(bin, [...extraArgs(this.def.id), ...STREAM_ARGS, "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence"], { cwd: homedir(), env: accountEnv(this.def.id, defaultAccount(this.def.id)) });
        const kill = () => void proc.kill();
        signal?.addEventListener("abort", kill, { once: true });
        const timer = setTimeout(kill, 30_000);
        try {
            const id = requestId();
            proc.send({ type: "control_request", request_id: id, request: { subtype: "initialize" } });
            for await (const m of proc.messages()) {
                if (m.type !== "control_response" || m.response?.request_id !== id) continue;
                if (m.response.subtype !== "success") throw new ProviderError(`Claude Code: ${String(m.response.error ?? "initialize failed")}`);
                const models: any[] = Array.isArray(m.response.response?.models) ? m.response.response.models : [];
                return models
                    .filter((x) => typeof x?.value === "string" && x.value)
                    .map((x) =>
                        backendModel(this.def.id, x.value, typeof x.displayName === "string" ? `${x.displayName}${x.resolvedModel && x.resolvedModel !== x.value ? ` (${x.resolvedModel})` : ""}` : undefined, {
                            supportsFastMode: x.supportsFastMode === true && claudeFastModeVersion(m.response.response?.claude_code_version),
                            effortLevels: Array.isArray(x.supportedEffortLevels) ? x.supportedEffortLevels : undefined,
                        }),
                    );
            }
            throw new ProviderError(`Claude Code exited without listing its models${proc.stderr() ? `: ${cliMessage(proc.stderr())}` : ""}`);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", kill);
            void proc.kill();
        }
    }

    /**
     * Stop background tasks of a session's run (these, or every one): Claude Code's stop_task. Its tasks run
     * only while its run does (until #219 PR 4 keeps the process): with none, there's nothing to stop.
     */
    async stopBackground(sessionKey: string, ids?: string[]): Promise<Record<string, BackgroundStop>> {
        const turn = [...this.turns].find((t) => t.sessionKey === sessionKey);
        if (turn) return turn.stopBackground(ids);
        if (this._live?.get(sessionKey)) return this._live.stopBackground(sessionKey, ids);
        return Object.fromEntries((ids ?? []).map((id) => [id, "unknown" as const]));
    }

    sendNow(sessionKey: string, text: string): boolean {
        return this._live?.sendNow(sessionKey, text) ?? false;
    }

    async wakeReport(w: BackendWake): Promise<string | undefined> {
        return this._live?.wakeReport(w.ref);
    }

    async restart(sessionKey: string): Promise<void> {
        await this._live?.restart(sessionKey);
    }

    async release(sessionKey: string): Promise<void> {
        await this._live?.release(sessionKey);
    }

    /** Stop every live process (the harness is quitting). */
    async shutdown(): Promise<void> {
        await this._live?.shutdown();
    }

    async runTurn(t: BackendTurn): Promise<BackendResult> {
        // One process per session, kept between turns (#219), unless agentCli.liveSessions is off: then one per turn, as
        // before. So too a turn nothing takes reports after (-p, the SDK runner, a sub-agent): its run waits for its
        // background work, with the bounded wait below (servers stopped at the answer, #193's timeouts), until the
        // live layer has that policy (#219 PR 5).
        // A turn Claude Code started by itself (a wake) is on the live process, whatever the setting says now: its
        // report is taken there, never asked again of a new process.
        if (t.adopt || (t.liveSessions !== false && !t.untilQuiet)) return this.live.runTurn(t);
        // A process still kept for the session (live sessions turned off since): it goes first, or it would go on
        // beside this run in the same Claude Code session (its background work reporting there).
        const kept = this._live?.get(t.sessionKey);
        if (kept) {
            const tasks = kept.tasks.running().length;
            await this._live!.release(t.sessionKey);
            if (tasks) t.sink.emit({ type: "notice", level: "warn", message: `Live sessions are off (agentCli.liveSessions), so Claude Code's process for this session was stopped, and ${tasks === 1 ? "its background task" : `its ${tasks} background tasks`} with it.` });
        }
        const bin = requireCli(this.def.id, CLAUDE_CLI);
        const key = (id: string) => `${t.accountId ?? "default"}:${id}`;
        // The harness's skills Claude Code doesn't read itself come as a plugin of their own, so it runs them like its own.
        const configDir = t.skills?.length ? claudeConfigDir(this.def.id, t) : undefined;
        const plugged = t.skills?.length ? forClaudeCode(t.skills, t.cwd, t.trusted, configDir) : [];
        const pluginDir = skillFolder(plugged, { plugin: true });
        // One it has under no name (the plugin couldn't be made, an untrusted project's) is pasted in, as for the harness's models.
        const names = claudeNames(t.skills ?? [], pluginDir ? plugged : [], t.cwd, t.trusted, configDir);
        const prompt = claudePrompt(t.prompt, t.request, t.skills ?? [], names, formatSkill, t.requestAfter);
        const turn = new ClaudeTurn(this.def, bin, { ...t, prompt }, t.resumeId ? this.spent.get(key(t.resumeId)) : undefined, this.limitSeen);
        turn.pluginDir = pluginDir;
        turn.skillNames = names;
        this.turns.add(turn);
        try {
            // The text goes last: Claude Code reads a /command only from the last block (what's before it goes along with it),
            // so with images or PDFs first, /skill and its own commands run with them attached instead of reaching the model as words.
            return await turn.run([...mediaBlocks(t.images, t.documents ?? []), ...textBlocks(prompt, t.preamble)]);
        } finally {
            this.turns.delete(turn);
            const s = turn.spending();
            if (s) this.spent.set(key(s.sessionId), s.total);
        }
    }

    /** Claude Code's own /compact, on the session being continued. */
    async compact(t: Omit<BackendTurn, "prompt" | "images"> & { instructions?: string }): Promise<BackendResult> {
        if (!t.resumeId) return { reason: "done", text: "", actions: [] };
        return this.runTurn({ ...t, prompt: `/compact${t.instructions ? ` ${t.instructions}` : ""}`, images: [] });
    }

    /** Each running turn takes its own agent's mode now (a read-only sub-agent's stays read-only). */
    setMode(_m: PermissionMode) {
        for (const turn of this.turns) turn.setMode(turn.agentMode());
        this._live?.setMode();
    }
}

export interface PendingTool {
    name: string;
    input: Record<string, unknown>;
    title: string;
    started: number;
}

/** One `claude -p` run: a prompt, plus any messages queued while it worked. */
class ClaudeTurn {
    private proc!: JsonLinesProcess;
    private tools = new Map<string, PendingTool>();
    /** Content block index → tool_use id, for streamed input. */
    private streamingTools = new Map<number, string>();
    /** Agent tool calls: their description labels the sub-agent's activity. */
    private agentLabels = new Map<string, string>();
    /** Agent calls whose sub-agent has started and hasn't finished, and those that have finished (and how). */
    private liveAgents = new Set<string>();
    private endedAgents = new Map<string, TurnEndReason>();
    /** Sub-agents' tool calls still waiting for their result, with the Agent call they're under. */
    private subTools = new Map<string, PendingTool & { parent: string }>();
    /** What each sub-agent handed back (its SubagentHandback message), by Agent call. */
    private reports = new Map<string, string>();
    private texts: string[] = [];
    private actions: string[] = [];
    private sessionId?: string;
    /** Its /goal, followed in its transcript. */
    private goals?: ClaudeGoalWatch;
    private billedToPlan = false;
    private resolvedModel?: string;
    private contextTokens?: number;
    private aborted = false;
    private failure?: string;
    /** CLI-generated assistant error prose, kept out of model history. */
    private diagnostic?: string;
    private reason?: BackendResult["reason"];
    private signedOut = false;
    /** The turn failed on the plan's usage limit; when that resets (ms), if Claude Code said. */
    private limitHit = false;
    private limits?: PlanLimits;
    /** This turn said the limit was reached (its error says it again, with when it resets). */
    private reachedNoted = false;
    /** Control requests sent to Claude Code, waiting for its answer. */
    private controls = new Map<string, (response: Record<string, any>) => void>();
    /** The prompt has been sent. */
    private prompted = false;
    /** Verified UUID aggregation for mid-turn input (older CLIs keep between-turn delivery). */
    private midTurnInput = false;
    /** Prompts sent and not answered yet, by the uuid they were sent with (a result names the ones it answers). */
    private unanswered = new Set<string>();
    /** A result has answered the run's prompts. */
    private answered = false;
    /** Claude Code is in a turn (from the prompt, or its own init, to the result). */
    private busy = false;
    /** What Claude Code says runs in the background, once it has said (background_tasks_changed). */
    private background?: { id: string; type: string; description: string }[];
    /** Agent calls whose sub-agent runs in the background. */
    private backgroundAgents = new Set<string>();
    /** Claude Code's task id for each Agent call (task_started), to match its background list. */
    private agentTasks = new Map<string, string>();
    /** Background sub-agents' Agent calls, open from their launch until the sub-agent ends. */
    private launched = new Set<string>();
    /** Those that have ended (how, and when), in case a report or another word on how it ended comes later. */
    private closedLaunches = new Map<string, PendingTool & { reason: TurnEndReason; ended: number }>();
    /** Claude Code's turns in this run so far (each starts with init, a turn it takes itself with reports too). */
    private turnCount = 0;
    /**
     * Background tasks Claude Code gave word of ending (it left its list, or said how it ended), by task id: in
     * which of its turns. The first turn after that takes its report (reportDue).
     */
    private endedIn = new Map<string, number>();
    /** What each sub-agent said last: its report, when nothing else carries one. */
    private lastWords = new Map<string, string>();
    /** Each sub-agent's token count as Claude Code last reported it. */
    private agentTokens = new Map<string, number>();
    /** Waiting on the background, since. */
    private waitingSince?: number;
    /** Each command's grace starts after an answer, or when it joins the wait. */
    private commandWaitingSince = new Map<string, number>();
    /** Each command's overall cap counts from when the wait first listed it, across answers and report turns. */
    private commandListedSince = new Map<string, number>();
    private waitingLabel?: string;
    /** Each Bash call's command and own background timeout, by its tool_use id; then by the task it started (task_started), from when. */
    private shellCommands = new Map<string, { command: string; timeoutMs?: number }>();
    private taskCommands = new Map<string, { command: string; timeoutMs?: number; started: number }>();
    private stoppedTaskIds = new Set<string>();
    private stoppedBackground = new Set<string>();
    /** Stops asked of Claude Code and not answered yet, by task id; `byUser`: the user's (a timeout of theirs never ends the run). */
    private pendingStops = new Map<string, { task: BackgroundWork; since: number; byUser: boolean; release: () => void }>();
    /** A task's end Claude Code said while its stop was pending: taken as said if the stop doesn't go through. */
    private heldEnds = new Map<string, Record<string, any>>();
    /** Background tasks that left Claude Code's list before it said how they ended (by the id they're reported with). */
    private leftList = new Set<string>();
    private stopFailed = false;
    private pollTimer?: ReturnType<typeof setInterval>;
    private settleTimer?: ReturnType<typeof setTimeout>;
    /** The run is being ended (its process stopped). */
    private finishing = false;
    /** The user was told the background sub-agents were stopped. */
    private toldStopped = false;
    /** The harness's hooks registered with Claude Code, by the callback id it sends back. */
    private hookCallbacks = new Map<string, { event: HookEvent; hook: HookConfig }>();
    /** The harness's skills, as a plugin folder (src/backends/native-skills.ts). */
    pluginDir?: string;
    /** The name Claude Code runs each of the harness's skills by (claudeNames), for the prompts sent during the run. */
    skillNames: ReadonlyMap<string, string> = new Map();
    /** Each sub-agent's type, by the id it asks permission with. */
    private agentTypes = new Map<string, string>();
    /** Where --agents reads from, removed when the process exits. */
    private agentsFile?: { path: string; remove: () => void };
    /** What the session was last told runs in this run's background (SessionHost.emitSession), by task id. */
    private reportedBackground = new Map<string, BackgroundTaskInfo>();
    /** How Claude Code said each background task ended (task_notification), by its task id. */
    private taskEnds = new Map<string, string>();

    constructor(
        private def: ProviderDef,
        private bin: string,
        private t: BackendTurn,
        /** What the session it resumes had spent before (its totals include that). */
        private spent?: number,
        /** The client's: each limit window's last status and reset (limitNews). */
        private limitSeen = new Map<string, string>(),
    ) {}

    get sessionKey(): string {
        return this.t.sessionKey;
    }

    /**
     * Tell the session what runs in the background when that changed: what started, and what ended since.
     * `gone`: the process is stopped, and whatever still ran stopped with it.
     */
    private syncBackground(gone = false) {
        const emit = this.cliSession.emitSession;
        if (!emit) return;
        const seen = new Set<string>();
        const calls = new Set(this.agentLabels.values());
        const mapped = new Set(this.agentTasks.values());
        for (const w of gone ? [] : this.inBackground()) {
            // A sub-agent by its Agent call (its task id may come later), the rest by task id.
            const id = w.toolUseId ?? w.id;
            if (!id) continue;
            // Listed before its task_started ties it to its Agent call: it's that call's, reported as such once tied.
            if (w.agent && !w.toolUseId && !mapped.has(id) && calls.has(w.label)) continue;
            seen.add(id);
            const was = this.reportedBackground.get(id);
            const task: BackgroundTaskInfo = {
                id,
                provider: this.def.id,
                kind: w.agent ? "agent" : w.monitor ? "monitor" : w.commandTask ? "shell" : "other",
                label: w.label,
                ...(w.toolUseId ? { toolUseId: w.toolUseId } : {}),
                startedAt: was?.startedAt ?? w.started ?? Date.now(),
                status: "running",
                // stop_task needs its task id.
                stoppable: Boolean(w.id),
            };
            if (was && JSON.stringify(was) === JSON.stringify(task)) continue;
            this.reportedBackground.set(id, task);
            emit({ type: "background_task", task, accountId: this.t.accountId ?? "default" });
        }
        for (const [id, t] of this.reportedBackground) {
            if (seen.has(id)) continue;
            const taskId = t.toolUseId ? this.agentTasks.get(t.toolUseId) : id;
            const said = taskId ? this.taskEnds.get(taskId) : undefined;
            const launch = t.toolUseId ? this.closedLaunches.get(t.toolUseId)?.reason : undefined;
            const stopped = (taskId !== undefined && this.stoppedTaskIds.has(taskId)) || said === "stopped" || launch === "aborted";
            let status: BackgroundTaskInfo["status"] | undefined = stopped ? "stopped" : said === "failed" || launch === "error" ? "failed" : said || launch ? "done" : undefined;
            let withProcess = false;
            if (!status) {
                // Off Claude Code's list with no word yet of how it ended (its task_notification comes after the
                // list changes, or its stop is still being answered): it's said once that word comes.
                if (!gone) {
                    this.leftList.add(id);
                    continue;
                }
                // The process is gone: one that had left the list (its stop not pending) ended before; the rest went with it.
                const stopping = taskId !== undefined && this.pendingStops.has(taskId);
                if (this.leftList.has(id) && !stopping) status = "done";
                else {
                    status = "stopped";
                    withProcess = !stopping;
                }
            }
            this.reportedBackground.delete(id);
            this.leftList.delete(id);
            // Ended with the process by the user's Esc: their stop (no news to them), not a crash's.
            const how = status === "stopped" && this.aborted ? { byUser: true } : withProcess ? { withProcess: true } : {};
            const ended: BackgroundTaskInfo = { ...t, status, endedAt: Date.now(), ...how };
            this.endedBackground.set(id, ended);
            emit({ type: "background_task", task: ended, accountId: this.t.accountId ?? "default" });
        }
        // One said to have ended, then said to have ended otherwise (a sub-agent done, then failed after all): so it did.
        for (const [id, t] of this.endedBackground) {
            if (t.status === "stopped") continue;
            const said = this.taskEnds.get((t.toolUseId ? this.agentTasks.get(t.toolUseId) : id) ?? "");
            const launch = t.toolUseId ? this.closedLaunches.get(t.toolUseId)?.reason : undefined;
            const status: BackgroundTaskInfo["status"] | undefined = said === "failed" || (!said && launch === "error") ? "failed" : said === "completed" || (!said && launch === "done") ? "done" : undefined;
            if (!status || status === t.status) continue;
            const revised = { ...t, status };
            this.endedBackground.set(id, revised);
            emit({ type: "background_task", task: revised, accountId: this.t.accountId ?? "default" });
        }
    }

    /** What the session was told of each background task that ended in this run, by its id: said again if Claude Code changes its word. */
    private endedBackground = new Map<string, BackgroundTaskInfo>();

    /** The user's stop of background tasks (these, or every one): how each went, once Claude Code answers. */
    async stopBackground(ids?: string[]): Promise<Record<string, BackgroundStop>> {
        const left = this.inBackground();
        const targets = ids ?? left.map((t) => t.toolUseId ?? t.id).filter((id): id is string => Boolean(id));
        const out: Record<string, BackgroundStop> = {};
        await Promise.all(
            targets.map(async (id) => {
                const w = left.find((t) => t.toolUseId === id || t.id === id);
                // Off Claude Code's list: ended (how is said once Claude Code says), unless a stop of it is still pending.
                if (!w) out[id] = this.reportedBackground.has(id) || this.endedBackground.has(id) ? (this.pendingStops.has(this.agentTasks.get(id) ?? id) ? "timeout" : "ended") : "unknown";
                else if (!w.id || this.finishing) out[id] = "not_stoppable";
                else out[id] = await this.stopTask(w, "", true);
            }),
        );
        return out;
    }

    /** The session's spend so far, as its last result put it. */
    spending(): { sessionId: string; total: number } | undefined {
        return this.sessionId && this.spent !== undefined ? { sessionId: this.sessionId, total: this.spent } : undefined;
    }

    /** The session's side of the host: permissions, usage, background tasks. */
    private get cliSession(): SessionHost {
        return this.t.session;
    }

    /** This turn's events and steering. */
    private get sink(): TurnSink {
        return this.t.sink;
    }

    /** The mode of the agent running this turn, as it is now. */
    agentMode(): PermissionMode {
        return this.cliSession.mode();
    }

    private args(): string[] {
        const t = this.t;
        // The harness's agents, for its own Agent tool (a file: -p reads one, and prompts can outgrow an argument).
        if (t.agents && Object.keys(t.agents).length && !t.readOnly) this.agentsFile ??= writeAgentsFile(t.agents);
        const { args, mcpWarning } = claudeArgs(this.def.id, t, {
            pluginDir: this.pluginDir,
            agentsPath: this.agentsFile?.path,
            append: [t.appendSystemPrompt, t.goalContext,
                `After an answer, Harness waits for a reported background Bash command until its own \`timeout\` runs out, counted from its start (at most ${span(backgroundTiming.commandMaxTimeoutMs)}); for one without a timeout, and for each monitor, it waits up to ${claudeBackgroundWaitMs(t.backgroundWaitSec) / 1000} seconds after the answer. ${Number.isFinite(backgroundTiming.maxWaitMs) ? `Sub-agents and other background work have a ${span(backgroundTiming.maxWaitMs)} limit, which doesn't cut short a command still within its own timeout (nor, while one is, any sub-agent or workflow).` : "Sub-agents and other background work run until they finish or the user stops them, with no time limit."} For a long finite job in the background (a test suite, a build, a benchmark), pass \`timeout\` with \`run_in_background\`, set to how long it may take. Background commands and monitors do not survive process shutdown, a user interrupt, or the end of their wait. Recognized dev servers/watchers are stopped without waiting after the answer, timeout or not. Consume finite-work results before declaring success; do not expect a background server to outlive the turn. Work not reported by the CLI cannot be waited for.`,
            ],
        });
        if (mcpWarning) this.sink.emit({ type: "notice", level: "warn", message: mcpWarning });
        return args;
    }

    setMode(m: PermissionMode) {
        this.proc?.send({ type: "control_request", request_id: requestId(), request: { subtype: "set_permission_mode", mode: MODES[m] } });
    }

    /** `synthetic`: not the user's own words (see BackendTurn.synthetic), so Claude Code expands no @mentions in it. */
    /** False when it didn't go: stopping, or Claude Code's stdin is gone (known once the write is done: JsonLinesProcess.send). */
    private async sendUser(content: unknown[], synthetic = false): Promise<boolean> {
        if (this.aborted || this.finishing) return false;
        const wasBusy = this.busy;
        this.prompted = true;
        this.busy = true;
        this.commandWaitingSince.clear();
        this.clearWaitStatus();
        // Its answer is waited for now, not a report turn.
        clearTimeout(this.settleTimer);
        this.settleTimer = undefined;
        const uuid = crypto.randomUUID();
        this.unanswered.add(uuid);
        const sent = await this.proc.send({ type: "user", uuid, message: { role: "user", content }, parent_tool_use_id: null, session_id: this.sessionId ?? "", ...(synthetic ? { isSynthetic: true } : {}) });
        // Not written: no answer to wait for.
        if (!sent) {
            this.unanswered.delete(uuid);
            this.busy = wasBusy;
        }
        return sent;
    }

    /**
     * Whether a result answers prompts this run sent (they're answered now).
     * One for a turn Claude Code took itself (a background sub-agent's report,
     * or one its last run left behind) says so with its origin, and doesn't.
     * One that names none of them and has no such origin (an older Claude
     * Code, or a failure before the turn started) answers them all.
     */
    private answers(m: Record<string, any>): boolean {
        const ids = [m.user_message_uuid, ...(Array.isArray(m.user_message_uuids) ? m.user_message_uuids : [])].filter((x): x is string => typeof x === "string" && x !== "");
        if (ids.some((id) => this.unanswered.has(id))) {
            for (const id of ids) this.unanswered.delete(id);
            return true;
        }
        // A late/duplicate result naming other prompts cannot acknowledge a newer send.
        if (ids.length || (typeof m.origin?.kind === "string" && m.origin.kind !== "human")) return false;
        this.unanswered.clear();
        return true;
    }

    /**
     * All reported background work, including shell commands and monitors.
     * Shells/monitors have a separate grace; all waits can be interrupted.
     */
    private inBackground(): BackgroundWork[] {
        // Its sub-agents until Claude Code says each is over, listed or not (the list can drop one before that comes).
        const agents = this.unreported();
        const tasks = new Set(agents.map((id) => this.agentTasks.get(id)));
        const labels = new Set(agents.filter((id) => !this.agentTasks.has(id)).map((id) => this.agentLabels.get(id) ?? "sub-agent"));
        // And what else it lists (a sub-agent there that's one of those once only).
        const listed = (this.background ?? []).filter((t) => !this.stoppedTaskIds.has(t.id) && !tasks.has(t.id) && !(t.type === "local_agent" && labels.has(t.description)));
        return [...agents.map((id) => ({ id: this.agentTasks.get(id), toolUseId: id, agent: true, label: this.agentLabels.get(id) ?? "sub-agent" })), ...listed.map((t) => {
            const shell = t.type === "local_bash" ? this.taskCommands.get(t.id) : undefined;
            return { id: t.id, agent: t.type === "local_agent", commandTask: t.type === "local_bash" || t.type.startsWith("monitor"), monitor: t.type.startsWith("monitor"), command: t.type === "local_bash" ? shell?.command ?? t.description : undefined, timeoutMs: shell?.timeoutMs, started: shell?.started, label: t.description || "background task" };
        })];
    }

    /** Background sub-agents Claude Code hasn't said are over. */
    private unreported(): string[] {
        // One Harness stopped (at the overall cap) is over too, whatever Claude Code says of it later.
        return [...this.backgroundAgents].filter((id) => this.liveAgents.has(id) && !this.stoppedTaskIds.has(this.agentTasks.get(id) ?? ""));
    }

    /**
     * With Claude Code between turns: whether the run is over. The prompts
     * are answered; messages the user sent meanwhile go to Claude Code; then
     * it waits while sub-agents run in the background, and for Claude Code's
     * turn with the reports of those that ended.
     */
    private idlePending?: Promise<boolean>;

    private idle(): Promise<boolean> {
        // Timer callbacks and the message loop can both check while a snapshot is being captured.
        return (this.idlePending ??= this.checkIdle().finally(() => {
            this.idlePending = undefined;
        }));
    }

    private async checkIdle(): Promise<boolean> {
        if (this.busy || this.unanswered.size || !this.answered || this.aborted || this.finishing) return false;
        // Waiting only on background work, Claude Code is between its turns: nothing is mid-step, so what the
        // user queued goes now, whatever its mode, with its attachments. Otherwise only messages to steer with.
        if (await this.deliverQueued(this.inBackground().length > 0)) return false;
        if (this.aborted || this.finishing) return false;
        // A timer may have awaited a snapshot while the message loop received fresh work.
        if (this.busy || this.unanswered.size || !this.answered) return false;
        // Harness's own stops past their timeout. One whose task said how it ended while it was pending (before
        // the timeout or after it) is settled by that end, here, whichever of this and the stop's timer comes first.
        for (const [id, p] of [...this.pendingStops]) if (!p.byUser && this.heldEnds.has(id) && Date.now() - p.since >= backgroundTiming.stopTimeoutMs) p.release();
        const left = this.inBackground();
        // The rest end the run: only Harness's own stops do when they go unanswered; the user's never do.
        if (this.stopFailed || [...this.pendingStops.values()].some((p) => !p.byUser && Date.now() - p.since >= backgroundTiming.stopTimeoutMs)) {
            this.noteStopped(left, "harness", "because Claude Code did not confirm a task stop, so its process was ended");
            this.toldStopped = true;
            return true;
        }
        if (this.pendingStops.size) return false;
        const commands = left.filter((t) => t.commandTask);
        const now = Date.now();
        const grace = claudeBackgroundWaitMs(this.t.backgroundWaitSec);
        for (const id of this.commandWaitingSince.keys()) {
            if (!commands.some((t) => t.id === id)) this.commandWaitingSince.delete(id);
        }
        for (const id of this.commandListedSince.keys()) {
            if (!commands.some((t) => t.id === id)) this.commandListedSince.delete(id);
        }
        const stopping: { task: BackgroundWork; why: string }[] = [];
        for (const task of commands) {
            // Command tasks come from the CLI's list and have task IDs.
            const id = task.id!;
            if (!this.commandWaitingSince.has(id)) this.commandWaitingSince.set(id, now);
            if (!this.commandListedSince.has(id)) this.commandListedSince.set(id, now);
            const until = ownDeadline(task);
            if (task.command && longLivedClaudeCommand(task.command)) stopping.push({ task, why: "without waiting: a recognized long-lived server/watcher" });
            // One with a timeout of its own runs until it's up, as in Claude Code; the setting changes only the default.
            else if (until !== undefined) {
                if (now >= until) stopping.push({ task, why: `when its background timeout of ${span(until - task.started!)} ran out` });
            } else if (now - this.commandWaitingSince.get(id)! >= grace) stopping.push({ task, why: `when its background grace expired after ${grace / 1000}s` });
        }
        if (stopping.length) {
            if (stopping.length === left.length) {
                for (const { task, why } of stopping) this.noteStopped([task], "harness", why);
                this.toldStopped = true;
                return true;
            }
            // Keep agents and other finite work alive: stop only these task IDs.
            this.waitFor(left);
            for (const { task, why } of stopping) this.stopTask(task, why);
            return false;
        }
        if (left.length) {
            // Work it lists after a report came: the report turn is waited for with it, not before it's done.
            clearTimeout(this.settleTimer);
            this.settleTimer = undefined;
            this.waitFor(left);
            // Commands without a timeout of their own and monitors have a cap; sub-agents and workflows none by
            // default (maxWaitMs), as in Claude Code: they run until they're done or the user stops them.
            // A command's from when it was first listed, not from the start of a wait other work kept going.
            const waited = (t: BackgroundWork) => now - (t.commandTask ? (this.commandListedSince.get(t.id!) ?? this.waitingSince!) : this.waitingSince!);
            const capOf = (t: BackgroundWork) => (t.commandTask ? Math.min(backgroundTiming.commandsMaxWaitMs, backgroundTiming.maxWaitMs) : backgroundTiming.maxWaitMs);
            // Sub-agents and workflows go on too while a command within its own timeout does: stopping one ends the
            // shells under it (a grandchild's too), and a command's completion goes to the sub-agent that ran it.
            const timed = left.some((t) => ownDeadline(t) !== undefined);
            const over = left.filter((t) => ownDeadline(t) === undefined && waited(t) >= capOf(t) && !(timed && !t.commandTask));
            if (!over.length) return false;
            const ms = Math.min(...over.map(capOf));
            // So too while a finished command's report is still due: stop the rest by task id and let that turn come.
            if (over.length < left.length || (this.reportDue() && over.every((t) => t.id))) {
                for (const task of over) this.stopTask(task, `after waiting ${span(ms)}, its limit for background work`);
                return false;
            }
            this.toldStopped = true;
            this.rememberStopped(left);
            this.sink.emit({ type: "notice", level: "warn", message: `${APP_TITLE} stopped ${describeBackground(left)} after waiting ${span(ms)}, its limit for background work, and Claude Code with ${left.length === 1 ? "it" : "them"}. ${left.length === 1 ? "It won't" : "They won't"} report back.` });
            return true;
        }
        this.stopWaiting();
        // A sub-agent ended: Claude Code's turn with its report is due.
        if (this.reportDue()) {
            this.settleTimer ??= setTimeout(() => {
                this.settleTimer = undefined;
                // A queued prompt may still be waiting for its start snapshot.
                if (this.idlePending) {
                    void this.idlePending.then((done) => {
                        if (done) this.finish();
                    });
                    return;
                }
                // It didn't come: the run is over, unless something started since (then that's waited for).
                if (this.busy || this.unanswered.size || this.inBackground().length) void this.idle();
                else this.finish();
            }, backgroundTiming.settleMs);
            return false;
        }
        return true;
    }

    /** Serialized with idle checks: snapshot/record the preceding output before the new user row. */
    private deliveryPending?: Promise<boolean>;

    /** `waiting`: Claude Code is between its turns, waiting only on background work (see BackendHost.drainWaiting). */
    private deliverQueued(waiting = false): Promise<boolean> {
        return (this.deliveryPending ??= this.forward(waiting).finally(() => { this.deliveryPending = undefined; }));
    }

    private async forward(waiting: boolean): Promise<boolean> {
        // One at a time, in the order they were sent: the next goes once Claude Code has answered this one.
        if (waiting && (await this.forwardWaiting())) return true;
        return this.forwardQueued();
    }

    /** What the run has said and done since the last of it was recorded, taken out. */
    private progress(): BackendResult {
        return { reason: "done", text: this.texts.splice(0).join("\n\n"), actions: this.actions.splice(0) };
    }

    private async forwardWaiting(): Promise<boolean> {
        if (this.aborted || this.finishing || !this.sink.drainWaiting) return false;
        const p = await this.sink.drainWaiting(() => this.progress(), () => !this.aborted && !this.finishing);
        if (!p) return false;
        if (this.aborted || this.finishing) {
            // Not expected: nothing is awaited between its "go" (see AgentHost.drainWaiting) and here. Should
            // a stop land anyway, the next turn is told of it rather than it vanishing.
            this.sink.undelivered?.([{ text: p.text, images: p.images, documents: p.documents }]);
            return false;
        }
        this.reason = undefined;
        // As a prompt of the user's own is sent (runTurn): its $names read the same way, its images and PDFs first.
        const text = claudePrompt(p.text, p.request, this.t.skills ?? [], this.skillNames, formatSkill, p.requestAfter);
        this.sendUser([...mediaBlocks(p.images, p.documents), ...(text ? [{ type: "text", text }] : [])]);
        return true;
    }

    private async forwardQueued(): Promise<boolean> {
        if (this.aborted || this.finishing) return false;
        // Their hooks run first: they're taken only if it can still send them.
        const queued = await this.sink.drainQueued(() => this.progress(), () => !this.aborted && !this.finishing);
        if (!queued.length) return false;
        if (this.aborted || this.finishing) {
            // Stopped once they were taken (they're in the transcript): the next turn is told of them rather than them
            // vanishing. One with attachments isn't in it yet: it stays queued, to go as a prompt of its own.
            for (const m of queued) await m.settle?.(false);
            const told = queued.filter((m) => !m.settle);
            if (told.length) this.sink.undelivered?.(told);
            return false;
        }
        this.reason = undefined;
        // The user's messages as they typed them; a watch's events (others' words) apart, read as written.
        // One with attachments (settle) is the user's, whatever its words.
        const fromWake = (m: SteerMessage) => !m.settle && Boolean(this.sink.fromWake?.(m.text));
        const typed = queued.filter((m) => !fromWake(m));
        const woke = queued.filter(fromWake);
        // Their images and PDFs first, as a prompt's (runTurn); the text last.
        const media = typed.flatMap((m) => mediaBlocks(m.images, m.documents));
        // One with only images or files has no text block (the API refuses an empty one).
        const words = typed.map((m) => m.text).filter((t) => t).join("\n\n");
        // Both buffered in order now; each known written (or not) once its write is done.
        const sending = typed.length ? this.sendUser([...media, ...(words ? [{ type: "text", text: words }] : [])]) : Promise.resolve(false);
        const telling = woke.length ? this.sendUser([{ type: "text", text: woke.map((m) => m.text).join("\n\n") }], true) : Promise.resolve(false);
        const [sent, told] = await Promise.all([sending, telling]);
        // Written whole to its stdin, as text steers are: one with attachments is the host's to record now (and if
        // the write failed, Claude Code went away before taking it: it stays queued).
        for (const m of typed) await m.settle?.(sent);
        // Nothing written: nothing to wait for.
        return sent || told;
    }

    private rememberStopped(tasks: BackgroundWork[]) {
        for (const t of tasks) this.stoppedBackground.add(`${t.agent ? "sub-agent" : t.monitor ? "background monitor" : t.commandTask ? "background command" : "background task"}: ${t.label}`);
    }

    /**
     * Say that background tasks were stopped, and by whom (#285): Harness (`why`: at a limit, or a command's own
     * timeout), the user (their Stop, or Esc), or the process ending under them.
     */
    private noteStopped(tasks: BackgroundWork[], by: "harness" | "user" | "esc" | "process", why = "") {
        if (!tasks.length) return;
        this.rememberStopped(tasks);
        const what = describeBackground(tasks);
        const said = by === "harness" ? `${APP_TITLE} stopped ${what}${why ? ` ${why}` : ""}.` : by === "user" ? `You stopped ${what}.` : by === "esc" ? `Stopped ${what} when you pressed Esc.` : `Claude Code's process ended, and with it ${what}.`;
        this.sink.emit({ type: "notice", level: by === "user" ? "info" : "warn", message: `${said} ${tasks.length === 1 ? "It won't" : "They won't"} report back.` });
    }

    /**
     * Ask Claude Code to stop a background task: how it went. One Harness stops (at a cap) that Claude Code
     * doesn't stop ends the run; one the user stops (`byUser`) that doesn't stop is only said to have failed.
     * A second stop of a task whose stop is still unanswered (the user's timed out, then Harness's at a cap)
     * asks nothing more: both take the one answer. Once it's stopped, or has said how it ended, a failure or
     * a silence after doesn't count against the run.
     */
    private stopTask(task: BackgroundWork, why: string, byUser = false): Promise<BackgroundStop> {
        // `why`: Harness's reason (noteStopped); the user's stop needs none.
        if (!task.id) {
            if (!byUser) this.stopFailed = true;
            return Promise.resolve("not_stoppable");
        }
        const id = task.id;
        if (this.stoppedTaskIds.has(id)) return Promise.resolve("stopped");
        const pending = { task, since: Date.now(), byUser, release: () => notStopped() };
        // Harness's own stop decides what an unanswered one does (it ends the run, checkIdle): the user's doesn't take its place.
        const before = this.pendingStops.get(id);
        if (!before || before.byUser) this.pendingStops.set(id, pending);
        const mine = () => this.pendingStops.get(id) === pending;
        /** Claude Code said how it ended before (not held for a stop): there was nothing left to stop. */
        const over = () => this.taskEnds.has(id) && !this.heldEnds.has(id);
        /** The stop didn't go through (refused, or not answered in time): the task's end, if Claude Code said it meanwhile, counts. */
        const notStopped = () => {
            if (!mine()) return;
            this.pendingStops.delete(id);
            const held = this.heldEnds.get(id);
            this.heldEnds.delete(id);
            if (held) this.onSystem(held);
            this.syncBackground();
        };
        /** The answer came (it's the same for every stop of the task waiting on it): its pending stop goes, and the end held for it counts. */
        const release = () => {
            this.pendingStops.delete(id);
            const held = this.heldEnds.get(id);
            this.heldEnds.delete(id);
            if (held) this.onSystem(held);
            this.syncBackground();
        };
        const answered = this.askStop(id).then((ok): BackgroundStop => {
            // Another stop of it has taken this answer already.
            if (this.stoppedTaskIds.has(id)) return "stopped";
            // Claude Code answers success for a task it no longer runs, and says a task it stops ended "stopped" before
            // it answers. An end it said otherwise while the stop was pending (done, failed), or before the stop was
            // asked: the task ended on its own, and that's how (its report turn is due), whatever the answer.
            const held = this.heldEnds.get(id);
            if (over() || (held && (held.status !== "stopped" || !ok))) {
                release();
                return "ended";
            }
            if (!ok) {
                if (!byUser) this.stopFailed = true;
                release();
                return "failed";
            }
            this.pendingStops.delete(id);
            this.heldEnds.delete(id);
            this.stoppedTaskIds.add(id);
            // A sub-agent stopped (at the overall cap, or by the user): over, without a report.
            if (task.toolUseId) this.endAgent(task.toolUseId, "aborted");
            this.noteStopped([task], byUser ? "user" : "harness", why);
            this.syncBackground();
            return "stopped";
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        // Its process gone, the task went with it; unless it said how it ended first (held for this stop): that's how.
        const gone = this.proc.exited.then((): BackgroundStop => {
            const held = mine() ? this.heldEnds.get(id) : undefined;
            if (!held) return "stopped";
            notStopped();
            return held.status === "stopped" ? "stopped" : "ended";
        });
        const late = new Promise<BackgroundStop>(
            (resolve) =>
                (timer = setTimeout(() => {
                    // The user's: the task runs on as far as Harness knows, and the run with it (an automatic
                    // stop's timeout ends the run, checkIdle, unless the task said meanwhile how it ended). A
                    // late answer still counts.
                    const held = mine() ? this.heldEnds.get(id) : undefined;
                    if (byUser || held) notStopped();
                    resolve(held && held.status !== "stopped" ? "ended" : "timeout");
                }, backgroundTiming.stopTimeoutMs)),
        );
        return Promise.race([answered, gone, late]).finally(() => {
            clearTimeout(timer);
            // A pending stop holds the run open (checkIdle): once it's settled, whatever else it waited on may be done
            // (a report turn that came meanwhile), with nothing else to look again (no wait polling yet).
            this.recheckIdle();
        });
    }

    /** Each task's stop_task not answered yet, by task id: whether it went through. One request per task at a time. */
    private stopRequests = new Map<string, Promise<boolean>>();

    private askStop(id: string): Promise<boolean> {
        const asked = this.stopRequests.get(id);
        if (asked) return asked;
        const request = requestId();
        const answer = new Promise<boolean>((resolve) => {
            this.controls.set(request, (response) => {
                this.controls.delete(request);
                this.stopRequests.delete(id);
                resolve(response.subtype === "success");
            });
        });
        this.stopRequests.set(id, answer);
        this.proc.send({ type: "control_request", request_id: request, request: { subtype: "stop_task", task_id: id } });
        return answer;
    }

    private clearWaitStatus() {
        if (this.waitingLabel === undefined) return;
        this.waitingLabel = undefined;
        this.sink.emit({ type: "activity" });
    }

    private waitFor(left: BackgroundWork[]) {
        const label = `Waiting for ${left.map((t) => `${t.agent ? "background sub-agent" : t.monitor ? "background monitor" : t.commandTask ? "background command" : "background task"}: ${t.label}`).join("; ")} · Esc to stop ${left.length === 1 ? "it" : "them"}`;
        if (label !== this.waitingLabel) {
            this.waitingLabel = label;
            this.sink.emit({ type: "activity", text: label });
        }
        if (this.waitingSince !== undefined) return;
        this.waitingSince = Date.now();
        this.sink.emit({ type: "notice", level: "info", message: `Waiting for ${describeBackground(left)} to report back: the turn ends once Claude Code has the results (Esc stops them).` });
        // Messages the user sends meanwhile go to Claude Code now, not after the wait; and the wait has an end.
        this.pollTimer = setInterval(() => {
            void this.idle().then((done) => {
                if (done) this.finish();
            });
        }, backgroundTiming.pollMs);
    }

    private stopWaiting() {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
        this.waitingSince = undefined;
        this.commandWaitingSince.clear();
        this.commandListedSince.clear();
        this.clearWaitStatus();
    }

    /**
     * Whether Claude Code's turn with a report is due: a background task ended (on its own, not by a stop of ours,
     * and with no stop of it still unsettled) since its last turn started. Derived from what happened, in whatever
     * order: a report a turn took while the task's stop was pending isn't waited for again.
     */
    private reportDue(): boolean {
        for (const [id, turn] of this.endedIn) if (turn === this.turnCount && !this.stoppedTaskIds.has(id) && !this.pendingStops.has(id)) return true;
        return false;
    }

    /** It ended (left the list, or said so): first word only. */
    private markEnded(taskId: string) {
        if (!this.endedIn.has(taskId)) this.endedIn.set(taskId, this.turnCount);
    }

    /** Look again whether the run is over, from outside its loop (a stop settled): end it if so. */
    private recheckIdle() {
        if (this.busy || this.finishing || this.aborted) return;
        void this.idle().then((done) => {
            if (done) this.finish();
        });
    }

    /** End the run from outside its loop: Claude Code is stopped (it would otherwise wait on its background work), and its output ends. */
    private finish() {
        if (this.finishing) return;
        this.finishing = true;
        this.stopWaiting();
        clearTimeout(this.settleTimer);
        // Then its output stops being read, even if something it started still holds it open.
        void this.proc.stop(this.aborted ? 1000 : 3000).then(() => this.proc.kill());
    }

    /** Keep delegation credentials on stdin; native project/user/plugin MCP servers load through Claude Code. */
    private async attach() {
        const o = this.t.orchestrator;
        if (!o || this.t.readOnly) return;
        const warn = (message: string) => this.sink.emit({ type: "notice", level: "warn", message });
        const servers = {
            [o.name]: {
                type: "http",
                url: o.url,
                headers: { Authorization: o.authorization },
                timeout: o.toolTimeoutSec * 1000,
                alwaysLoad: true,
                tools: o.tools.map((name) => ({ name, permission_policy: "always_allow" })),
            },
        };
        const id = requestId();
        const answered = new Promise<Record<string, any>>((resolve) => this.controls.set(id, resolve));
        this.proc.send({ type: "control_request", request_id: id, request: { subtype: "mcp_set_servers", servers } });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const r = await Promise.race([answered, this.proc.exited.then(() => undefined), new Promise<undefined>((resolve) => (timer = setTimeout(() => {
            timedOut = true;
            resolve(undefined);
        }, attachTiming.timeoutMs)))]);
        clearTimeout(timer);
        this.controls.delete(id);
        if (this.aborted) return;
        // CLI errors may echo arbitrary env/header values; names and static reasons only.
        const failed = !r || r.subtype !== "success" ? Object.keys(servers) : Object.keys(servers).filter((name) => r.response?.errors?.[name]);
        if (failed.length) warn(`Claude Code ${timedOut ? "timed out waiting for" : "couldn't connect to"} MCP servers: ${failed.map((name) => redact(name)).join(", ")}.`);
    }

    async run(content: unknown[]): Promise<BackendResult> {
        const { signal } = this.t;
        if (signal.aborted) return { reason: "aborted", text: "", actions: [] };
        let env: ReturnType<typeof accountEnv>;
        try {
            env = accountEnv(this.def.id, this.t.accountId, this.t.cwd);
            this.proc = new JsonLinesProcess(this.bin, this.args(), { cwd: this.t.cwd, env });
        } catch (e) {
            this.agentsFile?.remove();
            throw e;
        }
        // Its /goal, as it goes: read from its transcript (src/backends/claude-goal.ts).
        this.goals = new ClaudeGoalWatch(() => (this.sessionId ? claudeTranscriptFile(env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR, this.t.cwd, this.sessionId) : undefined), Date.now(), (goal) => this.sink.emit({ type: "goal", goal }));
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
            this.aborted = true;
            // Nothing to interrupt before the prompt is sent, or while Claude Code only waits on its background work.
            if (!this.prompted || (this.answered && !this.busy && !this.unanswered.size)) return void this.proc.kill();
            this.proc.send({ type: "control_request", request_id: requestId(), request: { subtype: "interrupt" } });
            // It answers an interrupt with a result; if it doesn't, stop it (SIGKILL if need be).
            killTimer = setTimeout(() => void this.proc.kill(), stopTiming.interruptMs);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.proc.send({ type: "control_request", request_id: requestId(), request: { subtype: "initialize", ...this.hookRegistration() } });
        // The prompt waits for the MCP server, so its first request has the harness's tools.
        void this.attach().then(() => this.aborted || this.sendUser(content, this.t.synthetic));
        const goalTimer = setInterval(() => this.goals?.poll(), GOAL_POLL_MS);
        let threw = true;
        try {
            // Claude Code gone (a crash) while something it started holds its output open: once all it wrote is
            // read and nothing more comes for a moment, the run ends rather than waiting for good.
            for await (const m of this.proc.messages({ quietAfterExitMs: backgroundTiming.exitDrainMs })) {
                if (m.type === "result") {
                    this.goals?.poll();
                    this.commandWaitingSince.clear();
                    this.busy = false;
                    const ours = this.answers(m);
                    this.onResult(m, ours);
                    if (ours && !this.unanswered.size) this.answered = true;
                    this.syncBackground();
                    if (this.aborted || (await this.idle())) break;
                    continue;
                }
                this.onMessage(m);
                this.syncBackground();
                // stream-json accepts user messages while running; Claude Code consumes
                // them between tool rounds. Await recording/snapshots before reading
                // subsequent frames so the timeline stays in delivery order.
                if (this.midTurnInput && this.unanswered.size < 64 && m.type === "user" && !m.parent_tool_use_id && Array.isArray(m.message?.content) && m.message.content.some((b: any) => b?.type === "tool_result")) {
                    await this.deliverQueued();
                }
                // Between turns, what changes in the background can end the run.
                if (!this.busy && (await this.idle())) break;
            }
            threw = false;
        } finally {
            clearInterval(goalTimer);
            this.goals?.poll();
            signal.removeEventListener("abort", onAbort);
            this.stopWaiting();
            clearTimeout(this.settleTimer);
            this.finishing = true;
            await this.proc.stop(this.aborted ? 1000 : 3000);
            // How tasks ended that Claude Code said while their stop was pending (a report among them): the
            // process is gone, so no answer will come, and that's how they ended.
            for (const [id, m] of [...this.heldEnds]) {
                this.pendingStops.delete(id);
                this.heldEnds.delete(id);
                this.onSystem(m);
            }
            // The run failed (its host gone, say): what still ran in the background stopped with the process
            // all the same, or the session would list it running for good, with nothing left to stop it.
            if (threw) this.syncBackground(true);
            this.agentsFile?.remove();
            // Polling may still be recording a queued prompt's start. Finish it before Agent records the end.
            await this.idlePending;
            await this.deliveryPending;
            if (killTimer) clearTimeout(killTimer);
        }
        // Anything still open never got a result. Sub-agents still working (in the background) stopped with Claude Code.
        const lost = [...this.liveAgents].filter((id) => this.backgroundAgents.has(id));
        if (lost.length && !this.aborted && !this.toldStopped) {
            const what = describeBackground(lost.map((id) => ({ agent: true, label: this.agentLabels.get(id) ?? "sub-agent" })));
            this.sink.emit({ type: "notice", level: "warn", message: `${what} stopped with Claude Code before reporting back.` });
        }
        const remaining = this.inBackground().filter((t) => !t.agent);
        if (remaining.length && !this.toldStopped) this.noteStopped(remaining, this.aborted ? "esc" : "process");
        const backgroundStopped = this.stoppedBackground.size ? [...this.stoppedBackground] : undefined;
        // Whatever still ran in the background stopped with the process.
        this.syncBackground(true);
        for (const id of [...this.liveAgents]) this.endAgent(id, "aborted");
        for (const [id, p] of this.tools) this.endTool(id, p, this.aborted ? "Interrupted by user" : "Claude Code stopped before this finished.", true);
        const text = this.texts.join("\n\n");
        if (this.aborted) return { reason: "aborted", text, actions: this.actions, backgroundStopped };
        const error = this.failure && this.diagnostic && !this.failure.includes(this.diagnostic) ? `${this.failure} ${this.diagnostic}` : this.failure;
        // A session it can't find ends with an error result (or exit) before init.
        const err = this.proc.stderr();
        const resumeFailed = Boolean(this.t.resumeId && !this.sessionId && /no conversation found|session.{0,40}(not found|doesn't exist|does not exist)/i.test(`${this.failure ?? ""}\n${err}`));
        if (!this.answered || this.unanswered.size || resumeFailed) {
            const code = await this.proc.exited;
            const why = [error, cliMessage(err)].filter(Boolean).join(": ") || `claude exited with code ${code}`;
            // No turn started (no init): it exited before taking the prompt, which isn't in its session. Once a turn has
            // started, it keeps the prompt in its transcript, even when the request then fails (signed out, the limit).
            const refused = this.turnCount === 0 && !resumeFailed;
            return { reason: "error", text, actions: this.actions, backgroundStopped, error: resumeFailed ? `Couldn't resume the Claude Code session: ${why}` : `Claude Code stopped: ${why}`, resumeFailed, ...this.limitStop(), ...(refused ? { refused } : {}) };
        }
        const reason = this.reason ?? "done";
        // An answer with nothing in it (not a command of Claude Code's own, like /compact): said, so the turn isn't just blank.
        if (reason === "done" && !text.trim() && !this.actions.length && !this.t.prompt.trimStart().startsWith("/")) this.sink.emit({ type: "notice", level: "warn", message: "Claude Code ended the turn without a reply." });
        return { reason, text, actions: this.actions, error, backgroundStopped, ...(reason === "error" ? this.limitStop() : {}) };
    }

    /** The turn stopped on the plan's usage limit: when it resets, for an automatic resume. */
    private limitStop(): Pick<BackendResult, "limit"> {
        return this.limitHit ? { limit: { resetsAt: this.limits?.reached ? this.limits.resetsAt : undefined } } : {};
    }

    private fastModeNotice?: string;
    private fastModeObserved = false;

    private reportFastMode(m: Record<string, any>) {
        if (m.fast_mode_state === "on") this.fastModeObserved = true;
        if (!this.t.fastMode || typeof m.fast_mode_state !== "string" || m.fast_mode_state === "on") return;
        const reason = typeof m.fast_mode_disabled_reason === "string" ? m.fast_mode_disabled_reason.replace(/_/g, " ") : m.fast_mode_state;
        if (reason === this.fastModeNotice) return;
        this.fastModeNotice = reason;
        this.sink.emit({ type: "notice", level: "warn", message: `Claude Code is not using fast mode (${reason}). Account, organization settings or capacity can limit availability.` });
    }

    private onMessage(m: Record<string, any>) {
        switch (m.type) {
            case "control_request":
                void this.onControlRequest(m);
                break;
            case "control_response": {
                const r = m.response ?? {};
                this.reportFastMode(r.response ?? {});
                // 2.1.301's results acknowledge all folded input UUIDs, capped at 64.
                // Do not exceed that window or assume older producers aggregate them.
                if (Array.isArray(r.response?.models)) {
                    this.midTurnInput = claudeVersionAtLeast(r.response.claude_code_version, 301);
                    if (!this.midTurnInput) this.sink.emit({ type: "notice", level: "info", message: "This Claude Code version has no verified mid-turn input acknowledgements. Queued messages will be delivered when its current turn ends." });
                }
                this.controls.get(String(r.request_id ?? ""))?.(r);
                break;
            }
            case "system":
                this.onSystem(m);
                break;
            case "stream_event":
                if (!m.parent_tool_use_id) this.onStreamEvent(m.event ?? {});
                break;
            case "assistant":
                this.onAssistant(m);
                break;
            case "user":
                if (!m.parent_tool_use_id) this.onToolResults(m);
                else this.onSubToolResults(m);
                break;
            case "rate_limit_event":
                this.onRateLimit(m.rate_limit_info ?? {});
                break;
            case "active_goal":
                // Its remote sessions report the goal themselves; the transcript says the same, and more (met, impossible).
                this.goals?.poll();
                if (!this.goals?.found) this.sink.emit({ type: "goal", goal: claudeGoal(m.value) });
                break;
        }
    }

    private onSystem(m: Record<string, any>) {
        this.reportFastMode(m);
        switch (m.subtype) {
            case "init":
                this.commandWaitingSince.clear();
                this.clearWaitStatus();
                // Each turn starts with one, a turn Claude Code takes itself (with background reports) too.
                this.busy = true;
                this.turnCount++;
                clearTimeout(this.settleTimer);
                this.settleTimer = undefined;
                if (typeof m.session_id === "string" && m.session_id) {
                    this.sessionId = m.session_id;
                    this.cliSession.sessionId(m.session_id);
                }
                // No API key behind it: the turn runs on the user's plan, not per-token billing.
                this.billedToPlan = m.apiKeySource === "none";
                if (typeof m.model === "string") this.resolvedModel = m.model;
                // It runs these itself when one is the prompt (/context, a skill): they aren't mistyped commands.
                // Not the harness's own skills (harness:name): the menus have those already.
                const names = cliCommandNames(m.slash_commands)?.filter((n) => !n.startsWith(CLAUDE_PREFIX));
                if (names) this.sink.emit({ type: "cli_commands", provider: this.def.id, names });
                break;
            case "background_tasks_changed":
                if (Array.isArray(m.tasks)) {
                    const next = m.tasks.map((t: any) => ({ id: String(t?.task_id ?? ""), type: String(t?.task_type ?? ""), description: typeof t?.description === "string" ? t.description : "" }));
                    // A shell/Monitor may leave the list before its notification and
                    // automatic report turn. Give that turn the same grace as agents.
                    for (const t of this.background ?? []) if (t.type !== "local_agent" && !this.stoppedTaskIds.has(t.id) && !next.some((n: { id: string }) => n.id === t.id)) this.markEnded(t.id);
                    for (const id of this.commandWaitingSince.keys()) {
                        if (!next.some((t: { id: string }) => t.id === id)) this.commandWaitingSince.delete(id);
                    }
                    this.background = next;
                }
                break;
            case "task_progress":
                this.agentUsage(String(m.tool_use_id ?? ""), m.usage);
                break;
            case "api_retry": {
                const delay = Number(m.retry_delay_ms ?? m.delay_ms ?? 0);
                const why = [m.error_status, typeof m.error === "string" ? m.error : m.error?.message].filter(Boolean).join(" ");
                this.sink.emit({ type: "retry", attempt: Number(m.attempt ?? 1), delayMs: delay, reason: why || "Claude Code is retrying the request" });
                break;
            }
            case "compact_boundary":
                this.sink.emit({ type: "notice", level: "info", message: "Claude Code compacted its context." });
                break;
            case "task_started": {
                const id = String(m.tool_use_id ?? "");
                if (this.shellCommands.has(id) && typeof m.task_id === "string") this.taskCommands.set(m.task_id, { ...this.shellCommands.get(id)!, started: Date.now() });
                if (this.agentLabels.has(id) && typeof m.task_id === "string") this.agentTasks.set(id, m.task_id);
                // Its permission requests carry this id (agent_id): which agent asks.
                if (typeof m.task_id === "string" && typeof m.subagent_type === "string") this.agentTypes.set(m.task_id, m.subagent_type);
                if (m.is_backgrounded === true && this.agentLabels.has(id)) this.backgroundAgents.add(id);
                this.agentStarted(id);
                break;
            }
            case "task_notification": {
                this.commandWaitingSince.delete(m.task_id);
                if (typeof m.task_id === "string" && typeof m.status === "string") this.taskEnds.set(m.task_id, m.status);
                // A sub-agent finished (in the foreground, this comes before its Agent call's result). It
                // ran even if nothing of it showed. A later one replaces what this one said (the report it
                // was waiting on, or how it ended).
                const id = String(m.tool_use_id ?? "");
                const summary = typeof m.summary === "string" ? m.summary.trim() : "";
                if (this.stoppedTaskIds.has(m.task_id)) break;
                // A background task's end: its report turn is due from now (reportDue), unless a stop of ours ended it.
                if (typeof m.task_id === "string" && (this.agentLabels.has(id) ? this.backgroundAgents.has(id) : this.background?.some((t) => t.id === m.task_id))) this.markEnded(m.task_id);
                // Its stop is being answered: if it doesn't go through, this is how the task ended.
                if (this.pendingStops.has(m.task_id)) {
                    this.heldEnds.set(m.task_id, m);
                    break;
                }
                const listed = this.background?.find((t) => t.id === m.task_id);
                if (listed && !this.agentLabels.has(id)) this.background = this.background!.filter((t) => t.id !== m.task_id);
                if (!this.agentLabels.has(id)) {
                    // One an earlier run left behind (stopped with it): Claude Code says so as it resumes the session,
                    // before the run's first turn. Not a command of this run's that ended (a foreground one stopped by Esc,
                    // a sub-agent's that failed): its own row says so (#311).
                    const leftBehind = Boolean(this.t.resumeId) && this.turnCount === 0 && m.owned_by_subagent !== true;
                    if (leftBehind && summary && (m.status === "stopped" || m.status === "failed")) this.sink.emit({ type: "notice", level: "info", message: `Claude Code: ${summary}.` });
                    break;
                }
                const background = this.backgroundAgents.has(id);
                // Over, whether or not Claude Code says so in its list too.
                if (this.background && typeof m.task_id === "string") this.background = this.background.filter((t) => t.id !== m.task_id);
                let report = typeof m.handback_report?.text === "string" ? m.handback_report.text : undefined;
                // In the background its report goes to the main agent in a turn of its own: what it said last.
                if (report === undefined && background && m.status === "completed") report = this.lastWords.get(id) ?? (summary || undefined);
                this.agentStarted(id);
                this.agentUsage(id, m.usage);
                this.endAgent(id, m.status === "completed" ? "done" : m.status === "failed" ? "error" : "aborted", report);
                break;
            }
            case "informational":
                if (typeof m.content === "string" && m.content.trim()) this.sink.emit({ type: "notice", level: m.level === "warning" ? "warn" : m.level === "error" ? "error" : "info", message: m.content });
                break;
        }
    }

    private onStreamEvent(e: Record<string, any>) {
        switch (e.type) {
            case "message_start":
                this.sink.emit({ type: "request_start" });
                break;
            case "content_block_start":
                if (e.content_block?.type === "tool_use") {
                    this.streamingTools.set(e.index, e.content_block.id);
                    // Under the harness's name from the start (Agent is a sub-agent's Task), as its call will be.
                    this.sink.emit({ type: "tool_call_start", id: e.content_block.id, name: toHarness(String(e.content_block.name ?? ""), {}).name });
                }
                break;
            case "content_block_delta": {
                const d = e.delta ?? {};
                if (d.type === "text_delta" && d.text) this.sink.emit({ type: "text", text: d.text });
                else if (d.type === "thinking_delta" && d.thinking) this.sink.emit({ type: "thinking", text: d.thinking });
                else if (d.type === "input_json_delta" && d.partial_json) {
                    const id = this.streamingTools.get(e.index);
                    if (id) this.sink.emit({ type: "tool_call_delta", id, partial: d.partial_json });
                }
                break;
            }
        }
    }

    private onAssistant(m: Record<string, any>) {
        const msg = m.message ?? {};
        const blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
        const parent: string | undefined = m.parent_tool_use_id ?? undefined;
        if (parent) {
            // A sub-agent's step: show its tool calls under the Agent call.
            const label = this.agentLabels.get(parent) ?? "sub-agent";
            this.agentStarted(parent);
            // One Claude Code said has finished shows no more steps (they'd never be closed), only its report.
            const over = this.endedAgents.has(parent);
            for (const b of blocks) {
                if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) this.lastWords.set(parent, b.text);
                if (b?.type !== "tool_use") continue;
                // Its report to the main agent: what it says last, not a tool of its own.
                if (b.name === "SubagentHandback") {
                    const fresh = typeof b.input?.message === "string" && this.report(parent, b.input.message);
                    // One that ended before it (waiting on work of its own) takes it as its report: it ends again, as it did.
                    const was = this.endedAgents.get(parent);
                    if (fresh && over && was !== undefined) this.sink.emit({ type: "subagent", parentId: parent, label, event: { type: "turn_end", reason: was } });
                    continue;
                }
                if (over) continue;
                const { name, input } = toHarness(b.name, b.input ?? {});
                const title = titleFor(name, input);
                if (b.name === "Bash" && typeof input.command === "string") this.shellCommands.set(b.id, { command: input.command, timeoutMs: claudeCommandTimeoutMs(input) });
                this.subTools.set(b.id, { name, input, title, started: Date.now(), parent });
                this.sink.emit({ type: "subagent", parentId: parent, label, event: { type: "tool_start", call: { type: "tool_call", id: b.id, name, input }, title } });
            }
            return;
        }
        if (msg.usage) {
            const u = msg.usage;
            const tokens = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0) + Number(u.output_tokens ?? 0);
            // Shown as it works: a long turn's context doesn't wait for its result.
            if (tokens && tokens !== this.contextTokens) this.cliSession.context?.(tokens);
            this.contextTokens = tokens;
        }
        if (m.error) {
            this.onAssistantError(String(m.error));
            // These blocks are CLI diagnostics, not model prose. Preserve genuine
            // earlier replies; the Agent records failure as a notice, outside history.
            const detail = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
            if (detail.trim()) this.diagnostic = redact(detail);
            return;
        }
        for (const b of blocks) {
            if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
                this.texts.push(b.text);
                this.sink.emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: b.text }], provider: this.def.id, model: this.t.model.id } });
            } else if (b?.type === "tool_use" && typeof b.id === "string") {
                const { name, input } = toHarness(b.name, b.input ?? {});
                const title = titleFor(name, input);
                this.tools.set(b.id, { name, input, title, started: Date.now() });
                if (b.name === "Bash" && typeof input.command === "string") this.shellCommands.set(b.id, { command: input.command, timeoutMs: claudeCommandTimeoutMs(input) });
                if (b.name === "Agent" || b.name === "Task") this.agentLabels.set(b.id, String(input.description ?? input.subagent_type ?? "sub-agent"));
                this.sink.emit({ type: "tool_start", call: { type: "tool_call", id: b.id, name, input }, title });
            }
        }
    }

    private onAssistantError(error: string) {
        if (error === "authentication_failed") {
            this.signedOut = true;
            this.failure = `Claude Code isn't signed in, or its sign-in expired. ${signInAdvice(this.def.id, this.t.accountId)}`;
        } else if (error === "rate_limit") {
            this.limitHit = true;
            if (!this.limits?.reached) this.noteLimits({ provider: this.def.id, accountId: this.t.accountId ?? "default", windows: [], reached: true, at: Date.now() }, true);
            this.failure = this.limitFailure();
        }
        else if (error === "billing_error") this.failure = "Claude Code reported a billing problem with the account it's signed in to.";
        else this.failure = `Claude Code reported an error: ${error}`;
    }

    private onToolResults(m: Record<string, any>) {
        const blocks: any[] = (Array.isArray(m.message?.content) ? m.message.content : []).filter((b: any) => b?.type === "tool_result");
        for (const b of blocks) {
            const p = this.tools.get(b.tool_use_id);
            if (!p) continue;
            let content = resultText(b.content);
            if (p.name === "Task") {
                // A sub-agent in the background goes on after this; one in the foreground is over.
                const background = m.tool_use_result?.status === "async_launched";
                if (background) {
                    this.backgroundAgents.add(b.tool_use_id);
                    this.agentStarted(b.tool_use_id);
                    // Its call is open while the sub-agent works, and ends with it (with its report, and how long it ran).
                    const was = this.endedAgents.get(b.tool_use_id);
                    if (was === undefined) {
                        this.launched.add(b.tool_use_id);
                        continue;
                    }
                    content = this.reports.get(b.tool_use_id) ?? LAUNCH_END[was] ?? content;
                    this.closedLaunches.set(b.tool_use_id, { ...p, reason: was, ended: Date.now() });
                    this.endTool(b.tool_use_id, p, content, endedBadly(was));
                    continue;
                }
                // Once Claude Code has said how it ended, the result only brings its report.
                const report = handedBack(m);
                if (!this.endedAgents.has(b.tool_use_id)) this.endAgent(b.tool_use_id, b.is_error ? "error" : "done", report);
                else if (report) this.report(b.tool_use_id, report, true);
                // Its report came as a handback: the result only says where to find it.
                content = this.reports.get(b.tool_use_id) || content;
            }
            // The structured result (for diffs) describes the message's one tool result.
            const structured = blocks.length === 1 && !b.is_error ? resultDisplay(p, m.tool_use_result, this.t.cwd) : undefined;
            this.endTool(b.tool_use_id, p, content, Boolean(b.is_error), structured);
        }
    }

    /** A sub-agent's tool results: its tool calls under the Agent call finish. */
    private onSubToolResults(m: Record<string, any>) {
        this.agentStarted(String(m.parent_tool_use_id));
        const blocks: any[] = (Array.isArray(m.message?.content) ? m.message.content : []).filter((b: any) => b?.type === "tool_result");
        for (const b of blocks) {
            const p = this.subTools.get(b.tool_use_id);
            if (!p) continue;
            // A sub-agent's own Agent call: its report rather than where it went, as at the top level.
            const content = (p.name === "Task" && (this.reports.get(b.tool_use_id) || (blocks.length === 1 && handedBack(m)))) || resultText(b.content);
            const structured = blocks.length === 1 && !b.is_error ? resultDisplay(p, m.tool_use_result, this.t.cwd) : undefined;
            this.endSubTool(b.tool_use_id, p, content, Boolean(b.is_error), structured);
        }
    }

    private endSubTool(id: string, p: PendingTool & { parent: string }, content: string, isError: boolean, display?: ToolDisplay) {
        this.subTools.delete(id);
        const label = this.agentLabels.get(p.parent) ?? "sub-agent";
        this.sink.emit({ type: "subagent", parentId: p.parent, label, event: { type: "tool_end", call: { type: "tool_call", id, name: p.name, input: p.input }, result: { content, isError, display }, durationMs: Date.now() - p.started } });
    }

    /**
     * A sub-agent's report, shown as the last thing it says; whether it's new.
     * Claude Code's word on it (a notification, the call's result) replaces an
     * earlier one; its own SubagentHandback calls don't (a second is turned down).
     */
    private report(parent: string, text: string, replace = false): boolean {
        const had = this.reports.get(parent);
        if (!text.trim() || (had !== undefined && (!replace || had.trim() === text.trim()))) return false;
        this.reports.set(parent, text);
        // Only on a sub-agent that has a chip: one that never started would get one that never ends.
        if (this.liveAgents.has(parent) || this.endedAgents.has(parent)) this.sink.emit({ type: "subagent", parentId: parent, label: this.agentLabels.get(parent) ?? "sub-agent", event: { type: "text", text } });
        // A background sub-agent's call that ended before: its result is this report now (and it still says how it ended).
        const p = this.closedLaunches.get(parent);
        if (p) this.relaunchEnd(parent, p, text);
        return true;
    }

    /** A sub-agent's tokens as Claude Code reports them (a total so far): what's new goes to its chip. */
    private agentUsage(id: string, u: unknown) {
        const total = Number((u as { total_tokens?: unknown } | undefined)?.total_tokens);
        // Only for one with a chip (one that never started would get one that never ends).
        if (!Number.isFinite(total) || !(this.liveAgents.has(id) || this.endedAgents.has(id))) return;
        const had = this.agentTokens.get(id) ?? 0;
        if (total <= had) return;
        this.agentTokens.set(id, total);
        this.sink.emit({ type: "subagent", parentId: id, label: this.agentLabels.get(id) ?? "sub-agent", event: { type: "usage", usage: { inputTokens: total - had, outputTokens: 0 }, cost: { usd: 0, estimated: true, unknown: true }, contextTokens: total, displayOnly: true } });
    }

    /**
     * A background sub-agent's call, open since its launch, ends with it: its
     * report is its result, and it fails as the sub-agent did. One said to end
     * another way (it failed after all) says so too; said to end as it did,
     * it keeps what it said.
     */
    private closeLaunch(id: string, reason: TurnEndReason) {
        const closed = this.closedLaunches.get(id);
        if (closed) {
            if (endedBadly(closed.reason) === endedBadly(reason)) return;
            closed.reason = reason;
            this.relaunchEnd(id, closed, this.reports.get(id) ?? LAUNCH_END[reason] ?? LAUNCH_END.aborted!);
            return;
        }
        const p = this.tools.get(id);
        if (!p || !this.launched.delete(id)) return;
        this.closedLaunches.set(id, { ...p, reason, ended: Date.now() });
        this.endTool(id, p, this.reports.get(id) ?? LAUNCH_END[reason] ?? LAUNCH_END.aborted!, endedBadly(reason));
    }

    /** A background sub-agent's call that ended before, ending again: with what it says now, and as long as it ran then. */
    private relaunchEnd(id: string, p: PendingTool & { reason: TurnEndReason; ended: number }, content: string) {
        this.sink.emit({ type: "tool_end", call: { type: "tool_call", id, name: p.name, input: p.input }, result: { content, isError: endedBadly(p.reason) }, durationMs: p.ended - p.started });
    }

    private agentStarted(id: string) {
        if (this.agentLabels.has(id) && !this.endedAgents.has(id)) this.liveAgents.add(id);
    }

    /** A sub-agent is over (or Claude Code says again how it ended): its open tool calls with it, and its chip says how. */
    private endAgent(id: string, reason: TurnEndReason, report?: string) {
        const live = this.liveAgents.delete(id);
        const was = this.endedAgents.get(id);
        if (!live && was === undefined) {
            // One that never showed has no chip: its report is for its Agent call's result.
            if (report) this.report(id, report, true);
            this.closeLaunch(id, reason);
            return;
        }
        this.endedAgents.set(id, reason);
        const reported = report ? this.report(id, report, true) : false;
        if (!live && !reported && reason === was) return;
        for (const [sub, p] of this.subTools) if (p.parent === id) this.endSubTool(sub, p, reason === "done" ? "Claude Code didn't report a result for this." : "Stopped with the sub-agent.", true);
        // Before its chip ends, so what the call says without a report isn't taken for one.
        this.closeLaunch(id, reason);
        this.sink.emit({ type: "subagent", parentId: id, label: this.agentLabels.get(id) ?? "sub-agent", event: { type: "turn_end", reason } });
    }

    private endTool(id: string, p: PendingTool, content: string, isError: boolean, display?: ToolDisplay) {
        this.tools.delete(id);
        this.actions.push(p.title);
        this.sink.emit({ type: "tool_end", call: { type: "tool_call", id, name: p.name, input: p.input }, result: { content, isError, display }, durationMs: Date.now() - p.started });
    }

    private noteLimits(limits: PlanLimits, partial: boolean) {
        this.limits = mergeLimits(this.limits, limits, partial);
        this.cliSession.limits?.(limits, partial);
    }

    private limitFailure(): string {
        return `${limitAccountLabel(this.def.id, this.t.accountId)}: usage limit reached. ${resetSentence(this.limits?.resetsAt, "Claude Code")} Choose another account with /account or the plan meter, then send again.`;
    }

    private onRateLimit(info: Record<string, any>) {
        const parsed = parseClaudeRateLimit(info, Date.now(), this.t.accountId ?? "default");
        if (parsed) {
            // A sparse rejection must not forget another window that still blocks this turn.
            this.limits = mergeLimits(this.limits, parsed.limits, parsed.partial);
            this.cliSession.limits?.(parsed.limits, parsed.partial);
        }
        const w = parsed?.limits.windows.find((x) => x.id === info.rateLimitType);
        // Every status counts, so a warning after the window was fine again (or reset) is news again.
        const news = typeof info.status === "string" && limitNews(this.limitSeen, `${this.t.accountId ?? "default"}:${String(info.rateLimitType ?? "")}`, info.status, w?.resetsAt);
        if (info.status !== "rejected" && info.status !== "allowed_warning") return;
        const which = w ? `${w.label.charAt(0).toLowerCase()}${w.label.slice(1)} ` : "";
        if (info.status === "rejected") {
            // The turn's error (it may have come first) says when, now that it's known.
            if (this.limitHit) this.failure = this.limitFailure();
            if (this.reachedNoted) return;
            this.reachedNoted = true;
            this.sink.emit({ type: "notice", level: "warn", message: `${limitAccountLabel(this.def.id, this.t.accountId)}: ${which}usage limit reached. ${resetSentence(this.limits?.resetsAt, "Claude Code")}` });
        } else if (news) this.sink.emit({ type: "notice", level: "info", message: `${limitAccountLabel(this.def.id, this.t.accountId)}: close to the ${which}usage limit.${w?.resetsAt ? ` It resets ${resetPhrase(w.resetsAt)}.` : ""}` });
    }

    /** A result: one answering the run's prompts (`ours`), or one for a turn Claude Code took itself. */
    private onResult(m: Record<string, any>, ours: boolean) {
        this.reportFastMode(m);
        const u = m.usage ?? {};
        // Each result's total_cost_usd includes the session's earlier ones: what's new is this result's.
        const total = typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined;
        const spent = total === undefined ? undefined : this.spent === undefined ? total : Math.max(0, total - this.spent);
        if (total !== undefined) this.spent = Math.max(total, this.spent ?? 0);
        const usage: Usage = {
            inputTokens: Number(u.input_tokens ?? 0),
            outputTokens: Number(u.output_tokens ?? 0),
            cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
            cacheWriteTokens: Number(u.cache_creation_input_tokens ?? 0),
            // How long its cache lasts (an hour on a subscription): idle compaction goes by it.
            ...(u.cache_creation && typeof u.cache_creation === "object" ? { cacheWrite1hTokens: Number(u.cache_creation.ephemeral_1h_input_tokens ?? 0) } : {}),
            // Fast service uses paid credits even on a subscription. A final cooldown
            // must not erase earlier fast spend; the CLI only gives a whole-turn total.
            cost: this.billedToPlan && !this.fastModeObserved ? 0 : spent,
            billing: this.billedToPlan && !this.fastModeObserved ? "plan" : "api",
        };
        // A turn of Claude Code's own that made no request (a report it passes on from an earlier run): nothing to count.
        const nothing = !ours && !usage.inputTokens && !usage.outputTokens && !usage.cacheReadTokens && !usage.cacheWriteTokens && !spent;
        if (!nothing) {
            const mixedPlanCost = this.billedToPlan && this.fastModeObserved && m.fast_mode_state !== "on";
            if (mixedPlanCost) this.sink.emit({ type: "notice", level: "info", message: "Claude Code changed speed during this turn. The displayed cost is its total estimate; the share covered by your plan is not reported." });
            if (mixedPlanCost) usage.costEstimated = true;
            const models = Object.keys(m.modelUsage ?? {});
            // A result can include several models; its init identifies the main one.
            const served = models.length === 1 ? models[0] : models.find((id) => id === this.resolvedModel);
            if (served) usage.resolvedModel = `${this.def.id}:${served}`;
            const window = Object.values((m.modelUsage ?? {}) as Record<string, { contextWindow?: number }>).find((x) => typeof x?.contextWindow === "number")?.contextWindow;
            this.cliSession.usage(usage, { contextTokens: this.contextTokens, contextWindow: window });
        }
        if (this.aborted) return;
        // How a turn of Claude Code's own went counts only when it went wrong.
        if (!ours && m.subtype === "success" && !m.is_error) return;
        if (m.subtype === "error_max_turns") this.reason = "max_turns";
        else if (m.subtype !== "success" || m.is_error) {
            this.reason = "error";
            const errs = Array.isArray(m.errors) ? m.errors.filter((x: unknown) => typeof x === "string") : [];
            this.failure ??= redact(errs.join("; ") || (typeof m.result === "string" && m.result) || `Claude Code ended the turn with ${m.subtype}`);
            if (this.signedOut) this.failure = `Claude Code isn't signed in, or its sign-in expired. ${signInAdvice(this.def.id, this.t.accountId)}`;
        } else this.reason = "done";
    }

    /**
     * The harness's hooks for the events Claude Code runs itself, one matcher
     * group per handler: Claude Code matches, runs them at once and merges
     * their answers, calling back (hook_callback) for each.
     */
    private hookRegistration(): { hooks?: Record<string, { matcher?: string; hookCallbackIds: string[]; timeout?: number }[]> } {
        if (!this.t.hooks || !this.cliSession.hookHandler) return {};
        const hooks: Record<string, { matcher?: string; hookCallbackIds: string[]; timeout?: number }[]> = {};
        let n = 0;
        for (const [event, list] of Object.entries(this.t.hooks) as [HookEvent, HookConfig[]][]) {
            // Prompt hooks Claude Code runs itself, with its own model (claudePromptHooks).
            const called = list.filter((hook) => hook.type !== "prompt");
            if (!called.length) continue;
            hooks[event] = called.map((hook) => {
                const id = `harness_${n++}`;
                this.hookCallbacks.set(id, { event, hook });
                return { ...(hook.matcher ? { matcher: backendMatcher(event, hook.matcher) } : {}), hookCallbackIds: [id], timeout: hook.timeout ?? 60 };
            });
        }
        return n ? { hooks } : {};
    }

    private async hookCallback(req: Record<string, any>): Promise<Record<string, unknown>> {
        const cb = this.hookCallbacks.get(String(req.callback_id ?? ""));
        if (!cb || !this.cliSession.hookHandler) return {};
        const input: Record<string, unknown> = req.input && typeof req.input === "object" ? req.input : {};
        const r = await this.cliSession.hookHandler(cb.event, cb.hook, input, this.t.signal);
        return claudeCodeHookOutput(cb.event, r);
    }

    private async onControlRequest(m: Record<string, any>) {
        const req = m.request ?? {};
        const reply = (response: Record<string, unknown>) => this.proc.send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
        if (req.subtype === "hook_callback") {
            // A hook that fails says nothing (the harness has shown why): Claude Code goes on as if it weren't there.
            reply(await this.hookCallback(req).catch(() => ({})));
            return;
        }
        if (req.subtype !== "can_use_tool") {
            this.proc.send({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: `${String(req.subtype)} isn't supported by this host` } });
            return;
        }
        try {
            reply({ ...(await this.permission(req)), toolUseID: req.tool_use_id });
        } catch (e) {
            reply({ behavior: "deny", message: `The permission check failed: ${redact((e as Error).message)}`, interrupt: true, toolUseID: req.tool_use_id });
        }
    }

    private async permission(req: Record<string, any>): Promise<Record<string, unknown>> {
        const raw: Record<string, unknown> = req.input && typeof req.input === "object" ? req.input : {};
        if (req.tool_name === "AskUserQuestion") {
            const qs: any[] = Array.isArray(raw.questions) ? raw.questions : [];
            const questions = qs.map((q) => ({
                question: String(q?.question ?? ""),
                header: typeof q?.header === "string" ? q.header : undefined,
                options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({ label: String(o?.label ?? ""), description: typeof o?.description === "string" ? o.description : undefined })),
                multiSelect: Boolean(q?.multiSelect),
            }));
            const answers = await this.cliSession.askQuestions(questions);
            if (!answers) return { behavior: "deny", message: "The user dismissed the question without answering.", interrupt: true };
            return { behavior: "allow", updatedInput: { ...raw, answers: Object.fromEntries(questions.map((q, i) => [q.question, (answers[i] ?? []).join(", ")])) } };
        }
        if (req.tool_name === "ExitPlanMode") {
            const r = await this.cliSession.approvePlan(String(raw.plan ?? ""));
            if (r.approved) {
                const mode = r.mode ?? "default";
                this.cliSession.setMode(mode);
                return { behavior: "allow", updatedInput: raw, updatedPermissions: [{ type: "setMode", mode: MODES[mode], destination: "session" }] };
            }
            const fb = r.feedback?.trim();
            // Taken to another session: this turn stops here, still in plan mode.
            if (r.handoff) return { behavior: "deny", message: `The user is carrying out this plan in another session instead. ${fb ?? ""} Don't continue it here.`, interrupt: true };
            return fb ? { behavior: "deny", message: `The user wants changes to the plan:\n${fb}` } : { behavior: "deny", message: "The user rejected the plan. Wait for them to say how to proceed.", interrupt: true };
        }
        // The harness's own tools: what a delegated agent does is checked when it does it, and run_with_secrets checks its command itself.
        const own = this.t.orchestrator;
        if (own && own.tools.some((t) => req.tool_name === `mcp__${own.name}__${t}`)) return { behavior: "allow", updatedInput: raw };
        const { name, input } = toHarness(String(req.tool_name ?? ""), raw);
        const reason = typeof req.decision_reason === "string" && req.decision_reason.trim() ? req.decision_reason : undefined;
        const agentType = typeof req.agent_id === "string" ? this.agentTypes.get(req.agent_id) : undefined;
        const a = await this.cliSession.permission({ toolName: name, input, title: titleFor(name, input), reason, callId: typeof req.tool_use_id === "string" ? req.tool_use_id : undefined, ...(agentType ? { agentType } : {}) });
        if (a.allow) return { behavior: "allow", updatedInput: a.updatedInput ?? raw, ...(a.mode ? { updatedPermissions: [{ type: "setMode", mode: MODES[a.mode], destination: "session" }] } : {}) };
        return { behavior: "deny", message: a.message, interrupt: a.stop };
    }
}

/**
 * The prompt as text blocks: what Harness put before the user's words (BackendTurn.preamble) in one of its own, then
 * theirs, last. Claude Code reads only the last text block as what the user typed (a /command; the blocks before it
 * go along as they are), and the message stays the user's: it isn't marked synthetic for Harness's catch-up.
 */
export function textBlocks(prompt: string, preamble?: string): Record<string, unknown>[] {
    const split = splitPreamble(prompt, preamble);
    return [...(split.preamble ? [{ type: "text", text: split.preamble }] : []), { type: "text", text: split.text }];
}

/** The prompt's preamble (BackendTurn.preamble) and the user's words after it, apart; all of it as theirs if it has none. */
export function splitPreamble(prompt: string, preamble?: string): { preamble?: string; text: string } {
    const own = preamble && prompt.startsWith(preamble) ? prompt.slice(preamble.length) : undefined;
    if (!own?.trim() || !preamble!.trim()) return { text: prompt };
    return { preamble: preamble!.trimEnd(), text: own };
}

/** What claudeArgs reads of a turn: its spawn settings. */
export type ClaudeSpawnSettings = Pick<BackendTurn, "mode" | "model" | "effort" | "resumeId" | "forkSession" | "maxTurns" | "additionalDirectories" | "pluginDirs" | "readOnly" | "trusted" | "agents" | "rules" | "orchestrator" | "fastMode" | "cwd" | "approvedMcpServers" | "hooks">;

/**
 * `claude -p`'s arguments for a turn's settings: the stream-json protocol, the mode, model and effort, the
 * session to resume, and what keeps it within the harness's rules (--settings: permissions, the sandbox,
 * MCP policy, prompt hooks). `append`: the parts of --append-system-prompt (empty ones left out).
 * `mcpWarning`: what the MCP policy says the user should know. `accountDenies: false` leaves out the deny
 * rules for CLI account folders (a live process's fingerprint: accounts added or removed restart nothing).
 */
export function claudeArgs(defId: string, t: ClaudeSpawnSettings, o: { pluginDir?: string; agentsPath?: string; append: (string | undefined)[]; accountDenies?: boolean }): { args: string[]; mcpWarning?: string } {
    const a = [...extraArgs(defId), ...STREAM_ARGS, "--include-partial-messages", "--permission-prompt-tool=stdio", "--permission-mode", MODES[t.mode]];
    if (t.model.id !== "default") a.push("--model", t.model.id);
    if (t.effort && (!t.model.effortLevels || t.model.effortLevels.includes(t.effort))) a.push("--effort", t.effort);
    if (t.resumeId) a.push("--resume", t.resumeId, ...(t.forkSession ? ["--fork-session"] : []));
    if (t.maxTurns && Number.isFinite(t.maxTurns)) a.push("--max-turns", String(t.maxTurns));
    const append = o.append.filter(Boolean).join("\n\n");
    if (append) a.push("--append-system-prompt", append);
    for (const d of t.additionalDirectories) a.push("--add-dir", d);
    if (o.pluginDir) a.push("--plugin-dir", o.pluginDir);
    // The harness's plugins, in Claude Code's own format: it runs their commands, agents, skills, hooks and servers.
    if (!t.readOnly) for (const d of t.pluginDirs ?? []) a.push("--plugin-dir", d);
    // An untrusted folder's Claude Code settings (hooks, permission rules), skills, agents and .mcp.json stay off.
    if (!t.trusted) a.push("--setting-sources", "user");
    // The harness's agents, for its own Agent tool.
    if (o.agentsPath && t.agents && Object.keys(t.agents).length && !t.readOnly) a.push("--agents", o.agentsPath);
    // The harness's deny and ask rules also cover what Claude Code would do without asking.
    // Named accounts add only deny rules for their folders (#375): nothing that changes how Claude Code asks or sandboxes.
    const permissions = claudePermissions(t.rules, o.accountDenies !== false);
    // Its own schedules would fire only while its process runs (it's stopped at a turn's end, or when idle): Harness's schedule tools keep them instead.
    if (t.orchestrator?.tools.includes("schedule_create")) permissions.deny.push(...CLAUDE_SCHEDULE_TOOLS);
    // Always override external preferences: an unsupported model must not silently switch to Opus.
    const fastMode = Boolean(t.fastMode && t.model.supportsFastMode);
    const mcp = t.trusted && !t.readOnly ? claudeMcpPolicy(t.cwd, t.approvedMcpServers) : { strict: true };
    if (mcp.strict) a.push("--strict-mcp-config");
    if (!t.readOnly) {
        a.push("--settings", JSON.stringify({ permissions, fastMode, ...mcp.settings, ...claudePromptHooks(t.hooks) }));
        return { args: a, mcpWarning: mcp.warning };
    }
    // A read-only sub-agent: no edit tools, no MCP servers of its own, and every command asks (the harness lets read-only ones run).
    a.push("--disallowedTools", READ_ONLY_DENY.join(","));
    const settings = { fastMode, permissions: { deny: [...permissions.deny, ...READ_ONLY_DENY], ask: [...permissions.ask, "Bash"] }, sandbox: { autoAllowBashIfSandboxed: false }, ...claudePromptHooks(t.hooks) };
    a.push("--settings", JSON.stringify(settings));
    return { args: a, mcpWarning: mcp.warning };
}

/** A prompt's images and PDFs as Claude Code takes them, after its text. */
export function mediaBlocks(images: readonly ImagePart[], documents: readonly PdfPart[]): Record<string, unknown>[] {
    return [
        ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } })),
        ...documents.map((d) => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: d.data } })),
    ];
}

/** When a background command with a timeout of its own is up: its timeout (at most Claude Code's maximum) from its start. */
function ownDeadline(t: BackgroundWork): number | undefined {
    return t.timeoutMs !== undefined && t.started !== undefined ? t.started + Math.min(t.timeoutMs, backgroundTiming.commandMaxTimeoutMs) : undefined;
}

/** "2 background sub-agents (Map auth, Check tests)". */
export function describeBackground(list: { agent: boolean; label: string }[]): string {
    const kind = list.length && list.every((x) => x.agent) ? "background sub-agent" : "background task";
    const shown = list.slice(0, 3).map((x) => x.label);
    return `${plural(list.length, kind)}${shown.length ? ` (${shown.join(", ")}${list.length > shown.length ? `, and ${list.length - shown.length} more` : ""})` : ""}`;
}

/** The report a sub-agent handed back, as its Agent call's structured result carries it. */
export function handedBack(m: Record<string, any>): string | undefined {
    const text = m.tool_use_result?.handbackReport?.text;
    return typeof text === "string" ? text : undefined;
}

const PATH_RULE: Record<string, "Read" | "Edit"> = { Read: "Read", Glob: "Read", Grep: "Read", LS: "Read", Edit: "Edit", Write: "Edit", MultiEdit: "Edit", NotebookEdit: "Edit" };

/**
 * One harness rule as Claude Code permission rules, or none when Claude Code
 * has no equivalent (those still apply to whatever it asks about). Paths are
 * resolved the way the harness resolves them and passed as absolute (//…)
 * patterns, plus everything under them for a plain path, as the harness
 * matches; edit and read rules widen to all of Claude Code's edit or read
 * tools, which only makes a deny or ask rule stricter.
 */
export function claudeRule(raw: string, root: string): string[] {
    const { tool, spec } = parseRule(raw);
    const kind = PATH_RULE[tool];
    if (kind) {
        if (!spec) return [kind];
        const abs = pathPattern(spec, root);
        const rules = [`${kind}(/${abs})`];
        if (!/[*?]/.test(spec)) rules.push(`${kind}(/${abs.replace(/\/+$/, "")}/**)`);
        return rules;
    }
    if (tool === "Bash" || tool === "WebSearch") return [spec ? `${tool}(${spec})` : tool];
    if (tool === "WebFetch") {
        if (!spec) return ["WebFetch"];
        const domain = spec.match(/^domain:(.+)$/)?.[1];
        if (!domain) return [];
        // The harness's domain:example.com covers its subdomains; Claude Code's needs *.example.com for those.
        return domain.startsWith("*.") ? [`WebFetch(${spec})`] : [`WebFetch(${spec})`, `WebFetch(domain:*.${domain})`];
    }
    // Every tool: Claude Code takes a bare *; with a path (or a domain), every tool that reads or edits it.
    if (tool === "*") {
        if (!spec) return ["*"];
        if (/^domain:/.test(spec)) return claudeRule(`WebFetch(${spec})`, root);
        return [...claudeRule(`Read(${spec})`, root), ...claudeRule(`Edit(${spec})`, root)];
    }
    if (tool === "Task") return [spec ? `Agent(${spec})` : "Agent"];
    if (tool.startsWith("mcp__")) return [tool];
    return [];
}

/**
 * The harness's deny and ask rules for Claude Code, with its credential store denied outright, and with
 * `accounts`, CLI account folders and sign-in files too.
 */
export function claudePermissions(r: { deny: string[]; ask: string[]; root: string }, accounts = true): { deny: string[]; ask: string[] } {
    const store = [paths.credentialsFile(), paths.mcpOAuth(), paths.providers()].flatMap((f) => [`Read(/${f})`, `Edit(/${f})`]);
    const folders = (accounts ? accountProtectionFolders() : []).flatMap((folder) => [`Read(/${folder})`, `Read(/${folder}/**)`, `Edit(/${folder})`, `Edit(/${folder}/**)`]);
    const map = (rules: string[]) => [...new Set(rules.flatMap((x) => claudeRule(x, r.root)))];
    return { deny: [...map(r.deny), ...store, ...folders], ask: map(r.ask) };
}

/** Claude Code's tool name and input as the harness's own tool sees them (for rules, titles, previews). */
export function toHarness(name: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> } {
    if (name === "Agent") return { name: "Task", input };
    return { name, input };
}

/** A transcript title like the harness's own tools use. */
export function titleFor(name: string, input: Record<string, unknown>): string {
    const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
    switch (name) {
        case "Bash":
            return commandTitle(s("command"));
        case "Read":
        case "Write":
        case "Edit":
        case "MultiEdit":
            return `${name}(${s("file_path")})`;
        case "NotebookEdit":
            return `NotebookEdit(${s("notebook_path")})`;
        case "Glob":
        case "Grep":
            return `${name}(${s("pattern")}${s("path") ? ` in ${s("path")}` : ""})`;
        case "WebFetch":
            return `WebFetch(${s("url")})`;
        case "WebSearch":
            return `WebSearch(${s("query")})`;
        case "Task":
            return `Task(${s("description") || s("subagent_type")})`;
        case "Skill":
            return `Skill(${(s("skill") || s("name")).replace(CLAUDE_PREFIX, "")})`;
        default:
            return name;
    }
}

export function resultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((c: any) => (c?.type === "text" ? String(c.text ?? "") : c?.type === "image" ? "[image]" : ""))
            .filter(Boolean)
            .join("\n");
    }
    return content == null ? "" : JSON.stringify(content);
}

function rel(path: string, cwd: string): string {
    return path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
}

/** Diffs for Claude Code's file edits, from the structured result it reports. */
export function resultDisplay(p: PendingTool, r: unknown, cwd: string): ToolDisplay | undefined {
    if (!r || typeof r !== "object") return undefined;
    const x = r as Record<string, unknown>;
    const path = typeof x.filePath === "string" ? x.filePath : undefined;
    const original = typeof x.originalFile === "string" ? x.originalFile : null;
    const summary = (before: string, after: string) => {
        const st = diffStats(diffLines(before, after));
        return `Updated with ${st.added} addition${st.added === 1 ? "" : "s"} and ${st.removed} removal${st.removed === 1 ? "" : "s"}`;
    };
    if (p.name === "Write" && path && typeof x.content === "string") {
        if (original === null) {
            const lines = x.content ? x.content.replace(/\n$/, "").split("\n").length : 0;
            return { summary: `Wrote ${lines} line${lines === 1 ? "" : "s"}`, diff: { path: rel(path, cwd), before: "", after: x.content } };
        }
        return { summary: summary(original, x.content), diff: { path: rel(path, cwd), before: original, after: x.content } };
    }
    if (p.name === "Edit" && path && original !== null && typeof x.oldString === "string" && typeof x.newString === "string" && x.oldString) {
        const newString = x.newString;
        const after = x.replaceAll ? original.split(x.oldString).join(newString) : original.replace(x.oldString, () => newString);
        return { summary: summary(original, after), diff: { path: rel(path, cwd), before: original, after } };
    }
    // Reads and searches: a count, like the harness's own tools, rather than the contents.
    const file = x.file && typeof x.file === "object" ? (x.file as Record<string, unknown>) : undefined;
    if (p.name === "Read" && typeof file?.numLines === "number") {
        const n = file.numLines;
        const total = typeof file.totalLines === "number" && file.totalLines > n ? ` (of ${file.totalLines})` : "";
        return { summary: `Read ${n} line${n === 1 ? "" : "s"}${total}` };
    }
    if ((p.name === "Glob" || p.name === "Grep") && typeof x.numFiles === "number") {
        const n = typeof x.numMatches === "number" ? x.numMatches : typeof x.numLines === "number" && x.mode === "content" ? x.numLines : x.numFiles;
        const what = n === x.numFiles ? "file" : "match";
        return { summary: `Found ${n} ${what}${n === 1 ? "" : what === "match" ? "es" : "s"}` };
    }
    return undefined;
}

/** The config folder this turn's Claude Code reads (its skills are under it). */
export function claudeConfigDir(provider: string, t: BackendTurn): string | undefined {
    try {
        return accountEnv(provider, t.accountId, t.cwd).CLAUDE_CONFIG_DIR;
    } catch {
        return process.env.CLAUDE_CONFIG_DIR;
    }
}

/** Claude Code's `active_goal` value (its /goal, set or with a new verdict; null once it's cleared or met). */
export function claudeGoal(v: unknown): NativeGoal | null {
    if (!v || typeof v !== "object") return null;
    const g = v as { condition?: unknown; iterations?: unknown; set_at?: unknown; last_reason?: unknown };
    if (typeof g.condition !== "string" || !g.condition.trim()) return null;
    const at = typeof g.set_at === "number" && g.set_at > 0 ? (g.set_at < 1e12 ? g.set_at * 1000 : g.set_at) : Date.now();
    return {
        provider: "claude-code",
        condition: g.condition,
        status: "active",
        since: at,
        ...(typeof g.iterations === "number" ? { turns: g.iterations } : {}),
        ...(typeof g.last_reason === "string" && g.last_reason.trim() ? { lastReason: redact(g.last_reason) } : {}),
    };
}
