import { open, opendir, realpath, stat } from "fs/promises";
import { createHash } from "crypto";
import { join, resolve } from "path";
import { paths } from "../config/paths";
import { listAccounts } from "../providers/accounts";
import type { Usage } from "../providers/types";
import { UsageJson } from "./usage-json";

export const usageBounds = { maxFiles: 5000, maxBytes: 512 * 1024 * 1024, maxMs: 4000 };
export type Source = "claude-code" | "codex" | "api";
export interface UsageRecord {
    at: number; approx: boolean; model: string; usage: Usage; cost: number; unknown: boolean;
    session: string; dedupe?: string; serviceTier?: string;
}
interface File { file: string; source: Source; account: string; size: number; mtimeMs: number; ino: number; dev: number }
interface State { model: string; session: string; total?: number[]; signature?: string; undated: number[]; sawMeta?: boolean; forkAnchor?: number; serviceTier?: string; unmodeled?: UsageRecord[] }
interface Cached { file: File; offset: number; guard: { digest: string; length: number }; state: State; records: UsageRecord[] }
const cache = new Map<string, Cached>();
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
const str = (v: unknown) => typeof v === "string" ? v.slice(0, 300) : "";
function timestamp(v: unknown): number { return typeof v === "number" ? n(v) : typeof v === "string" ? n(Date.parse(v)) : 0; }
function parse(l: any, f: File, s: State): UsageRecord | undefined {
    if (!l || typeof l !== "object") return;
    let at = timestamp(l.at ?? l.timestamp), model = "", usage: Usage, dedupe: string | undefined;
    let cost = 0, unknown = false;
    if (f.source === "api") {
        if (l.t !== "usage" || !l.usage || typeof l.model !== "string") return;
        // CLI transcripts are authoritative, including for Harness-run sessions.
        if (/^(claude-code|codex):/.test(l.model)) return;
        model = str(l.model);
        const u = l.usage;
        usage = { inputTokens: n(u.inputTokens), outputTokens: n(u.outputTokens), cacheReadTokens: n(u.cacheReadTokens), cacheWriteTokens: n(u.cacheWriteTokens), cacheWrite1hTokens: n(u.cacheWrite1hTokens) };
        if (typeof u.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0) usage.cost = u.cost;
        if (u.fastMode === true) usage.fastMode = true;
        if (typeof u.resolvedModel === "string" && u.resolvedModel.startsWith(model.split(":")[0] + ":")) model = str(u.resolvedModel);
        cost = n(l.cost); unknown = l.unknown === true;
    } else if (f.source === "claude-code") {
        if (l.type !== "assistant" || !l.message?.usage || !str(l.message.model)) return;
        const u = l.message.usage;
        model = `claude-code:${str(l.message.model)}`;
        s.session = str(l.sessionId) || s.session;
        if (str(l.message.id) || str(l.requestId)) dedupe = JSON.stringify([str(l.message.id), str(l.requestId)]);
        const writes = n(u.cache_creation_input_tokens) || n(u.cache_creation?.ephemeral_5m_input_tokens) + n(u.cache_creation?.ephemeral_1h_input_tokens);
        usage = { inputTokens: n(u.input_tokens), outputTokens: n(u.output_tokens), cacheReadTokens: n(u.cache_read_input_tokens), cacheWriteTokens: writes, cacheWrite1hTokens: Math.min(writes, n(u.cache_creation?.ephemeral_1h_input_tokens)), fastMode: u.speed === "fast", billing: "plan" };
    } else {
        const p = l.payload ?? l;
        if (l.type === "session_meta") {
            // A fork may copy ancestor metadata after its own first header.
            if (!s.sawMeta) {
                s.sawMeta = true; s.session = str(p.id ?? p.session_id);
                if (at && (str(p.forked_from_id) || str(p.source?.subagent?.thread_spawn?.parent_thread_id))) s.forkAnchor = at;
            }
            return;
        }
        if (l.type === "turn_context" || p.type === "token_count") {
            s.model = str(p.model) || s.model;
            if (s.model && s.unmodeled) {
                for (const r of s.unmodeled) r.model = `codex:${s.model}`;
                s.unmodeled = undefined;
            }
        }
        if (l.type === "turn_context") return;
        if (p.type === "thread_settings_applied") { s.serviceTier = str(p.thread_settings?.service_tier); return; }
        if (p.type !== "token_count" || !p.info) return;
        const info = p.info;
        const counts = (v: any) => [n(v.input_tokens), n(v.cached_input_tokens ?? v.cache_read_input_tokens), n(v.cache_write_input_tokens), n(v.output_tokens)];
        let delta: number[];
        if (info.total_token_usage && typeof info.total_token_usage === "object") {
            const total = counts(info.total_token_usage);
            const reset = s.total && total.some((v, i) => v < s.total![i]!);
            delta = reset ? (info.last_token_usage ? counts(info.last_token_usage) : total) : total.map((v, i) => v - (s.total?.[i] ?? 0));
            s.total = total;
            dedupe = JSON.stringify([at, total]);
        } else if (info.last_token_usage && typeof info.last_token_usage === "object") {
            delta = counts(info.last_token_usage);
            // Without a cumulative counter, only an identical event at the same
            // timestamp is provably a repeat. Equal-sized distinct turns count.
            dedupe = JSON.stringify([at, delta]);
            if (s.signature === dedupe) return;
            // Keep a baseline when older last-only events are interleaved with
            // cumulative events, otherwise the next total bills them again.
            s.total = delta.map((v, i) => v + (s.total?.[i] ?? 0));
        } else return;
        s.signature = dedupe;
        // Fork/subagent history is copied in an initial burst, re-stamped to
        // the fork instant. Advance cumulative state, but do not bill it again.
        // A separated event starts the child's own work (same 1s gap as ccusage).
        if (s.forkAnchor !== undefined) {
            if (at - s.forkAnchor < 1000) { s.forkAnchor = Math.max(at, s.forkAnchor); return; }
            s.forkAnchor = undefined;
        }
        if (!delta.some(v => v > 0)) return;
        const [input = 0, read = 0, write = 0, output = 0] = delta;
        usage = { inputTokens: Math.max(0, input - read - write), cacheReadTokens: read, cacheWriteTokens: write, outputTokens: output, fastMode: ["fast", "priority"].includes(s.serviceTier ?? ""), billing: "plan" };
        model = `codex:${s.model || "unknown"}`;
        unknown = s.serviceTier === "ultrafast";
    }
    const record = { at: at || f.mtimeMs, approx: !at, model, usage, cost, unknown, session: s.session || f.file, dedupe,
        ...(f.source === "codex" ? { serviceTier: s.serviceTier } : {}) };
    // Keep unknown usage visible, and resolve it even if context arrives on a later append.
    if (f.source === "codex" && !s.model) (s.unmodeled ??= []).push(record);
    return record;
}

