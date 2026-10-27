// Rebuilding a session's timeline from disk, so an opened session looks the
// way it did live: the saved transcript (all of it, including what came
// before a compaction) plus the GUI's own log of what the transcript doesn't
// keep (diffs, summaries, timings, and the steps of turns Claude Code or Codex
// answered, which the transcript keeps as text), in ui/<session>.jsonl next to it.

import { createHash } from "crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { EFFORT_LEVELS, type Effort } from "../config/settings";
import type { Message, ToolCallPart, ToolResultPart, UserMessage } from "../providers/types";
import { textOf, toolCallsOf } from "../providers/types";
import { redact, redactedJson } from "../util/redact";
import { attachedPrompt } from "./attachments";
import { fileDiff, trimInput, truncateText } from "./diffs";
import type { AgentRun, Block, EffortLevel, FileDiff, NoticeBlock, NoticeData, PermissionModeId, ToolBlock, ToolCategoryId, Turn, TurnStatus } from "./protocol";
import { DELEGATE_TOOL } from "../agent/delegation";
import { addNotice, noticesUpTo, turnNotice, type TurnNotice } from "../agent/session";
import { allProviders, getProvider } from "../providers/registry";

/** Tool output sent inline; longer output is fetched when the row is opened. */
export const INLINE_OUTPUT = 4000;

/** Starts the text of a message the user sent while tools were running (agent.ts). */
export const STEERING = "The user sent this message while you were working:\n";

const REMINDERS = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Tells one prompt from another, the same words sent again too (each has its own checkpoint), without keeping its text again. */
export function promptKey(m: UserMessage): string {
    return createHash("sha256").update(JSON.stringify([m.content, m.meta?.checkpoint ?? null])).digest("hex").slice(0, 16);
}

export function promptText(m: UserMessage): string {
    const first = m.content.find((p) => p.type === "text" && !/^<system-reminder>/.test(p.text));
    return (m.meta?.display ?? (first?.type === "text" ? first.text : textOf(m))).replace(REMINDERS, "").trim();
}

// ---------------------------------------------------------------------------
// The transcript, all segments

export interface Segment {
    /** The summary that started this segment (none for the first). */
    summary?: string;
    /** That summary was written while the conversation was idle, before its prompt cache expired. */
    idle?: boolean;
    /** Its message after the summary is the last one before it (a prompt waiting for its answer), moved here. */
    kept?: boolean;
    messages: Message[];
    /** How its turns ended, where the messages don't say (errors, limits). */
    notices?: TurnNotice[];
    /** Where its first messages were imported from (a Claude Code or Codex session). */
    imported?: { source: string; startedAt?: number; omitted: number };
}

/** Every segment of a session file: a compaction starts a new one, a rewind cuts the current one. */
export function readSegments(file: string): Segment[] {
    const segments: Segment[] = [{ messages: [] }];
    let text: string;
    try {
        text = readFileSync(file, "utf-8");
    } catch {
        return segments;
    }
    for (const raw of text.split("\n")) {
        if (!raw) continue;
        let l: { t: string; m?: Message; summary?: string; idle?: boolean; kept?: boolean; count?: number; source?: unknown; startedAt?: unknown; omitted?: unknown } & Partial<TurnNotice>;
        try {
            l = JSON.parse(raw);
        } catch {
            continue;
        }
        const cur = segments[segments.length - 1]!;
        if (l.t === "msg" && l.m) cur.messages.push(l.m);
        else if (l.t === "compact") segments.push({ summary: l.summary ?? "", ...(l.idle === true ? { idle: true } : {}), ...(l.kept === true ? { kept: true } : {}), messages: [] });
        else if (l.t === "rewind" && typeof l.count === "number") {
            cur.messages = cur.messages.slice(0, l.count);
            if (cur.notices) cur.notices = noticesUpTo(cur.notices, l.count);
        } else if (l.t === "withdraw" && typeof l.index === "number" && l.index >= 0 && l.index < cur.messages.length) {
            // As Session.withdraw: the message goes, the notices after it move back one.
            const at = l.index;
            cur.messages.splice(at, 1);
            if (cur.notices) cur.notices = cur.notices.map((n) => (n.index > at ? { ...n, index: n.index - 1 } : n));
        } else if (l.t === "notice") {
            const n = turnNotice(l);
            if (n) addNotice((cur.notices ??= []), n);
        }
        else if (l.t === "import" && typeof l.source === "string") cur.imported = { source: l.source, startedAt: typeof l.startedAt === "number" ? l.startedAt : undefined, omitted: typeof l.omitted === "number" ? l.omitted : 0 };
    }
    return segments;
}

