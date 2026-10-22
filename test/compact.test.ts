import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";
import type { AgentEvent } from "../src/agent/agent";
import type { AssistantMessage, ChatRequest, Message, Usage } from "../src/providers/types";

const iso = isolate();
const { compactTranscriptText, handoffTranscript } = await import("../src/agent/compact");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { ProviderError } = await import("../src/providers/types");
const { TodoWriteTool } = await import("../src/tools/meta-tools");
const { toAnthropicMessages } = await import("../src/providers/anthropic");
const { toOpenAIMessages } = await import("../src/providers/openai-compat");
const { toResponsesInput } = await import("../src/providers/openai-responses");
const { getProvider } = await import("../src/providers/registry");
afterAll(() => iso.cleanup());

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" });

function handoff(messages: Message[]): string {
    return (Agent.prototype as any).backendPrompt.call({ session: { messages } }, "continue", messages.length);
}

test("handoff keeps all eleven findings, without per-message clipping", () => {
    const findings = Array.from({ length: 11 }, (_, i) => `Finding ${i + 1}: ${"x".repeat(700)}`).join("\n");
    const messages = [user("Review this"), assistant("Ready"), user(findings)];
    expect(handoffTranscript(messages, 60_000).text).toContain(findings);
    expect(handoff(messages)).toContain(findings);
});

test("handoff budgets user instructions before assistant text and tool output", () => {
    const instruction = "Keep these requirements: " + "x".repeat(9000);
    const messages = [user(instruction), assistant("old " + "a".repeat(40_000)), { role: "user", content: [{ type: "tool_result", toolCallId: "r", toolName: "Read", content: "log " + "z".repeat(40_000) }] } as Message, assistant("newest answer")];
    const text = handoffTranscript(messages, 12_000).text;
    expect(text).toContain(instruction);
    expect(text).toContain("newest answer");
    expect(text.length).toBeLessThanOrEqual(12_000);
});

test("an oversized paste keeps its head and tail and discloses shortening", () => {
    const messages = [user("HEAD " + "x".repeat(90_000) + " TAIL")];
    const text = handoffTranscript(messages, 60_000).text;
    expect(text).toContain("HEAD");
    expect(text).toContain("TAIL");
    expect(text).toMatch(/characters \/ ~\d+ lines omitted/);
    expect(text.length).toBeLessThanOrEqual(60_000);
    expect(handoff(messages)).toMatch(/shortened[\s\S]*\d+ characters/);
});

test("small budgets never overflow, including truncation markers and separators", () => {
    for (const budget of [0, 1, 40, 100, 200, 1000]) {
        expect(handoffTranscript([user("x".repeat(2000)), assistant("y".repeat(2000))], budget).text.length).toBeLessThanOrEqual(budget);
    }
});

