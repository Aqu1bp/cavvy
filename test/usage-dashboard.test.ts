import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate } from "./helpers/isolate";
const iso = isolate();
const claude = process.env.CLAUDE_CONFIG_DIR!;
const codex = process.env.CODEX_HOME!;
const { usageSummary, usageDays, usageBounds, clearUsageCache } = await import("../src/server/usage");
const { scanUsage } = await import("../src/server/usage-reader");
const { UsageJson } = await import("../src/server/usage-json");
const { saveAgentConfig } = await import("../src/providers/registry");
const { costOf, usageCostParts } = await import("../src/providers/pricing");
const bounds = { ...usageBounds };
const now = Date.parse("2026-10-15T16:30:00Z");
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/usage", name), "utf8");
function write(file: string, data: string) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data); return file; }
const harnessLine = (model = "anthropic:claude-opus-5-5", cost = 1) => JSON.stringify({ t: "usage", at: now - 1000, model, cost, usage: { inputTokens: 100, outputTokens: 10 } }) + "\n";

test("Anthropic search fees survive session reload and dashboard cost breakdown", async () => {
    const { Session } = await import("../src/agent/session");
    const { resolveModelInfo } = await import("../src/providers/models");
    const session = Session.create(iso.home);
    session.push({ role: "user", content: [{ type: "text", text: "search" }] });
    const usage = { inputTokens: 100, outputTokens: 100, webSearchRequests: 8 };
    const model = "anthropic:claude-sonnet-5-5";
    const cost = costOf(usage, resolveModelInfo(model)).usd;
    expect(cost).toBeCloseTo(.0812, 10);
    session.recordUsage(model, usage, cost);
    const loaded = Session.load(session.path);
    expect(loaded.cost).toBeCloseTo(.0812, 10);
    expect(loaded.usageByModel.get(model)!.usage.webSearchRequests).toBe(8);
    const summary = await usageSummary(1);
    expect(summary.totals.cost).toBeCloseTo(.0812, 10);
    expect(summary.totals.costByType.input).toBeCloseTo(.0002, 10);
    expect(summary.totals.costByType.output).toBeCloseTo(.001, 10);
    expect(summary.totals.costByType.unallocated).toBeCloseTo(.08, 10);
    expect((await scanUsage()).files[0]!.records[0]!.usage.webSearchRequests).toBe(8);
});

test("offline Anthropic pricing includes Haiku's full-prompt long tier", async () => {
    const { resolveModelInfo } = await import("../src/providers/models");
    const usage = { inputTokens: 1, cacheReadTokens: 100_000, outputTokens: 1000 };
    expect(costOf(usage, resolveModelInfo("anthropic:claude-haiku-5-5")).usd).toBeCloseTo(.0075005, 10);
    write(join(iso.home, "projects/p/haiku.jsonl"), JSON.stringify({ t: "usage", at: now - 1000, model: "anthropic:claude-haiku-5-5", usage }) + "\n");
    expect((await usageSummary(1, now)).totals.cost).toBeCloseTo(.0075005, 10);
});

test("cached Anthropic metadata cannot retain stale static prices", async () => {
    const { resolveModelInfo, cachedListings } = await import("../src/providers/models");
    write(join(iso.home, "cache/models.json"), JSON.stringify({ version: 3, providers: { anthropic: { fetchedAt: now, fp: "test", models: [
        { provider: "anthropic", id: "claude-sonnet-5-5", pricing: { input: 2, output: 10, cacheRead: .2, cacheWrite: 2.5 } },
        { provider: "anthropic", id: "claude-haiku-5-5", pricing: { input: .1, output: .5, cacheRead: .01, cacheWrite: .125 } },
    ] } } }));
    expect(costOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, resolveModelInfo("anthropic:claude-sonnet-5-5")).usd).toBe(.1);
    const haiku = cachedListings().find(l => l.provider.id === "anthropic")!.models.find(m => m.id === "claude-haiku-5-5")!;
    expect(costOf({ inputTokens: 150_000, outputTokens: 10_000 }, haiku).usd).toBeCloseTo(.1, 10);
});
beforeEach(() => {
    for (const root of [iso.home, claude, codex]) { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }); }
    process.env.HARNESS_HOME = iso.home; process.env.CLAUDE_CONFIG_DIR = claude; process.env.CODEX_HOME = codex;
    clearUsageCache(); Object.assign(usageBounds, bounds);
});
afterAll(() => { Object.assign(usageBounds, bounds); clearUsageCache(); iso.cleanup(); });

