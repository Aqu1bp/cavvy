// A long session opens with its last turns (session.open's `last`), and the window asks for the rest as it needs them
// (session.turns): pages before a turn it has, back to a message, or all, as the server's view has them now.
import { afterAll, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";
import type { SessionOp, SessionState, Turn } from "../src/server/protocol";

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

test("a finished step list written before the turns a window has is stale", () => {
    const done = [{ content: "a", status: "completed" }] as never;
    const turns = [{ blocks: [] }, { blocks: [] }];
    expect(stepsStale(done, turns)).toBe(false);
    expect(stepsStale(done, turns, 40)).toBe(true);
    expect(stepsStale(done, [{ blocks: [{ t: "tool", name: "TodoWrite" }] }], 40)).toBe(false);
});