test("queued user instructions survive a large tool result in the same message", () => {
    const instruction = "REQUIREMENTS " + "x".repeat(40_000);
    const messages: Message[] = [{ role: "user", content: [{ type: "tool_result", toolCallId: "r", toolName: "Read", content: "z".repeat(80_000) }, { type: "text", text: instruction }] }];
    const text = handoffTranscript(messages, 60_000).text;
    expect(text.includes(instruction)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(60_000);
});

test("the initial task is kept before newer user messages", () => {
    const old = "OLD " + "x".repeat(800);
    const latest = "LATEST " + "y".repeat(800);
    const text = handoffTranscript([user(old), assistant("answer"), user(latest)], 1000).text;
    expect(text).toContain(old);
    expect(text).not.toContain(latest);
    expect(text.length).toBeLessThanOrEqual(1000);
});

test("shortening counts the characters actually removed, excluding the marker", () => {
    const result = handoffTranscript([user("HEAD " + "x".repeat(2000) + " TAIL")], 1000);
    const marker = result.text.match(/… \[(\d+) characters \/ ~\d+ lines omitted\] …/)!;
    expect(result.shortenedChars).toBe(Number(marker[1]));
});

test("compaction retains its original first-message and condensed-text policy", () => {
    const messages = [user("FIRST REQUEST"), ...Array.from({ length: 50 }, (_, i) => assistant(`step ${i} ` + "y".repeat(200)))];
    const text = compactTranscriptText(messages, 3000);
    expect(text.startsWith("User: FIRST REQUEST")).toBe(true);
    expect(text).toContain("step 49");
    expect(text).not.toContain("step 0 ");
    expect(text).toContain("earlier messages omitted");
    expect(compactTranscriptText([user("x".repeat(6000))], 60_000)).toContain("2000 characters");
});

test("after the initial task, newer user messages get the remaining budget first", () => {
    const initial = "INITIAL TASK";
    const older = "OLDER " + "x".repeat(800);
    const latest = "LATEST " + "y".repeat(800);
    const result = handoffTranscript([user(initial), user(older), user(latest)], 1000);
    expect(result.text).toContain(initial);
    expect(result.text).toContain(latest);
    // The older one is cut to what's left.
    expect(result.text.length).toBeLessThanOrEqual(1000);
    expect(result.text).toContain("OLDER x");
    expect(result.text).not.toContain(older);
    expect(result.shortenedChars).toBe(800 - (result.text.match(/x/g) ?? []).length);
});

test("assistant and tool parts keep their caps and count only original characters", () => {
    const input = { log: "x".repeat(2000) };
    const messages: Message[] = [user("TASK"), assistant("a".repeat(8000)), { role: "assistant", content: [{ type: "tool_call", id: "r", name: "Read", input }], stopReason: "tool_use" }, { role: "user", content: [{ type: "tool_result", toolCallId: "r", toolName: "Read", content: "z".repeat(5000) }] }];
    const result = handoffTranscript(messages, 60_000);
    expect(result.shortenedChars).toBe(8000 - 4000 + JSON.stringify(input).length - 600 + 5000 - 1500);
    expect(result.text.length).toBeLessThan(7000);
    const dropped = handoffTranscript(messages, 10);
    expect(dropped.text).toBe("User: TASK");
    expect(dropped.shortenedChars).toBe("Assistant: ".length + 8000 + "Assistant: [called Read: ]".length + JSON.stringify(input).length + "[result of Read: ]".length + 5000);
});

test("a handoff still discloses history when every block was left out", () => {
    const messages: Message[] = [{ role: "assistant", content: Array.from({ length: 20 }, () => ({ type: "text", text: "x".repeat(8000) })), stopReason: "end_turn" }];
    expect(handoffTranscript(messages, 60_000).text).toBe("");
    expect(handoff(messages)).toContain("Parts of it were shortened or left out");
});

test("a handoff frames attached files, and drops a whole file rather than cut a message through its frame", () => {
    const file = (name: string, text: string) => ({ type: "file" as const, kind: "text" as const, name, size: text.length, lines: 1, text });
    const msg: Message = { role: "user", content: [{ type: "text", text: "Read these." }, file("a.txt", "a".repeat(3000)), file("b.txt", "b".repeat(3000))] };
    const whole = handoffTranscript([msg], 60_000);
    expect(whole.text).toMatch(/<attached-file name="a\.txt" boundary="[0-9a-f]{16}">\na{3000}\n<\/attached-file boundary="[0-9a-f]{16}">/);
    expect(whole.shortenedChars).toBe(0);
    const tight = handoffTranscript([msg], 5000);
    expect(tight.text.length).toBeLessThanOrEqual(5000);
    expect(tight.text).toContain("Read these.");
    expect(tight.text).toContain("an attached file left out here, too long to include: b.txt");
    expect(tight.text).not.toContain("characters / ~");
    // Exactly what b's entry was: the note of it isn't counted as kept.
    const note = "\n[an attached file left out here, too long to include: b.txt]";
    expect(tight.shortenedChars).toBe(whole.text.length - (tight.text.length - note.length));
});

test("a long paste (sent as a file part) is the user's own words: a handoff keeps it whole, and counts only what it cut", () => {
    const findings = Array.from({ length: 11 }, (_, i) => `Finding ${i + 1}: ` + "x".repeat(700)).join("\n");
    const paste: Message = { role: "user", content: [{ type: "text", text: "Fix these." }, { type: "file", kind: "text", name: "Pasted text", size: findings.length, lines: 11, text: findings, pasted: true }] };
    const whole = handoffTranscript([user("first"), assistant("ok"), paste], 60_000);
    for (let n = 1; n <= 11; n++) expect(whole.text).toContain(`Finding ${n}:`);
    expect(whole.shortenedChars).toBe(0);
    // An attached file (not a paste) is cut to 4000 inside its frame: what's counted is what it lost, not the marker.
    const attached: Message = { role: "user", content: [{ type: "file", kind: "text", name: "notes.txt", size: findings.length, lines: 11, text: findings }] };
    expect(handoffTranscript([attached], 60_000).shortenedChars).toBe(findings.length - 4000);
});

test("a paste bigger than the whole budget keeps its head and tail inside its frame, and the count is only what was cut", () => {
    const text = "HEAD " + "x".repeat(90_000) + " TAIL";
    const paste: Message = { role: "user", content: [{ type: "file", kind: "text", name: "Pasted text", size: text.length, lines: 1, text, pasted: true }] };
    const r = handoffTranscript([paste], 60_000);
    expect(r.text.length).toBeLessThanOrEqual(60_000);
    expect(r.text).toContain("HEAD ");
    expect(r.text).toContain(" TAIL");
    expect(r.text).toMatch(/<pasted-text boundary="[0-9a-f]+">\nHEAD [\s\S]*characters \/ ~[\s\S]* TAIL\n<\/pasted-text boundary="[0-9a-f]+">$/);
    const body = r.text.slice(r.text.indexOf("\nHEAD "), r.text.lastIndexOf(" TAIL\n"));
    const kept = (body.match(/x/g) ?? []).length + "HEAD  TAIL".length;
    expect(r.shortenedChars).toBe(text.length - kept);
});

test("a later message too big for what's left is cut to it, keeping its head and tail, not left out", () => {
    for (const later of [user("HEAD " + "x".repeat(90_000) + " TAIL"), { role: "user" as const, content: [{ type: "file" as const, kind: "text" as const, name: "Pasted text", size: 90_010, lines: 1, text: "HEAD " + "x".repeat(90_000) + " TAIL", pasted: true }] }]) {
        const r = handoffTranscript([user("Original task"), assistant("ok"), later], 60_000);
        expect(r.text.length).toBeLessThanOrEqual(60_000);
        expect(r.text).toContain("Original task");
        expect(r.text).toContain("HEAD ");
        expect(r.text).toContain(" TAIL");
    }
});

function contextAgent(script: (req: ChatRequest, n: number) => AssistantMessage | Promise<AssistantMessage>) {
    const cwd = realpathSync(tempDir());
    const session = Session.create(cwd, { system: "SYSTEM" });
    // Context exhaustion is meaningful with enough history for a summary to shrink it.
    session.push(user("earlier task " + "x".repeat(4000)));
    session.push(assistant("earlier answer"));
    const settings = { autoCompact: false, delegation: false };
    const requests: ChatRequest[] = [];
    const events: any[] = [];
    const agent = new Agent({
        session,
        model: { provider: "test", id: "test" },
        client: { stream: async (req) => { requests.push(structuredClone({ ...req, signal: undefined })); return script(req, requests.length); }, listModels: async () => [] },
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: [],
        mode: { get: () => "bypassPermissions", set() {} },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        host: { emit: (e) => events.push(e), ui: {} },
    });
    const run = (signal = new AbortController().signal) => agent.run([{ type: "text", text: "finish the task" }], { signal });
    return { agent, session, requests, events, run };
}
const contextReply = (text: string, stopReason: AssistantMessage["stopReason"] = "end_turn"): AssistantMessage => ({ role: "assistant", provider: "test", model: "test", content: [{ type: "text", text }], stopReason });

test("context exhaustion compacts once even with autoCompact off, retaining partial text and usage", async () => {
    const a = contextAgent((_req, n) => n === 1
        ? { ...contextReply("partial answer", "context_window_exceeded"), usage: { inputTokens: 100, outputTokens: 12 } }
        : contextReply(n === 2 ? "summary of the task and partial answer" : "finished"));
    try {
        expect(await a.run()).toBe("done");
        expect(a.requests).toHaveLength(3);
        expect(a.requests[1]!.messages).toContainEqual(expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "partial answer" }] }));
        expect(a.requests[2]!.messages).toContainEqual(expect.objectContaining({ role: "user", meta: expect.objectContaining({ kind: "summary" }) }));
        expect(a.events.filter((e) => e.type === "compact_start")).toHaveLength(1);
        expect(a.events.some((e) => e.type === "usage" && e.usage.outputTokens === 12)).toBe(true);
        expect(JSON.stringify(a.requests)).not.toContain("output token limit");
    } finally { a.session.release(); }
});

