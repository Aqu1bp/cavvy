import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir, FAKE } from "./helpers/isolate";

const iso = isolate();
const { Session, listSessions, findSession, takeOver } = await import("../src/agent/session");
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
    test("account selections survive reopen and invalidate only their provider's native thread", () => {
        const s = Session.create(project());
        s.setModel("codex:default");
        s.setFastMode(true);
        s.push(user("Earlier conversation"));
        s.setBackendSession("codex", "old-home-thread", 1);
        s.setBackendSession("claude-code", "claude-session", 1);
        expect(s.setAccount("codex", "personal")).toBe(true);
        expect(s.setAccount("codex", "personal")).toBe(false);
        expect(s.backends.has("codex")).toBe(false);
        expect(s.backends.has("claude-code")).toBe(true);
        s.release();
        const reopened = Session.load(s.path);
        expect(reopened.accountId("codex")).toBe("personal");
        expect(reopened.accountId("claude-code")).toBe("default");
        expect(reopened.backends.has("codex")).toBe(false);
        expect(reopened.model).toBe("codex:default");
        expect(reopened.fastMode).toBe(true);
        expect(reopened.messages).toEqual(s.messages);
        reopened.release();
    });

    test("forks preserve account selections and conversation without sharing native threads", () => {
        const original = Session.create(project(), { persist: false, system: "system" });
        original.setAccount("codex", "personal");
        original.setAccount("claude-code", "work");
        original.setModel("codex:default");
        original.setFastMode(true);
        original.push(user("Earlier conversation"));
        original.setBackendSession("codex", "original-thread", 1);
        const fork = original.fork();
        expect(fork.meta.id).not.toBe(original.meta.id);
        expect(fork.messages).toEqual(original.messages);
        expect(fork.messages[0]).not.toBe(original.messages[0]);
        expect(fork.accounts).toEqual(original.accounts);
        expect(fork.model).toBe(original.model);
        expect(fork.fastMode).toBe(true);
        expect(fork.backends.size).toBe(0);
        fork.release();
        const reopened = Session.load(fork.path);
        expect(reopened.accountId("codex")).toBe("personal");
        expect(reopened.accountId("claude-code")).toBe("work");
        expect(reopened.backends.size).toBe(0);
        reopened.release();
    });

    test("resume bindings survive reload and reject a different folder even when the account id is unchanged", () => {
        const s = Session.create(project());
        s.setAccount("codex", "personal");
        s.push(user("prior"));
        s.setBackendSession("codex", "bound-thread", 1, "/tmp/original-home");
        s.release();
        const loaded = Session.load(s.path);
        expect(loaded.backendSession("codex", "/tmp/original-home")?.id).toBe("bound-thread");
        expect(loaded.backendSession("codex", "/tmp/replacement-home")).toBeUndefined();
        expect(loaded.backends.has("codex")).toBe(false);
        loaded.release();
        const reopened = Session.load(s.path);
        expect(reopened.backends.has("codex")).toBe(false);
        reopened.release();
    });

    test("legacy sessions keep Default without rewriting their selection", () => {
        const s = Session.create(project());
        s.push(user("legacy"));
        s.release();
        const loaded = Session.load(s.path);
        expect(loaded.accountId("codex")).toBe("default");
        expect(loaded.accountId("claude-code")).toBe("default");
        expect(lines(s.path).some((l) => l.t === "account")).toBe(false);
        loaded.release();
    });

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

    test("re-choosing the model or speed it already has writes nothing", () => {
        const s = Session.create(project());
        s.push(user("x"));
        s.setModel("anthropic:claude-a");
        s.setFastMode(false);
        s.setModel("anthropic:claude-a");
        s.setFastMode(false);
        expect(lines(s.path).map((l) => l.t)).toEqual(["meta", "msg", "model", "fastMode"]);
        const l = Session.load(s.path);
        l.setModel("anthropic:claude-a");
        l.setFastMode(false);
        l.setFastMode(true);
        l.setModel("anthropic:claude-b");
        expect(lines(s.path).slice(4)).toEqual([{ t: "fastMode", enabled: true }, { t: "model", model: "anthropic:claude-b" }]);
        // A speed held only in memory (a chat from before speeds were saved) is written once chosen.
        const legacy = Session.create(project());
        legacy.push(user("y"));
        const old = Session.load(legacy.path);
        old.fastMode = false;
        old.setFastMode(false);
        expect(lines(legacy.path).at(-1)).toEqual({ t: "fastMode", enabled: false });
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
        // Other test files store FAKE.anthropic as a key; here it should be caught by its format.
        unregisterSecret(FAKE.anthropic);
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

describe("one writer per session", () => {
    const holder = join(import.meta.dir, "fixtures", "hold-session.ts");

    test("a session another process has open isn't opened (or written) until that process is gone", async () => {
        const s = Session.create(project());
        s.push(user("hi"));
        s.push(assistant("running it", [{ id: "c1", name: "Bash" }]));
        s.release();
        const child = Bun.spawn([process.execPath, "--no-env-file", holder, s.path], { stdin: "pipe", stdout: "pipe", env: process.env as Record<string, string> });
        const first = await child.stdout.getReader().read();
        expect(new TextDecoder().decode(first.value)).toContain("held");
        const before = readFileSync(s.path, "utf-8");
        expect(() => Session.load(s.path)).toThrow(/open in another Harness process \(pid \d+\)/);
        // Nothing was written under the process that has it (such as answering its running tool call as interrupted).
        expect(readFileSync(s.path, "utf-8")).toBe(before);
        child.stdin.end();
        await child.exited;
        const again = Session.load(s.path);
        expect(again.messages).toHaveLength(3);
        again.release();
        expect(existsSync(`${s.path}.lock`)).toBe(false);
    });

    test("a lock left by a process that has exited doesn't count", async () => {
        const s = Session.create(project());
        s.push(user("hi"));
        s.release();
        const gone = Bun.spawn(["true"]);
        await gone.exited;
        writeFileSync(`${s.path}.lock`, JSON.stringify({ pid: gone.pid }));
        const again = Session.load(s.path);
        expect(JSON.parse(readFileSync(`${s.path}.lock`, "utf-8")).pid).toBe(process.pid);
        again.release();
    });

    test("processes taking over the same stale lock at once: one gets it", async () => {
        const s = Session.create(project());
        s.push(user("hi"));
        s.release();
        const gone = Bun.spawn(["true"]);
        await gone.exited;
        writeFileSync(`${s.path}.lock`, JSON.stringify({ pid: gone.pid }));
        const kids = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "--no-env-file", holder, s.path], { stdin: "pipe", stdout: "pipe", env: process.env as Record<string, string> }));
        try {
            const said = await Promise.all(kids.map(async (k) => new TextDecoder().decode((await k.stdout.getReader().read()).value).trim()));
            expect(said.filter((w) => w === "held")).toHaveLength(1);
            expect(said.filter((w) => w === "in_use")).toHaveLength(7);
        } finally {
            for (const k of kids) k.stdin.end();
            await Promise.all(kids.map((k) => k.exited));
        }
        expect(existsSync(`${s.path}.lock`)).toBe(false);
    }, 20_000);

    test("a released copy writes nothing more (another process may have it now)", () => {
        const s = Session.create(project());
        s.push(user("hi"));
        s.release();
        const other = Session.load(s.path);
        other.setTitle("Renamed there");
        // A title that was still being made when it was closed.
        s.setTitle("Late title");
        s.push(user("late"));
        other.release();
        const again = Session.load(s.path);
        expect(again.title).toBe("Renamed there");
        expect(again.messages).toHaveLength(1);
        again.release();
    });

    test("taking over a lock that another process has just made its own leaves it", async () => {
        // The lost race: this process saw a stale lock, and before it removed
        // it, another process replaced it with its own.
        const s = Session.create(project());
        s.push(user("hi"));
        s.release();
        const other = Bun.spawn(["sleep", "30"]);
        try {
            const theirs = JSON.stringify({ pid: other.pid, at: Date.now() });
            writeFileSync(`${s.path}.lock`, theirs);
            expect(takeOver(`${s.path}.lock`)).toBe(true);
            expect(readFileSync(`${s.path}.lock`, "utf-8")).toBe(theirs);
            expect(() => Session.load(s.path)).toThrow(/open in another Harness process/);
        } finally {
            other.kill();
            await other.exited;
        }
    });

    test("a stale lock another process is taking over is left to it", async () => {
        const s = Session.create(project());
        s.push(user("hi"));
        s.release();
        const gone = Bun.spawn(["true"]);
        await gone.exited;
        const stale = JSON.stringify({ pid: gone.pid });
        writeFileSync(`${s.path}.lock`, stale);
        writeFileSync(`${s.path}.lock.takeover`, "");
        expect(takeOver(`${s.path}.lock`)).toBe(true);
        expect(readFileSync(`${s.path}.lock`, "utf-8")).toBe(stale);
        expect(() => Session.load(s.path)).toThrow(/open in another Harness process/);
        // One that crashed while taking it over doesn't block it for good.
        const old = new Date(Date.now() - 60_000);
        utimesSync(`${s.path}.lock.takeover`, old, old);
        const again = Session.load(s.path);
        expect(JSON.parse(readFileSync(`${s.path}.lock`, "utf-8")).pid).toBe(process.pid);
        expect(existsSync(`${s.path}.lock.takeover`)).toBe(false);
        again.release();
    });

    test("this process may load what it already has open; the lock goes with the last copy released", () => {
        const s = Session.create(project());
        s.push(user("hi"));
        expect(existsSync(`${s.path}.lock`)).toBe(true);
        // A copy still closing (the GUI unloading it) overlapping the one reopened.
        const again = Session.load(s.path);
        expect(again.messages).toHaveLength(1);
        s.release();
        s.release();
        expect(existsSync(`${s.path}.lock`)).toBe(true);
        again.release();
        expect(existsSync(`${s.path}.lock`)).toBe(false);
    });
});
