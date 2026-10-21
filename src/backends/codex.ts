// Codex as an agent backend: the user's own installed `codex`, signed in by
// the user with `codex login` (a ChatGPT plan, or an API key they set up there).
//
// Each turn starts `codex app-server`, the JSON-RPC interface OpenAI ships for
// driving Codex from editors and other programs, starts or resumes a thread
// and runs one turn. Codex runs it with its own tools and sandbox; the harness
// maps its permission mode to Codex's approval policy and sandbox, shows the
// items as they stream, and answers Codex's approval requests through the
// harness's own permission rules and prompt (in auto mode, Codex's own
// reviewer answers them instead). The harness never reads Codex's
// credentials (~/.codex/auth.json) and never signs in on its behalf.

import { existsSync, readFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import type { AssistantMessage, ModelInfo, Usage } from "../providers/types";
import { ProviderError } from "../providers/types";
import type { ProviderDef } from "../providers/registry";
import type { PlanLimits } from "../server/protocol";
import { codexReachedType, limitAccountLabel, mergeLimits, parseCodexRateLimits, resetSentence } from "./limits";
import type { PermissionMode } from "../permissions/modes";
import { analyzeCommand } from "../permissions/bash-safety";
import { APP_NAME, APP_TITLE, APP_VERSION } from "../config/paths";
import { redact } from "../util/redact";
import { gitRoot } from "../util/git";
import { canonical, expandPath, isInside } from "../util/files";
import { CODEX_CLI, JsonLinesProcess, cliMessage, cliStatusString, commandTitle, extraArgs, requireCli, stopTiming } from "./cli";
import { codexMcpOverrides } from "./codex-mcp";
import { codexInput, codexSkills, pastedPrompt, skillFolder, type CodexSkill } from "./native-skills";
import { accountEnv, defaultAccount } from "../providers/accounts";
import { accountPermissionConfig, accountPermissionProfile, watchAccountFolders } from "./account-permissions";
import { backendModel, type AgentBackendClient, type BackendHost, type BackendQuestion, type BackendResult, type BackendTurn, type OrchestratorServer, type PermissionAnswer } from "./types";
import type { AgentEvent, TurnEndReason } from "../agent/agent";
import { parseGoalCommand, type GoalCommand, type NativeGoal } from "../agent/goal";

/** A JSON-RPC peer over a JsonLinesProcess: our requests, its notifications and requests. */
class Rpc {
    private seq = 0;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private closed?: Error;
    readonly done: Promise<void>;

    constructor(
        readonly proc: JsonLinesProcess,
        private onNotification: (method: string, params: any) => void,
        private onRequest: (method: string, params: any) => Promise<unknown>,
    ) {
        this.done = this.pump();
    }

    private async pump() {
        try {
            for await (const m of this.proc.messages()) {
                if (typeof m.method === "string" && m.id !== undefined) {
                    const id = m.id;
                    this.onRequest(m.method, m.params ?? {}).then(
                        (result) => this.proc.send({ id, result }),
                        (e) => this.proc.send({ id, error: { code: -32603, message: redact((e as Error).message ?? String(e)) } }),
                    );
                } else if (typeof m.method === "string") this.onNotification(m.method, m.params ?? {});
                else if (m.id !== undefined) {
                    const p = this.pending.get(m.id);
                    if (!p) continue;
                    this.pending.delete(m.id);
                    if (m.error) p.reject(new ProviderError(`Codex: ${cliMessage(String(m.error.message ?? "request failed"))}`));
                    else p.resolve(m.result);
                }
            }
        } finally {
            const code = await Promise.race([this.proc.exited, Bun.sleep(500).then(() => undefined)]);
            const why = cliMessage(this.proc.stderr());
            this.closed = new ProviderError(`Codex stopped${why ? `: ${why}` : code !== undefined ? ` (exit ${code})` : ""}`);
            for (const p of this.pending.values()) p.reject(this.closed);
            this.pending.clear();
        }
    }

    request<T = any>(method: string, params: unknown): Promise<T> {
        if (this.closed) return Promise.reject(this.closed);
        const id = ++this.seq;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.proc.send({ id, method, params });
        });
    }

    notify(method: string, params?: unknown) {
        this.proc.send(params === undefined ? { method } : { method, params });
    }
}

/**
 * In a folder the user hasn't trusted, Codex must not load the project's own
 * config (.codex/), even if Codex itself was told to trust the project. Codex
 * looks trust up by the git root (and, to be safe, any folder above), so all
 * of them are marked untrusted for this run.
 */
export function untrustedArgs(cwd: string): string[] {
    const dirs = new Set<string>();
    for (let d = resolve(cwd); ; d = dirname(d)) {
        dirs.add(d);
        if (dirname(d) === d) break;
    }
    const root = gitRoot(cwd);
    if (root) dirs.add(resolve(root));
    return ["-c", `projects={${[...dirs].map((d) => `${JSON.stringify(d)}={trust_level="untrusted"}`).join(",")}}`];
}

/** Start app-server (no handshake yet). */
function spawnRpc(providerId: string, cwd: string, onNotification: (method: string, params: any) => void, onRequest: (method: string, params: any) => Promise<unknown>, opts: { trusted?: boolean; accountId?: string } = {}): Rpc {
    const bin = requireCli(providerId, CODEX_CLI);
    const args = ["app-server", ...extraArgs(providerId), ...(opts.trusted === false ? untrustedArgs(cwd) : [])];
    return new Rpc(new JsonLinesProcess(bin, args, { cwd, env: accountEnv(providerId, opts.accountId, cwd) }), onNotification, onRequest);
}

async function handshake(rpc: Rpc, accountPermissions = false) {
    await rpc.request("initialize", { clientInfo: { name: CODEX_CLIENT_NAME, title: APP_TITLE, version: APP_VERSION }, capabilities: accountPermissions ? { experimentalApi: true } : null });
    rpc.notify("initialized");
}

/** Start app-server and do the handshake; the signal (or the timeout) stops it at any point. */
async function connect(providerId: string, cwd: string, signal?: AbortSignal, accountId?: string): Promise<Rpc> {
    const rpc = spawnRpc(providerId, cwd, () => {}, async () => {
        throw new Error("not supported");
    }, { accountId });
    const kill = () => void rpc.proc.kill();
    signal?.addEventListener("abort", kill, { once: true });
    try {
        await withTimeout(handshake(rpc), 30_000, "Codex didn't start (no answer to initialize)");
    } catch (e) {
        void rpc.proc.kill();
        throw e;
    } finally {
        signal?.removeEventListener("abort", kill);
    }
    return rpc;
}

export interface CodexAccount {
    /** chatgpt (a ChatGPT plan), apiKey, amazonBedrock; undefined when signed out. */
    type?: string;
    email?: string;
    planType?: string;
    /** Codex needs a sign-in for its configured model provider. */
    requiresAuth: boolean;
}

function parseAccount(r: any): CodexAccount {
    const a = r?.account;
    return { type: cliStatusString(a?.type), email: cliStatusString(a?.email), planType: cliStatusString(a?.planType), requiresAuth: r?.requiresOpenaiAuth === true };
}

export function describeCodexAuth(a: CodexAccount): string {
    if (a.type === "chatgpt") return `signed in with ChatGPT${a.planType ? ` (${a.planType} plan)` : ""}`;
    if (a.type === "apiKey") return "signed in with an API key (usage is billed to that key, not a plan)";
    if (a.type) return `signed in (${a.type})`;
    return a.requiresAuth ? "not signed in" : "using a model provider that needs no sign-in";
}

/** How Codex is signed in (account/read), from Codex itself. */
export async function codexAccount(providerId = "codex", signal?: AbortSignal, accountId?: string): Promise<CodexAccount> {
    const rpc = await connect(providerId, homedir(), signal, accountId);
    const kill = () => void rpc.proc.kill();
    signal?.addEventListener("abort", kill, { once: true });
    try {
        return parseAccount(await withTimeout(rpc.request("account/read", {}), 20_000, "Codex didn't answer account/read"));
    } finally {
        signal?.removeEventListener("abort", kill);
        void rpc.proc.kill();
    }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new ProviderError(message)), ms)))]).finally(() => clearTimeout(timer));
}

interface Policy {
    approvalPolicy: "untrusted" | "on-request" | "never";
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
    sandboxPolicy: Record<string, unknown>;
    /** Who answers its approval requests: the harness (its rules, then the user), or Codex's own reviewer. It stays with the thread, so every mode says. */
    approvalsReviewer: "user" | "auto_review";
}

/** The harness's permission mode as Codex's approval policy and sandbox. */
export function codexPolicy(mode: PermissionMode, additionalDirectories: string[], readOnly = false): Policy {
    // A read-only agent in auto: reads run in the read-only sandbox without asking; anything more asks the harness, which refuses it.
    if (mode === "auto" && readOnly) return { approvalPolicy: "on-request", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false }, approvalsReviewer: "user" };
    const workspaceWrite = { type: "workspaceWrite", writableRoots: additionalDirectories, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    switch (mode) {
        case "acceptEdits":
            // Edits inside the workspace; commands other than known read-only ones still ask (the harness approves the edits).
            return { approvalPolicy: "untrusted", sandbox: "workspace-write", sandboxPolicy: workspaceWrite, approvalsReviewer: "user" };
        case "auto":
            // Edits and commands inside the workspace run in Codex's sandbox; going beyond it, Codex's own reviewer decides.
            return { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: workspaceWrite, approvalsReviewer: "auto_review" };
        case "bypassPermissions":
            return { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" };
        default:
            // Manual and plan: commands other than known read-only ones, and every edit, ask.
            return { approvalPolicy: "untrusted", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false }, approvalsReviewer: "user" };
    }
}

/** Modes with the same Codex policy (plan adds instructions on top). */
function codexPolicyKey(m: PermissionMode, readOnly: boolean): string {
    const p = codexPolicy(m, [], readOnly);
    return `${p.approvalPolicy}|${p.sandbox}|${p.approvalsReviewer}`;
}

/** Our name to Codex: it records it as the originator of the threads we start. */
export const CODEX_CLIENT_NAME = `${APP_NAME}_cli`;

const PLAN_NOTE =
    "<system-reminder>\nPlan mode is active: the user wants a plan before anything changes. Research with read-only commands, don't modify files, and reply with your plan. Changes will be refused until the user approves it.\n</system-reminder>";

// Codex tells its model the sandbox "only permits reading files", and it can take that as
// the end of it. An approved change or command runs outside the sandbox (seen with 0.162).
const MANUAL_NOTE =
    "<system-reminder>\nThe sandbox is read-only, but you can still change files and run other commands: each one goes to the user for approval first and runs once they approve. Make the changes the task needs; don't stop because the sandbox is read-only.\n</system-reminder>";

// Said once for the thread, whatever the mode: the mode (and with it the sandbox) can change while the thread lives.
const LISTENER_NOTE =
    "In every permission mode but bypass, the sandbox has no network access, and that blocks local listeners too, including loopback servers that tests start. If a command needs one, ask to run that command outside the sandbox through the approval flow.";

/** What a turn starts with for the mode: plan mode's rules, or (manual mode, an agent that may change things) that changes are asked about. */
function modeNote(mode: PermissionMode, readOnly: boolean): string | undefined {
    if (mode === "plan") return PLAN_NOTE;
    if (mode === "default" && !readOnly) return MANUAL_NOTE;
    return undefined;
}

/** Codex's fast service tiers: "priority" in its catalog (0.163), "fast" in older ones. */
const FAST_TIERS = new Set(["fast", "priority"]);

/** Prefer the current catalog; the legacy field is only used by older CLIs. */
export function codexFastTier(m: { serviceTiers?: { id: string }[]; additionalSpeedTiers?: string[] }): string | undefined {
    const tiers = Array.isArray(m.serviceTiers) ? m.serviceTiers.map((t) => t.id) : m.additionalSpeedTiers ?? [];
    return tiers.find((t) => FAST_TIERS.has(t));
}

type LimitOrdering = { revision: number; reads: number; acceptedRead: number };

export class CodexBackend implements AgentBackendClient {
    readonly agentBackend = true as const;
    /** Order snapshots across sessions of each account, including reads answered in reverse order. */
    private limitUpdates = new Map<string, LimitOrdering>();

    private limitOrdering(accountId = "default"): LimitOrdering {
        let state = this.limitUpdates.get(accountId);
        if (!state) this.limitUpdates.set(accountId, state = { revision: 0, reads: 0, acceptedRead: 0 });
        return state;
    }

    constructor(readonly def: ProviderDef) {}

    async stream(): Promise<AssistantMessage> {
        throw new ProviderError(`${this.def.name} runs whole turns with its own tools, so it can't answer one-off requests. Set smallModel to another provider's model for those.`);
    }

    /** Codex's model catalog (model/list), the default model first. */
    async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
        const rpc = await connect(this.def.id, homedir(), signal, defaultAccount(this.def.id));
        const kill = () => void rpc.proc.kill();
        signal?.addEventListener("abort", kill, { once: true });
        try {
            const all: any[] = [];
            let cursor: string | null = null;
            for (let page = 0; page < 20; page++) {
                const r: any = await withTimeout(rpc.request("model/list", cursor ? { cursor } : {}), 30_000, "Codex didn't answer model/list");
                all.push(...(Array.isArray(r?.data) ? r.data : []));
                cursor = typeof r?.nextCursor === "string" ? r.nextCursor : null;
                if (!cursor) break;
            }
            const shown = all.filter((m) => typeof m?.model === "string" && !m.hidden);
            shown.sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)));
            return shown.map((m) =>
                backendModel(this.def.id, m.model, typeof m.displayName === "string" ? m.displayName : undefined, {
                    effortLevels: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map((e: any) => e?.reasoningEffort).filter((e: unknown) => typeof e === "string") : undefined,
                    supportsFastMode: codexFastTier(m) !== undefined,
                    fastModeTier: codexFastTier(m),
                    supportsImages: Array.isArray(m.inputModalities) ? m.inputModalities.includes("image") : true,
                }),
            );
        } finally {
            signal?.removeEventListener("abort", kill);
            void rpc.proc.kill();
        }
    }

    /** Turns running now: the main agent's, and sub-agents' on Codex. */
    private turns = new Set<CodexTurn>();
    /** Codex's own sub-agents' labels, by thread: one resumed in a later turn is shown by the name it had. */
    private labels = new Map<string, string>();

    async runTurn(t: BackendTurn): Promise<BackendResult> {
        const turn = new CodexTurn(this.def, t, this.labels, this.limitOrdering(t.accountId));
        this.turns.add(turn);
        try {
            return await turn.run();
        } finally {
            this.turns.delete(turn);
        }
    }

    /** Codex's own compaction of the thread. */
    async compact(t: Omit<BackendTurn, "prompt" | "images"> & { instructions?: string }): Promise<BackendResult> {
        if (!t.resumeId) return { reason: "done", text: "", actions: [] };
        return new CodexTurn(this.def, { ...t, prompt: "", images: [] }, this.labels, this.limitOrdering(t.accountId)).run({ compact: true });
    }

    /**
     * Codex takes its approval policy and sandbox per turn: a stricter mode
     * restarts a running turn under it. Each turn goes by its own agent's
     * mode (a read-only sub-agent's stays read-only).
     */
    setMode(_m: PermissionMode) {
        for (const turn of this.turns) turn.modeChanged(turn.agentMode());
    }
}

