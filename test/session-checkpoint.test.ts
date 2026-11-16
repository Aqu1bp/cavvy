// A session read from its checkpoint (agent/session.ts: what reading its file came to, up to a point) and the rest of
// its file is the session reading all of its file makes: every field, whatever was written since.
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { Message } from "../src/providers/types";

const iso = isolate();
const { Session, checkpointFile, checkpointing } = await import("../src/agent/session");
const { writeThread } = await import("../scripts/perf-thread");
const { digestToolState, lastCheckpointOf, lastPlanCall, latestCheckpointOf, toolStateOf } = await import("../src/agent/history-digest");
afterAll(() => iso.cleanup());

/** In memory only, or how it's held: not what it is. */
const RUNTIME = new Set(["file", "persist", "strictWrites", "holding", "released", "started", "pending", "torn", "failing", "loadedLines", "writtenAt", "switchRuns", "subagentRuns", "runsFor", "hookContext", "hookWatchPaths", "hooksStarting", "onSaving", "usageRecords", "loadedMessages", "digest", "digestible", "pushedUnread"]);
/** Every field of it, as data. */
function fields(s: InstanceType<typeof Session>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) if (!RUNTIME.has(k) && typeof v !== "function") out[k] = v instanceof Map ? [...v] : v;
    // Its messages as they're asked for (read then, where a checkpoint has a digest of them in their place).
    out.messages = s.messages;
    return JSON.parse(JSON.stringify(out));
}
/** Read whole (its checkpoint put aside), and read from its checkpoint. */
function bothWays(file: string) {
    const fromCheckpoint = fields(Session.peek(file));
    const cp = checkpointFile(file);
    renameSync(cp, `${cp}.aside`);
    try {
        return { fromCheckpoint, whole: fields(Session.peek(file)) };
    } finally {
        renameSync(`${cp}.aside`, cp);
    }
}

const prompt = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], meta: { kind: "prompt" } }) as Message;
const reply = (text: string, toolCall?: string): Message =>
    ({ role: "assistant", provider: "mock", model: "m", stopReason: toolCall ? "tool_use" : "end_turn", content: [{ type: "text", text }, ...(toolCall ? [{ type: "tool_call", id: toolCall, name: "bash", input: { command: "ls" } }] : [])] }) as Message;
const result = (id: string): Message => ({ role: "user", content: [{ type: "tool_result", toolCallId: id, content: "a b c" }], meta: { kind: "tool_results" } }) as Message;

/** Some of everything a session's file says. */
function work(s: InstanceType<typeof Session>, n: number) {
    s.push(prompt(`prompt ${n}`));
    s.push(reply(`calling ${n}`, `call-${n}`));
    s.push(result(`call-${n}`));
    s.push(reply(`done ${n}`));
    s.recordUsage("mock:m", { inputTokens: 10 + n, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 }, 0.01 * n);
    s.recordNotice("warn", `notice ${n}`);
    s.setTitle(`Title ${n}`);
    s.setModel(n % 2 ? "mock:m" : "mock:n");
    s.setFastMode(n % 2 === 0);
    s.setWorkdir(`/work/${n}`);
    s.setGoal({ text: `goal ${n}`, setAt: n } as never);
    s.addPlan(`plan-${n}`, `the plan ${n}`);
    // A thread of each CLI, in its home; Codex's set aside (parked) as its account changes.
    s.setBackendSession("claude-code", `thread-${n}`, s.messages.length, { folder: `/homes/claude-${n}` });
    s.setBackendSession("codex", `cx-${n}`, s.messages.length, { folder: `/homes/codex-${n}` });
    s.setAccount("codex", `work-${n}`);
    s.addPlanLink({ role: "to", session: `other-${n}`, folder: "/project", path: `/plans/${n}.md`, branch: "main", at: n } as never);
    s.recordBackgroundTask({ id: `task-${n}`, provider: "cavvy", kind: "shell", label: `job ${n}`, startedAt: n, status: "done" } as never);
    s.setSchedules([{ id: `a${n}`, kind: "loop", prompt: "again", everyMs: 3_600_000, recurring: true, durable: true, createdAt: n, runs: 0 } as never]);
    s.refuseImages([s.messages[0]!], "mock:m");
}

