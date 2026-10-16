// Rebuilding a session's timeline from disk, so an opened session looks the
// way it did live: the saved transcript (all of it, including what came
// before a compaction) plus the GUI's own log of what the transcript doesn't
// keep (diffs, summaries, timings, and the steps of turns Claude Code or Codex
// answered, which the transcript keeps as text), in ui/<session>.jsonl next to it.

import { createHash } from "crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import type { Message, ToolCallPart, ToolResultPart, UserMessage } from "../providers/types";
import { textOf } from "../providers/types";
import { redactedJson } from "../util/redact";
import { fileDiff, trimInput, truncateText } from "./diffs";
import type { AgentRun, Block, FileDiff, PermissionModeId, ToolBlock, ToolCategoryId, Turn, TurnStatus } from "./protocol";
import { DELEGATE_TOOL } from "../agent/delegation";
import { noticesUpTo, turnNotice, type TurnNotice } from "../agent/session";
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
        let l: { t: string; m?: Message; summary?: string; count?: number; source?: unknown; startedAt?: unknown; omitted?: unknown } & Partial<TurnNotice>;
        try {
            l = JSON.parse(raw);
        } catch {
            continue;
        }
        const cur = segments[segments.length - 1]!;
        if (l.t === "msg" && l.m) cur.messages.push(l.m);
        else if (l.t === "compact") segments.push({ summary: l.summary ?? "", messages: [] });
        else if (l.t === "rewind" && typeof l.count === "number") {
            cur.messages = cur.messages.slice(0, l.count);
            if (cur.notices) cur.notices = noticesUpTo(cur.notices, l.count);
        } else if (l.t === "notice") {
            const n = turnNotice(l);
            if (n) (cur.notices ??= []).push(n);
        }
        else if (l.t === "import" && typeof l.source === "string") cur.imported = { source: l.source, startedAt: typeof l.startedAt === "number" ? l.startedAt : undefined, omitted: typeof l.omitted === "number" ? l.omitted : 0 };
    }
    return segments;
}

// ---------------------------------------------------------------------------
// The GUI's log

/** The session as the GUI last left it: its permission mode, and its context after `messages` messages. */
export interface UiState {
    mode?: PermissionModeId;
    contextTokens?: number;
    messages?: number;
}

export type UiRecord =
    | { t: "tool"; id: string; summary?: string; diff?: FileDiff; durationMs?: number; approval?: string; sandboxed?: boolean; images?: number; at?: number }
    /** A turn's start (no `end`) begins its record afresh; its end adds to it. */
    | { t: "turn"; seg: number; index: number; at: number; end?: number; status?: TurnStatus }
    | { t: "pending-turn"; text: string; at: number }
    /**
     * A turn Claude Code or Codex answered, as it was shown (shownBlocks). The
     * transcript keeps only its text and a note of what was done, which is
     * what other models are given; this is what the GUI shows again.
     */
    | { t: "blocks"; seg: number; index: number; blocks: Block[]; /** promptKey of the prompt it answered. */ prompt?: string }
    /** A sub-agent of such a turn, the last time it changed (keptAgent). */
    | { t: "agent"; agent: AgentRun }
    | ({ t: "state" } & UiState);

