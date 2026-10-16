// Plan limits as the agent CLIs report them over their own protocols: Claude
// Code's rate_limit_event and Codex's account/rateLimits (read, and updated).
// Only what a meter needs is kept: window names, percentages, reset times and
// whether a limit is reached. Account ids, emails, plan names and credit
// balances in these payloads are never read.
//
// Field names are from captures of Claude Code 2.1.301 and Codex 0.163.0
// (test/fixtures/limits); anything missing is left out, not guessed.

import type { LimitWindow, PlanLimits } from "../server/protocol";
import { redact } from "../util/redact";

/** A CLI's string shown to the user: bounded and redacted. */
function label(s: string, max = 40): string {
    return redact(s.replace(/\s+/g, " ").trim()).slice(0, max);
}

/** Epoch seconds (both CLIs) to ms; undefined unless it's a plausible time. */
function seconds(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v * 1000 : undefined;
}

/** A percentage to show: 100 only when it's all used (99.6% shows as 99, not as a reached limit). */
function percent(v: unknown, scale: number): number | undefined {
    if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
    return full(v, scale) ? 100 : Math.max(0, Math.min(99, Math.round(v * scale)));
}

function full(v: unknown, scale: number): boolean {
    return typeof v === "number" && v * scale >= 100;
}

const CLAUDE_WINDOWS: Record<string, string> = {
    five_hour: "5-hour",
    seven_day: "Weekly",
    seven_day_opus: "Weekly Opus",
    seven_day_sonnet: "Weekly Sonnet",
};

function claudeLabel(key: string): string {
    const known = CLAUDE_WINDOWS[key];
    if (known) return known;
    const words = key.replace(/_/g, " ");
    return label(words.charAt(0).toUpperCase() + words.slice(1));
}

/**
 * Claude Code's rate_limit_info: `status` (allowed, allowed_warning, rejected),
 * `resetsAt` and `rateLimitType` for the window it's about, and (2.1.301)
 * `unifiedWindows` with each window's `utilization` (0-1) and `resetsAt`.
 * `partial`: it didn't list the windows, so earlier ones still stand.
 */
export function parseClaudeRateLimit(info: unknown, at = Date.now()): { limits: PlanLimits; partial: boolean } | undefined {
    if (!info || typeof info !== "object") return undefined;
    const i = info as Record<string, unknown>;
    const status = typeof i.status === "string" ? i.status : undefined;
    const type = typeof i.rateLimitType === "string" && i.rateLimitType ? label(i.rateLimitType, 60) : undefined;
    const resetsAt = seconds(i.resetsAt);
    const windows: LimitWindow[] = [];
    const listed = i.unifiedWindows && typeof i.unifiedWindows === "object" ? Object.entries(i.unifiedWindows as Record<string, any>).slice(0, 8) : undefined;
    for (const [key, w] of listed ?? []) {
        if (!w || typeof w !== "object") continue;
        const usedPercent = percent(w.utilization, 100);
        windows.push({ id: label(key, 60), label: claudeLabel(key), usedPercent, resetsAt: seconds(w.resetsAt), reached: full(w.utilization, 100) ? true : undefined });
    }
    let named: LimitWindow | undefined;
    if (type) {
        named = windows.find((x) => x.id === type);
        if (!named) windows.push((named = { id: type, label: claudeLabel(type) }));
        named.resetsAt ??= resetsAt;
        if (status === "rejected") named.reached = true;
    }
    if (!status && !windows.length) return undefined;
    const reached = status === "rejected" ? true : status === "allowed" || status === "allowed_warning" ? false : undefined;
    // Every exhausted window blocks usage, even if the rejection names only one.
    const blocking = windows.filter((w) => w.reached && (w.resetsAt === undefined || w.resetsAt > at));
    const blockingResets = [resetsAt, latestReset(blocking)].filter((t): t is number => t !== undefined);
    const lifts = reached && !blocking.some((w) => w.resetsAt === undefined) && blockingResets.length ? Math.max(...blockingResets) : undefined;
    return { limits: { provider: "claude-code", windows, reached, resetsAt: lifts, at }, partial: !listed };
}

