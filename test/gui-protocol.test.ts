// The pure parts of the GUI server: the shared timeline reducer (the GUI runs
// the same code), the history replay, diffs, cross-project session listing,
// and merging the login shell's PATH.

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { applyOp, coalesce, tail, wireReplacer, AGENT_BLOCKS, PROGRESS_LIMIT } = await import("../src/server/timeline");
const { fileDiff, trimInput, truncateText } = await import("../src/server/diffs");
const { agentHead, agentStep, agentsFromTurns, cutOffPrompt, promptKey, replay, runsAgent, shownStep, UiLog, withoutActionsNote } = await import("../src/server/history");
const { DELEGATE_TOOL } = await import("../src/agent/delegation");
const { mergePath } = await import("../src/server/login-env");
const { Session, listAllSessions, findSessionAnywhere } = await import("../src/agent/session");
const { Engine } = await import("../src/server/engine");
const { getProvider } = await import("../src/providers/registry");
import type { AgentRun, Block, SessionState, SessionSummary, ToolBlock, Turn } from "../src/server/protocol";
import type { Message, UserMessage } from "../src/providers/types";

afterAll(() => iso.cleanup());

function view() {
    return { state: { id: "s", busy: false, queued: [] } as unknown as SessionState, turns: [] as Turn[], agents: [] as AgentRun[] };
}

const agent = (id: string): AgentRun => ({ id, turnId: "t1", description: "Review auth", agentType: "explore", model: "gemini:gemini-3", status: "running", startedAt: 1, toolCount: 0, tokens: 0, blocks: [] });

