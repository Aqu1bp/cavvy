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

export interface QueueRowInfo {
    /** One or two words, beside the message. */
    hint: string;
    /** Its tooltip: why, in a sentence. */
    detail: string;
    /** "Send now"'s tooltip when it's offered. */
    sendNow?: string;
}

/** A row of the queue, by what the message will do and whether a turn is running. */
export function queueRow(mode: QueuedMode | undefined, busy: boolean): QueueRowInfo {
    switch (mode ?? "steer") {
        case "steer":
            return { hint: "Next step", detail: "Joins the current turn at its next step" };
        case "queue":
            return { hint: "After this turn", detail: "Runs as a turn of its own once this one ends", sendNow: busy ? "Send now: join the current turn at its next step" : "Send now" };
        case "turn":
            return { hint: "After this turn", detail: "Images, files and commands can't join a running turn: this runs once it ends", ...(busy ? {} : { sendNow: "Send now" }) };
        case "held":
            return { hint: "Held", detail: "Not sent before Harness restarted. It waits for you: send it, edit it or remove it", sendNow: busy ? "Send now: join the current turn, or run right after it" : "Send now: run it as a new turn" };
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

/** The first message "Send now" (mod+shift+enter in an empty composer) takes. */
export function firstSendable(modes: readonly (QueuedMode | undefined)[], busy: boolean): number {
    return modes.findIndex((m) => queueRow(m, busy).sendNow !== undefined);
}
