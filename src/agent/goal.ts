// /goal: keep working until a condition holds.
//
// After each turn, a check decides whether the condition is met. If it isn't,
// another turn starts with the check's reason as guidance, instead of control
// returning to the user. The goal ends when the check says it's met or can
// never be met, or when the user clears it. Claude Code's /goal works the same
// way (a session-scoped, model-evaluated Stop hook).
//
// The check is a separate small model when one can answer one-off requests
// (the judge). Claude Code and Codex run whole turns only, so with nothing else
// set up the working model reports for itself (as Codex's own goals do): its
// last line says whether the goal is met.
//
// Both the terminal app and the GUI server run turns; each hands this
// controller what it needs through GoalHost and calls afterTurn when a turn
// ends with nothing queued.

import type { Session } from "./session";
import type { TurnEndReason } from "./agent";
import type { Message } from "../providers/types";
import { redact } from "../util/redact";
import { duration } from "../server/duration";
import { formatTokens } from "../providers/pricing";
import { ACCOUNT_PROVIDERS } from "../providers/accounts";
import type { GoalState } from "../server/protocol";

/** Claude Code's limit too. */
export const GOAL_MAX_CHARS = 4000;
/** Goal turns in a row without a tool call before the loop pauses (it's only answering the check). */
export const IDLE_TURNS = 3;
/** Waits before retrying after an error that tends to pass; then it pauses. */
export const RETRY_DELAYS_MS = [30_000, 60_000, 120_000];
/** How long background work can hold the check before it runs anyway. */
export const BACKGROUND_WAIT_MS = 30 * 60_000;
const BACKGROUND_POLL_MS = 2000;
/** The transcript the judge sees: the newest part of the conversation, this long at most. */
const JUDGE_CHARS = 40_000;
const RESULT_CHARS = 1500;
const JUDGE_TIMEOUT_MS = 60_000;

const CLEAR_WORDS = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

export type GoalCommand = { kind: "status" } | { kind: "clear" } | { kind: "pause" } | { kind: "resume" } | { kind: "set"; condition: string } | { kind: "invalid"; message: string };

/** What `/goal <args>` asks for. */
export function parseGoalCommand(args: string): GoalCommand {
    const t = args.trim();
    if (!t) return { kind: "status" };
    const word = t.toLowerCase();
    if (CLEAR_WORDS.has(word)) return { kind: "clear" };
    if (word === "pause") return { kind: "pause" };
    if (word === "resume" || word === "continue") return { kind: "resume" };
    if (t.length > GOAL_MAX_CHARS) return { kind: "invalid", message: `A goal can be up to ${GOAL_MAX_CHARS.toLocaleString("en-US")} characters; this one is ${t.length.toLocaleString("en-US")}.` };
    return { kind: "set", condition: t };
}

export type Verdict = "met" | "not_met" | "impossible";
export interface Evaluation {
    verdict: Verdict;
    reason: string;
}

/** What's kept in the session file: a reopened session gets its goal back (with its counters reset). */
export interface GoalRecord {
    condition: string;
    setAt: number;
}

/** A goal as the UI shows it. */
export type GoalView = GoalState;

export interface GoalOutcome {
    condition: string;
    result: "met" | "impossible" | "cleared";
    reason?: string;
    ms: number;
    turns: number;
    tokens: number;
}

export interface GoalHost {
    session: Session;
    /** Tokens the session has used so far (input and output, all models). */
    tokens(): number;
    /** Whether a model other than a CLI backend can answer one-off requests (the small model, or the session's own). */
    canJudge(): boolean;
    /** A one-off completion on that model. */
    judge(system: string, prompt: string, signal: AbortSignal): Promise<string>;
    /** Delegated tasks or background commands still running: the check waits for them. */
    backgroundRunning(): number;
    /** No turn, command or task is running and nothing is queued. */
    idle(): boolean;
    /** Show a line in the transcript (and keep it, so a reopened session shows it). */
    notice(text: string, level: "info" | "warn" | "error"): void;
    /** The goal's state changed (redraw, broadcast). */
    changed(): void;
    /** It stopped going on its own (achieved, impossible, paused, cleared by an error): tell a user who may have walked away. */
    alert?(kind: "done" | "error", text: string, elapsedMs: number): void;
    /** Start a goal turn with this prompt. */
    startTurn(prompt: string, display: string): void;
    setTimer?(fn: () => void, ms: number): unknown;
    clearTimer?(t: unknown): void;
    now?(): number;
}