describe("sub-agent ops", () => {
    test("an agent's activity: text streams in, tools start and finish, and it ends", () => {
        const v = view();
        applyOp(v, { op: "agent", agent: agent("call_1") });
        applyOp(v, { op: "agent.block", id: "call_1", block: { t: "text", id: "x1", text: "" } });
        applyOp(v, { op: "agent.append", id: "call_1", blockId: "x1", field: "text", text: "Looking " });
        applyOp(v, { op: "agent.append", id: "call_1", blockId: "x1", field: "text", text: "around." });
        applyOp(v, { op: "agent.block", id: "call_1", block: { t: "tool", id: "r1", name: "Read", title: "Read(a.ts)", status: "running" } });
        applyOp(v, { op: "agent.patch", id: "call_1", patch: { toolCount: 1, activity: "Read(a.ts)" } });
        applyOp(v, { op: "agent.block.patch", id: "call_1", blockId: "r1", patch: { status: "ok", summary: "Read 8 lines" } });
        applyOp(v, { op: "agent.patch", id: "call_1", patch: { status: "done", activity: null as unknown as undefined, report: "All good." } });
        const a = v.agents[0]!;
        expect(a.blocks).toEqual([
            { t: "text", id: "x1", text: "Looking around." },
            { t: "tool", id: "r1", name: "Read", title: "Read(a.ts)", status: "ok", summary: "Read 8 lines" },
        ]);
        expect(a).toMatchObject({ status: "done", toolCount: 1, report: "All good." });
        // Cleared on the wire (null), so no stale "Reading…" once it's done.
        expect(a.activity).toBeUndefined();
        // Ops for an agent that isn't there change nothing.
        applyOp(v, { op: "agent.patch", id: "nope", patch: { status: "failed" } });
        expect(v.agents).toHaveLength(1);
    });

    test("an agent with the same id replaces the old one; a block with the same id replaces it", () => {
        const v = view();
        applyOp(v, { op: "agent", agent: { ...agent("c"), replayed: true } });
        applyOp(v, { op: "agent", agent: agent("c") });
        expect(v.agents).toHaveLength(1);
        expect(v.agents[0]!.replayed).toBeUndefined();
        applyOp(v, { op: "agent.block", id: "c", block: { t: "notice", id: "n", level: "warn", text: "one" } });
        applyOp(v, { op: "agent.block", id: "c", block: { t: "notice", id: "n", level: "warn", text: "two" } });
        expect(v.agents[0]!.blocks).toEqual([{ t: "notice", id: "n", level: "warn", text: "two" }]);
    });

    test("a long run keeps its latest blocks and counts the rest; live output keeps its tail", () => {
        const v = view();
        applyOp(v, { op: "agent", agent: agent("c") });
        for (let i = 0; i < AGENT_BLOCKS + 5; i++) applyOp(v, { op: "agent.block", id: "c", block: { t: "tool", id: `t${i}`, name: "Read", title: "Read", status: "ok" } });
        expect(v.agents[0]!.blocks).toHaveLength(AGENT_BLOCKS);
        expect(v.agents[0]!.blocks[0]!.id).toBe("t5");
        expect(v.agents[0]!.dropped).toBe(5);
        const last = `t${AGENT_BLOCKS + 4}`;
        applyOp(v, { op: "agent.append", id: "c", blockId: last, field: "progress", text: "x".repeat(PROGRESS_LIMIT + 500) });
        expect(((v.agents[0]!.blocks.at(-1) as { progress?: string }).progress ?? "").length).toBeLessThanOrEqual(PROGRESS_LIMIT);
    });

    test("an agent's bursts coalesce; reset can replace the agents", () => {
        const ops = coalesce([
            { op: "agent.append", id: "c", blockId: "x", field: "text", text: "a" },
            { op: "agent.append", id: "c", blockId: "x", field: "text", text: "b" },
            { op: "agent.patch", id: "c", patch: { tokens: 10 } },
            { op: "agent.patch", id: "c", patch: { tokens: 20, activity: "Writing" } },
            { op: "agent.patch", id: "d", patch: { tokens: 1 } },
        ]);
        expect(ops).toEqual([
            { op: "agent.append", id: "c", blockId: "x", field: "text", text: "ab" },
            { op: "agent.patch", id: "c", patch: { tokens: 20, activity: "Writing" } },
            { op: "agent.patch", id: "d", patch: { tokens: 1 } },
        ]);
        const v = view();
        applyOp(v, { op: "agent", agent: agent("c") });
        applyOp(v, { op: "reset", turns: [] });
        expect(v.agents).toHaveLength(1);
        applyOp(v, { op: "reset", turns: [], agents: [] });
        expect(v.agents).toHaveLength(0);
    });

    test("a reopened session's sub-agents come from their calls: Task and a backend's delegate", () => {
        expect(runsAgent("Task")).toBe(true);
        expect(runsAgent(DELEGATE_TOOL)).toBe(true);
        expect(runsAgent("Read")).toBe(false);
        const turns: Turn[] = [
            {
                id: "t1",
                prompt: { text: "review" },
                status: "done",
                startedAt: 5,
                blocks: [
                    { t: "tool", id: "a", name: "Task", title: "Task(x)", status: "ok", agent: true, input: { description: "Map auth", prompt: "Read src/auth", subagent_type: "explore", model: "mock:mock-haiku" }, output: "Strategies are in one list." },
                    { t: "tool", id: "b", name: DELEGATE_TOOL, title: "Delegate", status: "error", agent: true, input: { description: "Gemini review", task: "Review it", model: "gemini:g" }, output: "It failed." },
                    { t: "tool", id: "c", name: "Task", title: "Task(y)", status: "running", agent: true, input: { description: "Own model", prompt: "p", model: "mock:mock-opus" } },
                    { t: "tool", id: "d", name: "Read", title: "Read", status: "ok" },
                ],
            },
        ];
        const agents = agentsFromTurns(turns, "mock:mock-opus");
        expect(agents.map((a) => [a.id, a.description, a.agentType, a.model, a.prompt, a.status, a.report, a.replayed])).toEqual([
            ["a", "Map auth", "explore", "mock:mock-haiku", "Read src/auth", "done", "Strategies are in one list.", true],
            ["b", "Gemini review", "general-purpose", "gemini:g", "Review it", "failed", "It failed.", true],
            // Its own model isn't named; a call that never got a result was stopped.
            ["c", "Own model", "general-purpose", undefined, "p", "stopped", undefined, true],
        ]);
        expect(agents.every((a) => a.turnId === "t1" && a.startedAt === 5 && a.blocks.length === 0)).toBe(true);
    });
});

