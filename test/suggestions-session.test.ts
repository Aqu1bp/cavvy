// Suggested tasks in the session file (src/agent/session.ts): kept as {t:"suggestion"} lines, the last for an id
// winning; through reloads, compaction and checkpoints; taken away by a rewind past them; not copied by a fork.

import { afterAll, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
afterAll(() => iso.cleanup());
const { Session, checkpointing } = await import("../src/agent/session");
const { forkSession } = await import("../src/agent/fork");
import type { SuggestionRecord } from "../src/agent/suggestions";

const cwd = realpathSync(tempDir("suggest-session-"));
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], meta: { kind: "prompt" } }) as never;
const reply = (text: string) => ({ role: "assistant", provider: "mock", model: "m", stopReason: "end_turn", content: [{ type: "text", text }] }) as never;
const suggest = (s: InstanceType<typeof Session>, id: string, o: Partial<SuggestionRecord> = {}): SuggestionRecord => {
    const r: SuggestionRecord = { id, title: `Task ${id}`, prompt: "Fix it.", why: "Saw it.", at: Date.now(), state: "pending", ...s.suggestionAt(), ...o };
    s.setSuggestion(r);
    return r;
};

test("kept through a reload, the last line for an id winning, in the order they were made", () => {
    const s = Session.create(cwd);
    s.push(user("first"));
    const a = suggest(s, "a");
    suggest(s, "b");
    s.setSuggestion({ ...a, state: "dismissed" });
    s.release();
    const lines = readFileSync(s.path, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.t === "suggestion").length).toBe(3);
    const again = Session.load(s.path);
    expect([...again.suggestions.values()].map((r) => [r.id, r.state])).toEqual([["a", "dismissed"], ["b", "pending"]]);
    again.release();
});

test("a rewind past one takes it away (withdrawn, in the file too); one before it stays; through compaction too", () => {
    const s = Session.create(cwd);
    s.push(user("one"));
    s.push(reply("ok"));
    suggest(s, "early");
    s.push(user("two"));
    suggest(s, "late");
    s.rewind(2);
    expect(s.suggestions.get("late")?.state).toBe("withdrawn");
    expect(s.suggestions.get("early")?.state).toBe("pending");
    // A compaction after: the rewind before it isn't read again, the withdrawn line is.
    s.push(user("three"));
    s.compact("summary", [user("three")]);
    s.release();
    const again = Session.load(s.path);
    expect(again.suggestions.get("late")?.state).toBe("withdrawn");
    expect(again.suggestions.get("early")?.state).toBe("pending");
    // One made after the compaction isn't taken by a rewind of the new segment's messages before it.
    again.push(user("four"));
    suggest(again, "after");
    again.rewind(again.messageCount);
    expect(again.suggestions.get("after")?.state).toBe("pending");
    again.release();
});

test("read from a checkpoint", () => {
    const s = Session.create(cwd);
    s.push(user("one"));
    suggest(s, "cp");
    s.push(reply("done"));
    s.release();
    const was = checkpointing.after;
    checkpointing.after = 1;
    try {
        Session.load(s.path).release(); // writes the checkpoint
        const again = Session.load(s.path); // reads it
        expect(again.suggestions.get("cp")?.state).toBe("pending");
        again.release();
    } finally {
        checkpointing.after = was;
    }
});

test("the new session's origin is kept in its first line", () => {
    const s = Session.create(cwd);
    s.meta.suggestedBy = { key: "s1#c1", session: "s1", title: "Building login" };
    s.push(user("Fix it."));
    s.release();
    const again = Session.load(s.path);
    expect(again.meta.suggestedBy).toEqual({ key: "s1#c1", session: "s1", title: "Building login" });
    again.release();
});

test("a fork doesn't take the original's suggestions: a second Start would make the same task twice", () => {
    const s = Session.create(cwd);
    s.push(user("one"));
    suggest(s, "mine");
    s.push(reply("ok"));
    const fork = forkSession(s, { cut: s.messageCount, title: "x" });
    expect(fork.suggestions.size).toBe(0);
    expect(readFileSync(fork.path, "utf-8")).not.toContain('"t":"suggestion"');
    fork.release();
    s.release();
});