test("context exhaustion never executes its tool calls and closes them before compacting", async () => {
    const a = contextAgent((_req, n) => n === 1
        ? { ...contextReply("partial", "context_window_exceeded"), content: [{ type: "tool_call", id: "cut", name: "Write", input: { path: "partial" } }] }
        : contextReply(n === 2 ? "summary" : "finished"));
    try {
        expect(await a.run()).toBe("done");
        expect(a.events.some((e) => e.type === "tool_start")).toBe(false);
        const results = a.requests[1]!.messages.flatMap((m) => m.content).filter((p) => p.type === "tool_result");
        expect(results).toEqual([expect.objectContaining({ toolCallId: "cut", isError: true, content: expect.stringContaining("context window") })]);
        expect(JSON.stringify(a.requests)).not.toContain("smaller pieces");
    } finally { a.session.release(); }
});

test("repeated context exhaustion ends with context guidance instead of output retries", async () => {
    const a = contextAgent((_req, n) => contextReply(n % 2 === 0 ? "summary" : "partial " + "x".repeat(1000), n % 2 === 0 ? "end_turn" : "context_window_exceeded"));
    try {
        expect(await a.run()).toBe("error");
        expect(a.requests).toHaveLength(5);
        expect(a.events.filter((e) => e.type === "compact_start")).toHaveLength(2);
        expect(a.session.notices.at(-1)?.text).toContain("context window");
        expect(JSON.stringify(a.events)).not.toContain("output token limit");
    } finally { a.session.release(); }
});