function codexWindowLabel(mins: unknown, slot: string): string {
    if (typeof mins !== "number" || !Number.isFinite(mins) || mins <= 0) return slot === "primary" ? "Primary" : "Secondary";
    if (mins === 300) return "5-hour";
    if (mins === 10080) return "Weekly";
    if (mins % 1440 === 0) return `${mins / 1440}-day`;
    if (mins % 60 === 0) return `${mins / 60}-hour`;
    return `${Math.round(mins)}-minute`;
}

/** One RateLimitSnapshot's windows: `primary` and `secondary` ({usedPercent, windowDurationMins, resetsAt}). */
function codexWindows(s: Record<string, any>): LimitWindow[] {
    const limitId = typeof s.limitId === "string" && s.limitId ? label(s.limitId, 60) : "codex";
    // Codex's own limit needs no name; another metered one (a model's) is named, as Codex names it.
    const name = limitId === "codex" ? "" : `${label(typeof s.limitName === "string" && s.limitName ? s.limitName : limitId, 30)} `;
    const out: LimitWindow[] = [];
    for (const slot of ["primary", "secondary"] as const) {
        const w = s[slot];
        if (!w || typeof w !== "object") continue;
        const usedPercent = percent(w.usedPercent, 1);
        out.push({ id: `${limitId}:${slot}`, label: `${name}${codexWindowLabel(w.windowDurationMins, slot)}`, usedPercent, resetsAt: seconds(w.resetsAt), reached: full(w.usedPercent, 1) ? true : undefined });
    }
    return out;
}

/** Why Codex says a limit is reached (RateLimitReachedType), in words. */
export function codexReachedType(s: unknown): string | undefined {
    const t = (s as Record<string, unknown> | undefined)?.rateLimitReachedType;
    return typeof t === "string" && t ? label(t.replace(/_/g, " "), 60) : undefined;
}

/**
 * Codex's account/rateLimits/read result (full: `rateLimitsByLimitId`, or
 * `rateLimits`), or an account/rateLimits/updated's `rateLimits` (sparse: a
 * window it leaves out, or a null rateLimitReachedType, doesn't clear what was known).
 */
export function parseCodexRateLimits(r: unknown, opts: { update?: boolean; at?: number } = {}): { limits: PlanLimits; partial: boolean } | undefined {
    if (!r || typeof r !== "object") return undefined;
    const o = r as Record<string, any>;
    const snapshots: Record<string, any>[] = [];
    if (opts.update) {
        if (o.rateLimits && typeof o.rateLimits === "object") snapshots.push(o.rateLimits);
    } else {
        const byId = o.rateLimitsByLimitId && typeof o.rateLimitsByLimitId === "object" ? Object.values(o.rateLimitsByLimitId).filter((x): x is Record<string, any> => Boolean(x) && typeof x === "object") : [];
        if (byId.length) snapshots.push(...byId.slice(0, 6));
        else if (o.rateLimits && typeof o.rateLimits === "object") snapshots.push(o.rateLimits);
    }
    if (!snapshots.length) return undefined;
    const windows = snapshots.flatMap(codexWindows);
    const flagged = snapshots.some((s) => codexReachedType(s)) || o.ordinaryUsageAllowed === false;
    // A full read says it isn't reached; an update's null only means it didn't say.
    const reached = flagged || windows.some((w) => w.reached) ? true : opts.update ? undefined : false;
    return { limits: { provider: "codex", windows, reached, resetsAt: reached ? limitResetsAt(windows) : undefined, at: opts.at ?? Date.now() }, partial: Boolean(opts.update) };
}

function latestReset(windows: LimitWindow[]): number | undefined {
    // A known window's reset says nothing about when another blocker will lift.
    if (windows.some((w) => w.resetsAt === undefined)) return undefined;
    const times = windows.map((w) => w.resetsAt).filter((t): t is number => t !== undefined);
    return times.length ? Math.max(...times) : undefined;
}

/** When a reached limit lifts: the last of the reached windows' resets, else the fullest window's. */
function limitResetsAt(windows: LimitWindow[]): number | undefined {
    const reached = windows.filter((w) => w.reached);
    if (reached.length) return latestReset(reached);
    const fullest = [...windows].filter((w) => w.resetsAt !== undefined).sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0];
    return fullest?.resetsAt;
}

