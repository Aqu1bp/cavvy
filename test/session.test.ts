import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir, FAKE } from "./helpers/isolate";

const iso = isolate();
const { Session, listSessions, findSession } = await import("../src/agent/session");
const { registerSecret, unregisterSecret } = await import("../src/util/redact");
const { projectStateDir } = await import("../src/config/paths");
import type { AssistantMessage, Message, UserMessage } from "../src/providers/types";

const PROJECTS = tempDir("harness-proj-");
afterAll(() => {
    rmSync(PROJECTS, { recursive: true, force: true });
    iso.cleanup();
});

let n = 0;
/** A distinct (non-existent) project path per test, so session dirs don't mix. */
const project = () => join(PROJECTS, `p${++n}`);

const user = (text: string, extra: Partial<UserMessage> = {}): UserMessage => ({ role: "user", content: [{ type: "text", text }], meta: { kind: "prompt" }, ...extra });
const assistant = (text: string, calls: { id: string; name: string }[] = []): AssistantMessage => ({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [{ type: "text", text }, ...calls.map((c) => ({ type: "tool_call" as const, id: c.id, name: c.name, input: { path: "x" } }))],
    stopReason: calls.length ? "tool_use" : "end_turn",
});

function lines(file: string): any[] {
    return readFileSync(file, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
}

describe("Session persistence", () => {
    test("no file until the first message; earlier records are buffered and flushed in order", () => {
        const s = Session.create(project(), { system: "frozen system prompt" });
        expect(s.meta.id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);
        expect(s.path).toBe(join(projectStateDir(s.meta.cwd), `${s.meta.id}.jsonl`));
        expect(s.path.startsWith(iso.home)).toBe(true);
        expect(s.persisted).toBe(true);

        s.setModel("anthropic:claude-a");
        s.setTitle("First title");
        s.recordUsage("anthropic:claude-a", { inputTokens: 10, outputTokens: 5 }, 0.01);
        expect(existsSync(s.path)).toBe(false);
        expect(existsSync(dirname(s.path))).toBe(false);

        s.push(user("hello"));
        expect(existsSync(s.path)).toBe(true);
        const ls = lines(s.path);
        expect(ls.map((l) => l.t)).toEqual(["meta", "model", "title", "usage", "msg"]);
        expect(ls[0]).toMatchObject({ t: "meta", id: s.meta.id, cwd: s.meta.cwd, system: "frozen system prompt", version: s.meta.version });
        expect(ls[1].model).toBe("anthropic:claude-a");
        expect(ls[2].title).toBe("First title");
        expect(ls[4].m).toEqual(user("hello"));

        // After the first message, records are written immediately.
        s.setTitle("Second title");
        expect(lines(s.path).at(-1)).toEqual({ t: "title", title: "Second title" });
    });

    test("session files are 0600 and their directory 0700", () => {
        const s = Session.create(project());
        s.push(user("x"));
        expect(statSync(s.path).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(s.path)).mode & 0o777).toBe(0o700);
    });

    test("persist:false never writes", () => {
        const s = Session.create(project(), { persist: false });
        s.setModel("m");
        s.push(user("x"));
        expect(s.persisted).toBe(false);
        expect(existsSync(s.path)).toBe(false);
        expect(s.messages).toHaveLength(1);
    });

    test("load() restores messages, model, title, cost and usageByModel", () => {
        const s = Session.create(project(), { system: "sys" });
        s.setModel("anthropic:claude-a");
        s.push(user("q1"));
        s.push(assistant("a1"));
        s.recordUsage("anthropic:claude-a", { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 7 }, 0.5);
        s.setModel("openai:gpt-6-sol");
        s.push(user("q2"));
        s.recordUsage("openai:gpt-6-sol", { inputTokens: 50, outputTokens: 10 }, 0.25);
        s.recordUsage("anthropic:claude-a", { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 }, 0.125);
        s.setTitle("A title");

        const l = Session.load(s.path);
        expect(l.meta).toEqual(s.meta);
        expect(l.path).toBe(s.path);
        expect(l.messages).toEqual([user("q1"), assistant("a1"), user("q2")]);
        expect(l.model).toBe("openai:gpt-6-sol");
        expect(l.title).toBe("A title");
        expect(l.cost).toBeCloseTo(0.875, 10);
        expect(l.usageByModel.get("anthropic:claude-a")).toEqual({ usage: { inputTokens: 101, outputTokens: 22, cacheReadTokens: 8, cacheWriteTokens: 7 }, cost: 0.625 });
        expect(l.usageByModel.get("openai:gpt-6-sol")).toEqual({ usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: 0.25 });
        expect(l.usageByModel).toEqual(s.usageByModel);

        // A loaded session keeps appending to the same file.
        l.push(assistant("a2"));
        expect(Session.load(s.path).messages).toHaveLength(4);
    });

    test("a crash-truncated last line is ignored", () => {
        const s = Session.create(project());
        s.push(user("q1"));
        s.push(assistant("a1"));
        appendFileSync(s.path, '{"t":"msg","m":{"role":"user","content":[{"type":"te');
        const l = Session.load(s.path);
        expect(l.messages).toEqual([user("q1"), assistant("a1")]);
    });

    test("a record appended after loading a torn file is not lost", () => {
        // The torn tail has no trailing newline, so the next append lands on the
        // same line and both become unparseable on the following load.
        const s = Session.create(project());
        s.push(user("q1"));
        s.push(assistant("calling", [{ id: "toolu_1", name: "read_file" }]));
        appendFileSync(s.path, '{"t":"usage","usage":{"inputTok');

        const l1 = Session.load(s.path); // repairTail appends synthetic tool results
        expect(l1.messages).toHaveLength(3);
        l1.push(user("continue please"));

        const l2 = Session.load(s.path);
        expect(l2.messages.map((m) => (m.role === "user" ? (m.content[0]!.type === "tool_result" ? "tool_result" : "prompt") : "assistant"))).toEqual(["prompt", "assistant", "tool_result", "prompt"]);
    });

    test("dangling tool calls get synthetic error results on load (and only once)", () => {
        const s = Session.create(project());
        s.push(user("do it"));
        s.push(
            assistant("running two tools", [
                { id: "toolu_a", name: "bash" },
                { id: "toolu_b", name: "read_file" },
            ]),
        );
        const l = Session.load(s.path);
        expect(l.messages).toHaveLength(3);
        const repair = l.messages[2] as UserMessage;
        expect(repair.role).toBe("user");
        expect(repair.meta).toEqual({ kind: "tool_results" });
        expect(repair.content).toEqual([
            { type: "tool_result", toolCallId: "toolu_a", toolName: "bash", content: "Interrupted: the session ended before this tool ran.", isError: true },
            { type: "tool_result", toolCallId: "toolu_b", toolName: "read_file", content: "Interrupted: the session ended before this tool ran.", isError: true },
        ]);
        // The repair is persisted, so a second load doesn't add another.
        expect(Session.load(s.path).messages).toHaveLength(3);
    });

    test("no repair when the last message is a user turn or has no tool calls", () => {
        const a = Session.create(project());
        a.push(user("q"));
        a.push(assistant("done"));
        expect(Session.load(a.path).messages).toHaveLength(2);

        const b = Session.create(project());
        b.push(assistant("calling", [{ id: "t1", name: "bash" }]));
        b.push({ role: "user", content: [{ type: "tool_result", toolCallId: "t1", toolName: "bash", content: "ok" }], meta: { kind: "tool_results" } });
        expect(Session.load(b.path).messages).toHaveLength(2);
    });

    test("compact() replaces history in memory and on disk", () => {
        const s = Session.create(project());
        s.push(user("old 1"));
        s.push(assistant("old 2"));
        const summary = user("(summary of earlier work)", { meta: { kind: "summary", display: "(conversation summary)" } });
        s.compact("the summary text", [summary, user("latest")]);
        expect(s.messages).toEqual([summary, user("latest")]);
        expect(lines(s.path).map((l) => l.t)).toEqual(["meta", "msg", "msg", "compact", "msg", "msg"]);
        expect(lines(s.path)[3]).toEqual({ t: "compact", summary: "the summary text" });
        const l = Session.load(s.path);
        expect(l.messages).toEqual([summary, user("latest")]);
        // Appends after the compaction keep working.
        l.push(assistant("after"));
        expect(Session.load(s.path).messages).toHaveLength(3);
    });

    test("compact() before the first message is buffered like other records", () => {
        const s = Session.create(project());
        s.compact("nothing yet", []);
        expect(existsSync(s.path)).toBe(false);
        s.push(user("first"));
        expect(lines(s.path).map((l) => l.t)).toEqual(["meta", "compact", "msg"]);
    });

    test("registered secrets and known key formats are redacted on disk and in the user turns sent to models", () => {
        const secret = "my-very-private-token-0123456789";
        registerSecret(secret, "test-secret");
        try {
            const s = Session.create(project(), { system: `system mentions ${secret}` });
            s.setTitle(`title with ${secret}`);
            s.push(user(`here is ${secret} and ${FAKE.anthropic}`));
            const text = readFileSync(s.path, "utf-8");
            expect(text).not.toContain(secret);
            expect(text).not.toContain(FAKE.anthropic);
            expect(text).toContain("[REDACTED test-secret]");
            expect(text).toContain("[REDACTED anthropic-key]");
            // In memory too: these messages are what providers receive.
            expect((s.messages[0]!.content[0] as { text: string }).text).toBe("here is [REDACTED test-secret] and [REDACTED anthropic-key]");
            const l = Session.load(s.path);
            expect((l.messages[0]!.content[0] as { text: string }).text).toBe("here is [REDACTED test-secret] and [REDACTED anthropic-key]");
            expect(l.meta.system).toBe("system mentions [REDACTED test-secret]");
        } finally {
            unregisterSecret(secret);
        }
    });

    test("load() rejects files without a meta record", () => {
        const f = join(PROJECTS, "not-a-session.jsonl");
        writeFileSync(f, '{"t":"msg","m":{"role":"user","content":[]}}\n');
        expect(() => Session.load(f)).toThrow(/Not a session file/);
    });
});

