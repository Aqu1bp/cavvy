import { expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { opDelay } = await import("../src/server/runtime");

// A question for the person, or a turn starting or ending, is what they wait for: it goes to the window at once, not
// with the next batch of streamed text (24 ms, three frames at 120 Hz).
test("what the person waits for goes out at once; streamed text waits for its batch", () => {
    try {
        const shown = () => true;
        expect(opDelay({ op: "state", patch: { interactions: [] } }, shown)).toBe(0);
        expect(opDelay({ op: "state", patch: { status: "idle" } }, shown)).toBe(0);
        expect(opDelay({ op: "turn.patch", turnId: "t", patch: { status: "aborted" } }, shown)).toBe(0);
        expect(opDelay({ op: "turn", turn: { id: "t", blocks: [] } as never }, shown)).toBe(0);
        expect(opDelay({ op: "append", turnId: "t", blockId: "b", field: "text", text: "x" }, shown)).toBeGreaterThan(0);
        expect(opDelay({ op: "append", turnId: "t", blockId: "b", field: "text", text: "x" }, () => false)).toBeGreaterThan(opDelay({ op: "append", turnId: "t", blockId: "b", field: "text", text: "x" }, shown));
        expect(opDelay({ op: "block.patch", turnId: "t", blockId: "b", patch: {} }, shown)).toBeGreaterThan(0);
        expect(opDelay({ op: "state", patch: { activity: undefined } }, shown)).toBeGreaterThan(0);
    } finally {
        iso.cleanup();
    }
});