describe("timeline ops", () => {
    test("append, patch and remove build a turn", () => {
        const v = view();
        applyOp(v, { op: "turn", turn: { id: "t1", blocks: [], status: "running" } });
        applyOp(v, { op: "block", turnId: "t1", block: { t: "text", id: "b1", text: "" } });
        applyOp(v, { op: "append", turnId: "t1", blockId: "b1", field: "text", text: "Hel" });
        applyOp(v, { op: "append", turnId: "t1", blockId: "b1", field: "text", text: "lo" });
        applyOp(v, { op: "block", turnId: "t1", block: { t: "tool", id: "c1", name: "Bash", title: "Bash(ls)", status: "running" } });
        applyOp(v, { op: "block.patch", turnId: "t1", blockId: "c1", patch: { status: "ok", summary: "done" } });
        applyOp(v, { op: "turn.patch", turnId: "t1", patch: { status: "done" } });
        expect(v.turns[0]!.blocks).toEqual([
            { t: "text", id: "b1", text: "Hello" },
            { t: "tool", id: "c1", name: "Bash", title: "Bash(ls)", status: "ok", summary: "done" },
        ]);
        applyOp(v, { op: "block.remove", turnId: "t1", blockId: "b1" });
        expect(v.turns[0]!.blocks.map((b) => b.id)).toEqual(["c1"]);
        expect(v.turns[0]!.status).toBe("done");
    });

    test("null on the wire clears a field (JSON has no undefined)", () => {
        const v = view();
        applyOp(v, { op: "state", patch: { activity: { label: "Thinking", since: 1 } } });
        const wire = JSON.parse(JSON.stringify({ op: "state", patch: { activity: undefined } }, wireReplacer));
        expect(wire.patch).toEqual({ activity: null });
        applyOp(v, wire);
        expect(v.state.activity).toBeUndefined();
        expect("activity" in v.state).toBe(true);
    });

    test("live output keeps only its tail", () => {
        const v = view();
        applyOp(v, { op: "turn", turn: { id: "t", blocks: [{ t: "tool", id: "c", name: "Bash", title: "Bash", status: "running" }], status: "running" } });
        const line = "x".repeat(99) + "\n";
        for (let i = 0; i < 300; i++) applyOp(v, { op: "append", turnId: "t", blockId: "c", field: "progress", text: line });
        const p = (v.turns[0]!.blocks[0] as { progress: string }).progress;
        expect(p.length).toBeLessThanOrEqual(PROGRESS_LIMIT);
        expect(p.startsWith("x")).toBe(true);
        expect(tail("abc\ndef", 4)).toBe("def");
    });

    test("bursts of tokens coalesce into one op", () => {
        const ops = coalesce([
            { op: "append", turnId: "t", blockId: "b", field: "text", text: "a" },
            { op: "append", turnId: "t", blockId: "b", field: "text", text: "b" },
            { op: "state", patch: { busy: true } },
            { op: "state", patch: { cost: 1 } },
            { op: "append", turnId: "t", blockId: "b", field: "text", text: "c" },
        ]);
        expect(ops).toEqual([
            { op: "append", turnId: "t", blockId: "b", field: "text", text: "ab" },
            { op: "state", patch: { busy: true, cost: 1 } },
            { op: "append", turnId: "t", blockId: "b", field: "text", text: "c" },
        ]);
    });
});

describe("diffs", () => {
    test("hunks with line numbers and stats", () => {
        const d = fileDiff("a.ts", "one\ntwo\nthree\n", "one\nTWO\nthree\nfour\n");
        expect(d.status).toBe("modified");
        expect([d.added, d.removed]).toEqual([2, 1]);
        expect(d.hunks[0]!.lines.map((l) => `${l.t}:${l.a ?? ""}:${l.b ?? ""}:${l.text}`)).toEqual(["ctx:1:1:one", "del:2::two", "add::2:TWO", "ctx:3:3:three", "add::4:four"]);
        expect(fileDiff("n.ts", null, "x\n").status).toBe("added");
        expect(fileDiff("n.ts", "x\n", null).status).toBe("deleted");
    });

    test("big diffs are cut, with a note", () => {
        const before = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
        const after = before.replace(/line (\d*)0\b/g, "LINE $10");
        const d = fileDiff("big.txt", before, after, { maxLines: 100 });
        expect(d.truncated).toBe(true);
        expect(d.hunks.reduce((n, h) => n + h.lines.length, 0)).toBeLessThanOrEqual(100);
        expect(fileDiff("huge", "a".repeat(3_000_000), "b").note).toBe("Too large to show");
    });

    test("long tool inputs are trimmed for display", () => {
        const t = trimInput({ content: "x".repeat(10_000), path: "a" })!;
        expect(String(t.content).length).toBeLessThan(4200);
        expect(t.path).toBe("a");
        expect(truncateText("abcdef", 10)).toEqual({ text: "abcdef", truncated: false });
        expect(truncateText("x".repeat(100), 20).truncated).toBe(true);
    });
});

