// How the GUI reads a notice (#426): which kind draws it, the few words a limit or a warning says, what find counts,
// which notices sit above "Worked for", and the limit card taking the place of the turn's earlier warning.

import { expect, test } from "bun:test";
import type { Block, NoticeBlock, ScheduleInfo } from "../src/server/protocol";

const { codeRuns, errorParts, hasErrorCard, leadingNotices, limitTitle, listedSchedules, noticeKind, noticeReads, plainOf, shownBlocks, switchLine, waitingResume, warnParts } = await import("../gui/src/lib/notices");

const at = (h: number, m = 0) => new Date(2026, 9, 23, h, m).getTime();
const NOW = at(13, 35);
const n = (o: Partial<NoticeBlock>): NoticeBlock => ({ t: "notice", id: "n", level: "info", text: "", ...o });
const limit = { provider: "codex", accountId: "second", name: "Second", window: "5-hour", resetsAt: at(15, 40) };

test("each notice is drawn as what it is; an old plain one by its level", () => {
    expect(noticeKind(n({ account: { provider: "codex", cli: "Codex", name: "Second", how: "native" } }))).toBe("switch");
    expect(noticeKind(n({ level: "warn", text: "Codex was restarted for the account change: 1 background task stopped." }))).toBe("warn");
    expect(noticeKind(n({ level: "error", text: "boom" }))).toBe("error");
    // What a switch stopped, said after a message came: its own line, no switch.
    expect(noticeKind(n({ text: "Stopped: sleep 30", stopped: { provider: "codex", cli: "Codex", tasks: [{ label: "sleep 30" }] } }))).toBe("stopped");
    expect(noticeKind(n({ text: "Continuing on Codex · Second: …" }))).toBe("info");
});

