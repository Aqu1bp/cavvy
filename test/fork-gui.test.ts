import { expect, test } from "bun:test";
import { forkAnchor } from "../gui/src/lib/fork";
import type { Turn } from "../src/server/protocol";

const imported: Turn = { id: "imported", prompt: { text: "First message" }, imported: true, pos: { seg: 0, index: 0 }, blocks: [], status: "done" };

test("imported responses can fork without gaining a rewind target", () => {
    expect(forkAnchor([imported], 0)).toEqual({ index: 0, text: "First message", turn: "imported" });
    expect(imported.prompt!.index).toBeUndefined();
});

test("forking still refuses archived history and uses the initiating prompt for steering", () => {
    expect(forkAnchor([{ ...imported, archived: true }], 0)).toBeUndefined();
    const first: Turn = { ...imported, imported: undefined, prompt: { text: "Original prompt", index: 4 }, id: "first" };
    const steering: Turn = { ...first, id: "steering", prompt: { text: "Follow up" }, pos: { seg: 0, index: 6 } };
    expect(forkAnchor([first, steering], 1)).toEqual({ index: 4, text: "Original prompt", turn: "first" });
});
