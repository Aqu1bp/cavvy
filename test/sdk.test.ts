// The TypeScript SDK (src/sdk): query() against a scripted OpenAI-compatible
// server, with the real agent, tools, permissions and sessions in between.
// Covers the edge cases in its spec: abort and interrupt, errors, streaming,
// permissions, custom tools, resume, and concurrent queries.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { home: HARNESS_HOME, cleanup } = isolate();
const sdk = await import("../src/sdk/index");
const { query, tool, HarnessSdkError } = sdk;
type SDKMessage = import("../src/sdk/index").SDKMessage;
type SDKResultMessage = import("../src/sdk/index").SDKResultMessage;

// ---------------------------------------------------------------------------
// A scripted model

interface Req {
    messages: { role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }[];
    tools?: { function: { name: string } }[];
}
type Reply = { text?: string; calls?: { id: string; name: string; args: unknown }[]; delayMs?: number; status?: number; usage?: Record<string, unknown> };
type Script = (req: Req, n: number) => Reply | Promise<Reply>;

const chunk = (delta: unknown, finish?: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;

let script: Script = () => ({ text: "ok" });
const requests: Req[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        idleTimeout: 0,
        fetch: async (req) => {
            if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "m1" }] });
            const body = (await req.json()) as Req;
            requests.push(body);
            const r = await script(body, requests.length);
            if (r.status) return new Response(JSON.stringify({ error: { message: `scripted ${r.status}` } }), { status: r.status, headers: { "content-type": "application/json" } });
            const stream = new ReadableStream({
                async start(c) {
                    const enc = new TextEncoder();
                    c.enqueue(enc.encode(chunk({ role: "assistant" })));
                    if (r.text) {
                        // In two pieces, so partial messages have more than one delta.
                        const half = Math.ceil(r.text.length / 2);
                        c.enqueue(enc.encode(chunk({ content: r.text.slice(0, half) })));
                        if (r.delayMs) await Bun.sleep(r.delayMs);
                        c.enqueue(enc.encode(chunk({ content: r.text.slice(half) })));
                    } else if (r.delayMs) await Bun.sleep(r.delayMs);
                    for (const [i, call] of (r.calls ?? []).entries()) {
                        c.enqueue(enc.encode(chunk({ tool_calls: [{ index: i, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] })));
                    }
                    c.enqueue(enc.encode(chunk({}, r.calls?.length ? "tool_calls" : "stop")));
                    if (r.usage) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage: r.usage })}\n\n`));
                    c.enqueue(enc.encode("data: [DONE]\n\n"));
                    c.close();
                },
            });
            return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        },
    });
    writeFileSync(join(HARNESS_HOME, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: `http://127.0.0.1:${server.port}/v1`, kind: "openai", requiresKey: false, models: ["m1"] }] }));
});

afterAll(() => {
    server?.stop(true);
    cleanup();
});

afterEach(() => {
    script = () => ({ text: "ok" });
    requests.length = 0;
});

const MODEL = "mock:m1";
const project = () => realpathSync(tempDir("harness-sdk-"));

async function collect(q: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
    const out: SDKMessage[] = [];
    for await (const m of q) out.push(m);
    return out;
}
const results = (ms: SDKMessage[]) => ms.filter((m): m is SDKResultMessage => m.type === "result");
const of = <T extends SDKMessage["type"]>(ms: SDKMessage[], type: T) => ms.filter((m) => m.type === type) as Extract<SDKMessage, { type: T }>[];
/** Everything the model was sent in the last request, as one string. */
const lastSent = () => JSON.stringify(requests.at(-1)?.messages ?? []);

/** An async iterable whose messages the test sends one at a time. */
function channel() {
    const items: string[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    return {
        send(m: string) {
            items.push(m);
            wake?.();
        },
        end() {
            closed = true;
            wake?.();
        },
        async *[Symbol.asyncIterator]() {
            for (;;) {
                if (items.length) yield items.shift()!;
                else if (closed) return;
                else await new Promise<void>((r) => (wake = r));
                wake = undefined;
            }
        },
    };
}

async function until(fn: () => boolean, ms = 5000) {
    const end = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > end) throw new Error("timed out waiting");
        await Bun.sleep(10);
    }
}

// ---------------------------------------------------------------------------

describe("the normal path", () => {
    test("result includes child spend once and matches the saved session", async () => {
        const cwd = project();
        const usage = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 }, cost: .0123 };
        script = (_req, n) => n === 1
            ? { calls: [{ id: "task", name: "Task", args: { description: "review", prompt: "review", subagent_type: "explore" } }], usage }
            : { text: n === 2 ? "child answer" : "parent answer", usage };
        const q = query({ prompt: "delegate", options: { cwd, model: MODEL, permissionMode: "bypassPermissions" } });
        const ms = await collect(q);
        const result = results(ms)[0]!;
        expect(requests).toHaveLength(3);
        expect(result).toMatchObject({ result: "parent answer", num_turns: 2, total_cost_usd: .0369,
            usage: { input_tokens: 180, output_tokens: 60, cache_read_input_tokens: 120, cache_creation_input_tokens: 0 } });
        const { findSession, Session } = await import("../src/agent/session");
        const sessionId = await q.sessionId;
        const file = findSession(cwd, sessionId)!;
        const session = Session.load(file);
        expect(session.meta.id).toBe(sessionId);
        // usageRecords is only retained by ephemeral children; saved sessions reload aggregates.
        const savedUsage = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(line => line.t === "usage");
        expect(savedUsage).toHaveLength(3);
        expect(session.usageByModel.get(MODEL)).toMatchObject({ usage: { inputTokens: 180, outputTokens: 60, cacheReadTokens: 120, cacheWriteTokens: 0 } });
        expect(session.cost).toBeCloseTo(result.total_cost_usd, 10);
    });

    test("init, the answer and one success result; the session is saved and can be resumed", async () => {
        const cwd = project();
        script = () => ({ text: "hello from the model" });
        const q = query({ prompt: "say hi", options: { cwd, model: MODEL } });
        const ms = await collect(q);
        expect(ms[0]).toMatchObject({ type: "system", subtype: "init", cwd, model: MODEL, permission_mode: "default" });
        const init = ms[0] as Extract<SDKMessage, { subtype: "init" }>;
        expect(init.tools).toContain("Bash");
        expect(init.tools).not.toContain("AskUserQuestion");
        expect(of(ms, "assistant")[0]!.message.content).toEqual([{ type: "text", text: "hello from the model" }]);
        const [r] = results(ms);
        expect(r).toMatchObject({ type: "result", subtype: "success", is_error: false, result: "hello from the model", model: MODEL, num_turns: 1, permission_denials: [], errors: [] });
        expect(ms.at(-1)).toBe(r!);
        const id = await q.sessionId;
        expect(r!.session_id).toBe(id);

        // Resumed by id: the model sees the earlier exchange.
        script = () => ({ text: "again" });
        const again = await collect(query({ prompt: "and now?", options: { cwd, model: MODEL, resume: id.slice(0, 8) } }));
        expect(results(again)[0]!.session_id).toBe(id);
        expect(lastSent()).toContain("say hi");
        expect(lastSent()).toContain("hello from the model");
    });

    test("continue: true picks the latest session; persistSession: false leaves no file", async () => {
        const cwd = project();
        const first = query({ prompt: "one", options: { cwd, model: MODEL } });
        await collect(first);
        const cont = query({ prompt: "two", options: { cwd, model: MODEL, continue: true } });
        await collect(cont);
        expect(await cont.sessionId).toBe(await first.sessionId);

        const other = project();
        const q = query({ prompt: "x", options: { cwd: other, model: MODEL, persistSession: false } });
        await collect(q);
        const { listSessions } = await import("../src/agent/session");
        expect(listSessions(other)).toEqual([]);
    });

    test("partial messages only when asked for", async () => {
        const cwd = project();
        script = () => ({ text: "streamed text" });
        const plain = await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false } }));
        expect(of(plain, "stream_event")).toEqual([]);
        const partial = await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false, includePartialMessages: true } }));
        const deltas = of(partial, "stream_event");
        expect(deltas.length).toBeGreaterThan(1);
        expect(deltas.map((d) => d.event.text).join("")).toBe("streamed text");
        // Deltas come before the full message.
        expect(partial.indexOf(deltas.at(-1)!)).toBeLessThan(partial.findIndex((m) => m.type === "assistant"));
    });

    test("settings from options are merged in (an env var reaches Bash)", async () => {
        const cwd = project();
        script = (_req, n) => (n === 1 ? { calls: [{ id: "c1", name: "Bash", args: { command: "echo $SDK_VAR" } }] } : { text: "done" });
        const ms = await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false, settings: { env: { SDK_VAR: "from-options" } } } }));
        expect(of(ms, "tool_result")[0]).toMatchObject({ tool: "Bash", is_error: false });
        expect(of(ms, "tool_result")[0]!.content).toContain("from-options");
    });
});