type Root = { root: string; source: Source; account: string };
type DiscoveryItem = File | string | undefined;
let discovery: { key: string; since: number; walker: AsyncGenerator<DiscoveryItem>; files: Map<string, File>; missing: Set<string>; done: boolean } | undefined;
async function* discover(roots: Root[]): AsyncGenerator<DiscoveryItem> {
    const seenRoots = new Set<string>();
    const seenFiles = new Set<string>();
    async function* walk(dir: string, source: Source, account: string, depth = 0): AsyncGenerator<DiscoveryItem> {
        if (depth > 32) { yield "Some transcript folders exceeded the scan depth limit."; return; }
        try {
            const entries = await opendir(dir);
            for await (const e of entries) {
                const file = join(dir, e.name);
                if (e.isDirectory()) { yield undefined; yield* walk(file, source, account, depth + 1); }
                else if (e.isFile() && e.name.endsWith(".jsonl") && (source !== "codex" || e.name.startsWith("rollout-"))) {
                    if (seenFiles.has(file)) { yield undefined; continue; }
                    seenFiles.add(file);
                    const st = await stat(file);
                    yield { file, source, account, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev };
                } else yield undefined;
            }
        } catch (e: any) { if (e.code !== "ENOENT") yield "Some transcript files or folders could not be read."; }
    }
    const walkers: AsyncGenerator<DiscoveryItem>[] = [];
    try {
        for (const r of roots) {
            try {
                const root = await realpath(resolve(r.root));
                if (!seenRoots.has(root)) { seenRoots.add(root); walkers.push(walk(root, r.source, r.account)); }
            } catch (e: any) { if (e.code !== "ENOENT") yield "Some transcript folders could not be read."; }
            yield undefined;
        }
        // Interleave roots, including skipped entries, so each CLI gets a turn.
        while (walkers.length) {
            for (let i = 0; i < walkers.length;) {
                const next = await walkers[i]!.next();
                if (next.done) { walkers.splice(i, 1); continue; }
                i++;
                yield next.value;
            }
        }
    } finally { for (const walker of walkers) await walker.return(undefined); }
}