test("CLI fixtures: message/request dedupe, cumulative deltas, model switches and archived legacy sessions", async () => {
    write(join(claude, "projects/p/a.jsonl"), fixture("claude-current.jsonl"));
    write(join(claude, "projects/p/subagents/b.jsonl"), fixture("claude-older.jsonl"));
    write(join(codex, "sessions/2026/10/15/rollout-current.jsonl"), fixture("codex-current.jsonl"));
    write(join(codex, "archived_sessions/rollout-old.jsonl"), fixture("codex-older.jsonl"));
    // Same rollout present in both directories must still count once.
    write(join(codex, "archived_sessions/rollout-copy.jsonl"), fixture("codex-current.jsonl"));
    const s = await usageSummary(7, now);
    expect(s.sessions).toBe(4);
    expect(s.sources.find(s => s.source === "claude-code")).toMatchObject({ sessions: 2, inputTokens: 1167, outputTokens: 128, cacheReadTokens: 700, cacheWriteTokens: 60, unknown: true });
    expect(s.sources.find(s => s.source === "codex")).toMatchObject({ sessions: 2, inputTokens: 2100, outputTokens: 220, cacheReadTokens: 500, unknown: false });
    expect(s.rows.find(r => r.model === "claude-opus-5-5")!.cost).toBeCloseTo(.00137, 8);
    expect(s.rows.find(r => r.model === "unpriced-model")).toMatchObject({ cost: 0, unknown: true, plan: true });
    expect(s.interval).toBe("day");
    expect(s.series).toHaveLength(8);
    expect(s.series.reduce((a, b) => a + b.cost, 0)).toBeCloseTo(s.totals.cost, 10);
    expect(Object.values(s.totals.costByType).reduce((a, b) => a + b, 0)).toBeCloseTo(s.totals.cost, 10);
    expect(s.buckets.every(b => b.accountId === "default" && b.at % 86400000 === 0)).toBe(true);
    expect((await usageSummary(1, now)).sessions).toBe(2);
    expect((await usageSummary(1, now)).series).toHaveLength(25);
});

test("CLI providers come exclusively from CLI transcripts; API providers keep recorded spend", async () => {
    write(join(iso.home, "projects/p/harness.jsonl"), harnessLine("claude-code:claude-opus-5-5", 99) + harnessLine("codex:gpt-6-astra", 99) + harnessLine("openrouter:custom", 2));
    write(join(claude, "projects/p/a.jsonl"), fixture("claude-current.jsonl"));
    write(join(codex, "sessions/rollout-a.jsonl"), fixture("codex-current.jsonl"));
    const s = await usageSummary(1, now);
    expect(s.sessions).toBe(3);
    expect(s.sources.find(s => s.source === "api")).toMatchObject({ sessions: 1, cost: 2, planEquivalent: 0, unknown: false });
    expect(s.totals.cost).toBeCloseTo(2 + s.totals.planEquivalent, 10);
    expect(s.totals.costByType.unallocated).toBe(2);
    rmSync(join(claude, "projects"), { recursive: true }); rmSync(join(codex, "sessions"), { recursive: true });
    expect((await usageSummary(1, now)).rows.map(r => r.provider)).toEqual(["openrouter"]);
});

test("default selectors and named account folders contribute separate account/time buckets", async () => {
    const namedClaude = join(iso.home, "accounts/claude/team");
    const namedCodex = join(iso.home, "accounts/codex/team");
    saveAgentConfig("claude-code", { accounts: [{ id: "team", name: "Team", folder: namedClaude, managed: true }] });
    saveAgentConfig("codex", { accounts: [{ id: "team", name: "Team", folder: namedCodex, managed: true }] });
    write(join(claude, "projects/p/default.jsonl"), fixture("claude-current.jsonl"));
    write(join(namedClaude, "projects/p/named.jsonl"), fixture("claude-current.jsonl").replaceAll("claude-session", "named-session"));
    write(join(namedCodex, "archived_sessions/rollout-named.jsonl"), fixture("codex-older.jsonl"));
    const s = await usageSummary(90, now);
    expect(s.sessions).toBe(3);
    expect(s.accounts.map(a => `${a.source}/${a.accountId}`).sort()).toEqual(["claude-code/default", "claude-code/team", "codex/team"]);
    expect(s.buckets.some(b => b.source === "codex" && b.accountId === "team")).toBe(true);
    expect(usageDays(90)).toBe(90);
});

