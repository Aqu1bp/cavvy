// What the composer's queue tab says about each message sent while a turn
// runs, what it lets you do with it, and where a move puts it. Pure, so the
// rules are tested without a browser.

import type { FollowUpMode, QueuedMode } from "@shared/protocol";

/** What Enter does mid-turn: the setting, or (mod+shift+enter, mod-click) the other one. */
export function followUpFor(setting: FollowUpMode | null | undefined, opposite: boolean): FollowUpMode {
    const base: FollowUpMode = setting === "queue" ? "queue" : "steer";
    return opposite ? (base === "steer" ? "queue" : "steer") : base;
}

export const otherFollowUp = (m: FollowUpMode): FollowUpMode => (m === "steer" ? "queue" : "steer");

/** What a queued message's button does: steer it into the running turn, or (idle) send it now. */
export interface QueueAction {
    label: "Steer" | "Send now";
    title: string;
}

export interface QueueRowInfo {
    /** One or two words, beside the message. */
    hint: string;
    /** Its tooltip: why, in a sentence. */
    detail: string;
    /** The button on the row, where it does something. */
    action?: QueueAction;
    /** Waiting for the running turn's next step: the row shows it's on its way. */
    joining?: boolean;
}

const STEER: QueueAction = { label: "Steer", title: "Add to the current turn at its next step" };
const SEND_NOW: QueueAction = { label: "Send now", title: "Send now" };
/** Where every backend puts it (the agent loop, Claude Code, Codex): at a tool step, or else after the reply being written. */
const JOINS = "Joins the current turn at its next step. If the model is already writing its last reply, it goes in right after that reply";

/** A row of the queue, by what the message will do and whether a turn is running. */
export function queueRow(mode: QueuedMode | undefined, busy: boolean): QueueRowInfo {
    switch (mode ?? "steer") {
        case "steer":
            return { hint: busy ? "Joins at the next step" : "Next step", detail: JOINS, joining: busy };
        case "queue":
            return { hint: "After this turn", detail: "Runs as a turn of its own once this one ends, or at once while the turn only waits on background work", action: busy ? STEER : SEND_NOW };
        case "turn":
            return { hint: "After this turn", detail: "Commands, and images or files this model can't take in a running turn, don't join it: this runs once it ends. While the turn only waits on background work, images and files go at once; commands run after the background work ends", ...(busy ? {} : { action: SEND_NOW }) };
        case "held":
            return {
                hint: "Held",
                detail: "Not sent before Harness restarted. It waits for you: send it, edit it or remove it",
                action: busy ? { label: "Steer", title: "Add to the current turn at its next step (a command runs right after the turn)" } : { label: "Send now", title: "Send now: run it as a new turn" },
            };
    }
}

/** Where ↑/↓ moves the message at `from` (undefined: it's already at that end). */
export function stepTarget(from: number, key: "up" | "down", length: number): number | undefined {
    const to = key === "up" ? from - 1 : from + 1;
    return to < 0 || to >= length ? undefined : to;
}

/** A drop before row `before` (length for the end) as the dragged message's new position, undefined when it doesn't move. */
export function dropTarget(from: number, before: number): number | undefined {
    const to = before > from ? before - 1 : before;
    return to === from ? undefined : to;
}

/** The first message its button (Steer, or Send now) applies to: what mod+shift+enter in an empty composer takes. */
export function firstSendable(modes: readonly (QueuedMode | undefined)[], busy: boolean): number {
    return modes.findIndex((m) => queueRow(m, busy).action !== undefined);
}
