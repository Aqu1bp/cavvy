// One ACP agent process, spoken to over the Agent Client Protocol
// (agentclientprotocol.com): its session, its turns as CliEvents, and its
// permission requests through Cavvy's (SessionHost.permission).
//
// Cavvy offers it no file system or terminal: it uses its own tools, and asks
// before those that change something (the per-agent spawn makes it ask,
// src/backends/acp/agents.ts). Each ask goes through Cavvy's rules and mode.
// An agent whose own settings Cavvy can't override (Grok's) holds every tool
// call at a gate Cavvy registers instead (AcpAgent.gate), answered the same
// way. A change it makes without having asked, or without the gate (its own
// settings overrode the spawn's), stops the turn: the tripwire.
//
// A prompt is a turn: it ends when session/prompt answers. One at a time. A
// message the user sends meanwhile to steer it joins it at its next step
// (steer): each agent's way (AcpAgent.interject), and the turn ends once every
// prompt it sent has answered.

import { randomUUID } from "crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "fs";
import { isAbsolute, resolve } from "path";
import type { AgentEvent, TurnEndReason } from "../../agent/agent";
import { APP_NAME, APP_TITLE, APP_VERSION } from "../../config/paths";
import { servedWorktreeName } from "../../tools/worktree-tools";
import { stableStringify } from "../../permissions/classifier";
import type { PermissionMode } from "../../permissions/modes";
import type { Usage } from "../../providers/types";
import type { ToolDisplay } from "../../tools/types";
import { titleFor } from "../claude-code";
import type { JsonLinesProcess } from "../cli";
import type { AgentCliDef, CliCapabilities } from "../defs";
import { liveDebug } from "../live/debug";
import { PromptRefused } from "../live/session";
import type { CliConnection, CliEventSink, LiveSettings, TurnInput } from "../live/types";
import type { BackendPermission, OrchestratorServer, PermissionAnswer, SessionHost, SteerMessage } from "../types";
import { gateDeadlineMs, type AcpAgent, type GateCall, type GateTool } from "./agents";
import { AcpError, AcpGone, AcpRpc, METHOD_NOT_FOUND } from "./rpc";

/** session/resume or session/load failed: the backend starts a new session with the conversation as context. */
export const RESUME_FAILED = "Couldn't resume the";

/** Tool kinds that change something: the agent must have asked about them first (the tripwire). */
const CHANGES = new Set(["edit", "delete", "move", "execute"]);

interface ConfigOption {
    id: string;
    category?: string;
    currentValue?: unknown;
    options?: unknown[];
}

/** A tool call as its updates have told it so far (the first may say little: OpenCode's has no input). */
interface ToolState {
    id: string;
    kind?: string;
    title?: string;
    status?: string;
    rawInput?: Record<string, any>;
    locations?: { path: string }[];
    content?: any[];
    rawOutput?: any;
    _meta?: Record<string, any>;
    /** As its tool_start named it. */
    call?: { name: string; input: Record<string, unknown>; title: string; started: number };
    /** The tripwire has noted it already. */
    noted?: boolean;
}

interface Turn {
    ref: string;
    tools: Map<string, ToolState>;
    /** Tool calls the agent asked about, or Cavvy's gate answered. */
    asked: Set<string>;
    /**
     * Calls Cavvy's gate let go by its own decision (gateKey), as it checked them and in the mode it did: an ask
     * about the same call that follows, in that mode still, is answered yes.
     */
    gated: Map<string, Checked>;
    /** Permission requests still waiting for Cavvy's answer: they're answered cancelled if the turn stops. */
    waiting: Set<(outcome: Record<string, unknown>) => void>;
    /** session/cancel was sent. */
    cancelling?: boolean;
    /** Why the tripwire stopped it. */
    tripped?: string;
    /** Cavvy refused something it asked about (Grok ends its turn there, as cancelled). */
    refused?: boolean;
    /** The assistant message being said, and its id. */
    text: string;
    messageId?: string;
    /** The session's cost the agent last reported, in USD. */
    cost?: number;
    ended?: boolean;
    /** Its session/prompt calls not answered yet: its own, and those steering it. */
    open: number;
    /**
     * Their answers, and those of prompts the agent ran of its own for it (Interject.started). `group`: prompts the
     * agent folded into one run (OpenCode's), which answer alike.
     */
    answers: { r: any; group?: number }[];
    /** The last group of folded prompts begun. */
    group: number;
    /** The last group one of whose prompts answered: its run is over, so nothing sent after is folded into it. */
    closed?: number;
    /** Its own prompt answered: nothing more is taken to steer it. */
    answered?: boolean;
    /** Its own prompt's error, said once every other has answered. */
    failed?: unknown;
    /** Messages being taken to steer it and sent: it doesn't end before they've gone. */
    draining?: Promise<void>;
    /** Another drain was asked for while one ran. */
    again?: boolean;
    /** Texts sent by the agent's own request (Interject), and when the last went. */
    interjected: string[];
    /**
     * Those it queued, with no sign yet it took them (it says nothing when it does: grok-1.0.70-steer-taken.jsonl).
     * `pending`: not answered yet. `after`: one of its tools ended since its answer, so its next step, once it speaks,
     * began with them, and `taken` once it has: guessed, where its record (Interject.record) can't say. `back`: handed
     * back (handBack).
     */
    untaken: { text: string; pending?: boolean; after?: boolean; taken?: boolean; back?: boolean; message?: SteerMessage }[];
    /** Where its record ended as the turn began, and its prompt's id (its answer's): what it took is read from there. */
    since?: number;
    promptId?: string;
    /** Stopped, what its record says it took (null: unread, guessed), and while it's read: the turn ends after. */
    decided?: string[] | null;
    deciding?: boolean;
    /** Those requests not answered yet: the turn doesn't end before they are. */
    acking: number;
    /** Prompts the agent runs of its own for one of those (it came as the turn was ending): the turn waits for them. */
    own: Set<string>;
    /** Until then it waits for one to start, after its own prompt answered. */
    watchUntil?: number;
}

/** Where the turn running takes the messages to steer it with (the backend's turn sink, TurnSink.drainQueued). */
export interface SteerSource {
    /**
     * Messages queued to steer with, taken (and recorded) now; `live`: whether the turn can still take them.
     * `flush`: what the agent has said so far into the turn's record, before they're recorded after it.
     */
    drain(live: () => boolean, flush: () => void): Promise<SteerMessage[]>;
    /** Ones taken that never went (the turn was stopped first): saved for the next turn. */
    undelivered(messages: SteerMessage[]): void;
}

const CANCELLED = { outcome: { outcome: "cancelled" } };

/** How long a stopped turn waits for the agent's record to say its prompt ended (Interject.record), looking this often. */
const RECORD_WAIT_MS = 1000;
const RECORD_POLL_MS = 20;

/** What the gate (AcpAgent.gate) says to a call held while the turn is stopping. */
const TURN_STOPPED = "Turn stopped";

/** A gated call, by its session and id. */
const gateKey = (sessionId: string, id: string) => `${sessionId}\n${id}`;

/** A gated call as Cavvy checked it, and the mode it did in. */
type Checked = { toolName: string; input: Record<string, unknown>; mode: PermissionMode };

/** A gated call's answer. `decided`: by Cavvy's rules (not auto mode letting it go), as `checked`. */
type GateDecision = { allow: true; decided: boolean; checked?: Checked } | { allow: false; reason: string; stop?: boolean; late?: boolean };

export class AcpConnection implements CliConnection {
    caps: CliCapabilities;
    readonly done: Promise<void>;
    private rpc: AcpRpc;
    private init: Record<string, any> = {};
    private sessionId?: string;
    private config: ConfigOption[] = [];
    /** The models the session says it has (session/new's `models`), for session/set_model when there's no model option. */
    private models?: { currentModelId?: string; availableModels?: any[] };
    /** Its session mode (session/set_mode), as it last said or was set; unknown until then. */
    private modeId?: string;
    /** The `_meta` the session was opened with (AcpAgent.sessionMeta), as JSON. */
    private opened = "";
    /** The prompts it said ended (Grok's _meta.promptId): their updates still to come aren't the next turn's. */
    private endedPrompts: string[] = [];
    /** Updates are its history, replayed by session/load: not this turn's. */
    private replaying = false;
    private turn?: Turn;
    /** The session's cost when the current turn started (USD); unknown for a resumed session until a turn reports it. */
    private costSoFar?: number;
    private context?: { used?: number; size?: number };
    /** Its subagents' sessions (AcpGate.subagent): what their gated calls are labelled. */
    private children = new Map<string, string>();
    /** Its process went. */
    private gone = false;