test("a limit in a few words: the card, credits, reached", () => {
    const time = new Date(at(15, 40)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    expect(limitTitle(limit, "error", NOW)).toBe(`Second is out of its 5-hour limit until ${time}`);
    expect(limitTitle({ ...limit, window: "Weekly" }, "error", NOW)).toBe(`Second is out of its weekly limit until ${time}`);
    expect(limitTitle({ ...limit, window: undefined, resetsAt: undefined }, "error", NOW)).toBe("Second is out of its usage limit");
    expect(limitTitle({ ...limit, credits: true }, "warn", NOW)).toBe(`Using credits until ${time}`);
    expect(limitTitle(limit, "warn", NOW)).toBe("5-hour limit reached");
    // Past its reset, no "until".
    expect(limitTitle(limit, "error", at(16))).toBe("Second is out of its 5-hour limit");
});

test("a warning's pill: the CLI's title, what folds under it; Cavvy's own sentence is the pill", () => {
    expect(warnParts(n({ level: "warn", title: "Claude can't use thinking from another organization", text: "Claude's earlier thinking…", source: "claude-code" }), NOW)).toEqual({ title: "Claude can't use thinking from another organization", body: "Claude's earlier thinking…" });
    expect(warnParts(n({ level: "warn", text: "Claude Code ended the turn without a reply." }), NOW)).toEqual({ title: "Claude Code ended the turn without a reply." });
    expect(warnParts(n({ level: "warn", text: "Codex · Default: usage limit reached …", limit: { ...limit, credits: true } }), NOW).title).toStartWith("Using credits until ");
});

test("an error's card: one short sentence, and the CLI's raw words under it", () => {
    expect(errorParts(n({ level: "error", text: 'Claude Code stopped: API Error: 500 {"type":"error"}' }), NOW)).toEqual({ title: "Claude Code stopped", body: 'API Error: 500 {"type":"error"}' });
    expect(errorParts(n({ level: "error", text: "The model reached its context window. Compact the conversation." }), NOW)).toEqual({ title: "The model reached its context window. Compact the conversation." });
    expect(errorParts(n({ level: "error", text: "Codex · Second: usage limit reached.", limit }), NOW).title).toStartWith("Second is out of its 5-hour limit");
});

test("`code` reads as code, and find counts it without the backticks", () => {
    expect(codeRuns("recorded with `gpt-6-sol` but resuming with `gpt-6-luna`.")).toEqual(["recorded with ", "gpt-6-sol", " but resuming with ", "gpt-6-luna", "."]);
    expect(codeRuns("one ` alone")).toEqual(["one ` alone"]);
    expect(plainOf("a `b` c")).toBe("a b c");
});

test("find reads a notice as it's drawn: a switch's line, a pill's title then its body, a card's sentence", () => {
    const sw = n({ account: { provider: "codex", cli: "Codex", name: "Second", how: "handoff", stopped: [{ label: "bun test ./test/a.test.ts" }] } });
    expect(switchLine(sw)).toBe("Codex · Second new thread\nStopped: bun test ./test/a.test.ts");
    expect(noticeReads(sw, NOW)).toBe(switchLine(sw));
    expect(noticeReads(n({ account: { provider: "codex", cli: "Codex", name: "Second", how: "native", stopped: [{ label: "a" }, { label: "b" }] } }), NOW)).toBe("Codex · Second resumed\n2 tasks stopped");
    expect(noticeReads(n({ level: "warn", title: "Title", text: "Body with `x`." }), NOW)).toBe("Title\nBody with x.");
    expect(noticeReads(n({ text: "2 tasks stopped", stopped: { provider: "claude-code", cli: "Claude Code", tasks: [{ label: "a" }, { label: "b" }] } }), NOW)).toBe("2 tasks stopped");
    expect(noticeReads(n({ level: "info", text: "recorded with `gpt-6-sol`", source: "codex" }), NOW)).toBe("recorded with gpt-6-sol");
    expect(noticeReads(n({ level: "warn", text: "Stopped 2 background tasks", details: ["one", "two"] }), NOW)).toBe("Stopped 2 background tasks\none\ntwo");
});

test("a limit's card takes the place of the turn's earlier warning; one on credits stays", () => {
    const reached = n({ id: "w", level: "warn", text: "reached", limit });
    const credits = n({ id: "c", level: "warn", text: "credits", limit: { ...limit, credits: true } });
    const card = n({ id: "e", level: "error", text: "stopped", limit });
    const other = n({ id: "o", level: "warn", text: "something else" });
    const ids = (bs: Block[]) => bs.map((b) => b.id);
    expect(ids(shownBlocks([reached, credits, other]))).toEqual(["w", "c", "o"]);
    expect(ids(shownBlocks([reached, credits, other, card]))).toEqual(["c", "o", "e"]);
    expect(hasErrorCard([card])).toBe(true);
    expect(hasErrorCard([reached])).toBe(false);
});

test("notices from before the first step sit above Worked for; later ones stay where they are", () => {
    const item = (t: string) => ({ kind: "item", item: { kind: "block", block: { t } } });
    const work = { kind: "work" };
    expect(leadingNotices([item("notice"), item("notice"), work, item("notice"), item("text")])).toBe(2);
    expect(leadingNotices([work, item("notice")])).toBe(0);
    expect(leadingNotices([item("text"), item("notice"), work])).toBe(0);
});

test("a CLI's compaction is a rule, and find reads its label", () => {
    const c = n({ text: "Claude Code compacted its context.", compacted: true });
    expect(noticeKind(c)).toBe("compacted");
    expect(noticeReads(c, NOW)).toBe("Context compacted");
});

test("the waiting resume shows on the last turn's latest limit card only, and the composer leaves it to the card", () => {
    const resume: ScheduleInfo = { id: "r", kind: "resume", prompt: "", when: "", recurring: false, durable: false, paused: false, nextAt: at(15, 41), runs: 0, due: false };
    const loop: ScheduleInfo = { ...resume, id: "l", kind: "loop", nextAt: at(14) };
    const earlier = n({ id: "a", level: "error", text: "stopped", limit });
    const card = n({ id: "b", level: "error", text: "stopped", limit });
    const turn: Block[] = [earlier, n({ id: "x", text: "note" }), card];
    expect(waitingResume(card, turn, [loop, resume])).toBe(resume as ScheduleInfo & { nextAt: number });
    expect(listedSchedules([loop, resume], turn)).toEqual([loop]);
    // With no limit card in the last turn, the composer lists it (it's the only place to see it, and call it off).
    expect(listedSchedules([loop, resume], [n({ id: "x", text: "note" })])).toEqual([loop, resume]);
    expect(listedSchedules([loop, resume], undefined)).toEqual([loop, resume]);
    // An earlier card in the turn, a card of an earlier turn, no resume waiting, an error that isn't a limit: none.
    expect(waitingResume(earlier, turn, [resume])).toBeUndefined();
    expect(waitingResume(card, [n({ id: "c", level: "error", text: "stopped", limit })], [resume])).toBeUndefined();
    expect(waitingResume(card, turn, [loop])).toBeUndefined();
    expect(waitingResume(card, turn, undefined)).toBeUndefined();
    expect(waitingResume(n({ id: "b", level: "error", text: "boom" }), turn, [resume])).toBeUndefined();
});
