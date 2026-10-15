// Codex as an agent backend: the user's own installed `codex`, signed in by
// the user with `codex login` (a ChatGPT plan, or an API key they set up there).
//
// Each turn starts `codex app-server`, the JSON-RPC interface OpenAI ships for
// driving Codex from editors and other programs, starts or resumes a thread
// and runs one turn. Codex runs it with its own tools and sandbox; the harness
// maps its permission mode to Codex's approval policy and sandbox, shows the
// items as they stream, and answers Codex's approval requests through the
// harness's own permission rules and prompt. The harness never reads Codex's
// credentials (~/.codex/auth.json) and never signs in on its behalf.

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join } from "path";
import type { AssistantMessage, ModelInfo, Usage } from "../providers/types";
import { ProviderError } from "../providers/types";
import type { ProviderDef } from "../providers/registry";
import type { PermissionMode } from "../permissions/modes";
import { APP_NAME, APP_TITLE, APP_VERSION } from "../config/paths";
import { redact } from "../util/redact";
import { CODEX_CLI, JsonLinesProcess, cliMessage, commandTitle, extraArgs, requireCli } from "./cli";
import { backendModel, type AgentBackendClient, type BackendHost, type BackendResult, type BackendTurn, type PermissionAnswer } from "./types";

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

/** Start app-server and do the handshake. */
async function connect(providerId: string, cwd: string, onNotification: (method: string, params: any) => void, onRequest: (method: string, params: any) => Promise<unknown>): Promise<Rpc> {
    const bin = requireCli(providerId, CODEX_CLI);
    const rpc = new Rpc(new JsonLinesProcess(bin, ["app-server", ...extraArgs(providerId)], { cwd }), onNotification, onRequest);
    await rpc.request("initialize", { clientInfo: { name: `${APP_NAME}_cli`, title: APP_TITLE, version: APP_VERSION }, capabilities: null });
    rpc.notify("initialized");
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
    const rpc = await connect(providerId, homedir(), () => {}, async () => {
        throw new Error("not supported");
    });
    const kill = () => rpc.proc.kill();
    signal?.addEventListener("abort", kill, { once: true });
    try {
        return parseAccount(await withTimeout(rpc.request("account/read", {}), 20_000, "Codex didn't answer account/read"));
    } finally {
        signal?.removeEventListener("abort", kill);
        rpc.proc.kill();
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
}

/** The harness's permission mode as Codex's approval policy and sandbox. */
export function codexPolicy(mode: PermissionMode, additionalDirectories: string[]): Policy {
    switch (mode) {
        case "acceptEdits":
        case "auto":
            // Edits and commands inside the workspace run in Codex's sandbox; it asks to go beyond it.
            return { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite", writableRoots: additionalDirectories, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
        case "bypassPermissions":
            return { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
        default:
            // Manual and plan: commands other than known read-only ones, and every edit, ask.
            return { approvalPolicy: "untrusted", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } };
    }
}

const PLAN_NOTE =
    "<system-reminder>\nPlan mode is active: the user wants a plan before anything changes. Research with read-only commands, don't modify files, and reply with your plan. Changes will be refused until the user approves it.\n</system-reminder>";

export class CodexBackend implements AgentBackendClient {
    readonly agentBackend = true as const;

    constructor(readonly def: ProviderDef) {}

    async stream(): Promise<AssistantMessage> {
        throw new ProviderError(`${this.def.name} runs whole turns with its own tools, so it can't answer one-off requests. Set smallModel to another provider's model for those.`);
    }

    /** Codex's model catalog (model/list), the default model first. */
    async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
        const rpc = await connect(this.def.id, homedir(), () => {}, async () => {
            throw new Error("not supported");
        });
        const kill = () => rpc.proc.kill();
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
                    supportsImages: Array.isArray(m.inputModalities) ? m.inputModalities.includes("image") : true,
                }),
            );
        } finally {
            signal?.removeEventListener("abort", kill);
            rpc.proc.kill();
        }
    }

    async runTurn(t: BackendTurn): Promise<BackendResult> {
        return new CodexTurn(this.def, t).run();
    }

    /** Codex's own compaction of the thread. */
    async compact(t: Omit<BackendTurn, "prompt" | "images"> & { instructions?: string }): Promise<BackendResult> {
        if (!t.resumeId) return { reason: "done", text: "", actions: [] };
        return new CodexTurn(this.def, { ...t, prompt: "", images: [] }).run({ compact: true });
    }

    /** Codex takes the approval policy per turn; a change applies from the next one. */
    setMode(_m: PermissionMode) {}
}

