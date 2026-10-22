import { afterAll, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { isolate, FAKE } from "./helpers/isolate";
const iso = isolate();
const { AnthropicProvider } = await import("../src/providers/anthropic");
const { BUILTIN_PROVIDERS } = await import("../src/providers/registry");
const { costOf } = await import("../src/providers/pricing");
const { TurnTally } = await import("../src/sdk/messages");
import type { AgentEvent } from "../src/agent/agent";
type Json = Record<string, any>;
let respond: () => Response;
function providerWithMock() {
    const provider = new AnthropicProvider(BUILTIN_PROVIDERS.find(p => p.id === "anthropic")!, FAKE.anthropic);
    (provider as any).client = new Anthropic({ apiKey: FAKE.anthropic, maxRetries: 0, fetch: async () => respond() });
    return provider;
}
afterAll(() => iso.cleanup());

test.each([false, true])("real Task execution folds child records, including modeled hooks=%s, without duplicate spend", async (modeledHook) => {
    const { Agent } = await import("../src/agent/agent");
    const { Session } = await import("../src/agent/session");
    const { PermissionChecker } = await import("../src/permissions/checker");
    const { BUILTIN_TOOLS } = await import("../src/tools/index");
    const session = Session.create(iso.home, { persist: false });
    const tally = new TurnTally();
    let turns = 0;
    const model = providerWithMock().staticInfo("claude-sonnet-5-5");
    const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, webSearchRequests: 1 };
    const agent = new Agent({
        session, model, settings: () => modeledHook ? { hooks: { Stop: [{ type: "prompt", prompt: "Done?", model: "anthropic:claude-sonnet-5-5" }], SubagentStop: [{ type: "prompt", prompt: "Done?", model: "anthropic:claude-sonnet-5-5" }] } } : {}, tools: BUILTIN_TOOLS,
        helpers: {
            complete: async () => '{"ok":true}',
            resolveModel: async () => ({ model, client: { listModels: async () => [model], stream: async () => ({ role: "assistant", provider: model.provider, model: model.id, content: [{ type: "text", text: '{"ok":true}' }], usage }) } }),
        },
        checker: new PermissionChecker(() => ({}), iso.home),
        mode: { get: () => "bypassPermissions", set: () => {} },
        toolState: { cwd: iso.home, projectRoot: iso.home, fileState: new Map(), todos: [], shells: new Map() },
        host: { emit: e => tally.observe(e), ui: {} },
        client: {
            listModels: async () => [model],
            stream: async () => {
                turns++;
                return { role: "assistant", provider: model.provider, model: model.id, usage,
                    stopReason: turns === 1 ? "tool_use" : "end_turn",
                    content: turns === 1 ? [{ type: "tool_call", id: "task", name: "Task", input: { description: "review", prompt: "review", subagent_type: "explore" } }]
                        : [{ type: "text", text: turns === 2 ? "child answer" : "parent answer" }],
                };
            },
        },
    });
    try {
        const reason = await agent.run([{ type: "text", text: "delegate" }], { signal: new AbortController().signal });
        expect(reason).toBe("done");
        expect(turns).toBe(3);
        const result = tally.result(reason, session.meta.id, "anthropic:claude-sonnet-5-5");
        const count = modeledHook ? 5 : 3;
        expect(result).toMatchObject({ result: "parent answer", num_turns: 2, total_cost_usd: Number((count * .010503).toFixed(6)),
            usage: { input_tokens: count * 100, output_tokens: count * 20, cache_read_input_tokens: count * 30, cache_creation_input_tokens: count * 40 } });
        expect(session.usageRecords).toHaveLength(count);
        expect(session.cost).toBeCloseTo(result.total_cost_usd, 10);
    } finally { await agent.dispose(); }
});

test.each([false, true])("child compaction reports its saved spend, including transcript fallback=%s", async (fallback) => {
    const { Agent } = await import("../src/agent/agent");
    const { Session } = await import("../src/agent/session");
    const { PermissionChecker } = await import("../src/permissions/checker");
    const session = Session.create(iso.home, { persist: false });
    const model = providerWithMock().staticInfo("claude-sonnet-5-5");
    session.push({ role: "user", content: [{ type: "text", text: "review" }] });
    session.push({ role: "assistant", provider: model.provider, model: model.id, content: [{ type: "text", text: "reviewing" }] });
    const tally = new TurnTally();
    let calls = 0;
    const agent = new Agent({
        session, model, isSubagent: true, settings: () => ({}), tools: [],
        checker: new PermissionChecker(() => ({}), iso.home),
        mode: { get: () => "bypassPermissions", set: () => {} },
        toolState: { cwd: iso.home, projectRoot: iso.home, fileState: new Map(), todos: [], shells: new Map() },
        host: { emit: event => tally.observe({ type: "subagent", parentId: "task", label: "child", event }), ui: {} },
        client: { listModels: async () => [model], stream: async () => ({ role: "assistant", provider: model.provider, model: model.id,
            content: [{ type: "text", text: fallback && ++calls === 1 ? "" : "summary" }], usage: { inputTokens: 100, outputTokens: 20, cost: .01 } }) },
    });
    try {
        expect(await agent.compact({ auto: true, signal: new AbortController().signal })).toBe(true);
        const count = fallback ? 2 : 1;
        expect(tally.cost).toBeCloseTo(count * .01, 10);
        expect(session.cost).toBe(tally.cost);
        expect(tally.usage.inputTokens).toBe(count * 100);
    } finally { await agent.dispose(); }
});