/** Said to Codex in the turn that goes on under a mode the user switched to. */
function modeSwitched(m: PermissionMode): string {
    return `<system-reminder>\nThe user switched the permission mode to ${m === "plan" ? "plan mode" : `"${m}"`} while you were working, so your turn was stopped and resumes under it. Continue from where you were, within the new mode.\n</system-reminder>`;
}

/** How much a mode lets Codex do on its own; switching to a higher one mid-turn can't wait for the next turn. */
const STRICTNESS: Record<PermissionMode, number> = { bypassPermissions: 0, auto: 1, acceptEdits: 2, default: 3, plan: 4 };

interface OpenItem {
    name: string;
    input: Record<string, unknown>;
    title: string;
    started: number;
    changes?: FileChange[];
    /** The sub-agent of Codex's whose item it is (none: the main thread's). */
    sub?: SubAgent;
    /** An MCP tool call's server and tool. */
    mcp?: { server: string; tool: string };
    /** Codex is asking about it (an MCP call's approval): another of its questions isn't about this one. */
    asking?: boolean;
}

interface FileChange {
    path: string;
    kind: string;
    diff: string;
    /** A rename's destination. */
    movePath?: string;
}

/**
 * What a thread said last: the answer of its latest turn that said anything
 * (the messages Codex marks as the answer), or, when its model doesn't mark
 * them, that turn's last message. The working narration around it isn't part of it.
 */
interface Answer {
    turn?: string;
    parts: string[];
    last: string;
}

function noteMessage(a: Answer, turn: string | undefined, phase: unknown, text: string) {
    if (a.turn !== turn) {
        a.turn = turn;
        a.parts = [];
    }
    a.last = text;
    if (phase === "final_answer" || phase === "partial_answer") a.parts.push(text);
}

const answerOf = (a: Answer): string => (a.parts.length ? a.parts.join("\n\n") : a.last);

/** A sub-agent Codex started itself (spawn_agent): its thread's events show under the call that started it. */
interface SubAgent {
    /** The spawn call it shows under. */
    call: string;
    label: string;
    /** A sub-agent's own sub-agent: its tool calls show under the same call, but it isn't the one that reports. */
    nested: boolean;
    /** Its turn now. */
    turnId?: string;
    answer: Answer;
}

/** Notifications from a thread not known yet to be a sub-agent's: what it would show. */
const SHOWN_FROM_SUBAGENTS = new Set(["turn/started", "turn/completed", "item/started", "item/completed", "item/commandExecution/outputDelta", "item/fileChange/patchUpdated", "error", "warning", "configWarning"]);

export class CodexTurn {
    private rpc!: Rpc;
    private threadId?: string;
    private turnId?: string;
    private items = new Map<string, OpenItem>();
    private streamed = new Set<string>();
    private texts: string[] = [];
    /** The main thread's answer: what a sub-agent on Codex reports. */
    private answer: Answer = { parts: [], last: "" };
    private actions: string[] = [];
    /** Codex's own sub-agents, by thread. */
    private subs = new Map<string, SubAgent>();
    /** Events of threads not (yet) known as sub-agents (one just spawned, or Codex's reviewer's): kept in case a spawn names them. */
    private unclaimed = new Map<string, [string, any][]>();
    /** Turns (of any thread) that started while connected: their usage is new spend. */
    private turnsSeen = new Set<string>();
    /** Each thread's token totals as Codex last reported them. */
    private totals = new Map<string, Tokens>();
    private threadModels = new Map<string, string>();
    /** A reroute applies to the reported turn, not the next request for the thread. */
    private turnModels = new Map<string, string>();
    private aborted = false;
    private failure?: string;
    private status?: string;
    private billedToPlan = false;
    private limitNoted = false;
    /** The turn failed on the plan's usage limit (usageLimitExceeded). */
    private limitHit = false;
    /** The plan's limits as this turn has heard them. */
    private limits?: PlanLimits;
    /** Reviewer noes shown from item/autoApprovalReview/completed, by thread and reason, whose guardianWarning hasn't come yet. */
    private noesShown = new Map<string, number>();
    /** Codex's reviewer's approvals of items not started yet, by item id. */
    private pendingApprovals = new Map<string, string>();
    /** What the user said when declining something, when it can't go into the running turn: it starts the next one. */
    private followUp?: string;
    private followUps = 0;
    /** Messages the user steered with, one after another (each waits for the one before). */
    private steering: Promise<void> = Promise.resolve();
    /** Steered messages the turn ended before taking: they start the next. */
    private unsteered: string[] = [];
    /** One came while no turn was running (it was starting): steered once it is. */
    private steerWaiting = false;
    /** Why an approval was refused, by item, for the item's result. */
    private refusals = new Map<string, string>();
    private turnDone?: () => void;
    /** The mode the running turn's policy came from. */
    private turnMode?: PermissionMode;
    /** The mode of the thread's policy (its start or resume, or the last turn/start): the turns Codex starts itself for the goal run under it. */
    private threadMode?: PermissionMode;
    /** The goal was going on when a mode change restarted the turn (Codex may pause it for the interrupt). */
    private goalOnRestart = false;
    /** The user switched to a stricter mode mid-turn: the turn was interrupted to go on under it. */
    private restartFor?: PermissionMode;
    /** The thread's goal (thread/goal/*) as Codex last reported it; undefined until it has. */
    private goal?: NativeGoal | null;
    /** Turns Codex said it started that weren't the one waited on then: the goal's own, or one of ours said before its answer. */
    private startedTurns: string[] = [];
    /** Turns started here (turn/start): never one Codex started on its own, even if it said so before answering. */
    private ownTurns = new Set<string>();
    /** Turns that have ended, with how (an adopted one may have ended before it was waited on). */
    private completedTurns = new Map<string, { status: string; error?: unknown }>();
    /** Wakes the wait for the goal's next turn (one started, the goal changed, Codex gone). */
    private goalWake?: () => void;
    /** The turn being waited on was started by Codex itself (adopted), under the thread's policy. */
    private adopted = false;
    /** A turn/start is on its way: a turn that starts meanwhile may be that one (told apart by its answer). */
    private starting = false;
    /** The thread's mode when the turn/start on its way was sent: what a turn Codex started meanwhile runs under. */
    private startingThreadMode?: PermissionMode;
    /** The main thread's turns running now (turn/started to turn/completed), with the mode of the policy each runs under (undefined: not known yet). */
    private running = new Map<string, PermissionMode | undefined>();
    /** Turns Codex started itself that were stopped for the mode: restarted under it when adopted. */
    private stoppedForMode = new Set<string>();
    /** The mode of the policy the turn/start on its way asks for. */
    private startingMode?: PermissionMode;
    /** Kill timers for turns stopped for the mode: Codex that doesn't stop one is stopped itself, as on a user's stop. */
    private modeKills = new Set<ReturnType<typeof setTimeout>>();
    /** Why Codex was stopped, when it didn't stop a turn for the mode. */
    private modeKilled?: string;
    /** The goal was paused in Codex for a mode change, so Codex starts no turns of its own under the old policy: made active again under the new one. */
    private goalPausedForMode = false;

    constructor(
        private def: ProviderDef,
        private t: BackendTurn,
        /** Sub-agents' labels by thread, kept across turns (the client's). */
        private labels = new Map<string, string>(),
        private limitUpdates: LimitOrdering = { revision: 0, reads: 0, acceptedRead: 0 },
    ) {}

    /**
     * Whether the turn running under `turnMode` (the mode its policy was made from) can't go on under mode `m`.
     * A turn started here restarts for a stricter policy or plan mode (a looser one waits for the next turn); one
     * Codex started itself (adopted) runs under the thread's last policy, so any other restarts it, as nothing
     * else would apply it.
     */
    private stale(m: PermissionMode): boolean {
        if (this.turnMode === undefined || !this.differs(m, this.turnMode)) return false;
        return this.adopted || STRICTNESS[m] > STRICTNESS[this.turnMode] || m === "plan";
    }

    /** Of two modes, the one that lets Codex do more by itself (a turn not known to run under either is taken to run under that one). */
    private leastStrict(a: PermissionMode | undefined, b: PermissionMode | undefined): PermissionMode | undefined {
        if (a === undefined || b === undefined) return a ?? b;
        return STRICTNESS[a] <= STRICTNESS[b] ? a : b;
    }

    /** Whether modes `a` and `b` make different policies (or one of them is plan mode). */
    private differs(a: PermissionMode, b: PermissionMode): boolean {
        const ro = Boolean(this.t.readOnly);
        return codexPolicyKey(a, ro) !== codexPolicyKey(b, ro) || (a === "plan") !== (b === "plan");
    }

    /**
     * The check before anything goes into the running turn (it's started, adopted, steered, its goal made
     * active): stale for the mode as it is now, it's restarted under it instead (true). Already restarting: true.
     */
    private restartIfStale(): boolean {
        if (this.restartFor) return true;
        if (!this.turnId || this.aborted || this.completedTurns.has(this.turnId)) return false;
        const m = this.host.mode();
        if (!this.stale(m)) return false;
        this.restartFor = m;
        this.goalOnRestart = this.goal?.status === "active";
        this.interruptForMode(this.turnId);
        return true;
    }

    /**
     * The mode changed. Codex's own goal turns run under the thread's last policy, so with the goal active and
     * that policy no longer the mode's, the goal is paused in Codex first (it starts no more turns of its own),
     * Codex's turns running under the old policy are stopped, and the goal goes on in a turn started under the
     * mode, made active once that has started. The turn waited on restarts if it's stale.
     */
    modeChanged(_m: PermissionMode) {
        if (this.aborted) return;
        const m = this.host.mode();
        if (this.goal?.status === "active" && !this.goalPausedForMode && this.threadId && this.threadMode !== undefined && this.differs(m, this.threadMode)) {
            this.goalPausedForMode = true;
            void this.rpc.request("thread/goal/set", { threadId: this.threadId, status: "paused" }).then((r) => this.setGoal(r?.goal), () => {});
        }
        this.restartIfStale();
        this.stopStale();
    }

    /**
     * Stop Codex's own turns running under a policy other than the mode's. One that started while a turn/start was
     * on its way is taken for Codex's (under the thread's policy then) until the answer says; if it was that one,
     * it's restarted under the mode (settleStarted).
     */
    private stopStale() {
        if (this.aborted) return;
        const m = this.host.mode();
        for (const [id, known] of this.running) {
            const mode = known ?? (this.starting ? this.leastStrict(this.startingThreadMode, this.startingMode) : undefined);
            if (this.ownTurns.has(id) || mode === undefined || this.stoppedForMode.has(id) || this.completedTurns.has(id) || !this.differs(m, mode)) continue;
            this.stoppedForMode.add(id);
            this.interruptForMode(id);
        }
    }

    /** The turn/start's answer: of the turns that started meanwhile, `own` was it (under `mode`); the rest were Codex's, under the thread's policy then. */
    private settleStarted(own: string | undefined, mode?: PermissionMode) {
        this.starting = false;
        for (const [id, m] of this.running) if (m === undefined) this.running.set(id, id === own ? mode : this.startingThreadMode);
        // Stopped while it was taken for one of Codex's: it was this one, so it's restarted under the mode.
        if (own && this.stoppedForMode.delete(own)) {
            this.restartFor ??= this.host.mode();
            this.goalOnRestart ||= this.goal?.status === "active";
        }
        this.stopStale();
    }