interface OpenItem {
    name: string;
    input: Record<string, unknown>;
    title: string;
    started: number;
    changes?: { path: string; kind: string; diff: string }[];
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
    /** What the user said when declining something, when it can't go into the running turn: it starts the next one. */
    private followUp?: string;
    private followUps = 0;
    /** Why the last approval was refused, for the item's result. */
    private refusal?: string;
    private turnDone?: () => void;

    constructor(
        private def: ProviderDef,
        private t: BackendTurn,
    ) {}

    private get host(): BackendHost {
        return this.t.host;
    }

    async run(opts: { compact?: boolean } = {}): Promise<BackendResult> {
        const t = this.t;
        if (t.signal.aborted) return { reason: "aborted", text: "", actions: [] };
        this.rpc = await connect(this.def.id, t.cwd, (m, p) => this.onNotification(m, p), (m, p) => this.onRequest(m, p));
        let abortTimer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
            this.aborted = true;
            if (this.threadId && this.turnId) this.interrupt();
            else this.turnDone?.();
            // It answers an interrupt with turn/completed; don't wait forever if it doesn't.
            abortTimer = setTimeout(() => this.turnDone?.(), 8000);
        };
        t.signal.addEventListener("abort", onAbort, { once: true });
        try {
            const account = parseAccount(await this.rpc.request("account/read", {}));
            if (!account.type && account.requiresAuth) {
                return { reason: "error", text: "", actions: [], error: `Codex isn't signed in. In a terminal, run \`${CODEX_CLI.signIn}\`, then try again.` };
            }
            this.billedToPlan = account.type === "chatgpt";
            const policy = codexPolicy(t.mode, t.additionalDirectories);
            const model = t.model.id === "default" ? undefined : t.model.id;
            const threadParams = { cwd: t.cwd, model, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox, developerInstructions: t.appendSystemPrompt || undefined };
            if (t.resumeId) {
                try {
                    const r = await this.rpc.request("thread/resume", { ...threadParams, threadId: t.resumeId, excludeTurns: true });
                    this.threadId = r?.thread?.id ?? t.resumeId;
                } catch (e) {
                    return { reason: "error", text: "", actions: [], error: `Couldn't resume the Codex thread: ${(e as Error).message}`, resumeFailed: true };
                }
            } else {
                const r = await this.rpc.request("thread/start", threadParams);
                this.threadId = r?.thread?.id;
                if (!this.threadId) throw new ProviderError("Codex didn't start a thread");
            }
            this.host.sessionId(this.threadId!);
            if (opts.compact) {
                await this.waitFor(() => this.rpc.request("thread/compact/start", { threadId: this.threadId }));
            } else {
                let input = this.input(t.mode === "plan" ? `${PLAN_NOTE}\n\n${t.prompt}` : t.prompt, t.images);
                while (true) {
                    const effort = t.effort && (!t.model.effortLevels || t.model.effortLevels.includes(t.effort)) ? t.effort : undefined;
                    await this.waitFor(async () => {
                        const r = await this.rpc.request("turn/start", { threadId: this.threadId, input, cwd: t.cwd, model, effort, approvalPolicy: policy.approvalPolicy, sandboxPolicy: policy.sandboxPolicy, summary: "auto" });
                        this.turnId = r?.turn?.id;
                    });
                    if (this.aborted || this.status === "failed") break;
                    const followUp = this.followUp && this.followUps++ < 5 ? this.followUp : undefined;
                    this.followUp = undefined;
                    const next = followUp ? [followUp] : this.host.drainQueued();
                    if (!next.length) break;
                    input = this.input(next.join("\n\n"), []);
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
                const command = innerCommand(item);
                open = { name: "Bash", input: { command }, title: commandTitle(command), started: Date.now() };
                break;
            }
            case "fileChange": {
                const changes = fileChanges(item);
                const first = changes[0]?.path ?? "";
                const name = changes.length && changes.every((c) => c.kind === "add") ? "Write" : "Edit";
                open = { name, input: { file_path: first }, title: `${name}(${first}${changes.length > 1 ? ` +${changes.length - 1} more` : ""})`, started: Date.now(), changes };
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

    private async onRequest(method: string, p: any): Promise<unknown> {
        switch (method) {
            case "item/commandExecution/requestApproval": {
                const command = innerCommand(p);
                const net = p.networkApprovalContext?.host ? ` It needs network access to ${String(p.networkApprovalContext.host)}.` : "";
                const a = await this.host.permission({ toolName: "Bash", input: { command, description: typeof p.reason === "string" ? p.reason : undefined }, reason: `${typeof p.reason === "string" ? p.reason : ""}${net}`.trim() || undefined });
                return { decision: this.decision(a, p.availableDecisions) };
            }
            case "item/fileChange/requestApproval": {
                const open = this.items.get(String(p.itemId ?? ""));
                const changes = open?.changes ?? [];
                if (!changes.length && typeof p.grantRoot === "string") {
                    const a = await this.host.permission({ toolName: "Edit", input: { file_path: join(p.grantRoot, "*") }, title: `Write access to ${p.grantRoot}`, reason: p.reason ?? undefined });
                    return { decision: this.decision(a, p.availableDecisions) };
                }
                const first = changes[0];
                const name = changes.length && changes.every((c) => c.kind === "add") ? "Write" : "Edit";
                const others = changes.slice(1).map((c) => c.path);
                const a = await this.host.permission({
                    toolName: name,
                    input: { file_path: first?.path ?? "" },
                    title: open?.title,
                    reason: [typeof p.reason === "string" ? p.reason : "", others.length ? `This change also touches ${others.join(", ")}.` : ""].filter(Boolean).join(" ") || undefined,
                    preview: first ? changePreview(first, this.t.cwd) : undefined,
                    otherPaths: others,
                });
                return { decision: this.decision(a, p.availableDecisions) };
            }
            case "item/permissions/requestApproval": {
                const a = await this.host.permission({ toolName: "Codex permissions", input: { permissions: p.permissions ?? {} }, title: "Codex asks for more permissions", reason: [p.reason, JSON.stringify(p.permissions ?? {})].filter(Boolean).join(" ") });
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
     * tools). Refused by a rule, or with the user saying what to do instead:
     * decline, so the turn goes on (with their words), where Codex offers
     * that; where it doesn't (untrusted mode), cancel, and the user's words
     * start the next turn.
     */
    private decision(a: PermissionAnswer, available?: unknown): string {
        if (a.allow) return "accept";
        this.refusal = a.message;
        if (a.stop) return "cancel";
        const canDecline = !Array.isArray(available) || available.includes("decline");
        if (canDecline) {
            if (a.fromUser) this.steer(a.message);
            return "decline";
        }
        if (a.fromUser) this.followUp = a.message;
        return "cancel";
    }

    /** Add the user's words to the running turn (turn/steer); if that fails, they start the next turn. */
    private steer(text: string) {
        if (!this.threadId || !this.turnId) {
            this.followUp = text;
            return;
        }
        void this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input: this.input(text, []) }).catch(() => (this.followUp = text));
    }
}

/** The command a commandExecution runs, without Codex's `bash -lc '…'` wrapper. */
function innerCommand(x: any): string {
    const actions: any[] = Array.isArray(x?.commandActions) ? x.commandActions : [];
    if (actions.length === 1 && typeof actions[0]?.command === "string") return actions[0].command;
    const cmd = String(x?.command ?? "");
    const m = cmd.match(/^(?:\S*\/)?(?:ba|z)?sh -l?c '([\s\S]*)'$/);
    return m ? m[1]!.replace(/'\\''/g, "'") : cmd;
}

function fileChanges(item: any): { path: string; kind: string; diff: string }[] {
    const changes: any[] = Array.isArray(item?.changes) ? item.changes : [];
    return changes.map((c) => ({ path: String(c?.path ?? ""), kind: String(c?.kind?.type ?? "update"), diff: String(c?.diff ?? "") }));
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
