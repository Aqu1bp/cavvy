import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { usageSummary, usageBounds, clearUsageCache } = await import("../src/server/usage");
const { Session } = await import("../src/agent/session");
const { Agent } = await import("../src/agent/agent");
const { clientFor, forgetClient } = await import("../src/providers/models");
const { saveAgentConfig } = await import("../src/providers/registry");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const { trustForSession } = await import("../src/config/trust");
const dir = join(iso.home, "projects", "accounting");
const cwd = tempDir("usage-accounting-");
const now = Date.now();
const bounds = { ...usageBounds };

beforeEach(() => {
    rmSync(join(iso.home, "projects"), { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    clearUsageCache();
    Object.assign(usageBounds, bounds);
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});
afterAll(() => {
    Object.assign(usageBounds, bounds);
    clearUsageCache();
    iso.cleanup();
    rmSync(cwd, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

function records(name: string, rows: object[], mtime = now) {
    const file = join(dir, `${name}.jsonl`);
    writeFileSync(file, rows.map((r) => JSON.stringify({ t: "usage", at: now - 10_000, ...r })).join("\n") + "\n");
    utimesSync(file, mtime / 1000, mtime / 1000);
    return file;
}

function alias(model: string) {
    const cache = join(iso.home, "cache");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "models.json"), JSON.stringify({ version: 3, providers: { "claude-code": { fetchedAt: now, fp: "test", models: [{ provider: "claude-code", id: "opus", name: `Opus (${model})` }] } } }));
}

test("Codex API-key estimates are cost, only plan records contribute plan equivalent", async () => {
    records("api", [{ model: "codex:gpt-6-astra", usage: { inputTokens: 1_000_000, outputTokens: 0 }, cost: 0 }]);
    let summary = await usageSummary(1, now);
    expect(summary.rows[0]).toMatchObject({ cost: 10, planEquivalent: 0, plan: false });
    records("plan", [{ model: "codex:gpt-6-astra", usage: { inputTokens: 1_000_000, outputTokens: 0, cost: 0 }, cost: 0 }]);
    summary = await usageSummary(1, now);
    expect(summary.totals).toMatchObject({ cost: 20, planEquivalent: 10 });
});

test("recorded concrete models keep historical prices when Claude aliases move; legacy aliases are approximate", async () => {
    alias("claude-opus-4-1");
    records("resolved", [{ model: "claude-code:opus", usage: { inputTokens: 1_000_000, outputTokens: 0, cost: 0, resolvedModel: "claude-code:claude-opus-4-1" }, cost: 0 }]);
    const before = await usageSummary(1, now);
    expect(before.rows[0]).toMatchObject({ model: "claude-opus-4-1", cost: 15 });
    expect(before.approxPriced).toBe(0);
    alias("claude-opus-5-5");
    const after = await usageSummary(1, now);
    expect(after.rows).toEqual(before.rows);
    records("legacy", [{ model: "claude-code:opus", usage: { inputTokens: 1_000_000, outputTokens: 0, cost: 0 }, cost: 0 }]);
    const legacy = await usageSummary(1, now);
    expect(legacy.rows.find((r) => r.model === "opus")?.cost).toBe(4);
    expect(legacy.approxPriced).toBe(1);
});

test("cache evicts least recently used files even when every file is still in range", async () => {
    usageBounds.maxFiles = 2;
    const row = (cost: number) => ({ model: "anthropic:claude-opus-5-5", usage: { inputTokens: 1, outputTokens: 0 }, cost });
    const a = records("a", [row(1)], now - 1000);
    records("b", [row(1)], now - 2000);
    const c = records("c", [row(1)], now - 3000);
    expect((await usageSummary(1, now)).totals.cost).toBe(2); // caches a, b
    utimesSync(c, now / 1000, now / 1000);
    expect((await usageSummary(1, now)).totals.cost).toBe(2); // caches c, a; b must be evicted
    // Same size and mtime: a retained b would incorrectly keep its cached cost.
    records("b", [row(9)], now - 2000);
    utimesSync(a, (now - 4000) / 1000, (now - 4000) / 1000);
    utimesSync(c, (now - 5000) / 1000, (now - 5000) / 1000);
    expect((await usageSummary(1, now)).totals.cost).toBe(10);
});

async function agentFor(provider: "claude-code" | "codex", id = "default") {
    const bin = join(cwd, `${provider}-fake`);
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", provider === "codex" ? "fake-codex.ts" : "fake-claude.ts")}" "$@"\n`);
    chmodSync(bin, 0o755);
    saveAgentConfig(provider, { path: bin });
    forgetClient(provider);
    trustForSession(cwd);
    const settings = {};
    let mode: import("../src/permissions/modes").PermissionMode = "bypassPermissions";
    const session = Session.create(cwd);
    const agent = new Agent({
        session,
        model: { provider, id },
        client: await clientFor(provider),
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        host: { drainQueued: () => [], emit: () => {}, ui: {} },
    });
    return { agent, session };
}
const usageLines = (session: InstanceType<typeof Session>) => readFileSync(session.path, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.t === "usage");

test("Claude result model and plan/API billing are recorded and survive folding a delegated child", async () => {
    process.env.FAKE_RESOLVED_MODEL = "claude-opus-4-1";
    const { agent, session } = await agentFor("claude-code", "opus");
    expect(await agent.run([{ type: "text", text: "hello" }], { signal: new AbortController().signal })).toBe("done");
    expect(usageLines(session).at(-1).usage).toMatchObject({ resolvedModel: "claude-code:claude-opus-4-1", billing: "plan", cost: 0 });
    const planned = await (agent as any).runChild("plan-child", { prompt: "hello", description: "plan accounting", agent: "general-purpose" }, new AbortController().signal);
    expect(planned.status).toBe("done");
    expect(usageLines(session).at(-1).usage).toMatchObject({ resolvedModel: "claude-code:claude-opus-4-1", billing: "plan", cost: 0 });
    process.env.FAKE_API_KEY_SOURCE = "user";
    const child = await (agent as any).runChild("accounting-child", { prompt: "hello", description: "accounting", agent: "general-purpose" }, new AbortController().signal);
    expect(child.status).toBe("done");
    expect(usageLines(session).at(-1).usage).toMatchObject({ resolvedModel: "claude-code:claude-opus-4-1", billing: "api", cost: 0.5 });
});

test("Codex thread model is recorded for its default alias, including reroutes and API-key billing", async () => {
    const { agent, session } = await agentFor("codex");
    expect(await agent.run([{ type: "text", text: "hello" }], { signal: new AbortController().signal })).toBe("done");
    expect(usageLines(session).at(-1).usage).toMatchObject({ resolvedModel: "codex:gpt-test", billing: "plan", cost: 0 });
    process.env.FAKE_ACCOUNT = "apikey";
    process.env.FAKE_CODEX_REROUTED = "gpt-6-astra";
    expect(await agent.run([{ type: "text", text: "again" }], { signal: new AbortController().signal })).toBe("done");
    const usage = usageLines(session).at(-1).usage;
    expect(usage).toMatchObject({ resolvedModel: "codex:gpt-6-astra", billing: "api" });
    expect(usage.cost).toBeUndefined();
});
