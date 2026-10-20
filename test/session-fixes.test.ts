// Switching sessions (/resume failing, todos, /summary), the session list
// after rewinds and compactions, /context with --append-system-prompt, and
// key reports that aren't keys.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, realpathSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";

const { home: HARNESS_HOME, cleanup } = isolate();
const { App } = await import("../src/ui/app");
const { Session, listSessions, findSession } = await import("../src/agent/session");
const { runCommand } = await import("../src/commands/index");
const { KeyParser } = await import("../src/ui/keys");
const { stripAnsi } = await import("../src/ui/ansi");
const { formatTokens } = await import("../src/providers/pricing");
import type { AssistantMessage, ChatRequest, Message } from "../src/providers/types";

beforeAll(() => {
    process.env.HARNESS_HOME = HARNESS_HOME;
});
afterAll(cleanup);

const MODEL = { provider: "test", id: "m1", name: "Test model" } as any;

function testApp(init: { cwd?: string; appendSystemPrompt?: string } = {}) {
    const app = new App({ cwd: init.cwd ?? tempDir(), trusted: true, mode: "default", allowBypass: false, startupNotes: [], appendSystemPrompt: init.appendSystemPrompt });
    const printed: string[] = [];
    const print = (l: string | string[] | ((cols: number) => string[])) => (printed.push(...(typeof l === "function" ? l(100) : Array.isArray(l) ? l : [l])), {});
    (app as any).screen = { print, replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop() {}, clearScreen() {} };
    (app as any).renderLive = () => {};
    app.session = Session.create(app.cwd, { persist: false });
    return { app, printed, text: () => printed.map(stripAnsi).join("\n") };
}

function useClient(app: InstanceType<typeof App>, answer = "ok") {
    const requests: ChatRequest[] = [];
    app.model = MODEL;
    app.client = { stream: async (req: ChatRequest) => (requests.push(req), reply(answer)), listModels: async () => [] };
    app.makeAgent();
    return requests;
}

const prompt = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], meta: { kind: "prompt" } });
const reply = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], provider: "test", model: "m1", stopReason: "end_turn" });

/** A saved session in `cwd` with these messages. */
function saved(cwd: string, ...msgs: Message[]) {
    const s = Session.create(cwd);
    for (const m of msgs) s.push(m);
    return s;
}

// ---------------------------------------------------------------------------

describe("switching sessions", () => {
    test("a /resume that fails leaves you in the conversation you were in, and the agent keeps writing to it", async () => {
        const { app, text } = testApp();
        useClient(app);
        await app.startTurn("hello");
        const before = app.session;
        app.resume("/nonexistent/session.jsonl");
        expect(text()).toContain("Could not resume");
        expect(app.session).toBe(before);
        await app.startTurn("again");
        expect(app.session.messages.filter((m) => m.meta?.kind === "prompt").length).toBe(2);
    });

    test("/resume doesn't carry over the previous session's todos", () => {
        const { app } = testApp();
        useClient(app);
        app.toolState.todos = [{ content: "the other session's task", status: "in_progress" }];
        app.resume(saved(app.cwd, prompt("earlier work"), reply("done")).path);
        expect(app.session.messages.length).toBe(2);
        expect(app.toolState.todos).toEqual([]);
    });

    test("/summary shows the current session's compaction summary: none after /clear, the resumed one's after /resume", async () => {
        const { app, text, printed } = testApp();
        useClient(app, "SUMMARY OF THE FIRST SESSION");
        await app.startTurn("hello");
        expect(await app.agent!.compact({ auto: false, signal: new AbortController().signal })).toBe(true);
        await runCommand(app, "/summary");
        expect(text()).toContain("SUMMARY OF THE FIRST SESSION");

        printed.length = 0;
        app.newSession();
        await runCommand(app, "/summary");
        expect(text()).toContain("No compaction has happened in this session.");
        expect(text()).not.toContain("SUMMARY OF THE FIRST SESSION");

        const other = saved(app.cwd, prompt("old"), reply("old answer"));
        other.compact("SUMMARY OF THE RESUMED SESSION", [prompt("pick up")]);
        printed.length = 0;
        app.resume(other.path);
        await runCommand(app, "/summary");
        expect(text()).toContain("SUMMARY OF THE RESUMED SESSION");
    });
});

// ---------------------------------------------------------------------------