test("an invalid saved account folder is skipped, never resolved against the server's folder", async () => {
    const cwd = process.cwd();
    const work = join(iso.home, "server-cwd");
    write(join(work, "projects/p/decoy.jsonl"), fixture("claude-current.jsonl").replaceAll("claude-session", "decoy-session"));
    saveAgentConfig("claude-code", { accounts: [{ id: "broken", name: "Broken", folder: "", managed: false }] });
    process.chdir(work);
    try {
        const s = await usageSummary(90, now);
        expect(s.sessions).toBe(0);
        expect(s.accounts.some(a => a.accountId === "broken")).toBe(false);
    } finally {
        process.chdir(cwd);
        saveAgentConfig("claude-code", { accounts: [] });
    }
});

test("incremental cache resumes appends, keeps reducer state and ignores torn tails until completed", async () => {
    const file = write(join(codex, "sessions/rollout-a.jsonl"), fixture("codex-current.jsonl") + '{"type":"response_item","payload":{"content":"' + "x".repeat(200_000) + '"}}\n');
    const cold = await scanUsage(); expect(cold.bytesRead).toBeGreaterThan(200000);
    expect((await scanUsage()).bytesRead).toBe(0);
    const extra = '{"timestamp":"2026-10-15T15:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2500,"cached_input_tokens":500,"output_tokens":250}}}}';
    appendFileSync(file, extra.slice(0, 100));
    const torn = await scanUsage(); expect(torn.bytesRead).toBeLessThan(300);
    expect((await usageSummary(1, now)).totals.outputTokens).toBe(200);
    appendFileSync(file, extra.slice(100) + "\n");
    const warm = await scanUsage(); expect(warm.bytesRead).toBeLessThan(1000);
    expect((await usageSummary(1, now)).totals).toMatchObject({ inputTokens: 2000, cacheReadTokens: 500, outputTokens: 250 });
});

test("bounds are strict, partial scans resume, and changed/truncated files invalidate cached state", async () => {
    const line = harnessLine();
    const file = write(join(iso.home, "projects/p/a.jsonl"), line.repeat(20));
    usageBounds.maxBytes = line.length * 3;
    const first = await scanUsage();
    expect(first.bytesRead).toBeLessThanOrEqual(usageBounds.maxBytes);
    expect(first.truncated).toContain("too much to read");
    expect(first.files[0]!.records).toHaveLength(3);
    Object.assign(usageBounds, bounds);
    expect((await usageSummary(1, now)).totals.cost).toBe(20);
    writeFileSync(file, harnessLine(undefined, 7));
    expect((await usageSummary(1, now)).totals.cost).toBe(7);
    // A growing rewrite with a different guard must restart, not append stale records.
    writeFileSync(file, harnessLine(undefined, 9).repeat(4));
    expect((await usageSummary(1, now)).totals.cost).toBe(36);
    usageBounds.maxMs = -1;
    expect((await usageSummary(1, now)).truncated).toContain("took too long");
});

test("file discovery is bounded; symlinks are not followed into arbitrary files", async () => {
    for (let i = 0; i < 6; i++) write(join(iso.home, `projects/p/${i}.jsonl`), harnessLine());
    usageBounds.maxFiles = 2;
    const s = await usageSummary(1, now);
    expect(s.sessions).toBe(2); expect(s.truncated).toContain("2");
    Object.assign(usageBounds, bounds);
    symlinkSync(join(iso.home, "projects"), join(iso.home, "projects/p/cycle"));
    expect((await usageSummary(1, now)).sessions).toBe(6);
});

