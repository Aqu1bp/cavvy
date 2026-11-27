// Suggested tasks: an agent that comes across a problem unrelated to its task
// suggests it (SuggestTask, src/tools/suggest-tools.ts) as a card the user
// starts as a new session or dismisses. What's here is the session's side:
// the records kept in its file ({t:"suggestion"}, the last line for an id
// wins), how each moves between states, and what windows are sent of them.
// Starting one is the window's (tasks.start on the target machine), never the
// agent's.

import { visible } from "../mcp/approval";
import type { EffortLevel, SuggestionAction, SuggestionStarted, SuggestionState, SuggestionStatus } from "../server/protocol";
import { redact } from "../util/redact";

export const SUGGEST_LIMITS = {
    title: 80,
    prompt: 4000,
    why: 200,
    /** Suggestions one turn may make. */
    perTurn: 3,
    /** Waiting for the user in one session. */
    pending: 20,
    /** Resolved ones sent with their prompt; older ones are sent without it. */
    withPrompt: 20,
    /** Kept in memory (the file keeps them all). */
    kept: 100,
};

/**
 * As kept in the session file. `seg` and `msg`: the session's compactions and messages when it was made, so a rewind
 * past it takes it away ("withdrawn": never sent to a window).
 */
export interface SuggestionRecord extends Omit<SuggestionState, "state"> {
    state: SuggestionStatus | "withdrawn";
    prompt: string;
    seg: number;
    msg: number;
}

/** What the agent asked for, checked and trimmed. */
export interface SuggestionInput {
    title: string;
    prompt: string;
    why: string;
    hint?: { model?: string; effort?: EffortLevel };
}

/** What the session that shows suggestions does for the tool (the app's Runtime). Absent: not offered. */
export interface SuggestHost {
    /** Records it, or says why not (the refusal text for the agent). */
    suggest(s: SuggestionInput, callId: string): { ok: true } | { error: string };
}

const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
const str = (v: unknown) => (typeof v === "string" ? v : "");
/** One line: runs of whitespace (line breaks too) as one space. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The agent's input, checked: an error for the agent, or what to record. */
export function checkSuggestion(i: Record<string, unknown>): { error: string } | { input: SuggestionInput } {
    const title = oneLine(str(i.title));
    const prompt = str(i.prompt).trim();
    const why = oneLine(str(i.why));
    if (!title) return { error: "title is required: a few words saying what's wrong." };
    if (title.length > SUGGEST_LIMITS.title) return { error: `title is ${title.length} characters; keep it to ${SUGGEST_LIMITS.title}.` };
    if (!prompt) return { error: "prompt is required: the new session's first message, self-contained." };
    if (prompt.length > SUGGEST_LIMITS.prompt) return { error: `prompt is ${prompt.length} characters; keep it to ${SUGGEST_LIMITS.prompt}.` };
    if (!why) return { error: "why is required: one sentence saying what you saw, and where." };
    if (why.length > SUGGEST_LIMITS.why) return { error: `why is ${why.length} characters; keep it to ${SUGGEST_LIMITS.why}.` };
    if (i.model !== undefined && (typeof i.model !== "string" || !/^[\w.-]+:\S{1,200}$/.test(i.model.trim()))) return { error: "model must be provider:model, or left out." };
    if (i.effort !== undefined && !EFFORTS.includes(str(i.effort))) return { error: `effort must be one of ${EFFORTS.join(", ")}, or left out.` };
    const model = str(i.model).trim() || undefined;
    const effort = (str(i.effort) || undefined) as EffortLevel | undefined;
    // Redacted before it's kept or shown: a key the agent saw doesn't go into a card, a file or another session.
    return { input: { title: redact(title), prompt: redact(prompt), why: redact(why), ...(model || effort ? { hint: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } } : {}) } };
}

const sameTitle = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Why a new suggestion is refused, given the session's and this turn's: undefined when it may be made. */
export function refusal(records: Iterable<SuggestionRecord>, title: string, thisTurn: number): string | undefined {
    if (thisTurn >= SUGGEST_LIMITS.perTurn) return `You've suggested ${SUGGEST_LIMITS.perTurn} tasks this turn, as many as a turn may. Mention any others in your reply.`;
    let pending = 0;
    for (const r of records) {
        if (r.state === "withdrawn") continue;
        if ((r.state === "pending" || r.state === "starting") && sameTitle(r.title, title)) return `“${title}” is already suggested in this session.`;
        if (r.state === "dismissed" && sameTitle(r.title, title)) return `The user dismissed “${title}” in this session. Don't suggest it again.`;
        if (r.state === "pending") pending++;
    }
    if (pending >= SUGGEST_LIMITS.pending) return `${SUGGEST_LIMITS.pending} suggestions are waiting for the user in this session. Mention this one in your reply.`;
    return undefined;
}

export class SuggestionError extends Error {
    constructor(
        message: string,
        readonly code: string,
    ) {
        super(message);
    }
}

