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
import type { PermissionMode } from "../permissions/modes";
import { analyzeCommand } from "../permissions/bash-safety";
import { APP_NAME, APP_TITLE, APP_VERSION } from "../config/paths";
import { redact } from "../util/redact";
import { gitRoot } from "../util/git";
import { canonical } from "../util/files";
import { CODEX_CLI, JsonLinesProcess, cliMessage, commandTitle, extraArgs, requireCli, stopTiming } from "./cli";
import { backendModel, type AgentBackendClient, type BackendHost, type BackendResult, type BackendTurn, type OrchestratorServer, type PermissionAnswer } from "./types";

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
                    if (m.error) p.reject(new ProviderError(`Codex: ${String(m.error.message ?? "request failed")}`));
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
function spawnRpc(providerId: string, cwd: string, onNotification: (method: string, params: any) => void, onRequest: (method: string, params: any) => Promise<unknown>, opts: { trusted?: boolean } = {}): Rpc {
    const bin = requireCli(providerId, CODEX_CLI);
    const args = ["app-server", ...extraArgs(providerId), ...(opts.trusted === false ? untrustedArgs(cwd) : [])];
    return new Rpc(new JsonLinesProcess(bin, args, { cwd }), onNotification, onRequest);
}

async function handshake(rpc: Rpc) {
    await rpc.request("initialize", { clientInfo: { name: `${APP_NAME}_cli`, title: APP_TITLE, version: APP_VERSION }, capabilities: null });
    rpc.notify("initialized");
}

/** Start app-server and do the handshake; the signal (or the timeout) stops it at any point. */
async function connect(providerId: string, cwd: string, signal?: AbortSignal): Promise<Rpc> {
    const rpc = spawnRpc(providerId, cwd, () => {}, async () => {
        throw new Error("not supported");
    });
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
    return { type: typeof a?.type === "string" ? a.type : undefined, email: typeof a?.email === "string" ? a.email : undefined, planType: typeof a?.planType === "string" ? a.planType : undefined, requiresAuth: r?.requiresOpenaiAuth === true };
}

export function describeCodexAuth(a: CodexAccount): string {
    if (a.type === "chatgpt") return `signed in with ChatGPT${a.planType ? ` (${a.planType} plan)` : ""}`;
    if (a.type === "apiKey") return "signed in with an API key (usage is billed to that key, not a plan)";
    if (a.type) return `signed in (${a.type})`;
    return a.requiresAuth ? "not signed in" : "using a model provider that needs no sign-in";
}