    constructor(
        readonly proc: JsonLinesProcess,
        private events: CliEventSink,
        private host: SessionHost,
        private def: AgentCliDef,
        private agent: AcpAgent,
        private cwd: string,
        /** The turn running's, set by the backend with each. */
        private steering: () => SteerSource | undefined = () => undefined,
        /** Cavvy's MCP server for the session's turns (its worktree tools), if it has one. */
        private orchestrator: () => OrchestratorServer | undefined = () => undefined,
    ) {
        this.caps = { ...def.caps };
        this.rpc = new AcpRpc(proc, (m, p) => this.onNotification(m, p), (m, p) => this.onRequest(m, p));
        this.done = this.rpc.done.then(() => this.lost());
    }

    /** initialize: no file system or terminal offered. */
    async initialize(): Promise<Record<string, any>> {
        const r = await this.rpc.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: APP_TITLE.toLowerCase(), title: APP_TITLE, version: APP_VERSION },
        });
        if (r?.protocolVersion !== 1) throw new Error(`${this.def.name} speaks ACP version ${String(r?.protocolVersion)}, not 1`);
        this.init = r;
        this.caps.images = Boolean(r.agentCapabilities?.promptCapabilities?.image);
        return r;
    }

    async open(o: { resumeId?: string; fork?: boolean; settings: LiveSettings }): Promise<{ sessionId: string }> {
        if (o.fork) throw new Error(`${this.def.name} sessions can't be forked here`);
        const meta = this.agent.sessionMeta?.(o.settings.mode);
        const params = { cwd: this.cwd, mcpServers: this.mcpServers(), ...(meta ? { _meta: meta } : {}) };
        this.opened = JSON.stringify(meta ?? null);
        if (o.resumeId) {
            const can = this.init.agentCapabilities ?? {};
            let r: any;
            try {
                // session/resume doesn't replay the history; session/load does, as updates before its answer.
                if (can.sessionCapabilities?.resume) r = await this.rpc.request("session/resume", { ...params, sessionId: o.resumeId });
                else if (can.loadSession) {
                    this.replaying = true;
                    r = await this.rpc.request("session/load", { ...params, sessionId: o.resumeId });
                } else throw new Error(`${this.def.name} can't resume sessions`);
            } catch (e) {
                throw new Error(`${RESUME_FAILED} ${this.def.name} session: ${errorText(e)}`);
            } finally {
                this.replaying = false;
            }
            this.sessionId = o.resumeId;
            this.noteSession(r);
        } else {
            // Signed out, Grok answers -32000 Authentication required here (grok-1.0.70-signed-out.jsonl).
            const r = await this.rpc.request("session/new", params).catch((e) => {
                throw e instanceof AcpGone ? e : new Error(this.failure(e));
            });
            if (typeof r?.sessionId !== "string" || !r.sessionId) throw new Error(`${this.def.name} didn't start a session`);
            this.sessionId = r.sessionId;
            this.costSoFar = 0;
            this.noteSession(r);
        }
        await this.apply(o.settings);
        return { sessionId: this.sessionId! };
    }

    /** Cavvy's MCP server, to an agent that takes one over HTTP (ACP's mcpCapabilities). */
    private mcpServers(): unknown[] {
        const o = this.orchestrator();
        if (!o || !this.init.agentCapabilities?.mcpCapabilities?.http) return [];
        return [{ type: "http", name: o.name, url: o.url, headers: [{ name: "Authorization", value: o.authorization }] }];
    }

    private noteSession(r: any) {
        if (Array.isArray(r?.configOptions)) this.config = r.configOptions;
        if (r?.models && typeof r.models === "object") this.models = r.models;
        this.modeId = typeof r?.modes?.currentModeId === "string" ? r.modes.currentModeId : undefined;
    }

    async prompt(input: TurnInput): Promise<{ ref: string }> {
        if (!this.sessionId) throw new PromptRefused(`${this.def.name} has no session open`);
        if (this.turn && !this.turn.ended) throw new PromptRefused(`${this.def.name} is still finishing its last turn. Try again in a moment.`);
        const turn: Turn = { ref: randomUUID(), tools: new Map(), asked: new Set(), gated: new Map(), waiting: new Set(), text: "", open: 0, answers: [], group: 0, interjected: [], untaken: [], acking: 0, own: new Set() };
        this.turn = turn;
        try {
            turn.since = this.agent.interject?.record?.size(this.sessionId);
        } catch (e) {
            liveDebug("acp", "steer record unread", { error: errorText(e) });
        }
        if (input.images.length && !this.caps.images) this.emit({ type: "notice", level: "warn", message: `${this.def.name} doesn't take images, so ${input.images.length === 1 ? "the image wasn't" : "the images weren't"} sent.` });
        if (!(await this.send(turn, input, true))) {
            turn.ended = true;
            if (this.turn === turn) this.turn = undefined;
            throw new PromptRefused(`${this.def.name} had stopped before the prompt reached it`);
        }
        liveDebug("acp", "prompt", { ref: turn.ref, images: input.images.length });
        // One queued to steer with before the turn was under way goes now.
        this.steerQueued();
        return { ref: turn.ref };
    }

    /** A session/prompt of the turn's: its own, or one steering it. Whether it reached the agent. */
    private async send(turn: Turn, input: Pick<TurnInput, "text" | "images">, own: boolean): Promise<boolean> {
        const blocks: Record<string, unknown>[] = [{ type: "text", text: input.text }];
        if (input.images.length && this.caps.images) for (const i of input.images) blocks.push({ type: "image", mimeType: i.mediaType, data: i.data });
        // Sent while another of the turn's runs, it's folded into that one (an agent that steers by Interject queues it).
        const group = this.agent.interject ? undefined : turn.open > 0 && turn.closed !== turn.group ? turn.group : ++turn.group;
        const { sent, result } = this.rpc.call("session/prompt", { sessionId: this.sessionId, prompt: blocks });
        turn.open++;
        result.then(
            (r) => this.answer(turn, r, own, group),
            (e) => this.answerFailed(turn, e, own),
        );
        return sent;
    }

    /**
     * A message joining the running turn at its next step: by the agent's own request (Grok's _x.ai/interject, text
     * only), or as a second session/prompt that the agent folds into the running one (OpenCode). True once the agent
     * has it; false when the turn can't take it now (ended, stopped, or its prompt answered).
     */
    async steer(ref: string, input: TurnInput, message?: SteerMessage): Promise<boolean> {
        const turn = this.turn;
        if (!turn || turn.ref !== ref || !this.steerable(turn)) return false;
        const how = this.agent.interject;
        if (!how) return this.send(turn, input, false);
        if (input.images.length || input.documents?.length) return false;
        const { method, params } = how.request(this.sessionId!, input.text);
        turn.interjected.push(input.text);
        turn.acking++;
        // The message as taken (`message`, when it came from the queue): handed back as it is, so it's known as the same one.
        const entry: Turn["untaken"][number] = { text: input.text, pending: true, message };
        turn.untaken.push(entry);
        try {
            const r = await this.rpc.request(method, params);
            liveDebug("acp", "interject", { ref, status: r?.status });
            // Queued: a tool that ends from now on ends before its next step, which takes it.
            entry.pending = false;
            return true;
        } catch (e) {
            liveDebug("acp", "interject refused", { ref, error: errorText(e) });
            turn.interjected.splice(turn.interjected.lastIndexOf(input.text), 1);
            if (turn.untaken.includes(entry)) turn.untaken.splice(turn.untaken.indexOf(entry), 1);
            // Handed back already: not again as one that never went.
            return Boolean(entry.back);
        } finally {
            turn.acking--;
            // Taken once its prompt had answered: it may yet run as a prompt of its own, watched for from now.
            if (turn.answered) this.watchOwn(turn);
            this.settleTurn(turn);
        }
    }

    /** Whether a message can still join the turn: it runs, isn't being stopped, and its prompt hasn't answered. */
    private steerable(turn: Turn): boolean {
        return this.caps.steering !== "none" && this.turn === turn && !turn.ended && !turn.cancelling && !turn.tripped && !turn.answered;
    }

    /**
     * Messages queued to steer the running turn: taken and sent now (TurnSink.onQueued), each recorded as it's
     * taken. One with attachments is the queue's until the agent has it (SteerMessage.settle).
     */
    steerQueued() {
        const turn = this.turn;
        if (turn && this.steering() && this.steerable(turn)) void this.drain(turn);
    }

    private drain(turn: Turn): Promise<void> {
        if (turn.draining) {
            turn.again = true;
            return turn.draining;
        }
        // The turn's, kept: its run may be over by the time what was taken is known not to have gone.
        const source = this.steering();
        if (!source) return Promise.resolve();
        turn.draining = (async () => {
            const unsent: SteerMessage[] = [];
            try {
                do {
                    turn.again = false;
                    // What it said so far goes before them.
                    const taken = await source.drain(() => this.steerable(turn), () => this.flushText(turn));
                    for (const m of taken) {
                        const ok = await this.deliver(turn, m);
                        if (m.settle) await m.settle(ok);
                        else if (!ok) unsent.push(m);
                    }
                } while (turn.again && this.steerable(turn));
            } catch (e) {
                liveDebug("acp", "steer failed", { ref: turn.ref, error: errorText(e) });
            } finally {
                turn.draining = undefined;
                // Taken, and recorded, but never sent (stopped first): they go with the next turn.
                if (unsent.length) source.undelivered(unsent);
                this.settleTurn(turn);
            }
        })();
        return turn.draining;
    }

    /**
     * A message taken to steer with, sent. Its prompt having answered meanwhile (the turn was ending), it goes as a
     * prompt of its own that the turn waits for, never into the next turn's: it's recorded in this one already.
     */
    private async deliver(turn: Turn, m: SteerMessage): Promise<boolean> {
        const input = { text: m.text, images: m.images, documents: m.documents };
        if (this.steerable(turn)) return this.steer(turn.ref, input, m);
        if (this.turn !== turn || turn.ended || turn.cancelling || turn.tripped || turn.failed !== undefined) return false;
        liveDebug("acp", "steer after the prompt answered: a prompt of its own", { ref: turn.ref });
        return this.send(turn, input, false);
    }

    async interrupt(ref: string): Promise<void> {
        const turn = this.turn;
        if (!turn || turn.ref !== ref || turn.ended) return;
        await this.cancel(turn);
    }

    /** The session ends the turn itself: what it said so far, and the tools it started, go into it now. */
    settle(ref: string) {
        const turn = this.turn;
        if (!turn || turn.ref !== ref || turn.ended) return;
        this.flushText(turn);
        for (const t of [...turn.tools.values()]) if (t.call) this.endTool(turn, t, true, "Cancelled: the turn ended before it finished.");
        // Stopped, and its steering ends with it: before its answer comes.
        this.handBackNow(turn);
    }

    /**
     * Handed back as its record says so far, the rest as guessed: the turn can't wait for it to say its prompt ended
     * (ended here first, or its process went). One it records later is handed back too, and so sent twice.
     */
    private handBackNow(turn: Turn) {
        const r = this.agent.interject?.record && turn.untaken.length ? this.recorded(turn, turn.promptId) : null;
        turn.deciding = false;
        this.handBack(turn, r ? { taken: r.texts, exact: r.ended } : undefined);
    }

    /**
     * Stopped, it drops what it hadn't taken (grok-1.0.70-steer-taken.jsonl): recorded as sent already, those it
     * didn't (Turn.untaken, answered or not) go with the next turn, once, as one taken that never went does. Those its
     * record says it took (by text, each once) don't; the rest go when it says all it took (`exact`), else as guessed.
     */
    private handBack(turn: Turn, record?: { taken: string[]; exact: boolean }) {
        const left = record?.taken.map((t) => t.trim()) ?? [];
        const back = turn.untaken.splice(0).filter((x) => {
            const i = left.indexOf(x.text.trim());
            if (i >= 0) left.splice(i, 1);
            return i < 0 && (record?.exact || !x.taken);
        });
        for (const x of back) x.back = true;
        if (back.length) this.steering()?.undelivered(back.map(({ text, message }) => message ?? { text, images: [], documents: [] }));
    }

    /** What its record says it took in the turn's prompt `promptId` (Interject.record), and if it says that ended. Null: unread. */
    private recorded(turn: Turn, promptId?: string): { texts: string[]; ended: boolean } | null {
        try {
            if (turn.since === undefined) throw new Error("no record as the turn began");
            return this.agent.interject!.record!.taken(this.sessionId!, turn.since, promptId);
        } catch (e) {
            liveDebug("acp", "steer record unread: what it took is guessed", { ref: turn.ref, error: errorText(e) });
            return null;
        }
    }

    /** Stopped: its record, once it says the turn's prompt ended (RECORD_WAIT_MS at most), says what it took. Then the turn ends. */
    private async decide(turn: Turn) {
        turn.deciding = true;
        const until = Date.now() + RECORD_WAIT_MS;
        let r = turn.promptId ? this.recorded(turn, turn.promptId) : null;
        while (r && !r.ended && Date.now() < until) {
            await Bun.sleep(RECORD_POLL_MS);
            // Handed back meanwhile (handBackNow): the turn was ended here, or its process went.
            if (!turn.deciding) return this.gone ? undefined : this.settleTurn(turn);
            r = this.recorded(turn, turn.promptId);
        }
        if (r && !r.ended) liveDebug("acp", "steer record: its prompt's end not there in time, what it took is guessed", { ref: turn.ref });
        if (!turn.promptId) liveDebug("acp", "steer record: no prompt id, what it took is guessed", { ref: turn.ref });
        turn.decided = r?.ended ? r.texts : null;
        turn.deciding = false;
        this.settleTurn(turn);
    }

    /** session/cancel: what waits for a permission answer is answered cancelled, as ACP asks. */
    private async cancel(turn: Turn) {
        if (turn.cancelling) return;
        turn.cancelling = true;
        for (const w of [...turn.waiting]) w(CANCELLED);
        await this.rpc.notify("session/cancel", { sessionId: this.sessionId });
        // Waiting only for a steer that came too late to start (Interject.started): it won't now.
        this.settleTurn(turn);
    }

    async apply(s: Partial<LiveSettings>): Promise<"applied" | "restart"> {
        // A mode its session must be opened with (Grok's auto): a new process resumes the session with it.
        if (s.mode !== undefined && this.agent.sessionMeta && JSON.stringify(this.agent.sessionMeta(s.mode) ?? null) !== this.opened) return "restart";
        const model = s.model?.id;
        if (model && model !== "default" && model !== this.currentModel()) await this.setModel(model);
        if (s.effort !== undefined || model) await this.setEffort(s.effort);
        const plan = this.agent.planMode;
        if (s.mode !== undefined && plan) {
            const want = s.mode === "plan" ? plan.plan : plan.normal;
            if (plan.configId !== undefined) {
                const opt = this.config.find((c) => c.id === plan.configId);
                if (opt && opt.currentValue !== want) await this.setOption(opt.id, want);
            } else if (this.modeId !== want) {
                await this.rpc.request("session/set_mode", { sessionId: this.sessionId, modeId: want }).catch(said);
                this.modeId = want;
            }
        }
        return "applied";
    }

    private currentModel(): string | undefined {
        const opt = this.config.find((c) => c.category === "model");
        return typeof opt?.currentValue === "string" ? opt.currentValue : this.models?.currentModelId;
    }

    /** By its model option (a bare string value), or session/set_model where there's none. */
    private async setModel(id: string) {
        const opt = this.config.find((c) => c.category === "model");
        if (opt) await this.setOption(opt.id, id);
        else if (this.models) {
            await this.rpc.request("session/set_model", { sessionId: this.sessionId, modelId: id }).catch(said);
            this.models = { ...this.models, currentModelId: id };
        } else throw new Error(`${this.def.name} can't switch models`);
    }

    /** Through the model's effort option (category thought_level), when it has one with this level; otherwise left as it is. */
    private async setEffort(effort: string | undefined) {
        const opt = this.config.find((c) => c.category === "thought_level");
        if (!effort || !opt || opt.currentValue === effort || !optionValues(opt).includes(effort)) return;
        await this.setOption(opt.id, effort);
    }

    private async setOption(configId: string, value: string) {
        const r = await this.rpc.request("session/set_config_option", { sessionId: this.sessionId, configId, value }).catch(said);
        if (Array.isArray(r?.configOptions)) this.config = r.configOptions;
        else for (const c of this.config) if (c.id === configId) c.currentValue = value;
    }

    /** Close its stdin: it finishes and exits (the session then stops the process). */
    async close(): Promise<void> {
        this.proc.end();
    }

    private emit(event: AgentEvent) {
        this.events({ t: "turn_event", ...(this.turn ? { ref: this.turn.ref } : {}), event });
    }

    private onNotification(method: string, p: any) {
        // A subagent starting, said in whichever session started it (a subagent's own, for one it starts).
        const sub = this.replaying ? undefined : this.agent.gate?.subagent?.(method, p);
        if (sub) this.children.set(sub.sessionId, sub.label);
        if (this.replaying || !p || p.sessionId !== this.sessionId) return;
        if (method !== "session/update") {
            if (this.turn && !this.turn.ended && this.agent.interject) this.ownPrompt(this.turn, method, p);
            // Its own (Grok's _x.ai/...): mostly for its own UI, so quietly dropped, but for what it says the user should hear.
            const notice = this.turn && !this.turn.ended ? this.agent.notice?.(method, p) : undefined;
            if (notice) this.emit({ type: "notice", level: "warn", message: notice });
            return;
        }
        const u = p.update ?? {};
        switch (u.sessionUpdate) {
            case "config_option_update":
                if (Array.isArray(u.configOptions)) this.config = u.configOptions;
                return;
            case "current_mode_update":
                if (typeof u.currentModeId === "string") this.modeId = u.currentModeId;
                return;
            case "usage_update": {
                if (typeof u.used === "number" || typeof u.size === "number") this.context = { used: u.used, size: u.size };
                const c = u.cost;
                if (this.turn && !this.turn.ended && c && c.currency === "USD" && typeof c.amount === "number") this.turn.cost = c.amount;
                return;
            }
        }
        const turn = this.turn;
        // Between turns (a late update, or one after its answer): not a turn's. Nor one of an ended prompt's that was
        // still on its way when the next began (its answer and what follows it come in one read).
        if (!turn || turn.ended) return;
        const promptId = p._meta?.promptId;
        if (typeof promptId === "string" && this.endedPrompts.includes(promptId)) return;
        // Its prompt's id, before its answer says it (Interject.record).
        if (typeof promptId === "string") turn.promptId ??= promptId;
        // It speaks in a step begun after one of its tools ended: that step took what was queued before (Interject).
        if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk") for (const x of turn.untaken) x.taken ||= x.after;
        switch (u.sessionUpdate) {
            case "agent_message_chunk":
                if (u.content?.type !== "text" || typeof u.content.text !== "string" || !u.content.text) return;
                if (u.messageId !== turn.messageId) this.flushText(turn);
                turn.messageId = u.messageId;
                turn.text += u.content.text;
                return this.emit({ type: "text", text: u.content.text });
            case "agent_thought_chunk":
                if (u.content?.type === "text" && typeof u.content.text === "string" && u.content.text) this.emit({ type: "thinking", text: u.content.text });
                return;
            case "tool_call":
            case "tool_call_update":
                return this.onTool(turn, u);
        }
    }

    /** What was said so far, as a message of its own (before a tool, at the end). */
    private flushText(turn: Turn) {
        const text = turn.text;
        turn.text = "";
        if (text.trim()) this.emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], provider: this.def.id, model: this.currentModel() ?? "default" } });
    }

    private onTool(turn: Turn, u: any) {
        const id = typeof u.toolCallId === "string" ? u.toolCallId : "";
        if (!id) return;
        let t = turn.tools.get(id);
        if (!t) turn.tools.set(id, (t = { id }));
        merge(t, u);
        // A command that failed ran too (it may have done something first), unless it says it never ran. Not an edit
        // that failed: OpenCode fails some before asking ("must read file first").
        const ran = t.status === "completed" || (t.status === "in_progress" && Boolean(u.content?.length)) || (t.status === "failed" && t.kind === "execute" && !notRun(t));
        // Not while pending: its first update may say little (OpenCode's: no input), and its row would keep that.
        if (t.status === "in_progress" || t.status === "completed" || t.status === "failed") this.startTool(turn, t);
        const wire = ran && !t.noted && !turn.asked.has(id) && !turn.cancelling && !turn.tripped && CHANGES.has(t.kind ?? "") && !this.agent.readOnly?.(t, this.sessionId) ? this.tripwire(this.host.mode()) : undefined;
        if (wire === "stop") {
            turn.tripped = `${this.def.name} ran \`${t.call?.title ?? t.title ?? id}\` without asking ${APP_TITLE}, so the turn was stopped. Its own permission settings may be overriding ${APP_TITLE}'s.`;
            liveDebug("acp", "tripwire", { id, kind: t.kind });
            void this.cancel(turn);
            // Held to the interrupt's deadline: unanswered, the turn ends with why, and the process goes.
            this.events({ t: "stop", ref: turn.ref, error: turn.tripped });
        } else if (wire === "notice") {
            t.noted = true;
            const what = t.call?.name === "Bash" ? String(t.call.input.command) : (t.call?.title ?? t.title ?? id);
            liveDebug("acp", "tripwire notice", { id, kind: t.kind });
            this.emit({ type: "notice", level: "info", message: `${this.def.name} ran \`${what}\` without asking ${APP_TITLE}, as its own settings allow.` });
        }
        if (t.status === "completed" || t.status === "failed") {
            turn.gated.delete(gateKey(this.sessionId!, id));
            this.endTool(turn, t, t.status === "failed");
            for (const x of turn.untaken) if (!x.pending) x.after = true;
        }
    }

    private tripwire(mode: PermissionMode): "stop" | "notice" | undefined {
        if (this.agent.tripwire) return this.agent.tripwire(mode);
        return mode !== "bypassPermissions" ? "stop" : undefined;
    }

    /** Its row, as its updates say so far, or `as` the gate checked it. */
    private startTool(turn: Turn, t: ToolState, as?: { name: string; input: Record<string, unknown> }) {
        if (t.call) return;
        this.flushText(turn);
        const { name, input } = as ?? cavvyTool(t, this.cwd);
        t.call = { name, input, title: name === t.title || !CAVVY_TOOLS.has(name) ? (t.title ?? name) : titleFor(name, input), started: Date.now() };
        this.emit({ type: "tool_start", call: { type: "tool_call", id: t.id, name, input }, title: t.call.title });
    }

    private endTool(turn: Turn, t: ToolState, isError: boolean, content?: string) {
        this.startTool(turn, t);
        turn.tools.delete(t.id);
        const c = t.call!;
        const { text, display } = toolOutput(t, this.cwd);
        this.emit({ type: "tool_end", call: { type: "tool_call", id: t.id, name: c.name, input: c.input }, result: { content: content ?? (text || (isError ? "Failed" : "Done")), isError, ...(display ? { display } : {}) }, durationMs: Date.now() - c.started });
    }

    /** One of the turn's prompts answered: the turn ends once all have (settleTurn). */
    private answer(turn: Turn, r: any, own: boolean, group?: number) {
        if (turn.ended) return;
        turn.open--;
        this.noteEnded(r?._meta?.promptId);
        turn.answers.push({ r, group });
        // Its run is over (its folded prompts' answers may still be on their way).
        if (group !== undefined) turn.closed = Math.max(turn.closed ?? 0, group);
        if (own && typeof r?._meta?.promptId === "string") turn.promptId = r._meta.promptId;
        if (own) this.ownAnswered(turn);
        this.settleTurn(turn);
    }

    /** A prompt it said ended: its updates still on their way aren't the next turn's. */
    private noteEnded(promptId: unknown) {
        if (typeof promptId === "string" && !this.endedPrompts.includes(promptId)) this.endedPrompts = [...this.endedPrompts.slice(-7), promptId];
    }

    /** The turn's own prompt answered: nothing more steers it. A steer sent by the agent's own request may yet run as a prompt of its own: watched for a moment. */
    private ownAnswered(turn: Turn) {
        turn.answered = true;
        this.watchOwn(turn);
    }

    /** For a moment from now, a steer sent by the agent's own request may start as a prompt of its own: the turn waits. */
    private watchOwn(turn: Turn) {
        const how = this.agent.interject;
        if (!how || !turn.interjected.length || turn.cancelling) return;
        turn.watchUntil = Date.now() + how.graceMs;
        setTimeout(() => this.settleTurn(turn), how.graceMs);
    }

    /** One of the agent's own notifications about a prompt it runs of its own for a steer that came as the turn was ending (Interject). */
    private ownPrompt(turn: Turn, method: string, p: any) {
        const how = this.agent.interject!;
        const started = how.started(method, p);
        if (started && !turn.own.has(started.id) && !this.endedPrompts.includes(started.id) && turn.interjected.includes(started.text)) {
            turn.own.add(started.id);
            turn.interjected.splice(turn.interjected.indexOf(started.text), 1);
            const i = turn.untaken.findIndex((x) => x.text === started.text);
            if (i >= 0) turn.untaken.splice(i, 1);
            liveDebug("acp", "a steer runs as a prompt of its own: the turn waits for it", { ref: turn.ref, id: started.id });
            // Stopped meanwhile: it goes too.
            if (turn.cancelling) void this.rpc.notify("session/cancel", { sessionId: this.sessionId });
            return;
        }
        const ended = how.ended(method, p);
        if (ended && turn.own.delete(ended.id)) {
            this.noteEnded(ended.id);
            turn.answers.push({ r: ended.answer });
            this.settleTurn(turn);
        }
    }

    /** The turn ends once its own prompt and every one steering it have answered, and nothing is still being sent. */
    private settleTurn(turn: Turn) {
        if (turn.ended || this.turn !== turn || turn.open > 0 || turn.draining || turn.acking > 0 || turn.own.size || turn.deciding) return;
        if (!turn.answered && turn.failed === undefined) return;
        if (!turn.cancelling && turn.watchUntil && Date.now() < turn.watchUntil) return;
        if (turn.failed !== undefined) return this.finish(turn, "error", turn.tripped ?? this.failure(turn.failed));
        this.endTurn(turn);
    }

    private endTurn(turn: Turn) {
        const answers = turn.answers;
        // The worst of their stop reasons: OpenCode answers prompts folded together alike.
        const stops = answers.map(({ r }) => String(r?.stopReason ?? "end_turn"));
        const stop = ["cancelled", "refusal", "max_turn_requests", "max_tokens"].find((x) => stops.includes(x)) ?? "end_turn";
        const stopped = stop === "cancelled" || turn.cancelling;
        // What it took, from its own record, before anything ends.
        if (stopped && turn.decided === undefined && this.agent.interject?.record && turn.untaken.length) return void this.decide(turn);
        this.recordAnswers(turn, answers);
        if (stopped) this.handBack(turn, turn.decided ? { taken: turn.decided, exact: true } : undefined);
        let reason: TurnEndReason = "done";
        let error: string | undefined;
        if (turn.tripped) [reason, error] = ["error", turn.tripped];
        // It ended the turn at a no of Cavvy's (Grok does, as cancelled): the user's turn, not an interruption. The
        // no reached it without the user's words (ACP has no room for them).
        else if (stop === "cancelled" && !turn.cancelling && turn.refused) this.emit({ type: "notice", level: "info", message: `${this.def.name} stopped at the refusal. Say what to do instead.` });
        // Stopped (Esc, or a no that ends it), however it ended the turn itself.
        else if (stop === "cancelled" || turn.cancelling) reason = "aborted";
        else if (stop === "max_turn_requests") reason = "max_turns";
        else if (stop === "refusal") [reason, error] = ["error", `${this.def.name} refused to go on with this request.`];
        else if (stop === "max_tokens") this.emit({ type: "notice", level: "warn", message: `${this.def.name} stopped at its output limit.` });
        this.finish(turn, reason, error);
    }

    /** A prompt of the turn's failed: its own, the turn fails once the rest have answered (OpenCode answers them alike); a steer's is said. */
    private answerFailed(turn: Turn, e: unknown, own: boolean) {
        // The process went: the session ends the turn with why (its exit and stderr).
        if (turn.ended || e instanceof AcpGone) return;
        turn.open--;
        if (own) turn.failed = e;
        else turn.answers.push({ r: { error: e } });
        this.settleTurn(turn);
    }

    /**
     * Tokens of the turn's answers, counted once: prompts folded together answer with the same (OpenCode's), and a
     * steer's error says why it didn't go. Those run apart count each, however alike.
     */
    private recordAnswers(turn: Turn, answers: Turn["answers"]) {
        const seen = new Set<string>();
        const total: Usage = { inputTokens: 0, outputTokens: 0 };
        let contextTokens: number | undefined;
        for (const { r, group } of answers) {
            if (r?.error !== undefined) {
                if (turn.failed === undefined && !turn.cancelling) this.emit({ type: "notice", level: "warn", message: `${this.def.name} didn't take a message sent to steer the turn: ${errorText(r.error)}` });
                continue;
            }
            const own = this.agent.usage?.(r);
            const u = own?.usage ?? acpUsage(r?.usage);
            const key = `${group}\n${JSON.stringify(u)}`;
            if (group !== undefined && seen.has(key)) continue;
            seen.add(key);
            for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) if (u[k]) total[k] = (total[k] ?? 0) + u[k]!;
            contextTokens = own?.contextTokens ?? contextTokens;
        }
        this.recordUsage(turn, total, contextTokens);
    }

    /** What an error answer to a prompt says, for the user. */
    private failure(e: unknown): string {
        const text = errorText(e);
        if ((e instanceof AcpError && e.code === -32000) || /\b(auth(entication|orization)? (required|failed)|unauthori[sz]ed|not (signed|logged) in|sign in|log ?in)\b/i.test(text)) {
            return `${this.def.name} isn't signed in: ${text}. Sign in with \`${this.def.cli.signIn}\`, then try again.`;
        }
        return `${this.def.name}: ${text}`;
    }

    private finish(turn: Turn, reason: TurnEndReason, error?: string) {
        turn.ended = true;
        turn.gated.clear();
        for (const w of [...turn.waiting]) w(CANCELLED);
        this.flushText(turn);
        // What never ended (the turn was stopped, or it said nothing more of them).
        for (const t of [...turn.tools.values()]) if (t.call) this.endTool(turn, t, true, "Cancelled: the turn ended before it finished.");
        this.events({ t: "turn_ended", ref: turn.ref, reason, ...(error ? { error } : {}) });
        if (this.turn === turn) this.turn = undefined;
    }

    /** Tokens as it reports them; its cost only as it reports it, in USD (the session's running total, so this turn's is the difference). */
    private recordUsage(turn: Turn, usage: Usage, contextTokens?: number) {
        if (turn.cost !== undefined) {
            if (this.costSoFar !== undefined && turn.cost >= this.costSoFar) usage.cost = turn.cost - this.costSoFar;
            this.costSoFar = turn.cost;
        }
        if (!usage.inputTokens && !usage.outputTokens && !usage.cacheReadTokens && !usage.cost) return;
        const model = this.currentModel();
        if (model) usage.resolvedModel = `${this.def.id}:${model}`;
        const used = this.context?.used || contextTokens;
        // Its window from usage_update, or from the model's listing (Grok's _meta.totalContextTokens).
        const listed = this.models?.availableModels?.find((m) => m?.modelId === model)?._meta?.totalContextTokens;
        const size = this.context?.size || (typeof listed === "number" && listed > 0 ? listed : undefined);
        this.host.usage(usage, { ...(used ? { contextTokens: used } : {}), ...(size ? { contextWindow: size } : {}) });
    }

    /** Its output ended: a turn still going ends with the process (LiveCliSession says why), with what it said so far and its tools closed. */
    private lost() {
        this.gone = true;
        const turn = this.turn;
        if (!turn || turn.ended) return;
        // Its record was being waited for: handed back now, while the turn's steering is still there.
        if (turn.deciding) this.handBackNow(turn);
        for (const w of [...turn.waiting]) w(CANCELLED);
        this.flushText(turn);
        for (const t of [...turn.tools.values()]) if (t.call) this.endTool(turn, t, true, `Cancelled: ${this.def.name} stopped before it finished.`);
    }

    private async onRequest(method: string, p: any): Promise<unknown> {
        if (this.agent.gate && method === this.agent.gate.method) return this.gateRequest(p);
        switch (method) {
            case "session/request_permission":
                return this.permission(p);
            case "fs/write_text_file":
                // Not offered, yet OpenCode sends one after writing the file itself (ask-check.jsonl): what's there already is a yes.
                if (typeof p?.path === "string" && typeof p.content === "string" && isAbsolute(p.path) && holds(p.path, p.content)) return {};
                throw new AcpError(`${APP_TITLE} doesn't write files for agents`, METHOD_NOT_FOUND);
            default:
                throw new AcpError(`${APP_TITLE} doesn't offer ${method}`, METHOD_NOT_FOUND);
        }
    }

    /** An ask: through Cavvy's rules and mode. Allow once (Cavvy keeps "always" itself); anything it can't check is refused. */
    private async permission(p: any): Promise<unknown> {
        const turn = this.turn;
        const toolCall = p?.toolCall;
        const options: any[] = Array.isArray(p?.options) ? p.options : [];
        const option = (kind: string) => options.find((o) => o?.kind === kind && typeof o.optionId === "string")?.optionId as string | undefined;
        const reject = () => {
            const id = option("reject_once");
            return id ? { outcome: { outcome: "selected", optionId: id } } : CANCELLED;
        };
        // Whichever session asks (one of its sub-agents' too), Cavvy's rules decide; between turns nothing may run.
        if (!turn || turn.ended || turn.cancelling) return CANCELLED;
        const id = typeof toolCall?.toolCallId === "string" ? toolCall.toolCallId : "";
        if (id) turn.asked.add(id);
        // The gate let it go by Cavvy's decision just now (Grok asks right after, in its default mode): yes, once, for
        // that call as it was checked, in the mode it was checked in. Otherwise (the mode changed since) it's checked again.
        const sessions = [p?.sessionId, toolCall?._meta?.["x.ai/requestingSessionId"]].filter((s): s is string => typeof s === "string");
        const gated = id ? sessions.map((s) => gateKey(s, id)).find((k) => turn.gated.has(k)) : undefined;
        const checked = gated ? turn.gated.get(gated) : undefined;
        if (gated) turn.gated.delete(gated);
        const once = option("allow_once");
        if (checked && once && checked.mode === this.host.mode() && this.sameCall(checked, toolCall)) {
            liveDebug("acp", "ask about a call the gate allowed: yes", { id });
            return { outcome: { outcome: "selected", optionId: once } };
        }
        const known = id ? turn.tools.get(id) : undefined;
        // Cavvy's own tool (EnterWorktree): checked when it runs, as Cavvy's own call is.
        if (once && servedCall({ title: toolCall?.title ?? known?.title, rawInput: toolCall?.rawInput ?? known?.rawInput })) {
            liveDebug("acp", "ask about Cavvy's own tool: yes", { id });
            return { outcome: { outcome: "selected", optionId: once } };
        }
        if (id && !known?.call) {
            // Asked about before any update said what it is: its row starts from the ask.
            const t = known ?? { id };
            merge(t, toolCall);
            turn.tools.set(id, t);
            this.startTool(turn, t);
        }
        const req = permissionFor(this.def, toolCall, known, this.cwd);
        if (!req) {
            this.emit({ type: "notice", level: "warn", message: `Refused something ${this.def.name} asked about: ${APP_TITLE} can't tell what it would do, so it can't check it against your rules.` });
            turn.refused = true;
            return reject();
        }
        // Its own plan file, in plan mode, checked here again (a yes at the gate to one it cut isn't kept): as there, deny rules and Cavvy's protections only.
        const path = typeof req.input.file_path === "string" ? req.input.file_path : undefined;
        const plan = this.host.mode() === "plan" && path && (req.toolName === "Write" || req.toolName === "Edit") && !req.otherPaths?.length && !("operation" in req.input) && this.agent.gate?.planFile?.(path, this.sessionId);
        const asked: BackendPermission = { ...req, asksAlways: true, ...(plan ? { exempt: true, planFile: path } : {}), ...(this.host.mode() === "bypassPermissions" ? { hooksOnly: true } : {}), ...(id ? { callId: id } : {}) };
        let settle!: (outcome: Record<string, unknown>) => void;
        const stopped = new Promise<Record<string, unknown>>((r) => (settle = r));
        turn.waiting.add(settle);
        try {
            const a = await Promise.race([this.host.permission(asked), stopped]);
            if (!("allow" in a)) return a;
            const answer = a as PermissionAnswer;
            if (turn.ended || turn.cancelling) return CANCELLED;
            // A hook's rewrite: the agent runs the call as it asked, so neither runs.
            if (answer.allow && rewritten(answer, req.input)) {
                this.emit({ type: "notice", level: "warn", message: `Refused ${this.def.name}'s \`${req.title ?? req.toolName}\`: ${this.cantRewrite()}` });
                turn.refused = true;
                return reject();
            }
            if (answer.allow) {
                const once = option("allow_once");
                return once ? { outcome: { outcome: "selected", optionId: once } } : reject();
            }
            // A no that ends the turn (the user says what to do instead).
            if (answer.stop) this.stopAtNo(turn, settle);
            turn.refused = true;
            return reject();
        } catch {
            return reject();
        } finally {
            turn.waiting.delete(settle);
        }
    }

    /**
     * A no that ends the turn (the user says what to do instead): it's stopped from now, whatever else it waits on is
     * cancelled, and session/cancel follows the no (after its answer has gone).
     */
    private stopAtNo(turn: Turn, except?: (outcome: Record<string, unknown>) => void) {
        if (turn.cancelling) return;
        turn.cancelling = true;
        for (const w of [...turn.waiting]) if (w !== except) w(CANCELLED);
        // Not once the turn has ended: it would stop the next.
        setTimeout(() => void (turn.ended || this.rpc.notify("session/cancel", { sessionId: this.sessionId })), 0);
        this.events({ t: "stop", ref: turn.ref });
    }

    /**
     * A tool call the agent's gate holds (AcpAgent.gate), its subagents' too: decided by Cavvy's rules and the mode
     * now, as an ask would be. The agent goes on without an answer once it has waited long enough, or with one it
     * can't read, so it always gets a valid one, in time (gateDeadlineMs): whatever goes wrong refuses the call.
     */
    private async gateRequest(p: any): Promise<Record<string, unknown>> {
        const gate = this.agent.gate!;
        let call: GateCall | undefined;
        try {
            call = gate.call(p);
        } catch (e) {
            this.emit({ type: "notice", level: "warn", message: `Refused a tool call of ${this.def.name}'s: ${APP_TITLE} couldn't read it (${errorText(e)}).` });
            return gate.deny(`${APP_TITLE} couldn't read this call, so it was refused.`);
        }
        if (!call) return gate.allow();
        const turn = this.turn;
        // Between turns nothing may run.
        if (!turn || turn.ended) return gate.deny(`${APP_TITLE} isn't running a turn, so nothing may run now.`);
        if (turn.cancelling || turn.tripped) return gate.deny(TURN_STOPPED);
        const withdraw = new AbortController();
        let settle!: (d: GateDecision) => void;
        const decided = new Promise<GateDecision>((r) => (settle = r));
        const timer = setTimeout(() => settle({ allow: false, reason: `No answer from ${APP_TITLE} in time`, late: true }), gateDeadlineMs(gate.timeoutS));
        const stopped = () => settle({ allow: false, reason: TURN_STOPPED });
        turn.waiting.add(stopped);
        const what = call.toolName;
        this.gateDecide(turn, call, withdraw.signal).then(settle, (e) => {
            liveDebug("acp", "gate failed", { id: call.toolUseId, error: errorText(e) });
            this.emit({ type: "notice", level: "warn", message: `Refused ${this.def.name}'s \`${what}\` call: ${APP_TITLE} couldn't check it (${errorText(e)}).` });
            settle({ allow: false, reason: `${APP_TITLE} couldn't check this call, so it was refused.` });
        });
        let d: GateDecision;
        try {
            d = await decided;
        } finally {
            clearTimeout(timer);
            turn.waiting.delete(stopped);
            // A prompt still open (no answer in time, or the turn stopped) is withdrawn.
            withdraw.abort();
        }
        const main = call.sessionId === this.sessionId;
        if (call.toolUseId) {
            // The tripwire's: the gate saw it.
            turn.asked.add(call.toolUseId);
            // Not one checked on a cut input: what it asks about after may be anything that was cut.
            if (d.allow && d.decided && d.checked && !call.truncated) turn.gated.set(gateKey(call.sessionId, call.toolUseId), d.checked);
        }
        liveDebug("acp", "gate", { id: call.toolUseId, tool: what, allow: d.allow, main });
        if (!d.allow) {
            if (d.late) this.emit({ type: "notice", level: "warn", message: `${this.def.name} waited too long for an answer about \`${what}\`, so ${APP_TITLE} refused it.` });
            // A no that ends the turn, by the user, about a call of its own (a subagent's no is that subagent's).
            if (d.stop && main) this.stopAtNo(turn);
            return gate.deny(d.reason);
        }
        // Stopped meanwhile: nothing more runs.
        if (turn.ended || turn.cancelling) return gate.deny(TURN_STOPPED);
        return gate.allow();
    }

    /** A gated call, decided: let go in auto (the agent's reviewer decides), otherwise as an ask is (permission). */
    private async gateDecide(turn: Turn, call: GateCall, signal: AbortSignal): Promise<GateDecision> {
        const mode = this.host.mode();
        if (mode === "auto") return { allow: true, decided: false };
        const gate = this.agent.gate!;
        const main = call.sessionId === this.sessionId;
        const own = gate.tool(call, this.cwd);
        if (own?.refuse) return { allow: false, reason: own.refuse };
        // Cavvy's own tool (EnterWorktree): checked when it runs, as Cavvy's own call is.
        if (own && servedWorktreeName(own.toolName)) return { allow: true, decided: false };
        const label = main ? undefined : (this.children.get(call.sessionId) ?? call.subagentType ?? `${this.def.name} subagent`);
        /** One the mode doesn't decide: unasked, and Plan doesn't refuse it, but deny rules and Cavvy's protections do. */
        const exempt = async (r: GateTool, decided: boolean, planFile?: string): Promise<GateDecision> => {
            const a = await this.host.permission({ toolName: r.toolName, input: r.input, asksAlways: true, exempt: true, ...(planFile ? { planFile } : {}), ...(call.truncated ? { incomplete: true } : {}), ...(label ? { agentLabel: label } : {}), signal });
            if (!a.allow) return { allow: false, reason: a.message || "Denied.", stop: a.stop };
            return { allow: true, decided, ...(decided ? { checked: { toolName: r.toolName, input: r.input, mode } } : {}) };
        };
        // Its own bookkeeping goes; an ask about it that follows (its plan's approval, say) is still Cavvy's.
        if (own?.free) return exempt(own, false);
        // One of its own tools, Cavvy has none for: checked by the agent's name, with all it says (all of it).
        if (!own && call.truncated) return { allow: false, reason: `Its input is too long for ${APP_TITLE} to check in full.` };
        const req: GateTool = own ?? { toolName: this.def.name, input: call.input, title: `${this.def.name} asks to use ${call.toolName}` };
        const path = typeof req.input.file_path === "string" ? req.input.file_path : undefined;
        // Its own plan file, in plan mode (Cavvy's plan mode refuses every other write).
        if (mode === "plan" && path && (req.toolName === "Write" || req.toolName === "Edit") && gate.planFile?.(path, this.sessionId)) return exempt(req, true, path);
        // Its row, from the gate (an ask makes it wait). A subagent's calls have none.
        if (main && call.toolUseId) {
            const t = turn.tools.get(call.toolUseId) ?? { id: call.toolUseId };
            turn.tools.set(call.toolUseId, t);
            const shown = req.toolName === "Write" || req.toolName === "Edit" ? { file_path: path } : req.input;
            this.startTool(turn, t, own ? { name: req.toolName, input: shown } : undefined);
        }
        const bypass = mode === "bypassPermissions";
        const asked: BackendPermission = {
            toolName: req.toolName,
            input: req.input,
            ...(req.title ? { title: req.title } : {}),
            ...(req.reason ? { reason: req.reason } : {}),
            asksAlways: true,
            ...(bypass ? { hooksOnly: true } : own?.elsewhere ? { hookDecision: "ask" as const } : {}),
            ...(main && call.toolUseId ? { callId: call.toolUseId } : {}),
            ...(label ? { agentLabel: label } : {}),
            // Checked on what Grok left of it: a yes isn't remembered for what was cut.
            ...(call.truncated ? { incomplete: true } : {}),
            signal,
        };
        const a = await this.host.permission(asked);
        // A hook's rewrite: the agent runs the call as it asked, so neither runs.
        if (a.allow && rewritten(a, req.input)) return { allow: false, reason: this.cantRewrite() };
        if (a.allow) return { allow: true, decided: true, checked: { toolName: req.toolName, input: req.input, mode } };
        return { allow: false, reason: a.message || "Denied.", stop: a.stop };
    }

    private cantRewrite(): string {
        return `A hook rewrote this call, and ${this.def.name} can only run the call as it asked, so neither the rewrite nor the original ran.`;
    }

    /** An ask (its toolCall) is about the call the gate checked: as Cavvy's tool the same, with the same input (no more, no less). */
    private sameCall(checked: Checked, toolCall: any): boolean {
        const gate = this.agent.gate;
        const call = gate?.asked?.(toolCall);
        if (!gate || !call) return false;
        const now = gate.tool(call, this.cwd) ?? { toolName: this.def.name, input: call.input };
        const keys = new Set([...Object.keys(checked.input), ...Object.keys(now.input)]);
        return now.toolName === checked.toolName && [...keys].every((k) => stableStringify(now.input[k]) === stableStringify(checked.input[k]));
    }
}

