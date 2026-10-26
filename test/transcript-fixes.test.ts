// Fixes for problems seen in real session transcripts: turns that failed
// leaving nothing on disk, requests that never answered, mode and model
// notes that piled up, unknown prices saved as free, and the like.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { cleanup } = isolate();
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { ProviderError } = await import("../src/providers/types");
const { stall, stallError } = await import("../src/providers/sse");
const { OpenAICompatProvider, httpError } = await import("../src/providers/openai-compat");
const { readSegments, replay, UiLog } = await import("../src/server/history");
const { formatCost } = await import("../src/providers/pricing");
const { AnthropicProvider } = await import("../src/providers/anthropic");
const { OpenAIResponsesProvider } = await import("../src/providers/openai-responses");
const { BUILTIN_PROVIDERS } = await import("../src/providers/registry");
import type { ChatRequest, StreamEvent } from "../src/providers/types";

afterAll(cleanup);

const reply = (content: any[], stopReason = "end_turn") => ({ role: "assistant", provider: "test", model: "test", stopReason, content }) as any;
const text = (t: string) => reply([{ type: "text", text: t }]);

/** An agent on a scripted model, with a session saved to disk. */
function scripted(script: (req: ChatRequest, n: number, onEvent: (e: StreamEvent) => void) => any, o: { session?: any; mode?: string; model?: any; emit?: (e: any) => void } = {}) {
    const cwd = realpathSync(tempDir());
    const session = o.session ?? Session.create(cwd, { system: "SYSTEM" });
    const events: any[] = [];
    const requests: ChatRequest[] = [];
    const settings = { autoCompact: false } as any;
    let n = 0;
    let mode = o.mode ?? "default";
    const agent = new Agent({
        session,
        model: o.model ?? ({ provider: "test", id: "test", name: "Test Model" } as any),
        client: { stream: async (req: ChatRequest, onEvent: (e: StreamEvent) => void) => (requests.push(structuredClone({ ...req, signal: undefined })), script(req, ++n, onEvent)) } as any,
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: [],
        mode: { get: () => mode as any, set: (m: any) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() } as any,
        host: { emit: (e: any) => { events.push(e); o.emit?.(e); }, ui: {} } as any,
    });
    const run = (prompt: string, signal = new AbortController().signal) => agent.run([{ type: "text", text: prompt }], { signal });
    return { agent, session, events, requests, run, cwd };
}

const fileLines = (file: string) => readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
const reopenTurns = (file: string) => {
    const s = Session.load(file);
    try {
        return replay({ segments: readSegments(file), current: s.messages, currentNotices: s.notices, ui: new UiLog(file, s.meta.id, false), meta: (c) => ({ title: c.name }), newId: (() => { let i = 0; return () => `id${++i}`; })() });
    } finally {
        s.release();
    }
};