test("read from its checkpoint and what's been written since, a session is what reading all of it makes", () => {
    const was = { ...checkpointing };
    Object.assign(checkpointing, { after: 1, most: Infinity });
    try {
        const cwd = tempDir("cavvy-checkpoint-");
        const s = Session.create(cwd);
        for (let n = 0; n < 4; n++) work(s, n);
        s.compact("summary one", [prompt("summary")]);
        work(s, 4);
        s.rewind(s.messages.length - 2);
        work(s, 7);
        s.release();
        const file = s.path;
        // Read (whole): its checkpoint written.
        Session.load(file).release();
        expect(existsSync(checkpointFile(file))).toBe(true);
        // Nothing written since: all of it from the checkpoint, every field set to something (or this checks nothing).
        const first = bothWays(file);
        expect(first.fromCheckpoint).toEqual(first.whole);
        const empty = Object.entries(first.whole).filter(([, v]) => v === undefined || (Array.isArray(v) && !v.length) || (typeof v === "object" && v !== null && !Object.keys(v).length)).map(([k]) => k);
        expect(empty).toEqual([]);
        for (const [k, v] of Object.entries(first.whole)) expect([k, v === undefined || (Array.isArray(v) && !v.length) || (typeof v === "object" && v !== null && !Object.keys(v).length)]).toEqual([k, false]);
        // Written to since: read from its checkpoint, then what came after (a compaction, a rewind, a withdrawal among it).
        const again = Session.load(file);
        work(again, 5);
        again.compact("summary two", [prompt("summary")]);
        work(again, 6);
        again.withdraw(again.messages.length - 1);
        again.forgetBackendSession("claude-code");
        again.release();
        const { fromCheckpoint, whole } = bothWays(file);
        expect(fromCheckpoint).toEqual(whole);
        expect(whole.segments).toBe(3);
        expect((whole.messages as unknown[]).length).toBeGreaterThan(0);
    } finally {
        Object.assign(checkpointing, was);
    }
});