test("projection handles escaped content, huge usage-bearing lines, utf8 and malformed records", async () => {
    const p = new UsageJson();
    const json = JSON.stringify({ message: { content: [{ text: 'secret\\"' + "z".repeat(300000) }], usage: { input_tokens: 3 }, model: "claude-é" }, type: "assistant" });
    const b = Buffer.from(json);
    for (let i = 0; i < b.length; i += 13) p.feed(b.subarray(i, i + 13));
    expect(JSON.stringify(p.finish())).toBe('{"message":{"usage":{"input_tokens":3},"model":"claude-é"},"type":"assistant"}');
    const bad = new UsageJson(); bad.feed(Buffer.from('{"usage": {"inputTokens": 9},')); expect(bad.finish()).toBeUndefined();
    const huge = fixture("claude-current.jsonl").replace('"ignored"', JSON.stringify("x".repeat(300000)));
    write(join(claude, "projects/p/a.jsonl"), huge);
    expect((await usageSummary(1, now)).totals.inputTokens).toBe(150);
});

test("cache-write TTL and long-context pricing use all prompt tokens to choose the tier", () => {
    const m = { provider: "anthropic", id: "claude-sonnet-4-5", pricing: { input: 3, output: 15, cacheRead: .3, cacheWrite: 3.75 } };
    const usage = { inputTokens: 100000, cacheReadTokens: 100000, cacheWriteTokens: 1000, cacheWrite1hTokens: 200, outputTokens: 1000 };
    const parts = usageCostParts(usage, m)!;
    expect(parts).toMatchObject({ input: .6, cacheRead: .06, output: .0225 });
    expect(parts.cacheWrite).toBeCloseTo(.0084, 8);
    expect(costOf(usage, m).usd).toBeCloseTo(.6909, 8);
    expect(costOf(usage, undefined).unknown).toBe(true);
    expect(costOf({ ...usage, inputTokens: 0 }, m).usd).toBeLessThan(.1);
});

test("concrete historical models stay pinned, unresolved aliases and unknown API prices stay unknown", async () => {
    write(join(claude, "projects/p/a.jsonl"), fixture("claude-current.jsonl").replaceAll("claude-opus-5-5", "opus"));
    write(join(iso.home, "projects/p/a.jsonl"), harnessLine("anthropic:claude-unreleased", 0));
    const s = await usageSummary(1, now);
    expect(s.rows.every(r => r.unknown && r.cost === 0)).toBe(true);
    expect(s.approxPriced).toBe(2);
});

test("RPC shape carries totals, all sources, accounts, buckets, 90 days, and unchanged limits", async () => {
    const limits = [{ provider: "codex", accountId: "team", at: now, windows: [{ id: "primary", label: "5-hour", usedPercent: 30, resetsAt: now + 1000 }] }];
    const s = JSON.parse(JSON.stringify(await usageSummary(90, now, limits)));
    expect(s).toMatchObject({ days: 90, interval: "day", accounts: [], buckets: [], limits });
    expect(s.sources.map((r: any) => r.source)).toEqual(["claude-code", "codex", "api"]);
    expect(s.series).toHaveLength(91);
    expect(s.totals.costByType).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unallocated: 0 });
});

test("Codex forks and spawned subagents advance copied counters without double counting the parent", async () => {
    write(join(codex, "sessions/rollout-parent.jsonl"), fixture("codex-current.jsonl"));
    const fork = write(join(codex, "sessions/rollout-child.jsonl"), fixture("codex-fork.jsonl"));
    const s = await usageSummary(1, now);
    expect(s.totals).toMatchObject({ inputTokens: 1950, outputTokens: 220, cacheReadTokens: 450 });
    expect(s.sessions).toBe(2);
    writeFileSync(fork, fixture("codex-fork.jsonl").replace('"forked_from_id":"codex-session"', '"source":{"subagent":{"thread_spawn":{"parent_thread_id":"codex-session"}}}'));
    expect((await usageSummary(1, now)).totals).toEqual(s.totals);
});

