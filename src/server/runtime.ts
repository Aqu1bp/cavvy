// One live session in the GUI server: the agent, its tools and permissions,
// and the session's timeline, kept up to date from the agent's events and
// sent to every GUI window that has the session open. The terminal app does
// the same work in ui/app.ts; this is its counterpart without a terminal.

import { existsSync, readFileSync } from "fs";
import { basename, join } from "path";
import { Agent, type AgentEvent, type PermissionRequest, type PermissionResponse, type TurnEndReason } from "../agent/agent";
import { canonical, FileHistory, resetToolState, rewindTargets } from "../agent/checkpoints";
import { fireHooks, type HookEvent } from "../agent/hooks";
import { Session } from "../agent/session";
import { buildSystemPrompt } from "../agent/system-prompt";
import { INIT_PROMPT, reviewPrompt } from "../commands/index";
import { expandCommand } from "../commands/custom";
import { addPermissionRule, updateSettings, type Effort, type Settings } from "../config/settings";
import type { PermissionMode } from "../permissions/modes";
import { PermissionChecker } from "../permissions/checker";
import { AutoClassifier } from "../permissions/classifier";
import { toolPath } from "../permissions/rules";
import { BUILTIN_TOOLS } from "../tools/index";
import { childEnv, killAllShells, runShell } from "../tools/bash";
import type { Tool, ToolResult, ToolState } from "../tools/types";
import { availableSearchBackend, formatHits, searchWeb } from "../tools/web-tools";
import { clientFor, defaultModelFrom, lookupModel, resolveModelInfo, smallModelFor } from "../providers/models";
import { costOf } from "../providers/pricing";
import { getProvider, resolveBaseUrl } from "../providers/registry";
import { modelRef, parseModelRef, textOf, toolCallsOf, type ImagePart, type ModelInfo, type ProviderClient, type ToolCallPart } from "../providers/types";
import { expandMentions } from "../ui/mentions";
import { notifyAfterMs } from "../ui/notify";
import { displayPath } from "../util/files";
import { gitSnapshot } from "../util/git";
import { redact } from "../util/redact";
import { fileDiff, textOf as bufText, trimInput } from "./diffs";
import { promptText, readSegments, replay, resultPatch, toolBlockFromCall, UiLog, type ToolMeta } from "./history";
import type {
    Block,
    ChangesInfo,
    EffortLevel,
    Interaction,
    InteractionResponse,
    ModelSummary,
    PermissionInteraction,
    RewindPlanInfo,
    RewindTargetInfo,
    SessionOp,
    SessionSnapshot,
    SessionState,
    SubagentInfo,
    ToolBlock,
    ToolCategoryId,
    Turn,
    TurnStatus,
} from "./protocol";
import { applyOp, coalesce, findBlock, findTurn, type SessionView } from "./timeline";
import type { Engine, Workspace } from "./engine";

/** How often streamed output goes out to the GUI. */
const FLUSH_MS = 24;

interface Pending {
    interaction: Interaction;
    resolve: (r: InteractionResponse | undefined) => void;
}

interface Queued {
    text: string;
    images?: ImagePart[];
}

export function modelSummary(m: ModelInfo): ModelSummary {
    const p = getProvider(m.provider);
    return {
        ref: modelRef(m),
        provider: m.provider,
        providerName: p?.name,
        id: m.id,
        name: m.name ?? m.id,
        contextWindow: m.contextWindow,
        maxOutput: m.maxOutput,
        pricing: m.pricing,
        pricingEstimated: m.pricingEstimated,
        supportsImages: m.supportsImages,
        supportsReasoning: m.supportsReasoning,
        effortLevels: m.effortLevels,
        deprecated: m.deprecated,
    };
}

export class Runtime {
    readonly session: Session;
    readonly toolState: ToolState;
    readonly checker: PermissionChecker;
    readonly classifier: AutoClassifier;
    agent?: Agent;
    model?: ModelInfo;
    client?: ProviderClient;
    mode: PermissionMode;
    effort?: Effort;
    busy = false;
    lastActive = Date.now();
    /** Ready once a model has been chosen (or none could be). */
    ready: Promise<void>;

    private view: SessionView;
    private batch = 0;
    private outbox: SessionOp[] = [];
    private flushTimer?: ReturnType<typeof setTimeout>;
    private abort?: AbortController;
    private queued: Queued[] = [];
    private pending = new Map<string, Pending>();
    private ui: UiLog;
    /** Compactions so far: the transcript segment new prompts belong to. */
    private segment = 0;
    private ids = 0;
    private titleAsked = false;
    private shellTimer?: ReturnType<typeof setInterval>;
    private switching?: Promise<unknown>;

    // What the current turn is building
    private turnId?: string;
    private turnStartedAt = 0;
    private openText?: string;
    private openThinking?: string;
    /** Blocks from the model response being streamed (dropped if it's retried). */
    private responseBlocks: string[] = [];
    /** Tool call id -> the turn its block is in. */
    private toolTurn = new Map<string, string>();
    private subs = new Map<string, SubagentInfo>();

    constructor(
        private engine: Engine,
        readonly ws: Workspace,
        session: Session,
        opts: { mode?: PermissionMode; resumed: boolean },
    ) {
        this.session = session;
        this.mode = opts.mode ?? ws.settings.permissions?.defaultMode ?? "default";
        if (this.mode === "bypassPermissions" && !this.bypassAllowed()) this.mode = "default";
        this.toolState = { cwd: ws.cwd, projectRoot: ws.cwd, fileState: new Map(), todos: [], shells: new Map() };
        this.checker = new PermissionChecker(() => this.settings(), ws.cwd);
        this.classifier = new AutoClassifier(undefined);
        this.ui = new UiLog(session.path, session.meta.id, opts.resumed);
        if (opts.resumed) resetToolState(this.toolState, session.messages);

        const segments = opts.resumed ? readSegments(session.path) : [{ messages: [] }];
        this.segment = segments.length - 1;
        const turns = opts.resumed ? replay({ segments, current: session.messages, ui: this.ui, meta: (c) => this.toolMeta(c), newId: () => this.newId() }) : [];
        this.view = { state: this.initialState(), turns };
        this.ready = this.track(this.initModel());
        void this.hook("SessionStart", { source: opts.resumed ? "resume" : "startup" });
    }

    get id(): string {
        return this.session.meta.id;
    }

    get status(): SessionState["status"] {
        return this.view.state.status;
    }

    get title(): string | undefined {
        return this.view.state.title;
    }

    /** The first prompt, for sessions without a title. */
    firstPrompt(): string | undefined {
        return this.view.turns.find((t) => t.prompt)?.prompt?.text;
    }

    private newId(): string {
        return `b${(++this.ids).toString(36)}`;
    }

    settings(): Settings {
        const s = this.ws.settings;
        return this.effort ? { ...s, effort: this.effort } : s;
    }

    bypassAllowed(): boolean {
        return this.engine.bypassAllowed(this.ws.cwd);
    }

