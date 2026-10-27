// The "Up next" tray: what each queued message says it will do, what it lets
// you do with it, and where a move or drag puts it (lib/queue.ts), and the
// tray itself (fixtures/gui-queue-tray.ts, real Solid reactivity in an
// in-memory DOM).

import { describe, expect, test } from "bun:test";

const { clampDrag, dragTarget, firstSendable, followUpFor, followUpLabels, joiningRow, moved, movedAnnouncement, otherFollowUp, queueRow, settleMs, slotOf, stepTarget, withDraft } = await import("../gui/src/lib/queue");

describe("text handed back to the composer", () => {
    test("a steer the turn never took goes after what's typed, a blank line between; nothing typed: it's all there is", () => {
        expect(withDraft("half a thought", "and then deploy", true)).toBe("half a thought\n\nand then deploy");
        expect(withDraft("half a thought\n", "and then deploy", true)).toBe("half a thought\n\nand then deploy");
        expect(withDraft("  ", "and then deploy", true)).toBe("and then deploy");
        // The others (an interrupted queue, a rewound prompt) still go ahead of it.
        expect(withDraft("half a thought", "queued one")).toBe("queued one\nhalf a thought");
    });
});

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

    test("a model that can't be steered queues either way", () => {
        for (const setting of [undefined, "steer", "queue"] as const) for (const opposite of [false, true]) expect(followUpFor(setting, opposite, false)).toBe("queue");
    });

    test("the box says in a few words what sending does now; the send button, what Enter and the other key do", () => {
        expect(followUpLabels({ mode: "steer", steers: true, send: "Enter", other: "⇧⌘Enter", click: "⌘-click" })).toEqual({
            placeholder: "Steer this turn…",
            title: "Steer: joins this turn at its next step (Enter). ⌘-click or ⇧⌘Enter to queue instead.",
        });
        expect(followUpLabels({ mode: "queue", steers: true, send: "Ctrl+Enter", other: "Ctrl+Shift+Enter", click: "Ctrl-click" })).toEqual({
            placeholder: "Queue for after this turn…",
            title: "Queue: runs after this turn (Ctrl+Enter). Ctrl-click or Ctrl+Shift+Enter to steer instead.",
        });
        // macOS's symbols run together, as the menus show them.
        expect(followUpLabels({ mode: "steer", steers: true, send: "⌘+Enter", other: "⌥+S", click: "⌘-click" }).title).toBe("Steer: joins this turn at its next step (⌘Enter). ⌘-click or ⌥S to queue instead.");
        // The other key unbound: only mod-click is left.
        expect(followUpLabels({ mode: "steer", steers: true, send: "Enter", click: "⌘-click" })).toEqual({ placeholder: "Steer this turn…", title: "Steer: joins this turn at its next step (Enter). ⌘-click to queue instead." });
    });

    test("where the model can't be steered, both say it queues; the send button, why", () => {
        expect(followUpLabels({ mode: "queue", steers: false, send: "Enter", other: "⇧⌘Enter", click: "⌘-click", who: "Slow CLI" })).toEqual({
            placeholder: "Queue for after this turn…",
            title: "Queue: runs after this turn (Enter). Slow CLI can't take messages mid-turn.",
        });
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
        expect(queueRow("steer", true)).toMatchObject({ hint: "Next step", joining: true });
        expect(queueRow("steer", true).detail).toMatch(/at its next step\. If the model is already writing its last reply, it goes in right after that reply/);
        expect(queueRow("steer", false).joining).toBe(false);
    });

    test("each says what it will do, in a word or two, and why in its tooltip", () => {
        expect(queueRow("steer", false).hint).toBe("Next step");
        expect(queueRow("queue", true).hint).toBe("After this turn");
        expect(queueRow("turn", true).detail).toMatch(/Commands, and attachments this model can.t take/);
        expect(queueRow("turn", true, "Claude Code can't take PDFs in a running turn: this runs once it ends.").detail).toBe("Claude Code can't take PDFs in a running turn: this runs once it ends.");
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

    test("a held row drops into the nearest slot, past half a row; it follows the pointer within the list and 6px past its ends", () => {
        // Rows 36px apart, four of them.
        expect(dragTarget(0, 17, 36, 4)).toBe(0);
        expect(dragTarget(0, 19, 36, 4)).toBe(1);
        expect(dragTarget(0, 80, 36, 4)).toBe(2);
        expect(dragTarget(3, -200, 36, 4)).toBe(0);
        expect(dragTarget(1, 500, 36, 4)).toBe(3);
        expect(dragTarget(1, 50, 0, 4)).toBe(1);
        expect(clampDrag(1, 500, 36, 4)).toBe(2 * 36 + 6);
        expect(clampDrag(1, -500, 36, 4)).toBe(-36 - 6);
        expect(clampDrag(1, 20, 36, 4)).toBe(20);
        expect(clampDrag(0, 40, 36, 1)).toBe(6);
    });

    test("while a row is held, the ones it passes move one place out of its way, and the numbers follow the order being made", () => {
        // [a, b, c, d] with a held over slot 2: b and c move up, d stays.
        expect([0, 1, 2, 3].map((i) => slotOf(i, 0, 2))).toEqual([2, 0, 1, 3]);
        // d held over slot 1: b and c move down.
        expect([0, 1, 2, 3].map((i) => slotOf(i, 3, 1))).toEqual([0, 2, 3, 1]);
        // Held where it was: nothing moves.
        expect([0, 1, 2, 3].map((i) => slotOf(i, 2, 2))).toEqual([0, 1, 2, 3]);
        // The numbers shown are a permutation that matches the server's order after the move.
        for (const [from, to] of [[0, 3], [3, 0], [1, 2], [2, 1]] as const) {
            const order = moved(["a", "b", "c", "d"], from, to);
            ["a", "b", "c", "d"].forEach((x, i) => expect(order[slotOf(i, from, to)]).toBe(x));
        }
    });

    test("a move makes the order the server makes (runtime moveQueued): out, then in at `to`, clamped", () => {
        expect(moved([10, 20, 30], 2, 0)).toEqual([30, 10, 20]);
        expect(moved([10, 20, 30], 0, 2)).toEqual([20, 30, 10]);
        expect(moved([10, 20, 30], 0, 9)).toEqual([20, 30, 10]);
        expect(moved([10, 20, 30], 1, 1)).toEqual([10, 20, 30]);
        expect(moved([10, 20, 30], 5, 0)).toEqual([10, 20, 30]);
        // Keyboard: ↑ on the third is a move to the second.
        expect(moved([10, 20, 30], 2, stepTarget(2, "up", 3)!)).toEqual([10, 30, 20]);
    });

    test("a moved message is announced by its new place", () => {
        expect(movedAnnouncement(0, 3)).toBe("Moved to position 1 of 3");
        expect(movedAnnouncement(2, 3)).toBe("Moved to position 3 of 3");
    });

    test("the settle takes --dur-settle, and nothing with reduced motion or Instant", () => {
        expect(settleMs("220ms", false)).toBe(220);
        expect(settleMs(" 0.32s", false)).toBe(320);
        expect(settleMs("0ms", false)).toBe(0);
        expect(settleMs("", false)).toBe(0);
        expect(settleMs("220ms", true)).toBe(0);
    });

    test("only the first steer pulses, and only while a turn runs", () => {
        expect(joiningRow(["steer", "queue", "steer"], true)).toBe(0);
        expect(joiningRow(["queue", "steer", "steer"], true)).toBe(1);
        expect(joiningRow([undefined, "queue"], true)).toBe(0);
        expect(joiningRow(["steer", "queue"], false)).toBe(-1);
        expect(joiningRow(["queue", "held", "turn"], true)).toBe(-1);
    });
});

// Each runs its namesake in fixtures/gui-queue-tray.ts, in a browser-conditions
// process, so Solid's renderer and signals are the same copy.
const fixture = (name: string) =>
    test(name, () => {
        const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
        const result = Bun.spawnSync([process.execPath, "--no-env-file", "--conditions=browser", "test", new URL("./fixtures/gui-queue-tray.ts", import.meta.url).pathname, "-t", pattern], { timeout: 15000 });
        const output = result.stderr.toString();
        expect({ code: result.exitCode, output }).toMatchObject({ code: 0 });
        expect(output).toContain(" 1 pass");
    });

fixture("tray: numbered rows, a hint each, the first steer pulses, Steer on a queued one");
fixture("tray: ↑ moves the focused row one place, the others slide, the numbers follow, and it lands without a jump");
fixture("tray: ↑↑ pressed fast moves the same message twice");
fixture("tray: a drag from the row lifts it after 3px, follows the pointer within the list, and drops where it's held");
fixture("tray: a click stays a click, a press on a button starts no drag, and a drop back in place asks nothing");
fixture("tray: with reduced motion the move goes at once, whatever --dur-settle says");
fixture("tray: a message already sent says so and the rows go back; a queue that changes mid-drag lets go");