describe("custom tools", () => {
    test("the model calls it, the handler gets the input and the result goes back", async () => {
        const cwd = project();
        const seen: unknown[] = [];
        const weather = tool("get_weather", "The weather in a city", { type: "object", properties: { city: { type: "string" } }, required: ["city"] }, async (input: { city: string }, ctx) => {
            seen.push({ input, cwd: ctx.cwd, signal: ctx.signal instanceof AbortSignal });
            return `Sunny in ${input.city}`;
        });
        script = (_req, n) => (n === 1 ? { calls: [{ id: "c1", name: "get_weather", args: { city: "Paris" } }] } : { text: "It is sunny." });
        const ms = await collect(query({ prompt: "weather?", options: { cwd, model: MODEL, persistSession: false, tools: [weather] } }));
        expect(requests[0]!.tools!.map((t) => t.function.name)).toContain("get_weather");
        expect(seen).toEqual([{ input: { city: "Paris" }, cwd, signal: true }]);
        expect(of(ms, "tool_result")).toEqual([expect.objectContaining({ tool: "get_weather", tool_use_id: "c1", is_error: false, content: "Sunny in Paris" })]);
        expect(lastSent()).toContain("Sunny in Paris");
        expect(results(ms)[0]).toMatchObject({ subtype: "success", result: "It is sunny.", num_turns: 2 });
    });

    test("a throwing handler is an error result and the turn goes on; a bad return value too", async () => {
        const cwd = project();
        const boom = tool("boom", "fails", { type: "object", properties: {} }, () => {
            throw new Error("kaput");
        });
        const odd = tool("odd", "returns a number", {}, () => 42 as any);
        script = (_req, n) => (n === 1 ? { calls: [{ id: "c1", name: "boom", args: {} }, { id: "c2", name: "odd", args: {} }] } : { text: "recovered" });
        const ms = await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false, tools: [boom, odd] } }));
        const [a, b] = of(ms, "tool_result");
        expect(a).toMatchObject({ tool: "boom", is_error: true });
        expect(a!.content).toContain("kaput");
        expect(b).toMatchObject({ tool: "odd", is_error: true });
        expect(results(ms)[0]).toMatchObject({ subtype: "success", result: "recovered" });
    });

    test("deny rules still apply, and plan mode refuses tools not marked read-only", async () => {
        const cwd = project();
        let calls = 0;
        const t = tool("write_db", "writes", {}, () => (calls++, "written"));
        const r = tool("read_db", "reads", {}, () => (calls++, "rows"), { readOnly: true });
        script = (_req, n) => (n === 1 ? { calls: [{ id: "c1", name: "write_db", args: {} }] } : { text: "ok" });
        const denied = await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false, tools: [t], disallowedTools: ["write_db"] } }));
        expect(of(denied, "tool_result")[0]).toMatchObject({ is_error: true });
        expect(calls).toBe(0);

        requests.length = 0;
        script = (_req, n) => (n === 1 ? { calls: [{ id: "c1", name: "write_db", args: {} }, { id: "c2", name: "read_db", args: {} }] } : { text: "ok" });
        const plan = await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false, tools: [t, r], permissionMode: "plan" } }));
        const [w, rd] = of(plan, "tool_result");
        expect(w).toMatchObject({ tool: "write_db", is_error: true });
        expect(w!.content).toContain("Plan mode");
        expect(rd).toMatchObject({ tool: "read_db", is_error: false, content: "rows" });
        expect(calls).toBe(1);
    });

    test("an ask rule on a tool's name sends it to canUseTool", async () => {
        const cwd = project();
        const t = tool("deploy", "deploys", {}, () => "deployed");
        script = (_req, n) => (n === 1 ? { calls: [{ id: "c1", name: "deploy", args: {} }] } : { text: "ok" });
        const asked: string[] = [];
        const ms = await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false, tools: [t], settings: { permissions: { ask: ["deploy"] } }, canUseTool: (name) => (asked.push(name), { behavior: "allow" }) } }));
        expect(asked).toEqual(["deploy"]);
        expect(of(ms, "tool_result")[0]).toMatchObject({ is_error: false, content: "deployed" });
    });

    test("bad definitions are refused", async () => {
        expect(() => tool("has space", "", {}, () => "")).toThrow(TypeError);
        expect(() => tool("ok", "", [] as any, () => "")).toThrow(TypeError);
        expect(() => tool("ok", "", {}, "nope" as any)).toThrow(TypeError);
        const cwd = project();
        const clash = tool("Bash", "mine", {}, () => "");
        await expect(collect(query({ prompt: "x", options: { cwd, model: MODEL, tools: [clash] } }))).rejects.toThrow(/built-in tool/);
        const a = tool("dup", "", {}, () => "");
        await expect(collect(query({ prompt: "x", options: { cwd, model: MODEL, tools: [a, a] } }))).rejects.toThrow(/two tools/);
        await expect(collect(query({ prompt: "x", options: { cwd, model: MODEL, tools: [{ name: "x" } as any] } }))).rejects.toThrow(/tool\(\)/);
    });
});