    private initialState(): SessionState {
        const branch = gitSnapshot(this.ws.cwd)?.branch;
        return {
            id: this.id,
            cwd: this.ws.cwd,
            projectName: basename(this.ws.cwd) || this.ws.cwd,
            title: this.session.title,
            createdAt: this.session.meta.createdAt,
            persisted: existsSync(this.session.path),
            trusted: this.ws.trusted,
            branch,
            mode: this.mode,
            bypassAllowed: this.bypassAllowed(),
            effort: this.settings().effort,
            status: "idle",
            busy: false,
            contextTokens: 0,
            cost: this.session.cost,
            ...this.tokenTotals(),
            todos: this.toolState.todos.map((t) => ({ ...t })),
            queued: [],
            interactions: [],
            mcp: this.ws.mcpStatus(),
            filesChanged: this.filesChanged(),
            shells: [],
        };
    }

    private tokenTotals() {
        let tokensIn = 0;
        let tokensOut = 0;
        for (const { usage } of this.session.usageByModel.values()) {
            tokensIn += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
            tokensOut += usage.outputTokens;
        }
        return { tokensIn, tokensOut };
    }

    private filesChanged(): number {
        try {
            return FileHistory.for(this.session)?.originals().length ?? 0;
        } catch {
            return 0;
        }
    }

    // -----------------------------------------------------------------------
    // Sending ops

    snapshot(): SessionSnapshot {
        this.flush();
        return { state: structuredClone(this.view.state), turns: structuredClone(this.view.turns), seq: this.batch };
    }

    private op(o: SessionOp) {
        applyOp(this.view, structuredClone(o));
        this.outbox.push(o);
        if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
    }

    private setState(patch: Partial<SessionState>) {
        this.op({ op: "state", patch });
    }

    flush() {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
        if (!this.outbox.length) return;
        const ops = coalesce(this.outbox);
        this.outbox = [];
        this.batch++;
        this.engine.sendOps(this.id, this.batch, ops);
    }

    private setStatus(status: SessionState["status"]) {
        if (this.view.state.status === status) return;
        this.setState({ status });
        this.engine.sessionChanged(this);
    }

    private activity(label: string, detail?: string) {
        const cur = this.view.state.activity;
        if (cur?.label === label && cur.detail === detail) return;
        this.setState({ activity: { label, since: cur?.label === label ? cur.since : Date.now(), detail } });
    }

    // -----------------------------------------------------------------------
    // Model

    private track<T>(p: Promise<T>): Promise<T> {
        const t = p.finally(() => {
            if (this.switching === t) this.switching = undefined;
        });
        this.switching = t;
        return t;
    }

    private async initModel() {
        const candidates = [this.session.model, this.ws.settings.model ?? this.engine.fallbackModel].filter((r): r is string => Boolean(r && parseModelRef(r)));
        for (const ref of new Set(candidates)) {
            if (await this.setModel(ref, { quiet: true })) {
                if (this.session.model && ref !== this.session.model) this.notice(`This session used ${this.session.model}, which isn't available now; using ${ref}.`, "warn");
                return;
            }
        }
        let listings = this.engine.listings;
        let pick = defaultModelFrom(listings);
        if (!pick) {
            listings = await this.engine.refreshListings();
            pick = defaultModelFrom(listings);
        }
        if (pick && (await this.setModel(modelRef(pick), { quiet: true }))) return;
        this.setState({ model: undefined });
    }

    /** Switch models. Returns false when the provider can't be used. */
    async setModel(ref: string, opts: { quiet?: boolean; persist?: boolean } = {}): Promise<boolean> {
        const parsed = parseModelRef(ref);
        const def = parsed && getProvider(parsed.provider);
        if (!parsed || !def) {
            if (!opts.quiet) this.notice(`Unknown model "${ref}"`, "error");
            return false;
        }
        let client: ProviderClient;
        try {
            client = await clientFor(parsed.provider);
        } catch (e) {
            if (!opts.quiet) this.notice(redact((e as Error).message), "error");
            return false;
        }
        let info = this.engine.listings.find((l) => l.provider.id === parsed.provider)?.models.find((m) => m.id === parsed.id) ?? resolveModelInfo(ref);
        if (!info) return false;
        if (!info.contextWindow && def.kind !== "anthropic") info = (await lookupModel(ref).catch(() => undefined)) ?? info;
        const prev = this.model;
        this.model = info;
        this.client = client;
        this.classifier.setComplete((system, prompt, signal, o) => this.complete(system, prompt, signal, o));
        if (!this.agent) this.makeAgent();
        else {
            this.agent.setModel(info, client);
            this.agent.options.nativeWebSearch = this.nativeSearch();
            if (prev && modelRef(prev) !== ref) this.agent.addReminder(`The user switched the model to ${info.name ?? info.id} (${ref}). You are now running as this model.`);
        }
        if (opts.persist) {
            try {
                updateSettings("user", this.ws.cwd, (s) => (s.model = ref));
                this.engine.reloadSettings();
            } catch (e) {
                this.notice(`Switched for this session only. ${redact((e as Error).message)}`, "warn");
            }
        }
        this.setState({ model: modelSummary(info), effort: this.settings().effort });
        return true;
    }

    /** The model's details arrived (listings refreshed). */
    refreshModelInfo() {
        if (!this.model) return;
        const m = this.engine.listings.find((l) => l.provider.id === this.model!.provider)?.models.find((x) => x.id === this.model!.id);
        if (!m) return;
        this.model = m;
        if (this.agent) this.agent.model = m;
        this.setState({ model: modelSummary(m) });
    }

    /** A provider's key changed: rebuild the client, or deselect the model when the key is gone. */
    async keyChanged(providerId: string) {
        if (this.model?.provider !== providerId) {
            if (!this.model) await this.track(this.initModel());
            return;
        }
        try {
            this.client = await clientFor(providerId);
            this.agent?.setModel(this.model, this.client);
        } catch {
            this.model = undefined;
            this.client = undefined;
            this.agent = undefined;
            this.setState({ model: undefined });
            await this.track(this.initModel());
        }
    }

    private nativeSearch(): boolean {
        if (!this.model) return false;
        const def = getProvider(this.model.provider);
        const pref = this.settings().webSearch ?? "auto";
        return def?.kind === "anthropic" && /^https:\/\/api\.anthropic\.com$/.test(resolveBaseUrl(def)) && (pref === "auto" || pref === "anthropic");
    }

    /** One-shot completion on a cheap model (reviewer, titles, page summaries), or the session's own with `main`. */
    async complete(system: string, prompt: string, signal?: AbortSignal, opts?: { main?: boolean }): Promise<string> {
        let model = this.model!;
        let client = this.client!;
        const smallRef = this.settings().smallModel;
        if (opts?.main) {
            // the session's own model
        } else if (smallRef) {
            const p = parseModelRef(smallRef);
            if (p) {
                try {
                    client = await clientFor(p.provider);
                    model = resolveModelInfo(smallRef) ?? model;
                } catch {
                    // the main model it is
                }
            }
        } else {
            const small = smallModelFor(model.provider, this.engine.listings);
            if (small) model = small;
        }
        const res = await client.stream(
            { model, system, messages: [{ role: "user", content: [{ type: "text", text: redact(prompt) }] }], tools: [], maxTokens: 2048, effort: "low", lightweight: true, signal },
            () => {},
        );
        if (res.usage) {
            this.session.recordUsage(modelRef(model), res.usage, costOf(res.usage, model).usd);
            this.setState({ cost: this.session.cost, ...this.tokenTotals() });
        }
        return textOf(res);
    }