// ---------------------------------------------------------------------------
// The GUI's log

/** The session as the GUI last left it: its permission mode and effort (one chosen for it), and its context after `messages` messages. */
export interface UiState {
    mode?: PermissionModeId;
    effort?: EffortLevel;
    contextTokens?: number;
    messages?: number;
}

/** What changed of a sub-agent, its steps aside: null for what it no longer has (a report, once it runs again). */
export type AgentHead = { [K in keyof Omit<AgentRun, "blocks">]?: AgentRun[K] | null };

export type UiRecord =
    | { t: "tool"; id: string; summary?: string; diff?: FileDiff; diagnostics?: ToolBlock["diagnostics"]; durationMs?: number; approval?: string; sandboxed?: boolean; images?: number; job?: ToolBlock["job"]; at?: number }
    /** A turn's start (no `end`) begins its record afresh; its end adds to it, and so does its prompt's promptKey once that's in the history. */
    | { t: "turn"; seg: number; index: number; at: number; end?: number; status?: TurnStatus; prompt?: string }
    | { t: "pending-turn"; text: string; at: number }
    /**
     * A step of a turn Claude Code or Codex answered, as it was shown
     * (shownStep), written when it's new and again when it changes, so a
     * turn cut off part way (the server stopped or died) keeps what it did.
     * The transcript keeps only the turn's text and a note of what was done,
     * which is what other models are given; this is what the GUI shows
     * again. `after`: the step it follows (null: it's the first). `drop`: a
     * step taken back.
     */
    | { t: "step"; seg: number; index: number; /** promptKey of the prompt it answers. */ prompt?: string; block?: Block; after?: string | null; drop?: string }
    /** A sub-agent of such a turn, likewise: what changed of it (`head`), or one of its steps (agentStep), new or changed. */
    | { t: "agent"; id: string; head?: AgentHead; block?: Block; after?: string | null }
    | ({ t: "state" } & UiState)
    /** Earlier forms of these (a turn's steps all at once; a sub-agent whole), still read. */
    | { t: "blocks"; seg: number; index: number; blocks: Block[]; prompt?: string }
    | { t: "agent"; agent: AgentRun; id?: undefined };

/** A step put where it goes: in place of itself, else after the one it follows (at the end if that one isn't there). */
function place(blocks: Block[], b: Block, after: string | null | undefined) {
    const i = blocks.findIndex((x) => x.id === b.id);
    if (i >= 0) {
        blocks[i] = b;
        return;
    }
    const j = after === null ? 0 : after === undefined ? -1 : blocks.findIndex((x) => x.id === after) + 1;
    blocks.splice(after === null || j > 0 ? j : blocks.length, 0, b);
}

export class UiLog {
    tools = new Map<string, Extract<UiRecord, { t: "tool" }>>();
    turns = new Map<string, Extract<UiRecord, { t: "turn" }>>();
    /** Steps of backends' turns, by where their prompt is ("seg:index"). */
    steps = new Map<string, { blocks: Block[]; prompt?: string }>();
    agents = new Map<string, AgentRun>();
    /** Steps the log no longer keeps of each sub-agent (beyond its latest AGENT_KEPT): a late change to one doesn't bring it back. */
    private evicted = new Map<string, Set<string>>();
    state: UiState = {};
    /** The turn that started last ("seg:index"): it may never have ended. */
    lastStarted?: string;
    private file: string;
    private created = false;
    /** Its session was let go of: another process may be keeping this log now. */
    private closed = false;

    constructor(sessionFile: string, id: string, readExisting = true) {
        this.file = join(dirname(sessionFile), "ui", `${id}.jsonl`);
        if (readExisting) this.read();
    }

    private read() {
        let text: string;
        try {
            text = readFileSync(this.file, "utf-8");
            this.created = true;
        } catch {
            return;
        }
        for (const raw of text.split("\n")) {
            if (!raw) continue;
            try {
                this.apply(JSON.parse(raw) as UiRecord);
            } catch {
                // torn line
            }
        }
    }

