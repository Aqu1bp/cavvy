// Rebuilding a session's timeline from disk, so an opened session looks the
// way it did live: the saved transcript (all of it, including what came
// before a compaction) plus the GUI's own log of what the transcript doesn't
// keep (diffs, summaries, timings), in ui/<session>.jsonl next to it.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import type { Message, ToolCallPart, ToolResultPart, UserMessage } from "../providers/types";
import { textOf } from "../providers/types";
import { redactedJson } from "../util/redact";
import { fileDiff, trimInput, truncateText } from "./diffs";
import type { Block, FileDiff, ToolBlock, ToolCategoryId, Turn, TurnStatus } from "./protocol";

/** Tool output sent inline; longer output is fetched when the row is opened. */
export const INLINE_OUTPUT = 4000;

/** Starts the text of a message the user sent while tools were running (agent.ts). */
export const STEERING = "The user sent this message while you were working:\n";

const REMINDERS = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

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
        let l: { t: string; m?: Message; summary?: string; count?: number };
        try {
            l = JSON.parse(raw);
        } catch {
            continue;
        }
        const cur = segments[segments.length - 1]!;
        if (l.t === "msg" && l.m) cur.messages.push(l.m);
        else if (l.t === "compact") segments.push({ summary: l.summary ?? "", messages: [] });
        else if (l.t === "rewind" && typeof l.count === "number") cur.messages = cur.messages.slice(0, l.count);
    }
    return segments;
}

// ---------------------------------------------------------------------------
// The GUI's log

export type UiRecord =
    | { t: "tool"; id: string; summary?: string; diff?: FileDiff; durationMs?: number; approval?: string; sandboxed?: boolean; images?: number; at?: number }
    | { t: "turn"; seg: number; index: number; at: number; end?: number; status?: TurnStatus }
    | { t: "pending-turn"; text: string; at: number };

export class UiLog {
    tools = new Map<string, Extract<UiRecord, { t: "tool" }>>();
    turns = new Map<string, Extract<UiRecord, { t: "turn" }>>();
    private file: string;
    private created = false;

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
            this.turns.set(k, { ...this.turns.get(k), ...r });
        }
    }

    turn(seg: number, index: number) {
        return this.turns.get(`${seg}:${index}`);
    }

    /** Best effort, like the transcript itself; redacted like everything written to disk. */
    write(r: UiRecord) {
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
    return { t: "tool", id: call.id, name: call.name, title: meta.title, category: meta.category, input: trimInput(call.input), status: "running" };
}

// ---------------------------------------------------------------------------
// Replay

export interface ReplayInput {
    segments: Segment[];
    /** The current segment as the live session has it (repaired tail included). */
    current: Message[];
    ui: UiLog;
    meta: (call: ToolCallPart) => ToolMeta;
    newId: () => string;
}

export function replay(o: ReplayInput): Turn[] {
    const turns: Turn[] = [];
    const segs = [...o.segments.slice(0, -1), { summary: o.segments[o.segments.length - 1]?.summary, messages: o.current }];
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
        seg.messages.forEach((m, index) => {
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
                const t = start({ text: promptText(m), ...(images ? { images } : {}), ...(kind === "command" ? { command: true } : {}), ...(archived ? {} : { index }) }, rec?.at);
                if (rec?.end) t.endedAt = rec.end;
                if (rec?.status && rec.status !== "running") t.status = rec.status;
                return;
            }
            const t = ensure();
            for (const p of m.content) {
                if (p.type === "thinking") {
                    if (p.text.trim()) t.blocks.push({ t: "thinking", id: o.newId(), text: p.text });
                } else if (p.type === "text") {
                    if (p.text.trim()) t.blocks.push({ t: "text", id: o.newId(), text: p.text });
                } else if (p.type === "tool_call") {
                    const b = toolBlockFromCall(p, o.meta(p));
                    const rec = o.ui.tools.get(p.id);
                    b.diff = rec?.diff ?? (b.category === "edit" ? diffFromInput(p) : undefined);
                    tools.set(p.id, b);
                    t.blocks.push(b);
                }
            }
        });
    });
    // A tool call never answered (only the very end of a live session).
    return turns;
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