    /**
     * Stop a turn for the mode. It answers with turn/completed; one that's still running after the grace a user's
     * stop gets means Codex didn't stop it (the request failed, or it ignored it), so Codex is stopped instead:
     * nothing goes on under the old policy.
     */
    private interruptForMode(turnId: string) {
        void this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId }).catch(() => {});
        const timer = setTimeout(() => {
            this.modeKills.delete(timer);
            if (this.aborted || this.completedTurns.has(turnId)) return;
            this.modeKilled = "Codex didn't stop a turn running under the permission mode from before, so Codex was stopped. Send your message again to go on under the new mode.";
            this.failure = this.modeKilled;
            void this.rpc.proc.kill();
        }, stopTiming.interruptMs);
        this.modeKills.add(timer);
    }

    /** Codex's turns stopped for the mode, still running: waited for (briefly) before a turn is started beside them. */
    private async stoppedEnded() {
        const deadline = Date.now() + 5000;
        while (!this.aborted && [...this.stoppedForMode].some((id) => this.running.has(id)) && Date.now() < deadline) await Bun.sleep(10);
    }

    private get host(): BackendHost {
        return this.t.host;
    }

    /** The mode of the agent running this turn, as it is now. */
    agentMode(): PermissionMode {
        return this.host.mode();
    }

    async run(opts: { compact?: boolean } = {}): Promise<BackendResult> {
        const t = this.t;
        if (t.signal.aborted) return { reason: "aborted", text: "", actions: [] };
        const accountPermissions = accountPermissionConfig(t.additionalDirectories);
        this.rpc = spawnRpc(this.def.id, t.cwd, (m, p) => this.onNotification(m, p), (m, p) => this.onRequest(m, p), { trusted: t.trusted, accountId: t.accountId });
        const stopAccountWatch = watchAccountFolders(() => {
            this.failure = "Account folders changed while Codex was running. Send again to apply their updated protections.";
            void this.rpc.proc.kill();
        });
        let abortTimer: ReturnType<typeof setTimeout> | undefined;
        /** Stopped by the user with the goal active: its pause, which goes in before Codex is stopped. */
        let pausing: Promise<void> | undefined;
        const onAbort = () => {
            this.aborted = true;
            // Stopped by the user: Codex mustn't go on with the goal by itself (as T3 Code stops it).
            if (this.threadId && this.goal?.status === "active")
                pausing = withTimeout(this.rpc.request("thread/goal/set", { threadId: this.threadId, status: "paused" }), 2000, "").then(
                    (r) => r?.goal && this.setGoal(r.goal),
                    () => {},
                );
            this.goalWake?.();
            if (this.threadId && this.turnId) {
                this.interrupt();
                // It answers an interrupt with turn/completed; if it doesn't, stop it.
                abortTimer = setTimeout(() => void this.rpc.proc.kill(), stopTiming.interruptMs);
            } else void (pausing ?? Promise.resolve()).then(() => this.rpc.proc.kill()); // still starting, or between the goal's turns: nothing to interrupt
        };
        t.signal.addEventListener("abort", onAbort, { once: true });
        // A message to steer with goes into the running turn as it's sent (turn/steer), not at its end.
        const stopSteering = opts.compact ? undefined : this.host.onQueued?.(() => this.steerQueued());
        try {
            await withTimeout(handshake(this.rpc, Boolean(accountPermissions)), 30_000, "Codex didn't start (no answer to initialize)");
            const account = parseAccount(await this.rpc.request("account/read", {}));
            if (!account.type && account.requiresAuth) {
                return { reason: "error", text: "", actions: [], error: `Codex isn't signed in. In a terminal, run \`${CODEX_CLI.signIn}\`, then try again.` };
            }
            this.billedToPlan = account.type === "chatgpt";
            // Where the plan stands before the first update comes (they come only as it changes).
            if (this.billedToPlan) void this.readLimits();
            // The thread's policy, from one reading of the mode: what Codex's own goal turns run under (threadMode).
            const startMode = this.host.mode();
            const policy = codexPolicy(startMode, t.additionalDirectories, Boolean(t.readOnly));
            const model = t.model.id === "default" ? undefined : t.model.id;
            let o = t.orchestrator;
            const overrides = await this.mcpOverrides(t.cwd, Boolean(t.readOnly), o?.name);
            if (typeof overrides === "string") return { reason: "error", text: "", actions: [], error: overrides };
            const off = overrides.config;
            if (overrides.reservedCollision) {
                this.host.emit({ type: "notice", level: "warn", message: "Codex already has a server named harness; it is disabled and this turn runs without Harness delegation to avoid merging server configurations." });
                o = undefined;
            }
            const baseInstructions = [t.appendSystemPrompt, LISTENER_NOTE].filter(Boolean).join("\n\n") || undefined;
            const developerInstructions = [baseInstructions, o?.instructions].filter(Boolean).join("\n\n") || undefined;
            let config: Record<string, unknown> | undefined = o && !t.readOnly ? { mcp_servers: { ...off?.mcp_servers, ...(orchestratorConfig(o).mcp_servers as Record<string, unknown>) } } : off;
            if (accountPermissions) config = { ...config, ...accountPermissions };
            // Fast is the catalog's tier for it. Standard sends nothing (a Codex from before "default" was a
            // tier name refuses it), except null to take a thread on a fast tier (an earlier fast turn, or
            // Codex's own config) back off it: 0.163 puts it on "default". Other tiers set in Codex (flex) are left alone.
            const tierFor = (fast: boolean | undefined) => (fast && t.model.supportsFastMode ? t.model.fastModeTier : undefined);
            const fastTier = tierFor(t.fastMode);
            /** The thread's tier as last reported or set. */
            let tierNow: string | null | undefined;
            this.threadMode = startMode;
            const threadParams = { cwd: t.cwd, model, ...(fastTier ? { serviceTier: fastTier } : {}), approvalPolicy: policy.approvalPolicy, ...(accountPermissions ? { permissions: accountPermissionProfile(startMode, t.readOnly) } : { sandbox: policy.sandbox }), approvalsReviewer: policy.approvalsReviewer, developerInstructions, ...(config ? { config } : {}) };
            // A Codex that won't take the delegation server's config still gets its thread, without it.
            const thread = async (method: string, params: Record<string, unknown>) => {
                try {
                    return await this.rpc.request(method, params);
                } catch (e) {
                    // Never fall back by dropping account denies: fail closed instead.
                    if (this.aborted || !o || accountPermissions) throw e;
                    const r = await this.rpc.request(method, { ...params, config: off, developerInstructions: baseInstructions });
                    this.host.emit({ type: "notice", level: "warn", message: `Codex didn't accept ${APP_TITLE}'s delegation tools (${redact((e as Error).message).replace(/^Codex:\s*/, "")}); this turn runs without them, preserving MCP restrictions.` });
                    return r;
                }
            };
            // The harness's skills go to Codex as a skills root of its own, so it lists them to its model and runs them itself.
            const skills = opts.compact ? [] : await this.nativeSkills(t);
            if (t.resumeId) {
                try {
                    // Shared with a forked session: a copy of it goes on (a new thread), never the thread itself.
                    const r = await thread(t.forkSession ? "thread/fork" : "thread/resume", { ...threadParams, threadId: t.resumeId, excludeTurns: true });
                    this.threadId = r?.thread?.id ?? (t.forkSession ? undefined : t.resumeId);
                    if (!this.threadId || (t.forkSession && this.threadId === t.resumeId)) throw new ProviderError("Codex didn't fork the thread");
                    if (typeof r?.model === "string") this.threadModels.set(this.threadId!, r.model);
                    tierNow = r?.serviceTier;
                } catch (e) {
                    // Stopped by esc: the thread is fine and is resumed next time.
                    if (this.aborted) throw e;
                    return { reason: "error", text: "", actions: [], error: `Couldn't ${t.forkSession ? "fork" : "resume"} the Codex thread: ${(e as Error).message}`, resumeFailed: true };
                }
            } else {
                const r = await thread("thread/start", threadParams);
                this.threadId = r?.thread?.id;
                if (this.threadId && typeof r?.model === "string") this.threadModels.set(this.threadId, r.model);
                tierNow = r?.serviceTier;
                if (!this.threadId) throw new ProviderError("Codex didn't start a thread");
            }
            this.host.sessionId(this.threadId!);
            // /goal goes to Codex's own thread goal. A set or a resume runs a turn here (a resume's has no input, as
            // T3 Code's), under the mode, model and speed as they are now; the goal is made active once it has started.
            const goalCommand = opts.compact ? undefined : codexGoalCommand(t.prompt);
            const goalTurn = goalCommand ? await this.goalCommand(goalCommand) : undefined;
            if (!goalCommand) void this.readGoal();
            if (goalCommand && !goalTurn) {
                // Answered: no turn.
            } else if (opts.compact) {
                await this.waitFor(() => this.rpc.request("thread/compact/start", { threadId: this.threadId }));
            } else {
                let text = goalTurn ? [t.goalContext, goalTurn.text].filter(Boolean).join("\n\n") : t.prompt;
                /** What the user typed, which `text` ends with (then `after`): its /name and $name are skills to run (not a goal's condition). */
                let request = goalTurn ? undefined : t.request;
                let after = goalTurn ? "" : (t.requestAfter ?? "");
                // A new goal's images go with its first turn (/goal resume takes none).
                let images = t.images;
                /** Make the goal active once its first turn has started (so Codex doesn't start one of its own first). */
                let activate = Boolean(goalTurn);
                /** A turn Codex started itself for the goal: waited on instead of starting one. */
                let adopt: string | undefined;
                /** The user's messages for the turn adopted: they go into it (turn/steer). */
                let pending: string | undefined;
                /** The user's queued messages that `text` carries (not the prompt itself, which the session keeps). */
                let queued: string | undefined;
                while (true) {
                    // Paused in Codex for a mode change: active again once this turn (under the mode) has started.
                    if (this.goalPausedForMode && !adopt) activate = true;
                    // The policy for the mode as it is now: it may have changed since the last turn.
                    const mode = this.host.mode();
                    const policy = codexPolicy(mode, t.additionalDirectories, Boolean(t.readOnly));
                    const note = modeNote(mode, Boolean(t.readOnly));
                    const asked = skills ? codexInput(text, request, skills, t.skills, after) : { text: pastedPrompt(text, request, t.skills ?? [], after), items: [] };
                    const input = [...this.input(note ? `${note}\n\n${asked.text}` : asked.text, images), ...asked.items];
                    const effort = t.effort && (!t.model.effortLevels || t.model.effortLevels.includes(t.effort)) ? t.effort : undefined;
                    this.turnMode = mode;
                    // The speed as it is now too: a sub-agent's session may have changed it since (its turn restarting, a queued message).
                    const tier = tierFor(this.host.fastMode?.() ?? t.fastMode);
                    const serviceTier = tier ?? (typeof tierNow === "string" && FAST_TIERS.has(tierNow) ? null : undefined);
                    // Queued and restarted turns explicitly request this model again, even after a reroute.
                    if (model) this.threadModels.set(this.threadId!, model);
                    await this.waitFor(async () => {
                        if (adopt) {
                            // Codex's own turn runs under the thread's policy: a mode changed since restarts it (waitFor checks).
                            this.turnMode = this.running.get(adopt) ?? this.threadMode;
                            this.adopted = true;
                            await this.adoptTurn(adopt, pending);
                            adopt = pending = undefined;
                            return;
                        }
                        let r: any;
                        for (let attempt = 0; ; attempt++) {
                            // Not beside a turn of Codex's that was stopped for the mode and hasn't ended yet.
                            await this.stoppedEnded();
                            this.starting = true;
                            this.startingThreadMode = this.threadMode;
                            this.startingMode = mode;
                            try {
                                r = await this.rpc.request("turn/start", { threadId: this.threadId, input, cwd: t.cwd, model, effort, serviceTier, approvalPolicy: policy.approvalPolicy, ...(accountPermissions ? { permissions: accountPermissionProfile(mode, t.readOnly) } : { sandboxPolicy: policy.sandboxPolicy }), approvalsReviewer: policy.approvalsReviewer, summary: "auto" }).finally(() => (this.starting = false));
                                break;
                            } catch (e) {
                                // Any turn that started meanwhile was Codex's own.
                                this.settleStarted(undefined);
                                // Refused for a turn of Codex's that's being stopped for the mode: again once it has ended.
                                if (attempt === 0 && !this.aborted && [...this.stoppedForMode].some((id) => this.running.has(id))) continue;
                                // Codex started the goal's next turn first (and so refused this one): the user's messages go into that one.
                                const id = this.goal?.status === "active" && !activate ? await this.nextGoalTurn(GOAL_TURN_GRACE_MS, false) : undefined;
                                if (!id) {
                                    // The messages this turn was for aren't lost with it: saved for the next turn.
                                    if (queued) this.unsteered.push(queued);
                                    throw e;
                                }
                                // Under the thread's policy, as any turn Codex starts itself, not this one's mode.
                                this.turnMode = this.running.get(id) ?? this.threadMode;
                                this.adopted = true;
                                return this.adoptTurn(id, text);
                            }
                        }
                        this.turnId = r?.turn?.id;
                        this.threadMode = mode;
                        // Which turn that started meanwhile was this one: the others were Codex's own.
                        this.settleStarted(this.turnId, mode);
                        // Codex's turns stopped for the mode before this one: this one goes on in their place, not after them.
                        this.startedTurns = this.startedTurns.filter((id) => !this.stoppedForMode.has(id));
                        if (this.turnId) {
                            this.turnsSeen.add(this.turnId);
                            this.ownTurns.add(this.turnId);
                        }
                        // The mode changed while it was starting: restarted under it, before anything goes into it.
                        if (this.restartIfStale()) return;
                        // Sent while the turn was starting: it can take them now.
                        if (this.turnId && this.steerWaiting) this.steerQueued();
                        if (activate && this.turnId && !this.aborted) {
                            activate = false;
                            const g = (await this.rpc.request("thread/goal/set", { threadId: this.threadId, status: "active" }))?.goal;
                            this.goalPausedForMode = false;
                            this.setGoal(g);
                        }
                    });
                    if (serviceTier !== undefined) tierNow = serviceTier ?? "default";
                    this.turnId = undefined;
                    if (this.aborted || this.status === "failed") break;
                    images = [];
                    const restart = this.restartFor;
                    this.restartFor = undefined;
                    request = undefined;
                    after = "";
                    if (restart) {
                        // Stopped for the mode, not by the user: the goal goes on once the restarted turn has started.
                        if (this.goalOnRestart) activate = true;
                        this.goalOnRestart = false;
                        text = modeSwitched(restart);
                        // A steer the interrupt beat goes in with it, not after the restarted turn.
                        await this.steering;
                        queued = this.unsteered.length ? this.unsteered.splice(0).join("\n\n") : undefined;
                        if (queued) text = [text, queued].join("\n\n");
                        continue;
                    }
                    // A steer on its way when the turn ended: whether Codex took it decides what's next.
                    await this.steering;
                    const followUp = this.followUp && this.followUps++ < 5 ? this.followUp : undefined;
                    this.followUp = undefined;
                    const next = followUp ? [followUp] : this.unsteered.length ? this.unsteered.splice(0) : await this.host.drainQueued(() => this.progress());
                    if (!next.length) {
                        // The goal still active: Codex goes on with it in a turn of its own, which this run waits for.
                        if (this.goal?.status === "active") adopt = await this.nextGoalTurn();
                        if (adopt) continue;
                        // Paused for a mode change (before or while waiting): it goes on here, under the mode.
                        if (this.goalPausedForMode && !this.aborted) {
                            text = modeSwitched(this.host.mode());
                            queued = undefined;
                            continue;
                        }
                        break;
                    }
                    // The user's words name skills; a watch's events (others' words, such as a PR comment) come after and don't.
                    const typed = next.filter((x) => !this.host.fromWake?.(x));
                    const woke = next.filter((x) => this.host.fromWake?.(x));
                    request = typed.length ? typed.join("\n\n") : undefined;
                    after = woke.length ? `${typed.length ? "\n\n" : ""}${woke.join("\n\n")}` : "";
                    text = queued = [...typed, ...woke].join("\n\n");
                    // The goal active: Codex starts its next turn as this one ends, and the messages go into that one
                    // (a turn started here as well would run beside it).
                    const own = this.goal?.status === "active" ? await this.nextGoalTurn(GOAL_TURN_GRACE_MS, false) : undefined;
                    if (own) {
                        adopt = own;
                        pending = text;
                    }
                }
            }
            // Codex's error may not say when the limit resets; its limits do.
            if (this.limitHit && !this.limits?.resetsAt && !this.aborted) await this.readLimits();
        } catch (e) {
            if (!this.aborted) this.failure = this.modeKilled ?? redact((e as Error).message);
        } finally {
            // Ended with the goal still active (an error, Codex gone): it waits for the user, not for Codex.
            await pausing;
            // Paused for a mode change that no turn took up: shown as it is.
            if (this.goalPausedForMode) {
                this.goalPausedForMode = false;
                this.host.emit({ type: "goal", goal: this.goal ?? null });
            }
            if (this.threadId && this.goal?.status === "active") await withTimeout(this.rpc.request("thread/goal/set", { threadId: this.threadId, status: "paused" }), 2000, "").catch(() => {});
            stopAccountWatch();
            stopSteering?.();
            t.signal.removeEventListener("abort", onAbort);
            if (abortTimer) clearTimeout(abortTimer);
            for (const timer of this.modeKills) clearTimeout(timer);
            this.modeKills.clear();
            await this.rpc.proc.stop(1000);
            // Settled once Codex is gone (its pending requests fail): nothing records a prompt after the turn's end.
            await this.steering;
            // Recorded as sent but never taken (the turn failed or was stopped): saved for the next turn.
            if (this.unsteered.length) this.host.undelivered?.(this.unsteered.splice(0));
        }
        for (const [id, it] of this.items) this.endItem(id, it, this.aborted ? "Interrupted by user" : it.sub ? "Stopped with the sub-agent." : "Codex stopped before this finished.", true);
        // Sub-agents still working stopped with Codex.
        for (const sub of new Set(this.subs.values())) if (sub.turnId) this.endSubTurn(sub, "aborted");
        const text = this.texts.join("\n\n");
        const answer = answerOf(this.answer) || undefined;
        if (this.aborted) return { reason: "aborted", text, answer, actions: this.actions };
        if (this.failure) return { reason: "error", text, answer, actions: this.actions, error: this.limitHit ? `${limitAccountLabel(this.def.id, this.t.accountId)}: usage limit reached. ${resetSentence(this.limits?.resetsAt, "Codex")} Choose another account with /account or the plan meter, then send again.` : this.failure, ...(this.limitHit ? { limit: { resetsAt: this.limits?.resetsAt } } : {}) };
        return { reason: "done", text, answer, actions: this.actions };
    }

    private setGoal(raw: unknown) {
        this.goal = codexGoal(raw);
        // Paused for a mode change only until the goal's next turn has started: still going, as the user sees it.
        const shown = this.goalPausedForMode && this.goal?.status === "paused" ? { ...this.goal, status: "active" as const } : this.goal;
        this.host.emit({ type: "goal", goal: shown });
        this.goalWake?.();
    }

    /** What the thread's goal is now, for the UI (a Codex without goals answers with an error: nothing to show). */
    private async readGoal() {
        try {
            const r = await withTimeout(this.rpc.request("thread/goal/get", { threadId: this.threadId }), 5000, "");
            if (this.goal === undefined) this.setGoal(r?.goal ?? null);
        } catch {
            // An older Codex: no goals.
        }
    }

    /** /goal on Codex: answered here (a notice), or the text of the goal's first turn. */
    private async goalCommand(c: GoalCommand): Promise<{ text: string } | undefined> {
        const say = (message: string, level: "info" | "warn" | "error" = "info") => void this.host.emit({ type: "notice", level, message });
        if (c.kind === "invalid") return void say(c.message, "error");
        const threadId = this.threadId;
        let raw: unknown;
        try {
            raw = (await this.rpc.request("thread/goal/get", { threadId }))?.goal;
        } catch (e) {
            return void say(`This Codex doesn't keep goals (${redact((e as Error).message).replace(/^Codex:\s*/, "")}). Update Codex to use /goal with it.`, "error");
        }
        this.setGoal(raw);
        const current = this.goal ?? null;
        if (c.kind === "status") return void say(current ? describeCodexGoal(current) : "No goal set.");
        if (c.kind === "clear") {
            const r = await this.rpc.request("thread/goal/clear", { threadId });
            this.setGoal(null);
            return void say(r?.cleared === false || !current ? "No goal set" : `Goal cleared: ${current.condition}`);
        }
        if (!current && c.kind !== "set") return void say("No goal set. /goal <condition> sets one.");
        if (c.kind === "pause") {
            this.setGoal((await this.rpc.request("thread/goal/set", { threadId, status: "paused" }))?.goal);
            return void say("Goal paused. /goal resume continues it.");
        }
        if (c.kind === "resume") return { text: "" };
        if (current) await this.rpc.request("thread/goal/clear", { threadId });
        // Paused until its first turn has started, so Codex doesn't start one of its own first.
        this.setGoal((await this.rpc.request("thread/goal/set", { threadId, objective: c.condition, status: "paused" }))?.goal);
        return { text: c.condition };
    }

    /** Wait on a turn Codex started itself (it may have ended already: as it ended then), with the user's messages put into it. */
    private async adoptTurn(id: string, text?: string) {
        this.turnId = id;
        const ended = this.completedTurns.get(id);
        const stopped = this.stoppedForMode.delete(id);
        if (ended !== undefined && stopped) {
            // Stopped as it started, for the mode: restarted under it, with the messages.
            this.status = ended.status;
            this.restartFor = this.host.mode();
            this.goalOnRestart = this.goal?.status === "active";
            if (text) this.unsteered.push(text);
            this.turnDone?.();
            return;
        }
        if (ended !== undefined) {
            this.status = ended.status;
            if (ended.status === "failed") this.fail(ended.error, "Codex reported a failed turn");
            if (text) this.unsteered.push(text);
            this.turnDone?.();
            return;
        }
        // Started under the thread's policy: stale for the mode now, the messages go into its restart instead.
        if (this.restartIfStale()) {
            if (text) this.unsteered.push(text);
            return;
        }
        if (text) await this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: id, input: this.input(text, []) }).catch(() => this.unsteered.push(text));
        // Sent while no turn was running (waiting for this one): it can take them now.
        if (this.steerWaiting) this.steerQueued();
    }

    /** The turn Codex starts by itself while the goal is active; undefined once the goal isn't (or Codex is gone, or it was stopped). */
    private async nextGoalTurn(waitMs = GOAL_TURN_WAIT_MS, warn = true): Promise<string | undefined> {
        const deadline = Date.now() + waitMs;
        while (!this.aborted && this.goal?.status === "active") {
            // The newest Codex started that wasn't started here, still going (or failed: that's said).
            const id = this.startedTurns.filter((t) => !this.ownTurns.has(t) && (!this.completedTurns.has(t) || this.completedTurns.get(t)!.status === "failed" || this.stoppedForMode.has(t))).at(-1);
            this.startedTurns = [];
            if (id) return id;
            const left = deadline - Date.now();
            if (left <= 0) {
                if (!warn) return undefined;
                this.host.emit({ type: "notice", level: "warn", message: "Codex didn't go on with the goal by itself, so it's paused. /goal resume continues it." });
                return undefined;
            }
            const gone = await Promise.race([new Promise<boolean>((r) => (this.goalWake = () => r(false))), this.rpc.done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), left))]);
            this.goalWake = undefined;
            if (gone) return undefined;
        }
        return undefined;
    }

    private async readLimits() {
        const revision = this.limitUpdates.revision;
        const read = ++this.limitUpdates.reads;
        const at = Date.now();
        try {
            const report = await withTimeout(this.rpc.request("account/rateLimits/read", { excludeResetCreditDetails: true }), 10_000, "Codex did not report plan limits");
            if (revision !== this.limitUpdates.revision || read < this.limitUpdates.acceptedRead) return;
            const parsed = parseCodexRateLimits(report, { at, accountId: this.t.accountId ?? "default" });
            if (parsed) {
                this.limitUpdates.acceptedRead = read;
                this.noteLimits(parsed.limits, parsed.partial);
            }
        } catch {
            // Older CLIs may only push updates, or have no limits to report.
        }
    }

    private noteLimits(limits: PlanLimits, partial: boolean) {
        this.limits = mergeLimits(this.limits, limits, partial);
        this.host.emit({ type: "limits", limits, partial });
    }

    private fail(error: any, fallback: string) {
        this.failure = redact(String(error?.message ?? fallback));
        if (error?.codexErrorInfo !== "usageLimitExceeded" || this.limitHit) return;
        this.limitHit = true;
        this.limitUpdates.revision++;
        if (!this.limits?.reached) this.noteLimits({ provider: this.def.id, accountId: this.t.accountId ?? "default", windows: [], reached: true, at: Date.now() }, true);
    }

    /**
     * The harness's skills registered (skills/extraRoots/set), then all the
     * skills Codex has; Codex's own are listed for the menus. Undefined when
     * this Codex can't take them (they're pasted in instead).
     */
    private async nativeSkills(t: BackendTurn): Promise<CodexSkill[] | undefined> {
        // A project's own skills only where the user trusted it (the session's list may come from implicit trust): those are pasted in.
        const folder = skillFolder((t.skills ?? []).filter((s) => t.trusted || s.source !== "project"));
        try {
            // Every turn, an empty list too: the harness's skills are the session's as they are now.
            await withTimeout(this.rpc.request("skills/extraRoots/set", { extraRoots: folder ? [join(folder, "skills")] : [] }), 10_000, "Codex didn't answer skills/extraRoots/set");
            const r: any = await withTimeout(this.rpc.request("skills/list", { cwds: [t.cwd] }), 10_000, "Codex didn't answer skills/list");
            const listed: CodexSkill[] = (Array.isArray(r?.data) ? r.data : []).flatMap((e: any) => (Array.isArray(e?.skills) ? e.skills : [])).filter((x: any) => typeof x?.name === "string" && typeof x?.path === "string");
            const { skills, own } = codexSkills(listed, t.skills ?? [], folder);
            this.host.emit({ type: "cli_commands", provider: this.def.id, names: own.map((n) => n.toLowerCase()) });
            return skills;
        } catch (e) {
            if (this.aborted) throw e;
            return t.skills?.length ? undefined : [];
        }
    }

    private input(text: string, images: BackendTurn["images"]): unknown[] {
        const out: unknown[] = [];
        if (text) out.push({ type: "text", text, text_elements: [] });
        for (const i of images) out.push({ type: "image", url: `data:${i.mediaType};base64,${i.data}` });
        return out;
    }

    /** Stop the running turn: the main thread's, or one sub-agent's. */
    private interrupt(sub?: { thread: string; turnId?: string }) {
        const [threadId, turnId] = sub ? [sub.thread, sub.turnId] : [this.threadId, this.turnId];
        if (threadId && turnId) void this.rpc.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    }

    /** Start something that ends with turn/completed (or thread/compacted), and wait for that. */
    private async waitFor(start: () => Promise<void>) {
        const done = new Promise<void>((resolve) => (this.turnDone = resolve));
        this.status = undefined;
        await start();
        // Interrupted while the turn was being started.
        if (this.aborted && this.turnId) this.interrupt();
        // The mode changed while it was being started (modeChanged had no turn to stop yet).
        else this.restartIfStale();
        await Promise.race([done, this.rpc.done]);
        this.turnDone = undefined;
        this.adopted = false;
        if (!this.status && !this.aborted && !this.failure) this.failure = `Codex stopped before the turn finished${cliMessage(this.rpc.proc.stderr()) ? `: ${cliMessage(this.rpc.proc.stderr())}` : ""}`;
    }

    private onNotification(method: string, p: any) {
        const thread = typeof p?.threadId === "string" ? p.threadId : undefined;
        if (method === "thread/started" && typeof p?.thread?.id === "string" && typeof p.thread.model === "string") this.threadModels.set(p.thread.id, p.thread.model);
        const modelThread = thread ?? this.threadId;
        if (method === "model/rerouted" && typeof p?.toModel === "string" && modelThread) {
            const turn = typeof p.turnId === "string" ? p.turnId : this.turnId;
            if (turn) this.turnModels.set(`${modelThread}/${turn}`, p.toModel);
        }
        if (method === "turn/started" && typeof p.turn?.id === "string") {
            this.turnsSeen.add(p.turn.id);
            const model = modelThread && this.threadModels.get(modelThread);
            const key = `${modelThread}/${p.turn.id}`;
            if (model && !this.turnModels.has(key)) this.turnModels.set(key, model);
        }
        if (method === "thread/tokenUsage/updated") return this.onUsage(p, thread);
        // Codex streams its sub-agents' threads (and its reviewer's) on the same connection. Its
        // reviewer's verdicts are about any thread's action; everything else is that thread's own.
        if (thread && this.threadId && thread !== this.threadId && !ANY_THREAD.has(method)) return this.onSubThread(method, p, thread);
        switch (method) {
            case "turn/started":
                this.host.emit({ type: "request_start" });
                // One Codex started itself, for the goal (it may start as the last ends, before that end is taken in).
                if (typeof p.turn?.id === "string" && p.turn.id !== this.turnId) {
                    this.startedTurns.push(p.turn.id);
                    if (this.startedTurns.length > 16) this.startedTurns.shift();
                    // Codex's own runs under the thread's policy; while a turn/start is on its way, it may be that one
                    // (known by its answer). One under a policy other than the mode's is stopped at once, before it
                    // does anything (not when it's adopted), and the goal goes on under the mode.
                    this.running.set(p.turn.id, this.starting ? undefined : this.threadMode);
                    this.stopStale();
                    this.goalWake?.();
                }
                break;
            case "thread/goal/updated":
                this.setGoal(p.goal);
                break;
            case "thread/goal/cleared":
                this.setGoal(null);
                break;
            case "item/agentMessage/delta":
                if (p.delta) {
                    this.streamed.add(p.itemId);
                    this.host.emit({ type: "text", text: p.delta });
                }
                break;
            case "item/reasoning/summaryTextDelta":
            case "item/reasoning/textDelta":
                if (p.delta) this.host.emit({ type: "thinking", text: p.delta });
                break;
            case "item/reasoning/summaryPartAdded":
                this.host.emit({ type: "thinking", text: "\n\n" });
                break;
            case "item/commandExecution/outputDelta":
                if (p.delta) this.host.emit({ type: "tool_progress", id: p.itemId, text: p.delta });
                break;
            case "item/fileChange/patchUpdated":
                this.patchUpdated(p);
                break;
            case "item/started":
                this.onItemStarted(p.item ?? {});
                break;
            case "item/completed":
                this.onItemCompleted(p.item ?? {}, p.turnId);
                break;
            case "turn/completed":
                if (typeof p.turn?.id === "string") this.running.delete(p.turn.id);
                if (typeof p.turn?.id === "string") this.completedTurns.set(p.turn.id, { status: typeof p.turn.status === "string" ? p.turn.status : "completed", ...(p.turn.status === "failed" ? { error: p.turn.error } : {}) });
                if (p.turn?.id && this.turnId && p.turn.id !== this.turnId) break;
                this.status = p.turn?.status;
                if (p.turn?.status === "failed") this.fail(p.turn?.error, "Codex reported a failed turn");
                this.turnDone?.();
                break;
            case "thread/compacted":
                this.host.emit({ type: "notice", level: "info", message: "Codex compacted its context." });
                this.status ??= "completed";
                this.turnDone?.();
                break;
            case "error":
                if (p.willRetry) this.host.emit({ type: "retry", attempt: 1, delayMs: 0, reason: redact(String(p.error?.message ?? "Codex is retrying")) });
                else this.fail(p.error, "Codex reported an error");
                break;
            case "warning":
            case "configWarning":
            case "deprecationNotice": {
                const msg = String(p.message ?? p.summary ?? "").trim();
                if (msg) this.host.emit({ type: "notice", level: "info", message: `Codex: ${msg}` });
                break;
            }
            case "item/autoApprovalReview/completed": {
                if (p.review?.status === "approved") {
                    // Without an item id there is no command block to attach the verdict to.
                    if (typeof p.targetItemId !== "string" || !p.targetItemId) break;
                    // Redacted before it's trimmed: a secret can end in a space.
                    const reason = `Codex's reviewer (risk: ${redact(String(p.review.riskLevel ?? "unknown"))}): ${redact(String(p.review.rationale ?? "No reason supplied.")).trim()}`;
                    const open = this.items.get(p.targetItemId);
                    if (open) this.emitApproval(p.targetItemId, reason, open.sub);
                    else {
                        // Its item has ended (the block takes it now), or hasn't started (it waits for the block).
                        this.emitApproval(p.targetItemId, reason, this.subs.get(p.threadId));
                        this.pendingApprovals.set(p.targetItemId, reason);
                    }
                    break;
                }
                // Codex's reviewer said no: the model hears it from Codex; the user hears it here.
                const status = p.review?.status;
                if (status !== "denied" && status !== "timedOut") break;
                const what = reviewedAction(p.action);
                const why = typeof p.review?.rationale === "string" ? p.review.rationale.trim() : "";
                const verdict = status === "denied" ? "Codex's reviewer blocked" : "Codex's reviewer ran out of time on";
                this.host.emit({ type: "notice", level: "warn", message: redact(`${verdict} ${what}${why ? `: ${why}` : "."}`) });
                if (why) {
                    const key = verdictKey(p.threadId, why);
                    this.noesShown.set(key, (this.noesShown.get(key) ?? 0) + 1);
                }
                break;
            }
            case "guardianWarning": {
                const msg = String(p.message ?? "").trim();
                if (!msg || APPROVED_VERDICT.test(msg)) break;
                // A rejection already shown with its action does not need a second notice.
                const reason = msg.match(REVIEW_VERDICT)?.[1]?.trim();
                const key = reason ? verdictKey(p.threadId, reason) : undefined;
                const shown = key ? (this.noesShown.get(key) ?? 0) : 0;
                if (key && shown > 0) {
                    if (shown === 1) this.noesShown.delete(key);
                    else this.noesShown.set(key, shown - 1);
                    break;
                }
                this.host.emit({ type: "notice", level: "warn", message: redact(`Codex's reviewer: ${msg}`) });
                break;
            }
            case "model/rerouted":
                this.host.emit({ type: "notice", level: "info", message: `Codex switched models: ${String(p.reason ?? p.toModel ?? "").trim() || "rerouted"}` });
                break;
            case "account/rateLimits/updated": {
                this.limitUpdates.revision++;
                const parsed = parseCodexRateLimits(p, { update: true, accountId: this.t.accountId ?? "default" });
                if (parsed) this.noteLimits(parsed.limits, parsed.partial);
                const reached = codexReachedType(p.rateLimits);
                if (reached && !this.limitNoted) {
                    this.limitNoted = true;
                    this.host.emit({ type: "notice", level: "warn", message: `${limitAccountLabel(this.def.id, this.t.accountId)}: usage limit reached (${reached}). ${resetSentence(this.limits?.resetsAt, "Codex")}` });
                }
                break;
            }
        }
    }

    private emitApproval(id: string, reason: string, sub?: SubAgent) {
        const e: AgentEvent = { type: "tool_approved", id, reason, sandboxed: false };
        if (sub) this.subEmit(sub, e);
        else this.host.emit(e);
    }

    /**
     * A thread's token usage. Codex reports a thread's running total and
     * its last response's, and reports them again without new spend (on
     * thread/resume, with the earlier turn's id; when a compaction starts;
     * seen with 0.163): a report counts only when the total moved, or, the
     * thread's first here, when it's for a turn that started on this
     * connection. A sub-agent's spend counts too, but not toward the main
     * thread's context.
     */
    private onUsage(p: any, thread: string | undefined) {
        const u = p.tokenUsage ?? {};
        const key = thread ?? this.threadId ?? "";
        const total = tokens(u.total);
        const last = tokens(u.last);
        const before = this.totals.get(key);
        if (total) this.totals.set(key, total);
        let spent: Tokens | undefined;
        if (before && total) {
            if (TOKEN_FIELDS.every((k) => total[k] === before[k])) return;
            spent = minus(total, before) ?? last;
        } else {
            if (typeof p.turnId === "string" && !this.turnsSeen.has(p.turnId)) return;
            spent = last;
        }
        if (!spent) return;
        const model = this.turnModels.get(`${key}/${p.turnId}`) ?? this.threadModels.get(key);
        const usage: Usage = {
            inputTokens: Math.max(0, spent.inputTokens - spent.cachedInputTokens),
            outputTokens: spent.outputTokens,
            cacheReadTokens: spent.cachedInputTokens,
            cacheWriteTokens: spent.cacheWriteInputTokens,
            reasoningTokens: spent.reasoningOutputTokens,
            // A ChatGPT plan isn't billed per token; with an API key the price isn't known here.
            cost: this.billedToPlan ? 0 : undefined,
            billing: this.billedToPlan ? "plan" : "api",
            resolvedModel: model ? `${this.def.id}:${model}` : undefined,
        };
        const main = !thread || !this.threadId || thread === this.threadId;
        if (main) {
            const context = last ? last.inputTokens + last.outputTokens : undefined;
            this.host.usage(usage, { contextTokens: context, contextWindow: typeof u.modelContextWindow === "number" ? u.modelContextWindow : undefined });
            return;
        }
        this.host.usage(usage, {});
        // Counted above: what the sub-agent's chip shows (kept until it's known whose thread this is).
        const shown: AgentEvent = { type: "usage", usage, cost: { usd: 0, estimated: true, unknown: !this.billedToPlan }, contextTokens: 0 };
        const sub = this.subs.get(thread!);
        if (sub) this.subEmit(sub, shown);
        else this.keep(thread!, SHOWN_USAGE, shown);
    }

    /** What one of Codex's sub-agents' threads (or a thread not known yet) says. */
    private onSubThread(method: string, p: any, thread: string) {
        const sub = this.subs.get(thread);
        if (!sub) {
            // Not known as a sub-agent (yet): kept a while, in case a spawn names it; a reviewer's never shows.
            if (SHOWN_FROM_SUBAGENTS.has(method)) this.keep(thread, method, p);
            return;
        }
        switch (method) {
            case SHOWN_USAGE:
                this.subEmit(sub, p);
                break;
            case "turn/started":
                sub.turnId = typeof p.turn?.id === "string" ? p.turn.id : sub.turnId;
                if (!sub.nested) this.subEmit(sub, { type: "request_start" });
                break;
            case "item/started":
                this.onItemStarted(p.item ?? {}, sub);
                break;
            case "item/completed":
                this.onItemCompleted(p.item ?? {}, p.turnId, sub);
                break;
            case "item/commandExecution/outputDelta":
                if (p.delta) this.subEmit(sub, { type: "tool_progress", id: String(p.itemId ?? ""), text: p.delta });
                break;
            case "item/fileChange/patchUpdated":
                this.patchUpdated(p);
                break;
            case "turn/completed": {
                if (p.turn?.id && sub.turnId && p.turn.id !== sub.turnId) break;
                const status = p.turn?.status;
                this.endSubTurn(sub, status === "completed" ? "done" : status === "interrupted" ? "aborted" : "error", typeof p.turn?.id === "string" ? p.turn.id : undefined);
                break;
            }
            case "error":
                if (!p.willRetry) this.subEmit(sub, { type: "notice", level: "error", message: redact(String(p.error?.message ?? "Codex reported an error")) });
                break;
            case "warning":
            case "configWarning": {
                const msg = String(p.message ?? p.summary ?? "").trim();
                if (msg) this.subEmit(sub, { type: "notice", level: "info", message: `Codex: ${msg}` });
                break;
            }
        }
    }

    /** An event of a thread not known as a sub-agent's yet, for when it is. */
    private keep(thread: string, method: string, p: unknown) {
        const q = this.unclaimed.get(thread) ?? [];
        if (!this.unclaimed.has(thread) && this.unclaimed.size >= 50) return;
        if (q.length < 500) q.push([method, p]);
        this.unclaimed.set(thread, q);
    }

    /** A file change's patch as Codex streams it: what its approval is checked against. */
    private patchUpdated(p: any) {
        const open = this.items.get(String(p.itemId ?? ""));
        if (open && Array.isArray(p.changes)) open.changes = fileChanges(p);
    }

    private subEmit(sub: SubAgent, e: AgentEvent) {
        this.host.emit({ type: "subagent", parentId: sub.call, label: sub.label, event: e });
    }

    /** A sub-agent's turn is over: what it answered is its report, and its chip says how it ended. */
    private endSubTurn(sub: SubAgent, reason: TurnEndReason, turnId = sub.turnId) {
        for (const [id, it] of this.items) if (it.sub === sub) this.endItem(id, it, reason === "done" ? "Codex didn't say how this ended." : "Stopped with the sub-agent.", true);
        const said = turnId !== undefined && sub.answer.turn === turnId ? answerOf(sub.answer) : "";
        sub.turnId = undefined;
        if (sub.nested) return;
        if (said.trim()) this.subEmit(sub, { type: "text", text: said });
        this.subEmit(sub, { type: "turn_end", reason });
    }

    /** The threads a spawn started are sub-agents, shown under the call (a sub-agent's own, under its): what they did so far shows now. */
    private claimThreads(threads: unknown, call: string, label: string, from?: SubAgent) {
        for (const thread of Array.isArray(threads) ? threads : []) {
            if (typeof thread !== "string" || thread === this.threadId || this.subs.has(thread)) continue;
            if (!from) {
                this.labels.delete(thread);
                this.labels.set(thread, label);
                if (this.labels.size > 200) this.labels.delete(this.labels.keys().next().value!);
            }
            this.subs.set(thread, from ? { call: from.call, label: from.label, nested: true, answer: { parts: [], last: "" } } : { call, label, nested: false, answer: { parts: [], last: "" } });
            const early = this.unclaimed.get(thread) ?? [];
            this.unclaimed.delete(thread);
            for (const [method, p] of early) this.onSubThread(method, p, thread);
        }
    }

    /** Threads named that aren't known here as sub-agents (nor the main thread). */
    private unknownThreads(threads: unknown): string[] {
        return (Array.isArray(threads) ? threads : []).filter((t): t is string => typeof t === "string" && t !== this.threadId && !this.subs.has(t));
    }

    private onItemStarted(item: any, sub?: SubAgent) {
        const id = String(item.id ?? "");
        let open: OpenItem | undefined;
        switch (item.type) {
            case "commandExecution": {
                const { command } = shownCommand(item, this.t.cwd);
                open = { name: "Bash", input: { command }, title: commandTitle(command), started: Date.now() };
                break;
            }
            case "fileChange": {
                const changes = fileChanges(item);
                const first = changes[0];
                const name = changes.length && changes.every((c) => c.kind === "add") ? "Write" : "Edit";
                const what = first ? (first.movePath ? `${first.path} → ${first.movePath}` : first.path) : "";
                open = { name, input: { file_path: first?.path ?? "" }, title: `${name}(${what}${changes.length > 1 ? ` +${changes.length - 1} more` : ""})`, started: Date.now(), changes };
                break;
            }
            case "mcpToolCall": {
                const name = `mcp__${String(item.server ?? "")}__${String(item.tool ?? "")}`;
                const input = item.arguments && typeof item.arguments === "object" ? item.arguments : {};
                open = { name, input, title: `${String(item.server ?? "")} - ${String(item.tool ?? "")} (MCP)`, started: Date.now(), mcp: { server: String(item.server ?? ""), tool: String(item.tool ?? "") } };
                break;
            }
            case "webSearch": {
                // Its query usually comes only when it's done (item/completed).
                const query = webQuery(item);
                open = { name: "WebSearch", input: { query }, title: `WebSearch(${query})`, started: Date.now() };
                break;
            }
            case "collabAgentToolCall": {
                if (item.tool === "spawnAgent") {
                    // A sub-agent of Codex's own: shown as one, with its thread's work under it.
                    const prompt = typeof item.prompt === "string" ? item.prompt : "";
                    const label = subAgentLabel(prompt);
                    open = { name: "Task", input: { description: label, prompt }, title: `Task(${label})`, started: Date.now() };
                } else if (RUNS_SUBAGENT.has(String(item.tool)) && this.unknownThreads(item.receiverThreadIds).length) {
                    // One from an earlier turn, set going again (resumed, or messaged): shown as a sub-agent, as a spawn is.
                    const prompt = typeof item.prompt === "string" ? item.prompt : "";
                    const label = this.labels.get(this.unknownThreads(item.receiverThreadIds)[0]!) ?? subAgentLabel(prompt);
                    open = { name: "Task", input: { description: label, prompt }, title: `Task(${label})`, started: Date.now() };
                } else open = { name: String(item.tool ?? item.type), input: {}, title: COLLAB_TITLES[String(item.tool)] ?? String(item.tool ?? item.type), started: Date.now() };
                break;
            }
            case "subAgentActivity":
                return this.subAgentActivity(item, sub);
            case "dynamicToolCall":
            case "imageView":
            case "imageGeneration": {
                const name = String(item.tool ?? item.type);
                open = { name, input: item.arguments && typeof item.arguments === "object" ? item.arguments : {}, title: name, started: Date.now() };
                break;
            }
        }
        if (!open || !id) return;
        open.sub = sub;
        this.items.set(id, open);
        const e: AgentEvent = { type: "tool_start", call: { type: "tool_call", id, name: open.name, input: open.input }, title: open.title };
        if (sub) this.subEmit(sub, e);
        else this.host.emit(e);
        const approval = this.pendingApprovals.get(id);
        if (approval) this.emitApproval(id, approval, sub);
        this.pendingApprovals.delete(id);
    }

    private onItemCompleted(item: any, turn: string | undefined, sub?: SubAgent) {
        const id = String(item.id ?? "");
        if (item.type === "agentMessage") {
            const text = String(item.text ?? "");
            if (!text.trim()) return;
            // A sub-agent's answer is its report, when its turn ends; what it says on the way isn't the main agent's.
            noteMessage(sub ? sub.answer : this.answer, turn, item.phase, text);
            if (sub) return;
            if (!this.streamed.has(id)) this.host.emit({ type: "text", text });
            this.texts.push(text);
            this.host.emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], provider: this.def.id, model: this.t.model.id } });
            return;
        }
        if (item.type === "contextCompaction") {
            if (!sub) this.host.emit({ type: "notice", level: "info", message: "Codex compacted its context." });
            return;
        }
        if (item.type === "subAgentActivity") {
            this.subAgentActivity(item, sub);
            return;
        }
        const open = this.items.get(id);
        if (!open) return;
        const failed = item.status === "failed" || item.status === "declined";
        switch (item.type) {
            case "commandExecution": {
                const out = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
                const code = typeof item.exitCode === "number" ? item.exitCode : undefined;
                const content = item.status === "declined" ? this.takeRefusal(id, "The command was declined.") : `${out}${code !== undefined && code !== 0 ? `${out ? "\n" : ""}Exit code ${code}` : ""}` || "(no output)";
                this.endItem(id, open, content, failed || (code !== undefined && code !== 0));
                break;
            }
            case "fileChange": {
                const changes = open.changes ?? fileChanges(item);
                const content = item.status === "declined" ? this.takeRefusal(id, "The change was declined.") : failed ? "The change was not applied." : `Changed ${changes.length} file${changes.length === 1 ? "" : "s"}: ${changes.map((c) => c.path).join(", ")}`;
                const body = changes.map((c) => `${c.kind} ${c.path}\n${c.diff}`).join("\n").slice(0, 20_000);
                this.endItem(id, open, content, failed, failed ? undefined : { summary: `Changed ${changes.length} file${changes.length === 1 ? "" : "s"}`, body });
                if (!failed && !sub) this.diagnose(changes);
                break;
            }
            case "mcpToolCall": {
                const refused = this.refusals.has(id) && (failed || Boolean(item.error));
                const content = refused ? this.takeRefusal(id, "") : item.error?.message ? String(item.error.message) : mcpText(item.result);
                this.refusals.delete(id);
                this.endItem(id, open, content, Boolean(item.error) || failed);
                break;
            }
            case "webSearch": {
                const query = webQuery(item) || String(open.input.query ?? "");
                const retitled = query !== open.input.query;
                if (retitled) Object.assign(open, { input: { query }, title: `WebSearch(${query})` });
                this.endItem(id, open, failed ? "Failed" : "Done", failed, undefined, retitled);
                break;
            }
            case "collabAgentToolCall": {
                const threads = item.receiverThreadIds;
                if (item.tool === "spawnAgent") {
                    // The call ends first: what its sub-agent did before Codex said whose it was (even all of it) comes after.
                    this.endItem(id, open, failed ? "Codex couldn't start the sub-agent." : "The sub-agent started; what it does shows under it.", failed);
                    if (!failed) this.claimThreads(threads, id, String(open.input.description ?? "sub-agent"), sub);
                    break;
                }
                // What the sub-agents it waited on (or messaged) last said.
                const states = item.agentsStates && typeof item.agentsStates === "object" ? Object.entries<any>(item.agentsStates) : [];
                const said = states.map(([thread, st]) => `${this.subs.get(thread)?.label ?? this.labels.get(thread) ?? "Sub-agent"}: ${String(st?.status ?? "unknown")}${typeof st?.message === "string" && st.message.trim() ? `\n${st.message}` : ""}`).join("\n\n");
                this.endItem(id, open, said || (failed ? "Failed" : "Done"), failed);
                // A sub-agent of an earlier turn set going again: what it does shows under this call.
                const unknown = RUNS_SUBAGENT.has(String(item.tool)) && !failed ? this.unknownThreads(threads) : [];
                for (const thread of unknown) this.claimThreads([thread], id, open.name === "Task" ? String(open.input.description ?? "") : (this.labels.get(thread) ?? "Codex sub-agent"), sub);
                break;
            }
            default:
                this.endItem(id, open, failed ? "Failed" : "Done", failed);
        }
    }

    /**
     * Codex's newer sub-agents (multi_agent_v2) are announced by an item of
     * their own naming the thread, not by a spawn call: one that starts
     * shows as a sub-agent, as a spawn does. Its later activity (messaged,
     * finished) shows in its own thread's events.
     */
    private subAgentActivity(item: any, sub?: SubAgent) {
        const id = String(item.id ?? "");
        const thread = typeof item.agentThreadId === "string" ? item.agentThreadId : "";
        // Started, or one of an earlier turn's messaged again (unknown here).
        if ((item.kind !== "started" && item.kind !== "interacted") || !id || !thread || thread === this.threadId || this.subs.has(thread)) return;
        const name = typeof item.agentPath === "string" ? (item.agentPath.split("/").filter(Boolean).pop() ?? "") : "";
        const label = this.labels.get(thread) ?? subAgentLabel(name.replace(/[_-]+/g, " "));
        const open: OpenItem = { name: "Task", input: { description: label, prompt: "" }, title: `Task(${label})`, started: Date.now(), sub };
        const e: AgentEvent = { type: "tool_start", call: { type: "tool_call", id, name: open.name, input: open.input }, title: open.title };
        if (sub) this.subEmit(sub, e);
        else this.host.emit(e);
        // Over at once, as a spawn call is; then what its sub-agent did shows under it.
        this.endItem(id, open, item.kind === "started" ? "The sub-agent started; what it does shows under it." : "Codex went back to the sub-agent; what it does shows under it.", false);
        this.claimThreads([thread], id, label, sub);
    }

    private takeRefusal(id: string, fallback: string): string {
        const r = this.refusals.get(id) ?? fallback;
        this.refusals.delete(id);
        return r;
    }

    /** An item is over. One whose input was only known at its end (a web search's query) says its title again. */
    private endItem(id: string, open: OpenItem, content: string, isError: boolean, display?: { summary?: string; body?: string }, retitled = false) {
        this.items.delete(id);
        const e: AgentEvent = { type: "tool_end", call: { type: "tool_call", id, name: open.name, input: open.input }, result: { content, isError, display }, durationMs: Date.now() - open.started, ...(retitled ? { title: open.title } : {}) };
        if (open.sub) return this.subEmit(open.sub, e);
        this.actions.push(open.title);
        this.host.emit(e);
    }

    /** Build MCP overrides for every turn from CLI config/provenance, or return an error if unsafe to start. */
    private async mcpOverrides(cwd: string, readOnly: boolean, reservedName?: string) {
        try {
            const r = codexMcpOverrides(await this.rpc.request("config/read", { cwd, includeLayers: true }), readOnly, reservedName);
            if (r.missingProvenance) this.host.emit({ type: "notice", level: "warn", message: "Codex did not identify its config layers; all configured MCP servers are disabled for this turn." });
            return r;
        } catch (e) {
            if (this.aborted) throw e;
            // Errors from the CLI can contain server secrets; never echo them.
            return "Codex didn't list its MCP servers safely, so this turn cannot run: unapproved servers could not be turned off.";
        }
    }

    /** Where a request comes from, when it isn't the main thread: one of Codex's sub-agents (or a thread not known as one). */
    private origin(p: any): Origin | undefined {
        const thread = typeof p?.threadId === "string" ? p.threadId : undefined;
        if (!thread || !this.threadId || thread === this.threadId) return undefined;
        return { thread, turnId: typeof p.turnId === "string" ? p.turnId : this.subs.get(thread)?.turnId, sub: this.subs.get(thread) };
    }

    private async onRequest(method: string, p: any): Promise<unknown> {
        const from = this.origin(p);
        // The prompt says when it's one of Codex's sub-agents asking.
        const agentLabel = from ? (from.sub?.label ?? "Codex sub-agent") : undefined;
        switch (method) {
            case "item/commandExecution/requestApproval": {
                const { command, dir } = shownCommand(p, this.t.cwd);
                const net = p.networkApprovalContext?.host ? ` It needs network access to ${String(p.networkApprovalContext.host)}.` : "";
                // Codex 0.162 asks about every command in untrusted mode, `cat` included. One that wants the
                // network says something. One in another folder is checked as `cd <folder> && …`, where it runs,
                // and only inside the workspace: a search there (`rg --hidden .`) reads what the checker can't see.
                const asksAlways = !net && insideWorkspace(dir, this.t.cwd, this.t.additionalDirectories) && codexPolicy(this.turnMode ?? this.host.mode(), [], Boolean(this.t.readOnly)).approvalPolicy === "untrusted";
                const a = await this.host.permission({ toolName: "Bash", input: { command, description: typeof p.reason === "string" ? p.reason : undefined }, reason: `${typeof p.reason === "string" ? p.reason : ""}${net}`.trim() || undefined, asksAlways, agentLabel, callId: typeof p.itemId === "string" ? p.itemId : undefined });
                return { decision: this.decision(a, p.itemId, from) };
            }
            case "item/fileChange/requestApproval": {
                const open = this.items.get(String(p.itemId ?? ""));
                // A sub-agent's change Codex asks about before saying whose thread it is: the change as it was announced.
                const changes = open?.changes ?? this.unclaimedChanges(p.threadId, p.itemId);
                if (!changes.length && typeof p.grantRoot === "string") {
                    const a = await this.host.permission({ toolName: "Edit", input: { file_path: join(p.grantRoot, "*") }, title: `Write access to ${p.grantRoot}`, reason: p.reason ?? undefined, agentLabel });
                    return { decision: this.decision(a, p.itemId, from) };
                }
                if (!changes.length) {
                    // Nothing to check against the rules (or to show): refused, not approved blind.
                    const a: PermissionAnswer = { allow: false, message: `${APP_TITLE} doesn't know which files this change writes, so it can't check it against your rules.`, stop: false };
                    this.host.emit({ type: "notice", level: "warn", message: `Refused a change Codex asked about: ${a.message}` });
                    return { decision: this.decision(a, p.itemId, from) };
                }
                const first = changes[0];
                const name = changes.length && changes.every((c) => c.kind === "add") ? "Write" : "Edit";
                // Each file it writes, a rename's destination included, is checked against the rules.
                const others = writtenPaths(changes).slice(1);
                const a = await this.host.permission({
                    toolName: name,
                    input: { file_path: first?.path ?? "" },
                    title: open?.title,
                    reason: [typeof p.reason === "string" ? p.reason : "", others.length ? `This change also writes ${others.join(", ")}.` : ""].filter(Boolean).join(" ") || undefined,
                    preview: first ? changePreview(first, this.t.cwd) : undefined,
                    otherPaths: others,
                    agentLabel,
                });
                return { decision: this.decision(a, p.itemId, from) };
            }
            case "item/permissions/requestApproval": {
                const want = requestedPaths(p.permissions, [this.t.cwd, ...this.t.additionalDirectories]);
                if (want.unknown.length) {
                    // Access it can't map to folders can't be checked against the rules: refused, without asking.
                    this.host.emit({ type: "notice", level: "warn", message: `Refused Codex's request for access to ${want.unknown.join(", ")}: ${APP_TITLE} can't tell which folders that covers, so it can't check it against your rules.` });
                    return { permissions: {}, scope: "turn" };
                }
                const asks = [...want.write.map((x) => `write ${x}`), ...want.read.map((x) => `read ${x}`), ...(want.network ? ["network access"] : [])];
                const a = await this.host.permission({
                    toolName: "Codex permissions",
                    input: { permissions: p.permissions ?? {} },
                    title: "Codex asks for more permissions",
                    reason: [typeof p.reason === "string" ? p.reason : "", `It wants: ${asks.join(", ")}.`].filter(Boolean).join(" "),
                    widens: { read: want.read, write: want.write },
                    agentLabel,
                });
                // Granting nothing lets the turn go on without them; what the user said goes in with it.
                if (!a.allow && a.fromUser) this.steer(a.message, true, from);
                if (!a.allow && a.stop) this.interrupt(from);
                return a.allow ? { permissions: p.permissions ?? {}, scope: "turn" } : { permissions: {}, scope: "turn" };
            }
            case "item/tool/requestUserInput": {
                const qs: any[] = Array.isArray(p.questions) ? p.questions : [];
                const answers = await this.host.askQuestions(
                    qs.map((q) => ({ question: String(q?.question ?? ""), header: typeof q?.header === "string" ? q.header : undefined, options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({ label: String(o?.label ?? ""), description: typeof o?.description === "string" ? o.description : undefined })) })),
                );
                return { answers: Object.fromEntries(qs.map((q, i) => [String(q?.id ?? i), { answers: answers?.[i] ?? [] }])) };
            }
            case "mcpServer/elicitation/request":
                return this.elicitation(p, from, agentLabel);
            default:
                throw new Error(`${method} isn't supported by this host`);
        }
    }

    /**
     * An MCP elicitation Codex passes on. Codex asks this way itself before
     * an MCP tool call that needs approval (_meta.codex_approval_kind
     * "mcp_tool_call", seen with 0.163): the harness's rules for that tool,
     * then the user, answer it, as with a command. An MCP server's own form
     * or link goes to the question dialog. With nobody to ask (a
     * non-interactive run), or a form the dialog can't show, it's declined.
     */
    private async elicitation(p: any, from: Origin | undefined, agentLabel: string | undefined): Promise<unknown> {
        const reply = (action: "accept" | "decline", content: unknown = null) => ({ action, content, _meta: null });
        const server = typeof p.serverName === "string" ? p.serverName : "";
        const message = typeof p.message === "string" ? p.message.trim() : "";
        const meta = p._meta && typeof p._meta === "object" && !Array.isArray(p._meta) ? p._meta : {};
        if (typeof meta.codex_approval_kind === "string") {
            const call = meta.codex_approval_kind === "mcp_tool_call" ? this.mcpCall(server, meta.tool_params, message, from) : undefined;
            const a = await this.host.permission(
                call
                    ? { toolName: call.name, input: call.input, title: call.title, reason: message || undefined, agentLabel }
                    : { toolName: "Codex approval", input: { server, kind: meta.codex_approval_kind, message }, title: message || `Codex asks for approval (${String(meta.codex_approval_kind)})`, agentLabel },
            );
            const d = this.decision(a, call?.id, from);
            const asked = call?.id ? this.items.get(call.id) : undefined;
            if (asked) asked.asking = false;
            if (d === "accept") return reply("accept", {});
            // Codex goes on after a no to an MCP call (even "cancel"): the turn is stopped here, as the user asked.
            if (d === "cancel") this.interrupt(from);
            return reply("decline");
        }
        const intro = `${server ? `The ${server} MCP server` : "An MCP server"} asks${message ? `: ${message}` : "."}`;
        if (p.mode === "url") {
            const url = typeof p.url === "string" ? p.url : "";
            const answers = await this.host.askQuestions([{ question: `${intro}\n\nOpen this link to continue: ${url}`, options: [{ label: "Done", description: "I opened the link and finished there" }, { label: "Decline" }] }]);
            return answers?.[0]?.[0] === "Done" ? reply("accept") : reply("decline");
        }
        const form = elicitationForm(p.requestedSchema);
        if (!form) {
            this.host.emit({ type: "notice", level: "warn", message: `Declined a request from ${server || "an MCP server"} for input: ${APP_TITLE} can't show its form.` });
            return reply("decline");
        }
        const questions = form.length ? form.map((f) => ({ question: `${intro}\n\n${f.question}`, options: f.options, multiSelect: f.multi })) : [{ question: intro, options: [{ label: "Accept" }, { label: "Decline" }] }];
        const answers = await this.host.askQuestions(questions);
        if (!answers) return reply("decline");
        if (!form.length) return answers[0]?.[0] === "Accept" ? reply("accept", {}) : reply("decline");
        const content: Record<string, unknown> = {};
        for (const [i, f] of form.entries()) {
            const picked = (answers[i] ?? []).filter((x) => f.skip === undefined || x !== f.skip);
            const value = picked.length ? f.parse(picked) : undefined;
            if (value === undefined && picked.length) {
                // Not an answer the form allows (typed outside its choices, out of range): not sent as one.
                this.host.emit({ type: "notice", level: "warn", message: `Declined ${server ? `the ${server} MCP server's` : "an MCP server's"} form: the answer for "${f.key}" isn't one it allows.` });
                return reply("decline");
            }
            if (value === undefined) {
                if (f.required) return reply("decline");
                continue;
            }
            content[f.key] = value;
        }
        return reply("accept", content);
    }

    /** The changes of a file change announced on a thread not known as a sub-agent's yet. */
    private unclaimedChanges(thread: unknown, itemId: unknown): FileChange[] {
        const early = typeof thread === "string" ? (this.unclaimed.get(thread) ?? []) : [];
        let changes: FileChange[] = [];
        for (const [method, p] of early) {
            if (p?.item?.id === itemId && (method === "item/started" || method === "item/completed")) changes = fileChanges(p.item);
            else if (method === "item/fileChange/patchUpdated" && p?.itemId === itemId) changes = fileChanges(p);
        }
        return changes;
    }

    /**
     * The MCP tool call Codex asks about, whose rules then apply. Codex's
     * question names the tool ('… to run tool "write_thing"?', 0.163) but
     * not the call, so it's the open call of that server and thread whose
     * tool it names (with the same arguments, else the first not asked
     * about yet). One it doesn't name for sure is checked as the whole
     * server (`mcp__server`): no rule for one of its tools approves it.
     */
    private mcpCall(server: string, params: unknown, message: string, from: Origin | undefined): { id?: string; name: string; input: Record<string, unknown>; title?: string } {
        const input = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
        const open = [...this.items].filter(([, it]) => it.mcp?.server === server && !it.asking && it.sub === from?.sub && !(from && !from.sub));
        const named = open.filter(([, it]) => message.includes(`run tool "${it.mcp!.tool}"`));
        const pick = named.find(([, it]) => JSON.stringify(it.input) === JSON.stringify(input)) ?? named[0];
        if (pick) {
            pick[1].asking = true;
            return { id: pick[0], name: pick[1].name, input: pick[1].input, title: pick[1].title };
        }
        const tool = message.match(/run tool "([A-Za-z0-9_.-]+)"\?/)?.[1];
        if (tool) return { name: `mcp__${server}__${tool}`, input, title: `${server} - ${tool} (MCP)` };
        return { name: `mcp__${server}`, input, title: `${server} (MCP)` };
    }

    /**
     * Codex's decision for the harness's answer. Refused by the user with
     * nothing to add: cancel (the turn stops, as with the harness's own
     * tools). Refused by a rule, a read-only agent or a non-interactive run,
     * or with the user saying what to do instead: decline, so the turn goes
     * on (with their words). In untrusted mode a command's availableDecisions
     * leaves decline out, but Codex takes it anyway: the list is for its own
     * UI, and it doesn't check the answer against it. Codex tells the model
     * only "rejected by user", so the harness's reason goes into the turn too:
     * without it the model gives up, or tries the next way of doing the same.
     * A sub-agent's turn gets what's said about its own requests.
     */
    private decision(a: PermissionAnswer, itemId: unknown, from: Origin | undefined): string {
        if (a.allow) return "accept";
        if (typeof itemId === "string" && itemId) this.refusals.set(itemId, a.message);
        if (a.stop) return "cancel";
        if (a.fromUser) this.steer(a.message, true, from);
        else this.steer(`<system-reminder>\n${APP_TITLE} refused that: ${a.message}\n</system-reminder>`, false, from);
        return "decline";
    }

    /** What the turn has said and done so far, taken out: recorded before a message the user sent meanwhile. */
    private progress(): BackendResult {
        return { reason: "done", text: this.texts.splice(0).join("\n\n"), actions: this.actions.splice(0) };
    }

    /**
     * The user's messages to steer with, into the running turn. Taken from the
     * queue only while a turn is running (else its end takes them), and once
     * recorded; one Codex refuses (its turn had just ended, failed or was
     * stopped) starts the next turn.
     */
    private steerQueued() {
        this.steering = this.steering.then(async () => {
            const turnId = this.turnId;
            this.steerWaiting = !turnId;
            if (this.aborted || !this.threadId || !turnId) return;
            const texts = await this.host.drainQueued(() => this.progress());
            if (!texts.length) return;
            const text = texts.join("\n\n");
            // Into a turn that runs as the mode says, or into its restart (also when it changed while draining).
            if (this.turnId !== turnId || this.restartIfStale()) {
                this.unsteered.push(text);
                return;
            }
            try {
                await this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: turnId, input: this.input(text, []) });
            } catch {
                // Each as it was queued, so the user's words and a watch's events stay told apart.
                this.unsteered.push(...texts);
            }
        }).catch(() => {});
    }

    /**
     * The language servers' new problems in files Codex changed (it has no
     * diagnostics of its own): into the turn that made them while it runs;
     * once it has ended, the user is told (a notice) and no turn starts.
     */
    private diagnose(changes: FileChange[]) {
        const paths = changes.filter((c) => c.kind !== "delete").map((c) => resolve(this.t.cwd, c.movePath ?? c.path));
        const turnId = this.turnId;
        if (!paths.length || !turnId || !this.host.diagnose) return;
        void this.host.diagnose(paths).then(
            (note) => {
                if (note && !this.aborted && this.turnId === turnId) this.steer(`<system-reminder>\n${note}\n</system-reminder>`, false);
            },
            () => {},
        );
    }

    /**
     * Add text to the running turn (turn/steer). The user's words start the
     * next turn if that fails; the harness's own notes (followUp false) don't.
     * A sub-agent's turn is steered the same way (checked with 0.163), but
     * nothing starts another of its turns.
     */
    private steer(text: string, followUp = true, from?: Origin) {
        if (from) {
            if (from.turnId) void this.rpc.request("turn/steer", { threadId: from.thread, expectedTurnId: from.turnId, input: this.input(text, []) }).catch(() => {});
            return;
        }
        if (!this.threadId || !this.turnId) {
            if (followUp) this.followUp = text;
            return;
        }
        void this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input: this.input(text, []) }).catch(() => {
            if (followUp) this.followUp = text;
        });
    }
}

