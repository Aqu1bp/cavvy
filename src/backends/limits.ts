// Plan limits as the agent CLIs report them over their own protocols: Claude
// Code's rate_limit_event and /usage, and Codex's account/rateLimits (read, and updated).
// Only what a meter needs is kept: window names, percentages, reset times,
// whether a limit is reached, and whether credits carry turns past it (#434).
// Account ids, emails and plan names in these payloads are never read; of
// credits, only booleans and a status are: Codex's credits.hasCredits and
// credits.unlimited, Claude Code's isUsingOverage and overageStatus. A balance
// or an amount never is.
//
// Field names are from captures of Claude Code 2.1.301 and 2.1.322 and Codex
// 0.163.0 (test/fixtures/limits); anything missing is left out, not guessed. Credits'
// meaning: Codex's app-server protocol (codex-rs/app-server-protocol,
// CreditsSnapshot) and its TUI (has_usable_workspace_credits); Claude Code
// 2.1.304, which sets isUsingOverage when the plan's limit is rejected and
// overageStatus allows overage.

import { usingCredits, type LimitWindow, type NoticeLimit, type PlanLimits } from "../server/protocol";
import { planNow } from "../server/plan-meter";
import { cliAccounts } from "../providers/accounts";
import { agentCli } from "./defs";
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
    // Claude Code 2.1.310 calls it the "Fable limit": the models on its
    // overage-included allowlist count here.
    seven_day_overage_included: "Weekly Fable",
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
 * `unifiedWindows` with each window's `utilization` (0-1) and `resetsAt`, and
 * (2.1.322) its own `status`. It lists only the windows the turn's model
 * counts against (Weekly Fable after a Fable turn, not after an Opus one).
 * `partial`: it didn't list the windows, so earlier ones still stand; one that
 * lists them leaves the others as they were until they reset (mergeLimits).
 */
export function parseClaudeRateLimit(info: unknown, at = Date.now(), accountId = "default"): { limits: PlanLimits; partial: boolean } | undefined {
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
        // Its own status (2.1.322) says whether it's at its limit; without one, a full window is.
        // allowed_warning is still allowed: its share already says how near it is.
        // reached: true (rejected), false (said to be allowed), or unsaid.
        const own = typeof w.status === "string" ? w.status : undefined;
        const reached = own === "rejected" ? true : own === "allowed" || own === "allowed_warning" ? false : full(w.utilization, 100) ? true : undefined;
        windows.push({ id: label(key, 60), label: claudeLabel(key), usedPercent, resetsAt: seconds(w.resetsAt), reached });
    }
    let named: LimitWindow | undefined;
    if (type) {
        named = windows.find((x) => x.id === type);
        if (!named) windows.push((named = { id: type, label: claudeLabel(type) }));
        named.resetsAt ??= resetsAt;
        // The report's own status is the named window's, where that window didn't say.
        if (status === "rejected") named.reached = true;
        else if ((status === "allowed" || status === "allowed_warning") && named.reached === undefined) named.reached = false;
    }
    if (!status && !windows.length) return undefined;
    const reached = status === "rejected" ? true : status === "allowed" || status === "allowed_warning" ? false : undefined;
    // Every exhausted window blocks usage, even if the rejection names only one.
    const blocking = windows.filter((w) => w.reached && (w.resetsAt === undefined || w.resetsAt > at));
    const blockingResets = [resetsAt, latestReset(blocking)].filter((t): t is number => t !== undefined);
    const lifts = reached && !blocking.some((w) => w.resetsAt === undefined) && blockingResets.length ? Math.max(...blockingResets) : undefined;
    const credits = claudeCredits(i);
    return { limits: { provider: "claude-code", accountId, windows, reached, resetsAt: lifts, ...(credits === undefined ? {} : { credits }), at }, partial: !listed };
}

/**
 * Whether extra usage carries turns past the limit. Claude Code 2.1.304 sets
 * `isUsingOverage` when the plan's limit is rejected and `overageStatus` is
 * allowed or allowed_warning (and false on a refused request's record);
 * `overageStatus` alone says whether extra usage is there to go on with.
 */
function claudeCredits(i: Record<string, unknown>): boolean | undefined {
    if (i.isUsingOverage === true) return true;
    if (i.status === "rejected" && i.isUsingOverage === false) return false;
    if (i.overageStatus === "allowed" || i.overageStatus === "allowed_warning") return true;
    return i.overageStatus === "rejected" ? false : undefined;
}