describe("permissions", () => {
    // Writing a file in the default mode needs approval.
    const touch = (_req: Req, n: number): Reply => (n === 1 ? { calls: [{ id: "c1", name: "Bash", args: { command: "touch made.txt" } }] } : { text: "finished" });

    test("without canUseTool the call is denied and listed", async () => {
        const cwd = project();
        script = touch;
        const ms = await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false } }));
        expect(of(ms, "tool_result")[0]!.content).toContain("not granted");
        expect(results(ms)[0]!.permission_denials).toEqual(["Bash"]);
        expect(existsSync(join(cwd, "made.txt"))).toBe(false);
    });

    test("canUseTool sees the call and allows it", async () => {
        const cwd = project();
        script = touch;
        const asked: any[] = [];
        const ms = await collect(
            query({
                prompt: "x",
                options: { cwd, model: MODEL, persistSession: false, canUseTool: (name, input, ctx) => (asked.push({ name, input, title: ctx.title, id: ctx.toolUseId, signal: ctx.signal instanceof AbortSignal }), { behavior: "allow" }) },
            }),
        );
        expect(asked).toEqual([{ name: "Bash", input: expect.objectContaining({ command: "touch made.txt" }), title: expect.stringContaining("touch made.txt"), id: "c1", signal: true }]);
        expect(existsSync(join(cwd, "made.txt"))).toBe(true);
        expect(results(ms)[0]).toMatchObject({ subtype: "success", permission_denials: [] });
    });

    test("a denial with a message reaches the model and the turn goes on; without one the turn stops", async () => {
        const cwd = project();
        script = touch;
        const told = await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false, canUseTool: () => ({ behavior: "deny", message: "use the scratch folder" }) } }));
        expect(lastSent()).toContain("use the scratch folder");
        expect(results(told)[0]).toMatchObject({ subtype: "success", result: "finished", permission_denials: ["Bash"] });

        requests.length = 0;
        const stopped = await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false, canUseTool: () => ({ behavior: "deny" }) } }));
        expect(requests.length).toBe(1);
        expect(results(stopped)[0]).toMatchObject({ is_error: true, subtype: "error_during_execution", permission_denials: ["Bash"] });
        expect(existsSync(join(cwd, "made.txt"))).toBe(false);
    });

    test("a throwing canUseTool denies, with a notice; rules it returns hold for the query", async () => {
        const cwd = project();
        script = touch;
        const ms = await collect(
            query({
                prompt: "x",
                options: {
                    cwd,
                    model: MODEL,
                    persistSession: false,
                    canUseTool: async () => {
                        throw new Error("policy service down");
                    },
                },
            }),
        );
        expect(of(ms, "system").some((m) => m.subtype === "notice" && m.message.includes("policy service down"))).toBe(true);
        expect(results(ms)[0]!.permission_denials).toEqual(["Bash"]);

        // Allowed once with the suggested rule: the same command again isn't asked about.
        script = (_req, n) => (n <= 2 ? { calls: [{ id: `c${n}`, name: "Bash", args: { command: "touch again.txt" } }] } : { text: "ok" });
        requests.length = 0;
        let asked = 0;
        await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false, canUseTool: (_n, _i, ctx) => (asked++, { behavior: "allow", rules: ctx.suggestions.length ? ctx.suggestions : ["Bash(touch:*)"] }) } }));
        expect(asked).toBe(1);
    });

    test("disallowedTools beats canUseTool; bypassPermissions needs no answer", async () => {
        const cwd = project();
        script = touch;
        let asked = 0;
        await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false, disallowedTools: ["Bash"], canUseTool: () => (asked++, { behavior: "allow" }) } }));
        expect(asked).toBe(0);
        expect(existsSync(join(cwd, "made.txt"))).toBe(false);
        requests.length = 0;
        await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false, permissionMode: "bypassPermissions", canUseTool: () => (asked++, { behavior: "deny" }) } }));
        expect(asked).toBe(0);
        expect(existsSync(join(cwd, "made.txt"))).toBe(true);
    });

    test("setPermissionMode applies to the turns after it", async () => {
        const cwd = project();
        const input = channel();
        script = (req) => (req.messages.at(-1)?.role === "tool" ? { text: "done" } : { calls: [{ id: `c${requests.length}`, name: "Bash", args: { command: `touch f${requests.length}.txt` } }] });
        const q = query({ prompt: input, options: { cwd, model: MODEL, persistSession: false } });
        const seen: SDKMessage[] = [];
        input.send("first");
        for await (const m of q) {
            seen.push(m);
            if (m.type === "result" && results(seen).length === 1) {
                await q.setPermissionMode("acceptEdits");
                await q.setPermissionMode("bypassPermissions");
                input.send("second");
                input.end();
            }
        }
        const [a, b] = results(seen);
        expect(a!.permission_denials).toEqual(["Bash"]);
        expect(b!.permission_denials).toEqual([]);
        await expect(q.setPermissionMode("nonsense" as any)).rejects.toThrow(HarnessSdkError);
    });
});

describe("abort and interrupt", () => {
    test("abortController mid-response: the turn reports error_aborted and the query ends", async () => {
        const cwd = project();
        script = () => ({ text: "slow answer", delayMs: 5000 });
        const ac = new AbortController();
        const q = query({ prompt: "x", options: { cwd, model: MODEL, abortController: ac } });
        const started = Date.now();
        const ms: SDKMessage[] = [];
        for await (const m of q) {
            ms.push(m);
            if (m.type === "system" && m.subtype === "init") setTimeout(() => ac.abort(), 100);
        }
        expect(Date.now() - started).toBeLessThan(4000);
        expect(results(ms)).toEqual([expect.objectContaining({ subtype: "error_aborted", is_error: true })]);
        // Released: the session can be resumed right away.
        const id = await q.sessionId;
        script = () => ({ text: "ok" });
        expect(results(await collect(query({ prompt: "y", options: { cwd, model: MODEL, resume: id } })))[0]!.subtype).toBe("success");
    });

    test("aborted before it starts: no messages, nothing saved", async () => {
        const cwd = project();
        const ac = new AbortController();
        ac.abort();
        expect(await collect(query({ prompt: "x", options: { cwd, model: MODEL, abortController: ac } }))).toEqual([]);
        expect(requests.length).toBe(0);
    });

    test("interrupt() stops a turn waiting on canUseTool, and a streaming query goes on", async () => {
        const cwd = project();
        const input = channel();
        script = (req) => (lastSentOf(req).includes("second") ? { text: "second answer" } : { calls: [{ id: "c1", name: "Bash", args: { command: "touch never.txt" } }] });
        let signalled = false;
        const q = query({
            prompt: input,
            options: {
                cwd,
                model: MODEL,
                persistSession: false,
                // Never answers: only the interrupt ends the wait.
                canUseTool: (_n, _i, ctx) => new Promise(() => ctx.signal.addEventListener("abort", () => (signalled = true))),
            },
        });
        input.send("first");
        const seen: SDKMessage[] = [];
        const reading = (async () => {
            for await (const m of q) {
                seen.push(m);
                if (m.type === "result" && results(seen).length === 1) {
                    input.send("second");
                    input.end();
                }
            }
        })();
        await until(() => requests.length === 1);
        await Bun.sleep(100);
        await q.interrupt();
        await reading;
        const [a, b] = results(seen);
        expect(a).toMatchObject({ subtype: "error_aborted" });
        expect(b).toMatchObject({ subtype: "success", result: "second answer" });
        expect(signalled).toBe(true);
        expect(existsSync(join(cwd, "never.txt"))).toBe(false);
    });

    test("breaking out of for-await closes the query: shells stop and the session is let go", async () => {
        const cwd = project();
        script = (_req, n) => (n === 1 ? { calls: [{ id: "c1", name: "Bash", args: { command: "sleep 30", run_in_background: true } }] } : { text: "started", delayMs: 3000 });
        const q = query({ prompt: "x", options: { cwd, model: MODEL, permissionMode: "bypassPermissions" } });
        for await (const m of q) if (m.type === "tool_result") break;
        const id = await q.sessionId;
        // A second query on the same session works only once the first let go of it.
        script = () => ({ text: "ok" });
        expect(results(await collect(query({ prompt: "y", options: { cwd, model: MODEL, resume: id } })))[0]!.subtype).toBe("success");
        // next() after close: done.
        expect(await q.next()).toEqual({ done: true, value: undefined });
    });

    test("close() before iterating: nothing runs", async () => {
        const q = query({ prompt: "x", options: { cwd: project(), model: MODEL } });
        await q.close();
        expect(await q.next()).toEqual({ done: true, value: undefined });
        await expect(q.sessionId).rejects.toThrow();
        expect(requests.length).toBe(0);
    });
});

