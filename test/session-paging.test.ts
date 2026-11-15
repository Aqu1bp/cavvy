// A long session opens with its last turns (session.open's `last`), and the window asks for the rest as it needs them
// (session.turns): pages before a turn it has, back to a message, or all, as the server's view has them now.
import { afterAll, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";
import type { AgentRun, SessionOp, SessionState, Turn } from "../src/server/protocol";

const iso = isolate();
const { Runtime } = await import("../src/server/runtime");
const { applyOp } = await import("../src/server/timeline");
const { stepsStale } = await import("../gui/src/lib/plan-chat");
afterAll(() => iso.cleanup());

/** A runtime's view of `n` turns, each placed at message 2i of segment 0, with only what snapshot and paging read. */
function runtime(n: number) {
    const turns: Turn[] = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, startedAt: i, status: "done", blocks: [], pos: { seg: 0, index: 2 * i } }) as Turn);
    const view = { state: { id: "s", interactions: [] } as unknown as SessionState, turns, agents: [] };
    let flushed = 0;
    const rt = Object.assign(Object.create(Runtime.prototype), { view, batch: 7, flush: () => void flushed++ }) as InstanceType<typeof Runtime>;
    return { rt, view, flushed: () => flushed };
}

test("a session opens with its last turns, the rest counted; without `last`, all of them", () => {
    const { rt } = runtime(10);
    const some = rt.snapshot(3);
    expect(some.turns.map((t) => t.id)).toEqual(["t7", "t8", "t9"]);
    expect(some.earlier).toBe(7);
    expect(some.seq).toBe(7);
    const all = rt.snapshot();
    expect(all.turns).toHaveLength(10);
    expect(all.earlier).toBeUndefined();
    // Fewer than asked for: all, nothing counted.
    expect(rt.snapshot(50).earlier).toBeUndefined();
});

test("earlier turns come as a page before a turn, back to a message's, or all; what's sent so far is in them", () => {
    const { rt, flushed } = runtime(10);
    const page = rt.turnsBefore("t7", { count: 2 })!;
    expect(page.turns.map((t) => t.id)).toEqual(["t5", "t6"]);
    expect(page.earlier).toBe(5);
    // Ops still waiting to go were sent first: the page is as the window will have it after them.
    expect(flushed()).toBe(1);
    // Back to the turn holding message 5 (turn 2, at message 4), a page at least.
    expect(rt.turnsBefore("t7", { count: 2, through: { seg: 0, index: 5 } })!.turns[0]!.id).toBe("t2");
    expect(rt.turnsBefore("t7", { all: true })!).toMatchObject({ earlier: 0 });
    expect(rt.turnsBefore("t7", { all: true })!.turns).toHaveLength(7);
    // A turn the view doesn't have (replaced by a rewind): nothing, rather than turns from elsewhere.
    expect(rt.turnsBefore("gone", {})).toBeUndefined();
    // Copies: what the window does with them doesn't touch the server's.
    page.turns[0]!.status = "aborted";
    expect(rt.snapshot().turns[5]!.status).toBe("done");
});

test("an op for a turn the window hasn't been sent changes nothing; the page sent after has it", () => {
    const server = runtime(5);
    const windowView = { ...structuredClone(server.rt.snapshot(2)), earlier: 3 };
    const op: SessionOp = { op: "turn.patch", turnId: "t1", patch: { status: "aborted" } };
    applyOp(server.view, op);
    applyOp(windowView, op);
    expect(windowView.turns.map((t) => t.id)).toEqual(["t3", "t4"]);
    const page = server.rt.turnsBefore("t3", { all: true })!;
    windowView.turns.unshift(...page.turns);
    expect(windowView.turns.find((t) => t.id === "t1")!.status).toBe("aborted");
    // A rewind replaces them all: nothing earlier then.
    applyOp(windowView, { op: "reset", turns: structuredClone(server.view.turns) });
    expect(windowView.earlier).toBe(0);
});

test("a reset that says how many turns came before it leaves those to be asked for", () => {
    const server = runtime(150);
    const windowView = { ...structuredClone(server.rt.snapshot(100)) };
    // A rewind of a long session sends the windows its last turns, as an open does, and how many came before.
    applyOp(windowView, { op: "reset", turns: structuredClone(server.view.turns.slice(50)), earlier: 50 });
    expect(windowView.turns).toHaveLength(100);
    expect(windowView.earlier).toBe(50);
    const page = server.rt.turnsBefore(windowView.turns[0]!.id, { all: true })!;
    expect(page).toMatchObject({ earlier: 0 });
    expect(page.turns).toHaveLength(50);
});

test("a long session rebuilt (a rewind) keeps all its turns, and sends the windows its last 100", () => {
    const server = runtime(250);
    const sent: SessionOp[] = [];
    const rt = server.rt as unknown as { op(o: SessionOp, sent?: SessionOp): void; outbox: SessionOp[]; noteStep(): void; flushTimer?: unknown; engine: unknown };
    Object.assign(rt, { outbox: sent, noteStep() {}, flushTimer: 1, engine: { sessionShown: () => true } });
    const turns = structuredClone(server.view.turns);
    const from = turns.length - 100;
    rt.op({ op: "reset", turns }, structuredClone({ op: "reset", turns: turns.slice(from), earlier: from }));
    expect(server.view.turns).toHaveLength(250);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ op: "reset", earlier: 150 });
    expect((sent[0] as Extract<SessionOp, { op: "reset" }>).turns).toHaveLength(100);
    // What's sent isn't the view's: a window changing it changes nothing here.
    (sent[0] as Extract<SessionOp, { op: "reset" }>).turns[0]!.status = "aborted";
    expect(server.view.turns[150]!.status).toBe("done");
});

