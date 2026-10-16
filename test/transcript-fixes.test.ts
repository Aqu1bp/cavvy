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
const { formatCost } = await import("../src/providers/pricing");
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
            expect(environmentBlock(tempDir(), { provider: "x", id: "y" } as any, false)).toContain(`Shell: ${pickShell()}`);
            expect(pickShell()).not.toContain("fish");
        } finally {
            process.env.SHELL = saved;
        }
    });
});