describe("the session list", () => {
    const listed = (cwd: string) => listSessions(cwd).map((s) => ({ title: s.title, messages: s.messages }));

    test("a rewind lowers the message count", () => {
        const cwd = realpathSync(tempDir());
        const s = saved(cwd, prompt("first"), reply("a"), prompt("second"), reply("b"));
        s.rewind(2);
        expect(listed(cwd)).toEqual([{ title: "first", messages: 2 }]);
    });

    test("rewinding past the first prompt drops it from the title; rewinding everything unlists the session", () => {
        const cwd = realpathSync(tempDir());
        const s = saved(cwd, prompt("dropped"), reply("a"));
        s.rewind(0);
        expect(listed(cwd)).toEqual([]);
        expect(findSession(cwd, s.meta.id)).toBeUndefined();
        s.push(prompt("kept"));
        expect(listed(cwd)).toEqual([{ title: "kept", messages: 1 }]);
    });

    test("after a compaction it counts what's kept and keeps the opening prompt as the title", () => {
        const cwd = realpathSync(tempDir());
        const s = saved(cwd, prompt("opening"), reply("a"), prompt("more"), reply("b"));
        s.compact("summary", [prompt("summary of earlier"), reply("ok")]);
        expect(listed(cwd)).toEqual([{ title: "opening", messages: 2 }]);
    });

    test("in a large session, messages, renames and rewinds far into the file count", () => {
        const cwd = realpathSync(tempDir());
        const s = saved(cwd, prompt("opening"), reply("x".repeat(600 * 1024)), prompt("later"), reply("b"), prompt("latest"));
        s.setTitle("Renamed late");
        expect(listed(cwd)).toEqual([{ title: "Renamed late", messages: 5 }]);
        s.rewind(3);
        expect(listed(cwd)).toEqual([{ title: "Renamed late", messages: 3 }]);
    });

    test("a torn last line that loading skipped (and ended) isn't counted", () => {
        const cwd = realpathSync(tempDir());
        const s = saved(cwd, prompt("one"));
        appendFileSync(s.path, '{"t":"msg","m":{"role":"assistant","content":[');
        expect(Session.load(s.path).messages.length).toBe(1);
        expect(listed(cwd)).toEqual([{ title: "one", messages: 1 }]);
        const again = Session.load(s.path);
        again.push(prompt("two"));
        expect(Session.load(s.path).messages.length).toBe(2);
        expect(listed(cwd)).toEqual([{ title: "one", messages: 2 }]);
    });

    test("the count and title match what loading the session gives", () => {
        const cwd = realpathSync(tempDir());
        const s = saved(cwd, prompt("one"), reply("a"), prompt("two"), reply("b"));
        s.rewind(1);
        s.push(reply("c"));
        s.push(prompt("three"));
        const loaded = Session.load(s.path);
        expect(listed(cwd)).toEqual([{ title: "one", messages: loaded.messages.length }]);
    });
});

// ---------------------------------------------------------------------------

describe("/context", () => {
    test("the system prompt includes --append-system-prompt, which goes with every request", async () => {
        const append = "Always answer in French. ".repeat(1000);
        const { app, text } = testApp({ appendSystemPrompt: append });
        const requests = useClient(app);
        app.model = { ...MODEL, contextWindow: 200_000 };
        await app.startTurn("hello");
        await runCommand(app, "/context");
        const sent = requests[0]!.system!;
        expect(sent.endsWith(append)).toBe(true);
        expect(text()).toMatch(new RegExp(`System prompt\\s+${formatTokens(Math.ceil(sent.length / 3.5)).replace(".", "\\.")}`));
    });
});

// ---------------------------------------------------------------------------

describe("key reports that aren't keys", () => {
    test("a kitty keyboard-flags reply (CSI ? 1 u) or an out-of-range codepoint doesn't throw, and keys after it still arrive", () => {
        const p = new KeyParser();
        const keys = [...p.feed("\x1b[?1u"), ...p.feed("\x1b[1114112u"), ...p.feed("\x1b[55296u"), ...p.feed("a")];
        expect(keys.filter((k) => k.name !== "unknown")).toEqual([{ name: "text", text: "a" }]);
    });
});

test("backend background waiting uses the TUI's live status and clears it", () => {
    const { app } = testApp();
    const text = "Waiting for background command: Run checks · Esc to stop it";
    (app as any).onAgentEvent({ type: "activity", text });
    expect((app as any).status).toBe(text);
    (app as any).onAgentEvent({ type: "activity" });
    expect((app as any).status).toBeUndefined();
    app.session?.release();
});