/** A hook approved other input than was asked about. */
function rewritten(a: Extract<PermissionAnswer, { allow: true }>, input: Record<string, unknown>): boolean {
    return a.updatedInput !== undefined && stableStringify(a.updatedInput) !== stableStringify(input);
}

/** Cavvy's tools an agent's calls show as, by their kind: their titles and rows are Cavvy's. */
const CAVVY_TOOLS = new Set(["Bash", "Edit", "Write", "Read", "Grep", "Glob", "WebFetch", "WebSearch", "Task"]);

function merge(t: ToolState, u: any) {
    if (typeof u.kind === "string") t.kind = u.kind;
    if (typeof u.title === "string" && u.title) t.title = u.title;
    if (typeof u.status === "string") t.status = u.status;
    if (u.rawInput && typeof u.rawInput === "object" && Object.keys(u.rawInput).length) t.rawInput = u.rawInput;
    if (Array.isArray(u.locations) && u.locations.length) t.locations = u.locations.filter((l: any) => typeof l?.path === "string");
    if (Array.isArray(u.content) && u.content.length) t.content = u.content;
    if (u.rawOutput !== undefined) t.rawOutput = u.rawOutput;
    if (u._meta && typeof u._meta === "object") t._meta = { ...t._meta, ...u._meta };
}