    private apply(r: UiRecord) {
        if (r.t === "tool") this.tools.set(r.id, { ...this.tools.get(r.id), ...r });
        else if (r.t === "turn") {
            const k = `${r.seg}:${r.index}`;
            // A turn starting where another was (that one was rewound) owes it nothing.
            const start = r.end === undefined && r.status === undefined && r.prompt === undefined;
            if (start) {
                this.steps.delete(k);
                this.lastStarted = k;
            }
            this.turns.set(k, start ? r : { ...this.turns.get(k), ...r });
        } else if (r.t === "step") {
            const k = `${r.seg}:${r.index}`;
            let s = this.steps.get(k);
            // Another prompt's (one sent there where this log wasn't kept) start afresh.
            if (!s || s.prompt !== r.prompt) this.steps.set(k, (s = { blocks: [], prompt: r.prompt }));
            if (typeof r.drop === "string") s.blocks = s.blocks.filter((b) => b.id !== r.drop);
            else if (typeof r.block?.id === "string") place(s.blocks, r.block, r.after);
        } else if (r.t === "agent" && r.id === undefined) {
            if (typeof r.agent?.id === "string") this.agents.set(r.agent.id, r.agent);
        } else if (r.t === "agent" && typeof r.id === "string") {
            let a = this.agents.get(r.id);
            if (r.head) {
                const next: Record<string, unknown> = { ...(a ?? { status: "stopped", startedAt: 0, toolCount: 0, tokens: 0, description: "", agentType: "", turnId: "" }) };
                for (const [key, v] of Object.entries(r.head)) {
                    if (v === null) delete next[key];
                    else next[key] = v;
                }
                a = { ...(next as unknown as AgentRun), id: r.id, blocks: a?.blocks ?? [] };
                this.agents.set(r.id, a);
            }
            if (a && typeof r.block?.id === "string" && !this.evicted.get(r.id)?.has(r.block.id)) {
                place(a.blocks, r.block, r.after);
                if (a.blocks.length > AGENT_KEPT) {
                    const gone = a.blocks.splice(0, a.blocks.length - AGENT_KEPT);
                    a.dropped = (a.dropped ?? 0) + gone.length;
                    let ids = this.evicted.get(r.id);
                    if (!ids) this.evicted.set(r.id, (ids = new Set()));
                    for (const b of gone) ids.add(b.id);
                }
            }
        } else if (r.t === "blocks" && Array.isArray(r.blocks)) {
            // Written by this change's first versions: a turn's steps all at once, at its end.
            this.steps.set(`${r.seg}:${r.index}`, { blocks: r.blocks, prompt: r.prompt });
        } else if (r.t === "state") {
            const { t: _, ...state } = r;
            this.state = { ...this.state, ...state };
        }
    }

    turn(seg: number, index: number) {
        return this.turns.get(`${seg}:${index}`);
    }

    /**
     * The steps of the turn at that prompt, when a backend answered it. Not
     * if the prompt there is another one (put there where this log wasn't
     * kept: in a terminal, after a rewind).
     */
    shown(seg: number, index: number, prompt: UserMessage): Block[] | undefined {
        const r = this.steps.get(`${seg}:${index}`);
        return r?.blocks.length && (r.prompt === undefined || r.prompt === promptKey(prompt)) ? r.blocks : undefined;
    }

    /** Nothing more is written (the session is being let go of, like Session.release). */
    close() {
        this.closed = true;
    }

    /** Best effort, like the transcript itself; redacted like everything written to disk. */
    write(r: UiRecord) {
        if (this.closed) return;
        this.apply(r);
        try {
            if (!this.created) {
                mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
                if (!existsSync(this.file)) {
                    appendFileSync(this.file, "", { mode: 0o600 });
                    chmodSync(this.file, 0o600);
                }
                this.created = true;
            }
            appendFileSync(this.file, redactedJson(r) + "\n");
        } catch {
            // the session keeps working without it
        }
    }
}

/**
 * A fork's log, from the original's: what its copied turns need (tool rows'
 * summaries and diffs, turn times). The fork's segments are the original's up
 * to the cut, so records keep their keys. Written in one go, before the fork
 * is opened.
 */
