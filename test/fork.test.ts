// Forking a session (src/agent/fork.ts): the fork's file, what it copies and
// what it doesn't, the original left as it was, the timeline log it takes
// along, and /fork in the terminal.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { home: HARNESS_HOME, cleanup } = isolate();
const { Session, cliLinks, listSessions } = await import("../src/agent/session");
const { forkSession, forkTitle, forkCut, forkTargets, beforeFork } = await import("../src/agent/fork");
const { forkUiLog, promptKey, readSegments, UiLog } = await import("../src/server/history");
const { FileHistory } = await import("../src/agent/checkpoints");
const { App } = await import("../src/ui/app");
const { runCommand } = await import("../src/commands/index");
const { stripAnsi } = await import("../src/ui/ansi");
const { registerSecret, unregisterSecret } = await import("../src/util/redact");
const { MODE_INFO } = await import("../src/permissions/modes");
import type { AssistantMessage, ChatRequest, Message } from "../src/providers/types";

beforeAll(() => {
    process.env.HARNESS_HOME = HARNESS_HOME;
});
afterAll(cleanup);

const prompt = (text: string, checkpoint?: number): Message => ({ role: "user", content: [{ type: "text", text }], meta: { kind: "prompt", ...(checkpoint ? { checkpoint } : {}) } });
const reply = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], provider: "test", model: "m1", stopReason: "end_turn" });
const call = (id: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text: "Reading it." }, { type: "tool_call", id, name: "Read", input: { file_path: "a.ts" } }], provider: "test", model: "m1", stopReason: "tool_use" });
const result = (id: string): Message => ({ role: "user", content: [{ type: "tool_result", toolCallId: id, toolName: "Read", content: "1\tx" }], meta: { kind: "tool_results" } });
const USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A saved session with a title, a model, a speed, spend and a Claude Code session, as one in use would be. */
function original(cwd = realpathSync(tempDir())) {
    const s = Session.create(cwd, { system: "You are a test." });
    s.push(prompt("first", 1000));
    s.push(call("c1"));
    s.push(result("c1"));
    s.push(reply("one"));
    s.setTitle("Layout questions");
    s.setModel("test:m1");
    s.setFastMode(true);
    s.recordUsage("test:m1", USAGE, 0.5);
    s.setBackendSession("claude-code", "sess-1", 4);
    s.push(prompt("second", 2000));
    s.push(reply("two"));
    s.recordUsage("test:m1", USAGE, 0.25);
    s.setBackendSession("claude-code", "sess-1", 6);
    return s;
}

const filesIn = (dir: string) => readdirSync(dir).sort();