const lastSentOf = (req: Req) => JSON.stringify(req.messages.at(-1) ?? "");

describe("errors", () => {
    test("bad options and models throw HarnessSdkError from the iterator", async () => {
        const cwd = project();
        const first = (o: any) => query({ prompt: "x", options: { cwd, ...o } }).next();
        await expect(first({ model: "not-a-ref" })).rejects.toThrow(HarnessSdkError);
        await expect(first({ model: "nosuch:model" })).rejects.toThrow(/Invalid model/);
        await expect(first({ model: MODEL, resume: "zzzzzz" })).rejects.toThrow(/No session matching/);
        await expect(first({ model: MODEL, permissionMode: "yolo" })).rejects.toThrow(/permissionMode/);
        await expect(first({ model: MODEL, maxTurns: 0 })).rejects.toThrow(/maxTurns/);
        await expect(first({ model: MODEL, cwd: join(cwd, "missing") })).rejects.toThrow(/not a folder/);
        expect(() => query({ prompt: 42 as any })).toThrow(TypeError);
        expect(requests.length).toBe(0);
    });

    test("a provider error is an error result with the reason", async () => {
        const cwd = project();
        script = () => ({ status: 400 });
        const ms = await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false } }));
        const [r] = results(ms);
        expect(r).toMatchObject({ is_error: true, subtype: "error_during_execution" });
        expect(r!.errors.join("\n")).toContain("scripted 400");
    });

    test("maxTurns ends the turn with error_max_turns", async () => {
        const cwd = project();
        script = (_req, n) => ({ calls: [{ id: `c${n}`, name: "Read", args: { file_path: join(cwd, "nothing") } }] });
        const ms = await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false, maxTurns: 2 } }));
        expect(results(ms)[0]).toMatchObject({ subtype: "error_max_turns", is_error: true });
    });

    test("an input iterable that throws ends the query with its error, after cleanup", async () => {
        const cwd = project();
        async function* input() {
            yield "first";
            await Bun.sleep(50);
            throw new Error("input broke");
        }
        const q = query({ prompt: input(), options: { cwd, model: MODEL } });
        const seen: SDKMessage[] = [];
        await expect(
            (async () => {
                for await (const m of q) seen.push(m);
            })(),
        ).rejects.toThrow("input broke");
        const id = await q.sessionId;
        expect(results(await collect(query({ prompt: "y", options: { cwd, model: MODEL, resume: id } })))[0]!.subtype).toBe("success");
    });

    test("a malformed streaming message is an error", async () => {
        async function* input() {
            yield { type: "nope" } as any;
        }
        await expect(collect(query({ prompt: input(), options: { cwd: project(), model: MODEL, persistSession: false } }))).rejects.toThrow(/prompt message/);
    });
});

describe("streaming input", () => {
    test("each message is a turn with its own result, in one conversation", async () => {
        const cwd = project();
        script = (req) => ({ text: `answer to ${(lastSentOf(req).match(/q\d/) ?? ["?"])[0]}` });
        async function* input() {
            yield "q1";
            yield { type: "user" as const, content: "q2" };
        }
        const ms = await collect(query({ prompt: input(), options: { cwd, model: MODEL, persistSession: false } }));
        expect(of(ms, "system").filter((m) => m.subtype === "init").length).toBe(1);
        expect(results(ms).map((r) => r.result)).toEqual(["answer to q1", "answer to q2"]);
        // The second request carries the first exchange.
        expect(JSON.stringify(requests[1]!.messages)).toContain("answer to q1");
    });

    test("messages read while a turn runs wait for their own turn", async () => {
        const cwd = project();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const wait = tool("wait", "waits", {}, async () => (await gate, "waited"));
        script = (req) => (lastSentOf(req).includes("first") ? { calls: [{ id: "c1", name: "wait", args: {} }] } : { text: "next" });
        async function* input() {
            yield "first";
            yield "second";
            release();
        }
        const ms = await collect(query({ prompt: input(), options: { cwd, model: MODEL, persistSession: false, tools: [wait] } }));
        expect(results(ms)).toHaveLength(2);
        expect(JSON.stringify(requests[1]!.messages)).not.toContain("second");
    });

    test("steer() reaches the running turn between tool calls", async () => {
        const cwd = project();
        const input = channel();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let entered = false;
        const wait = tool("wait", "waits", {}, async () => {
            entered = true;
            await gate;
            return "waited";
        });
        script = (_req, n) => (n === 1 ? { calls: [{ id: "c1", name: "wait", args: {} }] } : { text: "saw it" });
        const q = query({ prompt: input, options: { cwd, model: MODEL, persistSession: false, tools: [wait] } });
        input.send("start");
        const reading = collect(q);
        await until(() => entered);
        expect(await q.steer("also check the README")).toBe(true);
        release();
        input.end();
        const ms = await reading;
        expect(JSON.stringify(requests[1]!.messages)).toContain("also check the README");
        expect(results(ms)).toHaveLength(1);
        expect(await q.steer("too late")).toBe(false);
    });
});