    tools(): Tool<any>[] {
        const native = this.nativeSearch();
        const off = this.settings().webSearch === "off";
        return [...BUILTIN_TOOLS.filter((t) => !(t.name === "WebSearch" && (native || off))), ...this.ws.mcp.tools()];
    }

    private toolMeta(call: ToolCallPart): ToolMeta {
        const tool = BUILTIN_TOOLS.find((t) => t.name === call.name) ?? this.ws.mcp.tools().find((t) => t.name === call.name);
        let title = call.name;
        try {
            if (tool) title = tool.title(call.input ?? {});
        } catch {
            // the bare name
        }
        return { title, category: (tool?.category ?? (call.name.startsWith("mcp__") ? "mcp" : undefined)) as ToolCategoryId | undefined };
    }

    private makeAgent() {
        if (!this.model || !this.client) return;
        this.agent = new Agent({
            session: this.session,
            model: this.model,
            client: this.client,
            settings: () => this.settings(),
            checker: this.checker,
            classifier: this.classifier,
            tools: () => this.tools(),
            mode: { get: () => this.mode, set: (m) => this.setMode(m, { fromAgent: true }) },
            toolState: this.toolState,
            nativeWebSearch: this.nativeSearch(),
            host: {
                emit: (e) => this.onEvent(e),
                askPermission: (req) => this.askPermission(req),
                saveRules: (rules, scope) => {
                    try {
                        for (const r of rules) addPermissionRule(scope, this.ws.cwd, "allow", r);
                    } catch (e) {
                        this.notice(`Allowed for this session only; the rule wasn't saved. ${redact((e as Error).message)}`, "warn");
                    }
                    this.ws.reload();
                },
                ui: {
                    askQuestion: (q, options, multi) => this.askQuestion(q, options, multi),
                    approvePlan: (plan) => this.approvePlan(plan),
                },
                drainQueued: () => this.drainQueued(),
            },
            helpers: {
                complete: (s, p, sig) => this.complete(s, p, sig),
                webSearch: async (query, signal) => {
                    const backend = await availableSearchBackend(this.settings().webSearch);
                    if (!backend) throw new Error("Web search is turned off (settings.webSearch = off)");
                    return formatHits(query, await searchWeb(query, backend, signal));
                },
                resolveModel: async (ref) => {
                    const p = parseModelRef(ref);
                    if (!p) return undefined;
                    try {
                        const client = await clientFor(p.provider);
                        const model = resolveModelInfo(ref);
                        return model ? { model, client } : undefined;
                    } catch {
                        return undefined;
                    }
                },
            },
        });
        if (this.session.model === undefined && this.model) this.session.setModel(modelRef(this.model));
    }

    // -----------------------------------------------------------------------
    // Modes and settings

    /** Returns false when the change was refused. */
    setMode(m: PermissionMode, opts: { fromAgent?: boolean } = {}): boolean {
        if (m === "bypassPermissions" && this.mode !== m && !this.bypassAllowed()) {
            this.notice("Bypass mode is off. Start the GUI with --dangerously-skip-permissions, or set permissions.allowBypass in your user settings, to enable it.", "error");
            return false;
        }
        const from = this.mode;
        this.mode = m;
        if (!opts.fromAgent && this.agent) this.agent.noteModeChange(from, m);
        this.setState({ mode: m, bypassAllowed: this.bypassAllowed() });
        return true;
    }

    setEffort(e: EffortLevel) {
        this.effort = e;
        this.setState({ effort: e });
    }

    rename(title: string) {
        const t = title.replace(/\s+/g, " ").trim().slice(0, 120);
        if (!t) return;
        this.session.setTitle(t);
        this.setState({ title: t });
        this.engine.sessionChanged(this);
    }

    workspaceChanged() {
        this.setState({ mcp: this.ws.mcpStatus(), bypassAllowed: this.bypassAllowed() });
    }

    // -----------------------------------------------------------------------
    // Timeline building

    private notice(text: string, level: "info" | "warn" | "error" = "info") {
        const turn = this.currentTurn();
        this.closeOpen();
        this.op({ op: "block", turnId: turn.id, block: { t: "notice", id: this.newId(), level, text: redact(text) } });
    }

    /** The turn output goes to: the running one, or a new one without a prompt. */
    private currentTurn(): Turn {
        const t = this.turnId ? findTurn(this.view, this.turnId) : undefined;
        if (t) return t;
        const last = this.view.turns[this.view.turns.length - 1];
        if (last && !last.prompt && !last.archived) return last;
        const turn: Turn = { id: this.newId(), blocks: [], status: "done", startedAt: Date.now() };
        this.op({ op: "turn", turn });
        return findTurn(this.view, turn.id)!;
    }

    private addBlock(block: Block): string {
        const turn = this.currentTurn();
        this.op({ op: "block", turnId: turn.id, block });
        return turn.id;
    }

    private patchBlock(blockId: string, patch: Partial<Block>, turnId = this.toolTurn.get(blockId) ?? this.turnId) {
        if (turnId) this.op({ op: "block.patch", turnId, blockId, patch });
    }

    private blockIn(turnId: string | undefined, id: string): Block | undefined {
        const t = turnId ? findTurn(this.view, turnId) : undefined;
        return t ? findBlock(t, id) : undefined;
    }

    /** Ends the text or thinking block being streamed. */
    private closeOpen() {
        if (this.openThinking) {
            const b = this.blockIn(this.turnId, this.openThinking);
            if (b?.t === "thinking" && b.startedAt) this.patchBlock(b.id, { durationMs: Date.now() - b.startedAt });
        }
        this.openText = undefined;
        this.openThinking = undefined;
    }