describe("a failed turn leaves its reason on disk", () => {
    test("the error is saved, shown when the session is opened again, and never sent to a model", async () => {
        const a = scripted((_req, n) => {
            if (n === 1) throw new ProviderError("Google Gemini: API key not valid (400)", 400, false);
            return text("Hello again.");
        });
        expect(await a.run("hi there")).toBe("error");
        expect(a.events.some((e) => e.type === "notice" && e.level === "error" && /API key not valid/.test(e.message))).toBe(true);
        const notice = fileLines(a.session.path).find((l) => l.t === "notice");
        expect(notice).toMatchObject({ level: "error", text: "Google Gemini: API key not valid (400)", index: 1 });

        // The next prompt: the model gets the prompts, not Cavvy's note about the failure.
        expect(await a.run("try again")).toBe("done");
        const sent = JSON.stringify(a.requests.at(-1)!.messages);
        expect(sent).toContain("try again");
        expect(sent).not.toContain("API key not valid");
        a.session.release();

        // Reopened: the failed turn shows the error and its status; the next one is as it was.
        const turns = reopenTurns(a.session.path);
        expect(turns.map((t) => [t.prompt?.text, t.status, t.blocks.map((b) => (b.t === "notice" ? `${b.level}: ${b.text}` : b.t))])).toEqual([
            ["hi there", "error", ["error: Google Gemini: API key not valid (400)"]],
            ["try again", "done", ["text"]],
        ]);
        const loaded = Session.load(a.session.path);
        expect(loaded.messages.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
        expect(loaded.notices).toHaveLength(1);
        loaded.release();
    });

    test("an empty response ends the turn with a warning instead of nothing", async () => {
        const a = scripted(() => reply([]));
        expect(await a.run("hello")).toBe("done");
        const warn = a.events.find((e) => e.type === "notice" && e.level === "warn");
        expect(warn?.message).toContain("Test Model sent back an empty response");
        expect(a.session.notices.map((n: any) => n.text)).toEqual([warn.message]);
        // A reply with text says nothing extra.
        const b = scripted(() => text("hi"));
        await b.run("hello");
        expect(b.events.some((e) => e.type === "notice")).toBe(false);
        expect(b.session.notices).toEqual([]);
    });

    test("an empty last response after tools isn't flagged: the turn already answered", async () => {
        const a = scripted((_req, n) => (n === 1 ? reply([{ type: "tool_call", id: "c1", name: "Nope", input: {} }], "tool_use") : reply([])));
        await a.run("hello");
        expect(a.requests).toHaveLength(2);
        expect(a.events.some((e) => e.type === "notice")).toBe(false);
    });

    test("old session files load as before; a rewind drops the dropped turns' notices; a compaction drops all", async () => {
        const a = scripted((_req, n) => {
            if (n <= 2) throw new ProviderError(`bad request ${n}`, 400, false);
            return text("ok");
        });
        await a.run("one");
        await a.run("two");
        expect(a.session.notices.map((n: any) => [n.index, n.text])).toEqual([
            [1, "bad request 1"],
            [2, "bad request 2"],
        ]);
        // Back to before "two": its note goes, the first stays.
        a.session.rewind(1);
        expect(a.session.notices.map((n: any) => n.text)).toEqual(["bad request 1"]);
        a.session.release();
        const loaded = Session.load(a.session.path);
        expect(loaded.notices.map((n: any) => n.text)).toEqual(["bad request 1"]);
        expect(readSegments(a.session.path).at(-1)!.notices!.map((n) => n.text)).toEqual(["bad request 1"]);
        loaded.compact("summary", []);
        expect(loaded.notices).toEqual([]);
        loaded.release();
        expect(Session.load(a.session.path).notices).toEqual([]);
    });
});

describe("output token limit continuation", () => {
    test("continues partial text once, without duplicating the transcript or reopened UI", async () => {
        const a = scripted((_req, n) => n === 1 ? reply([{ type: "text", text: "The answer is " }], "max_tokens") : text("forty-two."));
        expect(await a.run("answer")).toBe("done");
        expect(a.requests).toHaveLength(2);
        expect(a.requests[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
        expect(a.requests[1]!.messages.at(-1)).toMatchObject({ role: "user", meta: { kind: "continuation" }, content: [{ type: "text", text: expect.stringContaining("Continue from where you stopped") }] });
        const parts = a.session.messages.filter((m: any) => m.role === "assistant").flatMap((m: any) => m.content.map((p: any) => p.text));
        expect(parts).toEqual(["The answer is ", "forty-two."]);
        expect(a.events.filter((e) => e.type === "assistant").map((e) => e.message.content[0].text)).toEqual(parts);
        expect(a.session.notices).toEqual([]);
        a.session.release();
        const turns = reopenTurns(a.session.path);
        expect(turns).toHaveLength(1);
        expect(turns[0]!.blocks.filter((b) => b.t === "text").map((b) => b.text)).toEqual([parts.join("")]);
    });

    test("streamed continuations appear once in the live UI", async () => {
        const { Engine } = await import("../src/server/engine");
        const engine = new Engine({ listModels: async () => [] });
        try {
            const rt = await engine.createSession(realpathSync(tempDir()));
            await rt.ready;
            rt.session.setTitle("Continuation test");
            const a = scripted((_req, n, onEvent) => {
                const part = n === 1 ? "The answer is " : "forty-two.";
                onEvent({ type: "text", text: part });
                return reply([{ type: "text", text: part }], n === 1 ? "max_tokens" : "end_turn");
            }, { session: rt.session, emit: (e) => (rt as any).onEvent(e) });
            Object.assign(rt, { model: a.agent.model, agent: a.agent });
            await rt.startTurn("answer");
            const turns = rt.snapshot().turns;
            expect(turns).toHaveLength(1);
            expect(turns[0]!.blocks.filter((b) => b.t === "text").map((b) => b.text)).toEqual(["The answer is forty-two."]);
            expect(a.events.filter((e) => e.type === "text").map((e) => e.text)).toEqual(["The answer is ", "forty-two."]);
        } finally {
            await engine.stop();
        }
    });

    test.each(["streamed", "unstreamed", "retry", "whitespace", "multiple text blocks"])("%s continuation stays one Markdown block after thinking, live and reopened", async (mode) => {
        const { Engine } = await import("../src/server/engine");
        const engine = new Engine({ listModels: async () => [] });
        const intro = mode === "multiple text blocks" ? "Introduction.\n\n" : "";
        const head = mode === "whitespace" ? "    " : "Here is the code:\n```ts\nconst ";
        const tail = mode === "whitespace" ? "indented code" : "answer = 42;\n```";
        try {
            const rt = await engine.createSession(realpathSync(tempDir()));
            await rt.ready;
            rt.session.setTitle("Continuation with reasoning");
            const a = scripted((_req, n, onEvent) => {
                if (n > 1) onEvent({ type: "thinking", text: "Continue the code" });
                if (mode === "retry" && n === 2) {
                    onEvent({ type: "text", text: "discard this tail" });
                    throw new ProviderError("temporary", 503, true, 1);
                }
                const part = n === 1 ? head : tail;
                if (n === 1 && intro) {
                    onEvent({ type: "text", text: intro });
                    onEvent({ type: "thinking", text: "Compose the code" });
                }
                if (mode !== "unstreamed") onEvent({ type: "text", text: part });
                return reply([...(n === 1 && intro ? [{ type: "text", text: intro }, { type: "thinking", text: "Compose the code" }] : []), ...(n > 1 ? [{ type: "thinking", text: "Continue the code" }] : []), { type: "text", text: part }], n === 1 ? "max_tokens" : "end_turn");
            }, { session: rt.session, emit: (e) => (rt as any).onEvent(e) });
            Object.assign(rt, { model: a.agent.model, agent: a.agent });
            await rt.startTurn("code");
            const check = (turns: ReturnType<typeof reopenTurns>) => {
                expect(turns).toHaveLength(1);
                const blocks = turns[0]!.blocks;
                expect(blocks.filter((b) => b.t === "text").map((b) => b.text)).toEqual([intro + head + tail]);
                expect(blocks.findLastIndex((b) => b.t === "text")).toBeGreaterThan(blocks.findLastIndex((b) => b.t === "thinking"));
            };
            check(rt.snapshot().turns);
            await engine.stop();
            check(reopenTurns(a.session.path));
        } finally {
            await engine.stop();
        }
    });

    test("auto-compaction waits for a continued answer, keeping its text in requests, results and the GUI", async () => {
        const { Engine } = await import("../src/server/engine");
        const { TurnTally } = await import("../src/sdk/messages");
        const engine = new Engine({ listModels: async () => [] });
        const tally = new TurnTally();
        const head = "PART-ONE: const value = ";
        const tail = "42; PART-TWO.";
        try {
            const rt = await engine.createSession(realpathSync(tempDir()));
            await rt.ready;
            rt.session.setTitle("Continuation at the compaction threshold");
            for (const n of [1, 2]) {
                rt.session.push({ role: "user", content: [{ type: "text", text: `earlier ${n}` }], meta: { kind: "prompt" } });
                rt.session.push(text(`ok ${n}`));
            }
            const a = scripted((_req, n, onEvent) => {
                if (n > 1) onEvent({ type: "thinking", text: "finish the answer" });
                onEvent({ type: "text", text: n === 1 ? head : tail });
                return { ...reply([...(n > 1 ? [{ type: "thinking", text: "finish the answer" }] : []), { type: "text", text: n === 1 ? head : tail }], n === 1 ? "max_tokens" : "end_turn"), usage: { inputTokens: 9000, outputTokens: 1000 } };
            }, { session: rt.session, model: { provider: "test", id: "test", contextWindow: 10_000, maxOutput: 1000 }, emit: (e) => { tally.observe(e); (rt as any).onEvent(e); } });
            const settings = a.agent.options.settings() as any;
            settings.autoCompact = true;
            settings.hooks = { Stop: [{}] };
            let stopped: any;
            (a.agent as any).hooks = async (event: string, input: any) => { if (event === "Stop") stopped = input; };
            Object.assign(rt, { model: a.agent.model, agent: a.agent });
            await rt.startTurn("write the report");
            expect(a.requests).toHaveLength(2);
            expect(a.events.some((e) => e.type === "compact_start")).toBe(false);
            expect(a.requests[1]!.messages.at(-2)).toMatchObject({ role: "assistant", content: [{ type: "text", text: head }] });
            expect(a.requests[1]!.messages.at(-1)).toMatchObject({ role: "user", meta: { kind: "continuation" } });
            expect(tally.result("done", "s", "m").result).toBe(head + tail);
            expect(stopped.last_assistant_message).toBe(head + tail);
            expect((a.agent as any).lastAssistantText()).toBe(head + tail);
            expect(a.events.filter((e) => e.type === "request_start").map((e) => !!e.continuation)).toEqual([false, true]);
            // The guard applies only while continuing, not to the next ordinary request.
            expect((a.agent as any).shouldAutoCompact()).toBe(true);
            const check = (turns: ReturnType<typeof reopenTurns>) => {
                const blocks = turns.at(-1)!.blocks;
                expect(blocks.filter((b) => b.t === "text").map((b) => b.text)).toEqual([head + tail]);
                expect(blocks.findLastIndex((b) => b.t === "text")).toBeGreaterThan(blocks.findLastIndex((b) => b.t === "thinking"));
            };
            check(rt.snapshot().turns);
            await engine.stop();
            check(reopenTurns(a.session.path));
        } finally {
            await engine.stop();
        }
    });

    test("a kept prompt can start a continued answer without moving or splitting it again", async () => {
        const { Engine } = await import("../src/server/engine");
        const engine = new Engine({ listModels: async () => [] });
        const head = "PART-ONE: ```ts\nconst value = ";
        const tail = "42;\n```";
        try {
            const rt = await engine.createSession(realpathSync(tempDir()));
            await rt.ready;
            rt.session.setTitle("Kept prompt and continuation");
            // Two earlier exchanges: auto-compaction needs more than four messages, and this much context is over the threshold.
            for (const n of [1, 2]) {
                rt.session.push({ role: "user", content: [{ type: "text", text: `old context ${n} `.repeat(2000) }], meta: { kind: "prompt" } });
                rt.session.push(text(`old answer ${n}`));
            }
            const a = scripted((_req, n, onEvent) => {
                if (n === 1) return text("Earlier work.");
                if (n === 3) onEvent({ type: "thinking", text: "finish the answer" });
                onEvent({ type: "text", text: n === 2 ? head : tail });
                return { ...reply([...(n === 3 ? [{ type: "thinking", text: "finish the answer" }] : []), { type: "text", text: n === 2 ? head : tail }], n === 2 ? "max_tokens" : "end_turn"), usage: { inputTokens: 9000, outputTokens: 1000 } };
            }, { session: rt.session, model: { provider: "test", id: "test", contextWindow: 10_000, maxOutput: 1000 }, emit: (e) => (rt as any).onEvent(e) });
            (a.agent.options.settings() as any).autoCompact = true;
            Object.assign(rt, { model: a.agent.model, agent: a.agent });
            await rt.startTurn("write the report");
            expect(a.requests).toHaveLength(3);
            expect(a.events.filter((e) => e.type === "compact_end")).toMatchObject([{ kept: true }]);
            expect(JSON.stringify(a.requests[0]!.messages)).not.toContain("write the report");
            expect(a.requests[1]!.messages.map((m) => m.role === "user" ? m.meta?.kind : m.role)).toEqual(["summary", "prompt"]);
            expect(a.requests[2]!.messages.at(-1)).toMatchObject({ role: "user", meta: { kind: "continuation" } });
            expect(a.events.filter((e) => e.type === "request_start").map((e) => !!e.continuation)).toEqual([false, true]);
            const check = (turns: ReturnType<typeof reopenTurns>) => {
                const matches = turns.filter((t) => t.prompt?.text === "write the report");
                expect(matches).toHaveLength(1);
                const turn = matches[0]!;
                expect(turn.pos).toEqual({ seg: 1, index: 1 });
                expect(turn.prompt?.index).toBe(1);
                expect(turn.blocks.filter((b) => b.t === "text").map((b) => b.text)).toEqual([head + tail]);
                expect(turn.blocks.findLastIndex((b) => b.t === "text")).toBeGreaterThan(turn.blocks.findLastIndex((b) => b.t === "thinking"));
            };
            check(rt.snapshot().turns);
            await engine.stop();
            check(reopenTurns(a.session.path));
        } finally {
            await engine.stop();
        }
    });

    test.each(["error", "stop reason"])("a real context overflow (%s) during continuation still compacts reactively", async (kind) => {
        const a = scripted((_req, n) => {
            if (n === 1) return { ...reply([{ type: "text", text: "PART-ONE " }], "max_tokens"), usage: { inputTokens: 9000, outputTokens: 1000 } };
            if (n === 2) {
                if (kind === "error") throw new ProviderError("context window exceeded", 400, false);
                return reply([], "context_window_exceeded");
            }
            return text(n === 3 ? "summary" : "finished");
        }, { model: { provider: "test", id: "test", contextWindow: 10_000, maxOutput: 1000 } });
        (a.agent.options.settings() as any).autoCompact = true;
        for (const n of [1, 2]) {
            a.session.push({ role: "user", content: [{ type: "text", text: `earlier ${n}` }], meta: { kind: "prompt" } });
            a.session.push(text(`earlier context ${n} `.repeat(100)));
        }
        expect(await a.run("write")).toBe("done");
        expect(a.requests).toHaveLength(4);
        expect(a.requests[1]!.messages.at(-1)).toMatchObject({ role: "user", meta: { kind: "continuation" } });
        expect(a.requests[1]!.messages.at(-2)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "PART-ONE " }] });
        expect(a.events.filter((e) => e.type === "compact_start")).toHaveLength(1);
        expect(a.requests[3]!.messages[0]).toMatchObject({ role: "user", meta: { kind: "summary" } });
        // The continuation isn't a prompt waiting for its answer: it's folded into the summary, not kept after it.
        expect(JSON.stringify(a.requests[2]!.messages)).toContain("output token limit");
        expect(a.events.find((e) => e.type === "compact_end")).not.toHaveProperty("kept");
        expect(a.requests[3]!.messages.map((m) => m.meta?.kind ?? m.role)).toEqual(["summary"]);
    });

    test("the GUI Agents panel report uses the complete continued answer", async () => {
        const { Engine } = await import("../src/server/engine");
        const engine = new Engine({ listModels: async () => [] });
        try {
            const rt = await engine.createSession(realpathSync(tempDir()));
            await rt.ready;
            const a = scripted((_req, n, onEvent) => {
                const part = n === 1 ? "REPORT HEAD " : "TAIL";
                onEvent({ type: "text", text: part });
                return reply([{ type: "text", text: part }], n === 1 ? "max_tokens" : "end_turn");
            }, { session: rt.session, emit: (e) => (rt as any).onEvent(e) });
            (rt as any).onEvent({ type: "tool_start", call: { type: "tool_call", id: "c1", name: "Task", input: { description: "probe" } }, title: "probe" });
            const child = await (a.agent as any).runChild("c1", { prompt: "answer", description: "probe", agent: "general-purpose" }, new AbortController().signal);
            expect(child.report).toBe("REPORT HEAD TAIL");
            expect(rt.snapshot().agents.find((a) => a.id === "c1")?.report).toBe("REPORT HEAD TAIL");
        } finally {
            await engine.stop();
        }
    });

    test("the SDK result, Stop hooks and sub-agent report keep the whole continued answer", async () => {
        const { TurnTally } = await import("../src/sdk/messages");
        const tally = new TurnTally();
        const a = scripted((_req, n) => reply([{ type: "text", text: n % 2 ? "HEAD " : "TAIL" }], n % 2 ? "max_tokens" : "end_turn"), { emit: (e) => tally.observe(e) });
        (a.agent.options.settings() as any).hooks = { Stop: [{}] };
        let stopped: any;
        (a.agent as any).hooks = async (event: string, input: any) => { if (event === "Stop") stopped = input; };
        await a.run("answer");
        expect(tally.result("done", "s", "m").result).toBe("HEAD TAIL");
        expect(stopped.last_assistant_message).toBe("HEAD TAIL");
        expect((a.agent as any).lastAssistantText()).toBe("HEAD TAIL");
        const child = await (a.agent as any).runChild("c1", { prompt: "answer", description: "probe", agent: "general-purpose" }, new AbortController().signal);
        expect(child.report).toBe("HEAD TAIL");
    });

    test("only explicit continuation links join assistant text", async () => {
        const { assistantText } = await import("../src/providers/types");
        const user = (kind: any) => ({ role: "user", content: [{ type: "text", text: "go" }], meta: { kind } }) as any;
        const chain = [user("prompt"), text("HEAD "), user("continuation"), reply([{ type: "thinking", text: "hmm" }]), user("continuation"), text("TAIL")];
        expect(assistantText(chain)).toBe("HEAD TAIL");
        for (const kind of ["prompt", "tool_results", "reminder", "wake"]) expect(assistantText([...chain, user(kind), text("new answer")])).toBe("new answer");
        expect(assistantText([...chain, user("prompt")])).toBe("");
        expect(assistantText([...chain, user("interrupt")])).toBe("HEAD TAIL");
    });

    test.each(["text", "thinking"])("preserves raw %s and appends a user continuation in every wire format", async (kind) => {
        const { toAnthropicMessages } = await import("../src/providers/anthropic");
        const { toOpenAIMessages } = await import("../src/providers/openai-compat");
        const { toResponsesInput } = await import("../src/providers/openai-responses");
        const { BUILTIN_PROVIDERS } = await import("../src/providers/registry");
        const anthropic = kind === "text" ? [{ type: "text", text: "partial" }] : [{ type: "thinking", thinking: "partial", signature: "signed" }];
        const openai = kind === "text" ? { role: "assistant", content: "partial" } : { role: "assistant", content: null, reasoning_content: "partial" };
        const responses = kind === "text"
            ? [{ type: "message", id: "msg_1", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "partial", annotations: [] }] }]
            : [{ type: "reasoning", id: "rs_1", status: "incomplete", summary: [], encrypted_content: "encrypted" }];
        const a = scripted((_req, n) => n === 1 ? { ...reply([{ type: kind, text: "partial" }], "max_tokens"), raw: { anthropic, openai, responses } } : text("finished"));
        await a.run("answer");
        expect(a.requests).toHaveLength(2);
        const messages = a.requests[1]!.messages;
        const def = { ...BUILTIN_PROVIDERS.find((p) => p.id === "openai")!, id: "test" };
        const ant = toAnthropicMessages(messages);
        expect(ant.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
        expect(ant[1]!.content).toEqual(anthropic);
        const chat = toOpenAIMessages("", messages, def);
        expect(chat.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
        expect(chat[1]).toEqual(kind === "thinking" ? { role: "assistant", content: null } : openai);
        if (kind === "thinking") {
            // Main strips DeepSeek-only reasoning from standard Chat Completions,
            // while the DeepSeek dialect preserves it across the same boundary.
            const deepseek = toOpenAIMessages("", messages, { ...def, deepseekCompat: true });
            expect(deepseek.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
            expect(deepseek[1]).toEqual(openai);
        }
        const resp = toResponsesInput(messages, def, "test");
        expect(resp[1]).toEqual(responses[0]);
        for (const wire of [ant, chat, resp]) {
            expect(wire).toHaveLength(3);
            expect(wire.at(-1)).toMatchObject({ role: "user" });
            expect(JSON.stringify(wire.at(-1))).toContain("Continue from where you stopped");
        }
        // Anthropic's existing signature fallback drops thinking and merges the user messages.
        if (kind === "thinking") expect(toAnthropicMessages(messages, true).map((m) => m.role)).toEqual(["user"]);
    });

    test.each(["text", "thinking", "empty"])("bounds repeated %s cut-offs to three continuations per user turn", async (kind) => {
        const a = scripted((_req, n) => reply(kind === "empty" ? [] : [{ type: kind, text: `part ${n}` }], "max_tokens"));
        for (let turn = 1; turn <= 2; turn++) {
            expect(await a.run("answer")).toBe("done");
            expect(a.requests).toHaveLength(turn * 4);
            expect(a.session.messages.filter((m: any) => m.meta?.kind === "continuation")).toHaveLength(turn * 3);
            expect(a.session.notices.map((n: any) => n.text)).toEqual(Array(turn).fill("Response was cut off at the output token limit."));
        }
    });

    test("a thinking-only cut-off can continue to a visible answer", async () => {
        const a = scripted((_req, n) => n === 1 ? reply([{ type: "thinking", text: "Working it out" }], "max_tokens") : text("42"));
        expect(await a.run("answer")).toBe("done");
        expect(a.requests).toHaveLength(2);
        expect(a.session.messages.at(-1).content).toEqual([{ type: "text", text: "42" }]);
        expect(a.session.notices).toEqual([]);
    });

    test("abort during a continuation stops requests and discards its partial response", async () => {
        const ac = new AbortController();
        const a = scripted((_req, n) => {
            if (n === 2) ac.abort();
            return reply([{ type: "text", text: `part ${n}` }], "max_tokens");
        });
        expect(await a.run("answer", ac.signal)).toBe("aborted");
        expect(a.requests).toHaveLength(2);
        expect(a.events.filter((e) => e.type === "assistant").map((e) => e.message.content[0].text)).toEqual(["part 1"]);
        expect(a.session.messages.at(-1).meta.kind).toBe("interrupt");
    });

    test("truncated tool calls still get error results and their own strike limit", async () => {
        const a = scripted((_req, n) => n % 2 === 1
            ? reply([{ type: "text", text: "partial" }], "max_tokens")
            : reply([{ type: "tool_call", id: `c${n}`, name: "Nope", input: {} }], "max_tokens"));
        expect(await a.run("answer")).toBe("error");
        expect(a.requests).toHaveLength(6);
        const results = a.session.messages.filter((m: any) => m.meta?.kind === "tool_results").flatMap((m: any) => m.content);
        expect(results).toHaveLength(3);
        for (const r of results) expect(r).toMatchObject({ type: "tool_result", isError: true, content: expect.stringContaining("was not run") });
        expect(a.events.some((e) => e.type === "tool_start")).toBe(false);
    });
});

describe("a request that doesn't answer fails visibly, in bounded time", () => {
    test("stalls are tried three times in all, then the turn ends with the error", async () => {
        const a = scripted(() => {
            throw Object.assign(stallError("Google Gemini", 300_000), { retryAfterMs: 1 });
        });
        expect(await a.run("hi")).toBe("error");
        expect(a.requests).toHaveLength(3);
        expect(a.events.filter((e) => e.type === "retry")).toHaveLength(2);
        expect(a.session.notices.map((n: any) => n.text)).toEqual(["No response from Google Gemini for 5 minutes"]);
    });

    test("other retryable errors still get their retries", async () => {
        const a = scripted((_req, n) => {
            if (n < 5) throw new ProviderError("overloaded", 529, true, 1);
            return text("finally");
        });
        expect(await a.run("hi")).toBe("done");
        expect(a.requests).toHaveLength(5);
    });

    test("ordinary transient failures remain bounded to ten attempts", async () => {
        const a = scripted(() => { throw new ProviderError("overloaded", 529, true, 1); });
        expect(await a.run("hi")).toBe("error");
        expect(a.requests).toHaveLength(10);
        expect(a.events.filter((e) => e.type === "retry")).toHaveLength(9);
    });

    test("retry notices show the wait and cancellation in both interactive UIs, clearing partial output", async () => {
        const { Runtime } = await import("../src/server/runtime");
        const { App } = await import("../src/ui/app");
        const event = { type: "retry", attempt: 1, delayMs: 120_000, reason: "Rate limited" };
        const ops: any[] = [];
        const activity: string[] = [];
        const runtime = { turnId: "turn", responseBlocks: ["partial-text", "partial-tool"], openText: "partial-text", openThinking: "thinking", op: (o: any) => ops.push(o), activity: (label: string) => activity.push(label), worked() {} };
        (Runtime.prototype as any).onEvent.call(runtime, event);
        expect(ops).toEqual(["partial-text", "partial-tool"].map((blockId) => ({ op: "block.remove", turnId: "turn", blockId })));
        expect(runtime.responseBlocks).toEqual([]);
        expect(activity[0]).toContain("120s");
        expect(activity[0]).toContain("Stop to cancel");
        expect(activity[0]).not.toContain("Esc");
        const app: any = { md: { hasContent: true }, mdLines: 1, mdSource: "partial", thinking: "partial", receiving: new Map([["tool", {}]]), notice() {}, renderLive() {} };
        (App.prototype as any).onAgentEvent.call(app, event);
        expect(app.status).toContain("120s");
        expect(app.status).not.toContain("Esc");
        Object.assign(app, { active: new Map(), detached: new Map(), dialogs: [], queued: [], turnStart: Date.now(), turnTokens: 0, streamChars: 0, frame: 0, toolState: { todos: [] } });
        let binding: string | undefined = "ctrl+x";
        app.keys = { label: (action: string) => { expect(action).toBe("chat:cancel"); return binding; } };
        const { stripAnsi } = await import("../src/ui/ansi");
        const spinner = () => stripAnsi((App.prototype as any).renderActivity.call(app, 160, 40).status[0]);
        expect(spinner()).toContain("ctrl+x to interrupt");
        // Queueing after the retry event changes what the same key does.
        app.queued.push({ text: "next", mode: "queue" });
        expect(spinner()).not.toContain("to interrupt");
        expect(spinner()).not.toContain("cancels");
        expect(spinner()).toContain("ctrl+x to take back the queued message");
        app.queued = [];
        binding = undefined;
        expect(spinner()).not.toContain("to interrupt");
        expect(spinner()).not.toContain("esc");
        expect(app.mdSource).toBe("");
        expect(app.receiving.size).toBe(0);
    });

    test("stopped while it waits to retry: the reason it was retrying is kept with the interrupt", async () => {
        const ac = new AbortController();
        const a = scripted(() => {
            throw new ProviderError("Google Gemini: Resource has been exhausted (429)", 429, true, 60_000);
        });
        const done = a.run("hi", ac.signal);
        while (!a.events.some((e) => e.type === "retry")) await Bun.sleep(5);
        ac.abort();
        expect(await done).toBe("aborted");
        expect(a.session.notices.map((n: any) => n.text)).toEqual(["Stopped while retrying: Google Gemini: Resource has been exhausted (429) (attempt 1)"]);
        expect(a.session.messages.at(-1)?.meta?.kind).toBe("interrupt");
        // A later turn that's stopped without a retry pending says nothing more.
        const ac2 = new AbortController();
        ac2.abort();
        await a.run("again", ac2.signal);
        expect(a.session.notices).toHaveLength(1);
    });

    test.each([120_000, 300_000])("Retry-After %d is honoured and the wait can be cancelled", async (delay) => {
        const ac = new AbortController();
        const a = scripted(() => { throw httpError(429, "Too Many Requests", JSON.stringify({ error: { message: "Rate limited" } }), String(delay / 1000), "OpenAI"); });
        let waited: number | undefined;
        const original = globalThis.setTimeout;
        globalThis.setTimeout = ((fn: any, ms: number, ...args: any[]) => {
            if (ms >= 60_000) { waited = ms; queueMicrotask(() => ac.abort()); }
            return original(fn, ms, ...args);
        }) as typeof setTimeout;
        try {
            expect(await a.run("hi", ac.signal)).toBe("aborted");
            expect(waited).toBe(delay);
            expect(a.events.find((e) => e.type === "retry")?.delayMs).toBe(delay);
            expect(a.requests).toHaveLength(1);
        } finally { globalThis.setTimeout = original; }
    });

    test("Retry-After above five minutes stops and reports the requested wait", async () => {
        const a = scripted(() => { throw new ProviderError("Service unavailable", 503, true, 600_000); });
        const ac = new AbortController();
        const guard = setTimeout(() => ac.abort(), 100);
        try {
            expect(await a.run("hi", ac.signal)).toBe("error");
            expect(a.requests).toHaveLength(1);
            expect(a.events.filter((e) => e.type === "retry")).toHaveLength(0);
            expect(a.session.notices[0]?.text).toContain("600s");
            expect(a.session.notices[0]?.text).toContain("Service unavailable");
            const { classifyError } = await import("../src/agent/goal");
            expect(classifyError(a.session.notices[0]!.text)).toBe("limit");
        } finally { clearTimeout(guard); }
    });

    test("a long Retry-After is reported even on the last allowed attempt", async () => {
        const a = scripted((_req, n) => { throw new ProviderError("Rate limited", 429, true, n === 10 ? 600_000 : 1); });
        expect(await a.run("hi")).toBe("error");
        expect(a.requests).toHaveLength(10);
        expect(a.events.filter((e) => e.type === "retry")).toHaveLength(9);
        expect(a.session.notices[0]?.text).toContain("600s");
    });

    test("OpenAI quota exhaustion surfaces after one request without retrying", async () => {
        const a = scripted(() => { throw httpError(429, "Too Many Requests", JSON.stringify({ error: { code: "insufficient_quota", message: "Please check your plan and billing details." } }), "1", "OpenAI"); });
        const ac = new AbortController();
        const guard = setTimeout(() => ac.abort(), 100);
        try {
            expect(await a.run("hi", ac.signal)).toBe("error");
            expect(a.requests).toHaveLength(1);
            expect(a.events.filter((e) => e.type === "retry")).toHaveLength(0);
            expect(a.session.notices[0]?.text).toMatch(/usage limit.*billing/i);
        } finally { clearTimeout(guard); }
    });

    test("a 429 for a quota of 0 isn't retried; a rate limit is", () => {
        const body = JSON.stringify({ error: { code: 429, message: "You exceeded your current quota.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3-pro", status: "RESOURCE_EXHAUSTED" } });
        const e = httpError(429, "Too Many Requests", body, null, "Google Gemini");
        expect(e.retryable).toBe(false);
        expect(e.message).toContain("Not retried");
        expect(httpError(429, "Too Many Requests", JSON.stringify({ error: { message: "Rate limit reached, limit: 10 per minute" } }), null, "Google Gemini").retryable).toBe(true);
    });
});

describe("mode and model notes say where things are now, once", () => {
    const notesOf = (req: ChatRequest) => {
        const m = req.messages.findLast((x) => x.role === "user" && (x.meta?.kind ?? "prompt") === "prompt")!;
        return m.content.filter((p): p is { type: "text"; text: string } => p.type === "text" && p.text.startsWith("<system-reminder>")).map((p) => p.text.replace(/^<system-reminder>\n|\n<\/system-reminder>$/g, ""));
    };

    test("several mode switches before a prompt: one note, for the mode it ends on", async () => {
        const a = scripted(() => text("ok"));
        a.agent.noteModeChange("default", "acceptEdits");
        a.agent.noteModeChange("acceptEdits", "plan");
        a.agent.noteModeChange("plan", "default");
        a.agent.noteModeChange("default", "auto");
        a.agent.addReminder("The user ran a shell command themselves (output shown to them):\nok");
        await a.run("go");
        const notes = notesOf(a.requests[0]!);
        expect(notes).toHaveLength(2);
        expect(notes.filter((n) => n.startsWith("The user ran a shell command"))).toHaveLength(1);
        expect(notes.filter((n) => /permission mode|Plan mode/.test(n))).toEqual([expect.stringMatching(/^The user switched the permission mode to "Auto"/)]);
    });

    test("switched away and back: nothing to say", async () => {
        const a = scripted(() => text("ok"));
        a.agent.noteModeChange("default", "plan");
        a.agent.noteModeChange("plan", "default");
        a.agent.noteModelChange("test:test", { provider: "test", id: "other", name: "Other" } as any);
        a.agent.noteModelChange("test:other", { provider: "test", id: "test", name: "Test Model" } as any);
        await a.run("go");
        expect(notesOf(a.requests[0]!)).toEqual([]);
    });

    test("out of plan mode by way of another mode still says plan mode ended", async () => {
        const a = scripted(() => text("ok"));
        a.agent.noteModeChange("plan", "acceptEdits");
        a.agent.noteModeChange("acceptEdits", "default");
        await a.run("go");
        expect(notesOf(a.requests[0]!)).toEqual(['Plan mode has ended. The permission mode is now "Manual"; you can make changes again.']);
    });

    test("several model switches: one note, for the model it's on", async () => {
        const a = scripted(() => text("ok"));
        a.agent.noteModelChange("test:test", { provider: "gemini", id: "g", name: "Gemini" } as any);
        a.agent.noteModelChange("gemini:g", { provider: "codex", id: "gpt-6-astra", name: "GPT-6-Astra" } as any);
        a.agent.noteModelChange("codex:gpt-6-astra", { provider: "test", id: "test2", name: "Test Two" } as any);
        await a.run("go");
        expect(notesOf(a.requests[0]!)).toEqual(["The user switched the model to Test Two (test:test2). You are now running as this model."]);
        // Delivered: the next prompt has none.
        await a.run("again");
        expect(notesOf(a.requests[1]!)).toEqual([]);
    });

    test("rewound past a model switch: the model it's on now is said again, not the old note", async () => {
        const a = scripted(() => text("ok"));
        await a.run("first");
        a.agent.noteModelChange("test:test", { provider: "test", id: "b", name: "B" } as any);
        await a.run("second");
        expect(notesOf(a.requests[1]!)).toEqual(["The user switched the model to B (test:b). You are now running as this model."]);
        a.agent.rewind(2);
        await a.run("second, again");
        const notes = notesOf(a.requests[2]!);
        expect(notes.some((n) => n.startsWith("The user switched the model to B"))).toBe(false);
        expect(notes).toContain("You are running as Test Model (test:test).");
        expect(notes.filter((n) => n.startsWith("The permission mode is"))).toHaveLength(1);
    });

    test("a backend joining later isn't told, from turns it missed, that it runs as another model", async () => {
        const cwd = realpathSync(tempDir());
        const session = Session.create(cwd, { system: "SYSTEM" });
        const first = scripted(() => text("Answer from Astra."), { session });
        first.agent.noteModelChange("test:test", { provider: "codex", id: "gpt-6-astra", name: "GPT-6-Astra" } as any);
        await first.run("question one");
        expect(JSON.stringify(session.messages)).toContain("You are now running as this model");
        const prompts: string[] = [];
        const backend = { agentBackend: true, setMode() {}, listModels: async () => [], stream: async () => text(""), compact: async () => ({ reason: "done", text: "", actions: [] }), runTurn: async (t: any) => (prompts.push(t.prompt), { reason: "done", text: "From the backend.", actions: [] }) };
        first.agent.setModel({ provider: "claude-code", id: "opus", name: "Claude Opus" } as any, backend as any);
        first.agent.noteModelChange("codex:gpt-6-astra", { provider: "claude-code", id: "opus", name: "Claude Opus" } as any);
        await first.run("question two");
        expect(prompts[0]).toContain("question one");
        expect(prompts[0]).toContain("Answer from Astra.");
        // Its own, current note is there; the old one from the transcript isn't.
        expect(prompts[0]).toContain("The user switched the model to Claude Opus (claude-code:opus)");
        expect(prompts[0]).not.toContain("GPT-6-Astra");
        session.release();
    });
});

describe("usage with no known price isn't saved as free", () => {
    const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };

    test("the agent marks it, the file keeps it, and a reopened session still knows", async () => {
        const a = scripted(() => ({ ...text("ok"), usage }), { model: { provider: "vertex", id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash" } });
        await a.run("hi");
        expect(a.session.cost).toBe(0);
        expect(a.session.costUnknown).toBe(true);
        expect(fileLines(a.session.path).find((l) => l.t === "usage")).toMatchObject({ cost: 0, unknown: true, model: "vertex:google/gemini-3.5-flash" });
        a.session.release();
        const s = Session.load(a.session.path);
        expect(s.costUnknown).toBe(true);
        expect(s.usageByModel.get("vertex:google/gemini-3.5-flash")?.unknown).toBe(true);
        s.release();
    });

    test("priced usage, and files from before, are as they were", async () => {
        const a = scripted(() => ({ ...text("ok"), usage }), { model: { provider: "test", id: "priced", pricing: { input: 1, output: 2 } } });
        await a.run("hi");
        expect(a.session.cost).toBeCloseTo(0.0014);
        expect(a.session.costUnknown).toBe(false);
        expect(fileLines(a.session.path).find((l) => l.t === "usage").unknown).toBeUndefined();
        a.session.release();
        expect(Session.load(a.session.path).costUnknown).toBe(false);
    });

    test("shown as unknown, not $0", () => {
        expect(formatCost(0, true)).toBe("—");
        expect(formatCost(0.42, true)).toBe("$0.420+");
        expect(formatCost(0, false)).toBe("$0.00");
        expect(formatCost(1.5, undefined)).toBe("$1.50");
    });
});

describe("the environment block warns about GNU and bash habits that fail here", () => {
    test("macOS with BSD tools, and zsh", async () => {
        const { shellNotes } = await import("../src/agent/system-prompt");
        const bsd = (p: string) => ({ sed: "/usr/bin/sed", date: "/bin/date" })[p] ?? null;
        const notes = shellNotes("darwin", "/bin/zsh", bsd);
        expect(notes).toHaveLength(2);
        expect(notes[0]).toContain("no `timeout`");
        expect(notes[0]).toContain("sed -i ''");
        expect(notes[1]).toContain("$pipestatus");
        expect(notes[1]).toContain("--include='*.ts'");
        // GNU tools on PATH (coreutils' gnubin): nothing to say about them.
        expect(shellNotes("darwin", "/bin/bash", (p) => `/opt/homebrew/opt/coreutils/libexec/gnubin/${p}`)).toEqual([]);
        expect(shellNotes("linux", "/bin/bash", () => "/usr/bin/x")).toEqual([]);
    });

    test("the prompt names the shell commands actually run in", async () => {
        const { environmentBlock } = await import("../src/agent/system-prompt");
        const { pickShell } = await import("../src/tools/bash");
        const saved = process.env.SHELL;
        process.env.SHELL = "/usr/local/bin/fish";
        try {
            expect(environmentBlock(tempDir(), { provider: "x", id: "y" } as any)).toContain(`Shell: ${pickShell()}`);
            expect(pickShell()).not.toContain("fish");
        } finally {
            process.env.SHELL = saved;
        }
    });
});

describe("a last grep that finds nothing isn't an error", () => {
    test.each([
        ["npm test 2>&1 | grep FAIL", "grep"],
        ["ls src; grep -rn TODO src", "grep"],
        ["cat a | rg foo", "rg"],
        ["git grep -n foo", "git grep"],
        ["make || grep x log", "grep"],
        ["time grep x f", undefined],
        ["/usr/bin/grep x f", "grep"],
        ["grep x f\n", "grep"],
        ["make && grep x log", undefined],
        ["make && cat log | grep x", undefined],
        ["make &&\ngrep x log", undefined],
        ["grep x f &", undefined],
        ["! grep x f", undefined],
        ["grep x f | wc -l", undefined],
        ["set -o pipefail; a | grep x", undefined],
        ["if true; then grep x f; fi", undefined],
        ["grep $(cat p) f", undefined],
        ["npm test", undefined],
        ["grep -rn foo .", "grep"],
        ["grep x f 2>/dev/null", "grep"],
        ["grep x <<< \"$v\"", undefined],
        ["npm test > log 2>&1; grep FAIL log", "grep"],
        // The shell opens these before grep runs; when it can't, the 1 is the shell's.
        ["grep x < /no/such/file", undefined],
        ["grep x 2>/dev/null < f", undefined],
        ["grep x 0</no/such", undefined],
        ["grep x f > /no/such/dir/out", undefined],
        ["grep x f 2>err.log", undefined],
        ["cat < f | grep x", undefined],
        // A descriptor past stderr is closed unless something opened it.
        ["grep x 2>/dev/null <&9", undefined],
        ["grep x f >&3", undefined],
        ["grep x f 1>&3", undefined],
        ["grep x f 2>&1", "grep"],
        ["grep x <&0", undefined],
        ["grep x f 2>&-", undefined],
        ["grep x f >/dev/null 2>&1", "grep"],
        ["grep x f 1>&2", "grep"],
        ["grep x /dev/null 2>/dev/null <&0x", undefined],
        ["grep x /dev/null <&2- >&2", undefined],
        // A prefix assignment can fail (zsh can't set UID); formatting ones can't.
        ["UID=5 grep x f 2>/dev/null", undefined],
        ["cat f | FOO=1 grep x", undefined],
        ["LC_ALL=C grep x f", "grep"],
        // Closed, then copied: the copy fails.
        ["grep x /dev/null 2>&- 1>&2", undefined],
        ["grep x /dev/null <&- 0<&1", undefined],
        // Negated: 1 is a match.
        ["! cat package.json | grep -q name", undefined],
        ["time ! cat f | grep x", undefined],
        // Can change what grep is, or hide the shell's errors.
        ["exec 2>/dev/null; grep x *.ts", undefined],
        ["eval 'grep() false'; grep x f", undefined],
        ["alias grep=false; grep x f", undefined],
        ["source env.sh; grep x f", undefined],
        [". ./env.sh; grep x f", undefined],
        ["hash -p /usr/bin/false grep; grep x f", undefined],
        ["readonly LANG; LANG=C grep x f 2>/dev/null", undefined],
        ["typeset -r LC_ALL; LC_ALL=C grep x f", undefined],
        ["PATH=/tmp/x; grep x f", undefined],
        ["export PATH=/tmp/x; grep x f", undefined],
        ["LC_ALL=C; grep x f", "grep"],
        // Something else runs, and the 1 is its own.
        ["./grep x f", undefined],
        ["rg --pre /usr/bin/false x f", undefined],
        ["git grep -O/usr/bin/false x", undefined],
        ["git -c core.pager=false grep x", undefined],
        ["git -C sub grep -n x", "git grep"],
        ["/opt/homebrew/bin/ggrep x f", "ggrep"],
        ["git --no-pager -c core.fsmonitor=false grep -O/usr/bin/false name -- package.json", undefined],
        ["git grep --open-files-in-pager=/usr/bin/false name", undefined],
        // Before it: a here-document's lines aren't commands; builtins, however they're spelled, can end the shell.
        ["false <<grep\nhello\ngrep", undefined],
        ["command -p eval 'exit 1'; grep x /dev/null", undefined],
        ["e\"\"xit 1; grep x /dev/null", undefined],
        [": 2>/dev/null < /no/such; grep x f", undefined],
        ["UID=5 true 2>/dev/null; grep x f", undefined],
        ["ls .; grep x f", "grep"],
        ["cd src; grep -rn export .", "grep"],
        ["zgrep x f.gz", undefined],
        ["nice grep x /dev/null", undefined],
        ["command grep x f", undefined],
        ["LC_ALL=C grep -rn x .", "grep"],
        ["grep -v x f", undefined],
        ["grep -rvn x .", undefined],
        ["grep -L x *.ts", undefined],
        ["rg --invert-match x", undefined],
        ["grep --invert x f", undefined],
        ["grep --files-without x *.ts", undefined],
        ["grep --files-with-matches x src/*.ts", "grep"],
        ["grep -l x *.ts", undefined],
        ["git grep --open=/usr/bin/false x", undefined],
        ["git grep -n1O/usr/bin/false x", undefined],
        ["grep -1v x f", undefined],
        ["time -p ! cat f | grep x", undefined],
        ["$X 1; grep x f", undefined],
        ["grep $o x f", undefined],
        ["grep \"$o\" x f", undefined],
        ["grep x *", undefined],
        ["grep -rn x src/*.ts", "grep"],
        ["NO_COLOR=-O/usr/bin/false; git grep $NO_COLOR name -- package.json", undefined],
        ["NO_COLOR=--invert-match; printf 'x\\n' | grep $NO_COLOR x", undefined],
        ["NO_COLOR=\"exit 1\"; $NO_COLOR; grep x /dev/null", undefined],
        ["printf -v cmd 'exit 1'; $cmd; grep x /dev/null", undefined],
        // A command of redirections alone has a status of its own.
        ["grep name package.json; 2>/dev/null 1>&9", undefined],
        ["2>/dev/null 1>&9 && grep name package.json", undefined],
        // Descriptors other than stdout and stderr, either side.
        ["grep x /dev/null 2>/dev/null 999999999>&1", undefined],
        ["grep x /dev/null 2>/dev/null 999999999>/dev/null", undefined],
        ["grep x f 3>/dev/null", undefined],
        // A name in quotes keeps the other quotes: that's not /dev/null.
        ["grep x /dev/null 2>/dev/null > '\"/dev/null\"'", undefined],
        ["grep x /dev/null 2>/dev/null > \"'/dev/null'\"", undefined],
        ["grep x f > \"/dev/null\"", "grep"],
        // Options that make 1 mean something else: decompressing, --not, a max count of 0.
        ["printf 'x' | grep -Z x", undefined],
        ["printf 'x' | grep -J x", undefined],
        ["grep --decomp x f", undefined],
        ["grep --bz2 x f", undefined],
        ["grep -X x f", undefined],
        ["rg -z x", undefined],
        ["git grep --not -e . -- package.json", undefined],
        ["git grep -1v -e . --", undefined],
        ["grep -m 0 x f", undefined],
        ["grep -m0 x f", undefined],
        ["grep --max-count=0 x f", undefined],
        ["grep --inc='*.ts' x .", undefined],
        // Ordinary options still do.
        ["grep -rn --include '*.ts' TODO src", "grep"],
        ["grep -C 3 -A2 x f", "grep"],
        ["grep -e -v f", "grep"],
        ["grep -m 5 x f", "grep"],
        ["rg -n --type ts -g '*.ts' -i foo", "rg"],
        ["git grep -n -e foo -- src", "git grep"],
        ["grep --color=always -E 'a|b' f", "grep"],
        // A literal $ isn't an expansion; BSD grep's -C takes its count only in the same word.
        ["grep -n 'foo$' f", "grep"],
        ["grep -n \"foo$\" f", "grep"],
        ["grep -C -v x f", undefined],
        // A max count of 0 however it's spelled; a count's value is always its next word.
        ["grep -m +0 . f", undefined],
        ["grep -m -0 . f", undefined],
        ["grep -m ' 0' . f", undefined],
        ["grep --max-count=+0 . f", undefined],
        ["grep -m 3 . f", "grep"],
        ["grep -C 2 x f", "grep"],
        ["grep x /dev/null 2>&- >/dev/stderr", undefined],
        ["grep x /dev/null 2>/dev/null 1>&- >/dev/stdout", undefined],
        ["s\"\"et -e; false; grep x /dev/null", undefined],
    ])("%p: %p", async (cmd, want) => {
        const { finalSearch } = await import("../src/permissions/bash-safety");
        expect(finalSearch(cmd)?.name).toBe(want as string | undefined);
    });

    test("options from the environment count: GREP_OPTIONS, rg's config file", async () => {
        const { finalSearch } = await import("../src/permissions/bash-safety");
        expect(finalSearch("grep x f", { GREP_OPTIONS: "-v" })).toBeUndefined();
        expect(finalSearch("grep x f", { GREP_OPTIONS: "-i --color=auto" })?.name).toBe("grep");
        const dir = realpathSync(tempDir());
        writeFileSync(join(dir, "inverted"), "# mine\n--smart-case\n--invert-match\n");
        writeFileSync(join(dir, "plain"), "# mine\n--smart-case\n--hidden\n");
        expect(finalSearch("rg x", { RIPGREP_CONFIG_PATH: join(dir, "inverted") })).toBeUndefined();
        expect(finalSearch("rg x", { RIPGREP_CONFIG_PATH: join(dir, "missing") })).toBeUndefined();
        expect(finalSearch("rg x", { RIPGREP_CONFIG_PATH: join(dir, "plain") })?.name).toBe("rg");
        expect(finalSearch("rg x", {})?.name).toBe("rg");
        // --no-config: the file isn't read. A relative path is the shell's cwd's; a file too long to read whole could hide one.
        expect(finalSearch("rg --no-config x", { RIPGREP_CONFIG_PATH: join(dir, "inverted") })?.name).toBe("rg");
        expect(finalSearch("rg x -- --no-config", { RIPGREP_CONFIG_PATH: join(dir, "inverted") })).toBeUndefined();
        // There it's a pattern, and rg reads its config.
        expect(finalSearch("rg -e --no-config -e . f", { RIPGREP_CONFIG_PATH: join(dir, "inverted") })).toBeUndefined();
        expect(finalSearch("rg x", { RIPGREP_CONFIG_PATH: "plain" })).toBeUndefined();
        writeFileSync(join(dir, "long"), "--hidden\n".repeat(8000) + "--invert-match\n");
        expect(finalSearch("rg x", { RIPGREP_CONFIG_PATH: join(dir, "long") })).toBeUndefined();
        // A glob after empty quotes or an expansion starts the word all the same (a file named -v).
        expect(finalSearch('grep -e x ""*')).toBeUndefined();
        expect(finalSearch("grep -e x ''*")).toBeUndefined();
        expect(finalSearch("grep -e x $E*")).toBeUndefined();
    });

    test("says when other commands feed it", async () => {
        const { finalSearch } = await import("../src/permissions/bash-safety");
        expect(finalSearch("cat a | rg foo")?.piped).toBe(true);
        expect(finalSearch("make || cat log | grep x")?.piped).toBe(true);
        expect(finalSearch("ls; grep x f")?.piped).toBe(false);
    });

    const bash = async (command: string, files: Record<string, string> = {}, env?: Record<string, string>) => {
        const { BashTool } = await import("../src/tools/bash");
        const cwd = realpathSync(tempDir());
        for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
        return BashTool.run({ command }, { state: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() }, settings: env ? { env } : {}, signal: new AbortController().signal } as any);
    };

    // Only BSD grep reads GREP_OPTIONS (GNU grep ignores it), so ask the grep on PATH: 1 (no line survives
    // the inversion) means it reads it, 0 means it doesn't. Anything else is a broken grep, not a reason to skip.
    const grepReadsOptions = (() => {
        const r = Bun.spawnSync(["grep", "."], { stdin: Buffer.from("a line\n"), env: { ...process.env, GREP_OPTIONS: "--invert-match" } });
        if (r.exitCode !== 0 && r.exitCode !== 1) throw new Error(`grep exited ${r.exitCode} probing GREP_OPTIONS: ${r.stderr.toString()}`);
        return r.exitCode === 1;
    })();

    test("a search the environment inverted isn't taken for no matches", async () => {
        const conf = join(realpathSync(tempDir()), "rgrc");
        writeFileSync(conf, "--invert-match\n");
        for (const [command, env] of [
            ...(grepReadsOptions ? [["grep . f", { GREP_OPTIONS: "--invert-match" }] as const] : []),
            ["rg . f", { RIPGREP_CONFIG_PATH: conf }],
        ] as const) {
            const r = await bash(command, { f: "every line matches\n" }, env);
            expect(r.content).toContain("Exit code: 1");
            expect(r.isError).toBe(true);
        }
        // Told not to read it, rg's 1 is its own again.
        const plain = await bash("rg --no-config nomatch f", { f: "x\n" }, { RIPGREP_CONFIG_PATH: conf });
        expect(plain.isError).toBe(false);
    });

    test("the output stays the result, and says what exit 1 means", async () => {
        const r = await bash("echo useful output; grep -q nomatch /dev/null");
        expect(r.isError).toBe(false);
        expect(r.content).toStartWith("useful output");
        expect(r.content).toContain("Exit code: 1 (the last command, grep, found no matches");
        expect(r.content).toContain("The output above is everything the command printed.");
        const empty = await bash("grep nomatch /dev/null");
        expect(empty.isError).toBe(false);
        expect(empty.content).toBe("Exit code: 1 (the last command, grep, found no matches: that's its status for no match, not an error.)");
    });

    test("other failures are still errors, a grep that errs too", async () => {
        expect((await bash("echo x; false")).isError).toBe(true);
        const before = await bash("false && grep x /dev/null");
        expect(before.isError).toBe(true);
        expect(before.content).toContain("Exit code: 1");
        const missing = await bash("grep x /no/such/file");
        expect(missing.isError).toBe(true);
        expect(missing.content).toContain("Exit code: 2");
    });

    test("a 1 that isn't grep's stays an error", async () => {
        // grep never ran: the shell couldn't open its input, or output file.
        for (const cmd of ["grep x < /no/such/file", "grep x 2>/dev/null < /no/such/file", "grep x /dev/null > /no/such/dir/out", "grep x 2>/dev/null <&9", "grep x /dev/null 2>&- 1>&2", "UID=5 grep x /dev/null 2>/dev/null"]) {
            const r = await bash(cmd);
            expect(r.isError).toBe(true);
            expect(r.content).toContain("Exit code: 1");
            expect(r.content).not.toContain("found no matches");
        }
        // grep matched; the pipeline is negated.
        const negated = await bash("! cat package.json | grep -q name", { "package.json": '{"name":"x"}' });
        expect(negated.isError).toBe(true);
        expect(negated.content).not.toContain("found no matches");
        // A glob that matches nothing: zsh stops with 1 before grep runs (bash passes it on, and grep's 2 says why).
        const glob = await bash("grep x *.nomatchglob");
        expect(glob.isError).toBe(true);
        expect(glob.content).not.toContain("found no matches");
        // Its complaint mid-line, after output with no newline.
        const midLine = await bash("printf 'Checking... ' >&2; grep x *.nomatchglob");
        expect(midLine.isError).toBe(true);
        expect(midLine.content).not.toContain("found no matches");
    });

    test("a shell that stopped before the end of the script: its 1 isn't the search's", async () => {
        // A user's startup file can turn on errexit; here the env does (bash reads BASH_ENV).
        const env = join(realpathSync(tempDir()), "errexit.sh");
        writeFileSync(env, "set -e\n");
        const saved = { SHELL: process.env.SHELL, BASH_ENV: process.env.BASH_ENV };
        process.env.SHELL = "/bin/bash";
        process.env.BASH_ENV = env;
        try {
            const r = await bash("false; grep x /dev/null");
            expect(r.isError).toBe(true);
            expect(r.content).not.toContain("found no matches");
        } finally {
            process.env.SHELL = saved.SHELL;
            if (saved.BASH_ENV === undefined) delete process.env.BASH_ENV;
            else process.env.BASH_ENV = saved.BASH_ENV;
        }
    });

    test("in bash too: a descriptor closed, then copied", async () => {
        const saved = process.env.SHELL;
        process.env.SHELL = "/bin/bash";
        try {
            const r = await bash("grep x /dev/null 2>&- 1>&2");
            expect(r.isError).toBe(true);
            expect(r.content).not.toContain("found no matches");
        } finally {
            process.env.SHELL = saved;
        }
    });

    test("a piped grep's 1 says what came before it may have failed", async () => {
        const r = await bash("cat /dev/null | grep x");
        expect(r.isError).toBe(false);
        expect(r.content).toContain("What was piped into it may still have failed");
    });
});

describe("titles come from a prompt that says something", () => {
    test.each([
        ["fix the login bug", "Fix the login bug"],
        ["## Fix the build.\nIt fails on CI", "Fix the build"],
        ["<system-reminder>mode</system-reminder>\n\n  > why does   it hang?", "Why does it hang?"],
        ["src/auth.ts throws on sign-in", "src/auth.ts throws on sign-in"],
        ["untitled: fix it", "Untitled: fix it"],
        ["please read every file in this repository and then tell me what each one of them does", "Please read every file in this repository and then tell me…"],
        ["...", undefined],
    ])("named from the prompt itself: %p", async (prompt, want) => {
        const { promptTitle } = await import("../src/server/runtime");
        expect(promptTitle(prompt as string)).toBe(want as string | undefined);
    });

    test.each([
        ["Hi", false], ["hi!", false], ["Hello there", false], ["hey", false], ["thanks!", false], ["ok", false], ["good morning :)", false], ["test", false], ["??", false],
        ["fix the login bug", true], ["hi, can you fix the login bug?", true], ["Explain the layout", true], ["why", true], ["日本語の質問", true],
    ])("%p: %p", async (prompt, want) => {
        const { titleWorthy } = await import("../src/server/runtime");
        expect(titleWorthy(prompt as string)).toBe(want as boolean);
    });
});

describe("stopped while compacting", () => {
    test("is an interrupt, saved as one, not an unexpected error", async () => {
        const ac = new AbortController();
        const session = Session.create(realpathSync(tempDir()), { system: "SYSTEM" });
        for (let i = 0; i < 3; i++) {
            session.push({ role: "user", content: [{ type: "text", text: `q${i} ${"x".repeat(40_000)}` }] });
            session.push({ role: "assistant", provider: "test", model: "test", stopReason: "end_turn", content: [{ type: "text", text: "a" }] } as any);
        }
        const a = scripted(async (req) => {
            // The compaction request: stopped while it runs.
            ac.abort();
            throw new ProviderError("aborted");
        }, { session, model: { provider: "test", id: "test", contextWindow: 8_000, maxOutput: 1_000 } });
        (a.agent.options.settings as any)().autoCompact = true;
        expect(await a.run("next", ac.signal)).toBe("aborted");
        // The one request was the compaction's.
        expect(a.requests).toHaveLength(1);
        expect(JSON.stringify(a.requests[0]!.messages.at(-1))).toContain("summary");
        expect(a.session.messages.at(-1)?.meta?.kind).toBe("interrupt");
        expect(a.session.notices).toEqual([]);
    });
});

test("a failed Edit replays from disk with no diff, as it has none live; a successful one keeps its diff", () => {
    const call = (id: string) => ({ type: "tool_call", id, name: "Edit", input: { file_path: "/w/a.ts", old_string: "foo", new_string: "bar" } });
    const result = (id: string, isError: boolean) => ({ type: "tool_result", toolCallId: id, toolName: "Edit", content: isError ? "String to replace not found in file." : "Edited /w/a.ts", isError });
    const msgs: any[] = [
        { role: "user", content: [{ type: "text", text: "fix a.ts" }] },
        reply([call("c1")], "tool_use"),
        { role: "user", meta: { kind: "tool_results" }, content: [result("c1", true)] },
        reply([call("c2")], "tool_use"),
        { role: "user", meta: { kind: "tool_results" }, content: [result("c2", false)] },
        text("Done on the second try."),
    ];
    let n = 0;
    const turns = replay({ segments: [{ messages: msgs }] as any, current: msgs, ui: new UiLog(join(tempDir(), "x.jsonl"), "x", false), meta: (c) => ({ title: c.name, category: "edit" }), newId: () => `i${++n}` });
    const [failed, applied] = turns[0]!.blocks.filter((b: any) => b.t === "tool") as any[];
    expect(failed.status).toBe("error");
    expect(failed.diff).toBeUndefined();
    expect(applied.status).toBe("ok");
    expect(applied.diff).toMatchObject({ added: 1, removed: 1 });
    // An Edit interrupted before it ran has none either.
    const stopped: any[] = [msgs[0], reply([call("c3")], "tool_use"), { role: "user", meta: { kind: "interrupt" }, content: [{ type: "text", text: "[interrupted]" }] }];
    const [cut] = replay({ segments: [{ messages: stopped }] as any, current: stopped, ui: new UiLog(join(tempDir(), "y.jsonl"), "y", false), meta: (c) => ({ title: c.name, category: "edit" }), newId: () => `j${++n}` })[0]!.blocks.filter((b: any) => b.t === "tool") as any[];
    expect(cut.status).toBe("error");
    expect(cut.diff).toBeUndefined();
});

describe("provider retry classification", () => {
    type Json = Record<string, any>;
    const model = { provider: "anthropic", id: "claude-haiku-5-5" };
    const prompt = { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] };
    const req = (m = model, messages = [prompt], extra = {}) => ({ model: m, messages, system: "test", tools: [], ...extra });
    let respond: () => Response | Promise<Response>;
    const provider = () => {
        const p = new AnthropicProvider(BUILTIN_PROVIDERS.find((p) => p.id === "anthropic")!, "test-key");
        (p as any).client = (p as any).client.withOptions({ fetch: async (_url: unknown, init: RequestInit) => {
            const response = await new Promise<Response>((resolve, reject) => {
                const abort = () => reject(new DOMException("Aborted", "AbortError"));
                if (init.signal?.aborted) return abort();
                init.signal?.addEventListener("abort", abort, { once: true });
                Promise.resolve(respond()).then(resolve, reject).finally(() => init.signal?.removeEventListener("abort", abort));
            });
            if (!response.body) return response;
            const reader = response.body.getReader();
            const signal = init.signal;
            let abort: () => void;
            const body = new ReadableStream<Uint8Array>({
                start(c) {
                    abort = () => { c.error(new DOMException("Aborted", "AbortError")); void reader.cancel(); };
                    if (signal?.aborted) abort();
                    else signal?.addEventListener("abort", abort, { once: true });
                },
                async pull(c) {
                    try {
                        const { value, done } = await reader.read();
                        if (signal?.aborted) return;
                        if (done) { signal?.removeEventListener("abort", abort); c.close(); }
                        else c.enqueue(value);
                    } catch (e) { signal?.removeEventListener("abort", abort); c.error(e); }
                },
                cancel() { signal?.removeEventListener("abort", abort); return reader.cancel(); },
            });
            return new Response(body, response);
        } });
        return p;
    };
    function sse(items: string[], opts: { pauseMs?: number; pauseAfter?: number } = {}) {
        let cancelled = false;
        return new Response(new ReadableStream({
            async start(c) {
                for (let i = 0; i < items.length; i++) {
                    if (cancelled) return;
                    c.enqueue(new TextEncoder().encode(items[i]));
                    if (i === opts.pauseAfter) await Bun.sleep(opts.pauseMs!);
                }
                if (!cancelled) c.close();
            },
            cancel() { cancelled = true; },
        }), { headers: { "content-type": "text/event-stream" } });
    }
    test.each(["code", "type"])("quota exhaustion in error.%s fails immediately in both OpenAI adapters", async (field) => {
        const message = "You exceeded your current quota, please check your plan and billing details.";
        respond = () => Response.json({ error: { message, [field]: "insufficient_quota" } }, { status: 429, headers: { "retry-after": "120" } });
        const original = globalThis.fetch;
        globalThis.fetch = (async () => respond()) as typeof fetch;
        try {
            const def = BUILTIN_PROVIDERS.find((p) => p.id === "openai")!;
            for (const provider of [new OpenAICompatProvider(def, "test-key"), new OpenAIResponsesProvider(def, "test-key")]) {
                const err = await provider.stream(req(model, []), () => {}).catch((e) => e);
                expect(err).toBeInstanceOf(ProviderError);
                expect(err.retryable).toBe(false);
                expect(err.message).toContain(message);
                expect(err.message).toMatch(/usage limit.*billing/i);
            }
        } finally { globalThis.fetch = original; }
    });

    test("streamed quota failures get billing guidance, while rate limits stay retryable", async () => {
        const original = globalThis.fetch;
        const def = BUILTIN_PROVIDERS.find((p) => p.id === "openai")!;
        const responses = new OpenAIResponsesProvider(def, "test-key");
        const compat = new OpenAICompatProvider(def, "test-key");
        try {
            for (const code of ["insufficient_quota", "rate_limit_exceeded"]) {
                const error = { code, message: "Provider explanation" };
                for (const [p, event] of [
                    [responses, { type: "response.failed", response: { error } }],
                    [responses, { type: "error", ...error }],
                    [responses, { type: "error", error }],
                    [compat, { error: { ...error, code: 429, type: code } }],
                ] as const) {
                    globalThis.fetch = (async () => sse([`data: ${JSON.stringify(event)}\n\n`])) as typeof fetch;
                    const err = await p.stream(req(), () => {}).catch((e) => e);
                    expect(err.retryable).toBe(code !== "insufficient_quota");
                    expect(err.message).toContain("Provider explanation");
                    if (code === "insufficient_quota") expect(err.message).toMatch(/usage limit.*billing/i);
                }
            }
        } finally { globalThis.fetch = original; }
    });

    test("explicit billing exhaustion without a code is fatal; a temporary quota remains retryable", () => {
        const error = (message: string) => httpError(429, "Too Many Requests", JSON.stringify({ error: { message } }), null, "P");
        expect(error("Your credit balance is too low. Please purchase credits.").retryable).toBe(false);
        expect(error("You exceeded your current quota, please check your plan and billing details.").retryable).toBe(true);
        expect(error("Token quota exceeded for this minute; try again later.").retryable).toBe(true);
        expect(httpError(429, "Too Many Requests", JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } }), null, "Google Gemini").retryable).toBe(true);
        expect(httpError(402, "Payment Required", JSON.stringify({ error: { message: "Not enough credits" } }), null, "OpenRouter").retryable).toBe(false);
    });

    test.each(["object", "array", "string-wrapped"])("Gemini per-minute quotas remain retryable: %s", (shape) => {
        const message = "You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generate_content_free_tier_input_token_count, limit: 250000\nPlease retry in 33.9s.";
        const error = { code: 429, message, status: "RESOURCE_EXHAUSTED", details: [
            { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateContentInputTokensPerModelPerMinute-FreeTier" }] },
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "33s" },
        ] };
        const body = shape === "array" ? [{ error }] : shape === "string-wrapped" ? { error: { message: `litellm.RateLimitError: GeminiException - ${JSON.stringify({ error })}`, type: "throttling_error", code: "429" } } : { error };
        const e = httpError(429, "Too Many Requests", JSON.stringify(body), "33.9", "Google Gemini");
        expect(e.retryable).toBe(true);
        expect(e.retryAfterMs).toBe(33_900);
        expect(e.message).toContain("Please retry in 33.9s");
        expect(e.message).not.toContain("Usage limit / billing:");
    });

    test.each([
        { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s" }] },
        { message: "Your credit balance is too low. Please retry in 30s." },
        { details: [{ violations: [{ quotaId: "RequestsPerMinute" }] }] },
        { details: [{ violations: [{ quotaId: "RequestsPerDay" }] }] },
    ])("retry guidance overrides permanent-quota heuristics: %p", (hint) => {
        const body = JSON.stringify({ error: { code: "insufficient_quota", message: "Your credit balance is too low.", ...hint } });
        expect(httpError(429, "Too Many Requests", body, "30", "Gateway").retryable).toBe(true);
    });

    const ev = (type: string, data: Json = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const prefix = [
        ev("message_start", { message: { id: "msg_retry", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "partial" } }),
    ].join("");
    const suffix = ev("content_block_stop", { index: 0 }) + ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) + ev("message_stop");
    const run = (signal?: AbortSignal, on: (e: StreamEvent) => void = () => {}) => provider().stream(req({ provider: "anthropic", id: "claude-haiku-5-5" }, [prompt], { signal }), on);

    test("premature EOF discards the incomplete message and is retryable", async () => {
        respond = () => new Response(prefix, { headers: { "content-type": "text/event-stream" } });
        const err = await run().catch((e) => e);
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.retryable).toBe(true);
    });

    test("the agent retries an incomplete tool response without saving or executing it", async () => {
        let calls = 0;
        const partialTool = ev("content_block_stop", { index: 0 })
            + ev("content_block_start", { index: 1, content_block: { type: "tool_use", id: "discarded-tool", name: "Write", input: {} } })
            + ev("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/unwanted"' } });
        respond = () => sse(++calls === 1 ? [prefix, partialTool] : [prefix.replace("partial", "complete"), suffix]);
        const p = provider();
        const a = scripted((req, _n, on) => p.stream(req, on), { model });
        expect(await a.run("hi")).toBe("done");
        expect(calls).toBe(2);
        expect(a.requests[1]!.messages).toEqual(a.requests[0]!.messages);
        expect(a.events.filter((e) => e.type === "retry")).toHaveLength(1);
        expect(a.events.some((e) => e.type === "tool_start")).toBe(false);
        expect(a.session.messages.filter((m: any) => m.role === "assistant").map((m: any) => m.content)).toEqual([[{ type: "text", text: "complete" }]]);
        expect(JSON.stringify(a.session.messages)).not.toContain("discarded-tool");
    });

    test.each(["120", new Date(Date.now() + 120_000).toUTCString()])("Anthropic preserves Retry-After seconds and dates: %s", async (retryAfter) => {
        respond = () => Response.json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, { status: 429, headers: { "retry-after": retryAfter } });
        const err = await run().catch((e) => e);
        expect(err.retryable).toBe(true);
        expect(err.retryAfterMs).toBeGreaterThan(110_000);
        expect(err.retryAfterMs).toBeLessThanOrEqual(120_000);
    });

    test("a socket drop during the response is retryable", async () => {
        // Exercise the real SDK reader with a failing body, without depending on TCP buffering.
        const p = provider();
        (p as any).client = (p as any).client.withOptions({ fetch: async () => new Response(new ReadableStream({
            start(c) { c.enqueue(new TextEncoder().encode(prefix)); },
            pull(c) { c.error(new Error("The socket connection was closed unexpectedly")); },
        }), { headers: { "content-type": "text/event-stream" } }) });
        const err = await p.stream(req({ provider: "anthropic", id: "claude-haiku-5-5" }, [prompt]), () => {}).catch((e) => e);
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.retryable).toBe(true);
        expect(err.message).toContain("socket connection");
    });

    test.each([false, true])("a stalled Anthropic request is bounded (headers received: %s)", async (headers) => {
        const previous = stall.ms;
        stall.ms = 50;
        const ac = new AbortController();
        const guard = setTimeout(() => ac.abort(), 800);
        respond = headers ? () => sse([prefix, suffix], { pauseAfter: 0, pauseMs: 1500 }) : async () => { await Bun.sleep(1500); return sse([prefix, suffix]); };
        try {
            const err = await run(ac.signal).catch((e) => e);
            expect(err).toBeInstanceOf(ProviderError);
            expect(err.retryable).toBe(true);
            expect(err.stalled).toBe(true);
        } finally {
            clearTimeout(guard);
            stall.ms = previous;
        }
    });

    test("keep-alive pings reset the Anthropic stall timer", async () => {
        const previous = stall.ms;
        stall.ms = 150;
        respond = () => new Response(new ReadableStream({ async start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode(prefix));
            for (let i = 0; i < 5; i++) { await Bun.sleep(50); c.enqueue(enc.encode(ev("ping"))); }
            c.enqueue(enc.encode(suffix));
            c.close();
        } }), { headers: { "content-type": "text/event-stream" } });
        try { expect((await run()).content).toEqual([{ type: "text", text: "partial" }]); }
        finally { stall.ms = previous; }
    });

    test("user cancellation is not retried or classified as a stall", async () => {
        respond = () => sse([prefix, suffix], { pauseAfter: 0, pauseMs: 1000 });
        const ac = new AbortController();
        const err = await run(ac.signal, (e) => { if (e.type === "text") ac.abort(); }).catch((e) => e);
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.message).toBe("aborted");
        expect(err.retryable).toBe(false);
        expect(err.stalled).not.toBe(true);
    });

    test("authentication errors remain fatal and overload remains retryable", async () => {
        respond = () => Response.json({ type: "error", error: { type: "authentication_error", message: "bad key" } }, { status: 401 });
        expect((await run().catch((e) => e)).retryable).toBe(false);
        respond = () => sse([ev("error", { error: { type: "overloaded_error", message: "overloaded" } })]);
        expect((await run().catch((e) => e)).retryable).toBe(true);
    });

});