// #222: a steered message's UserPromptSubmit hooks run while it's still queued.
describe("UserPromptSubmit on steer()", () => {
    test("interrupted while its hooks run, it isn't lost: it's the next turn", async () => {
        const cwd = project();
        const marker = join(cwd, "hook-started");
        // Slow only the first time, so the turn it starts doesn't wait too.
        const settings = { hooks: { UserPromptSubmit: [{ command: `grep -q steered || exit 0; [ -f ${marker} ] && exit 0; touch ${marker}; exec sleep 10` }] } };
        script = (req) => (lastSentOf(req).includes("steered") ? { text: "got the steer" } : { text: "first answer", delayMs: 300 });
        const input = channel();
        const q = query({ prompt: input, options: { cwd, model: MODEL, persistSession: false, settings } });
        input.send("start");
        const reading = collect(q);
        await until(() => requests.length === 1);
        expect(await q.steer("the steered one")).toBe(true);
        await until(() => existsSync(marker));
        await q.interrupt();
        await until(() => requests.length === 2);
        input.end();
        const ms = await reading;
        expect(lastSent()).toContain("the steered one");
        expect(results(ms).map((r) => r.result)).toContain("got the steer");
    });
});

describe("concurrent queries", () => {
    test("two at once keep their own sessions, messages and tool state", async () => {
        const a = project();
        const b = project();
        script = async (req) => {
            const who = lastSentOf(req).includes("alpha") ? "alpha" : "beta";
            await Bun.sleep(who === "alpha" ? 150 : 10);
            return { text: `reply-${who}` };
        };
        const qa = query({ prompt: "alpha", options: { cwd: a, model: MODEL } });
        const qb = query({ prompt: "beta", options: { cwd: b, model: MODEL } });
        const [ma, mb] = await Promise.all([collect(qa), collect(qb)]);
        expect(results(ma)[0]!.result).toBe("reply-alpha");
        expect(results(mb)[0]!.result).toBe("reply-beta");
        const [ia, ib] = await Promise.all([qa.sessionId, qb.sessionId]);
        expect(ia).not.toBe(ib);
        expect(ma.every((m) => !("session_id" in m) || m.session_id === ia)).toBe(true);
        expect(mb.every((m) => !("session_id" in m) || m.session_id === ib)).toBe(true);
    });

    test("two in the same folder work; resuming a session another query has open is refused", async () => {
        const cwd = project();
        script = () => ({ text: "ok" });
        const [m1, m2] = await Promise.all([collect(query({ prompt: "1", options: { cwd, model: MODEL } })), collect(query({ prompt: "2", options: { cwd, model: MODEL } }))]);
        expect(results(m1)[0]!.session_id).not.toBe(results(m2)[0]!.session_id);

        const input = channel();
        const open = query({ prompt: input, options: { cwd, model: MODEL } });
        input.send("hold it open");
        const seen: SDKMessage[] = [];
        const reading = (async () => {
            for await (const m of open) seen.push(m);
        })();
        const id = await open.sessionId;
        // On disk once the first prompt is.
        await until(() => results(seen).length === 1);
        await expect(collect(query({ prompt: "x", options: { cwd, model: MODEL, resume: id } }))).rejects.toThrow(/open in another query/);
        input.end();
        await reading;
    });
});

describe("found in review", () => {
    test("steer() before iterating runs after the prompt, not before it", async () => {
        const cwd = project();
        script = (req) => ({ text: `re: ${lastSentOf(req).includes("B") ? "B" : "A"}` });
        const q = query({ prompt: "A", options: { cwd, model: MODEL, persistSession: false } });
        expect(await q.steer("B")).toBe(true);
        expect(results(await collect(q)).map((r) => r.result)).toEqual(["re: A", "re: B"]);
    });

    test("setPermissionMode checks the mode before the query starts; every mode is accepted", async () => {
        const { PERMISSION_MODES } = await import("../src/permissions/modes");
        const q = query({ prompt: "x", options: { cwd: project(), model: MODEL, persistSession: false } });
        await expect(q.setPermissionMode("bogus" as any)).rejects.toThrow(HarnessSdkError);
        for (const m of PERMISSION_MODES) await q.setPermissionMode(m);
        const ms = await collect(q);
        expect(ms[0]).toMatchObject({ subtype: "init", permission_mode: "bypassPermissions" });
    });

    test("init comes first, even with warnings; a folder trusted for being empty is judged again by the next query", async () => {
        const cwd = project();
        await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false } }));
        // Project settings appear after the first query.
        mkdirSync(join(cwd, ".harness"), { recursive: true });
        writeFileSync(join(cwd, ".harness", "settings.json"), JSON.stringify({ env: { FROM_PROJECT: "yes" } }));
        script = (_req, n) => (n === 1 ? { calls: [{ id: "c1", name: "Bash", args: { command: "echo [$FROM_PROJECT]" } }] } : { text: "ok" });
        requests.length = 0;
        const ms = await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false, permissionMode: "bypassPermissions" } }));
        expect(ms[0]).toMatchObject({ type: "system", subtype: "init" });
        expect(ms[1]).toMatchObject({ type: "system", subtype: "notice", level: "warn" });
        expect((ms[1] as any).message).toContain("isn't trusted");
        expect(of(ms, "tool_result")[0]!.content).toContain("[]");

        // Asked for, the project's settings load.
        requests.length = 0;
        const trusted = await collect(query({ prompt: "x", options: { cwd, model: MODEL, persistSession: false, permissionMode: "bypassPermissions", trusted: true } }));
        expect(of(trusted, "tool_result")[0]!.content).toContain("[yes]");
    });

    test("a folder trusted for having no project configuration gets its memory files, without trusting it for the process", async () => {
        const { isTrusted } = await import("../src/config/trust");
        const cwd = project();
        writeFileSync(join(cwd, "AGENTS.md"), "EMPTY-FOLDER-MEMORY-MARKER");
        const definition = join(HARNESS_HOME, "agents", "sdk-memory-reader.md");
        mkdirSync(join(HARNESS_HOME, "agents"), { recursive: true });
        writeFileSync(definition, "---\nname: sdk-memory-reader\ndescription: reader\nmemory: project\n---\nMEMORY-READER-MARKER");
        mkdirSync(join(cwd, ".harness", "agent-memory", "sdk-memory-reader"), { recursive: true });
        writeFileSync(join(cwd, ".harness", "agent-memory", "sdk-memory-reader", "MEMORY.md"), "EMPTY-FOLDER-AGENT-MEMORY-MARKER");
        try {
            script = (_req, n) => (n === 1 ? { calls: [{ id: "task", name: "Task", args: { description: "read", prompt: "review", subagent_type: "sdk-memory-reader" } }] } : { text: "done" });
            const ms = await collect(query({ prompt: "hello", options: { cwd, model: MODEL, persistSession: false, permissionMode: "bypassPermissions" } }));
            expect(results(ms)[0]!.subtype).toBe("success");
            expect(of(ms, "system").filter((m) => m.subtype === "notice")).toEqual([]);
            expect(JSON.stringify(requests[0]!.messages)).toContain("EMPTY-FOLDER-MEMORY-MARKER");
            const child = requests.find((r) => JSON.stringify(r.messages).includes("MEMORY-READER-MARKER"));
            expect(JSON.stringify(child!.messages)).toContain("EMPTY-FOLDER-AGENT-MEMORY-MARKER");
            // The decision was this query's: the folder isn't trusted for the rest of the process.
            expect(isTrusted(cwd)).toBe(false);
        } finally {
            rmSync(definition, { force: true });
        }
    });

    test("persistSession: false with resume leaves the session file as it was", async () => {
        const cwd = project();
        const first = query({ prompt: "keep me", options: { cwd, model: MODEL } });
        await collect(first);
        const id = await first.sessionId;
        const { findSession } = await import("../src/agent/session");
        const file = findSession(cwd, id)!;
        const before = readFileSync(file, "utf-8");
        const again = await collect(query({ prompt: "don't save me", options: { cwd, model: MODEL, resume: id, persistSession: false } }));
        expect(results(again)[0]!.subtype).toBe("success");
        expect(lastSent()).toContain("keep me");
        expect(readFileSync(file, "utf-8")).toBe(before);
    });

    test("next() calls in flight together each get a message", async () => {
        const q = query({ prompt: "x", options: { cwd: project(), model: MODEL, persistSession: false } });
        const [a, b, c] = await Promise.all([q.next(), q.next(), q.next()]);
        expect([a, b, c].map((r) => (r.done ? "done" : r.value.type))).toEqual(["system", "assistant", "result"]);
        expect((await q.next()).done).toBe(true);
    });

    test("close() doesn't wait for an input that never comes", async () => {
        async function* input() {
            yield "first";
            await new Promise(() => {});
        }
        const q = query({ prompt: input(), options: { cwd: project(), model: MODEL, persistSession: false } });
        for await (const m of q) if (m.type === "result") break;
        const t = Date.now();
        await q.close();
        expect(Date.now() - t).toBeLessThan(2000);
    });
});

