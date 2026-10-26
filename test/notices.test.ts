// Notices as data (#426): an account switch is one line between turns, switches with no message between them are
// one (the latest, with every task they stopped), a CLI's own words keep their title and link, a plan limit says
// whose and until when, and a session file from before these still reads, its notices as plain lines.

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, realpathSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { cleanup } = isolate();
const { Session, addNotice, noticeData } = await import("../src/agent/session");
const { readSegments, replay, UiLog, liveNotice } = await import("../src/server/history");
const { cliNotice } = await import("../src/backends/notice-data");
const { limitNotice, limitStopOf } = await import("../src/backends/limits");
const { accountNoticeText, stoppedTasksTip, switchMeaning, switchWord } = await import("../src/server/protocol");
import type { NoticeAccount } from "../src/server/protocol";

afterAll(cleanup);

const codex = (name: string, how: NoticeAccount["how"], more: Partial<NoticeAccount> = {}): NoticeAccount => ({ provider: "codex", cli: "Codex", name, how, ...more });
const prompt = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], meta: { kind: "prompt" as const } });
const answer = (text: string) => ({ role: "assistant" as const, provider: "test", model: "test", stopReason: "end_turn" as const, content: [{ type: "text" as const, text }] }) as any;

function session() {
    return Session.create(realpathSync(tempDir()), { system: "SYSTEM" });
}

function reopen(file: string) {
    const s = Session.load(file);
    try {
        let i = 0;
        return { notices: s.notices, turns: replay({ segments: readSegments(file), current: s.messages, currentNotices: s.notices, ui: new UiLog(file, s.meta.id, false), meta: (c) => ({ title: c.name }), newId: () => `id${++i}` }) };
    } finally {
        s.release();
    }
}

test("two switches with no message between them are one notice, the latest, live and read back", () => {
    const s = session();
    s.push(prompt("hello"));
    s.push(answer("hi"));
    const first = s.recordSwitch(codex("Default", "native"));
    expect(first.merged).toBe(false);
    const second = s.recordSwitch(codex("Second", "handoff", { dropped: true }));
    expect(second.merged).toBe(true);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]!.account).toEqual(codex("Second", "handoff", { dropped: true }));
    expect(s.notices[0]!.text).toBe("Codex · Second · new thread");
    const file = s.path;
    s.release();
    const back = reopen(file);
    expect(back.notices.map((n) => n.account)).toEqual([codex("Second", "handoff", { dropped: true })]);
});

test("the tasks a switch's restart stopped stay said under the latest switch, and a later one doesn't change who it's to", () => {
    const s = session();
    s.push(prompt("start it"));
    const origin = s.recordSwitch(codex("Default", "native")).notice;
    s.recordSwitch(codex("Second", "handoff"));
    // The first switch's release ends after the second switch: its task goes under the latest line, one with it.
    const r = s.recordStopped(origin, { provider: "codex", cli: "Codex", tasks: [{ label: "bun test ./test/a.test.ts", command: "bun test ./test/a.test.ts --timeout 1" }] });
    expect(r.merged).toBe(true);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]!.account).toEqual(codex("Second", "handoff", { stopped: [{ label: "bun test ./test/a.test.ts", command: "bun test ./test/a.test.ts --timeout 1" }] }));
    // A third switch keeps them.
    s.recordSwitch(codex("Third", "native"));
    expect(s.notices[0]!.account?.stopped).toHaveLength(1);
    expect(s.notices[0]!.text).toBe("Codex · Third · resumed\nStopped: bun test ./test/a.test.ts");
    const file = s.path;
    s.release();
    expect(reopen(file).notices.map((n) => n.account)).toEqual([codex("Third", "native", { stopped: [{ label: "bun test ./test/a.test.ts", command: "bun test ./test/a.test.ts --timeout 1" }] })]);
});

test("what a restart stopped, said once a message came, another notice, or with no switch line: a line of its own that switches nothing", () => {
    const tasks = [{ label: "sleep 30" }];
    const stopped = { provider: "codex", cli: "Codex", tasks };
    const s = session();
    s.push(prompt("one"));
    s.push(answer("ok"));
    const origin = s.recordSwitch(codex("Second", "native")).notice;
    s.push(prompt("two"));
    expect(s.recordStopped(origin, stopped)).toMatchObject({ merged: false, notice: { text: "Stopped: sleep 30", stopped } });
    expect(s.notices.at(-1)!.account).toBeUndefined();
    const other = s.recordSwitch(codex("Third", "native")).notice;
    s.recordNotice("warn", "Something else.");
    expect(s.recordStopped(other, stopped).merged).toBe(false);
    expect(s.recordStopped(undefined, { ...stopped, tasks: [{ label: "a" }, { label: "b" }] }).notice.text).toBe("2 tasks stopped");
    expect(s.notices.map((n) => n.account?.name ?? n.text)).toEqual(["Second", "Stopped: sleep 30", "Third", "Something else.", "Stopped: sleep 30", "2 tasks stopped"]);
    const file = s.path;
    s.release();
    const back = reopen(file);
    expect(back.notices.map((n) => n.account?.name ?? n.text)).toEqual(["Second", "Stopped: sleep 30", "Third", "Something else.", "Stopped: sleep 30", "2 tasks stopped"]);
    expect(back.notices[1]!.stopped).toEqual(stopped);
    // In the prompt's turn: it doesn't start one (the switch after it does).
    expect(back.turns.map((t) => t.prompt?.text ?? null)).toEqual(["one", null, "two", null]);
    expect(back.turns[2]!.blocks.map((b) => (b.t === "notice" ? b.text : b.t))).toEqual(["Stopped: sleep 30"]);
});