test("same configured folder through an alias is scanned once, and guard budget preserves cached usage", async () => {
    const alias = join(iso.home, "alias"); symlinkSync(claude, alias);
    saveAgentConfig("claude-code", { accounts: [{ id: "alias", name: "Alias", folder: alias, managed: false }] });
    const file = write(join(claude, "projects/p/a.jsonl"), fixture("claude-current.jsonl"));
    const initial = await usageSummary(1, now);
    expect(initial.sessions).toBe(1);
    appendFileSync(file, "\n"); usageBounds.maxBytes = 10;
    const next = await usageSummary(1, now);
    expect(next.truncated).toContain("too much to read");
    expect(next.totals).toEqual(initial.totals);
});

test("mixed last-only/cumulative events reconcile, counter resets and fast service tiers survive appends", async () => {
    const event = (minute: number, info: object) => JSON.stringify({ timestamp: `2026-10-15T15:0${minute}:00Z`, type: "event_msg", payload: { type: "token_count", info } }) + "\n";
    const count = (input: number) => ({ input_tokens: input, output_tokens: input / 10 });
    const file = write(join(codex, "sessions/rollout-mixed.jsonl"), fixture("codex-current.jsonl").split("\n").slice(0, 2).join("\n") + "\n" + event(0, { last_token_usage: count(100) }) + event(1, { total_token_usage: count(200) }));
    expect((await usageSummary(1, now)).totals.inputTokens).toBe(200);
    appendFileSync(file, event(2, { last_token_usage: count(100) }) + event(3, { total_token_usage: count(400) }));
    expect((await usageSummary(1, now)).totals.inputTokens).toBe(400);
    appendFileSync(file, JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } } }) + "\n" + event(4, { total_token_usage: count(50), last_token_usage: count(50) }));
    const s = await usageSummary(1, now);
    expect(s.totals.inputTokens).toBe(450);
    expect(s.totals.cost).toBeCloseTo(400 * 10 / 1e6 + 40 * 50 / 1e6 + 50 * 20 / 1e6 + 5 * 100 / 1e6, 10);
});

test("old Harness archives cannot exhaust the file budget before current CLI transcripts", async () => {
    for (let i = 0; i < 10; i++) {
        const path = write(join(iso.home, `projects/p/old-${i}.jsonl`), harnessLine());
        utimesSync(path, (now - 365 * 86400000) / 1000, (now - 365 * 86400000) / 1000);
    }
    write(join(claude, "projects/p/current.jsonl"), fixture("claude-current.jsonl"));
    usageBounds.maxFiles = 2;
    const s = await usageSummary(1, now);
    expect(s.sessions).toBe(1);
    expect(s.sources.find(s => s.source === "claude-code")!.inputTokens).toBe(150);
    expect(s.truncated).toBeUndefined();
});

test("excluded Harness CLI usage still dates earlier undated API records", async () => {
    const undated = JSON.stringify({ t: "usage", model: "custom:model", cost: 1, usage: { inputTokens: 5, outputTokens: 0 } });
    const cli = JSON.stringify({ t: "usage", model: "codex:gpt-6-astra", at: now - 2 * 86400000, usage: { inputTokens: 99, outputTokens: 0 } });
    write(join(iso.home, "projects/p/old.jsonl"), undated + "\n" + cli + "\n");
    expect((await usageSummary(1, now)).rows).toEqual([]);
    expect((await usageSummary(7, now)).totals).toMatchObject({ inputTokens: 5, cost: 1 });
});