describe("replay", () => {
    const user = (text: string, kind: "prompt" | "tool_results" | "interrupt" = "prompt", extra: Partial<Message> = {}): Message => ({ role: "user", content: [{ type: "text", text }], meta: { kind }, ...extra }) as Message;

    test("prompts, text, tool calls with results, and interrupts", () => {
        const segs = [
            {
                messages: [
                    user("fix it"),
                    { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "Looking." }, { type: "tool_call", id: "c1", name: "Read", input: { file_path: "a.ts" } }] },
                    { role: "user", content: [{ type: "tool_result", toolCallId: "c1", toolName: "Read", content: "     1\tx" }], meta: { kind: "tool_results" } },
                    { role: "assistant", provider: "p", model: "m", content: [{ type: "tool_call", id: "c2", name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } }] },
                    { role: "user", content: [{ type: "tool_result", toolCallId: "c2", toolName: "Edit", content: "The user declined this tool call." , isError: true }], meta: { kind: "tool_results" } },
                    user("[Request interrupted by user]", "interrupt"),
                ] as Message[],
            },
        ];
        let n = 0;
        const turns = replay({ segments: segs, current: segs[0]!.messages, ui: new UiLog(join(tempDir(), "x.jsonl"), "x", false), meta: (c) => ({ title: `${c.name}(${String(c.input.file_path)})`, category: c.name === "Edit" ? "edit" : "read" }), newId: () => `i${++n}` });
        expect(turns).toHaveLength(1);
        const t = turns[0]!;
        expect(t.prompt).toEqual({ text: "fix it", index: 0 });
        expect(t.status).toBe("aborted");
        expect(t.blocks.map((b) => (b.t === "tool" ? `${b.name}:${b.status}` : b.t))).toEqual(["text", "Read:ok", "Edit:denied"]);
        // Diffs come from the input when the GUI's log doesn't have them.
        const edit = t.blocks[2] as { diff?: { added: number; removed: number } };
        expect([edit.diff?.added, edit.diff?.removed]).toEqual([1, 1]);
    });

    test("a backend's note of what it did stays in history but not in the transcript", () => {
        const note = "[Claude Code used: Bash(bun test), Edit(src/a.ts)]";
        const segs = [
            {
                messages: [
                    user("fix it"),
                    { role: "assistant", provider: "claude-code", model: "opus", content: [{ type: "text", text: "Fixed and tested." }, { type: "text", text: note }] },
                    user("again"),
                    { role: "assistant", provider: "codex", model: "gpt", content: [{ type: "text", text: "[Codex used: Read(a.ts)]" }] },
                    user("and you?"),
                    // Another model's reply is left as written, even if it looks like one.
                    { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: note }] },
                ] as Message[],
            },
        ];
        let n = 0;
        const turns = replay({ segments: segs, current: segs[0]!.messages, ui: new UiLog(join(tempDir(), "z.jsonl"), "z", false), meta: (c) => ({ title: c.name }), newId: () => `i${++n}` });
        expect(turns.map((t) => t.blocks.map((b) => (b.t === "text" ? b.text : b.t)))).toEqual([["Fixed and tested."], [], [note]]);
    });

    test("an agent's report loses the note wherever it sits, and keeps text that only resembles it", () => {
        expect(withoutActionsNote("Done.\n\n[Claude Code used: Read(a.ts), Grep(x])]")).toBe("Done.");
        expect(withoutActionsNote("It was stopped. Its last message:\nHalf done.\n\n[Codex used: Bash(ls)]\n\n(It stopped at its limit of 200 model turns.)")).toBe("It was stopped. Its last message:\nHalf done.\n\n(It stopped at its limit of 200 model turns.)");
        expect(withoutActionsNote("[Claude Code used: Bash(ls)]")).toBe("");
        for (const kept of ["See [Codex used: x] in the log.", "[Gemini used: Read(a.ts)]", "Done.\n[Codex used: Bash(ls)]"]) expect(withoutActionsNote(kept)).toBe(kept);
    });

    test("a backend's turn comes back as it was shown: its steps in order, their timings and diffs, and its sub-agents", () => {
        const file = join(tempDir(), "s.jsonl");
        const log = new UiLog(file, "s", false);
        const diff = fileDiff("a.ts", "x\n", "y\n");
        const blocks: Block[] = [
            { t: "text", id: "b2", text: "Looking first." },
            { t: "tool", id: "tu1", name: "Bash", title: "Bash(ls)", category: "execute", status: "ok", input: { command: "ls" }, output: "a.ts", startedAt: 10, durationMs: 5, progress: "a.ts", approval: "sandboxed" },
            { t: "thinking", id: "b3", text: "Hmm.", startedAt: 20, durationMs: 3 },
            { t: "tool", id: "tu2", name: "Edit", title: "Edit(a.ts)", category: "edit", status: "ok", summary: "+1 −1", diff, startedAt: 30, durationMs: 2 },
            { t: "tool", id: "tu3", name: "Task", title: "Task(Map auth)", category: "meta", status: "ok", agent: true, input: { description: "Map auth", prompt: "Read it" }, output: "One list.", sub: { label: "Map auth", tools: [{ t: "tool", id: "s0", name: "Glob", title: "Glob", status: "running" }], toolCount: 1, tokens: 9, startedAt: 31 } },
            { t: "tool", id: "tu4", name: "Task", title: "Task(Background)", category: "meta", status: "ok", agent: true, input: { description: "Background" } },
            { t: "notice", id: "b4", level: "info", text: "Attached a.ts" },
            { t: "text", id: "b5", text: "Done." },
        ];
        log.write({ t: "turn", seg: 0, index: 0, at: 1 });
        log.write({ t: "tool", id: "tu2", summary: "+1 −1", diff, durationMs: 2 });
        // Written as they're shown: a call as it starts and again as it ends, one taken back, one written late (it goes where it was).
        const step = (b: Block, after: string | null) => log.write({ t: "step", seg: 0, index: 0, block: shownStep(b)!, after });
        const [first, ran, thought, ...rest] = blocks;
        step(first!, null);
        step({ ...(ran as ToolBlock), status: "running", output: undefined, durationMs: undefined }, "b2");
        step(ran!, "b2");
        step({ t: "text", id: "b7", text: "Retried." }, "tu1");
        log.write({ t: "step", seg: 0, index: 0, drop: "b7" });
        step(rest[0]!, "b3");
        step(thought!, "tu1");
        // A notice isn't a step.
        expect(shownStep(rest[3]!)).toBeUndefined();
        for (const [i, b] of rest.entries()) if (i > 0 && shownStep(b)) step(b, rest[i - 1]!.id === "b4" ? "tu4" : rest[i - 1]!.id);
        // The sub-agents: what changed of them, and their steps.
        const subRead: Block = { t: "tool", id: "s1", name: "Read", title: "Read(a.ts)", status: "ok", output: "x".repeat(5000), diff, progress: "x" };
        log.write({ t: "agent", id: "tu3", head: agentHead({ ...agent("tu3"), turnId: "b1", activity: "Reading" }) });
        log.write({ t: "agent", id: "tu3", block: agentStep({ t: "text", id: "b9", text: "Reading." }), after: null });
        log.write({ t: "agent", id: "tu3", block: agentStep(subRead), after: "b9" });
        log.write({ t: "agent", id: "tu3", head: { status: "done", endedAt: 40, toolCount: 1, tokens: 9, report: "One list.", taskId: "task-1" } });
        log.write({ t: "agent", id: "tu4", head: agentHead({ ...agent("tu4"), turnId: "b1", activity: "Thinking" }) });
        log.write({ t: "agent", id: "tu4", block: agentStep({ t: "tool", id: "s2", name: "Grep", title: "Grep", status: "running" }), after: null });
        log.write({ t: "turn", seg: 0, index: 0, at: 1, end: 100, status: "done" });
        const messages = [
            user("fix it"),
            { role: "assistant", provider: "claude-code", model: "opus", content: [{ type: "text", text: "Looking first.Done." }, { type: "text", text: "[Claude Code used: Bash(ls), Edit(a.ts), Task(Map auth), Task(Background)]" }] },
        ] as Message[];
        const ui = new UiLog(file, "s");
        let n = 0;
        const turns = replay({ segments: [{ messages }], current: messages, ui, meta: (c) => ({ title: c.name }), newId: () => `i${++n}` });
        expect(turns).toHaveLength(1);
        const t = turns[0]!;
        expect([t.startedAt, t.endedAt, t.status, t.prompt?.index]).toEqual([1, 100, "done", 0]);
        // Each step where it was, without the transcript's text again; notices aren't kept.
        expect(t.blocks.map((b) => (b.t === "tool" ? `${b.name}:${b.status}` : b.t === "text" || b.t === "thinking" ? b.text : b.t))).toEqual(["Looking first.", "Bash:ok", "Hmm.", "Edit:ok", "Task:ok", "Task:ok", "Done."]);
        // Text and thinking get ids of this run; calls keep theirs.
        expect(t.blocks.map((b) => b.id)).toEqual(["i2", "tu1", "i3", "tu2", "tu3", "tu4", "i4"]);
        const [, bash, thinking, edit, task] = t.blocks as [Block, ToolBlock, Extract<Block, { t: "thinking" }>, ToolBlock, ToolBlock];
        expect([bash.title, bash.input, bash.output, bash.startedAt, bash.durationMs, bash.approval, bash.progress]).toEqual(["Bash(ls)", { command: "ls" }, "a.ts", 10, 5, "sandboxed", undefined]);
        expect(thinking.durationMs).toBe(3);
        // The diff is the log's (written once, with the call's result).
        expect(edit.diff).toEqual(diff);
        // Nothing is left running after a reopen.
        expect([task.agent, task.sub?.toolCount, task.sub?.tools[0]?.status]).toEqual([true, 1, "error"]);

        const agents = agentsFromTurns(turns, "claude-code:opus", ui.agents);
        expect(agents.map((a) => [a.id, a.turnId, a.status, a.replayed, a.taskId, a.activity, a.report, a.endedAt])).toEqual([
            ["tu3", t.id, "done", true, undefined, undefined, "One list.", 40],
            // One the log last saw running was stopped with the session.
            ["tu4", t.id, "stopped", true, undefined, undefined, undefined, 100],
        ]);
        const [text, read] = agents[0]!.blocks as [Block, ToolBlock];
        expect(text.t === "text" && text.text).toBe("Reading.");
        // What it did is kept short: outputs cut, no diffs or live output.
        expect([read.name, read.status, read.outputTruncated, read.diff, read.progress]).toEqual(["Read", "ok", true, undefined, undefined]);
        expect(read.output!.length).toBeLessThan(1200);
        expect(agents[1]!.blocks.map((b) => b.t === "tool" && b.status)).toEqual(["error"]);
    });

    test("a turn started again where an earlier one was (after a rewind) doesn't get that one's steps", () => {
        const file = join(tempDir(), "r.jsonl");
        const log = new UiLog(file, "r", false);
        log.write({ t: "turn", seg: 0, index: 0, at: 1 });
        log.write({ t: "step", seg: 0, index: 0, block: { t: "text", id: "b1", text: "The old reply." }, after: null });
        log.write({ t: "turn", seg: 0, index: 0, at: 1, end: 5, status: "done" });
        // Rewound, and asked again of another model.
        log.write({ t: "turn", seg: 0, index: 0, at: 9 });
        const messages = [user("again"), { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "The new reply." }] }] as Message[];
        let n = 0;
        const turns = replay({ segments: [{ messages }], current: messages, ui: new UiLog(file, "r"), meta: (c) => ({ title: c.name }), newId: () => `i${++n}` });
        expect(turns.map((x) => [x.startedAt, x.endedAt, x.blocks.map((b) => (b.t === "text" ? b.text : b.t))])).toEqual([[9, undefined, ["The new reply."]]]);
    });

    test("steps recorded for another prompt at that place (one sent where the log wasn't kept) aren't shown for this one", () => {
        const file = join(tempDir(), "p.jsonl");
        const log = new UiLog(file, "p", false);
        const asked = user("the first question") as UserMessage;
        log.write({ t: "step", seg: 0, index: 0, block: { t: "text", id: "b1", text: "The first answer." }, after: null, prompt: promptKey(asked) });
        const reply = { role: "assistant", provider: "claude-code", model: "opus", content: [{ type: "text", text: "The second answer." }] } as Message;
        let n = 0;
        const run = (prompt: Message) => replay({ segments: [{ messages: [prompt, reply] }], current: [prompt, reply], ui: new UiLog(file, "p"), meta: (c) => ({ title: c.name }), newId: () => `i${++n}` });
        expect(run(user("another question"))[0]!.blocks.map((b) => b.t === "text" && b.text)).toEqual(["The second answer."]);
        // The same words sent again are another prompt.
        expect(run({ ...asked, meta: { kind: "prompt", checkpoint: 7 } })[0]!.blocks.map((b) => b.t === "text" && b.text)).toEqual(["The second answer."]);
        expect(run(asked)[0]!.blocks.map((b) => b.t === "text" && b.text)).toEqual(["The first answer."]);
    });

    test("the log keeps the session's last mode, effort and context; nothing is written once it's closed", () => {
        const file = join(tempDir(), "m.jsonl");
        const log = new UiLog(file, "m", false);
        log.write({ t: "state", mode: "auto", effort: "low" });
        log.write({ t: "state", contextTokens: 1234, messages: 2 });
        log.write({ t: "state", mode: "plan", effort: "high" });
        // Its session let go of (another process may have it now).
        log.close();
        log.write({ t: "state", mode: "acceptEdits" });
        expect(new UiLog(file, "m").state).toEqual({ mode: "plan", effort: "high", contextTokens: 1234, messages: 2 });
    });

    test("a sub-agent's log keeps its latest steps, counting the rest, and what's no longer so about it", () => {
        const file = join(tempDir(), "a.jsonl");
        const log = new UiLog(file, "a", false);
        log.write({ t: "agent", id: "tu1", head: agentHead({ ...agent("tu1"), status: "done", endedAt: 5, report: "First." }) });
        let after: string | null = null;
        for (let i = 0; i < 130; i++) {
            log.write({ t: "agent", id: "tu1", block: { t: "text", id: `x${i}`, text: `step ${i}` }, after });
            after = `x${i}`;
        }
        // Running again (Codex's, messaged after it answered): it hasn't ended, and has no report yet.
        log.write({ t: "agent", id: "tu1", head: { status: "running", endedAt: null, report: null } });
        // A step of one never seen isn't anyone's.
        log.write({ t: "agent", id: "tu9", block: { t: "text", id: "y", text: "?" }, after: null });
        const a = new UiLog(file, "a").agents;
        expect([...a.keys()]).toEqual(["tu1"]);
        const run = a.get("tu1")!;
        expect([run.status, "endedAt" in run, "report" in run, run.description, run.blocks.length, run.dropped, run.blocks[0]!.t === "text" && run.blocks[0]!.text]).toEqual(["running", false, false, "Review auth", 100, 30, "step 30"]);
    });

    test("a turn the log saw start and never end, with nothing after its prompt that says how it ended, was cut off", () => {
        const file = join(tempDir(), "c.jsonl");
        const log = new UiLog(file, "c", false);
        const answered = { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "Done." }] } as Message;
        const calling = { role: "assistant", provider: "p", model: "m", content: [{ type: "tool_call", id: "c1", name: "Bash", input: {} }] } as Message;
        const results = { role: "user", content: [{ type: "tool_result", toolCallId: "c1", toolName: "Bash", content: "ok" }], meta: { kind: "tool_results" } } as Message;
        log.write({ t: "turn", seg: 0, index: 0, at: 1 });
        log.write({ t: "turn", seg: 0, index: 0, at: 1, end: 2, status: "done" });
        log.write({ t: "turn", seg: 0, index: 2, at: 3 });
        const ui = new UiLog(file, "c");
        const at = (messages: Message[], seg = 0) => cutOffPrompt(ui, seg, messages);
        const before = [user("first"), answered];
        expect(at([...before, user("second")])).toBe(2);
        // Part way through its tools (a model's own turn).
        expect(at([...before, user("second"), calling, results])).toBe(2);
        // It said how it ended.
        expect(at([...before, user("second"), user("[Request interrupted by user]", "interrupt")])).toBeUndefined();
        expect(at([...before, user("second"), calling, { ...results, content: [...results.content, { type: "text", text: "[Request interrupted by user for tool use]" }] } as Message])).toBeUndefined();
        expect(at([...before, user("second"), answered])).toBeUndefined();
        // It went on where the log isn't kept (a terminal).
        expect(at([...before, user("second"), user("third")])).toBeUndefined();
        // Rewound past it, or compacted since.
        expect(at(before)).toBeUndefined();
        expect(at([...before, user("second")], 1)).toBeUndefined();
        // The one that ended isn't.
        log.write({ t: "turn", seg: 0, index: 2, at: 3, end: 4, status: "error" });
        expect(cutOffPrompt(new UiLog(file, "c"), 0, [...before, user("second")])).toBeUndefined();
    });

    test("turns from before a compaction are kept, marked archived and not rewindable", () => {
        const segs = [{ messages: [user("old prompt")] }, { summary: "Summary.", messages: [user("Summary.", "prompt", { meta: { kind: "summary" } } as Partial<Message>), user("new prompt")] }];
        let n = 0;
        const turns = replay({ segments: segs, current: segs[1]!.messages, ui: new UiLog(join(tempDir(), "y.jsonl"), "y", false), meta: (c) => ({ title: c.name }), newId: () => `i${++n}` });
        expect(turns.map((t) => [t.prompt?.text ?? t.blocks[0]?.t, Boolean(t.archived), t.prompt?.index])).toEqual([
            ["old prompt", true, undefined],
            ["compact", false, undefined],
            ["new prompt", false, 1],
        ]);
    });
});