interface Active {
    condition: string;
    since: number;
    baseTokens: number;
    turns: number;
    idleTurns: number;
    retries: number;
    lastReason?: string;
    state: GoalView["state"];
    note?: string;
    retryAt?: number;
    waitingSince?: number;
}

const SELF_REPORT = /^[\s>*_`]*GOAL:[*_`]*\s*[*_`]*(met|not[ _-]?met|impossible)\b[*_`]*\s*(?:[—–:\-]+\s*)?(.*)$/gim;

export class GoalController {
    private goal?: Active;
    /** The last goal that ended (shown by /goal when none is set). */
    last?: GoalOutcome;
    /** Bumped whenever what's pending is overtaken (a user's turn, clear, pause): a stale check or timer then does nothing. */
    private gen = 0;
    private timer?: unknown;
    private checking?: AbortController;

    constructor(private host: GoalHost) {}

    get active(): boolean {
        return this.goal !== undefined;
    }

    get condition(): string | undefined {
        return this.goal?.condition;
    }

    /** A check, a retry or a continuation is coming: the session isn't free for other automatic prompts. */
    pending(): boolean {
        const s = this.goal?.state;
        return s === "checking" || s === "waiting" || (s === "active" && this.timer !== undefined);
    }

    view(): GoalView | undefined {
        const g = this.goal;
        if (!g) return undefined;
        return {
            condition: g.condition,
            state: g.state,
            since: g.since,
            turns: g.turns,
            tokens: Math.max(0, this.host.tokens() - g.baseTokens),
            judge: this.host.canJudge() ? "model" : "self",
            ...(g.lastReason ? { lastReason: g.lastReason } : {}),
            ...(g.note ? { note: g.note } : {}),
            ...(g.retryAt ? { retryAt: g.retryAt } : {}),
        };
    }

    private now() {
        return this.host.now?.() ?? Date.now();
    }

    /** Set (or replace) the goal. Returns the first turn's prompt; the caller starts it, or the running turn's end picks it up. */
    set(condition: string): { prompt: string; display: string } {
        this.cancelPending();
        const replaced = this.goal?.condition;
        this.goal = { condition, since: this.now(), baseTokens: this.host.tokens(), turns: 0, idleTurns: 0, retries: 0, state: "active" };
        this.last = undefined;
        this.host.session.setGoal({ condition, setAt: this.goal.since });
        if (replaced) this.host.notice(`Replaced the goal: ${clip(replaced, 200)}`, "info");
        this.host.changed();
        return { prompt: this.directive(), display: `/goal ${condition}` };
    }

    /** Remove the goal. Returns its condition, or undefined when there was none. */
    clear(): string | undefined {
        const g = this.goal;
        if (!g) return undefined;
        this.finish("cleared");
        return g.condition;
    }

    /** Stop going on its own until the user's next message or /goal resume. */
    pause(note: string) {
        const g = this.goal;
        if (!g) return;
        this.cancelPending();
        g.state = "paused";
        g.note = note;
        g.retryAt = undefined;
        this.host.changed();
    }

    /** /goal resume: check where it stands now and go on from there (or after the running turn). */
    resume(): boolean {
        const g = this.goal;
        if (!g) return false;
        this.cancelPending();
        g.state = "active";
        g.note = undefined;
        g.idleTurns = 0;
        g.retries = 0;
        this.host.changed();
        // The last turn may not have been checked (it was interrupted, or the goal was paused or restored): check first,
        // once delegated work still running is done.
        if (this.host.idle()) {
            if (this.host.backgroundRunning() > 0) this.waitForBackground();
            else void this.check(this.host.session.messages.slice(-40));
        }
        return true;
    }

    /** A reopened session's goal: kept, but it continues only after the user's next message (or /goal resume). */
    restore(record: GoalRecord | undefined) {
        if (!record || this.goal) return;
        this.goal = { condition: record.condition, since: this.now(), baseTokens: this.host.tokens(), turns: 0, idleTurns: 0, retries: 0, state: "paused", note: "Restored with the session: it continues after your next message, or /goal resume." };
        this.host.changed();
    }

