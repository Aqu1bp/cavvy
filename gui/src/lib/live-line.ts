// The running turn's one indicator: its live line, always the turn's last row.
// What it says is chosen here, from the turn's blocks and the session's state;
// LiveLine.tsx draws it and rolls between states. Also here: which finished
// turns stay open because a steer carried their work on (a chain), what a
// turn folds away and what it says then ("Worked for 2m 5s"), the glide's arithmetic, and the
// pace at which rows that land together come in.

import type { Block, Interaction, ThinkingBlock, ToolBlock, Turn } from "@shared/protocol";
import { sleepSeconds, stripAnsi, tokens, turnDuration } from "./format";
import { commandDescription, isLive, runningVerb, toolLabel } from "./tool-words";

export type LiveKind = "think" | "tool" | "wait" | "bg" | "special" | "work";

export interface LiveLineState {
    /** A new key is a new state: the line rolls to it. The same key updates in place (a thought's latest line). */
    key: string;
    kind: LiveKind;
    label: string;
    /** What it's about: the file, the command, the thought being written. */
    detail?: string;
    /** The detail is code (a path, a command). */
    mono?: boolean;
    /** Said before the timer: "of 4m" for a wait, "1.2k chars" while a call arrives. */
    meta?: string;
    /** The background command a call is about started then (ms): said as "started 2m ago". */
    jobSince?: number;
    /** When this state began (ms), when it's known; else the line counts from when it first showed it. */
    since?: number;
    /** A running command's output so far: the line shows its last lines under it. */
    output?: string;
    /** The call it's about, for find. */
    toolId?: string;
    /** The whole of it, on hover. */
    title?: string;
}

/** Labels that say more than "Working": the turn (or the session, between turns) is in a special state. */
const SPECIAL = /^(Retrying|Compacting|Interrupting|Connecting|Waiting for background|Checking the goal)/;

export function specialActivity(label: string | undefined): boolean {
    return Boolean(label && SPECIAL.test(label));
}

export interface LiveInput {
    blocks: Block[];
    activity?: { label: string; since: number; detail?: string };
    interactions: Interaction[];
    /** Settings → Show thinking: the thought itself on the line, or only "Thinking". */
    showThinking: boolean;
}

/** What a request for the user is waiting on, in the line's words. */
function waitLabel(i: Interaction): { label: string; detail?: string; mono?: boolean } {
    switch (i.kind) {
        case "question":
            return { label: "Waiting for your answer" };
        case "plan":
            return { label: "Waiting for plan review" };
        case "secret":
            return { label: "Waiting for a secret", detail: i.name };
        default: {
            const what = i.command?.split("\n")[0] ?? i.path;
            return { label: "Waiting for approval", detail: what ?? i.title, mono: Boolean(what) };
        }
    }
}

/**
 * Claude Code's wait on its background work ("Waiting for background command: bun test · Esc to stop it"; a
 * semicolon between several), or the goal's ("Waiting for background tasks"): what it waits for, by name.
 */
export function backgroundWait(label: string): string | undefined {
    const m = /^Waiting for (background .*?)(?: · Esc to stop (?:it|them))?$/.exec(label);
    if (!m) return undefined;
    const names = m[1]!
        .split("; ")
        .map((part) => /^background [\w -]+?: (.+)$/.exec(part)?.[1]?.trim())
        .filter(Boolean);
    return names.join(", ");
}

