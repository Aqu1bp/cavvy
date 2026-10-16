// Tokens and cost per provider and model over the last day, week or month,
// from the usage records in session transcripts ({"t":"usage"} lines).
//
// Dating: records written since this view exists carry `at` (ms). Older ones
// have no time of their own, so each takes the time of the next dated record
// in its file, or else the file's last write (mtime): an upper bound, so an
// old session never looks older than it is. They're counted as approximate.
//
// Cost: a record marked `unknown` (no price was known), or saved as $0 for a
// model with no known price (before records were marked), is unknown, never
// $0. Usage covered by a plan (Claude Code, Codex) is priced as the API would
// have charged for the same model: an estimate, labelled as one.
//
// A scan is bounded (files, bytes, time) and reads only the usage lines; each
// file's records are cached by mtime and size, so a repeat costs a stat each.

import { open, readdir, stat } from "fs/promises";
import { join } from "path";
import { paths } from "../config/paths";
import { costOf } from "../providers/pricing";
import { resolveModelInfo } from "../providers/models";
import { anthropicPricing } from "../providers/anthropic-models";
import { getProvider } from "../providers/registry";
import type { ModelInfo, Usage } from "../providers/types";
import { USAGE_DAYS, type UsageDays, type UsageRow, type UsageSummary } from "./protocol";
import { RpcError } from "./rpc-error";

/** How much one scan reads at most (changeable for tests). */
export const usageBounds = { maxFiles: 5000, maxBytes: 512 * 1024 * 1024, maxMs: 4000 };

const DAY = 86_400_000;
const CHUNK = 256 * 1024;
/** A usage line is small; one this long is something else. */
const MAX_LINE = 64 * 1024;
const PREFIX = Buffer.from('{"t":"usage"');

interface UsageRecord {
    at: number;
    approx: boolean;
    model: string;
    usage: Usage;
    cost: number;
    unknown: boolean;
}

interface Cached {
    mtimeMs: number;
    size: number;
    records: UsageRecord[];
}

const cache = new Map<string, Cached>();

/** The range a client asked for, if it's one the view offers. */
export function usageDays(v: unknown): UsageDays {
    if (!USAGE_DAYS.includes(v as UsageDays)) throw new RpcError(`days must be one of ${USAGE_DAYS.join(", ")}`, "bad_request");
    return v as UsageDays;
}

interface Budget {
    start: number;
    bytes: number;
}

function spent(b: Budget): string | undefined {
    if (b.bytes > usageBounds.maxBytes) return "There was too much to read; earlier sessions are left out.";
    if (Date.now() - b.start > usageBounds.maxMs) return "Reading the sessions took too long; earlier ones are left out.";
    return undefined;
}