/**
 * Claude Code's `/usage`, answered in print mode without a model call (2.1.322), is text meant for people:
 * a line per window, "Current week (all models): 15% used · resets Nov 24, 8pm (UTC)". Only those lines are
 * read; the rest (tips about this machine's sessions) never is. A line it can't read is left out; with no line
 * read, undefined, so the last report stands.
 */
const USAGE_WINDOWS: [RegExp, string][] = [
    [/^current session$/i, "five_hour"],
    [/^current week \(all models\)$/i, "seven_day"],
    [/^current week \(opus\)$/i, "seven_day_opus"],
    [/^current week \(sonnet\)$/i, "seven_day_sonnet"],
    [/^current week \(fable\)$/i, "seven_day_overage_included"],
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Minutes a time zone is ahead of UTC at `ms`; undefined for a name Intl doesn't know. */
function zoneOffset(zone: string, ms: number): number | undefined {
    try {
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(ms).map((p) => [p.type, p.value]));
        const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
        return Math.round((wall - Math.floor(ms / 60_000) * 60_000) / 60_000);
    } catch {
        return undefined;
    }
}

/** A wall time in `zone` as ms. */
function zoned(y: number, mo: number, d: number, h: number, mi: number, zone: string): number | undefined {
    const guess = Date.UTC(y, mo, d, h, mi);
    const off = zoneOffset(zone, guess);
    if (off === undefined) return undefined;
    // Once more at the corrected time, for a day the clocks change.
    const again = zoneOffset(zone, guess - off * 60_000);
    return guess - (again ?? off) * 60_000;
}

/**
 * "Nov 24, 8pm (UTC)", "1:59pm (Europe/London)": a reset at most `within` ms from `now` (the window's length; a
 * minute's slack either side), else undefined. A date without a year is the nearest such day; a time alone is the
 * next such time.
 */