describe("listSessions / findSession", () => {
    const cwd = project();
    const older = Session.create(cwd);
    older.push(user("  first   prompt\nof the older session  "));
    older.push(assistant("reply"));
    const newer = Session.create(cwd);
    newer.push(user("ignored because a title exists"));
    newer.setTitle("Newer session title");
    const display = Session.create(cwd);
    display.push(user("raw text", { meta: { kind: "summary" } }));
    display.push(user("expanded @file mention", { meta: { kind: "prompt", display: "shown prompt" } }));
    const now = Date.now() / 1000;
    utimesSync(older.path, now - 300, now - 300);
    utimesSync(display.path, now - 200, now - 200);
    utimesSync(newer.path, now - 100, now - 100);

    // An empty session file (meta only) and a non-jsonl file are skipped.
    const dir = projectStateDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "20260101-000000-aaaaaa.jsonl"), JSON.stringify({ t: "meta", id: "20260101-000000-aaaaaa", cwd, createdAt: 0, version: "1" }) + "\n");
    writeFileSync(join(dir, "notes.txt"), "not a session");

    test("lists sessions newest first with titles and message counts", () => {
        const all = listSessions(cwd);
        expect(all.map((s) => s.id)).toEqual([newer.meta.id, display.meta.id, older.meta.id]);
        expect(all[0]).toMatchObject({ title: "Newer session title", messages: 1, file: newer.path, cwd });
        expect(all[1]).toMatchObject({ title: "shown prompt", messages: 2 });
        expect(all[2]).toMatchObject({ title: "first prompt of the older session", messages: 2 });
        expect(all[0]!.updatedAt).toBeGreaterThan(all[1]!.updatedAt);
        expect(listSessions(cwd, 1)).toHaveLength(1);
    });

    test("other projects have their own list", () => {
        expect(listSessions(project())).toEqual([]);
    });

    test("findSession by exact id and by prefix", () => {
        expect(findSession(cwd, older.meta.id)).toBe(older.path);
        expect(findSession(cwd, older.meta.id.slice(0, -1))).toBe(older.path);
        expect(findSession(cwd, "zzzz")).toBeUndefined();
        // The meta-only file isn't listed, so it can't be found either.
        expect(findSession(cwd, "20260101-000000-aaaaaa")).toBeUndefined();
    });
});
