// What the "Up next" tray says about each message sent while a turn runs,
// what it lets you do with it, and where a move puts it. Pure, so the rules
// are tested without a browser.

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

/** A row of the queue, by what the message will do and whether a turn is running; `why` it can't join a running turn, from the server. */
export function queueRow(mode: QueuedMode | undefined, busy: boolean, why?: string): QueueRowInfo {
    switch (mode ?? "steer") {
        case "steer":
            return { hint: "Next step", detail: JOINS, joining: busy };
        case "queue":
            return { hint: "After this turn", detail: "Runs as a turn of its own once this one ends, or at once while the turn only waits on background work", action: busy ? STEER : SEND_NOW };
        case "turn":
            return { hint: "After this turn", detail: why || "Commands, and attachments this model can't take in a running turn, don't join it: this runs once it ends. While the turn only waits on background work, images and files go at once; commands run after the background work ends", ...(busy ? {} : { action: SEND_NOW }) };
        case "held":
            return {
                hint: "Held",
                // Held for an account (the session's was removed, #410): the server says so.
                detail: why || "Not sent before Harness restarted. It waits for you: send it, edit it or remove it",
                action: busy ? { label: "Steer", title: "Add to the current turn at its next step (a command runs right after the turn)" } : { label: "Send now", title: "Send now: run it as a new turn" },
            };
    }
}

/** Where ↑/↓ moves the message at `from` (undefined: it's already at that end). */
export function stepTarget(from: number, key: "up" | "down", length: number): number | undefined {
    const to = key === "up" ? from - 1 : from + 1;
    return to < 0 || to >= length ? undefined : to;
}

/** How far a held row follows the pointer (`dy` from where it was picked up): within the list, and `give` past its ends. */
export function clampDrag(from: number, dy: number, pitch: number, length: number, give = 6): number {
    return Math.max(-from * pitch - give, Math.min((length - 1 - from) * pitch + give, dy));
}

/** The slot a row held `dy` from its own place (rows `pitch` apart) would drop into: the nearest one in the list. */
export function dragTarget(from: number, dy: number, pitch: number, length: number): number {
    if (pitch <= 0 || length < 1) return from;
    return Math.max(0, Math.min(length - 1, Math.round(from + dy / pitch)));
}

/**
 * Where row `i` shows while the row at `from` is held over `to`: the held one at `to`, the
 * ones between them one place over (out of its way), the rest where they are. Its number is this + 1.
 */
export function slotOf(i: number, from: number, to: number): number {
    if (i === from) return to;
    if (from < to && i > from && i <= to) return i - 1;
    if (from > to && i < from && i >= to) return i + 1;
    return i;
}

/** The list with the item at `from` moved to `to`: the order the server makes of that move (runtime moveQueued). */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
    if (from < 0 || from >= list.length) return list.slice();
    const next = list.slice();
    const [item] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(next.length, Math.trunc(to))), 0, item as T);
    return next;
}

/** What a screen reader hears once a message has moved. */
export const movedAnnouncement = (to: number, length: number) => `Moved to position ${to + 1} of ${length}`;

/** How long a dropped row takes to settle into its slot (a CSS time, from --dur-settle): none when motion is reduced. */
export function settleMs(cssTime: string, reducedMotion: boolean): number {
    if (reducedMotion) return 0;
    const v = cssTime.trim();
    const n = parseFloat(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return v.endsWith("ms") ? n : v.endsWith("s") ? n * 1000 : n;
}

/** The row with the small pulse by its hint (on its way in): the first steer while a turn runs, -1 for none. */
export function joiningRow(modes: readonly (QueuedMode | undefined)[], busy: boolean): number {
    return modes.findIndex((m) => queueRow(m, busy).joining);
}

/** The first message its button (Steer, or Send now) applies to: what mod+shift+enter in an empty composer takes. */
export function firstSendable(modes: readonly (QueuedMode | undefined)[], busy: boolean): number {
    return modes.findIndex((m) => queueRow(m, busy).action !== undefined);
}