export function forkUiLog(from: { file: string; id: string }, to: { file: string; id: string }) {
    const source = new UiLog(from.file, from.id);
    const segments = readSegments(to.file);
    const calls = new Set<string>();
    const records: UiRecord[] = [];
    for (const [si, seg] of segments.entries()) {
        for (const [index, m] of seg.messages.entries()) {
            if (m.role === "assistant") for (const p of m.content) if (p.type === "tool_call") calls.add(p.id);
            const turn = source.turn(si, index);
            // The same index can belong to a different prompt after a rewind.
            if (turn && (turn.prompt === undefined || (m.role === "user" && turn.prompt === promptKey(m)))) records.push(turn);
            if (m.role !== "user") continue;
            const blocks = source.shown(si, index, m);
            if (!blocks) continue;
            records.push({ t: "blocks", seg: si, index, prompt: promptKey(m), blocks });
            for (const b of blocks) if (b.t === "tool") calls.add(b.id);
        }
    }
    for (const id of calls) {
        const tool = source.tools.get(id);
        if (tool) records.push(tool);
    }
    // State, pending turns and delegated runs belong to the original. Only
    // its completed timeline is inherited; the fork gets its own live state.
    const out = records.map((r) => redactedJson(r));
    if (!out.length) return;
    const file = join(dirname(to.file), "ui", `${to.id}.jsonl`);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(tmp, out.join("\n") + "\n", { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, file);
    } catch {
        // The timeline is rebuilt without it (derived summaries, no timings).
        try {
            unlinkSync(tmp);
        } catch {
            // never made
        }
    }
}

// ---------------------------------------------------------------------------
// Tool results as blocks

export interface ToolMeta {
    title: string;
    category?: ToolCategoryId;
}

/** A diff for an edit from its input, when the log doesn't have the real one. */
function diffFromInput(call: ToolCallPart): FileDiff | undefined {
    const i = call.input ?? {};
    const path = String(i.file_path ?? i.notebook_path ?? i.path ?? "");
    if (!path) return undefined;
    if (call.name === "Edit" && typeof i.old_string === "string" && typeof i.new_string === "string") return fileDiff(path, i.old_string, i.new_string, { context: 2 });
    if (call.name === "MultiEdit" && Array.isArray(i.edits)) {
        const edits = i.edits as { old_string?: string; new_string?: string }[];
        return fileDiff(path, edits.map((e) => e.old_string ?? "").join("\n"), edits.map((e) => e.new_string ?? "").join("\n"), { context: 2 });
    }
    if (call.name === "Write" && typeof i.content === "string") return fileDiff(path, null, i.content);
    return undefined;
}

/** `agent`: a sub-agent's call, whose report can end with a backend's actions note (for models, not the reader), dropped before it's clipped. */
export function resultPatch(text: string, isError: boolean | undefined, agent = false): Partial<ToolBlock> {
    const denied = /^The user declined/.test(text);
    const out = truncateText(agent ? withoutActionsNote(text) : text, INLINE_OUTPUT);
    return {
        status: denied ? "denied" : isError ? "error" : "ok",
        output: out.text,
        ...(out.truncated ? { outputTruncated: true } : {}),
    };
}

export function toolBlockFromCall(call: ToolCallPart, meta: ToolMeta): ToolBlock {
    return { t: "tool", id: call.id, name: call.name, title: meta.title, category: meta.category, input: trimInput(call.input), status: "running", ...(runsAgent(call.name) ? { agent: true } : {}) };
}

