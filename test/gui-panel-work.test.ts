import { expect, test } from "bun:test";
import { agentRows, clearKey, commandRows, endedAllCleared, rowMeta, rowProvider, rowTone, stopAllOf, stopTarget, tabOf, workSection, workTabFor, type WorkRow } from "../gui/src/lib/background";
import type { AgentRun, BackgroundTaskInfo } from "../src/server/protocol";

// The side panel's Agents and Commands tabs (gui/src/lib/background.ts): background tasks and sub-agents as rows, each agent once.

const task = (o: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo => ({ id: "t1", provider: "claude-code", kind: "agent", label: "Map auth", startedAt: 0, status: "running", stoppable: true, ...o });
const run = (o: Partial<AgentRun> = {}): AgentRun => ({ id: "call_1", turnId: "turn_1", description: "Map auth", agentType: "general-purpose", status: "running", startedAt: 0, toolCount: 0, tokens: 0, blocks: [], ...o });
const keys = (placed: { row: WorkRow; depth: number }[]) => placed.map((p) => `${"  ".repeat(p.depth)}${p.row.key}`);
const dur = (ms: number) => `${ms / 1000}s`;

test("shells and monitors are commands; sub-agents, workflows and other tasks are agents'", () => {
    expect(["agent", "workflow", "other", "shell", "monitor"].map((kind) => tabOf({ kind: kind as BackgroundTaskInfo["kind"] }))).toEqual(["agents", "agents", "agents", "commands", "commands"]);
    const tasks = [task(), task({ id: "bash_1", kind: "shell", provider: "cavvy", label: "npm run dev" }), task({ id: "m1", kind: "monitor", label: "Watch the log" })];
    expect(commandRows(tasks).map((r) => r.key)).toEqual(["task:bash_1", "task:m1"]);
    expect(agentRows(tasks, []).map((r) => r.key)).toEqual(["task:t1"]);
});

test("a background sub-agent and its run are one row: by the call that launched it, or a delegated task's id", () => {
    // Claude Code's: its task id is the CLI's own, the call is the run's id.
    const cc = task({ id: "b7x2", toolUseId: "toolu_1", label: "Fix #375" });
    // Cavvy's delegated task: task-1, from the delegate call; the run knows it as its taskId too.
    const delegated = task({ id: "task-1", provider: "gemini", toolUseId: "call_d", label: "Review the diff" });
    // Codex's: the sub-agent's thread, from its spawn call.
    const codex = task({ id: "thread-9", provider: "codex", toolUseId: "call_s", label: "Explore" });
    const agents = [run({ id: "toolu_1", description: "Fix #375" }), run({ id: "call_d", taskId: "task-1", description: "Review the diff", model: "gemini:gemini-3-pro" }), run({ id: "call_s", description: "Explore" })];
    const rows = agentRows([cc, delegated, codex], agents);
    expect(rows.map((r) => [r.key, r.tasks.map((t) => t.id)])).toEqual([
        ["toolu_1", ["b7x2"]],
        ["call_d", ["task-1"]],
        ["call_s", ["thread-9"]],
    ]);
    // By the task id alone, when the task doesn't name its call.
    expect(agentRows([task({ id: "task-2" })], [run({ id: "call_e", taskId: "task-2", description: "Other words" })]).map((r) => [r.key, r.tasks.length])).toEqual([["call_e", 1]]);
});

test("a task with no run is a row of its own, and a sub-agent with no task (the turn's own) is one too", () => {
    const rows = agentRows([task({ id: "w1", kind: "workflow", label: "Release", toolUseId: "toolu_gone" })], [run({ id: "toolu_fg", description: "Write the note" })]);
    expect(rows.map((r) => [r.key, r.kind, r.label, r.tasks.length])).toEqual([
        ["toolu_fg", "agent", "Write the note", 0],
        ["task:w1", "workflow", "Release", 1],
    ]);
});

test("a task listed before it names its call goes with the one running sub-agent of its label, and only then", () => {
    const early = task({ id: "b1", label: "Fix #378" });
    expect(agentRows([early], [run({ id: "toolu_1", description: "Fix #378" })]).map((r) => [r.key, r.tasks.length])).toEqual([["toolu_1", 1]]);
    // Two of that label running: which is which isn't known, so neither is guessed.
    expect(agentRows([early], [run({ id: "a", description: "Fix #378" }), run({ id: "b", description: "Fix #378" })]).map((r) => r.key)).toEqual(["a", "b", "task:b1"]);
    expect(agentRows([early, task({ id: "b2", label: "Fix #378" })], [run({ id: "a", description: "Fix #378" })]).map((r) => r.key)).toEqual(["a", "task:b1", "task:b2"]);
    // Not one that has its task already, one that ended, or one that ended itself.
    expect(agentRows([early], [run({ id: "a", description: "Fix #378", status: "done" })]).map((r) => r.key)).toEqual(["a", "task:b1"]);
    expect(agentRows([task({ id: "b0", toolUseId: "a", label: "Fix #378" }), early], [run({ id: "a", description: "Fix #378" })]).map((r) => [r.key, r.tasks.length])).toEqual([["a", 1], ["task:b1", 1]]);
    expect(agentRows([{ ...early, status: "done" }], [run({ id: "a", description: "Fix #378" })]).map((r) => r.key)).toEqual(["a", "task:b1"]);
});

test("a Codex spawn that started two threads is one row with both tasks; its Stop stops both", () => {
    const rows = agentRows([task({ id: "th1", provider: "codex", toolUseId: "call_s" }), task({ id: "th2", provider: "codex", toolUseId: "call_s" })], [run({ id: "call_s" })]);
    expect(rows).toHaveLength(1);
    expect(stopTarget(rows[0]!)).toEqual({ tasks: ["th1", "th2"] });
});

test("a merged row runs while its run or any of its tasks does, waits when its run waits, and ends as its run did", () => {
    const status = (t: Partial<BackgroundTaskInfo>, a: Partial<AgentRun>) => agentRows([task({ toolUseId: "call_1", ...t })], [run(a)])[0]!.status;
    expect(status({}, { status: "waiting" })).toBe("waiting");
    // Its run said it's done, its CLI still lists it: still running, so Stop stays.
    expect(status({}, { status: "done", endedAt: 5 })).toBe("running");
    expect(status({ status: "stopped", endedAt: 5 }, {})).toBe("running");
    expect(status({ status: "done", endedAt: 5 }, { status: "failed", endedAt: 6 })).toBe("failed");
    const ended = agentRows([task({ toolUseId: "call_1", status: "done", endedAt: 9 })], [run({ status: "done" })])[0]!;
    expect(ended.endedAt).toBe(9);
});

test("a sub-agent's own sit under it, a step in; a running one keeps its parent in Running", () => {
    const agents = [run({ id: "p", startedAt: 1 }), run({ id: "c1", parentId: "p", startedAt: 2 }), run({ id: "c2", parentId: "c1", startedAt: 3 }), run({ id: "q", startedAt: 4, status: "done", endedAt: 10 }), run({ id: "qc", parentId: "q", status: "running", startedAt: 5 })];
    const s = workSection(agentRows([], agents));
    expect(keys(s.running)).toEqual(["p", "  c1", "    c2", "q", "  qc"]);
    expect(s.finished).toEqual([]);
    // One whose parent isn't listed sits at the top.
    expect(keys(workSection(agentRows([], [run({ id: "orphan", parentId: "gone" })])).running)).toEqual(["orphan"]);
});

test("Running is oldest first; Finished most recent first, with its failures counted under each", () => {
    const agents = [run({ id: "new", startedAt: 5 }), run({ id: "old", startedAt: 1 }), run({ id: "f1", status: "failed", startedAt: 0, endedAt: 3 }), run({ id: "f1c", parentId: "f1", status: "failed", startedAt: 1, endedAt: 2 }), run({ id: "d1", status: "done", startedAt: 0, endedAt: 8 })];
    const s = workSection(agentRows([task({ id: "lone", toolUseId: undefined, label: "Release", status: "done", startedAt: 0, endedAt: 6 })], agents));
    expect(keys(s.running)).toEqual(["old", "new"]);
    expect(keys(s.finished)).toEqual(["d1", "task:lone", "f1", "  f1c"]);
    expect(s.failed).toBe(2);
    expect(s.live).toBe(2);
});

test("the tabs' counts: what runs in each now, every sub-agent once", () => {
    const tasks = [task({ id: "b1", toolUseId: "toolu_1" }), task({ id: "b2", toolUseId: "toolu_2" }), task({ id: "sh", kind: "shell", provider: "cavvy" }), task({ id: "old", kind: "shell", status: "done", endedAt: 1 })];
    const agents = [run({ id: "toolu_1" }), run({ id: "toolu_2", description: "Other" }), run({ id: "toolu_3", status: "done", endedAt: 2 }), run({ id: "nested", parentId: "toolu_1", status: "waiting" })];
    // Before: Background listed b1 and b2, Lineage toolu_1 and toolu_2 again.
    expect(workSection(agentRows(tasks, agents)).live).toBe(3);
    expect(workSection(commandRows(tasks)).live).toBe(1);
});

test("Stop: a row's running tasks that can stop, else its delegated run; Stop all shows for more than one", () => {
    const rows = agentRows(
        [task({ id: "b1", toolUseId: "a" }), task({ id: "b2", toolUseId: "b", stoppable: false }), task({ id: "b3", toolUseId: "c", status: "done", endedAt: 1 })],
        [run({ id: "a" }), run({ id: "b", taskId: undefined }), run({ id: "c", status: "done", endedAt: 1 }), run({ id: "d", taskId: "task-4" }), run({ id: "e" }), run({ id: "dc", parentId: "d", taskId: "task-5" })],
    );
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(stopTarget(by("a"))).toEqual({ tasks: ["b1"] });
    // One the CLI says can't stop on its own, one that ended, a Task sub-agent of the turn's own: no Stop.
    expect(stopTarget(by("b"))).toBeUndefined();
    expect(stopTarget(by("c"))).toBeUndefined();
    expect(stopTarget(by("e"))).toBeUndefined();
    // A delegated one with no task listed (an older server): by its run.
    expect(stopTarget(by("d"))).toEqual({ agent: "d" });
    const s = workSection(rows);
    // Counted at the top only (a, d); the one under d stops with Stop all too.
    expect(s.stoppable).toBe(2);
    expect(stopAllOf(s.running.map((p) => p.row))).toEqual({ tasks: ["b1"], agents: ["d", "dc"] });
});

test("while the pointer is on the list, a row that ends stays in Running and a finished one stays in Finished", () => {
    const before = agentRows([], [run({ id: "a", startedAt: 1 }), run({ id: "b", startedAt: 2 }), run({ id: "z", status: "done", startedAt: 0, endedAt: 1 })]);
    const held = new Set(workSection(before).finished.map((p) => p.row.key));
    expect([...held]).toEqual(["z"]);
    const after = agentRows([], [run({ id: "a", status: "done", startedAt: 1, endedAt: 5 }), run({ id: "b", startedAt: 2 }), run({ id: "z", status: "done", startedAt: 0, endedAt: 1 }), run({ id: "n", startedAt: 6, status: "done", endedAt: 7 })]);
    expect(keys(workSection(after, held).running)).toEqual(["a", "b", "n"]);
    expect(keys(workSection(after, held).finished)).toEqual(["z"]);
    // Once it leaves, the list catches up.
    expect(keys(workSection(after).running)).toEqual(["b"]);
    expect(keys(workSection(after).finished)).toEqual(["n", "a", "z"]);
});

test("the composer's count and /tasks open Agents while a sub-agent runs, else Commands", () => {
    expect(workTabFor([task({ id: "sh", kind: "shell" })], [run()])).toBe("agents");
    expect(workTabFor([task({ id: "sh", kind: "shell" })], [run({ status: "done" })])).toBe("commands");
    expect(workTabFor([task()], [])).toBe("agents");
    expect(workTabFor([], [])).toBe("commands");
});

test("a row's time, its end, and their colour", () => {
    const [live, waiting, done, failed] = agentRows([], [run({ startedAt: 1000 }), run({ id: "w", status: "waiting" }), run({ id: "d", status: "done", startedAt: 1000, endedAt: 4000 }), run({ id: "f", status: "failed", startedAt: 0, endedAt: 2000 })]);
    expect(rowMeta(live!, [], 6000, dur)).toBe("5s");
    expect(rowMeta(waiting!, [], 6000, dur)).toBe("Needs you");
    expect(rowMeta(done!, [], 6000, dur)).toBe("Done · 3s");
    expect(rowMeta(failed!, [], 6000, dur)).toBe("Failed · 2s");
    expect([live, waiting, done, failed].map((r) => rowTone(r!))).toEqual(["", "warn", "ok", "err"]);
    // A task's own row says it as the task does: a monitor's time left; one Cavvy's quitting stopped.
    const shells = [{ id: "m1", command: "x", running: true, exitCode: null, startedAt: 0, monitor: { description: "d", events: 0, expiresAt: 125_000 } }];
    expect(rowMeta(commandRows([task({ id: "m1", kind: "monitor" })])[0]!, shells, 5000, dur)).toBe("2m left");
    const lost = agentRows([task({ toolUseId: "call_1", status: "stopped", lost: true })], [run({ status: "stopped" })])[0]!;
    expect(rowMeta(lost, [], 0, dur)).toBe("Stopped when Cavvy quit");
    expect(rowTone(lost)).toBe("warn");
    // Rows cleared from a fold are known by their key, start and end.
    expect(clearKey(done!)).toBe("d@1000-4000");
});

test("who runs a row: its task's runner, else its run's model's provider, else the session's; none for Cavvy's own commands", () => {
    const [cc, delegated, own] = agentRows([task({ toolUseId: "a" })], [run({ id: "a" }), run({ id: "b", model: "gemini:gemini-3-pro" }), run({ id: "c" })]);
    expect(rowProvider(cc!, "codex")).toBe("claude-code");
    expect(rowProvider(delegated!, "codex")).toBe("gemini");
    expect(rowProvider(own!, "codex")).toBe("codex");
    expect(rowProvider(commandRows([task({ id: "sh", kind: "shell", provider: "cavvy" })])[0]!, "codex")).toBeUndefined();
});

test("the server's finished tasks are cleared once every finished row with a task is cleared, in both tabs", () => {
    const tasks = [task({ id: "b1", toolUseId: "a", status: "done", endedAt: 1 }), task({ id: "sh", kind: "shell", status: "done", startedAt: 3, endedAt: 4 }), task({ id: "live", kind: "shell" })];
    const rows = [...agentRows(tasks, [run({ id: "a", status: "done", startedAt: 0, endedAt: 1 }), run({ id: "fg", status: "done", startedAt: 2, endedAt: 3 })]), ...commandRows(tasks)];
    // The Agents fold cleared: the shell that ended is still in Commands.
    expect(endedAllCleared(rows, new Set(["a@0-1", "fg@2-3"]))).toBe(false);
    // Commands cleared too (a sub-agent with no task needn't be).
    expect(endedAllCleared(rows, new Set(["a@0-1", "task:sh@3-4"]))).toBe(true);
});

test("a cleared row that runs again (Codex messaged after it answered) shows again when it finishes again", () => {
    // Cleared once it was done: the run's id and start stay the same when it's messaged again.
    const done = agentRows([], [run({ status: "done", startedAt: 0, endedAt: 5 })])[0]!;
    const cleared = new Set([clearKey(done)]);
    const again = agentRows([task({ toolUseId: "call_1", status: "failed", startedAt: 6, endedAt: 9 })], [run({ status: "failed", startedAt: 0, endedAt: 9 })])[0]!;
    expect(clearKey(again)).not.toBe(clearKey(done));
    // So its new end isn't hidden, and the server's list keeps the task it shows.
    expect(cleared.has(clearKey(again))).toBe(false);
    expect(endedAllCleared([again], cleared)).toBe(false);
});

test("a delegated task whose id an earlier run had (the counter starts again with a new Agent) doesn't join that run", () => {
    // task-1 again, after the old run with that taskId ended; its call wasn't claimed, so it names none.
    const old = run({ id: "call_old", taskId: "task-1", description: "Old review", status: "done", startedAt: 0, endedAt: 50 });
    const fresh = task({ id: "task-1", provider: "gemini", label: "New review", startedAt: 100 });
    const rows = agentRows([fresh], [old]);
    expect(rows.map((r) => [r.key, r.label, r.tasks.length])).toEqual([
        ["call_old", "Old review", 0],
        ["task:task-1", "New review", 1],
    ]);
    // One that started before the run ended is that run's.
    expect(agentRows([{ ...fresh, startedAt: 10 }], [old]).map((r) => [r.key, r.tasks.length])).toEqual([["call_old", 1]]);
    // Of two runs with that taskId, the one still running takes it.
    expect(agentRows([fresh], [old, run({ id: "call_new", taskId: "task-1", startedAt: 100 })]).map((r) => [r.key, r.tasks.length])).toEqual([
        ["call_old", 0],
        ["call_new", 1],
    ]);
});