test("a session opens with no more of its last turns than fit the budget, and one at least", () => {
    const { rt, view } = runtime(50);
    for (const t of view.turns) (t as { blocks: unknown[] }).blocks = [{ t: "text", id: `${t.id}-b`, text: "x".repeat(1000) }];
    const size = JSON.stringify(view.turns[49]).length;
    // Five turns' worth: the five latest (the fifth is the one that reaches it).
    const five = rt.snapshot(100, size * 5);
    expect(five.turns.map((t) => t.id)).toEqual(["t45", "t46", "t47", "t48", "t49"]);
    expect(five.earlier).toBe(45);
    // Less than one: one.
    expect(rt.snapshot(100, 10).turns.map((t) => t.id)).toEqual(["t49"]);
    // `last` still caps it.
    expect(rt.snapshot(3, size * 100).turns).toHaveLength(3);
});

test("a session opens with the sub-agents of the turns it sends, and any running, whole; the rest counted, and listed when asked", () => {
    const { rt, view } = runtime(10);
    const agent = (id: string, turnId: string, status: AgentRun["status"], more: Partial<AgentRun> = {}): AgentRun => ({ id, turnId, status, description: `does ${id}`, agentType: "general-purpose", startedAt: 1, toolCount: 3, tokens: 9, prompt: "the instructions", report: "what it found", blocks: [{ t: "text", id: `${id}-b`, text: "a step" }] as AgentRun["blocks"], ...more });
    (view as { agents: AgentRun[] }).agents = [agent("old", "t1", "done"), agent("broke", "t1", "failed"), agent("task", "t1", "done", { taskId: "task-1" }), agent("busy", "t2", "running"), agent("new", "t8", "done")];
    const some = rt.snapshot(3);
    const byId = Object.fromEntries(some.agents.map((a) => [a.id, a]));
    // Of a turn it sends, or still running: whole.
    expect(byId.new).toMatchObject({ blocks: [{ id: "new-b" }], prompt: "the instructions", report: "what it found" });
    expect(byId.new!.partial).toBeUndefined();
    expect(byId.busy).toMatchObject({ blocks: [{ id: "busy-b" }], prompt: "the instructions" });
    // One a background task is: what the list shows of it (the task's row is its row), and no more.
    expect(byId.task).toEqual({ id: "task", turnId: "t1", status: "done", description: "does task", agentType: "general-purpose", startedAt: 1, toolCount: 3, tokens: 9, taskId: "task-1", blocks: [], partial: true });
    // The rest of a turn it doesn't send: counted, not sent; how many failed too (the Finished fold says it).
    expect(Object.keys(byId).sort()).toEqual(["busy", "new", "task"]);
    expect(some.agentsMore).toEqual({ count: 2, failed: 1 });
    // Asked for (the fold shown): each as the list shows it.
    const list = rt.agentList();
    expect(list.map((a) => a.id)).toEqual(["old", "broke", "task", "busy", "new"]);
    expect(list.find((a) => a.id === "old")).toEqual({ id: "old", turnId: "t1", status: "done", description: "does old", agentType: "general-purpose", startedAt: 1, toolCount: 3, tokens: 9, blocks: [], partial: true });
    // Every turn sent: every sub-agent whole, none counted.
    const all = rt.snapshot();
    expect(all.agents.every((a) => !a.partial && a.blocks.length === 1)).toBe(true);
    expect(all.agentsMore).toBeUndefined();
    // Its turn's page brings it whole, and so does asking for it.
    const page = rt.turnsBefore("t7", { count: 10 })!;
    expect(page.agents?.map((a) => a.id).sort()).toEqual(["broke", "busy", "old", "task"]);
    expect(page.agents?.find((a) => a.id === "old")).toMatchObject({ prompt: "the instructions", blocks: [{ id: "old-b" }] });
    expect(rt.agentWhole("old")).toMatchObject({ report: "what it found" });
    expect(rt.agentWhole("gone")).toBeNull();
    // Copies: what the window does with them doesn't touch the server's.
    byId.new!.blocks.length = 0;
    list[0]!.description = "changed";
    expect(view.agents[4]!.blocks).toHaveLength(1);
    expect(view.agents[0]!.description).toBe("does old");
});

test("a finished step list written before the turns a window has is stale", () => {
    const done = [{ content: "a", status: "completed" }] as never;
    const turns = [{ blocks: [] }, { blocks: [] }];
    expect(stepsStale(done, turns)).toBe(false);
    expect(stepsStale(done, turns, 40)).toBe(true);
    expect(stepsStale(done, [{ blocks: [{ t: "tool", name: "TodoWrite" }] }], 40)).toBe(false);
});