/** Scans are serialized: two refreshes cannot mutate one file's reducer at once. */
let pending: Promise<unknown> = Promise.resolve();
export function scanUsage(since = 0) {
    const next = pending.then(() => scan(since));
    pending = next.catch(() => undefined);
    return next;
}
async function scan(since: number) {
    const start = Date.now();
    let bytes = 0, truncated: string | undefined;
    const spent = () => {
        if (Date.now() - start > usageBounds.maxMs) return truncated ??= "Reading the sessions took too long; earlier ones are left out.";
        if (bytes >= usageBounds.maxBytes) return truncated ??= "There was too much to read; earlier sessions are left out.";
    };
    const roots = [{ root: paths.projectsDir(), source: "api" as Source, account: "default" }, ...(["claude-code", "codex"] as const).flatMap(source => listAccounts(source).filter(a => !a.invalid).flatMap(a => (source === "codex" ? ["sessions", "archived_sessions"] : ["projects"]).map(sub => ({ root: join(a.folder, sub), source, account: a.id }))))];
    const key = JSON.stringify(roots);
    if (!discovery || discovery.key !== key || since < discovery.since) {
        if (discovery) await discovery.walker.return(undefined);
        discovery = { key, since, walker: discover(roots), files: new Map(), missing: new Set(cache.keys()), done: false };
    }
    const fresh = new Set<string>();
    // Reserve half the time for reading. A paused iterator resumes next refresh.
    while (!discovery.done && Date.now() - start <= usageBounds.maxMs / 2) {
        const next = await discovery.walker.next();
        if (next.done) { discovery.done = true; break; }
        const f = next.value;
        if (typeof f === "string") truncated ??= f;
        else if (f) {
            discovery.missing.delete(f.file);
            fresh.add(f.file);
            // Old history must not consume the current range's file budget.
            if (f.mtimeMs >= since) discovery.files.set(f.file, f);
        }
        if (discovery.files.size > usageBounds.maxFiles) { truncated ??= `Only ${usageBounds.maxFiles} transcript files could be scanned; some sessions are left out.`; break; }
    }
    if (!discovery.done) truncated ??= "Reading the sessions took too long; earlier ones are left out.";
    else for (const file of discovery.missing) cache.delete(file);
    // Read pending discoveries first, using metadata already obtained this
    // refresh. Then rotate through cached files in LRU order. Stat and read each
    // file together so a slow metadata pass cannot starve all transcript reads.
    const files = [...discovery.files.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
    for (const [path, entry] of cache) if (entry.file.mtimeMs >= since && !discovery.files.has(path)) files.push(entry.file);
    for (let f of files.slice(0, Math.max(0, usageBounds.maxFiles))) {
        if (spent()) break;
        let entry = cache.get(f.file);
        if (entry) { cache.delete(f.file); cache.set(f.file, entry); }
        try {
            if (!fresh.has(f.file)) {
                const st = await stat(f.file);
                f = { ...f, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev };
            }
            if (f.mtimeMs < since) { cache.delete(f.file); discovery.files.delete(f.file); continue; }
            if (!entry || entry.file.size !== f.size || entry.file.mtimeMs !== f.mtimeMs || entry.file.ino !== f.ino || entry.file.dev !== f.dev) {
                const fh = await open(f.file, "r");
                try {
                    let resume = !!entry && f.size > entry.file.size && f.ino === entry.file.ino && f.dev === entry.file.dev;
                    if (resume && entry!.guard.length) {
                        if (usageBounds.maxBytes - bytes < entry!.guard.length) {
                            truncated ??= "There was too much to read; earlier sessions are left out.";
                            break;
                        }
                        const guard = Buffer.alloc(entry!.guard.length);
                        const len = Math.min(guard.length, Math.max(0, usageBounds.maxBytes - bytes));
                        const read = await fh.read(guard, 0, len, entry!.offset - guard.length);
                        bytes += read.bytesRead;
                        resume = read.bytesRead === guard.length && digest(guard) === entry!.guard.digest;
                    }
                    if (!resume) entry = { file: f, offset: 0, guard: { digest: "", length: 0 }, records: [], state: { model: "", session: "", undated: [] } };
                    entry = entry!;
                    // Do not mark partially read files complete; another request resumes them.
                    let pos = entry.offset, parser = new UsageJson();
                    let tail = Buffer.alloc(0);
                    const buf = Buffer.alloc(64 * 1024);
                    while (pos < f.size && !spent()) {
                        const len = Math.min(buf.length, f.size - pos, usageBounds.maxBytes - bytes);
                        const { bytesRead } = await fh.read(buf, 0, len, pos);
                        if (!bytesRead) break;
                        bytes += bytesRead;
                        const chunk = buf.subarray(0, bytesRead);
                        let from = 0;
                        for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, from)) {
                            parser.feed(chunk.subarray(from, nl));
                            const projected = parser.finish();
                            // A skipped CLI record can still date preceding legacy
                            // API usage in the same Harness transcript.
                            const dated = f.source === "api" && projected?.t === "usage" ? timestamp(projected.at) : 0;
                            if (dated) { for (const i of entry.state.undated) entry.records[i]!.at = dated; entry.state.undated = []; }
                            const r = parse(projected, f, entry.state);
                            if (r) {
                                if (!r.approx) { for (const i of entry.state.undated) entry.records[i]!.at = r.at; entry.state.undated = []; }
                                else entry.state.undated.push(entry.records.length);
                                entry.records.push(r);
                            }
                            parser = new UsageJson();
                            const end = nl + 1;
                            entry.offset = pos + end;
                            const guard = end >= 64 ? chunk.subarray(end - 64, end) : Buffer.concat([tail, chunk.subarray(0, end)]).subarray(-64);
                            entry.guard = { digest: digest(guard), length: guard.length };
                            from = end;
                        }
                        parser.feed(chunk.subarray(from));
                        tail = Buffer.concat([tail, chunk]).subarray(-64);
                        pos += bytesRead;
                    }
                    for (const i of entry.state.undated) entry.records[i]!.at = f.mtimeMs;
                    entry.file = { ...f, size: pos < f.size ? entry.offset : f.size };
                } finally { await fh.close(); }
            }
            cache.delete(f.file); cache.set(f.file, entry!);
            while (cache.size > Math.max(0, usageBounds.maxFiles)) cache.delete(cache.keys().next().value!);
            discovery.files.delete(f.file);
        } catch (e: any) {
            if (e.code === "ENOENT") { cache.delete(f.file); discovery.files.delete(f.file); }
            else truncated ??= "Some transcript files or folders could not be read.";
        }
    }
    // Unprocessed cached entries remain useful even after either budget expires.
    while (discovery.files.size > Math.max(0, usageBounds.maxFiles)) discovery.files.delete(discovery.files.keys().next().value!);
    if (discovery.done && !discovery.files.size) discovery = undefined;
    const result = [...cache.values()].filter(e => e.file.mtimeMs >= since).map(e => ({ source: e.file.source, account: e.file.account, records: e.records }));
    return { files: result, truncated, bytesRead: bytes };
}
export function clearUsageCache() {
    cache.clear();
    if (discovery) void discovery.walker.return(undefined);
    discovery = undefined;
}