/** A request from a thread other than the main one. */
interface Origin {
    thread: string;
    turnId?: string;
    sub?: SubAgent;
}

/**
 * The harness's MCP server as Codex config for the thread (sent over the
 * app-server's stdin, never in arguments). Its tools run without Codex's
 * approval prompt: what a delegated agent does is checked when it does it, and run_with_secrets checks its command itself.
 */
export function orchestratorConfig(o: OrchestratorServer): Record<string, unknown> {
    return {
        mcp_servers: {
            [o.name]: {
                url: o.url,
                http_headers: { Authorization: o.authorization },
                tool_timeout_sec: o.toolTimeoutSec,
                startup_timeout_sec: 30,
                default_tools_approval_mode: "approve",
                supports_parallel_tool_calls: true,
            },
        },
    };
}

/**
 * The command a commandExecution runs, out of its shell wrapper: what rules, the read-only
 * check and the prompt see. Not Codex's parsed commandActions, which can
 * leave parts out (a leading cd). Codex shows the wrapper shell-quoted
 * (`/bin/zsh -lc "rg -g '"'!x'"'"`), so it's split as a shell would; one
 * that would expand anything, or isn't one of Codex's shells, is left whole.
 */
function innerCommand(x: any): string {
    const cmd = String(x?.command ?? "");
    const a = analyzeCommand(cmd);
    const argv = a.commands.length === 1 && !a.hasSubstitution && !a.unsafeExpansion && !a.unparsable && !a.redirects.length ? a.commands[0]!.argv : [];
    return argv.length === 3 && WRAPPER_SHELL.test(argv[0]!) && /^-l?c$/.test(argv[1]!) ? argv[2]! : cmd;
}