export function usageResetTime(text: string, now: number, within = 7 * 86_400_000): number | undefined {
    const m = /^(?:([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? )?(\d{1,2})(?::(\d{2}))? ?([ap])\.?m\.?\s*\(([^()]{1,64})\)$/i.exec(text.trim());
    if (!m) return undefined;
    const [, mon, day, hour, min, ap, zone] = m;
    let h = Number(hour) % 12;
    if (ap!.toLowerCase() === "p") h += 12;
    const mi = Number(min ?? 0);
    if (Number(hour) > 12 || Number(hour) < 1 || mi > 59) return undefined;
    const at = (y: number, mo: number, d: number) => zoned(y, mo, d, h, mi, zone!.trim());
    const ahead = (t: number | undefined) => t !== undefined && t > now - 60_000 && t <= now + within + 60_000;
    let t: number | undefined;
    if (mon) {
        const mo = MONTHS.indexOf(mon.toLowerCase());
        const d = Number(day);
        if (mo < 0 || d < 1 || d > 31) return undefined;
        const y = new Date(now).getUTCFullYear();
        t = [y - 1, y, y + 1].map((yy) => at(yy, mo, d)).filter((x): x is number => x !== undefined).sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0];
    } else {
        // A time alone: the first such time from now (today's, or tomorrow's once today's has passed).
        for (const add of [-1, 0, 1, 2]) {
            const d = new Date(now + add * 86_400_000);
            const x = at(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
            if (x !== undefined && x > now - 60_000) {
                t = x;
                break;
            }
        }
    }
    return ahead(t) ? t : undefined;
}

/** How long each window /usage names lasts: its reset is within that from now. */
const USAGE_SPAN: Record<string, number> = { five_hour: 5 * 3_600_000 };

/**
 * `/usage`'s text as a report. A line is read only with a reset it can place within its window's length: one
 * without would stand with no end (and a time alone further off is another window's, or misread).
 */
export function parseClaudeUsage(text: unknown, at = Date.now(), accountId = "default"): PlanLimits | undefined {
    if (typeof text !== "string" || text.length > 20_000) return undefined;
    const windows: LimitWindow[] = [];
    for (const raw of text.split("\n").slice(0, 40)) {
        const line = /^\s*([^:]{1,60}):\s*(\d{1,3}(?:\.\d+)?)%\s*used\b(?:\s*[·•-]\s*resets\s+(.+?))?\s*$/i.exec(raw.replace(/\x1b\[[0-9;]*m/g, ""));
        if (!line) continue;
        const id = USAGE_WINDOWS.find(([re]) => re.test(line[1]!.trim()))?.[1];
        if (!id || windows.some((w) => w.id === id)) continue;
        const used = Number(line[2]);
        if (!Number.isFinite(used) || used > 100) continue;
        const resetsAt = line[3] ? usageResetTime(line[3], at, USAGE_SPAN[id] ?? 7 * 86_400_000) : undefined;
        if (resetsAt === undefined) continue;
        // The text doesn't say whether a window is at its limit (reached unsaid): a full one is taken to be.
        windows.push({ id, label: claudeLabel(id), usedPercent: percent(used, 1), resetsAt });
    }
    if (!windows.length) return undefined;
    // Nor whether the plan is: that follows from its windows (planNow), and from what was said before (mergeLimits).
    return { provider: "claude-code", accountId, windows, at };
}

/** Codex's reached types that credits don't get past: a workspace's cap, not the plan's limit. */
const CODEX_WORKSPACE_STOPS = new Set(["workspace_owner_credits_depleted", "workspace_member_credits_depleted", "workspace_owner_usage_limit_reached", "workspace_member_usage_limit_reached"]);

/**
 * Whether a RateLimitSnapshot's credits carry turns past its limit, as Codex's
 * TUI decides (has_usable_workspace_credits): `credits.hasCredits` or
 * `credits.unlimited`, unless spend control or a workspace's cap stopped it.
 * Only those booleans are read, never `credits.balance`. `full` (a read): no
 * credits means none; an update's null only means it didn't say.
 */
function codexCredits(s: Record<string, any>, full: boolean): boolean | undefined {
    if (s.spendControlReached === true || CODEX_WORKSPACE_STOPS.has(s.rateLimitReachedType)) return false;
    const c = s.credits;
    if (c && typeof c === "object") return c.hasCredits === true || c.unlimited === true;
    return full ? false : undefined;
}

/** Codex's own limit's snapshot: `limitId` codex (or none), as its TUI takes it. */
function isCodexLimit(s: Record<string, any>): boolean {
    return typeof s.limitId !== "string" || !s.limitId || s.limitId.toLowerCase() === "codex";
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
function codexWindows(s: Record<string, any>, read: boolean): LimitWindow[] {
    const limitId = typeof s.limitId === "string" && s.limitId ? label(s.limitId, 60) : "codex";
    // Codex's own limit needs no name; another metered one (a model's) is named, as Codex names it.
    const name = limitId === "codex" ? "" : `${label(typeof s.limitName === "string" && s.limitName ? s.limitName : limitId, 30)} `;
    // Codex's own limit's credits are the plan's (PlanLimits.credits); another limit's go with its windows.
    const credits = isCodexLimit(s) ? undefined : codexCredits(s, read);
    const out: LimitWindow[] = [];
    for (const slot of ["primary", "secondary"] as const) {
        const w = s[slot];
        if (!w || typeof w !== "object") continue;
        const usedPercent = percent(w.usedPercent, 1);
        out.push({ id: `${limitId}:${slot}`, label: `${name}${codexWindowLabel(w.windowDurationMins, slot)}`, usedPercent, resetsAt: seconds(w.resetsAt), reached: full(w.usedPercent, 1) ? true : undefined, ...(credits === undefined ? {} : { credits }) });
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
export function parseCodexRateLimits(r: unknown, opts: { update?: boolean; at?: number; accountId?: string } = {}): { limits: PlanLimits; partial: boolean } | undefined {
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
    const windows = snapshots.flatMap((s) => codexWindows(s, !opts.update));
    const flagged = snapshots.some((s) => codexReachedType(s)) || o.ordinaryUsageAllowed === false;
    // A full read says it isn't reached; an update's null only means it didn't say.
    const reached = flagged || windows.some((w) => w.reached) ? true : opts.update ? undefined : false;
    const own = snapshots.find(isCodexLimit);
    const credits = own ? codexCredits(own, !opts.update) : undefined;
    return { limits: { provider: "codex", accountId: opts.accountId ?? "default", windows, reached, resetsAt: reached ? limitResetsAt(windows) : undefined, ...(credits === undefined ? {} : { credits }), at: opts.at ?? Date.now() }, partial: Boolean(opts.update) };
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

/** Two reports' resets this close are the same window period's. */
const SAME_PERIOD_MS = 10 * 60_000;

/**
 * How a report is merged: `full`, a whole check of the account (Codex's read), replaces what was known;
 * `statusUnsaid`, a report that can't say whether a window is at its limit (Claude Code's /usage text).
 */
export interface MergeHow {
    full?: boolean;
    statusUnsaid?: boolean;
}

/**
 * What's known now, given an earlier report and a new one. `partial`: the new
 * one may leave anything out (a status alone, Codex's updates), so what it
 * doesn't say stands. Otherwise it lists the windows it's about, and a window
 * it leaves out stands until its own reset (Claude Code lists only the
 * windows of the turn's model); `full`: it's a whole check of the account
 * (Codex's read), so it replaces what was known; `statusUnsaid`: it can't say
 * whether a window is at its limit (/usage), so it keeps what was said of
 * the same period. A reported window keeps an
 * omitted reset while that reset is still ahead; a limit reached earlier
 * stands while a full window (or, with none to show for it, its reset time)
 * says so.
 */
export function mergeLimits(prev: PlanLimits | undefined, next: PlanLimits, partial: boolean, how: boolean | MergeHow = false): PlanLimits {
    const { full = false, statusUnsaid = false } = typeof how === "boolean" ? { full: how } : how;
    if (!prev || full || prev.provider !== next.provider || (prev.accountId ?? "default") !== (next.accountId ?? "default")) return next;
    const live = (t: number | undefined) => t === undefined || t > next.at;
    const windows = prev.windows.flatMap((w) => {
        const n = next.windows.find((n) => n.id === w.id);
        // Left out of a report that lists its windows: until it resets (one with no reset known goes now). It keeps
        // when it was reported, so it's not taken for news.
        if (!n) return partial || (w.resetsAt !== undefined && w.resetsAt > next.at) ? [{ ...w, at: w.at ?? prev.at }] : [];
        let merged = n;
        if (n.resetsAt === undefined && w.resetsAt !== undefined && w.resetsAt > next.at) merged = { ...merged, resetsAt: w.resetsAt };
        // A report that can't say whether a window is at its limit (/usage's text) leaves what an earlier one said of
        // the same period (the same reset, give or take /usage's rounding to the minute), and that one's exact reset,
        // while it's still ahead.
        if (statusUnsaid && w.resetsAt !== undefined && w.resetsAt > next.at && (merged.resetsAt === undefined || Math.abs(merged.resetsAt - w.resetsAt) <= SAME_PERIOD_MS)) {
            merged = { ...merged, resetsAt: w.resetsAt, ...(n.reached === undefined && w.reached !== undefined ? { reached: w.reached } : {}) };
        }
        // An update that doesn't say whether a limit has credits leaves what was said.
        if (n.credits === undefined && w.credits !== undefined) merged = { ...merged, credits: w.credits };
        return [merged];
    });
    for (const n of next.windows) if (!windows.some((w) => w.id === n.id)) windows.push(n);
    const exhausted = windows.filter((w) => w.reached && live(w.resetsAt));
    let reached = exhausted.length ? true : next.reached;
    if (reached === undefined) {
        // Reached for a full window that has since reset, or been reported with room: no longer.
        if (prev.reached && prev.windows.some((w) => w.reached)) reached = false;
        // Reached with no window to show for it (credits, say): until its reset, when known.
        else reached = prev.reached && live(prev.resetsAt) ? true : prev.reached === undefined ? undefined : false;
    }
    // It lifts when the last of what's blocking it does: the full windows, and the new report's own reset. A report
    // that may leave the stop out (sparse, or /usage's text) keeps an earlier stop's own reset while it's ahead.
    const blockers = [...exhausted.map((w) => w.resetsAt), next.reached ? next.resetsAt : undefined].filter((t): t is number => t !== undefined);
    const resetsAt = reached && !exhausted.some((w) => w.resetsAt === undefined) ? (blockers.length ? Math.max(...blockers) : (partial || statusUnsaid) && live(prev.resetsAt) ? prev.resetsAt : undefined) : undefined;
    // Codex's updates leave credits out (null): what the last read said stands until one says otherwise.
    const credits = next.credits ?? prev.credits;
    return { provider: next.provider, accountId: next.accountId, windows, reached, resetsAt, ...(credits === undefined ? {} : { credits }), at: next.at };
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
/**
 * What a CLI's own warning about a limit window is said as. It warns well before the end (seen at 53% of a week),
 * so the share used is said where it's known, and "close to" only at four fifths or with no figure.
 */
export function nearLimitWords(usedPercent: number | undefined, which: string): string {
    return usedPercent !== undefined && Number.isFinite(usedPercent) && usedPercent < 80 ? `${Math.round(usedPercent)}% of the ${which}usage limit used.` : `close to the ${which}usage limit.`;
}

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

/**
 * One line per window, for the terminal's /cost: "5-hour 62% · resets at 4:40 PM (in 2h 5m)", or, for one that
 * has reset since the report, "5-hour · reset at 9:52 AM" (planNow: the GUI's meter says the same).
 */
export function limitLines(l: PlanLimits, now = Date.now()): string[] {
    const p = planNow(l, now);
    if (!p) return [];
    const lines = p.windows.map((w) => (w.reset ? `${w.label} · reset ${new Date(w.resetsAt!).toDateString() === new Date(now).toDateString() ? "at" : "on"} ${clockTime(w.resetsAt!, now)}` : [w.label, w.pct !== undefined ? `${w.pct}%` : undefined, w.reached ? "reached" : undefined].filter(Boolean).join(" ") + (w.resetsAt ? ` · resets ${resetPhrase(w.resetsAt, now)}` : "")));
    const shown = p.windows.some((w) => w.reached);
    // A reached window says when it resets; on credits, that turns go on is said first.
    if (p.reached && (!shown || p.usingCredits)) lines.unshift(`Limit reached${p.usingCredits ? " · using credits" : ""}${!shown && p.liftsAt ? ` · resets ${resetPhrase(p.liftsAt, now)}` : ""}`);
    return lines;
}

/** For a limit-reached notice: that turns go on past it, billed to credits (Claude Code's extra usage); "" when they don't. */
export function creditsNote(l: PlanLimits | undefined, billedTo = "credits"): string {
    return l && usingCredits(l, Boolean(l.reached)) ? ` · using credits. Turns go on, billed to ${billedTo}` : "";
}

/**
 * What a turn that stopped on the plan's limit reports: reached, and whatever
 * credits there were didn't carry it. Always sent: the host may hold credits
 * from another backend's reports that this one never saw.
 */
export function limitStopReport(provider: string, accountId: string): PlanLimits {
    return { provider, accountId, windows: [], reached: true, credits: false, at: Date.now() };
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

/** A local display name is safe in notices; signed-in email and plan stay out. */
export function limitAccountLabel(provider: string, accountId = "default"): string {
    return `${agentCli(provider)?.name ?? provider} · ${accountName(provider, accountId)}`;
}

function accountName(provider: string, accountId: string): string {
    return cliAccounts(provider).find((a) => a.id === accountId)?.name ?? accountId;
}

/** The window of a reached limit ("5-hour"), when the report names one. */
export function reachedWindow(l: PlanLimits | undefined): string | undefined {
    return l?.windows.find((w) => w.reached)?.label;
}

/** What a turn stopped on the plan's limit says of it (BackendResult.limit): when it lifts, and which window it is. */
export function limitStopOf(l: PlanLimits | undefined, resetsAt: number | undefined): { resetsAt?: number; window?: string } {
    const window = reachedWindow(l);
    return { ...(resetsAt !== undefined ? { resetsAt } : {}), ...(window ? { window } : {}) };
}

/** A reached limit as a notice draws it (#426): whose, which window, until when, and whether turns go on, on credits. */
export function limitNotice(provider: string, accountId = "default", l: PlanLimits | undefined, o: { resetsAt?: number; window?: string; credits?: boolean } = {}): NoticeLimit {
    const window = o.window ?? reachedWindow(l);
    const resetsAt = o.resetsAt ?? l?.resetsAt;
    return { provider, accountId, name: accountName(provider, accountId), ...(window ? { window } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}), ...(o.credits ? { credits: true as const } : {}) };
}