export class UiLog {
    tools = new Map<string, Extract<UiRecord, { t: "tool" }>>();
    turns = new Map<string, Extract<UiRecord, { t: "turn" }>>();
    blocks = new Map<string, { blocks: Block[]; prompt?: string }>();
    agents = new Map<string, AgentRun>();
    state: UiState = {};
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
            const start = r.end === undefined && r.status === undefined;
            if (start) this.blocks.delete(k);
            this.turns.set(k, start ? r : { ...this.turns.get(k), ...r });
        } else if (r.t === "blocks" && Array.isArray(r.blocks)) this.blocks.set(`${r.seg}:${r.index}`, { blocks: r.blocks, prompt: r.prompt });
        else if (r.t === "agent" && typeof r.agent?.id === "string") this.agents.set(r.agent.id, r.agent);
        else if (r.t === "state") {
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
        const r = this.blocks.get(`${seg}:${index}`);
        return r && (r.prompt === undefined || r.prompt === promptKey(prompt)) ? r.blocks : undefined;
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

export function resultPatch(text: string, isError: boolean | undefined): Partial<ToolBlock> {
    const denied = /^The user declined/.test(text);
    const out = truncateText(text, INLINE_OUTPUT);
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
        description: text(i.description) ?? b.title,
        agentType: text(i.subagent_type) ?? text(i.agent) ?? "general-purpose",
        model: model && model !== ownModel ? model : undefined,
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
                // Nothing of it runs any more, and there's no task to stop.
                const live = rec.status === "running" || rec.status === "waiting";
                out.push({ ...rec, turnId: t.id, taskId: undefined, activity: undefined, replayed: true, blocks: rec.blocks.map(ended), ...(live ? { status: "stopped", endedAt: rec.endedAt ?? t.endedAt } : {}) });
                continue;
            }
            if (!b.agent) continue;
            const status = b.status === "ok" ? "done" : b.status === "error" || b.status === "denied" ? "failed" : "stopped";
            out.push({ ...agentFromCall(b, t.id, ownModel), status, startedAt: b.startedAt ?? t.startedAt ?? 0, report: b.output && withoutActionsNote(b.output), replayed: true });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// What the log keeps of a backend's turn

/** A sub-agent's steps kept in the log, and how much of each one's output. */
const AGENT_KEPT = 100;
const AGENT_OUTPUT = 1000;

/** A step as it's kept: live-only fields go, and so does a diff (a call's own record has it); output is cut to `output`, if given. */
function keptBlock(b: Block, output?: number): Block {
    if (b.t !== "tool") return { ...b };
    const { progress: _p, receiving: _r, diff: _d, ...rest } = b;
    if (output === undefined || rest.output === undefined || rest.output.length <= output) return rest;
    return { ...rest, output: truncateText(rest.output, output).text, outputTruncated: true };
}

/**
 * The steps of a turn a backend answered, as they're written to the log:
 * text, thinking and tool calls (notices, compactions and shell commands
 * have records of their own, or none). Outputs are as shown, already cut
 * to INLINE_OUTPUT.
 */
export function shownBlocks(blocks: Block[]): Block[] {
    return blocks.filter((b) => b.t === "text" || b.t === "thinking" || b.t === "tool").map((b) => keptBlock(b));
}

/** A sub-agent as it's written to the log: its latest steps, outputs cut, without diffs. */
export function keptAgent(a: AgentRun): AgentRun {
    const dropped = Math.max(0, a.blocks.length - AGENT_KEPT);
    return { ...a, activity: undefined, blocks: a.blocks.slice(dropped).map((b) => keptBlock(b, AGENT_OUTPUT)), ...(dropped ? { dropped: (a.dropped ?? 0) + dropped } : {}) };
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

export function replay(o: ReplayInput): Turn[] {
    const turns: Turn[] = [];
    const last = o.segments[o.segments.length - 1];
    const segs: Segment[] = [...o.segments.slice(0, -1), { summary: last?.summary, imported: last?.imported, messages: o.current, notices: o.currentNotices ?? last?.notices }];
    segs.forEach((seg, si) => {
        const archived = si < segs.length - 1;
        let turn: Turn | undefined;
        const tools = new Map<string, ToolBlock>();
        const start = (prompt: Turn["prompt"], at?: number) => {
            if (turn && turn.status === "running") turn.status = "done";
            turn = { id: o.newId(), prompt, blocks: [], status: "done", startedAt: at, ...(archived ? { archived } : {}) };
            turns.push(turn);
            return turn;
        };
        const ensure = () => turn ?? start(undefined);
        if (si > 0) {
            const t = start(undefined);
            t.blocks.push({ t: "compact", id: o.newId(), summary: seg.summary ?? "", auto: false });
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
                const t = ensure();
                t.blocks.push({ t: "notice", id: o.newId(), level: n.level, text: n.text });
                if (n.level === "error" && t.status === "done") t.status = "error";
            }
        };
        // Turns whose steps came from the log: the transcript's text of them isn't shown again.
        const shown = new Set<Turn>();
        seg.messages.forEach((m, index) => {
            noticesBefore(index);
            if (m.role === "user") {
                const kind = m.meta?.kind ?? "prompt";
                if (kind === "summary" || kind === "reminder") return;
                if (kind === "interrupt") {
                    const t = ensure();
                    t.status = "aborted";
                    for (const b of t.blocks) if (b.t === "tool" && b.status === "running") b.status = "error";
                    return;
                }
                if (kind === "tool_results") {
                    for (const p of m.content) {
                        if (p.type === "tool_result") applyResult(tools.get(p.toolCallId), p, o.ui);
                        else if (p.type === "text" && p.text.startsWith(STEERING)) {
                            const rec = o.ui.turn(si, index);
                            start({ text: p.text.slice(STEERING.length).trim() }, rec?.at);
                        }
                    }
                    return;
                }
                const images = m.content.filter((p) => p.type === "image").length;
                const rec = o.ui.turn(si, index);
                const imported = Boolean(m.meta?.imported);
                const t = start({ text: promptText(m), ...(images ? { images } : {}), ...(kind === "command" ? { command: true } : {}), ...(archived || imported ? {} : { index }) }, rec?.at);
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
            const t = ensure();
            const backend = getProvider(m.provider ?? "")?.kind === "agent";
            if (backend && shown.has(t)) return;
            for (const p of m.content) {
                if (p.type === "thinking") {
                    if (p.text.trim()) t.blocks.push({ t: "thinking", id: o.newId(), text: p.text });
                } else if (p.type === "text") {
                    const text = backend ? withoutActionsNote(p.text) : p.text;
                    if (text.trim()) t.blocks.push({ t: "text", id: o.newId(), text });
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
    return b.t === "tool" && (b.status === "running" || b.status === "streaming" || b.status === "awaiting") ? { ...b, status: "error" } : b;
}

function applyResult(b: ToolBlock | undefined, p: ToolResultPart, ui: UiLog) {
    if (!b) return;
    const rec = ui.tools.get(p.toolCallId);
    Object.assign(b, resultPatch(p.content, p.isError));
    if (rec?.summary) b.summary = rec.summary;
    else if (b.status === "ok") b.summary = derivedSummary(b, p.content);
    if (rec?.durationMs !== undefined) b.durationMs = rec.durationMs;
    if (rec?.approval) b.approval = rec.approval;
    if (rec?.sandboxed) b.sandboxed = true;
    if (p.images?.length || rec?.images) b.images = p.images?.length ?? rec?.images;
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