describe("trusted: false in a folder the user trusted", () => {
    // Claude Code through the fake CLI (test/fixtures/fake-claude.ts): it runs the project's SessionStart
    // hooks unless --setting-sources leaves "project" out.
    function trustedRepo() {
        const cwd = project();
        mkdirSync(join(cwd, ".claude"), { recursive: true });
        writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${join(cwd, "hook-ran")}` }] }] } }));
        mkdirSync(join(cwd, ".harness", "agents"), { recursive: true });
        writeFileSync(join(cwd, ".harness", "agents", "repo-agent.md"), "---\nname: repo-agent\ndescription: from the repository\n---\nRepository instructions.");
        writeFileSync(join(cwd, "AGENTS.md"), "REPO-MEMORY-MARKER");
        return cwd;
    }

    test("Claude Code doesn't load the project's settings or run its hooks", async () => {
        const { saveAgentConfig } = await import("../src/providers/registry");
        const { forgetClient } = await import("../src/providers/models");
        const { trustFolder } = await import("../src/config/trust");
        const bin = tempDir("harness-sdk-bin-");
        const claude = join(bin, "claude");
        const log = join(bin, "log.jsonl");
        writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-claude.ts")}" "$@"\n`);
        chmodSync(claude, 0o755);
        saveAgentConfig("claude-code", { path: claude });
        forgetClient("claude-code");
        process.env.FAKE_LOG = log;
        process.env.FAKE_SCENARIO = "silent";
        try {
            const cwd = trustedRepo();
            trustFolder(cwd);
            const ms = await collect(query({ prompt: "hello", options: { cwd, model: "claude-code:default", trusted: false, persistSession: false, canUseTool: () => ({ behavior: "deny" }) } }));
            expect(ms[0]).toMatchObject({ subtype: "init", agent_backend: expect.any(String) });
            // Every launch (the turn's, and any side request's) leaves the project's settings out.
            const launches = readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => Array.isArray(l.argv)).map((l) => l.argv as string[]);
            expect(launches.length).toBeGreaterThan(0);
            for (const argv of launches) {
                expect(argv).toContain("--setting-sources");
                expect(argv[argv.indexOf("--setting-sources") + 1]).not.toContain("project");
            }
            expect(existsSync(join(cwd, "hook-ran"))).toBe(false);
        } finally {
            delete process.env.FAKE_LOG;
            delete process.env.FAKE_SCENARIO;
        }
    });

    test("the harness's own agent doesn't load the project's memory files or agents", async () => {
        const { trustFolder } = await import("../src/config/trust");
        const cwd = trustedRepo();
        trustFolder(cwd);
        script = (req) => (JSON.stringify(req.messages).includes('"Task"') || req.messages.at(-1)?.role === "tool" ? { text: "ok" } : { calls: [{ id: "c1", name: "Task", args: { description: "d", prompt: "p", subagent_type: "repo-agent" } }] });
        const ms = await collect(query({ prompt: "hello", options: { cwd, model: MODEL, trusted: false, persistSession: false, permissionMode: "bypassPermissions" } }));
        expect(JSON.stringify(requests[0]!.messages)).not.toContain("REPO-MEMORY-MARKER");
        expect(of(ms, "tool_result")[0]!.content).toMatch(/repo-agent/);
        expect(of(ms, "tool_result")[0]!.is_error).toBe(true);

        // Trusted, both load: the test reaches what it means to.
        requests.length = 0;
        await collect(query({ prompt: "hello", options: { cwd, model: MODEL, persistSession: false, permissionMode: "bypassPermissions" } }));
        expect(JSON.stringify(requests[0]!.messages)).toContain("REPO-MEMORY-MARKER");
    });
});