test("a long session's checkpoint is read in place of what its compactions cleared", () => {
    const cwd = join(tempDir("cavvy-checkpoint-long-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 3000, kind: "native", seed: 2 });
    Session.load(t.file).release();
    const cp = checkpointFile(t.file);
    expect(existsSync(cp)).toBe(true);
    // What's read in place of the file: a small part of it.
    expect(statSync(cp).size).toBeLessThan(statSync(t.file).size * checkpointing.most);
    const { fromCheckpoint, whole } = bothWays(t.file);
    expect(fromCheckpoint).toEqual(whole);
});

// One never compacted (a Claude Code session's) keeps all its messages: its checkpoint has a digest of them in their
// place, made without a checkpoint of them all to throw away (18 ms of opening one of 100,000 items), and opened from it
// they aren't read until they're asked for; then they're what reading all of it makes.
test("a long session never compacted is opened from a digest of its messages, read as they're asked for", () => {
    const cwd = join(tempDir("cavvy-checkpoint-cli-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 3000, kind: "cli", seed: 2 });
    const was = { ...checkpointing };
    checkpointing.after = 1;
    const stringify = JSON.stringify;
    let longest = 0;
    JSON.stringify = ((...args: Parameters<typeof stringify>) => {
        const out = stringify(...args);
        longest = Math.max(longest, out?.length ?? 0);
        return out;
    }) as typeof stringify;
    try {
        Session.load(t.file).release();
    } finally {
        JSON.stringify = stringify;
    }
    try {
        expect(longest).toBeLessThan(statSync(t.file).size * 0.1);
        expect(statSync(checkpointFile(t.file)).size).toBeLessThan(statSync(t.file).size * 0.1);
        const s = Session.peek(t.file);
        expect(s.historyDigest).toBeDefined();
        const count = s.messageCount;
        const { fromCheckpoint, whole } = bothWays(t.file);
        expect(fromCheckpoint).toEqual(whole);
        expect(count).toBe((whole.messages as unknown[]).length);
    } finally {
        Object.assign(checkpointing, was);
    }
});

// Messages added since its digest was made are put on it as they're read (digestWith); any other change to them (a
// rewind, images refused) and it's read whole. Either way, what reading all of it makes.
test("a session opened from a digest of its messages and written to since reads as reading all of it makes", () => {
    const cwd = join(tempDir("cavvy-checkpoint-cli-since-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 3000, kind: "cli", seed: 4 });
    const was = { ...checkpointing };
    checkpointing.after = 1;
    // What a digest says, and what the same from its messages says.
    const said = (s: InstanceType<typeof Session>) => {
        const d = s.historyDigest!;
        return { count: d.count, tools: digestToolState(d), plan: d.plan, checkpoint: d.checkpoint, latest: d.latestCheckpoint, last: s.lastMessage };
    };
    const truth = (messages: Message[]) => ({ count: messages.length, tools: toolStateOf(messages), plan: lastPlanCall(messages), checkpoint: lastCheckpointOf(messages), latest: latestCheckpointOf(messages), last: messages.at(-1) });
    try {
        Session.load(t.file).release();
        // Only added to: a turn with its todos and a plan, then the next prompt.
        const s = Session.load(t.file);
        expect(s.historyDigest).toBeDefined();
        s.push(prompt("plan it"));
        s.push({ role: "assistant", provider: "mock", model: "m", stopReason: "tool_use", content: [{ type: "tool_call", id: "todo-1", name: "TodoWrite", input: { todos: [{ content: "one", status: "pending", activeForm: "Doing one" }] } }, { type: "tool_call", id: "plan-1", name: "ExitPlanMode", input: { plan: "The plan" } }] } as Message);
        s.push({ role: "user", content: [{ type: "tool_result", toolCallId: "todo-1", content: "ok" }, { type: "tool_result", toolCallId: "plan-1", content: "ok" }], meta: { kind: "tool_results", checkpoint: 7 } } as Message);
        s.push(reply("done"));
        const next = s.push(prompt("next"));
        // Put on its digest, not read.
        expect(s.historyDigest?.count).toBe(s.messageCount);
        expect(s.lastMessage).toBe(next);
        // Asked for, they're read: the ones pushed are the objects pushed.
        expect(s.messages.at(-1)).toBe(next);
        expect(s.historyDigest).toBeUndefined();
        s.release();
        const added = Session.peek(t.file);
        expect(added.historyDigest).toBeDefined();
        const whole = bothWays(t.file);
        expect(said(added)).toEqual(truth(whole.whole.messages as Message[]));
        expect(said(added).tools.todos).toHaveLength(1);
        expect(whole.fromCheckpoint).toEqual(whole.whole);
        // Changed otherwise: read whole.
        const again = Session.load(t.file);
        work(again, 1);
        again.rewind(again.messageCount - 2);
        again.release();
        const after = bothWays(t.file);
        expect(after.fromCheckpoint).toEqual(after.whole);
        // A message taken out, then more added after it: read whole, each once.
        Session.load(t.file).release();
        const steered = Session.load(t.file);
        expect(steered.historyDigest).toBeDefined();
        steered.push(prompt("steer"));
        steered.withdraw(steered.messageCount - 1);
        work(steered, 2);
        const count = steered.messageCount;
        steered.release();
        const withdrawn = bothWays(t.file);
        expect(withdrawn.fromCheckpoint).toEqual(withdrawn.whole);
        expect(withdrawn.whole.messages as unknown[]).toHaveLength(count);
    } finally {
        Object.assign(checkpointing, was);
    }
});

// It's checked as the session heads' cache is (sessionHead): a file that's only ever appended to is the same file, with
// the same bytes up to where it was read, if it's the same inode, at least that long, and ends there as it did then.
test("a checkpoint of a file since changed where it was read to, cut shorter, or replaced, isn't used", () => {
    const was = { ...checkpointing };
    Object.assign(checkpointing, { after: 1, most: Infinity });
    try {
        const cwd = tempDir("cavvy-checkpoint-changed-");
        const s = Session.create(cwd);
        work(s, 1);
        s.setTitle("Title Z");
        s.release();
        const file = s.path;
        Session.load(file).release();
        const title = (f: string) => Session.peek(f).title;
        expect(title(file)).toBe("Title Z");
        // Its last bytes before where it was read to changed (the same length): read whole.
        const text = readFileSync(file, "utf-8");
        const at = text.lastIndexOf("Title Z");
        writeFileSync(file, text.slice(0, at) + "Title X" + text.slice(at + 7));
        expect(title(file)).toBe("Title X");
        // Cut short of it (before its last title): read whole, the title before.
        writeFileSync(file, text);
        Session.load(file).release();
        writeFileSync(file, text.slice(0, text.lastIndexOf("\n", at) + 1));
        expect(title(file)).toBe("Title 1");
        // Back as it was, but another file (a copy put in its place): read whole too.
        writeFileSync(file, text);
        Session.load(file).release();
        const copy = `${file}.copy`;
        copyFileSync(file, copy);
        appendFileSync(copy, JSON.stringify({ t: "title", title: "Title C" }) + "\n");
        rmSync(file);
        renameSync(copy, file);
        expect(title(file)).toBe("Title C");
    } finally {
        Object.assign(checkpointing, was);
    }
});

// Its messages read from the file on demand are the file's: a tool call it ends with is answered once, by the session
// that was opened (repairTail), not again by the read; and a read that fails leaves the session as it was.
test("a session opened from a digest answers a dangling tool call once, and keeps its messages if reading them fails", () => {
    const cwd = join(tempDir("cavvy-checkpoint-dangling-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 3000, kind: "cli", seed: 2 });
    const was = { ...checkpointing };
    checkpointing.after = 1;
    try {
        Session.load(t.file).release();
        const running = Session.load(t.file);
        expect(running.historyDigest).toBeDefined();
        running.push(prompt("go"));
        running.push(reply("calling", "call-x"));
        // A peer looks in mid-tool, opened from the digest: its repair is in memory only, so it reads them.
        const p = Session.peek(t.file);
        const answers = (m: Message[]) => m.filter((x) => x.content.some((c) => c.type === "tool_result" && (c as { toolCallId: string }).toolCallId === "call-x")).length;
        expect(answers(p.messages)).toBe(1);
        expect(p.messageCount).toBe(running.messageCount + 1);
        running.push(result("call-x"));
        running.push(reply("done"));
        running.release();

        const s = Session.peek(t.file);
        expect(s.historyDigest).toBeDefined();
        const count = s.messageCount;
        renameSync(t.file, t.file + ".aside");
        try {
            expect(() => s.messages).toThrow();
        } finally {
            renameSync(t.file + ".aside", t.file);
        }
        expect(s.historyDigest).toBeDefined();
        expect(s.messageCount).toBe(count);
        expect(s.messages.length).toBe(count);
    } finally {
        Object.assign(checkpointing, was);
    }
});

// Its messages' size is set against the file's in the same unit: text that's more bytes than characters still digests.
test("a long session in a language of many bytes per character is opened from a digest too", () => {
    const cwd = join(tempDir("cavvy-checkpoint-cjk-"), "project");
    mkdirSync(cwd, { recursive: true });
    const was = { ...checkpointing };
    checkpointing.after = 1;
    try {
        const s = Session.create(cwd);
        const text = "日本語のテキストです。".repeat(40);
        for (let i = 0; i < 400; i++) {
            s.push(prompt(`${i} ${text}`));
            s.push(reply(`${i} ${text}`));
        }
        const file = s.file;
        s.release();
        Session.load(file).release();
        const opened = Session.peek(file);
        expect(opened.historyDigest).toBeDefined();
        expect(statSync(checkpointFile(file)).size).toBeLessThan(statSync(file).size * 0.1);
        const { fromCheckpoint, whole } = bothWays(file);
        expect(fromCheckpoint).toEqual(whole);
    } finally {
        Object.assign(checkpointing, was);
    }
});
