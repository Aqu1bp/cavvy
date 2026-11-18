// Usage across the user's machines. A subscription is used wherever its CLI runs, and each machine's Cavvy knows only
// the transcripts on its own disk (usage.ts): the user's own computer asks each server it's connected to for that
// server's summary and adds them up. What a server answers is another machine's word: only its numbers and short
// names are taken from it, and it's said which servers weren't counted.

import { USAGE_DAYS, type UsageAccountRow, type UsageBucket, type UsageDays, type UsageRow, type UsageSource, type UsageSourceRow, type UsageSummary, type UsageTotals } from "./protocol";

/** A connection to a server's Cavvy, asked as this computer (watch.ts ask). */
export interface UsageAsk {
    ask(method: "usage.summary", params: Record<string, unknown>, ms?: number): Promise<unknown>;
}

/** How long a server has to answer: its own reading is bounded (usage-reader.ts), and the panel waits on this. */
const ASK_MS = 60_000;
const SOURCES: UsageSource[] = ["claude-code", "codex", "api"];
const MOST = { rows: 500, accounts: 2000, series: 2500 };

/** No more than any real figure (tokens, dollars, a time in ms): sums of them stay finite. */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, 1e15) : 0);
const text = (v: unknown, max = 120): string => (typeof v === "string" ? v.slice(0, max) : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown, most: number): unknown[] => (Array.isArray(v) ? v.slice(0, most) : []);

function totals(v: unknown): UsageTotals {
    const o = obj(v), c = obj(o.costByType);
    return {
        inputTokens: num(o.inputTokens), outputTokens: num(o.outputTokens), cacheReadTokens: num(o.cacheReadTokens), cacheWriteTokens: num(o.cacheWriteTokens),
        cost: num(o.cost), planEquivalent: num(o.planEquivalent), unknown: o.unknown === true, ...(o.estimated === true ? { estimated: true } : {}),
        costByType: { input: num(c.input), cacheRead: num(c.cacheRead), cacheWrite: num(c.cacheWrite), output: num(c.output), unallocated: num(c.unallocated) }, cacheSavings: num(o.cacheSavings),
    };
}
/** A row as usage.ts makes it: with every total, more than the protocol's type promises. */
type Full<T> = T & UsageTotals;
function row(v: unknown): Full<UsageRow> {
    const o = obj(v);
    return { ...totals(o), provider: text(o.provider), providerName: text(o.providerName), model: text(o.model, 200), plan: o.plan === true, sessions: num(o.sessions) };
}
const source = (v: unknown): UsageSource | undefined => SOURCES.find((s) => s === v);

/** A server's summary, cleaned: who its accounts are and what they're called are always there, if empty. */
export type Said = UsageSummary & { who: Record<string, string>; names: Record<string, string> };

/** What a server said its usage is, with nothing kept but numbers and short names; undefined if it isn't a summary of `days`. */
export function machineSummary(raw: unknown, days: UsageDays): Said | undefined {
    const o = obj(raw);
    if (o.days !== days || !USAGE_DAYS.includes(days) || o.interval !== (days === 1 ? "hour" : "day")) return undefined;
    // An answer that isn't one (an error's object, a part of one) isn't a server with no usage.
    if (typeof obj(o.totals).cost !== "number" || typeof obj(o.totals).inputTokens !== "number" || ![o.rows, o.accounts, o.series, o.sources].every(Array.isArray)) return undefined;
    const accounts: Full<UsageAccountRow>[] = [];
    for (const a of list(o.accounts, MOST.accounts)) {
        const s = source(obj(a).source);
        if (s) accounts.push({ ...row(a), source: s, accountId: text(obj(a).accountId) || "default" });
    }
    const series: UsageBucket[] = list(o.series, MOST.series).map((b) => {
        const by = obj(obj(b).sources);
        return { ...totals(b), at: num(obj(b).at), sessions: num(obj(b).sessions), sources: { "claude-code": totals(by["claude-code"]), codex: totals(by.codex), api: totals(by.api) } };
    });
    const sources: UsageSourceRow[] = [];
    for (const r of list(o.sources, SOURCES.length)) {
        const s = source(obj(r).source);
        if (s) sources.push({ ...totals(r), source: s, label: "", sessions: num(obj(r).sessions) });
    }
    const who: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj(o.who)).slice(0, 100)) if (typeof v === "string" && v.includes("@")) who[text(k, 200)] = text(v, 200).toLowerCase();
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj(o.names)).slice(0, 100)) if (typeof v === "string" && v.trim()) names[text(k, 200)] = text(v.trim(), 60);
    return {
        days, since: num(o.since), interval: days === 1 ? "hour" : "day", totals: totals(o.totals), rows: list(o.rows, MOST.rows).map(row), sources, accounts, buckets: [], series, limits: [],
        sessions: num(o.sessions), approxDated: num(o.approxDated), approxPriced: num(o.approxPriced), ...(typeof o.truncated === "string" ? { truncated: text(o.truncated, 300) } : {}), who, names,
    };
}