/** Shells Codex wraps commands in. The model can name another one (`./bash`), which could be anything. */
const WRAPPER_SHELL = /^\/(?:bin|usr\/bin|usr\/local\/bin|opt\/homebrew\/bin)\/(?:ba|z)?sh$/;

/**
 * The command as rules, checks and the prompt see it. One the model runs in
 * another folder (Codex takes a workdir) goes behind a cd to it.
 */
/** Is `dir` (resolved) in the session's folder or one of the added ones (`~/…` and relative ones as the checker reads them)? */
export function insideWorkspace(dir: string, cwd: string, additionalDirectories: string[]): boolean {
    return [cwd, ...additionalDirectories].some((r) => isInside(dir, canonical(expandPath(r, cwd))));
}

function shownCommand(x: any, cwd: string): { command: string; dir: string; elsewhere: boolean } {
    const inner = innerCommand(x);
    // The folder it runs in as the volume has it: through a symlink (`keys -> ~/.ssh`), the checker must see where it leads.
    const dir = canonical(typeof x?.cwd === "string" && x.cwd ? resolve(cwd, x.cwd) : cwd);
    const elsewhere = dir !== canonical(resolve(cwd));
    return { command: elsewhere ? `cd '${dir.replace(/'/g, `'\\''`)}' && ${inner}` : inner, dir, elsewhere };
}

function fileChanges(item: any): FileChange[] {
    const changes: any[] = Array.isArray(item?.changes) ? item.changes : [];
    return changes.map((c) => ({
        path: String(c?.path ?? ""),
        kind: String(c?.kind?.type ?? "update"),
        diff: String(c?.diff ?? ""),
        movePath: typeof c?.kind?.move_path === "string" && c.kind.move_path ? c.kind.move_path : undefined,
    }));
}

/** Every path a change writes: sources, and renames' destinations. */
function writtenPaths(changes: FileChange[]): string[] {
    return [...new Set(changes.flatMap((c) => (c.movePath ? [c.path, c.movePath] : [c.path])))];
}

/** A sub-agent's usage, already counted, kept for its chip until its thread is claimed (not a Codex method). */
const SHOWN_USAGE = "harness/subagentUsage";

/** Notifications about any thread's actions (its reviewer's verdicts): shown whichever thread they're for. */
const ANY_THREAD = new Set(["guardianWarning", "item/autoApprovalReview/started", "item/autoApprovalReview/completed"]);

const TOKEN_FIELDS = ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"] as const;
type Tokens = Record<(typeof TOKEN_FIELDS)[number], number>;

/** Codex's token breakdown (TokenUsageBreakdown), or undefined when it isn't one. */
function tokens(x: any): Tokens | undefined {
    if (!x || typeof x !== "object" || typeof x.inputTokens !== "number") return undefined;
    return Object.fromEntries(TOKEN_FIELDS.map((k) => [k, Number.isFinite(x[k]) ? Number(x[k]) : 0])) as Tokens;
}

/** What was spent between two totals; undefined if any went down (they aren't a thread's totals then). */
function minus(a: Tokens, b: Tokens): Tokens | undefined {
    const d = Object.fromEntries(TOKEN_FIELDS.map((k) => [k, a[k] - b[k]])) as Tokens;
    return TOKEN_FIELDS.every((k) => d[k] >= 0) ? d : undefined;
}

/** Codex's sub-agent tools that set one going (again) other than a spawn. */
const RUNS_SUBAGENT = new Set(["sendInput", "resumeAgent", "sendMessage", "followupTask"]);

/** Codex's sub-agent tools other than spawning one, in a few words. */
const COLLAB_TITLES: Record<string, string> = {
    wait: "Wait for sub-agents",
    sendInput: "Message a sub-agent",
    sendMessage: "Message a sub-agent",
    followupTask: "Message a sub-agent",
    resumeAgent: "Resume a sub-agent",
    interruptAgent: "Interrupt a sub-agent",
    closeAgent: "Close a sub-agent",
    listAgents: "List sub-agents",
};

/** A sub-agent's label: the first line of what it was asked, short. */
function subAgentLabel(prompt: string): string {
    const first = prompt.trim().split("\n")[0]!.trim();
    if (!first) return "Codex sub-agent";
    return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

/** What a web search looked for (or the page it opened), as far as the item says yet. */
function webQuery(item: any): string {
    const a = item?.action ?? {};
    const queries = Array.isArray(a.queries) ? a.queries.filter((q: unknown) => typeof q === "string" && q) : [];
    const str = (x: unknown) => (typeof x === "string" ? x : "");
    return str(item?.query) || str(a.query) || queries.join(", ") || (str(a.pattern) && str(a.url) ? `${a.pattern} in ${a.url}` : str(a.url));
}

/** The option that leaves an optional field of an MCP server's form empty. */
const LEAVE_EMPTY = "Leave empty";

interface FormField {
    key: string;
    question: string;
    options: BackendQuestion["options"];
    multi: boolean;
    required: boolean;
    /** The option that leaves it empty (an optional field's), named so no answer of its own is taken for it. */
    skip?: string;
    /** The value for what was picked or typed; undefined when it isn't one. */
    parse(answer: string[]): unknown;
}

/**
 * An MCP elicitation's form (a flat object of strings, numbers, booleans and
 * enums, as MCP has them) as one question per field. Undefined for a schema
 * that isn't one.
 */
export function elicitationForm(schema: any): FormField[] | undefined {
    const props = schema?.properties;
    if (!schema || typeof schema !== "object" || (schema.type !== undefined && schema.type !== "object") || (props !== undefined && (typeof props !== "object" || Array.isArray(props)))) return undefined;
    const required = new Set<string>(Array.isArray(schema.required) ? schema.required.filter((k: unknown) => typeof k === "string") : []);
    const out: FormField[] = [];
    for (const [key, s] of Object.entries<any>(props ?? {})) {
        if (!s || typeof s !== "object") return undefined;
        const req = required.has(key);
        const label = typeof s.title === "string" && s.title.trim() ? s.title.trim() : key;
        const question = `${label}${typeof s.description === "string" && s.description.trim() ? ` (${s.description.trim()})` : ""}${req ? "" : " (optional)"}`;
        // Choices: labels shown, values sent; something typed that isn't one of them isn't a value.
        const choices = (list: { value: string; label: string }[]) => (picked: string) => list.find((c) => c.label === picked)?.value ?? list.find((c) => c.value === picked)?.value;
        const enumOf = (x: any): { value: string; label: string }[] | undefined => {
            if (Array.isArray(x?.oneOf)) return x.oneOf.filter((o: any) => typeof o?.const === "string").map((o: any) => ({ value: o.const, label: typeof o.title === "string" ? o.title : o.const }));
            if (Array.isArray(x?.anyOf)) return x.anyOf.filter((o: any) => typeof o?.const === "string").map((o: any) => ({ value: o.const, label: typeof o.title === "string" ? o.title : o.const }));
            if (Array.isArray(x?.enum)) return x.enum.filter((v: unknown) => typeof v === "string").map((v: string, i: number) => ({ value: v, label: typeof x.enumNames?.[i] === "string" ? x.enumNames[i] : v }));
            return undefined;
        };
        const field = (options: BackendQuestion["options"], multi: boolean, parse: (a: string[]) => unknown): FormField => {
            if (req) return { key, question, options, multi, required: req, parse };
            // Not a label of the field's own (an enum's "Leave empty").
            let skip = LEAVE_EMPTY;
            while (options.some((o) => o.label === skip)) skip = `${skip} (skip)`;
            return { key, question, options: [...options, { label: skip }], multi, required: req, parse, skip };
        };
        const defaults = s.default !== undefined && typeof s.default !== "object" ? [{ label: String(s.default), description: "the default" }] : [];
        if (s.type === "array") {
            const list = enumOf(s.items);
            if (!list) return undefined;
            const value = choices(list);
            out.push(
                field(list.map((c) => ({ label: c.label })), true, (a) => {
                    const v = a.map(value);
                    const n = v.length;
                    return v.every((x) => x !== undefined) && !(typeof s.minItems === "number" && n < s.minItems) && !(typeof s.maxItems === "number" && n > s.maxItems) ? v : undefined;
                }),
            );
        } else if (s.type === "string" && enumOf(s)) {
            const list = enumOf(s)!;
            const value = choices(list);
            out.push(field(list.map((c) => ({ label: c.label })), false, (a) => value(a[0]!)));
        } else if (s.type === "boolean") {
            out.push(field([{ label: "Yes" }, { label: "No" }], false, (a) => (/^(yes|y|true)$/i.test(a[0]!.trim()) ? true : /^(no|n|false)$/i.test(a[0]!.trim()) ? false : undefined)));
        } else if (s.type === "number" || s.type === "integer") {
            const integer = s.type === "integer";
            out.push(
                field(defaults, false, (a) => {
                    const n = Number(a[0]!.trim());
                    const inRange = !(typeof s.minimum === "number" && n < s.minimum) && !(typeof s.maximum === "number" && n > s.maximum);
                    return a[0]!.trim() && Number.isFinite(n) && (!integer || Number.isInteger(n)) && inRange ? n : undefined;
                }),
            );
        } else if (s.type === "string") {
            const fits = (v: string) => !(typeof s.minLength === "number" && v.length < s.minLength) && !(typeof s.maxLength === "number" && v.length > s.maxLength);
            out.push(field(defaults, false, (a) => (fits(a[0]!) ? a[0] : undefined)));
        } else return undefined;
    }
    return out;
}

/** The guardianWarning Codex sends with each of its reviewer's verdicts (the reason last), and with a yes. */
const REVIEW_VERDICT = /^Automatic approval review [\w ]+ \(risk: [^)]*\): ([\s\S]+)$/;
const APPROVED_VERDICT = /^Automatic approval review approved \(risk: /;
const verdictKey = (threadId: unknown, reason: string) => `${typeof threadId === "string" ? threadId : ""}\0${reason}`;

/** What Codex's reviewer looked at, in a few words. */
export function reviewedAction(a: any): string {
    const clip = (x: string) => (x.length > 160 ? `${x.slice(0, 160)}…` : x);
    switch (a?.type) {
        case "command":
            return `\`${clip(String(a.command ?? ""))}\``;
        case "execve":
            return `\`${clip([a.program, ...(Array.isArray(a.argv) ? a.argv.slice(1) : [])].join(" "))}\``;
        case "writeStdin":
            return "input to a running command";
        case "applyPatch":
            return "a file change";
        case "networkAccess":
            return a.host ? `network access to ${String(a.host)}` : "network access";
        case "mcpToolCall":
            return a.server && a.toolName ? `${String(a.server)}'s ${String(a.toolName)} tool` : "an MCP tool call";
        case "requestPermissions":
            return "a request for more permissions";
        default:
            return "an action";
    }
}

