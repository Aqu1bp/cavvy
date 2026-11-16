// A running call's progress is sent as the windows keep it, its last PROGRESS_LIMIT characters (timeline.ts
// lastProgress): applied, it leaves each window with exactly what the whole would have.
import { expect, test } from "bun:test";
import { applyOp, lastProgress, PROGRESS_LIMIT, type SessionView } from "../src/server/timeline";

const view = (): SessionView => ({ state: {} as never, agents: [], turns: [{ id: "t", status: "running", blocks: [{ t: "tool", id: "b", name: "Bash", input: {}, status: "running" } as never] }] });
const progressOf = (v: SessionView) => (v.turns[0]!.blocks[0] as { progress?: string }).progress ?? "";

test("a progress append cut to what's kept leaves the same progress, whatever came before", () => {
    let seed = 3;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const line = () => "x".repeat(Math.floor(rnd() * 300)) + (rnd() < 0.8 ? "\n" : "");
    const whole = view();
    const cut = view();
    for (let i = 0; i < 400; i++) {
        const text = Array.from({ length: 1 + Math.floor(rnd() * (rnd() < 0.2 ? 400 : 5)) }, line).join("");
        const op = { op: "append" as const, turnId: "t", blockId: "b", field: "progress" as const, text };
        applyOp(whole, op);
        const sent = lastProgress(op);
        expect((sent as typeof op).text.length).toBeLessThanOrEqual(PROGRESS_LIMIT + 1);
        applyOp(cut, sent);
        expect(progressOf(cut)).toBe(progressOf(whole));
    }
    // Output and text aren't cut: only progress is kept to a tail.
    const output = { op: "append" as const, turnId: "t", blockId: "b", field: "output" as const, text: "y".repeat(PROGRESS_LIMIT * 3) };
    expect(lastProgress(output)).toBe(output);
});