    /** A turn the user started (a message, a command): it overtakes whatever was pending, and a paused goal picks up after it. */
    userTurn() {
        const g = this.goal;
        if (!g) return;
        this.cancelPending();
        g.state = "active";
        g.note = undefined;
        g.retryAt = undefined;
        g.idleTurns = 0;
        g.retries = 0;
        this.host.changed();
    }

    /**
     * A turn ended and nothing is queued. `from` is where the turn's messages
     * start in the session, to see whether it used tools (and, for a model that
     * reports for itself, what it said last); `startedAt` is when it started, to
     * find the error it ended with. A compaction during the turn replaces the
     * messages: then what's left after it is the turn's.
     */
    async afterTurn(reason: TurnEndReason, from: number, goalTurn: boolean, startedAt = 0): Promise<void> {
        const g = this.goal;
        if (!g || g.state === "paused") return;
        if (reason === "aborted") return this.pause("Interrupted. It continues after your next message, or /goal resume.");
        if (reason === "denied") return this.pauseWith("Goal paused: a tool call was declined. Send a message or /goal resume to continue.");
        if (reason === "blocked") return this.pauseWith("Goal paused: a hook blocked the prompt. Send a message or /goal resume to continue.");
        if (reason === "max_turns") return this.pauseWith("Goal paused: the turn stopped at its model-turn limit. Send a message or /goal resume to continue.");
        if (reason === "error") return this.afterError(startedAt);
        g.retries = 0;
        const messages = this.host.session.messages;
        const turn = messages.slice(from <= messages.length ? from : 0);
        if (goalTurn) {
            g.idleTurns = usedTools(turn) ? 0 : g.idleTurns + 1;
            if (g.idleTurns >= IDLE_TURNS) {
                g.idleTurns = 0;
                return this.pauseWith(`Goal paused: ${IDLE_TURNS} turns in a row without using a tool, so it doesn't look like progress. The goal is still set: send a message to continue, or /goal clear.`);
            }
        }
        if (this.host.backgroundRunning() > 0) return this.waitForBackground();
        await this.check(turn);
    }

    private pauseWith(text: string) {
        this.host.notice(text, "warn");
        this.alert("done", text);
        const why = text.replace(/^Goal paused: /, "");
        this.pause(why.charAt(0).toUpperCase() + why.slice(1));
    }

    private afterError(startedAt: number) {
        const g = this.goal!;
        // By time, not position: a compaction during the turn starts the notices over.
        const text = this.host.session.notices.filter((n) => n.at >= startedAt && n.level === "error").at(-1)?.text ?? "";
        const kind = classifyError(text);
        const cause = clip(text.replace(/\s+/g, " ").trim() || "the turn stopped with an error", 200);
        if (kind === "fatal") {
            const text = `Goal cleared after an unrecoverable error: ${cause}. Fix it, then run /goal again to continue.`;
            this.host.notice(text, "error");
            this.alert("error", text);
            this.finish("cleared");
            return;
        }
        if (kind === "limit" || g.retries >= RETRY_DELAYS_MS.length) {
            return this.pauseWith(`Goal paused: ${kind === "limit" ? cause : `still failing after ${RETRY_DELAYS_MS.length} retries (${cause})`}. Send a message or /goal resume to continue.`);
        }
        const delay = RETRY_DELAYS_MS[g.retries++]!;
        g.state = "waiting";
        g.retryAt = this.now() + delay;
        g.note = `Retrying after an error: ${cause}`;
        this.host.notice(`Goal still active: retrying in ${Math.round(delay / 1000)}s after an error (${g.retries} of ${RETRY_DELAYS_MS.length}).`, "warn");
        this.host.changed();
        this.schedule(() => this.continueNow(), delay);
    }