    private onEvent(e: AgentEvent) {
        this.lastActive = Date.now();
        switch (e.type) {
            case "request_start":
                this.closeOpen();
                this.responseBlocks = [];
                this.activity("Thinking");
                break;
            case "text": {
                if (!this.openText) {
                    this.closeOpen();
                    const id = this.newId();
                    this.addBlock({ t: "text", id, text: "" });
                    this.openText = id;
                    this.responseBlocks.push(id);
                    this.activity("Writing");
                }
                this.op({ op: "append", turnId: this.turnId ?? this.currentTurn().id, blockId: this.openText, field: "text", text: redact(e.text) });
                break;
            }
            case "thinking": {
                if (!this.openThinking) {
                    this.closeOpen();
                    const id = this.newId();
                    this.addBlock({ t: "thinking", id, text: "", startedAt: Date.now() });
                    this.openThinking = id;
                    this.responseBlocks.push(id);
                    this.activity("Thinking");
                }
                this.op({ op: "append", turnId: this.turnId ?? this.currentTurn().id, blockId: this.openThinking, field: "text", text: redact(e.text) });
                break;
            }
            case "tool_call_start": {
                this.closeOpen();
                const meta = this.toolMeta({ type: "tool_call", id: e.id, name: e.name, input: {} });
                const turnId = this.addBlock({ t: "tool", id: e.id, name: e.name, title: e.name, category: meta.category, status: "streaming", receiving: 0 });
                this.toolTurn.set(e.id, turnId);
                this.responseBlocks.push(e.id);
                this.activity(`Writing ${e.name}`);
                break;
            }
            case "tool_call_delta": {
                const b = this.blockIn(this.toolTurn.get(e.id), e.id);
                if (b?.t === "tool") this.patchBlock(e.id, { receiving: (b.receiving ?? 0) + e.partial.length });
                break;
            }
            case "server_tool": {
                this.closeOpen();
                if (e.name === "web_search") {
                    const id = this.newId();
                    this.addBlock({ t: "tool", id, name: "WebSearch", title: `Web search${e.detail ? `: ${e.detail}` : ""}`, category: "network", status: "ok", summary: "Searched the web" });
                } else if (e.name === "web_search_result") {
                    const turn = this.currentTurn();
                    const last = [...turn.blocks].reverse().find((b) => b.t === "tool" && b.name === "WebSearch");
                    if (last) this.patchBlock(last.id, { output: redact(e.detail).slice(0, 4000) }, turn.id);
                }
                break;
            }
            case "assistant":
                this.finishResponse(e.message);
                break;
            case "tool_start": {
                const turnId = this.toolTurn.get(e.call.id);
                const patch: Partial<ToolBlock> = {
                    title: e.title,
                    category: e.tool?.category as ToolCategoryId | undefined,
                    input: trimInput(e.call.input),
                    status: "running",
                    startedAt: Date.now(),
                    receiving: undefined,
                };
                if (turnId && this.blockIn(turnId, e.call.id)) this.patchBlock(e.call.id, patch, turnId);
                else {
                    const b = toolBlockFromCall(e.call, this.toolMeta(e.call));
                    this.toolTurn.set(e.call.id, this.addBlock({ ...b, ...patch } as ToolBlock));
                }
                this.activity(e.title);
                break;
            }
            case "tool_progress": {
                const turnId = this.toolTurn.get(e.id);
                if (turnId) this.op({ op: "append", turnId, blockId: e.id, field: "progress", text: redact(e.text) });
                break;
            }
            case "tool_approved":
                this.patchBlock(e.id, { approval: e.reason, sandboxed: e.sandboxed });
                break;
            case "tool_end":
                this.toolEnded(e.call, e.result, e.durationMs);
                break;
            case "notice":
                this.notice(e.message, e.level);
                break;
            case "retry": {
                // The partial response is thrown away and asked for again.
                const turnId = this.turnId;
                if (turnId) for (const id of this.responseBlocks) this.op({ op: "block.remove", turnId, blockId: id });
                this.responseBlocks = [];
                this.openText = this.openThinking = undefined;
                this.activity(`Retrying in ${Math.ceil(e.delayMs / 1000)}s`, `${e.reason.slice(0, 160)} (attempt ${e.attempt})`);
                break;
            }
            case "usage":
                this.setState({ contextTokens: e.contextTokens, cost: this.session.cost, ...this.tokenTotals() });
                break;
            case "compact_start":
                this.activity("Compacting conversation");
                break;
            case "compact_end":
                this.compacted(e.summary);
                break;
            case "subagent":
                this.subagentEvent(e.parentId, e.label, e.event);
                break;
            case "turn_end":
                this.closeOpen();
                this.endTurn(e.reason);
                break;
        }
    }

    /** The finished model response: its text is the redacted copy the session stored. */
    private finishResponse(msg: { content: { type: string; text?: string }[] }) {
        this.closeOpen();
        const turnId = this.turnId;
        if (!turnId) return;
        const texts = msg.content.filter((p) => p.type === "text").map((p) => p.text ?? "");
        const streamed = this.responseBlocks.map((id) => this.blockIn(turnId, id)).filter((b): b is Block => b?.t === "text");
        streamed.forEach((b, i) => {
            const text = i === streamed.length - 1 ? texts.slice(i).join("") : texts[i];
            if (text === undefined || !text.trim()) this.op({ op: "block.remove", turnId, blockId: b.id });
            else if (b.t === "text" && b.text !== text) this.patchBlock(b.id, { text }, turnId);
        });
        // Text the provider didn't stream (some send it all at the end).
        if (!streamed.length) for (const t of texts) if (t.trim()) this.addBlock({ t: "text", id: this.newId(), text: t });
        for (const id of this.responseBlocks) {
            const b = this.blockIn(turnId, id);
            if (b?.t === "thinking" && !b.text.trim()) this.op({ op: "block.remove", turnId, blockId: id });
        }
        this.responseBlocks = [];
    }

    private toolEnded(call: ToolCallPart, result: ToolResult, durationMs: number) {
        const turnId = this.toolTurn.get(call.id);
        if (!turnId || !this.blockIn(turnId, call.id)) {
            const b = toolBlockFromCall(call, this.toolMeta(call));
            this.toolTurn.set(call.id, this.addBlock(b));
        }
        const d = result.display;
        const shown = d?.body !== undefined ? d.body : result.content;
        const patch: Partial<ToolBlock> = { ...resultPatch(redact(shown || (result.isError ? result.content : "")), result.isError), durationMs, progress: undefined };
        if (/^The user declined/.test(result.content)) patch.status = "denied";
        if (d?.summary) patch.summary = d.summary;
        if (result.images?.length) patch.images = result.images.length;
        // A new file (Write says "Wrote", an Edit with an empty old_string "Created"): no "before" side.
        if (d?.diff) patch.diff = fileDiff(d.diff.path, d.diff.before === "" && /^(Created|Wrote)\b/.test(d.summary ?? "") ? null : d.diff.before, d.diff.after);
        this.patchBlock(call.id, patch, this.toolTurn.get(call.id));
        const b = this.blockIn(this.toolTurn.get(call.id), call.id) as ToolBlock | undefined;
        this.ui.write({ t: "tool", id: call.id, summary: patch.summary, diff: patch.diff, durationMs, approval: b?.approval, sandboxed: b?.sandboxed, images: patch.images, at: Date.now() });
        if (call.name === "TodoWrite") this.setState({ todos: this.toolState.todos.map((t) => ({ ...t })) });
        if (patch.diff || b?.category === "edit") this.setState({ filesChanged: this.filesChanged() });
        this.syncShells();
    }

    private compacted(summary: string) {
        this.segment++;
        const current = this.turnId;
        // Everything before is out of the model's context now (and out of /rewind's reach).
        for (const t of this.view.turns) {
            if (t.id === current) {
                if (t.prompt?.index !== undefined) this.op({ op: "turn.patch", turnId: t.id, patch: { prompt: { ...t.prompt, index: undefined } } });
                continue;
            }
            if (!t.archived) this.op({ op: "turn.patch", turnId: t.id, patch: { archived: true, prompt: t.prompt ? { ...t.prompt, index: undefined } : undefined } });
        }
        if (current) this.addBlock({ t: "compact", id: this.newId(), summary: redact(summary), auto: true });
        else {
            const turn: Turn = { id: this.newId(), blocks: [{ t: "compact", id: this.newId(), summary: redact(summary), auto: false }], status: "done", startedAt: Date.now() };
            this.op({ op: "turn", turn });
        }
        this.setState({ contextTokens: 0 });
    }

