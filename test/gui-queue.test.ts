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
    test("send now is offered where it does something: not for one already steering, nor (mid-turn) one that can't join", () => {
        expect(queueRow("steer", true).sendNow).toBeUndefined();
        expect(queueRow("queue", true).sendNow).toMatch(/join the current turn/);
        expect(queueRow("turn", true).sendNow).toBeUndefined();
        expect(queueRow("turn", false).sendNow).toBe("Send now");
        expect(queueRow("held", false).sendNow).toMatch(/new turn/);
        expect(queueRow("held", true).sendNow).toMatch(/join the current turn/);
        // An older server sends no modes: everything steered, as it did.
        expect(queueRow(undefined, true)).toEqual(queueRow("steer", true));
    });

    test("each says what it will do, in a word or two, and why in its tooltip", () => {
        expect(queueRow("steer", true).hint).toBe("Next step");
        expect(queueRow("queue", true).hint).toBe("After this turn");
        expect(queueRow("turn", true).detail).toMatch(/Images, files and commands/);
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
