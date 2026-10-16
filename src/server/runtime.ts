// One live session in the GUI server: the agent, its tools and permissions,
// and the session's timeline, kept up to date from the agent's events and
// sent to every GUI window that has the session open. The terminal app does
// the same work in ui/app.ts; this is its counterpart without a terminal.

import { existsSync, readFileSync } from "fs";
import { basename, join } from "path";
import { Agent, type AgentEvent, type PermissionRequest, type PermissionResponse, type TurnEndReason } from "../agent/agent";
import { backendsIn, canonical, FileHistory, resetToolState, rewindTargets, untrackedChangesNote, type RestoreItem } from "../agent/checkpoints";
import { fireHooks, type HookEvent } from "../agent/hooks";
import { Session } from "../agent/session";
import { buildSystemPrompt } from "../agent/system-prompt";
import { INIT_PROMPT, reviewPrompt } from "../commands/index";
import { expandCommand } from "../commands/custom";
import { addPermissionRule, updateSettings, EFFORT_LEVELS, type Effort, type Settings } from "../config/settings";
import { PERMISSION_MODES, type PermissionMode } from "../permissions/modes";
import { PermissionChecker } from "../permissions/checker";
import { AutoClassifier, REVIEW_REQUEST, reviewText, type ReviewStage } from "../permissions/classifier";
import { toolPath } from "../permissions/rules";
import { BUILTIN_TOOLS } from "../tools/index";
import { childEnv, killAllShells, runShell } from "../tools/bash";
import type { Tool, ToolResult, ToolState } from "../tools/types";
import { availableSearchBackend, formatHits, searchWeb } from "../tools/web-tools";
import { clientFor, defaultModelFrom, lookupModel, resolveModelInfo, reviewTarget, smallModelFor } from "../providers/models";
import { costOf } from "../providers/pricing";
import { isAgentBackend } from "../backends/types";
import { getProvider, resolveBaseUrl } from "../providers/registry";
import { attachmentsNote, readsPdf } from "../providers/files";
import { modelRef, parseModelRef, textOf, toolCallsOf, type AttachedPart, type Message, type ModelInfo, type ProviderClient, type ToolCallPart } from "../providers/types";
import { expandMentions } from "../ui/mentions";
import { notifyAfterMs } from "../ui/notify";
import { displayPath } from "../util/files";
import { gitSnapshot } from "../util/git";
import { redact, lineRedactor } from "../util/redact";
import { attachedLabel, attachedPrompt, toWire } from "./attachments";
import { RpcError } from "./rpc-error";
import { fileDiff, textOf as bufText, trimInput } from "./diffs";
import { gitChanges } from "./git-changes";
import { AGENT_KEPT, agentFromCall, agentHead, agentStep, agentsFromTurns, cutOffPrompt, INTERRUPTED, runsAgent, promptKey, promptText, readSegments, replay, resultPatch, shownStep, toolBlockFromCall, UiLog, withoutActionsNote, type AgentHead, type ToolMeta } from "./history";
import type {
    AgentRun,
    Block,
    ChangesInfo,
    GitChangesInfo,
    GitScope,
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
    WireFile,
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
    id: number;
    text: string;
    attachments?: AttachedPart[];
}

/** A session title as it's stored: one line, 120 characters at most ("" if there's nothing left). */
export function cleanTitle(title: string): string {
    return title.replace(/\s+/g, " ").trim().slice(0, 120);
}

/** A first message that's only a greeting, a thanks, a yes or a test: nothing to name a session after. */
const SMALL_TALK = /^(h(i+|ello|ey+|iya|owdy)|yo|sup|hola|greetings|good (morning|afternoon|evening|day)|thanks?( you)?( so much| a lot)?|thx|ty|ok(ay)?|k|cool|nice|great|yes|no|yep|nope|sure|test(ing)?|ping|hm+|\?+)(\s+(there|all|everyone|again|claude|harness|buddy|friend|mate))?[\s!.?,:)(]*$/i;

/** Whether a prompt says enough to name the session after (a later one is tried if not). */
export function titleWorthy(prompt: string): boolean {
    const t = prompt.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    return t.replace(/[^\p{L}\p{N}]/gu, "").length >= 3 && !SMALL_TALK.test(t);
}

/** Title requests per session, failures included: a model that can't give one isn't asked forever. */
const TITLE_TRIES = 3;

/**
 * A title made from the prompt itself, for when no model gives one: its
 * first line that says something, cut at a word to 60 characters.
 */