    private subagentEvent(parentId: string, label: string, e: AgentEvent) {
        const turnId = this.toolTurn.get(parentId);
        if (!turnId) return;
        let sub = this.subs.get(parentId);
        if (!sub) this.subs.set(parentId, (sub = { label, tools: [], toolCount: 0, tokens: 0, startedAt: Date.now() }));
        let changed = false;
        if (e.type === "tool_start") {
            sub.toolCount++;
            sub.tools.push({ t: "tool", id: e.call.id, name: e.call.name, title: e.title, category: e.tool?.category as ToolCategoryId | undefined, status: "running", startedAt: Date.now() });
            if (sub.tools.length > 6) sub.tools.shift();
            changed = true;
        } else if (e.type === "tool_end") {
            const t = sub.tools.find((x) => x.id === e.call.id);
            if (t) {
                t.status = /^The user declined/.test(e.result.content) ? "denied" : e.result.isError ? "error" : "ok";
                t.summary = e.result.display?.summary;
                t.durationMs = e.durationMs;
                changed = true;
            }
        } else if (e.type === "usage") {
            sub.tokens += e.usage.inputTokens + e.usage.outputTokens + (e.usage.cacheReadTokens ?? 0);
            changed = true;
        }
        if (changed) this.patchBlock(parentId, { sub: structuredClone(sub) }, turnId);
    }

    private endTurn(reason: TurnEndReason) {
        const turnId = this.turnId;
        if (!turnId) return;
        const turn = findTurn(this.view, turnId);
        // Tool calls that never finished (interrupted, or not run after a denial).
        for (const b of turn?.blocks ?? []) {
            if (b.t === "tool" && (b.status === "running" || b.status === "streaming" || b.status === "awaiting")) {
                this.patchBlock(b.id, { status: reason === "aborted" ? "error" : "error", summary: reason === "aborted" ? "Interrupted" : "Not run", progress: undefined, receiving: undefined }, turnId);
            }
        }
        const status: TurnStatus = reason;
        const end = Date.now();
        this.op({ op: "turn.patch", turnId, patch: { status, endedAt: end } });
        const index = turn?.prompt?.index;
        if (index !== undefined) this.ui.write({ t: "turn", seg: this.segment, index, at: turn!.startedAt ?? end, end, status });
    }

    // -----------------------------------------------------------------------
    // Interactions

    private interact(interaction: Interaction): Promise<InteractionResponse | undefined> {
        return new Promise((resolve) => {
            this.pending.set(interaction.id, { interaction, resolve });
            this.setState({ interactions: [...this.pendingList()] });
            this.setStatus("waiting");
            const kind = interaction.kind;
            this.engine.notify(this, kind, kind === "permission" ? `Wants to ${interaction.heading.toLowerCase()}` : kind === "question" ? interaction.question : "Plan ready for your review");
        });
    }

    private pendingList(): Interaction[] {
        return [...this.pending.values()].map((p) => p.interaction);
    }

    respond(interactionId: string, r: InteractionResponse) {
        const p = this.pending.get(interactionId);
        if (!p) throw new Error("That request was already answered or has expired.");
        if (p.interaction.kind !== r.kind) throw new Error("The answer doesn't match the request.");
        this.settle(interactionId, r);
    }

    private settle(id: string, r: InteractionResponse | undefined) {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        this.setState({ interactions: this.pendingList() });
        if (!this.pending.size) this.setStatus(this.busy ? "running" : "idle");
        p.resolve(r);
    }

    private cancelInteractions() {
        for (const id of [...this.pending.keys()]) this.settle(id, undefined);
    }

    private async askPermission(req: PermissionRequest): Promise<PermissionResponse> {
        const { tool, input, decision } = req;
        const suggestions = decision.suggestions ?? [];
        const projectName = basename(this.ws.cwd);
        const it: PermissionInteraction = {
            kind: "permission",
            id: this.newId(),
            toolId: req.callId,
            toolName: tool.name,
            category: tool.category as ToolCategoryId,
            title: req.title,
            heading: "Use a tool",
            options: [{ id: "yes", label: "Allow once" }],
            dangerous: decision.dangerous,
            reason: decision.reason ? redact(decision.reason) : undefined,
            classifierReason: req.classifierReason ? redact(req.classifierReason) : undefined,
            agentLabel: req.agentLabel,
        };
        if (req.preview?.summary) it.summary = redact(req.preview.summary);
        if (tool.name === "Bash") {
            it.heading = "Run a shell command";
            it.command = redact(String(input.command ?? ""));
            if (input.description) it.description = redact(String(input.description));
            if (decision.sandbox && Array.isArray(input.allowedHosts)) it.hosts = input.allowedHosts.map(String);
            if (!decision.dangerous && suggestions.length) {
                const label = suggestions.map((s) => s.replace(/^Bash\((.*?)(:\*)?\)$/, "$1")).join(", ");
                it.options.push({ id: "always", label: `Always allow \`${label}\` in ${projectName}` });
            }
        } else if (tool.category === "edit") {
            const p = toolPath(tool.name, input) ?? "";
            const abs = p.startsWith("/") ? p : join(this.toolState.cwd, p);
            const exists = existsSync(abs);
            it.heading = tool.name === "Write" ? (exists ? "Overwrite a file" : "Create a file") : tool.name === "NotebookEdit" ? "Edit a notebook" : "Edit a file";
            it.path = displayPath(abs, this.ws.cwd);
            const diff = req.preview?.diff;
            if (diff) it.diff = fileDiff(it.path, diff.before === "" && !exists ? null : redact(diff.before), redact(diff.after));
            if (decision.offerAcceptEdits) it.options.push({ id: "session-edits", label: "Allow all edits this session" });
            else if (suggestions.length) it.options.push({ id: "always", label: `Allow edits in ${suggestions[0]!.replace(/^Edit\(\/?(.*?)\/\*\*\)$/, "$1")} this session` });
        } else if (tool.category === "read") {
            it.heading = "Read outside the workspace";
            it.path = toolPath(tool.name, input) ?? "";
            if (suggestions.length) it.options.push({ id: "always", label: `Allow reading ${suggestions[0]!.replace(/^Read\(\/?(.*?)\/\*\*\)$/, "$1")} this session` });
        } else if (tool.name === "WebFetch") {
            it.heading = "Fetch a web page";
            it.url = String(input.url ?? "");
            if (input.prompt) it.description = redact(String(input.prompt).slice(0, 300));
            if (suggestions.length) it.options.push({ id: "always", label: `Always allow ${suggestions[0]!.replace(/^WebFetch\(domain:(.*)\)$/, "$1")}` });
        } else if (tool.category === "mcp") {
            it.heading = "Use an MCP tool";
            it.json = redact(JSON.stringify(input, null, 2)).slice(0, 6000);
            if (suggestions.length) it.options.push({ id: "always", label: `Always allow ${tool.name} in ${projectName}` });
        }
        it.options.push({ id: "no", label: "Deny" });
        if (req.callId && this.blockIn(this.toolTurn.get(req.callId), req.callId)) this.patchBlock(req.callId, { status: "awaiting" });
        const answer = await this.interact(it);
        const choice = answer?.kind === "permission" ? answer.choice : "no";
        if (req.callId && this.blockIn(this.toolTurn.get(req.callId), req.callId)) this.patchBlock(req.callId, { status: choice === "no" ? "denied" : "running" });
        switch (choice) {
            case "yes":
                return { allow: true };
            case "always":
                return { allow: true, rules: suggestions, scope: tool.category === "read" || tool.category === "edit" ? "session" : "local" };
            case "session-edits":
                return { allow: true, setMode: "acceptEdits" };
            default: {
                const feedback = answer?.kind === "permission" ? answer.feedback?.trim() : undefined;
                return { allow: false, feedback: feedback || undefined };
            }
        }
    }