describe("SDK integration with skills and subagent definitions", () => {
    test("explicit distrust also excludes project skills and memory preloaded by a user agent", async () => {
        const { trustFolder } = await import("../src/config/trust");
        const cwd = project();
        const definition = join(HARNESS_HOME, "agents", "sdk-reader.md");
        const write = (file: string, body: string) => {
            mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
            writeFileSync(file, body);
        };
        write(definition, "---\nname: sdk-reader\ndescription: reader\nskills: [sdk-project-skill]\nmemory: project\n---\nUSER-AGENT-MARKER");
        write(join(cwd, ".harness", "skills", "sdk-project-skill", "SKILL.md"), "---\ndescription: project skill\n---\nPROJECT-SKILL-MARKER");
        write(join(cwd, ".harness", "agent-memory", "sdk-reader", "MEMORY.md"), "PROJECT-AGENT-MEMORY-MARKER");
        trustFolder(cwd);
        try {
            for (const trusted of [false, true]) {
                requests.length = 0;
                script = (_req, n) => n === 1 ? { calls: [{ id: "task", name: "Task", args: { description: "read", prompt: "review", subagent_type: "sdk-reader" } }] } : { text: "done" };
                const ms = await collect(query({ prompt: "delegate", options: { cwd, model: MODEL, trusted, persistSession: false, permissionMode: "bypassPermissions" } }));
                expect(results(ms)[0]!.subtype).toBe("success");
                const child = requests.find((r) => JSON.stringify(r.messages).includes("USER-AGENT-MARKER"));
                expect(child).toBeDefined();
                const sent = JSON.stringify(child!.messages);
                expect(sent.includes("PROJECT-SKILL-MARKER")).toBe(trusted);
                expect(sent.includes("PROJECT-AGENT-MEMORY-MARKER")).toBe(trusted);
                expect(requests[0]!.tools?.some((t) => t.function.name === "Skill")).toBe(trusted);
            }
        } finally {
            rmSync(definition, { force: true });
        }
    });

    test("headless keeps slash and dollar skill expansion and exposes the Skill tool", async () => {
        const cwd = project();
        const skillDir = join(cwd, ".harness", "skills", "sdk-explain");
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, "SKILL.md"), "---\ndescription: explain\n---\nSKILL-BODY-MARKER $ARGUMENTS @nonexistent.txt");
        const { runHeadless } = await import("../src/headless");
        const realWrite = process.stdout.write;
        try {
            for (const prompt of ["/sdk-explain topic", "use $sdk-explain please"]) {
                requests.length = 0;
                let out = "";
                process.stdout.write = ((s: string) => ((out += s), true)) as any;
                const code = await runHeadless({ cwd, prompt, trusted: true, modelRef: MODEL, mode: "default", outputFormat: "stream-json", verbose: false, allowedTools: [], disallowedTools: [], addDirs: [], startupNotes: [] });
                expect(code).toBe(0);
                expect(JSON.stringify(requests[0]!.messages)).toContain("SKILL-BODY-MARKER");
                expect(JSON.stringify(requests[0]!.messages)).toContain("@nonexistent.txt");
                expect(requests[0]!.tools?.some((t) => t.function.name === "Skill")).toBe(true);
                expect(JSON.parse(out.split("\n")[0]!).tools).toContain("Skill");
            }
        } finally {
            process.stdout.write = realWrite;
        }
    });
});

describe("found in the Codex review", () => {
    /** A fake agent CLI (test/fixtures/fake-*.ts) in place of the real one, logging what it gets. */
    async function fakeCli(provider: "claude-code" | "codex", env: Record<string, string>) {
        const { saveAgentConfig } = await import("../src/providers/registry");
        const { forgetClient } = await import("../src/providers/models");
        const bin = tempDir("harness-sdk-bin-");
        const exe = join(bin, provider === "codex" ? "codex" : "claude");
        const log = join(bin, "log.jsonl");
        writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", provider === "codex" ? "fake-codex.ts" : "fake-claude.ts")}" "$@"\n`);
        chmodSync(exe, 0o755);
        saveAgentConfig(provider, { path: exe });
        forgetClient(provider);
        const all = { FAKE_LOG: log, ...env };
        for (const [k, v] of Object.entries(all)) process.env[k] = v;
        return {
            lines: () => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l)) : []),
            restore: () => {
                for (const k of Object.keys(all)) delete process.env[k];
            },
        };
    }

    test("setPermissionMode() mid-turn reaches Claude Code's running turn", async () => {
        const cli = await fakeCli("claude-code", { FAKE_SCENARIO: "bash" });
        try {
            const cwd = project();
            // Changed while Claude Code waits on a prompt: its turn is running then.
            let q!: ReturnType<typeof query>;
            q = query({
                prompt: "run the tests",
                options: {
                    cwd,
                    model: "claude-code:default",
                    persistSession: false,
                    canUseTool: async () => {
                        await q.setPermissionMode("plan");
                        return { behavior: "allow" };
                    },
                },
            });
            await collect(q);
            const sent = cli.lines().filter((l) => l.received?.request?.subtype === "set_permission_mode").map((l) => l.received.request.mode);
            expect(sent).toContain("plan");
        } finally {
            cli.restore();
        }
    });

    test("setPermissionMode() tells an API model with its next message, as the terminal does", async () => {
        const input = channel();
        const q = query({ prompt: input, options: { cwd: project(), model: MODEL, persistSession: false } });
        input.send("one");
        for await (const m of q) {
            if (m.type !== "result") continue;
            if (requests.length === 1) {
                await q.setPermissionMode("acceptEdits");
                input.send("two");
            } else input.end();
        }
        expect(JSON.stringify(requests[0]!.messages)).not.toContain("switched the permission mode");
        expect(JSON.stringify(requests[1]!.messages)).toContain("switched the permission mode");
    });

    test("steer() goes into Codex's running turn (turn/steer), not after it", async () => {
        const cli = await fakeCli("codex", { FAKE_SCENARIO: "slow", FAKE_STEER_WAKES: "1" });
        try {
            const cwd = project();
            const q = query({ prompt: "start", options: { cwd, model: "codex:default", persistSession: false, permissionMode: "bypassPermissions" } });
            const out: SDKMessage[] = [];
            const t = Date.now();
            for await (const m of q) {
                out.push(m);
                if (m.type === "system" && m.subtype === "init") {
                    void until(() => cli.lines().some((l) => l.received?.method === "turn/start"), 4000).then(() => q.steer("also check the docs"));
                }
            }
            expect(cli.lines().some((l) => l.received?.method === "turn/steer")).toBe(true);
            expect(results(out)).toHaveLength(1);
            expect(results(out)[0]!.result).toContain("Heard: also check the docs");
            expect(Date.now() - t).toBeLessThan(4500);
        } finally {
            cli.restore();
        }
    });

    test("trusted: true lets Claude Code load the project's settings", async () => {
        const cli = await fakeCli("claude-code", { FAKE_SCENARIO: "silent" });
        try {
            const cwd = project();
            mkdirSync(join(cwd, ".claude"), { recursive: true });
            writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${join(cwd, "hook-ran")}` }] }] } }));
            await collect(query({ prompt: "hello", options: { cwd, model: "claude-code:default", trusted: true, persistSession: false, canUseTool: () => ({ behavior: "deny" }) } }));
            // The turn's launches, in the project (side requests run from the home folder with no settings at all).
            const launches = cli.lines().filter((l) => Array.isArray(l.argv) && l.cwd === cwd).map((l) => l.argv as string[]);
            expect(launches.length).toBeGreaterThan(0);
            for (const argv of launches) {
                const i = argv.indexOf("--setting-sources");
                if (i >= 0) expect(argv[i + 1]).toContain("project");
            }
            expect(existsSync(join(cwd, "hook-ran"))).toBe(true);
        } finally {
            cli.restore();
        }
    });

    test("an input iterable that throws before the first message ends the query with its error", async () => {
        async function* input(): AsyncGenerator<string> {
            throw new Error("input broke");
        }
        await expect(collect(query({ prompt: input(), options: { cwd: project(), model: MODEL, persistSession: false } }))).rejects.toThrow("input broke");
    });

    test("trusted: false on resume leaves out the memory frozen into the saved system prompt, without changing the session", async () => {
        const cwd = project();
        writeFileSync(join(cwd, "AGENTS.md"), "RESUME-MEMORY-MARKER");
        const first = query({ prompt: "one", options: { cwd, model: MODEL } });
        await collect(first);
        const id = await first.sessionId;
        expect(JSON.stringify(requests[0]!.messages)).toContain("RESUME-MEMORY-MARKER");

        requests.length = 0;
        await collect(query({ prompt: "two", options: { cwd, model: MODEL, resume: id, trusted: false } }));
        expect(JSON.stringify(requests[0]!.messages)).not.toContain("RESUME-MEMORY-MARKER");
        expect(lastSent()).toContain("one");

        // The saved session keeps its prompt: resumed again with trust, the memory is back.
        requests.length = 0;
        await collect(query({ prompt: "three", options: { cwd, model: MODEL, resume: id } }));
        expect(JSON.stringify(requests[0]!.messages)).toContain("RESUME-MEMORY-MARKER");
    });

    test("an input iterable that throws while a turn runs throws without a result for that turn", async () => {
        script = () => ({ text: "slow", delayMs: 400 });
        async function* input() {
            yield "first";
            await Bun.sleep(50);
            throw new Error("input broke mid-turn");
        }
        const seen: SDKMessage[] = [];
        await expect(
            (async () => {
                for await (const m of query({ prompt: input(), options: { cwd: project(), model: MODEL, persistSession: false } })) seen.push(m);
            })(),
        ).rejects.toThrow("input broke mid-turn");
        expect(results(seen)).toEqual([]);
    });

    test("whatever the input throws comes out as is, null and an empty string included", async () => {
        for (const value of [null, "", 0]) {
            async function* input(): AsyncGenerator<string> {
                throw value;
            }
            let caught: unknown = "nothing thrown";
            try {
                await collect(query({ prompt: input(), options: { cwd: project(), model: MODEL, persistSession: false } }));
            } catch (e) {
                caught = e;
            }
            expect(caught).toBe(value);
        }
    });

    test("persistSession: false with resume doesn't write the repair of a crash's dangling tool call", async () => {
        const cwd = project();
        const first = query({ prompt: "keep me", options: { cwd, model: MODEL } });
        await collect(first);
        const { findSession } = await import("../src/agent/session");
        const file = findSession(cwd, await first.sessionId)!;
        // What a crash mid-tool-call leaves: the call, with no result.
        writeFileSync(file, readFileSync(file, "utf-8") + JSON.stringify({ t: "msg", m: { role: "assistant", content: [{ type: "tool_call", id: "dangling", name: "Bash", input: { command: "true" } }] } }) + "\n");
        const before = readFileSync(file, "utf-8");
        const ms = await collect(query({ prompt: "again", options: { cwd, model: MODEL, resume: await first.sessionId, persistSession: false } }));
        expect(results(ms)[0]!.subtype).toBe("success");
        // The copy has the repair (providers need it), the file doesn't.
        expect(lastSent()).toContain("Interrupted");
        expect(readFileSync(file, "utf-8")).toBe(before);
    });

    test("persistSession: false with resume forks Claude Code's own session instead of starting a new one", async () => {
        const cli = await fakeCli("claude-code", { FAKE_SCENARIO: "silent" });
        try {
            const cwd = project();
            const first = query({ prompt: "hello", options: { cwd, model: "claude-code:default", canUseTool: () => ({ behavior: "deny" }) } });
            await collect(first);
            const id = await first.sessionId;
            const { findSession, Session } = await import("../src/agent/session");
            const file = findSession(cwd, id)!;
            const s = Session.load(file);
            const native = s.backendSession("claude-code", s.backendFolder("claude-code"))?.id;
            s.release();
            expect(native).toBeTruthy();
            const before = readFileSync(file, "utf-8");

            const turns = () => cli.lines().filter((l) => Array.isArray(l.argv) && l.cwd === cwd).map((l) => l.argv as string[]);
            const launched = turns().length;
            await collect(query({ prompt: "again", options: { cwd, model: "claude-code:default", resume: id, persistSession: false, canUseTool: () => ({ behavior: "deny" }) } }));
            const argv = turns()[launched]!;
            expect(argv[argv.indexOf("--resume") + 1]).toBe(native!);
            expect(argv).toContain("--fork-session");
            expect(readFileSync(file, "utf-8")).toBe(before);
        } finally {
            cli.restore();
        }
    });

    test("@server:resource mentions attach an MCP resource, as in harness -p", async () => {
        const cwd = project();
        const docs = { command: process.execPath, args: ["--no-env-file", join(import.meta.dir, "fixtures", "mcp-stdio-server.ts")], env: { MCP_FIXTURE_ERA: "legacy" }, cwd };
        await collect(query({ prompt: "summarize @docs:fixture://readme", options: { cwd, model: MODEL, persistSession: false, settings: { mcpServers: { docs } } } }));
        expect(JSON.stringify(requests[0]!.messages)).toContain("Hello from a resource.");
    });

    test("a tool can't be named Skill, even where no skills are loaded", async () => {
        const skill = tool("Skill", "mine", { type: "object", properties: {} }, () => "mine");
        await expect(collect(query({ prompt: "x", options: { cwd: project(), model: MODEL, tools: [skill] } }))).rejects.toThrow(/built-in tool/);
    });
});