// Evaluate the real reader with a private cache and injectable I/O/clock. This
// lets us inspect retained state and exhaust discovery time deterministically.
async function readerWith(overrides: Record<string, unknown> = {}) {
    const { open, opendir, realpath, stat } = await import("fs/promises");
    const { resolve } = await import("path");
    const { createHash } = await import("crypto");
    const { paths } = await import("../src/config/paths");
    const { listAccounts } = await import("../src/providers/accounts");
    const scope = { open, opendir, realpath, stat, join, resolve, createHash, paths, listAccounts, UsageJson, ...overrides };
    const source = readFileSync(new URL("../src/server/usage-reader.ts", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    return new Function(...Object.keys(scope), `${js}; return { scanUsage, clearUsageCache, usageBounds, cache };`)(...Object.values(scope));
}

test("append guards retain only a digest and length, including after skipped prompt lines", async () => {
    const reader = await readerWith();
    const secret = "private prompt never retained";
    const line = JSON.stringify({ type: "user", content: secret }) + "\n";
    const file = write(join(iso.home, "projects/p/private.jsonl"), harnessLine() + line);
    try {
        await reader.scanUsage();
        const entry = reader.cache.get(await (await import("fs/promises")).realpath(file));
        const bytes = Buffer.from(harnessLine() + line).subarray(-64);
        expect(entry.guard).toEqual({ digest: (await import("crypto")).createHash("sha256").update(bytes).digest("hex"), length: bytes.length });
        expect(JSON.stringify([...reader.cache.values()])).not.toContain(secret);
        appendFileSync(file, harnessLine());
        const appended = await reader.scanUsage();
        expect(appended.files[0].records).toHaveLength(2);
        expect(appended.bytesRead).toBe(64 + Buffer.byteLength(harnessLine()));
        writeFileSync(file, harnessLine(undefined, 9).repeat(4));
        expect((await reader.scanUsage()).files[0].records.map((r: any) => r.cost)).toEqual([9, 9, 9, 9]);
    } finally { reader.clearUsageCache(); }
});

test("pre-context Codex counters resolve once, including context-only appends and unresolved EOF", async () => {
    const count = (second: number, input = 100) => JSON.stringify({ timestamp: `2026-10-15T12:00:0${second}Z`, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: input / 10 } } } }) + "\n";
    const context = JSON.stringify({ timestamp: "2026-10-15T12:00:02Z", type: "turn_context", payload: { model: "gpt-6-astra" } }) + "\n";
    const file = write(join(codex, "sessions/rollout-ordering.jsonl"), count(1));
    expect((await usageSummary(1, now)).rows[0]).toMatchObject({ model: "unknown", inputTokens: 100, outputTokens: 10, unknown: true, cost: 0 });
    appendFileSync(file, context);
    const resolved = await usageSummary(1, now);
    expect(resolved.rows).toHaveLength(1);
    expect(resolved.rows[0]).toMatchObject({ model: "gpt-6-astra", inputTokens: 100, outputTokens: 10, unknown: false });
    expect(resolved.totals.cost).toBeCloseTo(.0015, 10);
    appendFileSync(file, count(3));
    expect((await usageSummary(1, now)).totals).toEqual(resolved.totals);
    clearUsageCache(); // The exact three-line reproducer also works on a cold scan.
    expect((await usageSummary(1, now)).totals).toEqual(resolved.totals);
    writeFileSync(file, count(1) + count(2, 200) + context + count(3, 200));
    expect((await usageSummary(1, now)).totals).toMatchObject({ inputTokens: 200, outputTokens: 20, unknown: false });
});

test("Codex ultrafast retains its tier and tokens but stays unpriced across appends", async () => {
    const settings = (tier?: string) => JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: tier } } }) + "\n";
    const count = (input: number) => JSON.stringify({ timestamp: now - 1000 + input, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: input / 10 } } } }) + "\n";
    const file = write(join(codex, "sessions/rollout-ultrafast.jsonl"), JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } }) + "\n" + settings("ultrafast") + count(100));
    expect((await scanUsage()).files[0]!.records[0]).toMatchObject({ serviceTier: "ultrafast", unknown: true });
    expect((await usageSummary(1, now)).totals).toMatchObject({ inputTokens: 100, outputTokens: 10, cost: 0, unknown: true, planEquivalent: 0, cacheSavings: 0 });
    appendFileSync(file, count(200));
    expect((await usageSummary(1, now)).totals).toMatchObject({ inputTokens: 200, cost: 0, unknown: true });
    appendFileSync(file, settings() + count(300));
    const mixed = await usageSummary(1, now);
    expect(mixed.totals).toMatchObject({ inputTokens: 300, outputTokens: 30, unknown: true });
    expect(mixed.totals.cost).toBeCloseTo(.0015, 10);
    expect(mixed.totals.costByType.input).toBeCloseTo(.001, 10);
});