test("failed context compaction ends with context guidance and keeps the partial answer", async () => {
    const a = contextAgent((_req, n) => { if (n === 2) throw new Error("summary unavailable"); return contextReply("partial", "context_window_exceeded"); });
    try {
        expect(await a.run()).toBe("error");
        expect(a.requests).toHaveLength(2);
        expect(a.session.messages).toContainEqual(expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "partial" }] }));
        expect(a.session.notices.at(-1)?.text).toContain("context window");
    } finally { a.session.release(); }
});

test("abort during context compaction does not retry or replace the transcript", async () => {
    const controller = new AbortController();
    const a = contextAgent((_req, n) => {
        if (n === 2) controller.abort();
        return contextReply(n === 2 ? "discard this summary" : "partial", n === 2 ? "end_turn" : "context_window_exceeded");
    });
    try {
        expect(await a.run(controller.signal)).toBe("aborted");
        expect(a.requests).toHaveLength(2);
        expect(a.events.some((e) => e.type === "compact_end")).toBe(false);
        expect(a.session.messages.some((m) => m.role === "user" && m.meta?.kind === "summary")).toBe(false);
    } finally { a.session.release(); }
});

test("a context-limited compaction summary uses the condensed fallback", async () => {
    const a = contextAgent((_req, n) => contextReply(n < 3 ? "incomplete" : n === 3 ? "complete summary" : "finished", n < 3 ? "context_window_exceeded" : "end_turn"));
    try {
        expect(await a.run()).toBe("done");
        expect(a.requests).toHaveLength(4);
        expect(a.requests[2]!.tools).toEqual([]);
        expect(JSON.stringify(a.requests[3]!.messages)).toContain("complete summary");
        expect(JSON.stringify(a.requests[3]!.messages)).not.toContain("incomplete");
    } finally { a.session.release(); }
});

test("a context-limited fallback summary fails without replacing history", async () => {
    const a = contextAgent(() => contextReply("incomplete", "context_window_exceeded"));
    try {
        expect(await a.run()).toBe("error");
        expect(a.requests).toHaveLength(3);
        expect(a.events.some((e) => e.type === "compact_end")).toBe(false);
        expect(a.session.messages.some((m) => m.role === "user" && m.meta?.kind === "summary")).toBe(false);
    } finally { a.session.release(); }
});