export function promptTitle(prompt: string): string | undefined {
    const line = prompt
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
        .split("\n")
        .map((l) => l.replace(/^[\s#>*-]+/, "").replace(/\s+/g, " ").trim())
        .find((l) => /[\p{L}\p{N}]/u.test(l));
    if (!line) return undefined;
    let t = line;
    if (t.length > 60) {
        const cut = t.slice(0, 60);
        const space = cut.lastIndexOf(" ");
        t = `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
    } else t = t.replace(/[\s.]+$/, "");
    // A plain first word starts it in capitals, as a model's title would; not a path or a name like `src/x`.
    return /^\p{Ll}[\p{L}']*(?=[\s,:;!?]|$)/u.test(t) ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/** How long closing waits for a turn to stop on its own before noting the interrupt for it (changeable for tests). */
export const closeTiming = { turnMs: 3000 };

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
        supportsPdf: readsPdf(m),
        supportsReasoning: m.supportsReasoning,
        effortLevels: m.effortLevels,
        supportsFastMode: m.supportsFastMode,
        deprecated: m.deprecated,
    };
}

export class Runtime {
    readonly session: Session;
    readonly toolState: ToolState;
    readonly checker: PermissionChecker;
    readonly classifier: AutoClassifier;
    /** The reviewModel the reviewer's verdicts came from. */
    private reviewer: string | undefined;
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
    private queueSeq = 0;
    private pending = new Map<string, Pending>();
    private ui: UiLog;
    /** Compactions so far: the transcript segment new prompts belong to. */
    private segment = 0;
    private ids = 0;
    /** A title request is running or got one; cleared when it failed, so a later prompt tries again. */
    private titleAsked = false;
    private titleTries = 0;
    /** The first prompt a title was asked about: the one to name the session after when no model will. */
    private titleFrom?: string;
    private shellTimer?: ReturnType<typeof setInterval>;
    private switching?: Promise<unknown>;
    /** Being closed: it starts nothing more and sends nothing more (the session may be open again by then). */
    private closed = false;
    /** The rewind last shown: restoring does what it showed, or nothing if the conversation moved on. */
    private rewindShown?: { id: string; index: number; message: Message; count: number; plan?: RestoreItem[] };

    // What the current turn is building
    private turnId?: string;
    private turnStartedAt = 0;
    /** Settles when the running turn has ended (and written how). */
    private turnDone?: Promise<void>;
    private openText?: string;
    private openThinking?: string;
    /** Blocks from the model response being streamed (dropped if it's retried). */
    private responseBlocks: string[] = [];
    /** Tool call id -> the turn its block is in. */
    private toolTurn = new Map<string, string>();
    private subs = new Map<string, SubagentInfo>();
    /** Each sub-agent's label (how its permission prompts name it) and its open text block while it writes. */
    private agentLabels = new Map<string, string>();
    private agentText = new Map<string, string>();
    /** Turns Claude Code or Codex answered, and the transcript segment each is in: the log keeps their steps and sub-agents (the transcript only their text). */
    private backendTurns = new Map<string, number>();
    /** Where in the log each such turn's steps go: its prompt's place, and which prompt it is. */
    private stepsAt = new Map<string, { seg: number; index: number; prompt: string }>();
    /** Their steps changed since they were written (turn id → block ids), and what was written of each (its JSON). */
    private stepsDirty = new Map<string, Set<string>>();
    private stepsLogged = new Map<string, Map<string, string>>();
    /** Their sub-agents, likewise ("" for the sub-agent itself), and what was written of each field and step. */
    private agentsDirty = new Map<string, Set<string>>();
    private agentsLogged = new Map<string, { head: Map<string, string>; blocks: Map<string, string> }>();
    /** The log's record of the turn running now (where it started): its end goes there, a steering message's turn's too. */
    private uiTurn?: { seg: number; index: number; at: number; prompt?: string };
    /** The mode it was left in, when that isn't the one it reopened in (bypass, not chosen again): the model is told. */
    private leftIn?: PermissionMode;

    constructor(
        private engine: Engine,
        readonly ws: Workspace,
        session: Session,
        opts: { mode?: PermissionMode; resumed: boolean },
    ) {
        this.session = session;
        // Capture new-session defaults so changing Home settings cannot change an open chat’s speed.
        // A chat from before speeds were saved keeps it in memory: opening one doesn't write to it.
        if (session.fastMode === undefined) {
            if (opts.resumed) session.fastMode = Boolean(ws.settings.fastMode);
            else session.setFastMode(Boolean(ws.settings.fastMode));
        }
        this.ui = new UiLog(session.path, session.meta.id, opts.resumed);
        // A reopened session keeps the mode it was left in (bypass only when chosen again) and the effort chosen for it.
        const left = opts.resumed && this.ui.state.mode && PERMISSION_MODES.includes(this.ui.state.mode) ? this.ui.state.mode : undefined;
        this.mode = (left !== "bypassPermissions" ? left : undefined) ?? opts.mode ?? ws.settings.permissions?.defaultMode ?? "default";
        if (this.mode === "bypassPermissions" && !this.bypassAllowed()) this.mode = "default";
        if (left && left !== this.mode) this.leftIn = left;
        const effort = opts.resumed ? this.ui.state.effort : undefined;
        if (effort && EFFORT_LEVELS.includes(effort)) this.effort = effort;
        this.toolState = { cwd: ws.cwd, projectRoot: ws.cwd, fileState: new Map(), todos: [], shells: new Map() };
        this.checker = new PermissionChecker(() => this.settings(), ws.cwd);
        this.classifier = new AutoClassifier(undefined);
        this.reviewer = ws.settings.reviewModel;
        if (opts.resumed) resetToolState(this.toolState, session.messages);

        const segments = opts.resumed ? readSegments(session.path) : [{ messages: [] }];
        this.segment = segments.length - 1;
        // Its last turn was cut off (the server stopped or died before it could end): the history says so now, as a stop would have.
        if (opts.resumed && cutOffPrompt(this.ui, this.segment, session.messages, session.notices) !== undefined) session.push({ role: "user", content: [{ type: "text", text: INTERRUPTED }], meta: { kind: "interrupt" } });
        const turns = opts.resumed ? replay({ segments, current: session.messages, currentNotices: session.notices, ui: this.ui, meta: (c) => this.toolMeta(c), newId: () => this.newId() }) : [];
        this.view = { state: this.initialState(), turns, agents: agentsFromTurns(turns, session.model, this.ui.agents) };
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
            fastMode: this.fastModeEnabled(),
            status: "idle",
            busy: false,
            contextTokens: this.lastContext(),
            cost: this.session.cost,
            costUnknown: this.session.costUnknown,
            ...this.tokenTotals(),
            todos: this.toolState.todos.map((t) => ({ ...t })),
            queued: [],
            queueIds: [],
            queuedAttached: [],
            interactions: [],
            mcp: this.ws.mcpStatus(),
            filesChanged: this.filesChanged(),
            shells: [],
        };
    }

    /** Claude Code or Codex: an agent backend runs this session's turns. */
    private backendModel(): boolean {
        return getProvider(this.model?.provider ?? "")?.kind === "agent";
    }

    /** How full the context was when the session was left, if nothing has happened to it since (in a terminal, say). */
    private lastContext(): number {
        const s = this.ui.state;
        return s.contextTokens !== undefined && s.messages === this.session.messages.length ? s.contextTokens : 0;
    }

    /** The log's note of the mode, effort and context, for opening the session again. Not before the session is on disk: a new one may never be. */
    private recordState(opts: { force?: boolean } = {}) {
        if (!opts.force && !existsSync(this.session.path)) return;
        const s = this.ui.state;
        const state = { mode: this.mode, effort: this.effort, contextTokens: this.view.state.contextTokens, messages: this.session.messages.length };
        if (s.mode === state.mode && s.effort === state.effort && s.contextTokens === state.contextTokens && s.messages === state.messages) return;
        this.ui.write({ t: "state", ...state });
    }

    // What the log keeps of turns Claude Code or Codex answered, as they're
    // shown: each step and each sub-agent's, written when it's new or has
    // changed (at most once a flush), so a turn cut off part way keeps what
    // it did. What's still being written (text streaming in, a call's input)
    // waits until it's done, or the turn or session ends.

    /** Which prompt the running turn's record is of, once it's in the history: one sent at its place later isn't taken for it. */
    private notePrompt() {
        const t = this.uiTurn;
        const m = t && !t.prompt ? this.session.messages[t.index] : undefined;
        if (!t || m?.role !== "user") return;
        t.prompt = promptKey(m);
        this.ui.write({ t: "turn", ...t });
    }

    /** A view change to note for the log, if it's of such a turn or sub-agent. */
    private noteStep(o: SessionOp) {
        const mark = (dirty: Map<string, Set<string>>, key: string, id: string) => {
            let ids = dirty.get(key);
            if (!ids) dirty.set(key, (ids = new Set()));
            ids.add(id);
        };
        const ofBackend = (agentId: string) => {
            const a = this.view.agents.find((x) => x.id === agentId);
            return Boolean(a && this.backendTurns.has(a.turnId));
        };
        switch (o.op) {
            // (A block inside another, a sub-agent's call in its row, changes that one.)
            case "block":
                if (this.backendTurns.has(o.turnId)) mark(this.stepsDirty, o.turnId, o.parent ?? o.block.id);
                break;
            case "block.patch":
                if (this.backendTurns.has(o.turnId)) mark(this.stepsDirty, o.turnId, o.parent ?? o.blockId);
                break;
            case "block.remove":
            case "append":
                if (this.backendTurns.has(o.turnId)) mark(this.stepsDirty, o.turnId, o.blockId);
                break;
            case "agent":
                if (!this.backendTurns.has(o.agent.turnId)) break;
                mark(this.agentsDirty, o.agent.id, "");
                for (const b of o.agent.blocks) mark(this.agentsDirty, o.agent.id, b.id);
                break;
            case "agent.patch":
                if (ofBackend(o.id)) mark(this.agentsDirty, o.id, "");
                break;
            case "agent.block":
                if (ofBackend(o.id)) mark(this.agentsDirty, o.id, o.block.id);
                break;
            case "agent.block.patch":
            case "agent.append":
                if (ofBackend(o.id)) mark(this.agentsDirty, o.id, o.blockId);
                break;
        }
    }

    /** What changed since into the log; `all`: what's still being written too (the turn or the session is ending). */
    private syncSteps(all = false) {
        for (const turnId of [...this.stepsDirty.keys()]) this.syncTurn(turnId, all);
        for (const id of [...this.agentsDirty.keys()]) this.syncAgent(id, all);
    }

    /** Where a backend's turn's steps go in the log; none until its prompt is in the history. */
    private stepsPlace(turnId: string, turn: Turn): { seg: number; index: number; prompt: string } | undefined {
        const known = this.stepsAt.get(turnId);
        if (known) return known;
        const seg = this.backendTurns.get(turnId);
        const index = turn.prompt?.index;
        // Its prompt, unless the history was compacted since (it's out of reach of rewind then, and has no index).
        const prompt = seg === this.segment && index !== undefined ? this.session.messages[index] : undefined;
        if (seg === undefined || index === undefined || prompt?.role !== "user") return undefined;
        const at = { seg, index, prompt: promptKey(prompt) };
        this.stepsAt.set(turnId, at);
        return at;
    }

    private syncTurn(turnId: string, all = false) {
        const ids = this.stepsDirty.get(turnId);
        if (!ids) return;
        const turn = findTurn(this.view, turnId);
        // Gone (rebuilt after a rewind): nothing of it to write.
        if (!turn) return void this.stepsDirty.delete(turnId);
        const at = this.stepsPlace(turnId, turn);
        if (!at) {
            if (all) this.stepsDirty.delete(turnId);
            return;
        }
        let logged = this.stepsLogged.get(turnId);
        if (!logged) this.stepsLogged.set(turnId, (logged = new Map()));
        for (const id of [...ids]) {
            const i = turn.blocks.findIndex((b) => b.id === id);
            const b = turn.blocks[i];
            if (b && !all && (b.id === this.openText || b.id === this.openThinking || (b.t === "tool" && b.status === "streaming"))) continue;
            ids.delete(id);
            if (!b) {
                if (logged.delete(id)) this.ui.write({ t: "step", ...at, drop: id });
                continue;
            }
            const step = shownStep(b);
            const json = step && JSON.stringify(step);
            if (!step || logged.get(id) === json) continue;
            logged.set(id, json!);
            let after: string | null = null;
            for (let j = i - 1; j >= 0; j--) {
                if (shownStep(turn.blocks[j]!)) {
                    after = turn.blocks[j]!.id;
                    break;
                }
            }
            this.ui.write({ t: "step", ...at, block: step, after });
        }
        if (!ids.size) this.stepsDirty.delete(turnId);
    }

    private syncAgent(id: string, all = false) {
        const ids = this.agentsDirty.get(id);
        if (!ids) return;
        const a = this.view.agents.find((x) => x.id === id);
        if (!a) {
            this.agentsDirty.delete(id);
            this.agentsLogged.delete(id);
            return;
        }
        let logged = this.agentsLogged.get(id);
        if (!logged) this.agentsLogged.set(id, (logged = { head: new Map(), blocks: new Map() }));
        if (ids.delete("")) {
            const head = agentHead(a);
            const patch: AgentHead = {};
            for (const [k, v] of Object.entries(head)) {
                const json = JSON.stringify(v);
                if (json !== undefined && logged.head.get(k) !== json) {
                    logged.head.set(k, json);
                    (patch as Record<string, unknown>)[k] = v;
                }
            }
            // What it no longer has (a report, once it runs again).
            for (const k of [...logged.head.keys()]) {
                if ((head as Record<string, unknown>)[k] !== undefined) continue;
                logged.head.delete(k);
                (patch as Record<string, unknown>)[k] = null;
            }
            if (Object.keys(patch).length) this.ui.write({ t: "agent", id, head: patch });
        }
        // The log keeps its latest AGENT_KEPT steps: an older one changing (a long call ending) isn't written.
        const kept = a.blocks.length - AGENT_KEPT;
        for (const bid of [...ids]) {
            const i = a.blocks.findIndex((b) => b.id === bid);
            const b = a.blocks[i];
            if (b && !all && (this.agentText.get(id) === bid || (b.t === "tool" && b.status === "streaming"))) continue;
            ids.delete(bid);
            if (!b || i < kept) continue;
            const step = agentStep(b);
            const json = JSON.stringify(step);
            if (logged.blocks.get(bid) === json) continue;
            logged.blocks.set(bid, json);
            this.ui.write({ t: "agent", id, block: step, after: a.blocks[i - 1]?.id ?? null });
        }
        // What was written of steps the log no longer keeps needn't be remembered.
        if (logged.blocks.size > AGENT_KEPT) {
            const tail = new Set(a.blocks.slice(-AGENT_KEPT).map((b) => b.id));
            for (const bid of [...logged.blocks.keys()]) if (!tail.has(bid)) logged.blocks.delete(bid);
        }
        if (!ids.size) this.agentsDirty.delete(id);
    }

    /** A backend's turn is over (or is being cut off): all of it into the log, its sub-agents too, as they are now. */
    private syncTurnAll(turnId: string) {
        this.syncTurn(turnId, true);
        for (const a of this.view.agents) if (a.turnId === turnId) this.syncAgent(a.id, true);
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
        return { state: structuredClone(this.view.state), turns: structuredClone(this.view.turns), agents: structuredClone(this.view.agents), seq: this.batch };
    }

    private op(o: SessionOp) {
        applyOp(this.view, structuredClone(o));
        this.noteStep(o);
        this.outbox.push(o);
        if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
    }

    private setState(patch: Partial<SessionState>) {
        this.op({ op: "state", patch });
    }

    flush() {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
        // Into the log as it's shown (while it's being closed too, until the log is let go of).
        this.syncSteps();
        if (!this.outbox.length || this.closed) return;
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

    /** The model being set up (as it opens, or switched), if it is. */
    get modelSetup(): Promise<unknown> | undefined {
        return this.switching;
    }

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

    /** The user picked a model: a prompt sent while it's being set up waits, and starts with it. */
    switchModel(ref: string, opts: { persist?: boolean } = {}): Promise<boolean> {
        // After the one under way (the session's own, as it opens), so this one has the last word.
        const before = this.switching;
        return this.track((async () => {
            if (before) await before.catch(() => undefined);
            return this.setModel(ref, opts);
        })());
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
            if (prev) this.agent.noteModelChange(modelRef(prev), info);
        }
        if (opts.persist) {
            try {
                updateSettings("user", this.ws.cwd, (s) => (s.model = ref));
                this.engine.reloadSettings();
            } catch (e) {
                this.notice(`Switched for this session only. ${redact((e as Error).message)}`, "warn");
            }
        }
        this.setState({ model: modelSummary(info), effort: this.settings().effort, fastMode: this.fastModeEnabled() });
        return true;
    }

    /** The model's details arrived (listings refreshed). */
    refreshModelInfo() {
        if (!this.model) return;
        const m = this.engine.listings.find((l) => l.provider.id === this.model!.provider)?.models.find((x) => x.id === this.model!.id);
        if (!m) return;
        this.model = m;
        if (this.agent) this.agent.model = m;
        this.setState({ model: modelSummary(m), fastMode: this.fastModeEnabled() });
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
            // What it delegated stops with it.
            void this.agent?.dispose();
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
    async complete(system: string, prompt: string, signal?: AbortSignal, opts?: { main?: boolean; review?: ReviewStage }): Promise<string> {
        let model = this.model!;
        let client = this.client!;
        if (opts?.review) {
            // The reviewer, or with none the session's own model.
            const r = await reviewTarget(this.settings().reviewModel);
            if (r) ({ model, client } = r);
        } else if (opts?.main) {
            // the session's own model
        } else ({ model, client } = await this.smallTarget());
        const res = await client.stream(
            { model, system, messages: [{ role: "user", content: [{ type: "text", text: redact(prompt) }] }], tools: [], maxTokens: 2048, effort: "low", lightweight: true, signal, ...(opts?.review ? REVIEW_REQUEST[opts.review] : {}) },
            () => {},
        );
        if (res.usage) {
            const c = costOf(res.usage, model);
            this.session.recordUsage(modelRef(model), res.usage, c.usd, c.unknown);
            this.setState({ cost: this.session.cost, costUnknown: this.session.costUnknown, ...this.tokenTotals() });
        }
        return opts?.review ? reviewText(res) : textOf(res);
    }

    /** Who answers one-off requests (titles, summaries): smallModel, else a small model of the session's provider, else its own. */
    private async smallTarget(): Promise<{ model: ModelInfo; client: ProviderClient }> {
        let model = this.model!;
        let client = this.client!;
        const smallRef = this.settings().smallModel;
        if (smallRef) {
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
        return { model, client };
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
        // Tasks the old one delegated stop with it.
        void this.agent?.dispose();
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
            // Which models Claude Code and Codex can delegate to.
            listings: () => this.engine.listings,
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
        // Left in bypass, it opened in another mode: the model hears of it, as of any switch.
        if (this.leftIn) this.agent.noteModeChange(this.leftIn, this.mode);
        this.leftIn = undefined;
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
        this.recordState();
        return true;
    }

    fastModeEnabled(): boolean {
        return Boolean(this.model?.supportsFastMode && (this.session.fastMode ?? this.settings().fastMode));
    }

    setFastMode(enabled: boolean) {
        if (enabled && !this.model?.supportsFastMode) throw new Error("Fast mode is not available for this model/backend. Refresh the model list to check for updates.");
        if (this.busy) throw new Error("Change speed once this response is done, or interrupt it first.");
        this.session.setFastMode(enabled);
        this.setState({ fastMode: this.fastModeEnabled() });
    }

    setEffort(e: EffortLevel) {
        this.effort = e;
        this.setState({ effort: e });
        this.recordState();
    }

    rename(title: string) {
        // Shown and listed as it is: a key in the prompt it was made from stays out (on disk it's redacted anyway).
        const t = cleanTitle(redact(title));
        // A title still being made when it was closed.
        if (!t || this.closed) return;
        this.session.setTitle(t);
        this.setState({ title: t });
        this.engine.sessionChanged(this);
    }

    workspaceChanged() {
        // Another reviewer's verdicts don't stand for the one now chosen.
        if (this.ws.settings.reviewModel !== this.reviewer) {
            this.reviewer = this.ws.settings.reviewModel;
            this.classifier.clearCache();
        }
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
        if (last && !last.prompt && !last.archived && !last.imported) return last;
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
                this.notePrompt();
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
                const turnId = this.addBlock({ t: "tool", id: e.id, name: e.name, title: e.name, category: meta.category, status: "streaming", receiving: 0, ...(runsAgent(e.name) ? { agent: true } : {}) });
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
                // A sub-agent's call reads as what it's doing, not as Task(…).
                if (runsAgent(e.call.name)) this.activity("Agent working", String((e.call.input as { description?: unknown })?.description ?? ""));
                else this.activity(e.title);
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
                this.toolEnded(e.call, e.result, e.durationMs, e.title);
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
            case "usage": {
                // A backend says its context window with its usage (Claude Code's models list none): the ring can show now.
                const window = this.model?.contextWindow !== this.view.state.model?.contextWindow && this.model ? { model: modelSummary(this.model) } : {};
                this.setState({ contextTokens: e.contextTokens, cost: this.session.cost, costUnknown: this.session.costUnknown, ...this.tokenTotals(), ...window });
                break;
            }
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

    private toolEnded(call: ToolCallPart, result: ToolResult, durationMs: number, title?: string) {
        const turnId = this.toolTurn.get(call.id);
        if (!turnId || !this.blockIn(turnId, call.id)) {
            const b = toolBlockFromCall(call, this.toolMeta(call));
            this.toolTurn.set(call.id, this.addBlock(b));
        }
        const d = result.display;
        const shown = d?.body !== undefined ? d.body : result.content;
        const patch: Partial<ToolBlock> = { ...resultPatch(redact(shown || (result.isError ? result.content : "")), result.isError, runsAgent(call.name)), durationMs, progress: undefined };
        // What it did was only known at its end (a backend's web search): its title and input say so now.
        if (title) Object.assign(patch, { title, input: trimInput(call.input) });
        if (/^The user declined/.test(result.content)) patch.status = "denied";
        if (d?.summary) patch.summary = d.summary;
        if (result.images?.length) patch.images = result.images.length;
        // A new file (Write says "Wrote", an Edit with an empty old_string "Created"): no "before" side.
        if (d?.diff) patch.diff = fileDiff(d.diff.path, d.diff.before === "" && /^(Created|Wrote)\b/.test(d.summary ?? "") ? null : d.diff.before, d.diff.after);
        this.patchBlock(call.id, patch, this.toolTurn.get(call.id));
        const b = this.blockIn(this.toolTurn.get(call.id), call.id) as ToolBlock | undefined;
        this.ui.write({ t: "tool", id: call.id, summary: patch.summary, diff: patch.diff, durationMs, approval: b?.approval, sandboxed: b?.sandboxed, images: patch.images, at: Date.now() });
        if (call.name === "TodoWrite") this.setState({ todos: this.toolState.todos.map((t) => ({ ...t })) });
        // A Task's result is its sub-agent's report (a delegated task's comes when it settles). One
        // still working (Claude Code's in the background) only says it started: its report comes when it ends.
        const sub = call.name === "Task" ? this.view.agents.find((a) => a.id === call.id) : undefined;
        if (sub && sub.status !== "running" && sub.status !== "waiting") this.agentPatch(call.id, { report: redact(withoutActionsNote(result.content)) });
        if (patch.diff || b?.category === "edit") this.setState({ filesChanged: this.filesChanged() });
        this.syncShells();
    }

    private compacted(summary: string) {
        const current = this.turnId;
        // Claude Code or Codex compacting its own context leaves this session's history as it is.
        if (!this.backendModel()) {
            this.segment++;
            // Everything before is out of the model's context now (and out of /rewind's reach).
            for (const t of this.view.turns) {
                if (t.id === current) {
                    if (t.prompt?.index !== undefined) this.op({ op: "turn.patch", turnId: t.id, patch: { prompt: { ...t.prompt, index: undefined } } });
                    continue;
                }
                if (!t.archived) this.op({ op: "turn.patch", turnId: t.id, patch: { archived: true, prompt: t.prompt ? { ...t.prompt, index: undefined } : undefined } });
            }
        }
        if (current) this.addBlock({ t: "compact", id: this.newId(), summary: redact(summary), auto: true });
        else {
            const turn: Turn = { id: this.newId(), blocks: [{ t: "compact", id: this.newId(), summary: redact(summary), auto: false }], status: "done", startedAt: Date.now() };
            this.op({ op: "turn", turn });
        }
        this.setState({ contextTokens: 0 });
        this.recordState();
    }

    private subagentEvent(parentId: string, label: string, e: AgentEvent) {
        this.trackAgent(parentId, label, e);
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
                if (e.title) t.title = e.title;
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

    // -----------------------------------------------------------------------
    // Sub-agents: the bar above the input and each one's activity

    private agentPatch(id: string, patch: Partial<Omit<AgentRun, "id" | "blocks">>) {
        this.op({ op: "agent.patch", id, patch });
    }

    private trackAgent(id: string, label: string, e: AgentEvent) {
        let a = this.view.agents.find((x) => x.id === id);
        if (!a || a.replayed) {
            const turnId = this.toolTurn.get(id);
            const call = turnId ? this.blockIn(turnId, id) : undefined;
            if (!turnId || call?.t !== "tool") return;
            this.op({ op: "agent", agent: { ...agentFromCall(call, turnId, this.model && modelRef(this.model)), startedAt: Date.now() } });
            a = this.view.agents.find((x) => x.id === id)!;
        }
        this.agentLabels.set(id, label);
        if (!a.taskId) {
            const task = this.agent?.delegatedTasks.find((t) => t.callId === id);
            if (task) this.agentPatch(id, { taskId: task.id, ...(a.model || !this.model || task.model === modelRef(this.model) ? {} : { model: task.model }) });
        }
        // A new turn of one that had ended (Codex's, messaged after it answered): it's running again, and its next answer is its report.
        if (e.type === "request_start" && a.endedAt !== undefined && a.status !== "running" && a.status !== "waiting") {
            this.agentText.delete(id);
            this.agentPatch(id, { status: "running", endedAt: undefined, report: undefined, turnAfter: a.blocks.at(-1)?.id ?? a.turnAfter });
        }
        switch (e.type) {
            case "request_start":
            case "thinking":
                if (a.activity !== "Thinking" && a.status === "running") this.agentPatch(id, { activity: "Thinking" });
                break;
            case "text": {
                let blockId = this.agentText.get(id);
                if (!blockId) {
                    blockId = this.newId();
                    this.agentText.set(id, blockId);
                    this.op({ op: "agent.block", id, block: { t: "text", id: blockId, text: "" } });
                }
                this.op({ op: "agent.append", id, blockId, field: "text", text: redact(e.text) });
                if (a.activity !== "Writing") this.agentPatch(id, { activity: "Writing" });
                break;
            }
            case "tool_call_start":
                this.agentText.delete(id);
                this.agentPatch(id, { activity: `Preparing ${e.name}` });
                break;
            case "tool_start": {
                this.agentText.delete(id);
                const block: ToolBlock = { ...toolBlockFromCall(e.call, { title: e.title, category: e.tool?.category as ToolCategoryId | undefined }), startedAt: Date.now() };
                this.op({ op: "agent.block", id, block });
                this.agentPatch(id, { toolCount: a.toolCount + 1, activity: e.title });
                break;
            }
            case "tool_progress":
                this.op({ op: "agent.append", id, blockId: e.id, field: "progress", text: redact(e.text) });
                break;
            case "tool_approved":
                this.op({ op: "agent.block.patch", id, blockId: e.id, patch: { approval: e.reason, sandboxed: e.sandboxed } });
                break;
            case "tool_end": {
                const d = e.result.display;
                const shown = d?.body !== undefined ? d.body : e.result.content;
                const patch: Partial<ToolBlock> = { ...resultPatch(redact(shown || (e.result.isError ? e.result.content : "")), e.result.isError, runsAgent(e.call.name)), durationMs: e.durationMs, progress: undefined };
                if (e.title) Object.assign(patch, { title: e.title, input: trimInput(e.call.input) });
                if (d?.summary) patch.summary = d.summary;
                if (d?.diff) patch.diff = fileDiff(d.diff.path, d.diff.before === "" && /^(Created|Wrote)\b/.test(d.summary ?? "") ? null : d.diff.before, d.diff.after);
                this.op({ op: "agent.block.patch", id, blockId: e.call.id, patch });
                break;
            }
            case "notice":
                this.agentText.delete(id);
                this.op({ op: "agent.block", id, block: { t: "notice", id: this.newId(), level: e.level, text: redact(e.message) } });
                break;
            case "retry":
                this.agentPatch(id, { activity: `Retrying: ${redact(e.reason)}` });
                break;
            case "usage":
                this.agentPatch(id, { tokens: a.tokens + e.usage.inputTokens + e.usage.outputTokens + (e.usage.cacheReadTokens ?? 0) });
                break;
            case "turn_end":
                this.agentEnded(id, e.reason);
                break;
        }
    }

    private agentEnded(id: string, reason: TurnEndReason) {
        this.agentText.delete(id);
        const a = this.view.agents.find((x) => x.id === id);
        if (!a) return;
        // Said in its latest turn (not an answer of an earlier one, when this one gave none). Gone from the list: all of it is.
        const from = a.turnAfter ? a.blocks.findIndex((b) => b.id === a.turnAfter) + 1 : 0;
        const said = a.blocks.slice(from).reverse().find((b) => b.t === "text" && b.text.trim());
        const status: AgentRun["status"] = reason === "aborted" ? "stopped" : reason === "done" || reason === "max_turns" ? "done" : "failed";
        // Its last word is its report; one ending again (Claude Code saying so twice) takes the later.
        const report = (a.report === undefined || a.endedAt !== undefined) && said?.t === "text" ? said.text : undefined;
        this.agentPatch(id, { status, endedAt: Date.now(), activity: undefined, ...(report !== undefined ? { report } : {}) });
        this.syncAgent(id, true);
        // Its steps are written; what's kept of them to compare against can go.
        this.agentsLogged.get(id)?.blocks.clear();
        // One that outlived its turn changed that turn's row of it (what it did, its result) since the turn ended.
        if (a.turnId !== this.turnId) this.syncTurn(a.turnId, true);
        // A delegated task's result (its report, and why it ended) comes once it settles.
        const task = a.taskId ? this.agent?.delegatedTasks.find((t) => t.id === a.taskId) : undefined;
        if (task)
            void task.settled.then(() => {
                if (!task.result) return;
                this.agentPatch(id, { report: redact(withoutActionsNote(task.result.report)), status: task.status === "cancelled" ? "stopped" : task.status === "failed" ? "failed" : "done" });
                this.syncAgent(id, true);
            });
    }

    /** The running sub-agent a permission request comes from: by its tool call, or by the label it asks with. */
    private agentAsking(req: PermissionRequest): AgentRun | undefined {
        const live = this.view.agents.filter((a) => a.status === "running" || a.status === "waiting");
        if (req.callId) {
            const byCall = live.find((a) => a.blocks.some((b) => b.id === req.callId));
            if (byCall) return byCall;
        }
        return req.agentLabel ? live.find((a) => this.agentLabels.get(a.id) === req.agentLabel) : undefined;
    }

    /** Stop a delegated task by its sub-agent's id, or every one still running. Task sub-agents stop with the turn. */
    stopAgent(agentId?: string): number {
        if (!this.agent) return 0;
        if (!agentId) return this.agent.stopDelegated();
        const a = this.view.agents.find((x) => x.id === agentId);
        if (!a?.taskId) throw new Error(a ? "This sub-agent stops with the turn: interrupt it (Esc) to stop it." : "No such sub-agent.");
        return this.agent.stopDelegated(a.taskId);
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
        // What it did, then that it ended.
        this.syncTurnAll(turnId);
        this.stepsLogged.delete(turnId);
        if (this.uiTurn) this.ui.write({ t: "turn", ...this.uiTurn, end, status });
        this.uiTurn = undefined;
        this.recordState();
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
        // Only what was offered: "always" isn't, for a dangerous command.
        if (p.interaction.kind === "permission" && r.kind === "permission" && !p.interaction.options.some((o) => o.id === r.choice)) throw new Error("That isn't one of the choices offered.");
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

    /** Answer what's pending with nothing. At a turn's end, a delegated task still running keeps asking: it outlives the turn. */
    private cancelInteractions(opts: { keepDelegated?: boolean } = {}) {
        for (const [id, p] of [...this.pending]) {
            const agentId = p.interaction.kind === "permission" ? p.interaction.agentId : undefined;
            const agent = agentId ? this.view.agents.find((a) => a.id === agentId) : undefined;
            if (opts.keepDelegated && agent?.taskId && (agent.status === "running" || agent.status === "waiting")) continue;
            this.settle(id, undefined);
        }
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
        // A sub-agent stopped while this was put together asks nothing.
        if (req.signal?.aborted) return { allow: false };
        if (req.callId && this.blockIn(this.toolTurn.get(req.callId), req.callId)) this.patchBlock(req.callId, { status: "awaiting" });
        const asking = this.agentAsking(req);
        if (asking) {
            it.agentId = asking.id;
            this.agentPatch(asking.id, { status: "waiting", activity: "Waiting for approval" });
        }
        // Withdrawn when its sub-agent is stopped.
        const withdraw = () => this.settle(it.id, undefined);
        req.signal?.addEventListener("abort", withdraw, { once: true });
        const answer = await this.interact(it).finally(() => req.signal?.removeEventListener("abort", withdraw));
        if (asking && this.view.agents.find((a) => a.id === asking.id)?.status === "waiting") this.agentPatch(asking.id, { status: "running", activity: req.title });
        if (req.signal?.aborted) return { allow: false };
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
        // Messages with images or files wait for their own turn.
        const take = this.queued.filter((q) => !q.attachments?.length && !q.text.startsWith("/") && !q.text.startsWith("!"));
        if (!take.length) return [];
        this.queued = this.queued.filter((q) => !take.includes(q));
        this.setState(this.queueState());
        const texts = take.map((q) => q.text);
        // After tool calls they ride along with the results; otherwise they're a prompt of their own.
        const last = this.session.messages[this.session.messages.length - 1];
        const steering = last?.role === "assistant" && toolCallsOf(last).length > 0;
        this.closeOpen();
        const prev = this.turnId;
        if (prev) {
            const end = Date.now();
            this.op({ op: "turn.patch", turnId: prev, patch: { status: "done", endedAt: end } });
            if (this.uiTurn) this.ui.write({ t: "turn", ...this.uiTurn, end, status: "done" });
            this.syncTurnAll(prev);
            this.stepsLogged.delete(prev);
        }
        const turn: Turn = { id: this.newId(), prompt: { text: texts.join("\n\n"), ...(steering ? {} : { index: this.session.messages.length }) }, blocks: [], status: "running", startedAt: Date.now() };
        this.op({ op: "turn", turn });
        if (prev && this.backendTurns.has(prev)) this.backendTurns.set(turn.id, this.segment);
        this.turnId = turn.id;
        // Where it starts: its own prompt, or the tool results it rides along with.
        this.uiTurn = { seg: this.segment, index: this.session.messages.length, at: turn.startedAt! };
        this.ui.write({ t: "turn", ...this.uiTurn });
        return texts;
    }

    /** A message from the GUI: a prompt, a slash command, or `!command`. Queued while busy. */
    async send(text: string, attachments?: AttachedPart[]): Promise<{ queued: boolean }> {
        // Another switch can start while it waits for one.
        while (this.switching) await this.switching.catch(() => undefined);
        if (this.closed) throw new Error("This session was closed.");
        // No await between this check and queueing/dispatch: a switch must not change the model we checked.
        const pdf = attachments?.find((p) => p.type === "file" && p.kind === "pdf");
        if (pdf && this.model && !readsPdf(this.model)) throw new RpcError(`${this.model.name ?? this.model.id} can't read PDFs. Remove ${pdf.name}, or switch to a model that can.`, "pdf_unsupported");
        const trimmed = text.trim();
        if (!trimmed && !attachments?.length) return { queued: false };
        if (attachments?.length && /^\/compact(\s|$)/i.test(trimmed)) throw new RpcError("/compact doesn't take attachments. Send them in a message of their own.");
        if (this.busy) {
            this.queued.push({ id: ++this.queueSeq, text, attachments });
            this.setState(this.queueState());
            return { queued: true };
        }
        void this.dispatch(text, attachments).catch((e) => this.notice(redact((e as Error).message), "error"));
        return { queued: false };
    }

    private async dispatch(text: string, attachments?: AttachedPart[]) {
        const trimmed = text.trim();
        if (trimmed.startsWith("!") && !attachments?.length) return this.runUserShell(trimmed.slice(1).trim());
        if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
            const [, name = "", args = ""] = trimmed.match(/^\/(\S+)\s*([\s\S]*)$/) ?? [];
            const cmd = name.toLowerCase();
            if (cmd === "compact") return void (await this.compact(args.trim() || undefined));
            if (cmd === "init") return this.startTurn(INIT_PROMPT, { display: "/init", kind: "command", attachments });
            if (cmd === "review") return this.startTurn(reviewPrompt(args.trim()), { display: `/review${args.trim() ? ` ${args.trim()}` : ""}`, kind: "command", attachments });
            const custom = this.ws.commands.find((c) => c.name === cmd);
            if (custom) return this.startTurn(expandCommand(custom.body, args.trim()), { display: trimmed, kind: "command", attachments });
        }
        return this.startTurn(text, { attachments });
    }

    async startTurn(text: string, opts: { display?: string; kind?: "prompt" | "command"; attachments?: AttachedPart[] } = {}) {
        if (!this.agent) {
            await this.ready.catch(() => undefined);
            if (this.closed) return;
            if (!this.agent) {
                this.notice("No model is selected. Add an API key in Settings → Providers, then pick a model.", "error");
                return;
            }
        }
        const agent = this.agent;
        this.busy = true;
        let settled!: () => void;
        this.turnDone = new Promise<void>((r) => (settled = r));
        const ac = (this.abort = new AbortController());
        this.turnStartedAt = Date.now();
        const display = opts.display ?? text;
        const index = this.session.messages.length;
        const turn: Turn = {
            id: this.newId(),
            prompt: { text: display, ...attachedPrompt(opts.attachments), ...(opts.kind === "command" ? { command: true } : {}), index },
            blocks: [],
            status: "running",
            startedAt: this.turnStartedAt,
        };
        this.op({ op: "turn", turn });
        this.turnId = turn.id;
        if (this.backendModel()) this.backendTurns.set(turn.id, this.segment);
        this.responseBlocks = [];
        this.uiTurn = { seg: this.segment, index, at: this.turnStartedAt };
        this.ui.write({ t: "turn", ...this.uiTurn });
        // The mode and effort it's sent with, once the session is going to be on disk.
        if (this.ui.state.mode !== this.mode || this.ui.state.effort !== this.effort) this.recordState({ force: true });
        this.setState({ busy: true, status: "running", activity: { label: "Thinking", since: this.turnStartedAt } });
        this.engine.sessionChanged(this);
        // A command's own text says more than "/init"; a greeting says nothing, so a later prompt names it.
        const about = opts.kind === "command" ? text : display;
        if (!this.session.title && !this.titleAsked && this.titleTries < TITLE_TRIES && titleWorthy(about)) void this.generateTitle(about);

        let reason: TurnEndReason | undefined;
        try {
            if (!this.session.meta.system) await this.freezeSystemPrompt(ac.signal);
            if (ac.signal.aborted) {
                this.engine.draft(this, display, opts.attachments);
                reason = "aborted";
                this.endTurn("aborted");
            } else {
                const roots = [this.ws.cwd, ...(this.settings().permissions?.additionalDirectories ?? [])];
                const { parts, attached } = expandMentions(text, this.toolState, roots);
                if (attached.length) this.notice(`Attached ${attached.join(", ")}`);
                if (opts.attachments?.length) {
                    if (this.model?.supportsImages === false && opts.attachments.some((a) => a.type === "image")) this.notice(`${this.model.name ?? this.model.id} may not accept images.`, "warn");
                    // Checked when it was sent; the model may have changed while it waited in the queue.
                    if (this.model && !readsPdf(this.model) && opts.attachments.some((a) => a.type === "file" && a.kind === "pdf")) this.notice(`${this.model.name ?? this.model.id} can't read PDFs: it's told one was attached, not what's in it.`, "warn");
                    parts.push(...opts.attachments);
                }
                reason = await agent.run(parts, { signal: ac.signal, display, kind: opts.kind });
            }
        } catch (e) {
            const message = `Unexpected error: ${redact((e as Error).message)}`;
            this.session.recordNotice("error", message);
            this.notice(message, "error");
            reason = "error";
            this.endTurn("error");
        } finally {
            this.busy = false;
            this.abort = undefined;
            this.cancelInteractions({ keepDelegated: true });
            this.closeOpen();
            this.turnId = undefined;
            this.setState({ busy: false, activity: undefined, persisted: existsSync(this.session.path), todos: this.toolState.todos.map((t) => ({ ...t })) });
            this.setStatus(reason === "error" ? "error" : this.pending.size ? "waiting" : "idle");
            this.flush();
            this.engine.sessionChanged(this);
            settled();
        }
        const elapsed = Date.now() - this.turnStartedAt;
        if (reason && reason !== "aborted" && (reason === "error" || elapsed >= notifyAfterMs(this.settings()))) {
            this.engine.notify(this, reason === "error" ? "error" : "done", reason === "error" ? "Stopped with an error" : `Finished in ${Math.round(elapsed / 1000)}s`);
        }
        await this.runQueued(ac.signal.aborted);
    }

    /** After a turn, a `!command` or a compaction: the next message sent meanwhile, or all of them back to the input box after an interrupt. */
    private async runQueued(aborted: boolean) {
        if (this.closed) return;
        if (aborted) return this.returnQueued();
        const next = this.queued.shift();
        if (!next) return;
        this.setState(this.queueState());
        await this.dispatch(next.text, next.attachments).catch((e) => this.notice(redact((e as Error).message), "error"));
    }

    /** After an interrupt, unsent messages go back to the input box instead of running. */
    private returnQueued() {
        if (!this.queued.length) return;
        const text = this.queued.map((q) => q.text).filter((t) => t.trim()).join("\n\n");
        this.engine.draft(this, text, this.queued.flatMap((q) => q.attachments ?? []));
        this.queued = [];
        this.setState(this.queueState());
    }

    private queueState() {
        return { queued: this.queued.map((q) => q.text), queueIds: this.queued.map((q) => q.id), queuedAttached: this.queued.map((q) => attachedLabel(q.attachments)) };
    }

    /** Out of the queue, by its id (a message the queue has moved past isn't there any more). */
    dequeue(queueId: number): Queued | undefined {
        const i = this.queued.findIndex((q) => q.id === queueId);
        if (i < 0) return undefined;
        const [q] = this.queued.splice(i, 1);
        this.setState(this.queueState());
        return q;
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
        if (!this.client) return;
        this.titleAsked = true;
        this.titleTries++;
        // Redacted before it's cut or capitalized: then a key in it no longer looks like one.
        this.titleFrom ??= redact(prompt);
        let title: string | undefined;
        // Claude Code and Codex run whole turns only, so they can't be asked for one: without a
        // smallModel on another provider the prompt names the session.
        if (isAgentBackend((await this.smallTarget().catch(() => undefined))?.client ?? this.client)) {
            const t = promptTitle(this.titleFrom);
            if (t && !this.session.title) this.rename(t);
            return;
        }
        try {
            const raw = await this.complete(
                "You name coding-assistant sessions for a sidebar. Reply with only the title: 2 to 6 words, sentence case, no quotes, no trailing punctuation. Describe the task, not the user.",
                prompt.slice(0, 3000),
                AbortSignal.timeout(20_000),
            );
            title = raw
                .replace(/<[^>]*>/g, "")
                .split("\n")
                .map((l) => l.trim())
                .find(Boolean)
                ?.replace(/^title:\s*/i, "")
                .replace(/^["'`*#\s]+|["'`*.\s]+$/g, "")
                .slice(0, 60);
            // Not a title: the prompt said back, or a paragraph.
            if (title && title.split(/\s+/).length > 10) {
                this.engine.log(`session ${this.id}: the title it got was the prompt said back, or a paragraph`);
                title = undefined;
            }
        } catch (e) {
            this.engine.log(`session ${this.id}: no title (try ${this.titleTries} of ${TITLE_TRIES}): ${(e as Error).message}`);
        }
        // The last try failed too: the first prompt that said something names it.
        if (!title && this.titleTries >= TITLE_TRIES) title = promptTitle(this.titleFrom);
        if (title && !this.session.title) this.rename(title);
        // Until one comes, the sidebar shows the first prompt; a later prompt asks again.
        else if (!title) this.titleAsked = false;
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
        const lines = lineRedactor();
        try {
            const res = await runShell({
                command,
                cwd: this.toolState.cwd,
                timeoutMs: 120_000,
                signal: ac.signal,
                env: childEnv(this.settings().env),
                // Line by line (the rest comes with the full output at the end).
                onData: (chunk) => {
                    const ready = lines(chunk);
                    if (ready) this.op({ op: "append", turnId: turn.id, blockId, field: "output", text: ready });
                },
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
        await this.runQueued(ac.signal.aborted);
    }

    async compact(instructions?: string) {
        // On the model being switched to, as a prompt would be.
        while (this.switching) await this.switching.catch(() => undefined);
        if (this.closed) throw new Error("This session was closed.");
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
        // Not awaited: session.compact answers once the compaction is done, not after the next turn.
        void this.runQueued(ac.signal.aborted);
    }

    // -----------------------------------------------------------------------
    // Rewind and changes

    rewindTargets(): RewindTargetInfo[] {
        const history = FileHistory.for(this.session);
        return rewindTargets(this.session.messages)
            .reverse()
            .map((t) => ({ index: t.index, text: t.text, tracked: Boolean(history && t.checkpoint !== undefined), files: history && t.checkpoint !== undefined ? history.filesIn(t.checkpoint).length : 0, ...(t.backends.length ? { backends: t.backends } : {}) }));
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
        const planId = this.newId();
        this.rewindShown = { id: planId, index, message: this.session.messages[index]!, count: this.session.messages.length, plan };
        const backends = backendsIn(this.session.messages, index);
        return {
            index,
            planId,
            ...(backends.length ? { backends } : {}),
            tracked: Boolean(plan),
            restore: (plan ?? []).filter((i) => i.action !== "skip").map((i) => ({ path: rel(i.path), action: i.action as "write" | "delete", outside: Boolean(i.outside) })),
            skipped: (plan ?? []).filter((i) => i.action === "skip").map((i) => ({ path: rel(i.path), reason: i.reason ?? "" })),
        };
    }

    /**
     * Restore what rewindPlan showed (`planId`), as the terminal's /rewind does:
     * a file changed since then is left alone (it fails, with the reason), and
     * nothing happens if the conversation moved on.
     */
    rewind(index: number, planId: string, code: boolean, conversation: boolean): { restored: string[]; failed: { path: string; error: string }[]; text: string; images?: { mediaType: string; data: string }[]; files?: WireFile[] } {
        if (this.busy) throw new Error("Wait for the current response to finish, or interrupt it first.");
        const t = this.target(index);
        const shown = this.rewindShown;
        // A turn since (one running when it was shown, say) may have changed files the plan doesn't know about.
        if (!shown || shown.id !== planId || shown.index !== index || this.session.messages[index] !== shown.message || this.session.messages.length !== shown.count) {
            throw new Error("The conversation changed since this was shown; nothing was rewound. Open Rewind again.");
        }
        this.rewindShown = undefined;
        // What the prompt carried goes back to the box with its text: a pasted text exists nowhere else.
        const attached = shown.message.role === "user" ? shown.message.content.filter((p): p is AttachedPart => p.type === "image" || p.type === "file") : [];
        const history = FileHistory.for(this.session);
        const plan = shown.plan;
        const backends = backendsIn(this.session.messages, index);
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
            // What a backend changed was never tracked: all of it is still there.
            if (backends.length) this.agent?.addReminder(untrackedChangesNote(backends, restored));
            this.rebuild();
        }
        this.setState({ filesChanged: this.filesChanged(), todos: this.toolState.todos.map((x) => ({ ...x })), contextTokens: 0 });
        this.recordState();
        this.flush();
        this.engine.sessionChanged(this);
        return { restored, failed, text: t.text, ...toWire(attached) };
    }

    /** The timeline again from the transcript (after a rewind). */
    private rebuild() {
        const segments = readSegments(this.session.path);
        const turns = replay({ segments: segments.length ? segments : [{ messages: [] }], current: this.session.messages, currentNotices: this.session.notices, ui: this.ui, meta: (c) => this.toolMeta(c), newId: () => this.newId() });
        // Sub-agents whose calls are still there keep what was seen of them (their turns have new ids).
        const agents = agentsFromTurns(turns, this.model && modelRef(this.model), this.ui.agents).map((r) => {
            const live = this.view.agents.find((a) => a.id === r.id && !a.replayed);
            // One still working goes on being logged under its turn's new id.
            if (live && this.backendTurns.has(live.turnId)) this.backendTurns.set(r.turnId, this.segment);
            return live ? { ...live, turnId: r.turnId } : r;
        });
        this.op({ op: "reset", turns, agents });
    }

    /** What git says changed in the session's folder, whoever changed it. */
    gitChanges(req: { scope: GitScope; base?: string; path?: string }): Promise<GitChangesInfo> {
        return gitChanges(this.ws.cwd, req);
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
        const find = (messages: Message[]) => {
            for (const m of messages) {
                if (m.role !== "user") continue;
                for (const p of m.content) if (p.type === "tool_result" && p.toolCallId === toolId) return p.content;
            }
            return undefined;
        };
        // From before a compaction, it's still in the transcript file (and still shown).
        const out = find(this.session.messages) ?? readSegments(this.session.path).reduce<string | undefined>((hit, seg) => hit ?? find(seg.messages), undefined);
        if (out === undefined) throw new Error("That output is no longer in the conversation.");
        return redact(out);
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
                const note = attachmentsNote(msg.content);
                if (t || note) out.push(kind === "summary" ? "## Summary of earlier conversation" : "## User", "", ...(t ? [t] : []), ...(note ? [`*${note}*`] : []), "");
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

    /** Nothing running, waiting for the user, or still to be delivered to the model: closing it loses nothing. */
    get idle(): boolean {
        if (this.busy || this.queued.length || this.pending.size || this.switching) return false;
        if ([...this.toolState.shells.values()].some((s) => s.exitCode === null)) return false;
        return !(this.agent?.delegatedTasks ?? []).some((t) => t.status === "running" || !t.delivered);
    }

    /** SessionEnd hooks and background shells, when the server stops or the session is closed. */
    async close() {
        this.abort?.abort();
        this.cancelInteractions();
        if (this.shellTimer) clearInterval(this.shellTimer);
        this.flush();
        // What's still going (a turn being interrupted, sub-agents delegated past their turn) as far as it got.
        // How it ends is written too, if that's before the session is let go of.
        this.syncSteps(true);
        this.closed = true;
        // Delegated tasks still running stop with the session.
        const ending = Promise.all([this.hook("SessionEnd", { reason: "exit" }, AbortSignal.timeout(5000)), this.agent?.dispose(), killAllShells({ state: this.toolState })]);
        try {
            // A turn still running notes how it stopped (the interrupt, what it was retrying) before the file is let go.
            const turn = this.turnDone;
            if (turn && !(await Promise.race([turn.then(() => true), Bun.sleep(closeTiming.turnMs).then(() => false)]))) {
                // Still stopping (the server's own exit doesn't wait long enough for a CLI backend's): noted for it,
                // and the file let go now, so what it writes when it does stop isn't recorded after that.
                this.agent?.noteStopped();
                // Its log too (noting the stop ended the turn there): another process may have the session next.
                this.ui.close();
                this.session.release();
            }
            await ending;
        } finally {
            this.ui.close();
            this.session.release();
        }
    }
}