    private runningTool(name: string): string | undefined {
        const turn = this.turnId ? findTurn(this.view, this.turnId) : undefined;
        return [...(turn?.blocks ?? [])].reverse().find((b) => b.t === "tool" && b.name === name && b.status === "running")?.id;
    }

    private async askQuestion(question: string, options: { label: string; description?: string }[], multi: boolean): Promise<string[] | undefined> {
        const toolId = this.runningTool("AskUserQuestion");
        if (toolId) this.patchBlock(toolId, { status: "awaiting" });
        const r = await this.interact({ kind: "question", id: this.newId(), toolId, question: redact(question), options: options.map((o) => ({ label: redact(o.label), description: o.description && redact(o.description) })), multi });
        if (toolId) this.patchBlock(toolId, { status: "running" });
        return r?.kind === "question" && r.answers?.length ? r.answers : undefined;
    }

    private async approvePlan(plan: string): Promise<{ approved: boolean; mode?: PermissionMode; feedback?: string }> {
        const toolId = this.runningTool("ExitPlanMode");
        if (toolId) this.patchBlock(toolId, { status: "awaiting" });
        const r = await this.interact({ kind: "plan", id: this.newId(), toolId, plan: redact(plan) });
        if (toolId) this.patchBlock(toolId, { status: "running" });
        if (r?.kind !== "plan") return { approved: false };
        return { approved: r.approved, mode: r.mode, feedback: r.feedback };
    }

    // -----------------------------------------------------------------------
    // Prompts

    private drainQueued(): string[] {
        // Messages with images wait for their own turn.
        const take = this.queued.filter((q) => !q.images?.length && !q.text.startsWith("/") && !q.text.startsWith("!"));
        if (!take.length) return [];
        this.queued = this.queued.filter((q) => !take.includes(q));
        this.setState({ queued: this.queued.map((q) => q.text) });
        const texts = take.map((q) => q.text);
        // After tool calls they ride along with the results; otherwise they're a prompt of their own.
        const last = this.session.messages[this.session.messages.length - 1];
        const steering = last?.role === "assistant" && toolCallsOf(last).length > 0;
        this.closeOpen();
        const prev = this.turnId;
        if (prev) this.op({ op: "turn.patch", turnId: prev, patch: { status: "done", endedAt: Date.now() } });
        const turn: Turn = { id: this.newId(), prompt: { text: texts.join("\n\n"), ...(steering ? {} : { index: this.session.messages.length }) }, blocks: [], status: "running", startedAt: Date.now() };
        this.op({ op: "turn", turn });
        this.turnId = turn.id;
        if (!steering) this.ui.write({ t: "turn", seg: this.segment, index: this.session.messages.length, at: turn.startedAt! });
        return texts;
    }

    /** A message from the GUI: a prompt, a slash command, or `!command`. Queued while busy. */
    async send(text: string, images?: ImagePart[]): Promise<{ queued: boolean }> {
        if (this.switching) await this.switching.catch(() => undefined);
        const trimmed = text.trim();
        if (!trimmed && !images?.length) return { queued: false };
        if (this.busy) {
            this.queued.push({ text, images });
            this.setState({ queued: this.queued.map((q) => q.text) });
            return { queued: true };
        }
        void this.dispatch(text, images).catch((e) => this.notice(redact((e as Error).message), "error"));
        return { queued: false };
    }