test("discovery reserves reading time, resumes across refreshes and keeps cached results", async () => {
    let elapsed = 0;
    const { opendir } = await import("fs/promises");
    const reader = await readerWith({ Date: { now: () => elapsed, parse: Date.parse },
        opendir: async (dir: string) => ({ async *[Symbol.asyncIterator]() {
            for await (const entry of await opendir(dir)) { elapsed += 10; yield entry; }
        } }) });
    reader.usageBounds.maxMs = 40;
    for (let i = 0; i < 12; i++) write(join(iso.home, `projects/p/${i}.jsonl`), harnessLine());
    try {
        let scan = await reader.scanUsage(now - 86400000);
        expect(scan.truncated).toContain("took too long");
        expect(scan.files.length).toBeGreaterThan(0);
        let previous = scan.files.length;
        for (let refresh = 0; scan.truncated && refresh < 10; refresh++) {
            scan = await reader.scanUsage(now - 86400000);
            expect(scan.files.length).toBeGreaterThanOrEqual(previous);
            previous = scan.files.length;
        }
        expect(scan.truncated).toBeUndefined();
        expect(scan.files).toHaveLength(12);
        reader.usageBounds.maxMs = -1;
        const expired = await reader.scanUsage(now - 86400000);
        expect(expired.truncated).toContain("took too long");
        expect(expired.files).toHaveLength(12);
        expect(expired.bytesRead).toBe(0);
    } finally { reader.clearUsageCache(); }
});

test("discovery restarts when the range narrows then widens between refreshes", async () => {
    let elapsed = 0;
    const { opendir } = await import("fs/promises");
    const reader = await readerWith({ Date: { now: () => elapsed, parse: Date.parse }, listAccounts: () => [],
        opendir: async (dir: string) => ({ async *[Symbol.asyncIterator]() {
            for await (const entry of await opendir(dir)) { elapsed += 10; yield entry; }
        } }) });
    reader.usageBounds.maxMs = 40;
    const wide = now - 3 * 86400000, narrow = now - 86400000;
    for (let i = 0; i < 9; i++) {
        const file = write(join(iso.home, `projects/${i}.jsonl`), harnessLine());
        utimesSync(file, (now - 2 * 86400000) / 1000, (now - 2 * 86400000) / 1000);
    }
    try {
        const first = await reader.scanUsage(wide);
        expect(first.files).toHaveLength(3);
        expect(first.truncated).toContain("took too long");
        expect((await reader.scanUsage(narrow)).files).toHaveLength(0);
        let scan = await reader.scanUsage(wide);
        for (let refresh = 0; scan.truncated && refresh < 6; refresh++) scan = await reader.scanUsage(wide);
        expect(scan.truncated).toBeUndefined();
        expect(scan.files).toHaveLength(9);
    } finally { reader.clearUsageCache(); }
});

test.each(["ENOENT", "EACCES"])("a discovery stat %s failure preserves surviving siblings", async (code) => {
    const { stat } = await import("fs/promises");
    let fail = false, failedFile = "";
    const reader = await readerWith({ listAccounts: () => [], stat: async (file: string) => {
        if (fail) { fail = false; failedFile = file; throw Object.assign(new Error(code), { code }); }
        return stat(file);
    } });
    for (let i = 0; i < 3; i++) write(join(iso.home, `projects/${i}.jsonl`), harnessLine());
    try {
        expect((await reader.scanUsage()).files).toHaveLength(3);
        fail = true;
        const scan = await reader.scanUsage();
        expect(scan.files).toHaveLength(2);
        expect(scan.files.every((f: any) => f.records[0].session !== failedFile)).toBe(true);
        if (code === "ENOENT") expect(scan.truncated).toBeUndefined();
        else expect(scan.truncated).toBe("Some transcript files or folders could not be read.");
    } finally { reader.clearUsageCache(); }
});

test("every refresh over the file budget reports truncation including cached candidates", async () => {
    const reader = await readerWith({ listAccounts: () => [] });
    reader.usageBounds.maxFiles = 2;
    for (let i = 0; i < 3; i++) write(join(iso.home, `projects/${i}.jsonl`), harnessLine());
    try {
        for (let refresh = 0; refresh < 6; refresh++) {
            const scan = await reader.scanUsage(now - 86400000);
            expect(scan.files).toHaveLength(2);
            expect(scan.truncated).toBe("Only 2 transcript files could be scanned; some sessions are left out.");
        }
    } finally { reader.clearUsageCache(); }
});

