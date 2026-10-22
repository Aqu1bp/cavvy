// The composer's queue tab: what each queued message says it will do, what it
// lets you do with it, and where a move or drop puts it.

import { describe, expect, test } from "bun:test";

const { dropTarget, firstSendable, followUpFor, otherFollowUp, queueRow, stepTarget } = await import("../gui/src/lib/queue");

describe("steer or queue", () => {
    test("the setting decides, steer when unset; the opposite key flips it", () => {
        expect(followUpFor(undefined, false)).toBe("steer");
        expect(followUpFor(null, false)).toBe("steer");
        expect(followUpFor("queue", false)).toBe("queue");
        expect(followUpFor(undefined, true)).toBe("queue");
        expect(followUpFor("queue", true)).toBe("steer");
        expect(otherFollowUp("steer")).toBe("queue");
        expect(otherFollowUp("queue")).toBe("steer");
    });
});

describe("queue rows", () => {
    test("while a turn runs, a queued message offers Steer; idle, Send now; none for one already steering, nor one that can't join", () => {
        expect(queueRow("queue", true).action).toEqual({ label: "Steer", title: "Add to the current turn at its next step" });
        expect(queueRow("held", true).action).toMatchObject({ label: "Steer", title: expect.stringMatching(/^Add to the current turn at its next step/) });
        expect(queueRow("steer", true).action).toBeUndefined();
        expect(queueRow("turn", true).action).toBeUndefined();
        expect(queueRow("queue", false).action?.label).toBe("Send now");
        expect(queueRow("turn", false).action?.label).toBe("Send now");
        expect(queueRow("held", false).action).toEqual({ label: "Send now", title: expect.stringMatching(/new turn/) });
        // An older server sends no modes: everything steered, as it did.
        expect(queueRow(undefined, true)).toEqual(queueRow("steer", true));
    });

    test("one already steering says it's on its way, and where it goes in when no step is left", () => {
        expect(queueRow("steer", true)).toMatchObject({ hint: "Joins at the next step", joining: true });
        expect(queueRow("steer", true).detail).toMatch(/at its next step\. If the model is already writing its last reply, it goes in right after that reply/);
        expect(queueRow("steer", false).joining).toBe(false);
    });

    test("each says what it will do, in a word or two, and why in its tooltip", () => {
        expect(queueRow("steer", false).hint).toBe("Next step");
        expect(queueRow("queue", true).hint).toBe("After this turn");
        expect(queueRow("turn", true).detail).toMatch(/Commands, and images or files this model can.t take/);
        expect(queueRow("held", false)).toMatchObject({ hint: "Held", detail: expect.stringMatching(/restarted/) });
    });

    test("mod+shift+enter with nothing typed takes the first message that send now applies to", () => {
        expect(firstSendable(["steer", "turn", "queue", "held"], true)).toBe(2);
        expect(firstSendable(["held", "queue"], true)).toBe(0);
        expect(firstSendable(["steer", "turn"], true)).toBe(-1);
        expect(firstSendable([], true)).toBe(-1);
    });
});

describe("reordering", () => {
    test("↑ and ↓ move one place, and stop at the ends", () => {
        expect(stepTarget(1, "up", 3)).toBe(0);
        expect(stepTarget(0, "up", 3)).toBeUndefined();
        expect(stepTarget(1, "down", 3)).toBe(2);
        expect(stepTarget(2, "down", 3)).toBeUndefined();
        expect(stepTarget(0, "down", 1)).toBeUndefined();
    });

    test("a drop before a row (or at the end) is the new position; on either side of itself it doesn't move", () => {
        // [a, b, c, d]: a dropped before d ends up third.
        expect(dropTarget(0, 3)).toBe(2);
        expect(dropTarget(0, 4)).toBe(3);
        expect(dropTarget(3, 0)).toBe(0);
        expect(dropTarget(2, 1)).toBe(1);
        expect(dropTarget(1, 1)).toBeUndefined();
        expect(dropTarget(1, 2)).toBeUndefined();
    });
});