/**
 * What's known now, given an earlier report and a new one (`partial`: the
 * new one may leave things out). A reported window keeps an omitted reset
 * while that reset is still ahead; a limit reached earlier stands while a
 * full window (or, with none to show for it, its reset time) says so.
 */
export function mergeLimits(prev: PlanLimits | undefined, next: PlanLimits, partial: boolean): PlanLimits {
    if (!prev || !partial) return next;
    const windows = prev.windows.map((w) => {
        const n = next.windows.find((n) => n.id === w.id);
        if (!n) return w;
        return n.resetsAt === undefined && w.resetsAt !== undefined && w.resetsAt > next.at ? { ...n, resetsAt: w.resetsAt } : n;
    });
    for (const n of next.windows) if (!windows.some((w) => w.id === n.id)) windows.push(n);
    const live = (t: number | undefined) => t === undefined || t > next.at;
    const exhausted = windows.filter((w) => w.reached && live(w.resetsAt));
    let reached = exhausted.length ? true : next.reached;
    if (reached === undefined) {
        // Reached for a full window that has since reset, or been reported with room: no longer.
        if (prev.reached && prev.windows.some((w) => w.reached)) reached = false;
        // Reached with no window to show for it (credits, say): until its reset, when known.
        else reached = prev.reached && live(prev.resetsAt) ? true : prev.reached === undefined ? undefined : false;
    }
    // It lifts when the last of what's blocking it does: the full windows, and the new report's own reset.
    const blockers = [...exhausted.map((w) => w.resetsAt), next.reached ? next.resetsAt : undefined].filter((t): t is number => t !== undefined);
    const resetsAt = reached && !exhausted.some((w) => w.resetsAt === undefined) ? (blockers.length ? Math.max(...blockers) : live(prev.resetsAt) ? prev.resetsAt : undefined) : undefined;
    return { provider: next.provider, windows, reached, resetsAt, at: next.at };
}

/** "4:40 PM" today, else "Mon 20 Oct, 9:00 AM" (local time). */
export function clockTime(ms: number, now = Date.now()): string {
    const d = new Date(ms);
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === new Date(now).toDateString()) return time;
    return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}

/** "2h 5m", "3d 4h", "12m". */
export function untilText(ms: number, now = Date.now()): string {
    const mins = Math.max(1, Math.round((ms - now) / 60_000));
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    if (h < 24) return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** "at 4:40 PM (in 2h 5m)": when a limit resets, for a sentence. */
export function resetPhrase(ms: number, now = Date.now()): string {
    const when = clockTime(ms, now);
    const today = new Date(ms).toDateString() === new Date(now).toDateString();
    if (ms <= now) return `${today ? "at" : "on"} ${when} (it may have reset already)`;
    return `${today ? "at" : "on"} ${when} (in ${untilText(ms, now)})`;
}

/** The sentence a limit-hit error or notice ends with. */
export function resetSentence(resetsAt: number | undefined, cli: string, now = Date.now()): string {
    return resetsAt ? `It resets ${resetPhrase(resetsAt, now)}.` : `${cli} didn't say when it resets.`;
}

/** One line per window, for the terminal's /cost: "5-hour 62% · resets at 4:40 PM (in 2h 5m)". */
export function limitLines(l: PlanLimits, now = Date.now()): string[] {
    const lines = l.windows.map((w) => [w.label, w.usedPercent !== undefined ? `${w.usedPercent}%` : undefined, w.reached ? "reached" : undefined].filter(Boolean).join(" ") + (w.resetsAt ? ` · resets ${resetPhrase(w.resetsAt, now)}` : ""));
    if (l.reached && !l.windows.some((w) => w.reached)) lines.unshift(`Limit reached${l.resetsAt ? ` · resets ${resetPhrase(l.resetsAt, now)}` : ""}`);
    return lines;
}

/**
 * Whether a window's status is news: not the status and reset it had when
 * last reported. `seen` (by window) remembers it, across turns and sessions,
 * since the CLI repeats it with every request.
 */
export function limitNews(seen: Map<string, string>, window: string, status: string, resetsAt: number | undefined): boolean {
    const now = `${status}:${resetsAt ?? ""}`;
    const was = seen.get(window);
    seen.delete(window);
    seen.set(window, now);
    if (seen.size > 50) seen.delete(seen.keys().next().value!);
    return was !== now;
}