describe("sessions across projects", () => {
    test("listed newest first with their own folder; found by id anywhere", () => {
        const a = Session.create(join(tempDir(), "proj-a"));
        a.push({ role: "user", content: [{ type: "text", text: "in a" }], meta: { kind: "prompt" } });
        const b = Session.create(join(tempDir(), "proj-b"));
        b.setTitle("Named b");
        b.push({ role: "user", content: [{ type: "text", text: "in b" }], meta: { kind: "prompt" } });
        const empty = Session.create(join(tempDir(), "proj-c"));
        empty.setTitle("never used");
        const all = listAllSessions(50);
        const mine = all.filter((s) => s.id === a.meta.id || s.id === b.meta.id);
        expect(mine.map((s) => [s.title, s.cwd])).toContainEqual(["in a", a.meta.cwd]);
        expect(mine.map((s) => [s.title, s.cwd])).toContainEqual(["Named b", b.meta.cwd]);
        expect(all.some((s) => s.id === empty.meta.id)).toBe(false);
        expect(findSessionAnywhere(b.meta.id)).toBe(b.path);
        expect(findSessionAnywhere("../etc")).toBeUndefined();
    });
});

describe("login shell PATH", () => {
    test("the login shell's entries come first, without duplicates", () => {
        expect(mergePath("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin")).toBe("/opt/homebrew/bin:/usr/bin:/bin");
        expect(mergePath("/usr/bin", undefined)).toBe("/usr/bin");
        expect(mergePath(undefined, "/a::/b")).toBe("/a:/b");
    });
});

