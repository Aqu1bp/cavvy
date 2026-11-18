// Updates the user waits on are shown at the next frame, not the stream clock's next step (gui/src/lib/waited-on.ts).
import { expect, test } from "bun:test";
import { waitedOn } from "../gui/src/lib/waited-on";

test("stopping, starting, a question for the user and a turn's end are waited on; what streams isn't", () => {
    expect(waitedOn([{ op: "append", turnId: "t", blockId: "b", field: "text", text: "more" }, { op: "state", patch: { busy: false } }])).toBe(true);
    expect(waitedOn([{ op: "state", patch: { interactions: [] } }])).toBe(true);
    expect(waitedOn([{ op: "turn.patch", turnId: "t", patch: { status: "done" } as never }])).toBe(true);
    expect(waitedOn([{ op: "append", turnId: "t", blockId: "b", field: "text", text: "more" }])).toBe(false);
    expect(waitedOn([{ op: "state", patch: { activity: { label: "Thinking", since: 1 } } as never }])).toBe(false);
    expect(waitedOn([{ op: "turn.patch", turnId: "t", patch: { usage: undefined } as never }])).toBe(false);
    expect(waitedOn([])).toBe(false);
});