/** A failed call that says it never ran: refused (OpenCode's "The user rejected permission…", Grok's _meta.toolNotRun). */
function notRun(t: ToolState): boolean {
    return Boolean(t._meta?.toolNotRun) || (t.content ?? []).some((c) => typeof c?.content?.text === "string" && c.content.text.startsWith("The user rejected permission"));
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const abs = (p: string, cwd: string) => (isAbsolute(p) ? p : resolve(cwd, p));

/** The paths a call names: its input's, then its locations'. */
function pathsOf(raw: Record<string, any> | undefined, locations: { path: string }[] | undefined, cwd: string): string[] {
    const out: string[] = [];
    for (const k of ["filePath", "filepath", "file_path", "target_file", "path"]) if (str(raw?.[k])) out.push(raw![k]);
    for (const l of locations ?? []) out.push(l.path);
    return [...new Set(out.map((p) => abs(p, cwd)))];
}

/**
 * A call of Cavvy's own MCP tools (its worktree tools), by its MCP name: Grok's goes through its use_tool (the tool's
 * name and arguments in its input), OpenCode's is named for the tool. Cavvy checks it as it runs, as its own call.
 */
function servedCall(t: Pick<ToolState, "title" | "rawInput">): { name: string; input: Record<string, unknown> } | undefined {
    const raw = t.rawInput ?? {};
    const viaUse = servedWorktreeName(raw.tool_name);
    if (viaUse) return { name: `mcp__${APP_NAME}__${viaUse}`, input: raw.tool_input && typeof raw.tool_input === "object" && !Array.isArray(raw.tool_input) ? raw.tool_input : {} };
    const named = servedWorktreeName(t.title);
    return named ? { name: `mcp__${APP_NAME}__${named}`, input: raw } : undefined;
}

/** A call as one of Cavvy's tools, by its kind; another kind as its own name. */
function cavvyTool(t: ToolState, cwd: string): { name: string; input: Record<string, unknown> } {
    const raw = t.rawInput ?? {};
    const served = servedCall(t);
    if (served) return served;
    const path = pathsOf(raw, t.locations, cwd)[0];
    switch (t.kind) {
        case "execute":
            return str(raw.command) ? { name: "Bash", input: { command: raw.command, ...(str(raw.description) ? { description: raw.description } : {}) } } : { name: t.title ?? "command", input: raw };
        case "edit":
            if (!path) break;
            return typeof raw.content === "string" && raw.oldString === undefined ? { name: "Write", input: { file_path: path } } : { name: "Edit", input: { file_path: path } };
        case "read":
            if (path) return { name: "Read", input: { file_path: path } };
            break;
        case "fetch":
            if (str(raw.url)) return { name: "WebFetch", input: { url: raw.url } };
            break;
        case "search":
            if (str(raw.pattern)) return { name: "Grep", input: { pattern: raw.pattern, ...(path ? { path } : {}) } };
            break;
    }
    return { name: t.title ?? t.kind ?? "tool", input: raw };
}

/** What a finished call said, and a diff to show for an edit. */
function toolOutput(t: ToolState, cwd: string): { text: string; display?: ToolDisplay } {
    const parts: string[] = [];
    let display: ToolDisplay | undefined;
    for (const c of t.content ?? []) {
        if (c?.type === "content" && c.content?.type === "text" && typeof c.content.text === "string") parts.push(c.content.text);
        else if (c?.type === "diff" && typeof c.path === "string" && typeof c.newText === "string") {
            const path = abs(c.path, cwd);
            display = { diff: { path: path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path, before: typeof c.oldText === "string" ? c.oldText : "", after: c.newText } };
            parts.push(`Edited ${path}`);
        }
    }
    if (!parts.length && typeof t.rawOutput?.error === "string") parts.push(t.rawOutput.error);
    return { text: parts.join("\n"), ...(display ? { display } : {}) };
}

/**
 * A permission request as Cavvy's: a command as Bash, a change as Edit or Write of each path it names (Write with
 * its content when it says the file's whole new content; a delete or move as Edit with its `operation`), a fetch as
 * WebFetch, anything else as the agent's own tool by its title. Undefined when it can't be checked (no command, no
 * path, no address): refused.
 */
export function permissionFor(def: AgentCliDef, toolCall: any, known: Pick<ToolState, "kind" | "rawInput" | "locations" | "content"> | undefined, cwd: string): Omit<BackendPermission, "asksAlways" | "hooksOnly"> | undefined {
    if (!toolCall || typeof toolCall !== "object") return undefined;
    const kind = str(toolCall.kind) ?? known?.kind;
    const raw: Record<string, any> = toolCall.rawInput && typeof toolCall.rawInput === "object" ? toolCall.rawInput : (known?.rawInput ?? {});
    const locations = Array.isArray(toolCall.locations) && toolCall.locations.length ? toolCall.locations.filter((l: any) => typeof l?.path === "string") : known?.locations;
    const title = str(toolCall.title);
    switch (kind) {
        case "execute": {
            const command = str(raw.command) ?? str(known?.rawInput?.command);
            return command ? { toolName: "Bash", input: { command }, title } : undefined;
        }
        case "edit":
        case "delete":
        case "move": {
            const paths = pathsOf(raw, locations, cwd);
            for (const k of ["source", "destination", "from", "to", "oldPath", "newPath"]) if (str(raw[k])) paths.push(abs(raw[k], cwd));
            const all = [...new Set(paths)];
            if (!all.length) return undefined;
            // Its diff: in the ask, or (Grok's) in the update before it.
            const content: any[] = Array.isArray(toolCall.content) && toolCall.content.length ? toolCall.content : (known?.content ?? []);
            const diff = content.find((c: any) => c?.type === "diff" && typeof c.newText === "string");
            const rel = (p: string) => (p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p);
            const preview: ToolDisplay | undefined = kind === "delete" ? { summary: "Deletes the file" } : diff ? { diff: { path: rel(abs(String(diff.path ?? all[0]), cwd)), before: typeof diff.oldText === "string" ? diff.oldText : "", after: diff.newText } } : undefined;
            // Cavvy remembers a yes by tool and input: an edit whose whole new content it says is a Write of that
            // content, so the yes covers only that; a delete or move says so, so a yes to an edit doesn't cover it.
            const full = diff ? diff.newText : typeof raw.content === "string" && raw.oldString === undefined && raw.old_string === undefined ? raw.content : undefined;
            const input = kind === "edit" && full !== undefined ? { file_path: all[0], content: full } : { file_path: all[0], ...(kind === "edit" ? {} : { operation: kind }) };
            return { toolName: "content" in input ? "Write" : "Edit", input, title, otherPaths: all.slice(1), ...(all.length > 1 ? { reason: `This change also writes ${all.slice(1).join(", ")}.` } : {}), ...(preview ? { preview } : {}) };
        }
        case "fetch": {
            const url = str(raw.url);
            return url ? { toolName: "WebFetch", input: { url }, title } : undefined;
        }
    }
    return { toolName: def.name, input: raw, title: title ?? `${def.name} asks to use ${kind ?? "a tool"}` };
}

function optionValues(opt: ConfigOption): string[] {
    const out: string[] = [];
    for (const o of opt.options ?? []) {
        const x = o as any;
        if (typeof x?.value === "string") out.push(x.value);
        // Grouped options: { group, options: [...] }.
        for (const g of Array.isArray(x?.options) ? x.options : []) if (typeof g?.value === "string") out.push(g.value);
    }
    return out;
}

/** The file holds exactly this (an agent's write it reports after making it). */
function holds(path: string, content: string): boolean {
    const want = Buffer.from(content, "utf-8");
    let fd: number | undefined;
    try {
        // Not blocking on a pipe or device it names.
        fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
        const st = fstatSync(fd);
        if (!st.isFile() || st.size !== want.length) return false;
        const buf = Buffer.alloc(want.length);
        return readSync(fd, buf, 0, want.length, 0) === want.length && buf.equals(want);
    } catch {
        return false;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

/** An error answer, rethrown with all it says (Grok's data: "Invalid params (unknown model id)"). */
function said(e: unknown): never {
    throw e instanceof AcpError ? new AcpError(errorText(e), e.code) : e;
}

/** ACP's `usage` on a prompt's answer, in Cavvy's terms. */
function acpUsage(raw: any): Usage {
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
    const usage: Usage = { inputTokens: n(raw?.inputTokens), outputTokens: n(raw?.outputTokens) };
    if (n(raw?.cachedReadTokens)) usage.cacheReadTokens = n(raw.cachedReadTokens);
    if (n(raw?.cachedWriteTokens)) usage.cacheWriteTokens = n(raw.cachedWriteTokens);
    if (n(raw?.thoughtTokens)) usage.reasoningTokens = n(raw.thoughtTokens);
    return usage;
}

function errorText(e: unknown): string {
    if (e instanceof AcpError) {
        const d = e.data as any;
        // Its data says more: a message (OpenCode), or a string (Grok's "Invalid params": "unknown model id").
        const detail = typeof d === "string" ? d : typeof d?.message === "string" ? d.message : undefined;
        const more = detail && detail !== e.message ? ` (${detail})` : "";
        return `${e.message}${more}`;
    }
    return e instanceof Error ? e.message : String(e);
}