describe("harness -p --output-format stream-json", () => {
    test("prints the SDK's message shapes", async () => {
        const cwd = project();
        script = () => ({ text: "from headless" });
        const { runHeadless } = await import("../src/headless");
        const realWrite = process.stdout.write;
        let out = "";
        process.stdout.write = ((s: string) => ((out += s), true)) as any;
        try {
            const code = await runHeadless({ cwd, prompt: "hi", trusted: true, modelRef: MODEL, mode: "default", outputFormat: "stream-json", verbose: false, allowedTools: [], disallowedTools: [], addDirs: [], startupNotes: [] });
            expect(code).toBe(0);
        } finally {
            process.stdout.write = realWrite;
        }
        const lines = out.trim().split("\n").map((l) => JSON.parse(l));
        expect(lines.map((l) => l.type)).toEqual(["system", "assistant", "result"]);
        expect(lines[0]).toMatchObject({ subtype: "init", model: MODEL, cwd });
        expect(lines[2]).toMatchObject({ subtype: "success", result: "from headless", errors: [] });
        expect(readFileSync).toBeDefined();
    });
});

describe("the examples", () => {
    test("run end to end against the mock model (bun run sdk:example)", async () => {
        const root = join(import.meta.dir, "..");
        const started = Date.now();
        const p = Bun.spawn(["bun", "--no-env-file", `--config=${join(root, "bunfig.toml")}`, join(root, "scripts/sdk-demo.ts")], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: HARNESS_HOME }, stdout: "pipe", stderr: "pipe" });
        const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        expect(err).toContain("? Edit(src/auth/index.ts) -> allowed");
        expect(err).toMatch(/success in \d+ steps/);
        expect(err).toMatch(/session: \d{8}-/);
        expect(out).toContain("SAML single sign-on");
        expect(code).toBe(0);
        // Two scripts, each exiting once its query is done: no timer of the harness's keeps them alive.
        expect(Date.now() - started).toBeLessThan(10_000);
    }, 60_000);
});