function add(a: UsageTotals, b: UsageTotals) {
    for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost", "planEquivalent", "cacheSavings"] as const) a[k] += b[k];
    a.unknown ||= b.unknown;
    if (b.estimated) a.estimated = true;
    for (const k of ["input", "cacheRead", "cacheWrite", "output", "unallocated"] as const) a.costByType[k] += b.costByType[k];
}
/** `b` added to the one of `into` with its key, or put there. Sessions add up: a machine's sessions are its own. */
function addInto<T extends UsageTotals & { sessions: number }>(into: Map<string, T>, key: string, b: T) {
    const a = into.get(key);
    if (!a) return void into.set(key, b);
    add(a, b);
    a.sessions += b.sessions;
}

export const whoKey = (source: string, accountId: string) => `${source}:${accountId}`;

/**
 * `own` (this computer's) with each server's added. An account of a server's is this computer's own when both are
 * known to be the same sign-in (the same email, as each CLI says); otherwise it's a row of its own (`<id>@<server>`,
 * so two of a server's never run together), named with its server in `names`: "default" there is whoever signed in
 * there. The detail by hour or day and account (`buckets`) stays this computer's: nothing shown reads another's.
 */
export function addMachines(own: UsageSummary, others: { name: string; summary: Said }[]): UsageSummary {
    if (!others.length) return own;
    const mine = new Map(Object.entries(own.who ?? {}).map(([k, email]) => [`${k.slice(0, k.indexOf(":"))}:${email.toLowerCase()}`, k.slice(k.indexOf(":") + 1)]));
    const rows = new Map((own.rows as Full<UsageRow>[]).map((r) => [`${r.provider}:${r.model}`, r]));
    const accounts = new Map((own.accounts as Full<UsageAccountRow>[]).map((a) => [JSON.stringify([a.source, a.accountId, a.provider, a.model]), a]));
    const series = new Map(own.series.map((s) => [s.at, s]));
    const names = { ...own.names };
    let truncated = own.truncated;
    for (const { name, summary: s } of others) {
        // API providers' usage has no account: it's that machine's keys, counted under the provider as this computer's is.
        const account = (source: UsageSource, id: string) => {
            if (source === "api") return id;
            const email = s.who[whoKey(source, id)];
            const same = email && mine.get(`${source}:${email}`);
            if (same) return same;
            names[whoKey(source, `${id}@${name}`)] = `${s.names[whoKey(source, id)] ?? (id === "default" ? "Default" : id)} on ${name}`;
            return `${id}@${name}`;
        };
        add(own.totals, s.totals);
        own.sessions += s.sessions;
        own.approxDated += s.approxDated;
        own.approxPriced = (own.approxPriced ?? 0) + (s.approxPriced ?? 0);
        truncated ??= s.truncated && `${name}: ${s.truncated}`;
        for (const r of s.sources) {
            const a = own.sources.find((x) => x.source === r.source);
            if (a) { add(a, r); a.sessions += r.sessions; }
        }
        for (const r of s.rows as Full<UsageRow>[]) addInto(rows, `${r.provider}:${r.model}`, r);
        for (const a of s.accounts as Full<UsageAccountRow>[]) { a.accountId = account(a.source, a.accountId); addInto(accounts, JSON.stringify([a.source, a.accountId, a.provider, a.model]), a); }
        // Only the hours or days this computer's own range has: both count the same range from the same clock time, near enough.
        for (const b of s.series) {
            const a = series.get(b.at);
            if (!a) continue;
            add(a, b);
            a.sessions += b.sessions;
            for (const k of SOURCES) add(a.sources[k], b.sources[k]);
        }
    }
    return { ...own, rows: [...rows.values()].sort((a, b) => b.cost - a.cost), accounts: [...accounts.values()], names, ...(truncated ? { truncated } : {}) };
}

/**
 * This computer's usage (`own`, still being read) with every server's: each connected one is asked for its own at
 * once, so all of them count the same range, near enough. `servers`: every server's name, and the connection to each
 * that's connected. One that isn't, or doesn't answer with a summary in time, is named in `uncounted`.
 */
/** What each server said its usage is (none: not connected, or no summary in time), asked at once. */
export type Asked = { name: string; summary?: Said }[];

/** Each server asked for its own usage: `brief`, without its detail by hour and account, which isn't added (and is most of a long range's answer). */
export function askMachines(days: UsageDays, servers: { names: string[]; connected: Map<string, UsageAsk> }, ms = ASK_MS): Promise<Asked> {
    return Promise.all(
        servers.names.map(async (name) => ({ name, summary: await servers.connected.get(name)?.ask("usage.summary", { days, brief: true }, ms).then((raw) => machineSummary(raw, days), () => undefined) })),
    );
}

/** `own` with what the servers said: those that said nothing usable are named in `uncounted`. */
export function withMachines(own: UsageSummary, asked: Asked): UsageSummary {
    const counted = asked.filter((a): a is { name: string; summary: Said } => Boolean(a.summary));
    const uncounted = asked.filter((a) => !a.summary).map((a) => a.name);
    return { ...addMachines(own, counted), ...(uncounted.length ? { uncounted } : {}) };
}

/** How long this computer's own figures wait for the servers' before they're shown without them (the servers' follow). */
export const USAGE_GRACE_MS = 1500;

export async function usageEverywhere(days: UsageDays, reading: Promise<UsageSummary>, servers: { names: string[]; connected: Map<string, UsageAsk> }, ms = ASK_MS): Promise<UsageSummary> {
    if (!servers.names.length) return reading;
    const [own, asked] = await Promise.all([reading, askMachines(days, servers, ms)]);
    return withMachines(own, asked);
}