/** The record after a window's action, or a SuggestionError. Repeating what's already so is no change. */
export function applyAction(r: SuggestionRecord, a: SuggestionAction, now = Date.now()): SuggestionRecord {
    const refuse = (why: string): never => {
        throw new SuggestionError(why, "not_pending");
    };
    if (r.state === "withdrawn") throw new SuggestionError("That suggestion is gone.", "not_found");
    switch (a.action) {
        case "claim":
            if (r.state === "starting") refuse("It's already being started.");
            if (r.state === "started") refuse("It's already started.");
            if (r.state !== "pending") refuse("It was dismissed. Restore it to start it.");
            return { ...r, state: "starting", failed: undefined };
        case "started": {
            const s = startedOf(a.started, now);
            if (!s) throw new SuggestionError("That says nothing of where it started.", "invalid");
            // Started again with the session it already has: no change. Any other while started is a second start.
            if (r.state === "started" && r.started?.sessionId !== s.sessionId) refuse("It's already started.");
            if (r.state === "dismissed") refuse("It was dismissed.");
            return { ...r, state: "started", started: s, failed: undefined };
        }
        case "failed":
            if (r.state === "started") refuse("It's already started.");
            if (r.state === "dismissed") return r;
            return { ...r, state: "pending", failed: oneLine(redact(str(a.message))).slice(0, 300) || "It didn't start." };
        case "dismissed":
            if (r.state === "dismissed") return r;
            if (r.state !== "pending") refuse(r.state === "started" ? "It's already started." : "It's being started.");
            return { ...r, state: "dismissed", failed: undefined };
        case "pending":
            if (r.state === "pending") return r;
            if (r.state !== "dismissed") refuse(r.state === "started" ? "It's already started." : "It's being started.");
            return { ...r, state: "pending" };
    }
    throw new SuggestionError("Unknown action.", "invalid");
}

function startedOf(v: unknown, now: number): SuggestionStarted | undefined {
    const x = v as Record<string, unknown> | null;
    if (!x || typeof x !== "object" || typeof x.sessionId !== "string" || !x.sessionId || x.sessionId.length > 300) return undefined;
    const wt = x.worktree as Record<string, unknown> | undefined;
    return {
        sessionId: x.sessionId,
        ...(typeof x.machine === "string" && x.machine ? { machine: x.machine.slice(0, 100) } : {}),
        title: oneLine(str(x.title)).slice(0, 200),
        cwd: str(x.cwd).slice(0, 4096),
        ...(wt && typeof wt.path === "string" && typeof wt.branch === "string" ? { worktree: { path: wt.path.slice(0, 4096), branch: wt.branch.slice(0, 300) } } : {}),
        at: typeof x.at === "number" ? x.at : now,
        ...(typeof x.problem === "string" && x.problem ? { problem: oneLine(redact(x.problem)).slice(0, 300) } : {}),
    };
}

/** A record as read from a file line, or undefined when it isn't one. */
export function validRecord(v: unknown): SuggestionRecord | undefined {
    const x = v as Record<string, unknown> | null;
    if (!x || typeof x !== "object" || typeof x.id !== "string" || !x.id || typeof x.title !== "string" || typeof x.prompt !== "string") return undefined;
    if (!["pending", "starting", "started", "dismissed", "withdrawn"].includes(str(x.state))) return undefined;
    return {
        id: x.id,
        title: x.title,
        prompt: x.prompt,
        why: str(x.why),
        ...(x.hint && typeof x.hint === "object" ? { hint: x.hint as SuggestionRecord["hint"] } : {}),
        at: typeof x.at === "number" ? x.at : 0,
        state: x.state as SuggestionRecord["state"],
        ...(x.started ? { started: startedOf(x.started, 0) } : {}),
        ...(typeof x.failed === "string" && x.failed ? { failed: x.failed } : {}),
        seg: typeof x.seg === "number" ? x.seg : 0,
        msg: typeof x.msg === "number" ? x.msg : 0,
    };
}

/** Those a rewind to `count` messages (in segment `seg`) takes away: made after what's kept. */
export function rewoundAway(records: Iterable<SuggestionRecord>, seg: number, count: number): SuggestionRecord[] {
    return [...records].filter((r) => r.state !== "withdrawn" && r.seg === seg && r.msg > count);
}

/**
 * What windows are sent: none withdrawn, oldest first; what the agent wrote with what's invisible shown (visible()), so
 * a hidden instruction can't pass for nothing; resolved ones beyond the last few without their prompt.
 */
export function shownSuggestions(records: Iterable<SuggestionRecord>): SuggestionState[] {
    const all = [...records].filter((r) => r.state !== "withdrawn").sort((a, b) => a.at - b.at);
    const resolved = all.filter((r) => r.state === "started" || r.state === "dismissed");
    const bare = new Set(resolved.slice(0, Math.max(0, resolved.length - SUGGEST_LIMITS.withPrompt)).map((r) => r.id));
    return all.map(({ seg: _seg, msg: _msg, ...r }) => ({
        ...r,
        state: r.state as SuggestionStatus,
        title: visible(r.title).text,
        why: visible(r.why).text,
        ...(bare.has(r.id) ? { prompt: undefined } : { prompt: visible(r.prompt, { lineBreaks: true }).text }),
    }));
}

/** Waiting for the user. */
export function pendingCount(records: Iterable<SuggestionRecord>): number {
    let n = 0;
    for (const r of records) if (r.state === "pending") n++;
    return n;
}

/** "fix/<slug>" for a title: lower case, words joined by "-", at most 40 characters of them. */
export function branchSlug(title: string): string {
    const words = title
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(" ")
        .filter(Boolean);
    let slug = "";
    for (const w of words) {
        const next = slug ? `${slug}-${w}` : w;
        if (next.length > 40) break;
        slug = next;
    }
    return `fix/${slug || "task"}`;
}
