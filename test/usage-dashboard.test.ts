import { afterAll, beforeEach, expect, test } from "bun:test";
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