/** The folders a permissions request asks Codex's sandbox to open, for reading and writing. */
export function requestedPaths(permissions: any, roots: string[]): { read: string[]; write: string[]; network: boolean; unknown: string[] } {
    const fs = permissions?.fileSystem ?? {};
    const list = (x: unknown) => (Array.isArray(x) ? x.filter((p): p is string => typeof p === "string") : []);
    const read = list(fs.read);
    const write = list(fs.write);
    const unknown: string[] = [];
    for (const e of Array.isArray(fs.entries) ? fs.entries : []) {
        if (e?.access !== "write" && e?.access !== "read") continue; // "deny" only takes access away
        const folders = entryFolders(e.path, roots);
        if (!folders) unknown.push(describeEntry(e.path));
        else (e.access === "write" ? write : read).push(...folders);
    }
    const network = permissions?.network?.enabled === true;
    // Something it asks for that isn't any of these: it can't be checked, so it's refused.
    if (!read.length && !write.length && !network && !unknown.length && Object.values(permissions ?? {}).some((v) => v !== null && v !== undefined)) unknown.push(JSON.stringify(permissions));
    return { read, write, network, unknown };
}

/**
 * The folders one sandbox entry covers: a path; a glob's folder up to its
 * first wildcard; or a special path the harness knows. Undefined for one it
 * can't map to folders (Codex's "minimal" system paths, or kinds it doesn't
 * know), which then can't be checked against the rules.
 */