describe("the fork's file", () => {
    test.each(["explicit", "session", "prompt"] as const)("redacts %s titles before shortening or normalizing them", (source) => {
        for (const secret of ["fork-private-token-" + "x".repeat(160), "fork-private\n  token-123456789"]) {
            const s = Session.create(realpathSync(tempDir()));
            const title = `Discuss ${secret} later`;
            // Register after saving to cover older transcripts containing newly known secrets.
            s.push(prompt(source === "prompt" ? title : "first"));
            if (source === "session") s.setTitle(title);
            registerSecret(secret, "fork-test");
            try {
                const f = forkSession(s, { cut: 1, ...(source === "explicit" ? { title } : {}) });
                try {
                    expect(f.title).toBe("Fork of Discuss [REDACTED fork-test] later");
                    expect(f.meta.forkOf?.title).toBe("Discuss [REDACTED fork-test] later");
                    expect(readFileSync(f.path, "utf-8")).not.toContain("fork-private");
                } finally {
                    f.release();
                }
            } finally {
                unregisterSecret(secret);
                s.release();
            }
        }
    });

    test("at the last response: the whole conversation, a new id and title, the model and speed now, no spend, and where it came from", () => {
        const s = original();
        s.setModel("test:m2"); // picked since, nothing run on it yet
        const before = readFileSync(s.path, "utf-8");
        const f = forkSession(s, { cut: forkCut(s.messages, 4), model: "test:m2" });
        try {
            expect(f.meta.id).not.toBe(s.meta.id);
            expect(f.meta.id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);
            expect(dirname(f.path)).toBe(dirname(s.path));
            expect(f.messages).toEqual(s.messages);
            expect(f.title).toBe("Fork of Layout questions");
            expect(f.model).toBe("test:m2");
            expect(f.fastMode).toBe(true);
            expect(f.cost).toBe(0);
            expect(f.usageByModel.size).toBe(0);
            expect(f.meta.system).toBe("You are a test.");
            expect(f.meta.forkOf).toEqual({ id: s.meta.id, title: "Layout questions", messages: 6, at: expect.any(Number) });
            // The Claude Code session is shared, marked in both so neither continues it in place.
            expect(f.backends.get("claude-code")).toEqual({ id: "sess-1", synced: 6, fork: true });
            expect(s.backends.get("claude-code")).toEqual({ id: "sess-1", synced: 6, fork: true });
            // The original: the same bytes, and that marker after them.
            expect(readFileSync(s.path, "utf-8")).toBe(before + '{"t":"backend","provider":"claude-code","id":"sess-1","synced":6,"fork":true}\n');
            expect(Session.load(s.path).backends.get("claude-code")).toEqual({ id: "sess-1", synced: 6, fork: true });
            // Its own, private file, already claimed by this process; nothing else left in the folder.
            expect(statSync(f.path).mode & 0o777).toBe(0o600);
            expect(JSON.parse(readFileSync(`${f.path}.lock`, "utf-8")).pid).toBe(process.pid);
            expect(filesIn(dirname(s.path)).filter((n) => n.includes(".tmp"))).toEqual([]);
            expect(listSessions(s.meta.cwd).map((x) => x.title)).toContain("Fork of Layout questions");
        } finally {
            f.release();
        }
        expect(existsSync(`${f.path}.lock`)).toBe(false);
    });

    test("native fork markers don't claim the original's CLI session in the sidebar", () => {
        const s = original();
        const f = forkSession(s, { cut: 6 });
        expect(cliLinks(f.path)).toEqual([]);
        expect(cliLinks(s.path)).toContainEqual({ provider: "claude-code", id: "sess-1", kind: "backend" });
        f.setBackendSession("claude-code", "own-fork", 6);
        expect(cliLinks(f.path)).toEqual([{ provider: "claude-code", id: "own-fork", kind: "backend" }]);
        f.release();
    });

    test("at an earlier response: everything before the next prompt, and a backend session that saw more isn't shared", () => {
        const s = original();
        const before = readFileSync(s.path, "utf-8");
        const f = forkSession(s, { cut: forkCut(s.messages, 0) });
        f.release();
        expect(forkCut(s.messages, 0)).toBe(4);
        expect(f.messages).toEqual(s.messages.slice(0, 4));
        expect(f.meta.forkOf?.messages).toBe(4);
        // The model the original has, when none is given.
        expect(f.model).toBe("test:m1");
        expect(f.backends.size).toBe(0);
        expect(s.backends.get("claude-code")).toEqual({ id: "sess-1", synced: 6 });
        expect(readFileSync(s.path, "utf-8")).toBe(before);
    });

    test("imported turns can be forked at their own boundaries", () => {
        const s = original();
        // Use a saved imported transcript, so the file and live history agree.
        const imported = Session.create(realpathSync(tempDir()));
        for (const m of s.messages) imported.push(m.role === "user" && m.meta?.kind === "prompt" ? { ...m, meta: { ...m.meta, imported: true } } : m);
        imported.setImported({ source: "claude-code", id: "cli-original", importedAt: 100, startedAt: 50, messages: 6, omitted: 2 });
        expect(forkTargets(imported.messages).map((t) => t.index)).toEqual([0, 4]);
        expect(forkCut(imported.messages, 0)).toBe(4);
        const f = forkSession(imported, { cut: forkCut(imported.messages, 0) });
        f.release();
        expect(f.messages).toEqual(imported.messages.slice(0, 4));
        expect(readSegments(f.path)[0]!.imported).toEqual(readSegments(imported.path)[0]!.imported);
        expect(cliLinks(f.path)).toEqual([]);
    });

    test("while the original is working, none of its backend sessions are shared", () => {
        const s = original();
        const before = readFileSync(s.path, "utf-8");
        const f = forkSession(s, { cut: 6, shareBackends: false });
        f.release();
        expect(f.backends.size).toBe(0);
        expect(readFileSync(s.path, "utf-8")).toBe(before);
    });

    test("a compacted original: the fork starts from the same summary, with the same segments", () => {
        const s = original();
        s.compact("SUMMARY OF THE START", [{ role: "user", content: [{ type: "text", text: "summary" }], meta: { kind: "summary" } }]);
        s.push(prompt("third", 3000));
        s.push(reply("three"));
        const f = forkSession(s, { cut: 3 });
        f.release();
        expect(f.summary).toBe("SUMMARY OF THE START");
        expect(f.messages).toEqual(s.messages);
        expect(f.backends.size).toBe(0);
        expect(readSegments(f.path)).toEqual(readSegments(s.path));
    });

    test("copies ending notices and imported history metadata without backend sub-agent ownership", () => {
        const s = original();
        s.recordNotice("warn", "The response reached its output limit.");
        s.setImported({ source: "claude-code", id: "imported-session", importedAt: 100, messages: 6, omitted: 2 });
        s.recordSubagentRun("claude-code", "child-session");
        const f = forkSession(s, { cut: 6, shareBackends: false });
        f.release();
        expect(f.notices).toEqual(s.notices);
        expect(cliLinks(f.path)).toEqual([]);
        expect(cliLinks(s.path)).toContainEqual({ provider: "claude-code", id: "imported-session", kind: "import" });
        expect(readSegments(f.path)).toEqual(readSegments(s.path));
        expect(readFileSync(f.path, "utf-8")).not.toContain('"t":"subagent"');
        s.push(prompt("next"));
        s.push(reply("later"));
        s.recordNotice("error", "Later failure");
        const earlier = forkSession(s, { cut: 6, shareBackends: false });
        earlier.release();
        expect(earlier.notices.map((n) => n.text)).toEqual(["The response reached its output limit."]);
    });

    test("repairs a final dangling tool call without changing the original", () => {
        const s = Session.create(realpathSync(tempDir()));
        s.push(prompt("read"));
        s.push(call("unfinished"));
        const before = readFileSync(s.path, "utf-8");
        const f = forkSession(s, { cut: 2 });
        f.release();
        expect(f.messages[2]).toMatchObject({ role: "user", content: [{ type: "tool_result", toolCallId: "unfinished", isError: true }] });
        expect(readFileSync(s.path, "utf-8")).toBe(before);
    });

    test("a rewound original: the history it has now, not the turns it rewound away", () => {
        const s = original();
        s.rewind(4);
        s.push(prompt("second, again", 2500));
        s.push(reply("two again"));
        s.push(prompt("third", 3000));
        s.push(reply("three"));
        const f = forkSession(s, { cut: forkCut(s.messages, 4) });
        f.release();
        expect(f.messages).toEqual(s.messages.slice(0, 6));
        expect(f.messages.map((m) => (m.content[0] as { text?: string }).text)).toContain("second, again");
        expect(JSON.stringify(f.messages)).not.toContain('"two"');
    });

    test("titles: a fork of a fork isn't 'Fork of Fork of', and one without a title is named after its first prompt", () => {
        expect(forkTitle("Fork of Fork of Layout")).toBe("Fork of Layout");
        const s = original();
        const f = forkSession(s, { cut: 6 });
        const ff = forkSession(f, { cut: 6 });
        f.release();
        ff.release();
        expect(ff.title).toBe("Fork of Layout questions");
        expect(ff.meta.forkOf).toMatchObject({ id: f.meta.id, title: "Fork of Layout questions" });

        const plain = Session.create(realpathSync(tempDir()));
        plain.push(prompt("explain   the\nlayout"));
        plain.push(reply("ok"));
        const p = forkSession(plain, { cut: 2 });
        p.release();
        expect(p.title).toBe("Fork of explain the layout");
    });

    test("a prompt rewound away doesn't name it; one compacted away still does", () => {
        const s = Session.create(realpathSync(tempDir()));
        s.push(prompt("discarded"));
        s.push(reply("a"));
        s.rewind(0);
        s.push(prompt("kept"));
        s.push(reply("b"));
        const f = forkSession(s, { cut: 2 });
        f.release();
        expect(f.title).toBe("Fork of kept");
        s.compact("SUMMARY", [{ role: "user", content: [{ type: "text", text: "summary" }], meta: { kind: "summary" } }]);
        s.push(prompt("after"));
        s.push(reply("c"));
        const g = forkSession(s, { cut: 3 });
        g.release();
        expect(g.title).toBe("Fork of kept");
    });

    test("a backend session is shared only once the original has saved that it won't continue it in place", () => {
        const s = original();
        chmodSync(s.path, 0o400);
        try {
            const f = forkSession(s, { cut: 6 });
            f.release();
            expect(f.backends.size).toBe(0);
            expect(f.messages).toEqual(s.messages);
        } finally {
            chmodSync(s.path, 0o600);
        }
    });

    test("its own checkpoints come after the ones it was forked with, even from a clock that was ahead", () => {
        const s = Session.create(realpathSync(tempDir()));
        const ahead = Date.now() + 1e9;
        s.push(prompt("from the future", ahead));
        s.push(reply("a"));
        const f = forkSession(s, { cut: 2 });
        f.release();
        expect(f.meta.forkOf!.at).toBe(ahead + 1);
        const cp = FileHistory.for(f)!.begin();
        expect(cp).toBeGreaterThanOrEqual(ahead + 1);
        expect(beforeFork(f.meta, prompt("new", cp), 2)).toBe(false);
        expect(beforeFork(f.meta, f.messages[0], 0)).toBe(true);
    });

    test("a marker saved after a failed append reads back: it doesn't join the torn line that append left", () => {
        const s = original();
        // An append that failed half way (a full disk): part of a line, and no newline.
        appendFileSync(s.path, '{"t":"title","title":"Half wri');
        chmodSync(s.path, 0o400);
        try {
            s.setTitle("not saved");
        } finally {
            chmodSync(s.path, 0o600);
        }
        const f = forkSession(s, { cut: 6 });
        f.release();
        expect(f.backends.get("claude-code")).toEqual({ id: "sess-1", synced: 6, fork: true });
        s.release();
        const again = Session.load(s.path);
        again.release();
        expect(again.backends.get("claude-code")).toEqual({ id: "sess-1", synced: 6, fork: true });
        expect(again.messages).toEqual(s.messages);
    });

    test("one that can't be made leaves nothing behind", () => {
        const s = original();
        const before = filesIn(dirname(s.path));
        expect(() => forkSession(s, { cut: 0 })).toThrow(/isn't in this conversation/);
        expect(() => forkSession(s, { cut: 99 })).toThrow(/isn't in this conversation/);
        expect(() => forkSession(Session.create(realpathSync(tempDir()), { persist: false }), { cut: 1 })).toThrow(/hasn't been saved/);
        // What's saved doesn't match what it has (a write that failed).
        s.messages[5] = reply("only in memory");
        expect(() => forkSession(s, { cut: 6 })).toThrow(/doesn't match/);
        expect(filesIn(dirname(s.path))).toEqual(before);
    });

    test("prompts it was forked with are told apart from ones sent in it later, by their checkpoints", () => {
        const s = original();
        const f = forkSession(s, { cut: 6 });
        f.release();
        expect(beforeFork(f.meta, f.messages[0], 0)).toBe(true);
        expect(beforeFork(f.meta, f.messages[4], 4)).toBe(true);
        expect(beforeFork(f.meta, prompt("later", f.meta.forkOf!.at), 6)).toBe(false);
        expect(beforeFork(s.meta, s.messages[0], 0)).toBe(false);
    });
});

describe("the timeline log", () => {
    test("copies backend steps and their diffs, without queued work or original settings", () => {
        const s = original();
        const ui = new UiLog(s.path, s.meta.id);
        const key = promptKey(s.messages[0] as any);
        const block = { t: "tool" as const, id: "backend-edit", name: "Edit", title: "Edit a.ts", status: "ok" as const, summary: "Changed one line" };
        const diff = { path: "a.ts", before: "a", after: "b" } as any;
        ui.write({ t: "turn", seg: 0, index: 0, at: 111, end: 222, status: "done", prompt: key });
        ui.write({ t: "step", seg: 0, index: 0, prompt: key, block });
        ui.write({ t: "tool", id: block.id, diff, durationMs: 5 });
        ui.write({ t: "step", seg: 0, index: 4, prompt: promptKey(s.messages[4] as any), block: { t: "text", id: "later", text: "Later reply" } });
        ui.write({ t: "state", mode: "plan", effort: "high" });
        ui.write({ t: "pending-turn", text: "queued", at: 1 });
        const f = forkSession(s, { cut: 4 });
        f.release();
        forkUiLog({ file: s.path, id: s.meta.id }, { file: f.path, id: f.meta.id });
        const copied = new UiLog(f.path, f.meta.id);
        expect(copied.shown(0, 0, f.messages[0] as any)).toEqual([block]);
        expect(copied.tools.get(block.id)).toMatchObject({ diff, durationMs: 5 });
        expect([...copied.steps.keys()]).toEqual(["0:0"]);
        expect(copied.state).toEqual({});
        expect(readFileSync(join(dirname(f.path), "ui", `${f.meta.id}.jsonl`), "utf-8")).not.toContain("queued");
    });

    test("goes along for the copied turns: their tool rows and times, not the rest", () => {
        const s = original();
        const ui = new UiLog(s.path, s.meta.id);
        ui.write({ t: "turn", seg: 0, index: 0, at: 111, end: 222, status: "done" });
        ui.write({ t: "tool", id: "c1", summary: "Read 1 line", durationMs: 5 });
        ui.write({ t: "turn", seg: 0, index: 4, at: 333, end: 444, status: "done" });
        ui.write({ t: "tool", id: "c-later", summary: "later" });
        ui.write({ t: "pending-turn", text: "queued", at: 1 });
        const f = forkSession(s, { cut: 4 });
        f.release();
        forkUiLog({ file: s.path, id: s.meta.id }, { file: f.path, id: f.meta.id });
        const copied = new UiLog(f.path, f.meta.id);
        expect([...copied.turns.keys()]).toEqual(["0:0"]);
        expect(copied.turn(0, 0)).toMatchObject({ at: 111, end: 222 });
        expect([...copied.tools.keys()]).toEqual(["c1"]);
        const file = join(dirname(f.path), "ui", `${f.meta.id}.jsonl`);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(filesIn(dirname(file)).filter((n) => n.includes(".tmp"))).toEqual([]);
    });
});

// ---------------------------------------------------------------------------

describe("/fork in the terminal", () => {
    function testApp(cwd: string) {
        const app = new App({ cwd, trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
        const printed: string[] = [];
        const print = (l: string | string[] | ((cols: number) => string[])) => (printed.push(...(typeof l === "function" ? l(100) : Array.isArray(l) ? l : [l])), {});
        (app as any).screen = { print, replace() {}, redraw() {}, setLive() {}, flushNow() {}, stop() {}, clearScreen() {} };
        (app as any).renderLive = () => {};
        const requests: ChatRequest[] = [];
        app.model = { provider: "test", id: "m1", name: "Test model" } as any;
        app.client = { stream: async (req: ChatRequest) => (requests.push(req), reply("ok")), listModels: async () => [] } as any;
        return { app, requests, text: () => printed.map(stripAnsi).join("\n") };
    }

    test("switches to a fork of the conversation so far, and says how to go back; neither sees the other's later turns", async () => {
        const cwd = realpathSync(tempDir());
        const { app, requests, text } = testApp(cwd);
        app.session = Session.create(cwd);
        app.makeAgent();
        await app.startTurn("remember PINEAPPLE");
        const origin = app.session;
        const before = readFileSync(origin.path, "utf-8");
        await runCommand(app, "/fork");
        expect(app.session).not.toBe(origin);
        expect(app.session.meta.forkOf?.id).toBe(origin.meta.id);
        expect(app.session.messages).toEqual(origin.messages);
        expect(app.session.title).toBe("Fork of remember PINEAPPLE");
        expect(text().replace(/\s+/g, " ")).toContain(`/resume ${origin.meta.id} goes back to the original`);
        // The original is released for whoever opens it next, and unchanged.
        expect(existsSync(`${origin.path}.lock`)).toBe(false);
        expect(readFileSync(origin.path, "utf-8")).toBe(before);

        await app.startTurn("now MANGO");
        expect(readFileSync(origin.path, "utf-8")).toBe(before);
        expect(app.session.messages.length).toBe(origin.messages.length + 2);

        await runCommand(app, `/resume ${origin.meta.id}`);
        expect(app.session.meta.id).toBe(origin.meta.id);
        requests.length = 0;
        await app.startTurn("what did I say?");
        expect(JSON.stringify(requests[0]!.messages)).toContain("PINEAPPLE");
        expect(JSON.stringify(requests[0]!.messages)).not.toContain("MANGO");
    });

    test.each(["default", "acceptEdits", "plan"] as const)("reminds the model of the current %s mode on the first fork turn", async (mode) => {
        const cwd = realpathSync(tempDir());
        const { app, requests } = testApp(cwd);
        app.session = Session.create(cwd);
        app.makeAgent();
        app.setMode(mode === "plan" ? "default" : "plan");
        await app.startTurn("consider the change");
        app.setMode(mode);
        const origin = app.session;
        const before = readFileSync(origin.path, "utf-8");
        try {
            await runCommand(app, "/fork");
            expect(app.mode).toBe(mode);
            expect(app.session.messages).toEqual(origin.messages);
            requests.length = 0;
            await app.startTurn("continue in the current mode");
            const sent = requests[0]!.messages.findLast((m) => m.role === "user")!;
            const text = sent.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
            expect(text).toContain(mode === "plan" ? "Plan mode" : `The permission mode is "${MODE_INFO[mode].label}": ${MODE_INFO[mode].description}`);
            expect(readFileSync(origin.path, "utf-8")).toBe(before);
        } finally {
            app.session.release();
            origin.release();
        }
    });

    test("with nothing to fork, says so", async () => {
        const cwd = realpathSync(tempDir());
        const { app, text } = testApp(cwd);
        app.session = Session.create(cwd);
        const before = existsSync(join(HARNESS_HOME, "projects")) ? readdirSync(join(HARNESS_HOME, "projects")).length : 0;
        await runCommand(app, "/fork");
        expect(text()).toContain("Nothing to fork yet.");
        expect(existsSync(join(HARNESS_HOME, "projects")) ? readdirSync(join(HARNESS_HOME, "projects")).length : 0).toBe(before);
    });
});