test.each(["done", "error", "aborted"] as const)("tally includes nested child usage on %s without replacing the parent's answer", (reason) => {
    const tally = new TurnTally();
    const usage: AgentEvent = { type: "usage", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 }, cost: { usd: .01, estimated: true, unknown: false }, contextTokens: 170 };
    const child = (event: AgentEvent): AgentEvent => ({ type: "subagent", parentId: "task", label: "child", event });
    tally.observe({ type: "assistant", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-5-5", content: [{ type: "text", text: "parent answer" }] } });
    tally.observe(usage);
    tally.observe(child(usage));
    tally.observe(child(child(usage)));
    // Native CLI sub-agent notifications repeat usage already included above.
    tally.observe(child({ ...usage, displayOnly: true }));
    tally.observe(child(child({ ...usage, displayOnly: true })));
    tally.observe(child({ type: "assistant", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-5-5", content: [{ type: "text", text: "child answer" }] } }));
    tally.observe(child({ type: "notice", level: "error", message: "child error" }));
    expect(tally.result(reason, "session", "anthropic:claude-sonnet-5-5")).toMatchObject({
        result: "parent answer", num_turns: 1, total_cost_usd: .03, errors: [],
        usage: { input_tokens: 300, output_tokens: 60, cache_read_input_tokens: 90, cache_creation_input_tokens: 120 },
    });
});

test("current Anthropic prices survive live discovery and offline fallbacks", async () => {
    const provider = providerWithMock();
    const ids = ["claude-sonnet-5-5", "claude-haiku-5-5"];
    respond = () => Response.json({ data: ids.map(id => ({ id, display_name: id, created_at: "2026-10-01T00:00:00Z" })), has_more: false });
    const live = await provider.listModels();
    respond = () => new Response("offline", { status: 503 });
    const fallback = await provider.listModels();
    for (const models of [live, fallback, ids.map(id => provider.staticInfo(id))]) {
        const sonnet = models.find(m => m.id === ids[0])!;
        const haiku = models.find(m => m.id === ids[1])!;
        expect(costOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, sonnet).usd).toBe(.1);
        expect(haiku.longContextThreshold).toBe(100_000);
        expect(costOf({ inputTokens: 100_000, outputTokens: 10_000 }, haiku).usd).toBeCloseTo(.015, 10);
        expect(costOf({ inputTokens: 150_000, outputTokens: 10_000 }, haiku).usd).toBeCloseTo(.1, 10);
        const cached = { inputTokens: 1, outputTokens: 1000, cacheReadTokens: 90_000, cacheWriteTokens: 10_000, cacheWrite1hTokens: 2000 };
        expect(costOf(cached, haiku).usd).toBeCloseTo(.0140005, 10);
    }
});

test.each([undefined, 0, 8])("server search usage is priced once from final usage: %s", async (searches) => {
    const ev = (type: string, data: Json) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    respond = () => new Response([
        ev("message_start", { message: { id: "search", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0, ...(searches === undefined ? {} : { server_tool_use: { web_search_requests: 0 } }) } } }),
        ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100, ...(searches === undefined ? {} : { server_tool_use: { web_search_requests: searches } }) } }),
        ev("message_stop", {}),
    ].join(""), { headers: { "content-type": "text/event-stream" } });
    const provider = providerWithMock();
    const model = provider.staticInfo("claude-sonnet-5-5");
    const msg = await provider.stream({ model, system: "test", messages: [{ role: "user", content: [{ type: "text", text: "search" }] }], tools: [], signal: new AbortController().signal }, () => {});
    expect(msg.usage).toMatchObject({ inputTokens: 100, outputTokens: 100 });
    expect(msg.usage?.webSearchRequests ?? 0).toBe(searches ?? 0);
    expect(costOf(msg.usage!, model).usd).toBeCloseTo(.0012 + (searches ?? 0) * .01, 10);
    expect(costOf({ ...msg.usage!, cost: .123 }, model).usd).toBe(.123);
});