/** The latest line of a thought, as it's written. */
function latestLine(text: string): string | undefined {
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i]!.replace(/[*_`#>]/g, "").trim();
        if (l) return l;
    }
    return undefined;
}

function toolState(t: ToolBlock): LiveLineState {
    const { verb, arg } = toolLabel(t);
    const description = commandDescription(t);
    const command = t.name === "Bash" ? String(t.input?.command ?? "").trim() : "";
    const first = command.split("\n")[0];
    if (t.status === "awaiting") {
        const asks = t.name === "AskUserQuestion" || t.name === "ExitPlanMode";
        return { key: `wait:${t.id}`, kind: "wait", label: runningVerb(t), detail: asks ? undefined : [verb, description ?? arg].filter(Boolean).join(" "), toolId: t.id, title: command || arg };
    }
    if (t.status === "streaming") {
        return { key: `tool:${t.id}:streaming`, kind: "tool", label: runningVerb(t), detail: arg, mono: true, meta: t.receiving ? `${tokens(t.receiving)} chars` : undefined, since: t.startedAt, toolId: t.id };
    }
    const wait = t.name === "Bash" && t.status === "running" ? sleepSeconds(t.input?.command) : undefined;
    const base = { key: `tool:${t.id}:${t.status}`, kind: "tool" as const, since: t.startedAt, toolId: t.id, jobSince: t.job?.startedAt };
    if (t.name === "Bash") {
        // Its description is the label when it has one ("Run the transcript tests"), the command beside it.
        const label = t.status === "queued" ? runningVerb(t) : wait ? "Waiting" : (description ?? "Running");
        return { ...base, label, detail: first || undefined, mono: true, title: command || undefined, meta: wait ? `of ${turnDuration(wait * 1000)}` : undefined, output: t.status === "running" ? (t.progress ?? "") : undefined };
    }
    return { ...base, label: runningVerb(t), detail: arg, mono: !t.agent && t.name !== "AskUserQuestion", title: arg };
}

/**
 * What the running turn's live line says, or nothing while the answer streams (its caret says it's working).
 * In order: a request waiting for the user; a special state (a retry, a compaction, a wait on background work);
 * the call under way (one waiting for approval first); the thought being written; else the session's activity.
 */
export function liveLine(o: LiveInput): LiveLineState | undefined {
    const pending = o.interactions[0];
    if (pending) {
        const w = waitLabel(pending);
        return { key: `wait:${pending.id}`, kind: "wait", ...w };
    }
    const a = o.activity;
    if (a && specialActivity(a.label)) {
        const names = backgroundWait(a.label);
        if (names !== undefined) return { key: "bg", kind: "bg", label: "Waiting for background", detail: names || a.detail, since: a.since, title: a.label };
        const [head, ...rest] = a.label.split(" · ");
        return { key: `special:${head!.split(" ")[0]}`, kind: "special", label: head!, detail: a.detail ?? (rest.join(" · ") || undefined), since: a.since, title: [a.label, a.detail].filter(Boolean).join("\n") };
    }
    const last = o.blocks.at(-1);
    // A command the user ran ("!ls") has its own card, running.
    if (last?.t === "shell" && last.running) return undefined;
    const tools = o.blocks.filter((b): b is ToolBlock => b.t === "tool" && isLive(b));
    const asking = tools.find((t) => t.status === "awaiting");
    if (asking) return toolState(asking);
    // The latest call under way: running before one still arriving or waiting for it.
    const current = tools.findLast((t) => t.status === "running") ?? tools.at(-1);
    if (current) return toolState(current);
    if (last?.t === "text" && a?.label === "Writing") return undefined;
    if (last?.t === "thinking" && last.durationMs === undefined && (!a || a.label === "Thinking")) {
        const b = last as ThinkingBlock;
        return { key: "think", kind: "think", label: "Thinking", detail: o.showThinking ? latestLine(b.text) : undefined, since: b.startedAt ?? a?.since };
    }
    if (!a) return { key: "work", kind: "work", label: "Working" };
    // Writing, but the text hasn't arrived yet: the caret will say so in a moment.
    if (a.label === "Writing") return undefined;
    if (a.label === "Thinking") return { key: "think", kind: "think", label: "Thinking", since: a.since };
    return { key: `work:${a.label}`, kind: "work", label: a.label, detail: a.detail, since: a.since, title: a.detail };
}

/** A running command's last `n` lines of output (or fewer), cleaned of terminal codes. */
export function lastLines(output: string | undefined, n: number): string[] {
    if (!output) return [];
    // Only the end is wanted: don't clean a long output to read a few lines of it.
    const lines = stripAnsi(output.slice(-8192)).split(/\r\n|\r|\n/);
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    return lines.slice(-n);
}

/** How an output line reads: a failure, a pass, or plain. */
export function lineTone(line: string): "er" | "ok" | undefined {
    // "FAIL" as a runner prints it (not " 0 fail" in a summary), or a count of failures above zero.
    if ((/\berror\b|\bfailed\b|✗/i.test(line) || /\bFAIL\b|\b[1-9]\d* fail/.test(line)) && !/^\s*(no|0)\s/i.test(line)) return "er";
    if (/✓|\bpass(ed)?\b/i.test(line) && !/\b[1-9]\d* fail/.test(line)) return "ok";
    return undefined;
}

/**
 * Finished turns whose work stays open: a steer ended each, and the turn it started (or one after that) is still
 * running. The server ends a turn when a steered message is drained and starts the next with it
 * (runtime.ts drainedTurn); the chain folds together once its last turn ends.
 */
export function heldTurns(turns: readonly Pick<Turn, "id" | "status" | "prompt">[]): Set<string> {
    const held = new Set<string>();
    let carried = false;
    for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i]!;
        const next = turns[i + 1];
        carried = Boolean(next?.prompt?.steered && (next.status === "running" || carried));
        if (carried && t.status !== "running") held.add(t.id);
    }
    return held;
}

/** A finished turn's work, folded: "Worked for 2m 5s", or "Worked briefly" under a second (never "0s"). */
export function workedLabel(startedAt?: number, endedAt?: number): string | undefined {
    if (startedAt === undefined || endedAt === undefined) return undefined;
    const ms = Math.max(0, endedAt - startedAt);
    return ms < 1000 ? "Worked briefly" : `Worked for ${turnDuration(ms)}`;
}

/** A turn's rows as TurnView lays them out: a run of steps (Activity's groupBlocks), or a block of its own. */
type Row = { kind: "activity" } | { kind: "block"; block: { t: string; text?: string } };

export type Seg<R> = { kind: "work"; items: R[] } | { kind: "item"; item: R; interim: boolean };

/**
 * Work (tool runs, thinking) vs what's said: the reply, notices. What the model said on its way (`interim`) folds
 * away with the work once the turn is done. The reply is what it said after its last step; when it ended on a
 * step (a background wait, a stop), it's the last thing it said, so that never folds away. Notices (errors) never do.
 */
export function workSegments<R extends Row>(items: R[]): Seg<R>[] {
    const isWork = (it: Row) => it.kind === "activity" || it.block.t === "thinking";
    const isText = (it: Row) => it.kind === "block" && it.block.t === "text";
    // Something said: a blank block (a CLI's stray newlines) isn't a reply.
    const said = (it: Row) => isText(it) && Boolean((it as { block: { text?: string } }).block.text?.trim());
    const lastWork = items.findLastIndex(isWork);
    const lastText = items.findLastIndex(said);
    // Where the reply starts: after the last step, or at the last thing said when nothing was after it.
    const reply = lastText > lastWork ? lastWork : lastText;
    const out: Seg<R>[] = [];
    items.forEach((it, i) => {
        if (isWork(it)) {
            const prev = out[out.length - 1];
            if (prev?.kind === "work") prev.items.push(it);
            else out.push({ kind: "work", items: [it] });
        } else out.push({ kind: "item", item: it, interim: i < reply && isText(it) });
    });
    return out;
}

/** How long a state shows on the live line, at least, before the line moves on to another: long enough to read it. */
export const DWELL_MS = 400;

/** How long until the live line may move on from a state it began showing at `shownAt`: 0 for now. */
export function dwellLeft(shownAt: number | undefined, now: number): number {
    return shownAt === undefined ? 0 : Math.max(0, shownAt + DWELL_MS - now);
}

/** A glide never covers more than this: farther, the content starts this far off and slides the rest of the way in. */
export const GLIDE_MAX = 240;

/**
 * Where a glide starts: the content is drawn `delta` px lower than it is (the distance the end moved) plus what's
 * left of a glide still running, so back-to-back growth is one motion; never farther than `max`. Undefined:
 * nothing to glide.
 */
export function glideFrom(delta: number, running = 0, max = GLIDE_MAX): number | undefined {
    const from = Math.max(-max, Math.min(max, delta + running));
    return Math.abs(from) < 1 ? undefined : from;
}

/** Rows that land together (a fast agent's calls finishing in one update) come in one after another, this far apart. */
export const STAGGER_MS = 50;
/** No row waits longer than this to come in, however many land at once. */
export const STAGGER_MAX = 200;
/** When the row to come in next may start (ms). */
let nextRow = -Infinity;

/** How long a row landing at `now` waits to come in: `step` after the row before it started, and never long. */
export function staggerDelay(now: number, step = STAGGER_MS): number {
    const delay = Math.min(STAGGER_MAX, Math.max(0, nextRow - now));
    nextRow = now + delay + step;
    return delay;
}

/**
 * A row of a running turn's work, just made: its step-in (transcript.css) waits for the rows that landed before
 * it (--enter). `step`: STAGGER_MS as the motion settings have it (0: no motion, no wait).
 */
export function enterRow(el: HTMLElement, step: number) {
    if (!step) return;
    // Placed in the page by then; only a running turn's rows wait (not those of a finished turn's opened work).
    queueMicrotask(() => {
        if (!el.closest?.('.turn[aria-busy="true"]')) return;
        const delay = staggerDelay(performance.now(), step);
        if (delay) el.style.setProperty("--enter", `${delay}ms`);
    });
}