function entryFolders(path: any, roots: string[]): string[] | undefined {
    if (path?.type === "path" && typeof path.path === "string") return [path.path];
    if (path?.type === "glob_pattern" && typeof path.pattern === "string") {
        const segs = path.pattern.split("/");
        const first = segs.findIndex((s: string) => /[*?[{]/.test(s));
        return [(first < 0 ? segs : segs.slice(0, first)).join("/") || "/"];
    }
    if (path?.type === "special") {
        const v = path.value ?? {};
        // As Codex resolves it: an absolute subpath replaces the root, a relative one goes under it.
        const sub = (r: string) => (typeof v.subpath !== "string" || !v.subpath ? r : isAbsolute(v.subpath) ? resolve(v.subpath) : join(r, v.subpath));
        switch (v.kind) {
            case "root":
                return ["/"];
            case "tmpdir":
                return [tmpdir()];
            case "slash_tmp":
                return ["/tmp"];
            case "project_roots":
                return [...new Set(roots.map(sub))];
        }
    }
    return undefined;
}

function describeEntry(path: any): string {
    if (path?.type === "special") return `the special path "${String(path.value?.kind ?? "?")}"${typeof path.value?.path === "string" ? ` (${path.value.path})` : ""}`;
    return JSON.stringify(path);
}

function mcpText(result: any): string {
    const content: any[] = Array.isArray(result?.content) ? result.content : [];
    const text = content.map((c) => (c?.type === "text" ? String(c.text ?? "") : c?.type ? `[${c.type}]` : "")).filter(Boolean).join("\n");
    return text || (result?.structuredContent ? JSON.stringify(result.structuredContent) : "(no output)");
}

/** The before/after of one file in a Codex patch, for the approval prompt's diff. */
export function changePreview(c: { path: string; kind: string; diff: string }, cwd: string): { summary?: string; diff?: { path: string; before: string; after: string }; body?: string } {
    const abs = isAbsolute(c.path) ? c.path : join(cwd, c.path);
    const rel = abs.startsWith(cwd + "/") ? abs.slice(cwd.length + 1) : abs;
    let before = "";
    try {
        if (existsSync(abs)) before = readFileSync(abs, "utf-8");
    } catch {
        // unreadable: show the patch as text
    }
    if (c.kind === "add") return { diff: { path: rel, before: "", after: c.diff } };
    if (c.kind === "delete") return { summary: "Deletes the file", diff: { path: rel, before, after: "" } };
    const after = applyHunks(before, c.diff);
    return after === undefined ? { body: c.diff } : { diff: { path: rel, before, after } };
}

/** Apply unified-diff hunks to a text; undefined if they don't fit it. */
export function applyHunks(text: string, diff: string): string | undefined {
    const src = text.split("\n");
    const out: string[] = [];
    let pos = 0;
    const lines = diff.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (let i = 0; i < lines.length; i++) {
        const h = lines[i]!.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
        if (!h) continue;
        const start = Math.max(0, Number(h[1]) - 1);
        if (start < pos) return undefined;
        out.push(...src.slice(pos, start));
        pos = start;
        for (i++; i < lines.length && !lines[i]!.startsWith("@@"); i++) {
            const l = lines[i]!;
            const op = l[0];
            const body = l.slice(1);
            if (op === "\\") continue;
            if (op === "+") out.push(body);
            else if (op === " " || op === "-") {
                if (src[pos] !== body) return undefined;
                if (op === " ") out.push(body);
                pos++;
            } else return undefined;
        }
        i--;
    }
    out.push(...src.slice(pos));
    return out.join("\n");
}

/** How long a run waits for Codex to start the goal's next turn itself before it gives up on it. */
const GOAL_TURN_WAIT_MS = 60_000;
/** With the user's messages to send while the goal is active: how long Codex gets to start its next turn, which takes them. */
const GOAL_TURN_GRACE_MS = 1500;

/** `/goal …` as the prompt, for Codex's own goals; undefined for anything else. */
export function codexGoalCommand(prompt: string): GoalCommand | undefined {
    const m = prompt.trim().match(/^\/goal(?:\s+([\s\S]*))?$/i);
    return m ? parseGoalCommand(m[1] ?? "") : undefined;
}

const CODEX_GOAL_STATUS: Record<string, NativeGoal["status"]> = { active: "active", paused: "paused", blocked: "blocked", usageLimited: "limited", budgetLimited: "limited", complete: "complete" };

/** A ThreadGoal from Codex's app-server (thread/goal/get, set, updated). */
export function codexGoal(raw: unknown): NativeGoal | null {
    if (!raw || typeof raw !== "object") return null;
    const g = raw as { objective?: unknown; status?: unknown; createdAt?: unknown; tokensUsed?: unknown };
    const condition = typeof g.objective === "string" ? g.objective.trim() : "";
    if (!condition) return null;
    return {
        provider: "codex",
        condition,
        status: CODEX_GOAL_STATUS[String(g.status)] ?? "paused",
        since: typeof g.createdAt === "number" ? g.createdAt * 1000 : Date.now(),
        ...(typeof g.tokensUsed === "number" ? { tokens: Math.max(0, g.tokensUsed) } : {}),
    };
}

function describeCodexGoal(g: NativeGoal): string {
    const status = g.status === "limited" ? "stopped at a limit" : g.status === "complete" ? "achieved" : g.status;
    return `◎ Goal (Codex, ${status}): ${g.condition}`;
}
