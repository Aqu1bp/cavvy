// Fixes for problems seen in real session transcripts: turns that failed
// leaving nothing on disk, requests that never answered, mode and model
// notes that piled up, unknown prices saved as free, and the like.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";

const { cleanup } = isolate();
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { ProviderError } = await import("../src/providers/types");
const { stallError } = await import("../src/providers/sse");
const { httpError } = await import("../src/providers/openai-compat");
const { readSegments, replay, UiLog } = await import("../src/server/history");
import type { ChatRequest } from "../src/providers/types";

afterAll(cleanup);

const reply = (content: any[], stopReason = "end_turn") => ({ role: "assistant", provider: "test", model: "test", stopReason, content }) as any;
const text = (t: string) => reply([{ type: "text", text: t }]);

/** An agent on a scripted model, with a session saved to disk. */
function scripted(script: (req: ChatRequest, n: number) => any, o: { session?: any; mode?: string; model?: any } = {}) {
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
        client: { stream: async (req: ChatRequest) => (requests.push(structuredClone({ ...req, signal: undefined })), script(req, ++n)) } as any,
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: [],
        mode: { get: () => mode as any, set: (m: any) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() } as any,
        host: { emit: (e: any) => events.push(e), ui: {} } as any,
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

        // The next prompt: the model gets the prompts, not the harness's note about the failure.
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

    test("a 429 for a quota of 0 isn't retried; a rate limit is", () => {
        const body = JSON.stringify({ error: { code: 429, message: "You exceeded your current quota.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3-pro", status: "RESOURCE_EXHAUSTED" } });
        const e = httpError(429, "Too Many Requests", body, null, "Google Gemini");
        expect(e.retryable).toBe(false);
        expect(e.message).toContain("Not retried");
        expect(httpError(429, "Too Many Requests", JSON.stringify({ error: { message: "Rate limit reached, limit: 10 per minute" } }), null, "Google Gemini").retryable).toBe(true);
    });
});