/** Session files written to since `since`, most recent first. */
async function sessionFiles(since: number, budget: Budget): Promise<{ file: string; mtimeMs: number; size: number }[]> {
    const root = paths.projectsDir();
    const out: { file: string; mtimeMs: number; size: number }[] = [];
    let dirs: string[];
    try {
        dirs = await readdir(root);
    } catch {
        return out;
    }
    for (const d of dirs) {
        if (spent(budget)) break;
        let names: string[];
        try {
            names = await readdir(join(root, d));
        } catch {
            continue;
        }
        for (const f of names) {
            if (!f.endsWith(".jsonl")) continue;
            if (spent(budget)) break;
            const file = join(root, d, f);
            try {
                const st = await stat(file);
                // Nothing in a file is newer than its last write.
                if (st.isFile() && st.mtimeMs >= since) out.push({ file, mtimeMs: st.mtimeMs, size: st.size });
            } catch {
                // vanished or unreadable
            }
        }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function toRecord(l: any): Omit<UsageRecord, "at" | "approx"> | undefined {
    if (!l || l.t !== "usage" || typeof l.model !== "string" || !l.usage || typeof l.usage !== "object") return undefined;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
    const u = l.usage;
    const usage: Usage = { inputTokens: n(u.inputTokens), outputTokens: n(u.outputTokens), cacheReadTokens: n(u.cacheReadTokens), cacheWriteTokens: n(u.cacheWriteTokens) };
    if (typeof u.cost === "number" && Number.isFinite(u.cost)) usage.cost = u.cost;
    if (u.costEstimated === true) usage.costEstimated = true;
    if (u.fastMode === true) usage.fastMode = true;
    return { model: l.model.slice(0, 300), usage, cost: n(l.cost), unknown: l.unknown === true };
}

/** One file's usage records; undefined when the budget ran out part way. */
async function readRecords(file: string, mtimeMs: number, budget: Budget): Promise<UsageRecord[] | undefined> {
    const records: UsageRecord[] = [];
    /** Undated records waiting for the next dated one. */
    let undated: UsageRecord[] = [];
    const fh = await open(file, "r");
    try {
        const buf = Buffer.alloc(CHUNK);
        let pos = 0;
        // The line being read: kept only while it may be a usage line.
        let parts: Buffer[] = [];
        let len = 0;
        let keep: boolean | undefined;
        const endLine = () => {
            if (keep && len <= MAX_LINE) {
                let rec: Omit<UsageRecord, "at" | "approx"> | undefined;
                let at: unknown;
                try {
                    const l = JSON.parse(Buffer.concat(parts, len).toString("utf8"));
                    rec = toRecord(l);
                    at = l?.at;
                } catch {
                    // torn or not JSON
                }
                if (rec) {
                    if (typeof at === "number" && Number.isFinite(at) && at > 0) {
                        for (const u of undated) u.at = at;
                        undated = [];
                        records.push({ ...rec, at, approx: false });
                    } else {
                        const r = { ...rec, at: mtimeMs, approx: true };
                        undated.push(r);
                        records.push(r);
                    }
                }
            }
            parts = [];
            len = 0;
            keep = undefined;
        };
        const take = (b: Buffer) => {
            if (keep === false || !b.length) return;
            len += b.length;
            if (len > MAX_LINE) {
                keep = false;
                parts = [];
                return;
            }
            parts.push(Buffer.from(b));
            if (keep === undefined && len >= PREFIX.length) keep = Buffer.concat(parts, len).subarray(0, PREFIX.length).equals(PREFIX);
            if (keep === false) parts = [];
        };
        while (true) {
            if (spent(budget)) return undefined;
            const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
            if (!bytesRead) break;
            pos += bytesRead;
            budget.bytes += bytesRead;
            const chunk = buf.subarray(0, bytesRead);
            let start = 0;
            for (let nl = chunk.indexOf(10, start); nl !== -1; nl = chunk.indexOf(10, start)) {
                take(chunk.subarray(start, nl));
                endLine();
                start = nl + 1;
            }
            take(chunk.subarray(start));
        }
        // A last line without its newline is still being written: left for next time.
    } finally {
        await fh.close();
    }
    return records;
}

/** Prices, and what kind of provider each is, looked up once per summary. */
class Prices {
    private models = new Map<string, ModelInfo | undefined>();
    private kinds = new Map<string, { name: string; agent: boolean }>();

    provider(id: string): { name: string; agent: boolean } {
        let k = this.kinds.get(id);
        if (!k) {
            const def = getProvider(id);
            this.kinds.set(id, (k = { name: def?.name ?? id, agent: def?.kind === "agent" }));
        }
        return k;
    }

    model(ref: string): ModelInfo | undefined {
        if (!this.models.has(ref)) this.models.set(ref, resolveModelInfo(ref));
        return this.models.get(ref);
    }

    /** What the API would charge for an agent CLI's model: Claude Code's are Anthropic's, Codex's OpenAI's. */
    apiEquivalent(provider: string, id: string, usage: Usage): number | undefined {
        const plain: Usage = { ...usage, cost: undefined, costEstimated: undefined, fastMode: undefined };
        if (provider === "claude-code") {
            // An alias (default, opus) is named for the model it resolved to in the CLI's listing ("Opus (claude-opus-5-5)").
            const named = /^claude-/.test(id) ? id : this.model(`claude-code:${id}`)?.name?.match(/claude-[a-z0-9-]+/)?.[0];
            const claudeId = named?.replace(/\[.*$/, "");
            const pricing = claudeId ? anthropicPricing(claudeId) : undefined;
            return pricing ? costOf(plain, { provider: "anthropic", id: claudeId!, pricing }).usd : undefined;
        }
        if (provider === "codex") {
            const info = this.model(`openai:${id}`);
            return info?.pricing ? costOf(plain, info).usd : undefined;
        }
        return undefined;
    }

    /** A record's cost: `plan` is the API-equivalent part, undefined when no price is known. */
    of(r: UsageRecord, provider: string, id: string): { cost: number; plan: number } | undefined {
        if (r.unknown) return undefined;
        const reported = r.usage.cost;
        if (this.provider(provider).agent) {
            // An agent CLI on an API key reports what it was billed (Claude Code); on a plan, 0. A
            // sub-agent's usage folded into its parent's file keeps only the record's own cost.
            if (typeof reported === "number" && reported > 0) return { cost: reported, plan: 0 };
            if (reported === undefined && r.cost > 0) return { cost: r.cost, plan: 0 };
            // On a plan, or (Codex on an API key, a folded sub-agent's) not priced when it was spent:
            // what the API would charge, labelled as that estimate.
            const eq = this.apiEquivalent(provider, id, r.usage);
            if (eq === undefined) return undefined;
            return { cost: eq, plan: eq };
        }
        if (typeof reported === "number") return { cost: reported, plan: 0 };
        if (r.cost > 0) return { cost: r.cost, plan: 0 };
        // Saved as $0: free, or (before unpriced usage was marked) no price was known.
        const info = this.model(r.model);
        if (!info?.pricing) return r.usage.inputTokens + r.usage.outputTokens + (r.usage.cacheReadTokens ?? 0) + (r.usage.cacheWriteTokens ?? 0) ? undefined : { cost: 0, plan: 0 };
        return { cost: costOf(r.usage, info).usd, plan: 0 };
    }
}

export async function usageSummary(days: UsageDays, now = Date.now()): Promise<UsageSummary> {
    const since = now - days * DAY;
    const budget: Budget = { start: Date.now(), bytes: 0 };
    const files = await sessionFiles(since, budget);
    // Listing a folder of many sessions can take the time: what was listed is still read (in a budget of its own).
    const listed = spent(budget);
    if (listed) Object.assign(budget, { start: Date.now(), bytes: 0 });
    const prices = new Prices();
    const rows = new Map<string, UsageRow & { files: Set<string> }>();
    const sessions = new Set<string>();
    let approxDated = 0;
    let truncated = listed;
    for (const [i, f] of files.entries()) {
        const out = spent(budget);
        if (out) {
            truncated ??= out;
            break;
        }
        if (i >= usageBounds.maxFiles) {
            truncated ??= `Only the ${usageBounds.maxFiles} most recently active sessions were read.`;
            break;
        }
        let entry = cache.get(f.file);
        if (!entry || entry.mtimeMs !== f.mtimeMs || entry.size !== f.size) {
            let records: UsageRecord[] | undefined;
            try {
                records = await readRecords(f.file, f.mtimeMs, budget);
            } catch {
                continue; // vanished or unreadable
            }
            if (!records) {
                truncated ??= spent(budget);
                break;
            }
            cache.set(f.file, (entry = { mtimeMs: f.mtimeMs, size: f.size, records }));
        }
        for (const [n, r] of entry.records.entries()) {
            // A huge file's records take time to add up too.
            const out = n % 10_000 === 9_999 ? spent(budget) : undefined;
            if (out) {
                truncated ??= out;
                break;
            }
            if (r.at < since || r.at > now) continue;
            const colon = r.model.indexOf(":");
            const provider = colon > 0 ? r.model.slice(0, colon) : "unknown";
            const id = colon > 0 ? r.model.slice(colon + 1) : r.model;
            const kind = prices.provider(provider);
            let row = rows.get(r.model);
            if (!row) rows.set(r.model, (row = { provider, providerName: kind.name, model: id, plan: false, sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, planEquivalent: 0, unknown: false, files: new Set() }));
            row.inputTokens += r.usage.inputTokens;
            row.outputTokens += r.usage.outputTokens;
            row.cacheReadTokens += r.usage.cacheReadTokens ?? 0;
            row.cacheWriteTokens += r.usage.cacheWriteTokens ?? 0;
            const c = prices.of(r, provider, id);
            if (!c) row.unknown = true;
            else {
                row.cost += c.cost;
                row.planEquivalent += c.plan;
                if (c.plan) row.plan = true;
            }
            if (kind.agent && r.usage.cost === 0) row.plan = true;
            row.files.add(f.file);
            sessions.add(f.file);
            if (r.approx) approxDated++;
        }
    }
    // Keep the cache to about what one scan reads.
    if (cache.size > usageBounds.maxFiles) {
        const listed = new Set(files.map((f) => f.file));
        for (const k of cache.keys()) if (!listed.has(k)) cache.delete(k);
    }
    const out = [...rows.values()]
        .map(({ files, ...row }) => ({ ...row, sessions: files.size }))
        .sort((a, b) => b.cost - a.cost || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, planEquivalent: 0, unknown: false };
    for (const r of out) {
        totals.inputTokens += r.inputTokens;
        totals.outputTokens += r.outputTokens;
        totals.cacheReadTokens += r.cacheReadTokens;
        totals.cacheWriteTokens += r.cacheWriteTokens;
        totals.cost += r.cost;
        totals.planEquivalent += r.planEquivalent;
        totals.unknown ||= r.unknown;
    }
    return { days, since, rows: out, totals, sessions: sessions.size, approxDated, ...(truncated ? { truncated } : {}) };
}

/** Forget cached records (tests). */
export function clearUsageCache() {
    cache.clear();
}