// The agent's own compaction (API providers), against a scripted fake client.
describe("the agent loop's compaction", () => {
    type Script = (req: ChatRequest, n: number) => AssistantMessage;
    const MODEL = { provider: "anthropic", id: "claude-x", contextWindow: 200_000, maxOutput: 32_000, pricing: { input: 3, output: 15 } };

    function setup(script: Script, o: { model?: Record<string, unknown>; subagent?: boolean; settings?: Record<string, unknown> } = {}) {
        const proj = tempDir("compact-agent-");
        const session = Session.create(proj, { system: "sys" });
        const settings = { ...o.settings } as any;
        const events: AgentEvent[] = [];
        const requests: ChatRequest[] = [];
        const agent = new Agent({
            session,
            model: (o.model ?? MODEL) as any,
            client: {
                async stream(req: ChatRequest) {
                    requests.push({ ...req, messages: structuredClone(req.messages) });
                    return script(req, requests.length);
                },
                async listModels() {
                    return [];
                },
            } as any,
            settings: () => settings,
            checker: new PermissionChecker(() => settings, proj),
            tools: [TodoWriteTool],
            mode: { get: () => "bypassPermissions", set: () => {} },
            toolState: { cwd: proj, projectRoot: proj, fileState: new Map(), todos: [], shells: new Map() } as any,
            isSubagent: o.subagent,
            host: { emit: (e: AgentEvent) => void events.push(e), ui: {} } as any,
        });
        const run = (content: any[], signal = new AbortController().signal) => agent.run(content, { signal, display: "p" });
        const compactions = () => events.filter((e) => e.type === "compact_start").length;
        return { agent, session, events, requests, run, compactions };
    }

    const usage = (inputTokens: number, outputTokens = 10): Usage => ({ inputTokens, outputTokens });
    const say = (text: string, u = usage(100)): AssistantMessage => ({ role: "assistant", content: text ? [{ type: "text", text }] : [], provider: "anthropic", model: "claude-x", stopReason: "end_turn", usage: u });
    const todo = (id: string, u = usage(100)): AssistantMessage => ({ role: "assistant", content: [{ type: "tool_call", id, name: "TodoWrite", input: { todos: [{ content: id, status: "pending", activeForm: id }] } }], provider: "anthropic", model: "claude-x", stopReason: "tool_use", usage: u });
    const isSummary = (req: ChatRequest) => JSON.stringify(req.messages.at(-1)).includes("write a detailed summary");
    const twoMessages = (session: InstanceType<typeof Session>) => {
        session.push({ role: "user", content: [{ type: "text", text: "hello" }] });
        session.push(say("hi"));
    };

    test("a compaction request is retried after a transient error, as the provider's retry-after says", async () => {
        const { agent, session, requests, events } = setup((_req, n) => {
            if (n === 1) throw new ProviderError("Anthropic API is overloaded", 529, true, 1);
            return say("SUMMARY");
        });
        twoMessages(session);
        expect(await agent.compact({ auto: false, signal: new AbortController().signal })).toBe(true);
        expect(requests.length).toBe(2);
        expect(events.filter((e) => e.type === "retry")).toMatchObject([{ attempt: 1, delayMs: 1 }]);
        expect(session.summary).toBe("SUMMARY");
    });

    test("the fallback (transcript) compaction request is retried too", async () => {
        const { agent, session, requests } = setup((_req, n) => {
            // The first summary answers with tool calls only: the transcript fallback runs.
            if (n === 1) return todo("t1");
            if (n === 2) throw new ProviderError("rate limited", 429, true, 1);
            return say("SUMMARY");
        });
        twoMessages(session);
        expect(await agent.compact({ auto: false, signal: new AbortController().signal })).toBe(true);
        expect(requests.length).toBe(3);
        expect(requests[2]!.tools).toEqual([]);
    });

    test("a compaction stops retrying when it's interrupted", async () => {
        const ctrl = new AbortController();
        const { agent, session, requests } = setup(() => {
            setTimeout(() => ctrl.abort(), 10);
            throw new ProviderError("Anthropic API is overloaded", 529, true, 60_000);
        });
        twoMessages(session);
        const started = Date.now();
        await expect(agent.compact({ auto: false, signal: ctrl.signal })).rejects.toThrow("aborted");
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(requests.length).toBe(1);
        expect(session.messages.length).toBe(2);
    });

    test("both summary requests' spend is recorded: the first, and the transcript fallback's", async () => {
        const { agent, session } = setup((_req, n) => {
            // The summary request answers with a tool call only: the transcript fallback runs.
            if (n === 1) return todo("t1", usage(1000, 100));
            return say("SUMMARY", usage(2000, 500));
        });
        twoMessages(session);
        const before = session.cost;
        expect(await agent.compact({ auto: false, signal: new AbortController().signal })).toBe(true);
        // (1000 * 3 + 100 * 15) / 1e6, then (2000 * 3 + 500 * 15) / 1e6.
        expect(session.cost - before).toBeCloseTo(0.0045 + 0.0135, 9);
        expect(session.usageByModel.get("anthropic:claude-x")?.usage).toMatchObject({ inputTokens: 3000, outputTokens: 600 });
    });

    test("a small window whose model can write about all of it keeps a sane input budget, and asks for what output fits", async () => {
        const SMALL = { provider: "openrouter", id: "some/32k-model", contextWindow: 32_768, maxOutput: 32_768 };
        let i = 0;
        const { run, requests, compactions } = setup(
            (req) => {
                if (isSummary(req)) return say("SUMMARY", usage(3000, 50));
                return ++i <= 6 ? todo(`c${i}`, usage(3000, 50)) : say("done", usage(3000, 50));
            },
            { model: SMALL },
        );
        // About 3K tokens in context, for seven requests: before, the threshold was about 700 tokens and this compacted three times.
        expect(await run([{ type: "text", text: "go" }])).toBe("done");
        expect(compactions()).toBe(0);
        expect(requests.length).toBe(7);
        // Each request asks for no more output than fits beside its context, and for more than the reserve (a quarter of the window) here.
        for (const r of requests.slice(1)) {
            expect(r.maxTokens).toBeGreaterThan(8192);
            expect(r.maxTokens! + 3000).toBeLessThan(32_768);
        }

        // Past the threshold, (32768 - 8192) * 0.92 ≈ 22.6K, it compacts; until then, the output asked for shrinks, to no less than the reserve.
        let j = 0;
        const big = setup(
            (req) => {
                if (isSummary(req)) return say("SUMMARY", usage(1000, 50));
                j++;
                return j <= 4 ? todo(`c${j}`, usage(8000 * j, 50)) : say("done", usage(1000, 50));
            },
            { model: SMALL },
        );
        expect(await big.run([{ type: "text", text: "go" }])).toBe("done");
        expect(big.compactions()).toBe(1);
        const turns = big.requests.filter((r) => !isSummary(r));
        const asked = turns.map((r) => r.maxTokens!);
        for (const n of asked) expect(n).toBeGreaterThanOrEqual(8192);
        // 8K, then 16K tokens in context: what fits shrinks with it.
        expect(asked[1]!).toBeLessThan(asked[0]!);
        expect(asked[1]! + 8000).toBeLessThan(32_768);
        expect(asked[2]!).toBeLessThan(asked[1]!);
        expect(asked[2]! + 16_000).toBeLessThan(32_768);
        // After the compaction, room again; a context that leaves less than the reserve still gets the reserve.
        expect(asked[3]!).toBeGreaterThan(asked[2]!);
        expect(asked.at(-1)).toBe(8192);
        // The summary request leaves the history room too.
        expect(big.requests.find(isSummary)!.maxTokens).toBe(8192);
    });

    test("a large window's requests ask for the output as set", async () => {
        const { run, requests } = setup(() => say("done"));
        expect(await run([{ type: "text", text: "go" }])).toBe("done");
        expect(requests[0]!.maxTokens).toBeUndefined();
        const set = setup(() => say("done"), { settings: { maxOutputTokens: 20_000 } });
        expect(await set.run([{ type: "text", text: "go" }])).toBe("done");
        expect(set.requests[0]!.maxTokens).toBe(20_000);
    });

    test("auto-compacting at the start of a turn keeps the new prompt, with its image, after the summary", async () => {
        const { run, requests, session, events } = setup((req, n) => {
            if (n === 1) return say("first answer", usage(160_000));
            if (isSummary(req)) return say("SUMMARY: earlier work");
            return say("final");
        });
        await run([{ type: "text", text: "start" }]);
        session.push({ role: "user", content: [{ type: "text", text: "more" }] });
        session.push(say("ok"));
        const img = { type: "image" as const, mediaType: "image/png", data: "iVBORw0KGgo=" };
        // 160K tokens in context, over (200K - 32K) * 0.92: this turn compacts before its first request.
        expect(await run([{ type: "text", text: "What is wrong in this screenshot?" }, img])).toBe("done");
        expect(events.filter((e) => e.type === "compact_start").length).toBe(1);
        // The summary covers what came before; the prompt isn't in it.
        const summaryReq = requests.find(isSummary)!;
        expect(JSON.stringify(summaryReq.messages)).not.toContain("What is wrong in this screenshot?");
        // The answer's request: the summary, then the prompt as sent.
        const answer = requests.at(-1)!;
        expect(answer.messages.length).toBe(2);
        expect(answer.messages[0]!.meta?.kind).toBe("summary");
        const summaryText = (answer.messages[0]!.content[0] as { text: string }).text;
        expect(summaryText).toContain("SUMMARY: earlier work");
        // Not told to carry on regardless: the prompt says what's next.
        expect(summaryText).not.toContain("without asking the user any further questions");
        expect(answer.messages[1]).toMatchObject({ role: "user", meta: { kind: "prompt" }, content: [{ type: "text", text: "What is wrong in this screenshot?" }, img] });
        expect(session.messages.map((m) => m.meta?.kind ?? m.role)).toEqual(["summary", "prompt", "assistant"]);

        // On the wire: Anthropic gets one user turn (the two merged), then alternation; OpenAI's formats keep the image.
        const sent = answer.messages;
        expect(toAnthropicMessages([...sent, say("final")]).map((m) => m.role)).toEqual(["user", "assistant"]);
        expect(JSON.stringify(toAnthropicMessages(sent))).toContain('"type":"image"');
        expect(JSON.stringify(toOpenAIMessages("sys", sent, getProvider("openai")!))).toContain("image_url");
        expect(JSON.stringify(toResponsesInput(sent, getProvider("openai")!, "gpt-x"))).toContain("input_image");
        // Chat Completions too: one user message (strict templates refuse two in a row), the summary, the prompt, then its image.
        const chat = toOpenAIMessages("sys", [...sent, say("final")], getProvider("mistral")!);
        expect(chat.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
        expect(chat[1]!.content.map((p: { type: string; text?: string }) => p.type === "text" ? p.text!.slice(0, 20) : p.type)).toEqual([summaryText.slice(0, 20), "What is wrong in thi", "image_url"]);

        // The move is on record (the GUI shows the prompt once, where it went), and said when it happens.
        expect(events.find((e) => e.type === "compact_end")).toMatchObject({ kept: true });
        const record = readFileSync(session.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.t === "compact");
        expect(record).toMatchObject({ t: "compact", kept: true });
    });

    test("consecutive text-only user messages go to Chat Completions as one, in order", () => {
        const chat = toOpenAIMessages("", [user("[Request interrupted by user]"), user("try again"), assistant("ok"), user("next")], getProvider("openai")!);
        expect(chat).toEqual([
            { role: "user", content: "[Request interrupted by user]\n\ntry again" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "next" },
        ]);
    });

    test("compaction folds a continuation link into its summary instead of keeping it as an unanswered prompt", async () => {
        const { agent, session, requests, events } = setup((req) => isSummary(req) ? say("SUMMARY") : say("done"));
        session.push({ ...user("original task"), meta: { kind: "prompt" } });
        session.push({ ...say("partial answer"), stopReason: "max_tokens" });
        session.push({ ...user("Continue exactly where you stopped."), meta: { kind: "continuation" } });

        expect(await agent.compact({ auto: true, signal: new AbortController().signal, continuing: true, keepLast: true })).toBe(true);
        expect(JSON.stringify(requests[0]!.messages)).toContain("Continue exactly where you stopped.");
        expect(session.messages.map((m) => m.meta?.kind)).toEqual(["summary"]);
        expect(events.find((e) => e.type === "compact_end")).not.toHaveProperty("kept");
    });

    test("Chat Completions merges a kept prompt with its summary without merging a continuation across the assistant", () => {
        const messages: Message[] = [
            { ...user("summary"), meta: { kind: "summary" } },
            { ...user("task"), meta: { kind: "prompt" } },
            { ...assistant("answer head"), stopReason: "max_tokens" },
            { ...user("Continue exactly where you stopped."), meta: { kind: "continuation" } },
        ];
        expect(toOpenAIMessages("", messages, getProvider("openai")!)).toEqual([
            { role: "user", content: "summary\n\ntask" },
            { role: "assistant", content: "answer head" },
            { role: "user", content: "Continue exactly where you stopped." },
        ]);
    });

    test("a mid-turn compaction (after tool results) summarizes everything, and the work carries on", async () => {
        let i = 0;
        const { run, requests, session } = setup((req) => {
            if (isSummary(req)) return say("SUMMARY");
            return ++i === 1 ? todo("c1", usage(160_000)) : say("done");
        });
        session.push({ role: "user", content: [{ type: "text", text: "a" }] });
        session.push(say("b"));
        session.push({ role: "user", content: [{ type: "text", text: "c" }] });
        session.push(say("d"));
        expect(await run([{ type: "text", text: "go" }])).toBe("done");
        const answer = requests.at(-1)!;
        expect(answer.messages.length).toBe(1);
        expect((answer.messages[0]!.content[0] as { text: string }).text).toContain("without asking the user any further questions");
    });

    test("/compact summarizes everything, a prompt left unanswered too", async () => {
        const { agent, session, requests } = setup(() => say("SUMMARY"));
        twoMessages(session);
        session.push({ role: "user", content: [{ type: "text", text: "interrupted prompt" }], meta: { kind: "prompt" } });
        expect(await agent.compact({ auto: false, signal: new AbortController().signal })).toBe(true);
        expect(JSON.stringify(requests[0]!.messages)).toContain("interrupted prompt");
        expect(session.messages.length).toBe(1);
    });

    const overflow = () => new ProviderError("prompt is too long: 210000 tokens > 200000 maximum", 400, false);

    test("a sub-agent compacts ahead of the window, by the same threshold, as often as it fills it", async () => {
        let rounds = 0;
        const { run, compactions, events } = setup(
            (req) => {
                if (isSummary(req)) return say("SUMMARY", usage(1000, 50));
                // Each tool round adds 60K tokens; over the window, the provider refuses.
                const since = req.messages.filter((m) => m.role === "assistant").length;
                if (since >= 4) throw overflow();
                return ++rounds <= 10 ? todo(`c${rounds}`, usage(60_000 * (since + 1), 50)) : say("done");
            },
            { subagent: true },
        );
        expect(await run([{ type: "text", text: "long task" }])).toBe("done");
        expect(compactions()).toBeGreaterThanOrEqual(3);
        // Never had to wait for the provider to refuse.
        expect(events.filter((e) => e.type === "notice" && /exceeded the model's context window/.test(e.message))).toEqual([]);
    });

    test("an overflow compacts again whenever the last compaction shrank the history (here, a model with no known window)", async () => {
        let rounds = 0;
        const { run, compactions, requests } = setup(
            (req) => {
                if (isSummary(req)) return say("SUMMARY", usage(1000, 50));
                if (req.messages.length > 6) throw overflow();
                return ++rounds <= 8 ? todo(`c${rounds}`) : say("done");
            },
            { model: { provider: "anthropic", id: "claude-x" }, subagent: true },
        );
        expect(await run([{ type: "text", text: "long task" }])).toBe("done");
        expect(compactions()).toBeGreaterThanOrEqual(2);
        expect(requests.filter((r) => !isSummary(r) && r.messages.length > 6).length).toBe(compactions());
    });

    test("a prompt kept after a summary that still overflows is folded in by a second compaction", async () => {
        const { run, session, requests, compactions } = setup((req) => {
            if (isSummary(req)) return say("SUMMARY", usage(1000, 50));
            if (req.messages.some((m) => m.meta?.kind === "prompt" && JSON.stringify(m.content).includes("HUGE"))) throw overflow();
            return say("done");
        });
        session.push({ role: "user", content: [{ type: "text", text: "a" }] });
        session.push(say("b"));
        session.push({ role: "user", content: [{ type: "text", text: "c" }] });
        session.push(say("d"));
        expect(await run([{ type: "text", text: "HUGE " + "x".repeat(5000) }])).toBe("done");
        expect(compactions()).toBe(2);
        // The first kept the prompt; the second summarized it.
        const [first, second] = requests.filter(isSummary);
        expect(JSON.stringify(first!.messages)).not.toContain("HUGE");
        expect(JSON.stringify(second!.messages)).toContain("HUGE");
        expect(requests.at(-1)!.messages.length).toBe(1);
        expect(session.messages.map((m) => m.meta?.kind ?? m.role)).toEqual(["summary", "assistant"]);
    });

    test("a compaction that didn't shrink the history doesn't stop the next one, once the model has answered since", async () => {
        let main = 0;
        let summaries = 0;
        const { run, session, compactions } = setup((req) => {
            // The first summary is longer than the little it summarized; the second is short.
            if (isSummary(req)) return say(++summaries === 1 ? "SUMMARY " + "s".repeat(4000) : "S");
            switch (++main) {
                case 1:
                    return todo("c1", usage(190_000));
                case 2:
                    return todo("c2");
                case 3:
                    throw overflow();
                default:
                    return say("done");
            }
        });
        session.push({ role: "user", content: [{ type: "text", text: "a" }] });
        session.push(say("b"));
        session.push({ role: "user", content: [{ type: "text", text: "c" }] });
        session.push(say("d"));
        expect(await run([{ type: "text", text: "go" }])).toBe("done");
        expect(compactions()).toBe(2);
        expect(session.summary).toBe("S");
    });

    test("a request that overflows however much is compacted stops after two compactions, not in a loop", async () => {
        const { run, session, requests, compactions } = setup(
            (req) => {
                if (isSummary(req)) return say("SUMMARY");
                throw overflow();
            },
            { model: { provider: "anthropic", id: "claude-x" } },
        );
        session.push({ role: "user", content: [{ type: "text", text: "a" }] });
        session.push(say("b"));
        session.push({ role: "user", content: [{ type: "text", text: "c" }] });
        session.push(say("d"));
        expect(await run([{ type: "text", text: "go" }])).toBe("error");
        expect(compactions()).toBeLessThanOrEqual(2);
        expect(requests.length).toBeLessThanOrEqual(5);
    });

    test("an error that isn't transient isn't retried", async () => {
        const { agent, session, requests } = setup(() => {
            throw new ProviderError("invalid x-api-key", 401, false);
        });
        twoMessages(session);
        await expect(agent.compact({ auto: false, signal: new AbortController().signal })).rejects.toThrow("invalid x-api-key");
        expect(requests.length).toBe(1);
    });
});