/** A call that runs a sub-agent: Task, or Claude Code's or Codex's delegate. */
export function runsAgent(toolName: string): boolean {
    return toolName === "Task" || toolName === DELEGATE_TOOL;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** A sub-agent as its call shows it, before any of its activity is known. */
export function agentFromCall(b: ToolBlock, turnId: string, ownModel?: string): AgentRun {
    const i = b.input ?? {};
    const model = text(i.model);
    return {
        id: b.id,
        turnId,
        // A skill that runs as its own agent is named by the skill ("code-review"), not its call ("Skill(code-review)").
        description: text(i.description) ?? (b.name === "Skill" ? text(i.skill) : undefined) ?? b.title,
        agentType: text(i.subagent_type) ?? text(i.agent) ?? "general-purpose",
        model: model && model !== ownModel ? model : undefined,
        effort: EFFORT_LEVELS.includes(i.effort as Effort) ? i.effort as Effort : undefined,
        prompt: text(i.prompt) ?? text(i.task),
        status: "running",
        startedAt: b.startedAt ?? Date.now(),
        toolCount: 0,
        tokens: 0,
        blocks: [],
    };
}

let actionsNote: RegExp | undefined;

/**
 * Text without the note Claude Code or Codex leave after their reply in history,
 * "[Claude Code used: Bash(…), Edit(…)]" (Agent.recordBackendTurn). It's there so
 * other models know what was done; the transcript shows the steps themselves.
 */
export function withoutActionsNote(text: string): string {
    return text.replace(actionsNoteRe(), "").trim();
}

function actionsNoteRe(): RegExp {
    if (!actionsNote) {
        const names = allProviders()
            .filter((p) => p.kind === "agent")
            .map((p) => p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        actionsNote = new RegExp(`(^|\\n\\n)\\[(?:${names.join("|")}) used: ([\\s\\S]*?)\\](?=\\n\\n|$)`, "g");
    }
    actionsNote.lastIndex = 0;
    return actionsNote;
}

/** What the note lists ("Bash(npm test), Edit(src/x.ts)"), for turns whose steps weren't seen (imported ones). */
export function actionsInNote(text: string): string[] {
    return [...text.matchAll(actionsNoteRe())].map((m) => m[2]!.trim()).filter(Boolean);
}

/**
 * A reopened session's sub-agents. One of a backend's turn comes back as the
 * log last saw it (`recorded`); any other from its call and result (what it
 * did along the way isn't kept).
 */
export function agentsFromTurns(turns: Turn[], ownModel?: string, recorded?: Map<string, AgentRun>): AgentRun[] {
    const out: AgentRun[] = [];
    for (const t of turns) {
        for (const b of t.blocks) {
            if (b.t !== "tool") continue;
            const rec = recorded?.get(b.id);
            if (rec) {
                out.push(restoredAgent(rec, t));
                continue;
            }
            if (!b.agent) continue;
            const status = b.status === "ok" ? "done" : b.status === "error" || b.status === "denied" ? "failed" : "stopped";
            const startedAt = b.startedAt ?? t.startedAt ?? 0;
            out.push({ ...agentFromCall(b, t.id, ownModel), status, startedAt, ...(b.durationMs !== undefined && startedAt ? { endedAt: startedAt + b.durationMs } : {}), report: b.output && withoutActionsNote(b.output), replayed: true });
        }
    }
    // A sub-agent's own (a delegated Codex task's) has its call in that one's steps, not in a turn: it comes back with it.
    for (let i = 0; i < out.length && recorded; i++) {
        const up = out[i]!;
        const turn = turns.find((t) => t.id === up.turnId)!;
        for (const rec of recorded.values()) if (rec.parentId === up.id && !out.some((a) => a.id === rec.id)) out.push(restoredAgent(rec, turn));
    }
    return out;
}

/** A logged sub-agent as it comes back: nothing of it runs any more, and there's no task to stop. */
function restoredAgent(rec: AgentRun, t: Turn): AgentRun {
    const live = rec.status === "running" || rec.status === "waiting";
    return { ...rec, turnId: t.id, taskId: undefined, activity: undefined, replayed: true, blocks: rec.blocks.map(ended), ...(live ? { status: "stopped", endedAt: rec.endedAt ?? t.endedAt } : {}) };
}

// ---------------------------------------------------------------------------
// A turn cut off

/** How an interrupted turn ends in the history (as Agent writes it when a turn is stopped). */
export const INTERRUPTED = "[Request interrupted by user]";

/** A message the user sent that starts a turn of its own: a prompt, a command, a wake. */
export const isPrompt = (m: Message) => m.role === "user" && (m.meta?.kind === undefined || m.meta.kind === "prompt" || m.meta.kind === "command" || m.meta.kind === "wake");
/** Where a turn starts: a prompt, or tool results a message sent meanwhile rides along with. */
const startsTurn = (m: Message) => isPrompt(m) || (m.role === "user" && m.meta?.kind === "tool_results" && m.content.some((p) => p.type === "text" && p.text.startsWith(STEERING)));

/**
 * The prompt of the session's last turn (its index), if that turn was cut
 * off: the log saw it start and never end, and nothing in the history after
 * its prompt says how it ended (a reply, an interrupt). The server stopped
 * or died before the turn could say. Not when the history went on after it
 * (in a terminal, which keeps no log), was rewound past it, or compacted.
 */
export function cutOffPrompt(ui: UiLog, seg: number, messages: Message[], notices: TurnNotice[] = []): number | undefined {
    const rec = ui.lastStarted ? ui.turns.get(ui.lastStarted) : undefined;
    if (!rec || rec.seg !== seg || rec.end !== undefined || rec.status !== undefined) return undefined;
    const prompt = messages[rec.index];
    if (!prompt || !startsTurn(prompt) || messages.slice(rec.index + 1).some(startsTurn)) return undefined;
    // Another prompt there (that one was rewound in a terminal, this one sent there).
    if (rec.prompt !== undefined && rec.prompt !== promptKey(prompt as UserMessage)) return undefined;
    // A note of how it ended (an error), unless it went on after that (a Stop hook kept it going after a warning).
    const wentOn = (from: number) => messages.slice(from).some((m) => m.role === "assistant" || m.meta?.kind === "reminder" || m.meta?.kind === "continuation");
    if (notices.some((n) => n.index > rec.index && !wentOn(n.index))) return undefined;
    const last = messages[messages.length - 1]!;
    if (last.role === "assistant" && !toolCallsOf(last).length) return undefined;
    // Interrupted already (as a stop writes it, for tools too).
    if (last.role === "user" && (last.meta?.kind === "interrupt" || last.content.some((p) => p.type === "text" && p.text.startsWith("[Request interrupted")))) return undefined;
    return rec.index;
}

// ---------------------------------------------------------------------------
// What the log keeps of a backend's turn

/** A sub-agent's steps kept in the log, and how much of each one's output. */
export const AGENT_KEPT = 100;
const AGENT_OUTPUT = 1000;

/** A step as it's kept: live-only fields go, and so does a diff (a call's own record has it); output is cut to `output`, if given. */
function keptBlock(b: Block, output?: number): Block {
    if (b.t !== "tool") return { ...b };
    const { progress: _p, receiving: _r, diff: _d, ...rest } = b;
    if (output === undefined || rest.output === undefined || rest.output.length <= output) return rest;
    return { ...rest, output: truncateText(rest.output, output).text, outputTruncated: true };
}

/**
 * A step of a turn a backend answered, as it's written to the log: text,
 * thinking and tool calls (notices, compactions and shell commands have
 * records of their own, or none: undefined). Outputs are as shown, already
 * cut to INLINE_OUTPUT.
 */
export function shownStep(b: Block): Block | undefined {
    return b.t === "text" || b.t === "thinking" || b.t === "tool" ? keptBlock(b) : undefined;
}

/** A sub-agent's step as it's written to the log: its output cut, without a diff. The log keeps its latest AGENT_KEPT. */
export function agentStep(b: Block): Block {
    return keptBlock(b, AGENT_OUTPUT);
}

/** A sub-agent as it's written to the log, its steps aside (they're written one by one), and what it's doing now (nothing is, once it's reopened). */
export function agentHead(a: AgentRun): AgentHead {
    const { blocks: _b, activity: _a, dropped: _d, ...head } = a;
    return head;
}

// ---------------------------------------------------------------------------
// Replay

export interface ReplayInput {
    segments: Segment[];
    /** The current segment as the live session has it (repaired tail included). */
    current: Message[];
    /** The live session's notices for the current segment (the file's when not given). */
    currentNotices?: TurnNotice[];
    ui: UiLog;
    meta: (call: ToolCallPart) => ToolMeta;
    newId: () => string;
}

/** A kept notice as the transcript shows it (a live one is built the same way: Runtime.notice). */
export function noticeBlock(n: Omit<TurnNotice, "index" | "at">, id: string): NoticeBlock {
    const { level, text, details, source, title, link, account, stopped, limit } = n;
    return { t: "notice", id, level, text, ...(details ? { details } : {}), ...(source ? { source } : {}), ...(title ? { title } : {}), ...(link ? { link } : {}), ...(account ? { account } : {}), ...(stopped ? { stopped } : {}), ...(limit ? { limit } : {}) };
}

/** A notice as it happens (an agent's event): its text the data's, if it has one, else the message; redacted. */
export function liveNotice(id: string, level: NoticeBlock["level"], message: string, data: NoticeData = {}): NoticeBlock {
    const { text, title, link, ...rest } = data;
    return noticeBlock({ level, text: redact(text ?? message), ...rest, ...(title ? { title: redact(title) } : {}), ...(link ? { link: redact(link) } : {}) }, id);
}

export function replay(o: ReplayInput): Turn[] {
    const turns: Turn[] = [];
    const last = o.segments[o.segments.length - 1];
    const segs: Segment[] = [...o.segments.slice(0, -1), { summary: last?.summary, idle: last?.idle, kept: last?.kept, imported: last?.imported, messages: o.current, notices: o.currentNotices ?? last?.notices }];
    segs.forEach((seg, si) => {
        const archived = si < segs.length - 1;
        let turn: Turn | undefined;
        const tools = new Map<string, ToolBlock>();
        const start = (prompt: Turn["prompt"], at?: number, index?: number) => {
            if (turn && turn.status === "running") turn.status = "done";
            turn = { id: o.newId(), prompt, blocks: [], status: "done", startedAt: at, ...(archived ? { archived } : {}), ...(index !== undefined ? { pos: { seg: si, index } } : {}) };
            turns.push(turn);
            return turn;
        };
        // A turn no prompt started (a reply carrying on after a compaction) still has its place.
        const ensure = (index: number) => turn ?? start(undefined, undefined, index);
        if (si > 0) {
            // Before any prompt of its segment: what a search finds there leads here.
            const t = start(undefined, undefined, -1);
            t.blocks.push({ t: "compact", id: o.newId(), summary: seg.summary ?? "", auto: false, ...(seg.idle ? { idle: true } : {}) });
            turn = undefined;
        }
        if (seg.imported) {
            const t = start(undefined);
            t.imported = true;
            t.blocks.push({ t: "imported", id: o.newId(), source: getProvider(seg.imported.source)?.name ?? seg.imported.source, startedAt: seg.imported.startedAt, omitted: seg.imported.omitted });
            turn = undefined;
        }
        // Notices go to the turn they ended: the one before the message that came next.
        const notices = [...(seg.notices ?? [])].sort((a, b) => a.index - b.index);
        const noticesBefore = (index: number) => {
            while (notices.length && notices[0]!.index <= index) {
                const n = notices.shift()!;
                // An account switch is between turns: a turn of its own with no prompt, as the live session shows it
                // (Runtime.currentTurn), never the end of the turn before.
                if (n.account) {
                    if (!turn || turn.prompt || turn.blocks.some((b) => b.t !== "notice")) start(undefined, n.at || undefined);
                    turn!.blocks.push(noticeBlock(n, o.newId()));
                    continue;
                }
                // A notice can be the first block after compaction; it still needs a
                // position for search, even when flushed after the last message.
                const t = ensure(n.index);
                t.blocks.push(noticeBlock(n, o.newId()));
                if (n.level === "error" && t.status === "done") t.status = "error";
            }
        };
        // Turns whose steps came from the log: the transcript's text of them isn't shown again.
        const shown = new Set<Turn>();
        let answerBlock: Extract<Block, { t: "text" }> | undefined;
        // A prompt the next compaction kept is shown once, where it went on (after the summary).
        const moved = segs[si + 1]?.kept ? seg.messages.length - 1 : -1;
        const before = si > 0 && seg.kept ? segs[si - 1]!.messages.length - 1 : -1;
        seg.messages.forEach((m, index) => {
            noticesBefore(index);
            if (index === moved && m.role === "user") return;
            if (m.role === "user") {
                const kind = m.meta?.kind ?? "prompt";
                if (kind === "summary" || kind === "reminder" || kind === "continuation") return;
                if (kind === "interrupt") {
                    const t = ensure(index);
                    t.status = "aborted";
                    for (const b of t.blocks)
                        if (b.t === "tool" && b.status === "running") {
                            b.status = "error";
                            // Stopped before it ran: no edit happened, whatever its input said.
                            if (!o.ui.tools.get(b.id)?.diff) delete b.diff;
                        }
                    return;
                }
                if (kind === "tool_results") {
                    for (const p of m.content) {
                        if (p.type === "tool_result") applyResult(tools.get(p.toolCallId), p, o.ui);
                        else if (p.type === "text" && p.text.startsWith(STEERING)) {
                            const rec = o.ui.turn(si, index);
                            // With what was attached to it (beside the results, not inside one).
                            const t = start({ text: p.text.slice(STEERING.length).trim(), ...attachedPrompt(m.content), steered: true }, rec?.at, index);
                            t.snapshotId = m.meta?.checkpoint;
                            if (rec?.end) t.endedAt = rec.end;
                            if (rec?.status && rec.status !== "running") t.status = rec.status;
                        }
                    }
                    return;
                }
                // Its record from where it was sent, if the log has none here (written before it was moved).
                const rec = o.ui.turn(si, index) ?? (index === 1 && before >= 0 ? o.ui.turn(si - 1, before) : undefined);
                const imported = Boolean(m.meta?.imported);
                // A wake (a watched PR, a monitor) isn't a prompt to rewind to.
                const t = start({ text: promptText(m), ...attachedPrompt(m.content), ...(kind === "command" ? { command: true } : {}), ...(kind === "wake" ? { wake: true } : archived || imported ? {} : { index }) }, rec?.at, index);
                t.snapshotId = m.meta?.checkpoint;
                if (imported) t.imported = true;
                if (rec?.end) t.endedAt = rec.end;
                if (rec?.status && rec.status !== "running") t.status = rec.status;
                const steps = o.ui.shown(si, index, m);
                if (steps) {
                    t.blocks.push(...steps.map((b) => restoredBlock(b, o)));
                    shown.add(t);
                }
                return;
            }
            const t = ensure(index);
            const backend = getProvider(m.provider ?? "")?.kind === "agent";
            if (backend && shown.has(t)) return;
            const previous = seg.messages[index - 1];
            const continuing = previous?.role === "user" && previous.meta?.kind === "continuation";
            if (!continuing) answerBlock = undefined;
            const joinText = continuing || (m.stopReason === "max_tokens" && !toolCallsOf(m).length);
            for (const p of m.content) {
                if (p.type === "thinking") {
                    if (p.text.trim()) {
                        t.blocks.push({ t: "thinking", id: o.newId(), text: p.text });
                        if (answerBlock && joinText) {
                            t.blocks.splice(t.blocks.indexOf(answerBlock), 1);
                            t.blocks.push(answerBlock);
                        }
                    }
                } else if (p.type === "text") {
                    const text = backend ? withoutActionsNote(p.text) : p.text;
                    if (answerBlock && joinText) answerBlock.text += text;
                    else if (text.trim() || (text && joinText)) {
                        answerBlock = { t: "text", id: o.newId(), text };
                        t.blocks.push(answerBlock);
                    }
                    // An imported turn has no steps to show: its note says what was used.
                    else if (backend && t.imported) for (const used of actionsInNote(p.text)) t.blocks.push({ t: "notice", id: o.newId(), level: "info", text: `Used: ${used}` });
                } else if (p.type === "tool_call") {
                    const b = toolBlockFromCall(p, o.meta(p));
                    const rec = o.ui.tools.get(p.id);
                    b.diff = rec?.diff ?? (b.category === "edit" ? diffFromInput(p) : undefined);
                    tools.set(p.id, b);
                    t.blocks.push(b);
                }
            }
        });
        noticesBefore(Infinity);
    });
    // A tool call never answered (only the very end of a live session).
    return turns;
}

/** A step from the log, in this run: its own ids for text, the diff from the call's record, nothing left running. */
function restoredBlock(b: Block, o: ReplayInput): Block {
    if (b.t !== "tool") return { ...b, id: o.newId() } as Block;
    const diff = o.ui.tools.get(b.id)?.diff;
    return { ...ended(b), ...(diff ? { diff } : {}), ...(b.sub ? { sub: { ...b.sub, tools: b.sub.tools.map(ended) } } : {}) };
}

/** A call that was still open when the log last saw it: nothing runs after a reopen. */
function ended<B extends Block>(b: B): B {
    return b.t === "tool" && (b.status === "running" || b.status === "streaming" || b.status === "queued" || b.status === "awaiting") ? { ...b, status: "error" } : b;
}

function applyResult(b: ToolBlock | undefined, p: ToolResultPart, ui: UiLog) {
    if (!b) return;
    const rec = ui.tools.get(p.toolCallId);
    Object.assign(b, resultPatch(p.content, p.isError, b.agent));
    // A diff built from the call's input is of an edit that never happened when the call failed.
    // A declined one keeps it: that's what the user was shown and said no to.
    if (b.status === "error" && !rec?.diff) delete b.diff;
    if (rec?.summary) b.summary = rec.summary;
    else if (b.status === "ok") b.summary = derivedSummary(b, p.content);
    if (rec?.durationMs !== undefined) b.durationMs = rec.durationMs;
    if (rec?.approval) b.approval = rec.approval;
    if (rec?.sandboxed !== undefined) b.sandboxed = rec.sandboxed;
    if (p.images?.length || rec?.images) b.images = p.images?.length ?? rec?.images;
    if (rec?.job) b.job = rec.job;
    if (rec?.diagnostics) b.diagnostics = rec.diagnostics;
}

/** A one-line summary for a result the GUI didn't see happen (sessions from the terminal). */
function derivedSummary(b: ToolBlock, content: string): string | undefined {
    const lines = content.split("\n").length;
    switch (b.name) {
        case "Read":
            return `Read ${content.match(/^\s*\d+\t/gm)?.length ?? lines} lines`;
        case "Grep":
        case "Glob":
            return /^No (files|matches)/.test(content) ? "No matches" : `${lines} result${lines === 1 ? "" : "s"}`;
        case "Edit":
        case "MultiEdit":
        case "Write":
            return b.diff ? `+${b.diff.added} −${b.diff.removed}` : undefined;
        default:
            return undefined;
    }
}

export function lastBlock(t: Turn): Block | undefined {
    return t.blocks[t.blocks.length - 1];
}