test("a message between switches, another CLI, or another notice keeps them apart", () => {
    const s = session();
    s.push(prompt("one"));
    s.recordSwitch(codex("Default", "native"));
    s.push(prompt("two"));
    s.recordSwitch(codex("Second", "native"));
    s.recordSwitch({ provider: "claude-code", cli: "Claude Code", name: "Work", how: "native" });
    s.recordNotice("info", "Something else.");
    s.recordSwitch(codex("Third", "native"));
    expect(s.notices.map((n) => n.account?.name ?? n.text)).toEqual(["Default", "Second", "Work", "Something else.", "Third"]);
    const file = s.path;
    s.release();
    expect(reopen(file).notices.map((n) => n.account?.name ?? n.text)).toEqual(["Default", "Second", "Work", "Something else.", "Third"]);
});

test("replayed, a switch is a turn of its own with no prompt, between the turns, as the live session shows it", () => {
    const s = session();
    s.push(prompt("why does the pane jump?"));
    s.push(answer("It re-measures."));
    const line = s.recordSwitch(codex("Second", "handoff")).notice;
    s.recordStopped(line, { provider: "codex", cli: "Codex", tasks: [{ label: "Run the suite" }] });
    s.push(prompt("review the diff"));
    s.push(answer("Looks fine."));
    const file = s.path;
    s.release();
    const { turns } = reopen(file);
    expect(turns.map((t) => t.prompt?.text ?? null)).toEqual(["why does the pane jump?", null, "review the diff"]);
    expect(turns[0]!.blocks.some((b) => b.t === "notice")).toBe(false);
    expect(turns[1]!.blocks).toEqual([{ t: "notice", id: expect.any(String), level: "info", text: "Codex · Second · new thread\nStopped: Run the suite", account: codex("Second", "handoff", { stopped: [{ label: "Run the suite" }] }) }]);
});

test("a session file from before structured notices reads its plain ones as lines, by level", () => {
    const s = session();
    s.push(prompt("go"));
    s.push(answer("done"));
    const file = s.path;
    s.release();
    // As older versions wrote them: text only, the switch's prose and the restart's warning as two notices.
    appendFileSync(file, JSON.stringify({ t: "notice", index: 2, level: "info", text: "Continuing on Codex · Second: the same Codex session goes on, resumed natively (this account shares its history).", at: 1 }) + "\n");
    appendFileSync(file, JSON.stringify({ t: "notice", index: 2, level: "warn", text: "Codex was restarted for the account change: 1 background task stopped.", at: 2 }) + "\n");
    const { notices, turns } = reopen(file);
    expect(notices.map((n) => [n.level, n.account])).toEqual([["info", undefined], ["warn", undefined]]);
    const blocks = turns.at(-1)!.blocks.filter((b) => b.t === "notice");
    expect(blocks).toEqual([
        { t: "notice", id: expect.any(String), level: "info", text: "Continuing on Codex · Second: the same Codex session goes on, resumed natively (this account shares its history)." },
        { t: "notice", id: expect.any(String), level: "warn", text: "Codex was restarted for the account change: 1 background task stopped." },
    ]);
});

test("a notice's data is read back only when it's well formed", () => {
    expect(noticeData({ source: "codex", title: "", link: "javascript:alert(1)" })).toEqual({ source: "codex" });
    expect(noticeData({ account: { provider: "codex", cli: "Codex", name: "X", how: "sideways" } as any })).toEqual({});
    expect(noticeData({ account: { provider: "codex", cli: "Codex", name: "X", how: "native", stopped: [{ label: "a", command: 3 }, null, { label: "" }] } as any })).toEqual({ account: { provider: "codex", cli: "Codex", name: "X", how: "native", stopped: [{ label: "a" }] } });
    expect(noticeData({ limit: { provider: "codex", accountId: "second", name: "Second", window: "5-hour", resetsAt: 5, credits: "yes" } as any })).toEqual({ limit: { provider: "codex", accountId: "second", name: "Second", window: "5-hour", resetsAt: 5 } });
    // addNotice merges only switches.
    const list: any[] = [{ index: 1, level: "info", text: "a", at: 0 }];
    addNotice(list, { index: 1, level: "info", text: "b", at: 0 });
    expect(list).toHaveLength(2);
});

