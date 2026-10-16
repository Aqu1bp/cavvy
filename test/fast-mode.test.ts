import { afterAll, describe, expect, test } from "bun:test";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
afterAll(iso.cleanup);
const { apiFastModeInfo } = await import("../src/providers/fast-mode");
const { codexFastTier } = await import("../src/backends/codex");
const { claudeFastModeVersion } = await import("../src/backends/claude-code");
const { OpenAIResponsesProvider } = await import("../src/providers/openai-responses");
const { AnthropicProvider } = await import("../src/providers/anthropic");
const { BUILTIN_PROVIDERS } = await import("../src/providers/registry");
const { costOf } = await import("../src/providers/pricing");
const { Session } = await import("../src/agent/session");
const { runCommand } = await import("../src/commands/index");
import type { ChatRequest, ModelInfo } from "../src/providers/types";

const def = (id: string) => BUILTIN_PROVIDERS.find((p) => p.id === id)!;
function request(provider: string, id: string, fastMode: boolean): ChatRequest {
    return { model: { provider, id, supportsReasoning: true, effortLevels: ["high"], ...apiFastModeInfo(provider, id, def(provider).baseUrl) }, system: "Test", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools: [], effort: "high", fastMode };
}

describe("fast mode capabilities", () => {
    test("requires an explicitly supported first-party model and endpoint", () => {
        expect(apiFastModeInfo("openai", "gpt-6-astra", "https://api.openai.com/v1").supportsFastMode).toBe(true);
        expect(apiFastModeInfo("openai", "gpt-6-astra-2026-10-01", "https://api.openai.com/v1").supportsFastMode).toBe(true);
        for (const id of ["gpt-6-astra-other", "gpt-unknown", "ft:gpt-6-astra"]) expect(apiFastModeInfo("openai", id, "https://api.openai.com/v1").supportsFastMode).toBeUndefined();
        expect(apiFastModeInfo("custom", "gpt-6-astra", "https://api.openai.com/v1").supportsFastMode).toBeUndefined();
        expect(apiFastModeInfo("openai", "gpt-6-astra", "https://api.openai.com.example/v1").supportsFastMode).toBeUndefined();
        expect(apiFastModeInfo("anthropic", "claude-opus-5-5", "https://api.anthropic.com").supportsFastMode).toBe(true);
        const opus = apiFastModeInfo("anthropic", "claude-opus-5-5", "https://api.anthropic.com");
        expect(opus.fastPricing?.cacheRead).toBe(0.4);
        expect(costOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, fastMode: true }, { provider: "anthropic", id: "claude-opus-5-5", ...opus }).usd).toBe(0.4);
        for (const id of ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-4-6", "claude-opus-4-7"]) expect(apiFastModeInfo("anthropic", id, "https://api.anthropic.com").supportsFastMode).toBeUndefined();
    });
    test("Codex current catalog is authoritative, with conservative legacy fallback", () => {
        expect(codexFastTier({ serviceTiers: [{ id: "fast" }] })).toBe("fast");
        expect(codexFastTier({ additionalSpeedTiers: ["fast"] })).toBe("fast");
        expect(codexFastTier({ serviceTiers: [], additionalSpeedTiers: ["fast"] })).toBeUndefined();
        expect(codexFastTier({ serviceTiers: [{ id: "ultrafast" }] })).toBeUndefined();
    });
    test("Claude Code requires a version supporting noninteractive fast mode", () => {
        for (const v of ["2.1.204", "1.9.999", undefined, "garbage"]) expect(claudeFastModeVersion(v)).toBe(false);
        for (const v of ["2.1.205", "2.1.301", "2.2.0", "3.0.0"]) expect(claudeFastModeVersion(v)).toBe(true);
    });
});