    private waitForBackground() {
        const g = this.goal!;
        g.state = "waiting";
        g.waitingSince ??= this.now();
        g.note = "Waiting for background work to finish before checking the goal.";
        this.host.changed();
        const gen = this.gen;
        const poll = () => {
            if (gen !== this.gen || this.goal !== g) return;
            const overdue = this.now() - (g.waitingSince ?? 0) >= BACKGROUND_WAIT_MS;
            if (this.host.backgroundRunning() > 0 && !overdue) return this.schedule(poll, BACKGROUND_POLL_MS);
            this.timer = undefined;
            g.waitingSince = undefined;
            g.note = undefined;
            g.state = "active";
            void this.check(this.host.session.messages.slice(-40));
        };
        this.schedule(poll, BACKGROUND_POLL_MS);
    }

    private async check(turn: Message[]) {
        const g = this.goal!;
        const gen = this.gen;
        let ev: Evaluation | undefined;
        if (this.host.canJudge()) {
            g.state = "checking";
            g.note = undefined;
            this.host.changed();
            const ac = (this.checking = new AbortController());
            const timeout = setTimeout(() => ac.abort(), JUDGE_TIMEOUT_MS);
            let error: string | undefined;
            try {
                const prompt = judgePrompt(g.condition, this.host.session.messages, { turns: g.turns + 1, minutes: Math.round((this.now() - g.since) / 60_000) });
                // A reply that isn't a verdict gets one more try.
                for (let i = 0; i < 2 && !ev; i++) ev = parseVerdict(await this.host.judge(JUDGE_SYSTEM, prompt, ac.signal));
                if (!ev) error = "its answer wasn't a verdict";
            } catch (e) {
                error = (e as Error).message;
            } finally {
                clearTimeout(timeout);
                if (this.checking === ac) this.checking = undefined;
            }
            // Overtaken while it ran: the user's turn (or a clear, a pause) decides what's next.
            if (gen !== this.gen || this.goal !== g) return;
            if (!ev) {
                g.state = "active";
                return this.pauseWith(`Goal paused: couldn't check the goal (${clip(redact(error ?? "no answer"), 200)}). Send a message or /goal resume to continue.`);
            }
        } else {
            ev = selfReport(turn) ?? { verdict: "not_met", reason: "No goal status was reported at the end of the turn." };
        }
        g.turns++;
        g.lastReason = clip(ev.reason, 600);
        if (ev.verdict === "met") {
            const text = `✓ Goal achieved: ${clip(g.condition, 200)} (${this.summary(g)})${ev.reason ? `\n${g.lastReason}` : ""}`;
            this.host.notice(text, "info");
            this.alert("done", text);
            return this.finish("met", ev.reason);
        }
        if (ev.verdict === "impossible") {
            const text = `✗ Goal stopped, judged impossible: ${g.lastReason}`;
            this.host.notice(text, "warn");
            this.alert("done", text);
            return this.finish("impossible", ev.reason);
        }
        this.host.notice(`◎ Goal not met yet: ${g.lastReason}`, "info");
        // The next turn is scheduled before anyone hears of the change, so it never looks idle in between.
        this.continueNow();
    }

    /** Start the next goal turn, now or as soon as nothing else is running. */
    private continueNow() {
        const g = this.goal;
        if (!g) return;
        g.state = "active";
        g.retryAt = undefined;
        g.note = undefined;
        const gen = this.gen;
        const go = () => {
            if (gen !== this.gen || this.goal !== g || g.state !== "active") return;
            if (!this.host.idle()) return this.schedule(go, 250);
            this.timer = undefined;
            // Started first: the session is busy by the time the change is told, so it never reads as idle.
            this.host.startTurn(this.continuation(), CONTINUE_DISPLAY);
            this.host.changed();
        };
        // Its own tick: the turn that just ended is still unwinding in the caller.
        this.schedule(go, 0);
        this.host.changed();
    }

    private finish(result: GoalOutcome["result"], reason?: string) {
        const g = this.goal!;
        this.cancelPending();
        this.last = { condition: g.condition, result, ...(reason ? { reason } : {}), ms: this.now() - g.since, turns: g.turns, tokens: Math.max(0, this.host.tokens() - g.baseTokens) };
        this.goal = undefined;
        this.host.session.setGoal(null);
        this.host.changed();
    }