/** How Codex is signed in (account/read), from Codex itself. */
export async function codexAccount(providerId = "codex", signal?: AbortSignal): Promise<CodexAccount> {
    const rpc = await connect(providerId, homedir(), signal);
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
export function codexPolicy(mode: PermissionMode, additionalDirectories: string[]): Policy {
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
function codexPolicyKey(m: PermissionMode): string {
    const p = codexPolicy(m, []);
    return `${p.approvalPolicy}|${p.sandbox}|${p.approvalsReviewer}`;
}

const PLAN_NOTE =
    "<system-reminder>\nPlan mode is active: the user wants a plan before anything changes. Research with read-only commands, don't modify files, and reply with your plan. Changes will be refused until the user approves it.\n</system-reminder>";

// Codex tells its model the sandbox "only permits reading files", and it can take that as
// the end of it. An approved change or command runs outside the sandbox (seen with 0.162).
const MANUAL_NOTE =
    "<system-reminder>\nThe sandbox is read-only, but you can still change files and run other commands: each one goes to the user for approval first and runs once they approve. Make the changes the task needs; don't stop because the sandbox is read-only.\n</system-reminder>";

/** What a turn starts with for the mode: plan mode's rules, or (manual mode, an agent that may change things) that changes are asked about. */
function modeNote(mode: PermissionMode, readOnly: boolean): string | undefined {
    if (mode === "plan") return PLAN_NOTE;
    if (mode === "default" && !readOnly) return MANUAL_NOTE;
    return undefined;
}

/** Prefer the current catalog; the legacy field is only used by older CLIs. */
export function codexFastTier(m: { serviceTiers?: { id: string }[]; additionalSpeedTiers?: string[] }): string | undefined {
    const tiers = Array.isArray(m.serviceTiers) ? m.serviceTiers.map((t) => t.id) : m.additionalSpeedTiers ?? [];
    return tiers.find((t) => t === "fast" || t === "priority");
}

export class CodexBackend implements AgentBackendClient {
    readonly agentBackend = true as const;

    constructor(readonly def: ProviderDef) {}

    async stream(): Promise<AssistantMessage> {
        throw new ProviderError(`${this.def.name} runs whole turns with its own tools, so it can't answer one-off requests. Set smallModel to another provider's model for those.`);
    }

    /** Codex's model catalog (model/list), the default model first. */
    async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
        const rpc = await connect(this.def.id, homedir(), signal);
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

    async runTurn(t: BackendTurn): Promise<BackendResult> {
        const turn = new CodexTurn(this.def, t);
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
        return new CodexTurn(this.def, { ...t, prompt: "", images: [] }).run({ compact: true });
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

/** How much a mode lets Codex do on its own; switching to a higher one mid-turn can't wait for the next turn. */
const STRICTNESS: Record<PermissionMode, number> = { bypassPermissions: 0, auto: 1, acceptEdits: 2, default: 3, plan: 4 };

interface OpenItem {
    name: string;
    input: Record<string, unknown>;
    title: string;
    started: number;
    changes?: FileChange[];
}

interface FileChange {
    path: string;
    kind: string;
    diff: string;
    /** A rename's destination. */
    movePath?: string;
}

class CodexTurn {
    private rpc!: Rpc;
    private threadId?: string;
    private turnId?: string;
    private items = new Map<string, OpenItem>();
    private streamed = new Set<string>();
    private texts: string[] = [];
    private actions: string[] = [];
    private aborted = false;
    private failure?: string;
    private status?: string;
    private billedToPlan = false;
    private limitNoted = false;
    /** Reviewer noes shown from item/autoApprovalReview/completed, by thread and reason, whose guardianWarning hasn't come yet. */
    private noesShown = new Map<string, number>();
    /** What the user said when declining something, when it can't go into the running turn: it starts the next one. */
    private followUp?: string;
    private followUps = 0;
    /** Why the last approval was refused, for the item's result. */
    private refusal?: string;
    private turnDone?: () => void;
    /** The mode the running turn's policy came from. */
    private turnMode?: PermissionMode;
    /** The user switched to a stricter mode mid-turn: the turn was interrupted to go on under it. */
    private restartFor?: PermissionMode;

    constructor(
        private def: ProviderDef,
        private t: BackendTurn,
    ) {}

    modeChanged(m: PermissionMode) {
        if (!this.turnId || this.turnMode === undefined || this.aborted) return;
        if (STRICTNESS[m] > STRICTNESS[this.turnMode] && codexPolicyKey(m) !== codexPolicyKey(this.turnMode) || (m === "plan" && this.turnMode !== "plan")) {
            this.restartFor = m;
            this.interrupt();
        }
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
        this.rpc = spawnRpc(this.def.id, t.cwd, (m, p) => this.onNotification(m, p), (m, p) => this.onRequest(m, p), { trusted: t.trusted });
        let abortTimer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
            this.aborted = true;
            if (this.threadId && this.turnId) {
                this.interrupt();
                // It answers an interrupt with turn/completed; if it doesn't, stop it.
                abortTimer = setTimeout(() => void this.rpc.proc.kill(), stopTiming.interruptMs);
            } else void this.rpc.proc.kill(); // still starting: nothing to interrupt
        };
        t.signal.addEventListener("abort", onAbort, { once: true });
        try {
            await withTimeout(handshake(this.rpc), 30_000, "Codex didn't start (no answer to initialize)");
            const account = parseAccount(await this.rpc.request("account/read", {}));
            if (!account.type && account.requiresAuth) {
                return { reason: "error", text: "", actions: [], error: `Codex isn't signed in. In a terminal, run \`${CODEX_CLI.signIn}\`, then try again.` };
            }
            this.billedToPlan = account.type === "chatgpt";
            const policy = codexPolicy(this.host.mode(), t.additionalDirectories);
            const model = t.model.id === "default" ? undefined : t.model.id;
            const o = t.orchestrator;
            const developerInstructions = [t.appendSystemPrompt, o?.instructions].filter(Boolean).join("\n\n") || undefined;
            let config = o ? orchestratorConfig(o) : undefined;
            if (t.readOnly) {
                const off = await this.mcpServersOff(t.cwd);
                if (typeof off === "string") return { reason: "error", text: "", actions: [], error: off };
                config = off;
            }
            const serviceTier = t.fastMode && t.model.supportsFastMode ? t.model.fastModeTier ?? "fast" : "default";
            const threadParams = { cwd: t.cwd, model, serviceTier, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox, approvalsReviewer: policy.approvalsReviewer, developerInstructions, ...(config ? { config } : {}) };
            // A Codex that won't take the delegation server's config still gets its thread, without it.
            const thread = async (method: string, params: Record<string, unknown>) => {
                try {
                    return await this.rpc.request(method, params);
                } catch (e) {
                    if (this.aborted || !o) throw e;
                    const r = await this.rpc.request(method, { ...params, config: undefined, developerInstructions: t.appendSystemPrompt || undefined });
                    this.host.emit({ type: "notice", level: "warn", message: `Codex didn't accept ${APP_TITLE}'s delegation tools (${redact((e as Error).message).replace(/^Codex:\s*/, "")}); this turn runs without them.` });
                    return r;
                }
            };
            if (t.resumeId) {
                try {
                    const r = await thread("thread/resume", { ...threadParams, threadId: t.resumeId, excludeTurns: true });
                    this.threadId = r?.thread?.id ?? t.resumeId;
                } catch (e) {
                    // Stopped by esc: the thread is fine and is resumed next time.
                    if (this.aborted) throw e;
                    return { reason: "error", text: "", actions: [], error: `Couldn't resume the Codex thread: ${(e as Error).message}`, resumeFailed: true };
                }
            } else {
                const r = await thread("thread/start", threadParams);
                this.threadId = r?.thread?.id;
                if (!this.threadId) throw new ProviderError("Codex didn't start a thread");
            }
            this.host.sessionId(this.threadId!);
            if (opts.compact) {
                await this.waitFor(() => this.rpc.request("thread/compact/start", { threadId: this.threadId }));
            } else {
                let text = t.prompt;
                let images = t.images;
                while (true) {
                    // The policy for the mode as it is now: it may have changed since the last turn.
                    const mode = this.host.mode();
                    const policy = codexPolicy(mode, t.additionalDirectories);
                    const note = modeNote(mode, Boolean(t.readOnly));
                    const input = this.input(note ? `${note}\n\n${text}` : text, images);
                    const effort = t.effort && (!t.model.effortLevels || t.model.effortLevels.includes(t.effort)) ? t.effort : undefined;
                    this.turnMode = mode;
                    await this.waitFor(async () => {
                        const r = await this.rpc.request("turn/start", { threadId: this.threadId, input, cwd: t.cwd, model, effort, serviceTier, approvalPolicy: policy.approvalPolicy, sandboxPolicy: policy.sandboxPolicy, approvalsReviewer: policy.approvalsReviewer, summary: "auto" });
                        this.turnId = r?.turn?.id;
                    });
                    this.turnId = undefined;
                    if (this.aborted || this.status === "failed") break;
                    images = [];
                    const restart = this.restartFor;
                    this.restartFor = undefined;
                    if (restart) {
                        text = `<system-reminder>\nThe user switched the permission mode to ${restart === "plan" ? "plan mode" : `"${restart}"`} while you were working, so your turn was stopped and resumes under it. Continue from where you were, within the new mode.\n</system-reminder>`;
                        continue;
                    }
                    const followUp = this.followUp && this.followUps++ < 5 ? this.followUp : undefined;
                    this.followUp = undefined;
                    const next = followUp ? [followUp] : this.host.drainQueued();
                    if (!next.length) break;
                    text = next.join("\n\n");
                }
            }
        } catch (e) {
            if (!this.aborted) this.failure = redact((e as Error).message);
        } finally {
            t.signal.removeEventListener("abort", onAbort);
            if (abortTimer) clearTimeout(abortTimer);
            await this.rpc.proc.stop(1000);
        }
        for (const [id, it] of this.items) this.endItem(id, it, this.aborted ? "Interrupted by user" : "Codex stopped before this finished.", true);
        const text = this.texts.join("\n\n");
        if (this.aborted) return { reason: "aborted", text, actions: this.actions };
        if (this.failure) return { reason: "error", text, actions: this.actions, error: this.failure };
        return { reason: "done", text, actions: this.actions };
    }

    private input(text: string, images: BackendTurn["images"]): unknown[] {
        const out: unknown[] = [];
        if (text) out.push({ type: "text", text, text_elements: [] });
        for (const i of images) out.push({ type: "image", url: `data:${i.mediaType};base64,${i.data}` });
        return out;
    }

    private interrupt() {
        void this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
    }

    /** Start something that ends with turn/completed (or thread/compacted), and wait for that. */
    private async waitFor(start: () => Promise<void>) {
        const done = new Promise<void>((resolve) => (this.turnDone = resolve));
        this.status = undefined;
        await start();
        // Interrupted while the turn was being started.
        if (this.aborted && this.turnId) this.interrupt();
        // The mode changed while it was being started (modeChanged had no turn to stop yet).
        else if (this.turnId) this.modeChanged(this.host.mode());
        await Promise.race([done, this.rpc.done]);
        this.turnDone = undefined;
        if (!this.status && !this.aborted && !this.failure) this.failure = `Codex stopped before the turn finished${cliMessage(this.rpc.proc.stderr()) ? `: ${cliMessage(this.rpc.proc.stderr())}` : ""}`;
    }

    private onNotification(method: string, p: any) {
        switch (method) {
            case "turn/started":
                this.host.emit({ type: "request_start" });
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
            case "item/started":
                this.onItemStarted(p.item ?? {});
                break;
            case "item/completed":
                this.onItemCompleted(p.item ?? {});
                break;
            case "thread/tokenUsage/updated":
                this.onUsage(p.tokenUsage ?? {});
                break;
            case "turn/completed":
                if (p.turn?.id && this.turnId && p.turn.id !== this.turnId) break;
                this.status = p.turn?.status;
                if (p.turn?.status === "failed") this.failure = redact(String(p.turn?.error?.message ?? "Codex reported a failed turn"));
                this.turnDone?.();
                break;
            case "thread/compacted":
                this.host.emit({ type: "notice", level: "info", message: "Codex compacted its context." });
                this.status ??= "completed";
                this.turnDone?.();
                break;
            case "error":
                if (p.willRetry) this.host.emit({ type: "retry", attempt: 1, delayMs: 0, reason: redact(String(p.error?.message ?? "Codex is retrying")) });
                else this.failure = redact(String(p.error?.message ?? "Codex reported an error"));
                break;
            case "warning":
            case "configWarning":
            case "deprecationNotice": {
                const msg = String(p.message ?? p.summary ?? "").trim();
                if (msg) this.host.emit({ type: "notice", level: "info", message: `Codex: ${msg}` });
                break;
            }
            case "item/autoApprovalReview/completed": {
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
                // Its verdict on each action ("Automatic approval review approved (risk: low, …): why"): an
                // approval is noise, and a no shown from item/autoApprovalReview/completed (same thread, same
                // reason) isn't shown twice. Anything it can't match, a no that event didn't bring included, shows.
                if (!msg || APPROVED_VERDICT.test(msg)) break;
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
                const reached = p.rateLimits?.rateLimitReachedType;
                if (reached && !this.limitNoted) {
                    this.limitNoted = true;
                    this.host.emit({ type: "notice", level: "warn", message: `Your Codex usage limit has been reached (${String(reached)}).` });
                }
                break;
            }
        }
    }

    private onUsage(u: any) {
        const last = u.last ?? {};
        const cached = Number(last.cachedInputTokens ?? 0);
        const usage: Usage = {
            inputTokens: Math.max(0, Number(last.inputTokens ?? 0) - cached),
            outputTokens: Number(last.outputTokens ?? 0),
            cacheReadTokens: cached,
            cacheWriteTokens: Number(last.cacheWriteInputTokens ?? 0),
            reasoningTokens: Number(last.reasoningOutputTokens ?? 0),
            // A ChatGPT plan isn't billed per token; with an API key the price isn't known here.
            cost: this.billedToPlan ? 0 : undefined,
        };
        this.host.usage(usage, { contextTokens: Number(last.inputTokens ?? 0) + Number(last.outputTokens ?? 0), contextWindow: typeof u.modelContextWindow === "number" ? u.modelContextWindow : undefined });
    }

    private onItemStarted(item: any) {
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
                open = { name, input, title: `${String(item.server ?? "")} - ${String(item.tool ?? "")} (MCP)`, started: Date.now() };
                break;
            }
            case "webSearch": {
                const query = String(item.query ?? item.action?.query ?? item.action?.url ?? "");
                open = { name: "WebSearch", input: { query }, title: `WebSearch(${query})`, started: Date.now() };
                break;
            }
            case "dynamicToolCall":
            case "collabAgentToolCall":
            case "imageView":
            case "imageGeneration": {
                const name = String(item.tool ?? item.type);
                open = { name, input: item.arguments && typeof item.arguments === "object" ? item.arguments : {}, title: name, started: Date.now() };
                break;
            }
        }
        if (!open || !id) return;
        this.items.set(id, open);
        this.host.emit({ type: "tool_start", call: { type: "tool_call", id, name: open.name, input: open.input }, title: open.title });
    }

    private onItemCompleted(item: any) {
        const id = String(item.id ?? "");
        if (item.type === "agentMessage") {
            const text = String(item.text ?? "");
            if (!text.trim()) return;
            if (!this.streamed.has(id)) this.host.emit({ type: "text", text });
            this.texts.push(text);
            this.host.emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], provider: this.def.id, model: this.t.model.id } });
            return;
        }
        if (item.type === "contextCompaction") {
            this.host.emit({ type: "notice", level: "info", message: "Codex compacted its context." });
            return;
        }
        const open = this.items.get(id);
        if (!open) return;
        const failed = item.status === "failed" || item.status === "declined";
        switch (item.type) {
            case "commandExecution": {
                const out = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
                const code = typeof item.exitCode === "number" ? item.exitCode : undefined;
                const content = item.status === "declined" ? this.takeRefusal("The command was declined.") : `${out}${code !== undefined && code !== 0 ? `${out ? "\n" : ""}Exit code ${code}` : ""}` || "(no output)";
                this.endItem(id, open, content, failed || (code !== undefined && code !== 0));
                break;
            }
            case "fileChange": {
                const changes = open.changes ?? fileChanges(item);
                const content = item.status === "declined" ? this.takeRefusal("The change was declined.") : failed ? "The change was not applied." : `Changed ${changes.length} file${changes.length === 1 ? "" : "s"}: ${changes.map((c) => c.path).join(", ")}`;
                const body = changes.map((c) => `${c.kind} ${c.path}\n${c.diff}`).join("\n").slice(0, 20_000);
                this.endItem(id, open, content, failed, failed ? undefined : { summary: `Changed ${changes.length} file${changes.length === 1 ? "" : "s"}`, body });
                break;
            }
            case "mcpToolCall": {
                const content = item.error?.message ? String(item.error.message) : mcpText(item.result);
                this.endItem(id, open, content, Boolean(item.error) || failed);
                break;
            }
            default:
                this.endItem(id, open, failed ? "Failed" : "Done", failed);
        }
    }

    private takeRefusal(fallback: string): string {
        const r = this.refusal ?? fallback;
        this.refusal = undefined;
        return r;
    }

    private endItem(id: string, open: OpenItem, content: string, isError: boolean, display?: { summary?: string; body?: string }) {
        this.items.delete(id);
        this.actions.push(open.title);
        this.host.emit({ type: "tool_end", call: { type: "tool_call", id, name: open.name, input: open.input }, result: { content, isError, display }, durationMs: Date.now() - open.started });
    }

    /**
     * For a read-only sub-agent: thread config that turns off the MCP
     * servers in the user's Codex config (as seen from this folder), since
     * Codex runs tools set to "approve" there without asking, and they may
     * change things. Thread config is merged into the user's, so each is
     * turned off by name. Why it can't, if Codex doesn't list them.
     */
    private async mcpServersOff(cwd: string): Promise<Record<string, unknown> | undefined | string> {
        let servers: unknown;
        try {
            servers = (await this.rpc.request("config/read", { cwd }))?.config?.mcp_servers;
        } catch (e) {
            if (this.aborted) throw e;
            return `Codex didn't list its MCP servers (${redact((e as Error).message).replace(/^Codex:\s*/, "")}), so a read-only task can't run on it: their tools couldn't be turned off.`;
        }
        const names = servers && typeof servers === "object" && !Array.isArray(servers) ? Object.keys(servers) : [];
        return names.length ? { mcp_servers: Object.fromEntries(names.map((n) => [n, { enabled: false }])) } : undefined;
    }

    private async onRequest(method: string, p: any): Promise<unknown> {
        switch (method) {
            case "item/commandExecution/requestApproval": {
                const { command, elsewhere } = shownCommand(p, this.t.cwd);
                const net = p.networkApprovalContext?.host ? ` It needs network access to ${String(p.networkApprovalContext.host)}.` : "";
                // Codex 0.162 asks about every command in untrusted mode, `cat` included. One that wants
                // the network says something, and one in another folder isn't checked where it runs.
                const asksAlways = !net && !elsewhere && codexPolicy(this.turnMode ?? this.host.mode(), []).approvalPolicy === "untrusted";
                const a = await this.host.permission({ toolName: "Bash", input: { command, description: typeof p.reason === "string" ? p.reason : undefined }, reason: `${typeof p.reason === "string" ? p.reason : ""}${net}`.trim() || undefined, asksAlways });
                return { decision: this.decision(a) };
            }
            case "item/fileChange/requestApproval": {
                const open = this.items.get(String(p.itemId ?? ""));
                const changes = open?.changes ?? [];
                if (!changes.length && typeof p.grantRoot === "string") {
                    const a = await this.host.permission({ toolName: "Edit", input: { file_path: join(p.grantRoot, "*") }, title: `Write access to ${p.grantRoot}`, reason: p.reason ?? undefined });
                    return { decision: this.decision(a) };
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
                });
                return { decision: this.decision(a) };
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
                });
                // Granting nothing lets the turn go on without them; what the user said goes in with it.
                if (!a.allow && a.fromUser) this.steer(a.message);
                if (!a.allow && a.stop) this.interrupt();
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
                return { action: "decline", content: null, _meta: null };
            default:
                throw new Error(`${method} isn't supported by this host`);
        }
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
     */
    private decision(a: PermissionAnswer): string {
        if (a.allow) return "accept";
        this.refusal = a.message;
        if (a.stop) return "cancel";
        if (a.fromUser) this.steer(a.message);
        else this.steer(`<system-reminder>\n${APP_TITLE} refused that: ${a.message}\n</system-reminder>`, false);
        return "decline";
    }

    /**
     * Add text to the running turn (turn/steer). The user's words start the
     * next turn if that fails; the harness's own notes (followUp false) don't.
     */
    private steer(text: string, followUp = true) {
        if (!this.threadId || !this.turnId) {
            if (followUp) this.followUp = text;
            return;
        }
        void this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input: this.input(text, []) }).catch(() => {
            if (followUp) this.followUp = text;
        });
    }
}

/**
 * The harness's MCP server as Codex config for the thread (sent over the
 * app-server's stdin, never in arguments). Its tools run without Codex's
 * approval prompt: what a delegated agent does is checked when it does it.
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
function shownCommand(x: any, cwd: string): { command: string; elsewhere: boolean } {
    const inner = innerCommand(x);
    const dir = typeof x?.cwd === "string" && x.cwd ? resolve(cwd, x.cwd) : cwd;
    const elsewhere = canonical(dir) !== canonical(resolve(cwd));
    return { command: elsewhere ? `cd '${dir.replace(/'/g, `'\\''`)}' && ${inner}` : inner, elsewhere };
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