describe("fast service requests and actual billing tier", () => {
    test("OpenAI sends fast/default, keeps effort, and records a provider downgrade", async () => {
        const original = globalThis.fetch;
        const bodies: any[] = [];
        let served = "fast";
        globalThis.fetch = (async (_url: any, opts: any) => {
            bodies.push(JSON.parse(opts.body));
            return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", service_tier: served, output: [], usage: { input_tokens: 100, output_tokens: 10 } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch;
        try {
            const p = new OpenAIResponsesProvider(def("openai"), "fake");
            const r = request("openai", "gpt-6-astra", true);
            const fast = await p.stream(r, () => {});
            expect(bodies[0].service_tier).toBe("fast");
            expect(bodies[0].reasoning.effort).toBe("high");
            expect(fast.usage?.fastMode).toBe(true);
            expect(costOf(fast.usage!, r.model).usd).toBeCloseTo(0.003);
            served = "default";
            const downgraded = await p.stream(r, () => {});
            expect(downgraded.usage?.fastMode).toBe(false);
            await p.stream({ ...r, fastMode: false }, () => {});
            expect(bodies[2].service_tier).toBe("default");
            await p.stream({ ...r, model: { ...r.model, id: "unknown", supportsFastMode: false } }, () => {});
            expect(bodies[3].service_tier).toBe("default");
        } finally { globalThis.fetch = original; }
    });
    test("Anthropic sends speed independently of effort and bills actual speed", async () => {
        const original = globalThis.fetch;
        const bodies: any[] = [];
        const event = (type: string, rest: any) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
        globalThis.fetch = (async (_url: any, opts: any) => {
            const body = JSON.parse(opts.body); bodies.push(body);
            return new Response([
                event("message_start", { message: { id: "msg1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, speed: body.speed ?? "standard" } } }),
                event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }), event("message_stop", {}),
            ].join(""), { headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch;
        try {
            const p = new AnthropicProvider(def("anthropic"), "fake");
            const r = request("anthropic", "claude-opus-5-5", true);
            const fast = await p.stream(r, () => {});
            expect(bodies[0].speed).toBe("fast");
            expect(bodies[0].output_config.effort).toBe("high");
            expect(fast.usage?.fastMode).toBe(true);
            expect(costOf(fast.usage!, r.model).usd).toBeCloseTo(0.0012);
            await p.stream({ ...r, fastMode: false }, () => {});
            expect(bodies[1].speed).toBe("standard");
            await p.stream(request("anthropic", "claude-sonnet-5-5", true), () => {});
            expect(bodies[2].speed).toBeUndefined();
        } finally { globalThis.fetch = original; }
    });
});

test("session speed survives reload, including explicit false", () => {
    const s = Session.create(tempDir("fast-session-"));
    s.setFastMode(true);
    s.push({ role: "user", content: [{ type: "text", text: "hi" }] });
    s.setFastMode(false);
    const path = s.path;
    s.release();
    const resumed = Session.load(path);
    expect(resumed.fastMode).toBe(false);
    resumed.release();
});

test("terminal /fast toggles, reports status, rejects unsupported models and busy changes", async () => {
    const notices: string[] = [];
    const session = Session.create(tempDir("fast-command-"), { persist: false });
    const app: any = { customCommands: [], print() {}, renderLive() {}, model: { provider: "codex", id: "model", supportsFastMode: true } as ModelInfo, session, cwd: session.meta.cwd, settings: { effort: "high" }, busy: false, notice: (s: string) => notices.push(s) };
    await runCommand(app, "/fast on");
    expect(session.fastMode).toBe(true);
    expect(app.settings.effort).toBe("high");
    await runCommand(app, "/fast status");
    expect(notices.at(-1)).toBe("Fast mode on");
    app.busy = true;
    await runCommand(app, "/fast off");
    expect(session.fastMode).toBe(true);
    app.busy = false;
    await runCommand(app, "/fast");
    expect(session.fastMode).toBe(false);
    app.model.supportsFastMode = false;
    await runCommand(app, "/fast on");
    expect(session.fastMode).toBe(false);
    expect(notices.at(-1)).toContain("not available");
});