    /** "3 turns · 4m 10s · 120k tokens" */
    summary(g: { turns: number; since: number; baseTokens?: number } = this.goal!): string {
        const tokens = g.baseTokens === undefined ? 0 : Math.max(0, this.host.tokens() - g.baseTokens);
        return goalSummary(g.turns, this.now() - g.since, tokens);
    }

    private alert(kind: "done" | "error", text: string) {
        const g = this.goal;
        this.host.alert?.(kind, text, g ? this.now() - g.since : 0);
    }

    private schedule(fn: () => void, ms: number) {
        if (this.timer !== undefined) (this.host.clearTimer ?? clearTimeout)(this.timer as any);
        this.timer = (this.host.setTimer ?? setTimeout)(fn, ms);
    }

    private cancelPending() {
        this.gen++;
        if (this.timer !== undefined) (this.host.clearTimer ?? clearTimeout)(this.timer as any);
        this.timer = undefined;
        this.checking?.abort();
        this.checking = undefined;
        if (this.goal) {
            this.goal.waitingSince = undefined;
            if (this.goal.state === "checking" || this.goal.state === "waiting") {
                this.goal.state = "active";
                this.goal.note = undefined;
                this.goal.retryAt = undefined;
            }
        }
    }

    /** Timers and a running check stop (the session is closing). */
    dispose() {
        this.cancelPending();
    }

    private directive(): string {
        const g = this.goal!;
        const judged = this.host.canJudge();
        return [
            `Work toward this goal until it holds:\n\n${g.condition}`,
            `After each of your turns, ${judged ? "a separate check reads the conversation and decides" : "your report decides"} whether the goal is met. If it isn't, you'll be asked to continue, so keep going in concrete steps rather than stopping to ask for confirmation.${judged ? " The check can't run commands or read files itself: show the evidence (test output, command results) in the conversation." : ""}`,
            ...(judged ? [] : [SELF_REPORT_RULE]),
        ].join("\n\n");
    }

    private continuation(): string {
        const g = this.goal!;
        return [
            `Keep working toward the goal:\n\n${g.condition}`,
            g.lastReason ? `It isn't met yet: ${g.lastReason}` : "",
            "Take the next concrete step. If something blocks you that only the user can fix, say exactly what it is.",
            this.host.canJudge() ? "" : SELF_REPORT_RULE,
        ]
            .filter(Boolean)
            .join("\n\n");
    }
}

/** How a goal turn shows in the transcript. */
export const CONTINUE_DISPLAY = "/goal · keep going";

const SELF_REPORT_RULE = "End your final message with one line saying where the goal stands: `GOAL: met`, `GOAL: not met — <what's left>` or `GOAL: impossible — <why>`. Say met only when the conversation shows the evidence; say impossible only when the goal can never hold, not when it's just hard.";