describe("engine", () => {
    test("with no models, listing doesn't loop (each list used to broadcast a change that asked for another)", async () => {
        let fetched = 0;
        const engine = new Engine({ listModels: async (o) => (o?.cachedOnly || fetched++, []) });
        const events: string[] = [];
        const client = { subs: new Set<string>(), send: (e: { type: string }) => events.push(e.type) };
        engine.clients.add(client as never);
        // The GUI lists again whenever it hears models.changed.
        let lists = 0;
        const list = async () => {
            lists++;
            return engine.handle(client as never, "models.list", {});
        };
        expect(await list()).toEqual([]);
        for (let i = 0; i < 5 && events.includes("models.changed"); i++) {
            events.length = 0;
            await list();
        }
        expect(lists).toBe(1);
        expect(fetched).toBe(1);
        // Asking for a refresh still refreshes.
        await engine.handle(client as never, "models.list", { refresh: true });
        expect(fetched).toBe(2);
        await engine.stop();
    });
    test("the model picker gets last run's lists at once, not after the slowest provider; the fresh ones replace them", async () => {
        const provider = getProvider("anthropic")!;
        const listing = (id: string, status: "cached" | "ok") => ({ provider, status, models: [{ provider: "anthropic", id }] });
        let release!: () => void;
        const slow = new Promise<void>((r) => (release = r));
        const engine = new Engine({ listModels: async (o) => (o?.cachedOnly ? [listing("claude-old", "cached")] : (await slow, [listing("claude-new", "ok")])) });
        const events: string[] = [];
        const client = { subs: new Set<string>(), send: (e: { type: string }) => events.push(e.type) };
        engine.clients.add(client as never);
        const ids = async () => ((await engine.handle(client as never, "models.list", {})) as { models: { id: string }[] }[]).flatMap((p) => p.models.map((m) => m.id));
        expect(await ids()).toEqual(["claude-old"]);
        expect(events).not.toContain("models.changed");
        release();
        await engine.handle(client as never, "models.list", { refresh: false });
        for (let i = 0; i < 20 && !events.includes("models.changed"); i++) await Bun.sleep(5);
        expect(events).toContain("models.changed");
        expect(await ids()).toEqual(["claude-new"]);
        await engine.stop();
    });

    test("with nothing cached, the picker waits for the providers", async () => {
        const provider = getProvider("anthropic")!;
        const engine = new Engine({ listModels: async (o) => (o?.cachedOnly ? [] : [{ provider, status: "ok" as const, models: [{ provider: "anthropic", id: "claude-new" }] }]) });
        const client = { subs: new Set<string>(), send: () => {} };
        const got = (await engine.handle(client as never, "models.list", {})) as { models: { id: string }[] }[];
        expect(got.flatMap((p) => p.models.map((m) => m.id))).toEqual(["claude-new"]);
        await engine.stop();
    });

    test("a settled session is listed as settled, with the model it last used, until it's moved back", async () => {
        const a = Session.create(join(tempDir(), "proj-settle"));
        a.push({ role: "user", content: [{ type: "text", text: "set me aside" }], meta: { kind: "prompt" } });
        a.setModel("openai:gpt-6");
        const engine = new Engine({ listModels: async () => [] });
        const upserts: SessionSummary[] = [];
        const client = { subs: new Set<string>(), send: (e: { type: string; session?: SessionSummary }) => e.type === "sessions.upsert" && upserts.push(e.session!) };
        engine.clients.add(client as never);
        const find = async () => ((await engine.handle(client as never, "sessions.list", {})) as SessionSummary[]).find((s) => s.id === a.meta.id);
        expect(await find()).toMatchObject({ settled: false, model: "openai:gpt-6" });
        await engine.handle(client as never, "session.settle", { id: a.meta.id, settled: true });
        expect(upserts.at(-1)).toMatchObject({ id: a.meta.id, settled: true });
        expect(await find()).toMatchObject({ settled: true, pinned: false, archived: false });
        await engine.handle(client as never, "session.settle", { id: a.meta.id, settled: false });
        expect(await find()).toMatchObject({ settled: false });
        await engine.stop();
    });
});