test("what a switch says: a word, its meaning for the tooltip, and its stopped tasks' commands", () => {
    expect(switchWord("native")).toBe("resumed");
    expect(switchWord("returned")).toBe("resumed");
    expect(switchWord("handoff")).toBe("new thread");
    expect(switchMeaning(codex("Second", "handoff", { dropped: true }))).toBe("Switched to Codex · Second. New thread: this conversation was handed over (this account doesn't share the earlier thread).");
    expect(switchMeaning(codex("Second", "native"))).toBe("Switched to Codex · Second. Same session, resumed: this account shares its history.");
    expect(accountNoticeText(codex("Second", "native", { stopped: [{ label: "a" }, { label: "b" }] }))).toBe("Codex · Second · resumed\n2 tasks stopped");
    expect(stoppedTasksTip("claude-code", [{ label: "Run the suite", command: "bun test" }, { label: "Map auth" }])).toBe("Stopped by the switch's restart:\nRun the suite\n  $ bun test\nMap auth");
    // Codex has no descriptions: its commands, whole.
    expect(stoppedTasksTip("codex", [{ label: "bun test ./a…", command: "bun test ./a ./b" }, { label: "sleep 5" }])).toBe("Stopped by the switch's restart:\n$ bun test ./a ./b\n$ sleep 5");
});

test("a CLI's warning keeps its first line as the title, and the docs link it ends with as a link", () => {
    const said = "Claude can't use thinking from another organization\nClaude's earlier thinking was written while you were signed in to another organization, so Claude can't use it now. See docs for more: https://platform.claude.com/docs/en/build-with-claude/preserved-thinking";
    expect(cliNotice("claude-code", "warn", said)).toEqual({
        source: "claude-code",
        title: "Claude can't use thinking from another organization",
        text: "Claude's earlier thinking was written while you were signed in to another organization, so Claude can't use it now.",
        link: "https://platform.claude.com/docs/en/build-with-claude/preserved-thinking",
    });
    // One line, or info: the text whole (no "Codex: " in it).
    expect(cliNotice("codex", "info", "This session was recorded with model `gpt-6-sol`.\nMore.")).toEqual({ source: "codex", text: "This session was recorded with model `gpt-6-sol`.\nMore." });
    expect(cliNotice("claude-code", "warn", "Just one line.")).toEqual({ source: "claude-code", text: "Just one line." });
    // A live notice's text is the data's, redacted; the message stays the terminal's.
    expect(liveNotice("n1", "info", "Codex: hello", { source: "codex", text: "hello" })).toEqual({ t: "notice", id: "n1", level: "info", text: "hello", source: "codex" });
    expect(liveNotice("n2", "warn", "plain")).toEqual({ t: "notice", id: "n2", level: "warn", text: "plain" });
});

test("a limit says whose, which window and until when; a turn it stopped says the window too", () => {
    const limits = { provider: "codex", accountId: "default", windows: [{ id: "codex:primary", label: "5-hour", reached: true, resetsAt: 9_000 }, { id: "codex:secondary", label: "Weekly", usedPercent: 40 }], reached: true, resetsAt: 9_000, at: 1 } as any;
    expect(limitStopOf(limits, 9_000)).toEqual({ resetsAt: 9_000, window: "5-hour" });
    expect(limitStopOf(undefined, undefined)).toEqual({});
    expect(limitNotice("codex", "default", limits)).toEqual({ provider: "codex", accountId: "default", name: "Default", window: "5-hour", resetsAt: 9_000 });
    expect(limitNotice("codex", "default", limits, { credits: true })).toMatchObject({ credits: true });
    expect(limitNotice("codex", "default", undefined, { window: "Weekly" })).toEqual({ provider: "codex", accountId: "default", name: "Default", window: "Weekly" });
});

test("a notice recorded with a limit or a CLI's title reads back with them", () => {
    const s = session();
    s.push(prompt("fix it"));
    s.recordNotice("error", "Codex · Second: usage limit reached.", { source: "codex", limit: { provider: "codex", accountId: "second", name: "Second", window: "5-hour", resetsAt: 123 } });
    s.recordNotice("warn", "Title\nBody", { source: "claude-code", title: "Title", text: "Body", link: "https://example.com/docs" });
    const file = s.path;
    s.release();
    const { turns } = reopen(file);
    const blocks = turns.at(-1)!.blocks.filter((b) => b.t === "notice");
    expect(blocks).toEqual([
        { t: "notice", id: expect.any(String), level: "error", text: "Codex · Second: usage limit reached.", source: "codex", limit: { provider: "codex", accountId: "second", name: "Second", window: "5-hour", resetsAt: 123 } },
        // What it shows under its title, as the live notice did.
        { t: "notice", id: expect.any(String), level: "warn", text: "Body", source: "claude-code", title: "Title", link: "https://example.com/docs" },
    ]);
    expect(turns.at(-1)!.status).toBe("error");
});