test.each([false, true])("changing roots clears retired cache entries with discovery paused: %s", async (paused) => {
    let elapsed = 0, root = join(iso.home, "original");
    const { realpath, stat } = await import("fs/promises");
    const reader = await readerWith({ Date: { now: () => elapsed, parse: Date.parse },
        paths: { projectsDir: () => root }, listAccounts: () => [],
        stat: async (file: string) => { elapsed += 30; return stat(file); } });
    for (const dir of ["original", "migrated"]) {
        for (let i = 0; i < 2; i++) write(join(iso.home, dir, `${i}.jsonl`), harnessLine());
    }
    try {
        reader.usageBounds.maxMs = paused ? 40 : 4000;
        const first = await reader.scanUsage();
        expect(first.files).toHaveLength(paused ? 1 : 2);
        if (paused) expect(first.truncated).toContain("took too long");
        else expect(first.truncated).toBeUndefined();
        root = join(iso.home, "migrated");
        reader.usageBounds.maxMs = 40;
        const migrated = await reader.scanUsage();
        expect(migrated.truncated).toContain("took too long");
        expect(migrated.files).toHaveLength(1);
        expect(migrated.files[0].records[0].session.startsWith(await realpath(root) + "/")).toBe(true);
        reader.usageBounds.maxMs = 4000;
        expect((await reader.scanUsage()).files).toHaveLength(2);
    } finally { reader.clearUsageCache(); }
});

test("aggregation yields a macrotask between bounded batches of cached records", async () => {
    write(join(iso.home, "projects/p/batches.jsonl"), harnessLine().repeat(4001));
    const records = (await scanUsage()).files[0]!.records;
    let yielded = false, observedYield = false;
    Object.defineProperty(records[0], "at", { get() { setImmediate(() => { yielded = true; }); return now - 1000; } });
    Object.defineProperty(records[2000], "at", { get() { observedYield = yielded; return now - 1000; } });
    const summary = await usageSummary(1, now);
    expect(observedYield).toBe(true);
    expect(summary.truncated).toBeUndefined();
    expect(summary.totals.cost).toBe(4001);
});


test.each([14, 15])("slow %d ms metadata checks leave time to read and discovery still converges", async (latency) => {
    let elapsed = 0;
    const { stat } = await import("fs/promises");
    const reader = await readerWith({ Date: { now: () => elapsed, parse: Date.parse },
        stat: async (file: string) => { elapsed += latency; return stat(file); } });
    reader.usageBounds.maxMs = 40;
    for (let i = 0; i < 5; i++) write(join(iso.home, `projects/p/${i}.jsonl`), harnessLine());
    try {
        let count = 0;
        for (let round = 1; round <= 2; round++) {
            if (round === 2) for (let i = 0; i < 5; i++) appendFileSync(join(iso.home, `projects/p/${i}.jsonl`), harnessLine());
            for (let refresh = 0; refresh < 8; refresh++) {
                const scan = await reader.scanUsage(now - 86400000);
                const records = scan.files.reduce((sum: number, f: any) => sum + f.records.length, 0);
                expect(records).toBeGreaterThanOrEqual(count);
                count = records;
                if (count === round * 5) break;
                expect(scan.truncated).toContain("took too long");
            }
            expect(count).toBe(round * 5);
        }
    } finally { reader.clearUsageCache(); }
});

test("aggregation keeps its deadline after yielding between batches", async () => {
    write(join(iso.home, "projects/p/deadline.jsonl"), harnessLine().repeat(4001));
    const records = (await scanUsage()).files[0]!.records;
    let elapsed = now;
    const clock = spyOn(Date, "now").mockImplementation(() => elapsed);
    Object.defineProperty(records[0], "at", { get() { setImmediate(() => { elapsed = now + 4001; }); return now - 1000; } });
    try {
        const summary = await usageSummary(1, now);
        expect(summary.truncated).toContain("Aggregating the sessions took too long");
        expect(summary.totals.cost).toBe(2000);
    } finally { clock.mockRestore(); }
});