    private async dispatch(text: string, images?: ImagePart[]) {
        const trimmed = text.trim();
        if (trimmed.startsWith("!") && !images?.length) return this.runUserShell(trimmed.slice(1).trim());
        if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
            const [, name = "", args = ""] = trimmed.match(/^\/(\S+)\s*([\s\S]*)$/) ?? [];
            const cmd = name.toLowerCase();
            if (cmd === "compact") return void (await this.compact(args.trim() || undefined));
            if (cmd === "init") return this.startTurn(INIT_PROMPT, { display: "/init", kind: "command" });
            if (cmd === "review") return this.startTurn(reviewPrompt(args.trim()), { display: `/review${args.trim() ? ` ${args.trim()}` : ""}`, kind: "command" });
            const custom = this.ws.commands.find((c) => c.name === cmd);
            if (custom) return this.startTurn(expandCommand(custom.body, args.trim()), { display: trimmed, kind: "command" });
        }
        return this.startTurn(text, { images });
    }

    async startTurn(text: string, opts: { display?: string; kind?: "prompt" | "command"; images?: ImagePart[] } = {}) {
        if (!this.agent) {
            await this.ready.catch(() => undefined);
            if (!this.agent) {
                this.notice("No model is selected. Add an API key in Settings → Providers, then pick a model.", "error");
                return;
            }
        }
        const agent = this.agent;
        this.busy = true;
        const ac = (this.abort = new AbortController());
        this.turnStartedAt = Date.now();
        const display = opts.display ?? text;
        const index = this.session.messages.length;
        const turn: Turn = {
            id: this.newId(),
            prompt: { text: display, ...(opts.images?.length ? { images: opts.images.length } : {}), ...(opts.kind === "command" ? { command: true } : {}), index },
            blocks: [],
            status: "running",
            startedAt: this.turnStartedAt,
        };
        this.op({ op: "turn", turn });
        this.turnId = turn.id;
        this.responseBlocks = [];
        this.ui.write({ t: "turn", seg: this.segment, index, at: this.turnStartedAt });
        this.setState({ busy: true, status: "running", activity: { label: "Thinking", since: this.turnStartedAt } });
        this.engine.sessionChanged(this);
        if (!this.session.title && !this.titleAsked) void this.generateTitle(display);

        let reason: TurnEndReason | undefined;
        try {
            if (!this.session.meta.system) await this.freezeSystemPrompt(ac.signal);
            if (ac.signal.aborted) {
                this.engine.draft(this, display);
                reason = "aborted";
                this.endTurn("aborted");
            } else {
                const roots = [this.ws.cwd, ...(this.settings().permissions?.additionalDirectories ?? [])];
                const { parts, attached } = expandMentions(text, this.toolState, roots);
                if (attached.length) this.notice(`Attached ${attached.join(", ")}`);
                if (opts.images?.length) {
                    if (this.model?.supportsImages === false) this.notice(`${this.model.name ?? this.model.id} may not accept images.`, "warn");
                    parts.push(...opts.images);
                }
                reason = await agent.run(parts, { signal: ac.signal, display, kind: opts.kind });
            }
        } catch (e) {
            this.notice(`Unexpected error: ${redact((e as Error).message)}`, "error");
            reason = "error";
            this.endTurn("error");
        } finally {
            this.busy = false;
            this.abort = undefined;
            this.cancelInteractions();
            this.closeOpen();
            this.turnId = undefined;
            this.setState({ busy: false, activity: undefined, persisted: existsSync(this.session.path), todos: this.toolState.todos.map((t) => ({ ...t })) });
            this.setStatus(reason === "error" ? "error" : "idle");
            this.flush();
            this.engine.sessionChanged(this);
        }
        const elapsed = Date.now() - this.turnStartedAt;
        if (reason && reason !== "aborted" && (reason === "error" || elapsed >= notifyAfterMs(this.settings()))) {
            this.engine.notify(this, reason === "error" ? "error" : "done", reason === "error" ? "Stopped with an error" : `Finished in ${Math.round(elapsed / 1000)}s`);
        }
        if (ac.signal.aborted) return this.returnQueued();
        const next = this.queued.shift();
        if (next) {
            this.setState({ queued: this.queued.map((q) => q.text) });
            await this.dispatch(next.text, next.images).catch((e) => this.notice(redact((e as Error).message), "error"));
        }
    }

    /** After an interrupt, unsent messages go back to the input box instead of running. */
    private returnQueued() {
        if (!this.queued.length) return;
        this.engine.draft(this, this.queued.map((q) => q.text).join("\n\n"));
        this.queued = [];
        this.setState({ queued: [] });
    }

    dequeue(index: number) {
        if (index < 0 || index >= this.queued.length) return;
        this.queued.splice(index, 1);
        this.setState({ queued: this.queued.map((q) => q.text) });
    }

    interrupt() {
        this.cancelInteractions();
        if (this.abort) {
            this.abort.abort();
            this.activity("Interrupting");
        } else this.returnQueued();
    }

    private async freezeSystemPrompt(signal: AbortSignal) {
        // Give MCP servers a moment so their instructions make it into the prompt.
        const connecting = () => [...this.ws.mcp.servers.values()].some((s) => s.status === "connecting" || s.status === "pending");
        if (connecting()) {
            this.activity("Connecting MCP servers");
            const until = Date.now() + 5000;
            while (connecting() && Date.now() < until && !signal.aborted) await new Promise((r) => setTimeout(r, 100));
        }
        this.session.setSystem(buildSystemPrompt({ cwd: this.ws.cwd, model: this.model!, append: this.ws.mcp.instructions() || undefined }));
    }

    private async generateTitle(prompt: string) {
        this.titleAsked = true;
        if (!this.client || prompt.trim().length < 3) return;
        try {
            const raw = await this.complete(
                "You name coding-assistant sessions for a sidebar. Reply with only the title: 2 to 6 words, sentence case, no quotes, no trailing punctuation. Describe the task, not the user.",
                prompt.slice(0, 3000),
                AbortSignal.timeout(20_000),
            );
            const title = raw
                .replace(/<[^>]*>/g, "")
                .split("\n")
                .map((l) => l.trim())
                .find(Boolean)
                ?.replace(/^title:\s*/i, "")
                .replace(/^["'`*#\s]+|["'`*.\s]+$/g, "")
                .slice(0, 60);
            if (title && !this.session.title) this.rename(title);
        } catch {
            // the first prompt names it instead
        }
    }

    /** `!command` from the input box: the user runs it themselves; the model sees it with the next prompt. */
    private async runUserShell(command: string) {
        if (!command) return;
        this.busy = true;
        const ac = (this.abort = new AbortController());
        const turn: Turn = { id: this.newId(), prompt: { text: `!${command}` }, blocks: [], status: "running", startedAt: Date.now() };
        this.op({ op: "turn", turn });
        this.turnId = turn.id;
        const blockId = this.newId();
        this.op({ op: "block", turnId: turn.id, block: { t: "shell", id: blockId, command, output: "", running: true } });
        this.setState({ busy: true, status: "running", activity: { label: "Running", since: Date.now(), detail: command.slice(0, 80) } });
        let status: TurnStatus = "done";
        try {
            const res = await runShell({
                command,
                cwd: this.toolState.cwd,
                timeoutMs: 120_000,
                signal: ac.signal,
                env: childEnv(this.settings().env),
                onData: (chunk) => this.op({ op: "append", turnId: turn.id, blockId, field: "output", text: redact(chunk) }),
            });
            const out = redact(res.output.replace(/\s+$/, ""));
            this.op({ op: "block.patch", turnId: turn.id, blockId, patch: { output: out.slice(-24_000) || "(no output)", exitCode: res.exitCode, running: false } });
            if (res.newCwd) this.toolState.cwd = res.newCwd;
            if (res.aborted) status = "aborted";
            const text = `<bash-input>${command}</bash-input>\n<bash-stdout>${out.slice(0, 20_000)}</bash-stdout>${res.exitCode ? `\n<bash-exit-code>${res.exitCode}</bash-exit-code>` : ""}`;
            this.agent?.addReminder(`The user ran a shell command themselves (output shown to them):\n${text}`);
        } catch (e) {
            status = "error";
            this.op({ op: "block.patch", turnId: turn.id, blockId, patch: { output: redact((e as Error).message), running: false, exitCode: null } });
        } finally {
            this.op({ op: "turn.patch", turnId: turn.id, patch: { status, endedAt: Date.now() } });
            this.busy = false;
            this.abort = undefined;
            this.turnId = undefined;
            this.setState({ busy: false, activity: undefined });
            this.setStatus("idle");
            this.flush();
        }
        const next = this.queued.shift();
        if (next) {
            this.setState({ queued: this.queued.map((q) => q.text) });
            await this.dispatch(next.text, next.images).catch((e) => this.notice(redact((e as Error).message), "error"));
        }
    }

    async compact(instructions?: string) {
        if (this.busy) throw new Error("Wait for the current response to finish, or interrupt it first.");
        if (!this.agent) throw new Error("No model is selected.");
        if (this.session.messages.length < 2) throw new Error("Nothing to compact yet.");
        this.busy = true;
        const ac = (this.abort = new AbortController());
        this.setState({ busy: true, status: "running", activity: { label: "Compacting conversation", since: Date.now() } });
        try {
            await this.agent.compact({ auto: false, signal: ac.signal, instructions });
        } catch (e) {
            if (!ac.signal.aborted) this.notice(`Compaction failed: ${redact((e as Error).message)}`, "error");
        } finally {
            this.busy = false;
            this.abort = undefined;
            this.setState({ busy: false, activity: undefined });
            this.setStatus("idle");
        }
    }

    // -----------------------------------------------------------------------
    // Rewind and changes

    rewindTargets(): RewindTargetInfo[] {
        const history = FileHistory.for(this.session);
        return rewindTargets(this.session.messages)
            .reverse()
            .map((t) => ({ index: t.index, text: t.text, tracked: Boolean(history && t.checkpoint !== undefined), files: history && t.checkpoint !== undefined ? history.filesIn(t.checkpoint).length : 0 }));
    }

    private target(index: number) {
        const t = rewindTargets(this.session.messages).find((x) => x.index === index);
        if (!t) throw new Error("That prompt can't be rewound to (it may have been compacted).");
        return t;
    }

    rewindPlan(index: number): RewindPlanInfo {
        const t = this.target(index);
        const history = FileHistory.for(this.session);
        const plan = history && t.checkpoint !== undefined ? history.plan(t.checkpoint) : undefined;
        const root = canonical(this.ws.cwd);
        const rel = (p: string) => displayPath(p, root);
        return {
            index,
            tracked: Boolean(plan),
            restore: (plan ?? []).filter((i) => i.action !== "skip").map((i) => ({ path: rel(i.path), action: i.action as "write" | "delete", outside: Boolean(i.outside) })),
            skipped: (plan ?? []).filter((i) => i.action === "skip").map((i) => ({ path: rel(i.path), reason: i.reason ?? "" })),
        };
    }

    rewind(index: number, code: boolean, conversation: boolean): { restored: string[]; failed: { path: string; error: string }[]; text: string } {
        if (this.busy) throw new Error("Wait for the current response to finish, or interrupt it first.");
        const t = this.target(index);
        const history = FileHistory.for(this.session);
        const plan = history && t.checkpoint !== undefined ? history.plan(t.checkpoint) : undefined;
        const restore = plan?.filter((i) => i.action !== "skip") ?? [];
        const skipped = plan?.filter((i) => i.action === "skip") ?? [];
        const root = canonical(this.ws.cwd);
        const rel = (p: string) => displayPath(p, root);
        let restored: string[] = [];
        let failed: { path: string; error: string }[] = [];
        let rewindConversation = conversation;
        if (code && restore.length) {
            const r = history!.restore(restore);
            restored = r.done.map(rel);
            failed = r.failed.map((f) => ({ path: rel(f.path), error: f.error }));
            const done = new Set(r.done);
            for (const p of [...this.toolState.fileState.keys()]) if (done.has(canonical(p))) this.toolState.fileState.delete(p);
            if (conversation && failed.length) rewindConversation = false;
            if (!rewindConversation && r.done.length) this.agent?.addReminder(`The user restored these files to how they were before an earlier prompt (/rewind), undoing the changes made to them since. Read them again before editing them:\n${restored.map((p) => `- ${p}`).join("\n")}`);
        }
        if (rewindConversation) {
            if (this.agent) this.agent.rewind(index);
            else {
                this.session.rewind(index);
                resetToolState(this.toolState, this.session.messages);
                this.classifier.clearCache();
            }
            const kept = [...(code ? [] : restore), ...skipped];
            if (kept.length) this.agent?.addReminder(`The user rewound the conversation to an earlier point (/rewind), but these files weren't restored and still have changes made after that point:\n${kept.map((it) => `- ${rel(it.path)}`).join("\n")}`);
            this.rebuild();
        }
        this.setState({ filesChanged: this.filesChanged(), todos: this.toolState.todos.map((x) => ({ ...x })), contextTokens: 0 });
        this.flush();
        this.engine.sessionChanged(this);
        return { restored, failed, text: t.text };
    }

    /** The timeline again from the transcript (after a rewind). */
    private rebuild() {
        const segments = readSegments(this.session.path);
        const turns = replay({ segments: segments.length ? segments : [{ messages: [] }], current: this.session.messages, ui: this.ui, meta: (c) => this.toolMeta(c), newId: () => this.newId() });
        this.op({ op: "reset", turns });
    }

    changes(): ChangesInfo {
        const history = FileHistory.for(this.session);
        if (!history) return { files: [], added: 0, removed: 0, tracked: false };
        const root = canonical(this.ws.cwd);
        const files = [];
        let added = 0;
        let removed = 0;
        for (const o of history.originals()) {
            const rel = displayPath(o.path, root);
            if (o.skipped) {
                files.push({ path: rel, status: "modified" as const, added: 0, removed: 0, hunks: [], note: `No saved copy (${o.skipped})` });
                continue;
            }
            const beforeBuf = o.hash ? history.savedCopy(o.hash) : null;
            if (o.hash && !beforeBuf) {
                files.push({ path: rel, status: "modified" as const, added: 0, removed: 0, hunks: [], note: "The saved copy is missing" });
                continue;
            }
            let afterBuf: Buffer | null = null;
            try {
                afterBuf = existsSync(o.path) ? readFileSync(o.path) : null;
            } catch {
                afterBuf = null;
            }
            if (beforeBuf === null && afterBuf === null) continue;
            if (beforeBuf && afterBuf && beforeBuf.equals(afterBuf)) continue;
            const before = beforeBuf === null ? null : bufText(beforeBuf);
            const after = afterBuf === null ? null : bufText(afterBuf);
            if (before === undefined || after === undefined) {
                files.push({ path: rel, status: beforeBuf === null ? ("added" as const) : afterBuf === null ? ("deleted" as const) : ("modified" as const), added: 0, removed: 0, hunks: [], note: "Binary file" });
                continue;
            }
            const d = fileDiff(rel, before === null ? null : redact(before), after === null ? null : redact(after));
            added += d.added;
            removed += d.removed;
            files.push(d);
        }
        files.sort((a, b) => a.path.localeCompare(b.path));
        return { files, added, removed, tracked: true };
    }

    toolOutput(toolId: string): string {
        for (const m of this.session.messages) {
            if (m.role !== "user") continue;
            for (const p of m.content) if (p.type === "tool_result" && p.toolCallId === toolId) return redact(p.content);
        }
        throw new Error("That output is no longer in the conversation.");
    }

    exportMarkdown(): string {
        const out: string[] = [`# ${this.session.title ?? "Session"} (${this.id})`, "", `- Directory: ${this.ws.cwd}`, `- Model: ${this.session.model ?? "?"}`, `- Exported: ${new Date().toISOString()}`, ""];
        for (const msg of this.session.messages) {
            if (msg.role === "user") {
                const kind = msg.meta?.kind ?? "prompt";
                if (kind === "tool_results") {
                    for (const p of msg.content) if (p.type === "tool_result") out.push(`<details><summary>Result: ${p.toolName}${p.isError ? " (error)" : ""}</summary>`, "", "```", p.content.slice(0, 4000), "```", "</details>", "");
                    continue;
                }
                const t = promptText(msg);
                if (t) out.push(kind === "summary" ? "## Summary of earlier conversation" : "## User", "", t, "");
            } else {
                const t = textOf(msg).trim();
                if (t) out.push("## Assistant", "", t, "");
                for (const p of msg.content) if (p.type === "tool_call") out.push(`**${p.name}** \`${JSON.stringify(p.input).slice(0, 300)}\``, "");
            }
        }
        return redact(out.join("\n"));
    }

    // -----------------------------------------------------------------------
    // Background shells

    private syncShells() {
        const shells = [...this.toolState.shells.values()].map((s) => ({ id: s.id, command: redact(s.command).slice(0, 300), running: s.exitCode === null, exitCode: s.exitCode, startedAt: s.startedAt }));
        const same = JSON.stringify(shells) === JSON.stringify(this.view.state.shells);
        if (!same) this.setState({ shells });
        const running = shells.some((s) => s.running);
        if (running && !this.shellTimer) this.shellTimer = setInterval(() => this.syncShells(), 2000);
        else if (!running && this.shellTimer) {
            clearInterval(this.shellTimer);
            this.shellTimer = undefined;
        }
    }

    async killShell(shellId: string) {
        const sh = this.toolState.shells.get(shellId);
        if (!sh) throw new Error(`No background shell ${shellId}`);
        await sh.kill();
        this.syncShells();
    }

    // -----------------------------------------------------------------------

    private hook(event: HookEvent, payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
        return fireHooks(this.settings(), event, { session_id: this.id, ...payload }, this.toolState.cwd, (msg) => this.notice(msg, "warn"), signal);
    }

    /** SessionEnd hooks and background shells, when the server stops. */
    async close() {
        this.abort?.abort();
        this.cancelInteractions();
        if (this.shellTimer) clearInterval(this.shellTimer);
        this.flush();
        await Promise.all([this.hook("SessionEnd", { reason: "exit" }, AbortSignal.timeout(5000)), killAllShells({ state: this.toolState })]);
    }
}