export function goalSummary(turns: number, ms: number, tokens: number): string {
    const parts = [`${turns} turn${turns === 1 ? "" : "s"}`, ms < 1000 ? "0s" : duration(ms)];
    if (tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
    return parts.join(" · ");
}

/**
 * Whether one-off requests (the goal check, titles) have a model that answers
 * them: the small model if one is set, else the session's provider. Claude Code
 * and Codex run whole turns only.
 */
export function canAnswerOneOff(smallModel: string | undefined, sessionProvider: string | undefined): boolean {
    const i = smallModel?.indexOf(":") ?? -1;
    const provider = (smallModel && i > 0 ? smallModel.slice(0, i) : undefined) || sessionProvider;
    return Boolean(provider) && !(ACCOUNT_PROVIDERS as readonly string[]).includes(provider!);
}

/** Claude Code and Codex keep goals of their own: there /goal goes to them, not to the loop here. */
export function nativeGoals(provider: string | undefined): boolean {
    return Boolean(provider) && (ACCOUNT_PROVIDERS as readonly string[]).includes(provider!);
}

/** A goal an agent CLI keeps itself (Claude Code's /goal, Codex's thread goal), as it reports it. */
export interface NativeGoal {
    provider: "claude-code" | "codex";
    condition: string;
    /** "limited": a usage or token budget stopped it; "complete": met; "failed": judged impossible (Claude Code). */
    status: "active" | "paused" | "blocked" | "limited" | "complete" | "failed";
    /** When it was set, ms. */
    since: number;
    /** Turns it has checked (Claude Code), when known. */
    turns?: number;
    tokens?: number;
    lastReason?: string;
}

const NATIVE_NAMES: Record<NativeGoal["provider"], string> = { "claude-code": "Claude Code", codex: "Codex" };

/** What the goal tab and status line show for one. `running`: a turn is going (Claude Code reports no pause of its own). */
export function nativeGoalView(g: NativeGoal, running: boolean): GoalState {
    const by = NATIVE_NAMES[g.provider];
    const waiting = g.status === "active" && !running;
    const note =
        g.status === "paused" ? `Paused in ${by}. /goal resume continues it.`
        : g.status === "blocked" ? `${by} stopped working on it: it's blocked. Send a message to go on.`
        : g.status === "limited" ? `${by} stopped at a usage or token limit.`
        : waiting ? `${by} goes on with it after your next message.`
        : undefined;
    return {
        condition: g.condition,
        state: g.status === "active" && running ? "active" : "paused",
        since: g.since,
        turns: g.turns ?? 0,
        tokens: g.tokens ?? 0,
        judge: "native",
        by,
        canPause: g.provider === "codex",
        ...(g.lastReason ? { lastReason: g.lastReason } : {}),
        ...(note ? { note } : {}),
    };
}

/** A message waiting in the queue that sets a goal: its condition. */
export function queuedGoalSet(text: string): string | undefined {
    const m = text.trim().match(/^\/goal(?:\s+([\s\S]*))?$/i);
    const c = m ? parseGoalCommand(m[1] ?? "") : undefined;
    return c?.kind === "set" ? c.condition : undefined;
}

/** /goal clear: what's said, a /goal <condition> still waiting in the queue (taken out with it) included. */
export function goalClearedNotice(was: string | undefined, dropped: string[]): string {
    const queued = dropped.map((c) => `/goal ${clip(c, 200)}`).join(", ");
    if (!dropped.length) return was ? `Goal cleared: ${was}` : "No goal set";
    return was ? `Goal cleared: ${was}. The queued ${queued} was taken out too.` : `Took the queued ${queued} out of the queue.`;
}

/** The loop's goal, cleared on a switch to Claude Code or Codex (or a session reopened on one). */
export function loopGoalDropped(condition: string, provider: string): string {
    const by = NATIVE_NAMES[provider as NativeGoal["provider"]] ?? provider;
    return `Goal cleared: ${sentence(clip(condition, 200))} ${by} keeps goals of its own: /goal <condition> sets one there.`;
}

/** A CLI's goal paused as the session switched to another model (#412), with how many of its background tasks go on. */
export function nativeGoalLeft(g: NativeGoal, background: number): string {
    const by = NATIVE_NAMES[g.provider];
    const tasks = background === 1 ? " Its background task keeps running." : background > 1 ? ` Its ${background} background tasks keep running.` : "";
    return `${by}'s goal is paused while this session is on another model: ${sentence(clip(g.condition, 200))}${tasks} Switch back to ${by} and send /goal resume to go on with it.`;
}

/** Back on the CLI whose goal paused when the session left it: how to go on. */
export function nativeGoalBack(g: NativeGoal): string {
    return `${NATIVE_NAMES[g.provider]}'s goal is paused: ${sentence(clip(g.condition, 200))} /goal resume goes on with it.`;
}

/** What's said when a CLI's goal ends (met, or judged impossible); undefined while it goes on. */
export function nativeGoalEnd(g: NativeGoal): string | undefined {
    if (g.status === "complete") return `✓ Goal achieved: ${g.condition}${g.lastReason ? `\n${g.lastReason}` : ""}`;
    if (g.status === "failed") return `✗ Goal stopped, judged impossible: ${g.condition}${g.lastReason ? `\n${g.lastReason}` : ""}`;
    return undefined;
}

/** Codex stopped its goal at a usage limit: the automatic resume after it goes on with the goal. */
export function limitedCodexGoal(g: NativeGoal | undefined): boolean {
    return g?.provider === "codex" && g.status === "limited";
}

/** "Goal (Codex, paused): …" and its details, for /goal while a turn runs (the CLI answers it otherwise). */
export function nativeGoalStatus(g: NativeGoal | undefined, running: boolean): string {
    if (!g) return "No goal set.";
    const v = nativeGoalView(g, running);
    return [`◎ Goal (${v.by}${v.state === "paused" ? ", paused" : ""}): ${g.condition}`, ...(v.note ? [v.note] : []), ...(g.lastReason ? [`Last check: ${g.lastReason}`] : [])].join("\n");
}

/** Text closed as a sentence: a period added unless it already ends in . ! or ? (a goal condition often does). */
export function sentence(s: string): string {
    const t = s.trimEnd();
    return /[.!?]$/.test(t) ? t : `${t}.`;
}

function clip(s: string, n: number): string {
    const t = s.trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** A turn did something: a tool call (Cavvy's own), or a CLI backend's actions note. */
export function usedTools(messages: Message[]): boolean {
    return messages.some((m) => m.role === "assistant" && m.content.some((p) => p.type === "tool_call" || (p.type === "text" && /^\[[^\]\n]{1,80} used: /.test(p.text))));
}

/**
 * Errors that won't pass until the user fixes something (the goal is cleared),
 * limits that a retry would only hit again (paused), and the rest (retried).
 */
export function classifyError(text: string): "fatal" | "limit" | "transient" {
    const t = text.toLowerCase();
    // Respect a provider's wait even when a 503 or Gemini's billing wording accompanies it.
    if (/provider requested retry after|retryinfo|please retry in|quotaid[^,}]*per(?:minute|day)/.test(t)) return "limit";
    if (/credit balance|insufficient[_ ]quota|usage limit \/ billing|billing_disabled|requires billing to be enabled|no billing account|payment required|\b402\b/.test(t)) return "fatal";
    if (/rate[_ -]?limit|usage limit|\b429\b|limit (is )?(reached|exceeded)|resets? (at|in)|too many requests|quota/.test(t)) return "limit";
    if (/invalid (x-)?api[_ -]?key|unauthori[sz]ed|authenticat|\b401\b|\b403\b|forbidden|not (signed|logged) in|log ?in again|permission denied/.test(t)) return "fatal";
    if (/context (window|length)|prompt is too long|too many tokens|maximum context|exceeded the model's context/.test(t)) return "fatal";
    if (/model[^.]{0,80}(not found|not available|unavailable|does not exist|isn't available|is not supported)|unknown model|no such model|no model is selected|\b404\b/.test(t)) return "fatal";
    return "transient";
}

/** The model's own report, from the last thing it said in the turn. */
export function selfReport(messages: Message[]): Evaluation | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role !== "assistant") continue;
        const text = m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
        const all = [...text.matchAll(SELF_REPORT)];
        const hit = all.at(-1);
        if (!hit) continue;
        const word = hit[1]!.toLowerCase().replace(/[ _-]/g, "");
        const verdict: Verdict = word === "met" ? "met" : word === "impossible" ? "impossible" : "not_met";
        return { verdict, reason: hit[2]!.replace(/\*+$/, "").trim() };
    }
    return undefined;
}

export const JUDGE_SYSTEM = `You check whether a coding agent has reached a goal. You get the goal and the newest part of the agent's conversation: what the user asked, what the agent said, the tools it called and their output.

Judge only from evidence in the conversation: command and test output, file contents shown, results of tools. The agent's own claims count only when output backs them. You can't run anything yourself.

Answer with JSON only, no other text:
{"verdict": "met" | "not_met" | "impossible", "reason": "<one or two sentences>"}

- met: the evidence shows every part of the goal holds, including any constraints it states.
- not_met: something is missing or unproven. The reason says concretely what's left, as guidance for the agent's next step.
- impossible: the goal can never hold (it contradicts itself, or depends on something that doesn't exist and can't be made). Not for work that is hard, slow or unfinished.
If the goal sets a limit on turns or time, judge it from the progress line; when the limit is reached, answer met if the rest holds, otherwise impossible with the reason.`;

/** The judge's prompt: the goal, how far along it is, and the newest part of the conversation. */
export function judgePrompt(condition: string, messages: Message[], progress: { turns: number; minutes: number }, budget = JUDGE_CHARS): string {
    const chunks: string[] = [];
    let used = 0;
    let omitted = false;
    for (let i = messages.length - 1; i >= 0; i--) {
        const c = describe(messages[i]!);
        if (!c) continue;
        if (used + c.length > budget) {
            // The newest message always goes in, cut to fit.
            if (!chunks.length) chunks.push(c.slice(c.length - budget));
            omitted = true;
            break;
        }
        chunks.push(c);
        used += c.length;
    }
    chunks.reverse();
    return [`<goal>\n${condition}\n</goal>`, `<progress>Check ${progress.turns} of this goal; it has been running ${progress.minutes} minute${progress.minutes === 1 ? "" : "s"}.</progress>`, `<conversation>\n${omitted ? "[earlier conversation omitted]\n\n" : ""}${chunks.join("\n\n")}\n</conversation>`].join("\n\n");
}

function describe(m: Message): string {
    if (m.role === "assistant") {
        const out: string[] = [];
        for (const p of m.content) {
            if (p.type === "text" && p.text.trim()) out.push(`AGENT: ${p.text.trim()}`);
            else if (p.type === "tool_call") out.push(`TOOL CALL ${p.name} ${headTail(JSON.stringify(p.input ?? {}), 400)}`);
        }
        return out.join("\n");
    }
    if (m.meta?.kind === "interrupt") return "[the user interrupted]";
    const out: string[] = [];
    for (const p of m.content) {
        if (p.type === "tool_result") out.push(`TOOL RESULT ${p.toolName}${p.isError ? " (error)" : ""}:\n${headTail(p.content, RESULT_CHARS)}`);
        else if (p.type === "text" && p.text.trim()) {
            // Reminders Cavvy adds are context for the working model, not something the user said.
            const text = p.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
            if (text) out.push(`${m.meta?.kind === "summary" ? "SUMMARY OF EARLIER CONVERSATION" : "USER"}: ${headTail(text, 4000)}`);
        } else if (p.type === "image") out.push("[image]");
        else if (p.type === "file") out.push(`[attached file ${p.name}]`);
    }
    return out.join("\n");
}

function headTail(s: string, n: number): string {
    if (s.length <= n) return s;
    const head = Math.floor(n * 0.4);
    return `${s.slice(0, head)}\n… [${s.length - n} characters cut] …\n${s.slice(s.length - (n - head))}`;
}

/** The judge's answer, or undefined when it isn't a verdict. */
export function parseVerdict(raw: string): Evaluation | undefined {
    const text = raw.replace(/```(?:json)?/gi, "").trim();
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (json) {
        try {
            const j = JSON.parse(json) as Record<string, unknown>;
            const v = typeof j.verdict === "string" ? j.verdict.toLowerCase().replace(/[\s-]/g, "_") : "";
            const verdict: Verdict | undefined = v === "met" || v === "achieved" ? "met" : v === "not_met" || v === "notmet" ? "not_met" : v === "impossible" ? "impossible" : undefined;
            if (verdict) return { verdict, reason: typeof j.reason === "string" ? j.reason.trim() : "" };
        } catch {
            // not JSON after all
        }
    }
    // Not JSON: only a reply that starts with its verdict counts ("met", "not met", "impossible"), never a "met" somewhere in a sentence.
    const lead = /^\W*(not[ _-]?met|impossible|met)\b\W*/i.exec(text);
    if (!lead) return undefined;
    const word = lead[1]!.toLowerCase().replace(/[ _-]/g, "");
    const verdict: Verdict = word === "met" ? "met" : word === "impossible" ? "impossible" : "not_met";
    return { verdict, reason: text.slice(lead[0].length).slice(0, 600).trim() };
}

/** Delegated tasks and background shells still running: what a goal check waits for (as Claude Code's does). */
export function backgroundWork(tasks: readonly { status: string }[] | undefined, shells: ReadonlyMap<string, { exitCode: number | null }>): number {
    let n = (tasks ?? []).filter((t) => t.status === "running").length;
    for (const s of shells.values()) if (s.exitCode === null) n++;
    return n;
}

/** Input and output tokens across the session's models. */
export function sessionTokens(session: Session): number {
    let n = 0;
    for (const { usage } of session.usageByModel.values()) n += usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    return n;
}
