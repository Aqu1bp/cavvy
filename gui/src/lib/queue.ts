// What the "Up next" tray says about each message sent while a turn runs,
// what it lets you do with it, and where a move puts it. Pure, so the rules
// are tested without a browser.

import type { FollowUpMode, QueuedMode } from "@shared/protocol";

/**
 * What Enter does mid-turn: the setting, or (mod+shift+enter, mod-click) the other one. `steers` false: the running
 * model takes nothing mid-turn (ModelSummary.steers), so a message is queued whichever way it's sent.
 */
export function followUpFor(setting: FollowUpMode | null | undefined, opposite: boolean, steers = true): FollowUpMode {
    if (!steers) return "queue";
    const base: FollowUpMode = setting === "queue" ? "queue" : "steer";
    return opposite ? (base === "steer" ? "queue" : "steer") : base;
}

export const otherFollowUp = (m: FollowUpMode): FollowUpMode => (m === "steer" ? "queue" : "steer");

/** Each way, in a few words: what the send button's hint says of it. */
export const FOLLOW_UP_WORDS: Record<FollowUpMode, string> = { steer: "Steer: joins this turn at its next step", queue: "Queue: runs after this turn" };

/** A key as words read it: macOS's symbols run together (⌘⇧Enter), others keep their + (Ctrl+Shift+Enter). */
const keyText = (k: string) => (/[⌘⌥⇧⌃]/.test(k) ? k.replaceAll("+", "") : k);

/**
 * What the composer says while a turn runs: its placeholder, in a few words, what sending does now; the send button's
 * description, the keys: what Enter (`send`) does and what the other key (`other`, unbound: none) does. Where the
 * model can't be steered (`steers` false), both queue, and the description says why (`who`: the model's or CLI's name).
 */
export function followUpLabels(o: { mode: FollowUpMode; steers: boolean; send: string; other?: string; click: string; who?: string }): { placeholder: string; title: string } {
    const send = keyText(o.send);
    if (!o.steers) {
        const why = `${o.who ?? "This model"} can't take messages mid-turn`;
        return { placeholder: "Queue for after this turn…", title: `${FOLLOW_UP_WORDS.queue} (${send}). ${why}.` };
    }
    const other = otherFollowUp(o.mode);
    const otherKey = o.other ? keyText(o.other) : undefined;
    return {
        placeholder: o.mode === "steer" ? "Steer this turn…" : "Queue for after this turn…",
        title: `${FOLLOW_UP_WORDS[o.mode]} (${send}). ${o.click}${otherKey ? ` or ${otherKey}` : ""} to ${other} instead.`,
    };
}

/**
 * The box once the server hands text back (`back`): before what's typed (an interrupted queue, a rewound prompt), or
 * `after` it, a blank line between (a steer the turn never took). What's typed always stays.
 */
export function withDraft(typed: string, back: string, after = false): string {
    if (!typed.trim()) return back;
    return after ? `${typed.trimEnd()}\n\n${back}` : `${back}\n${typed}`;
}

/**
 * A steer handed back (withDraft's `after`) waits: while a message is being sent (it would change the box under that
 * send, which then can't clear what it sent), and while the box holds a command (`/` or `!`), which would take it as
 * its arguments or its shell input. It goes in once neither holds.
 */
export function restoreWaits(typed: string, sending: boolean): boolean {
    return sending || /^\s*[/!]/.test(typed);
}

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
                detail: why || "Not sent before Cavvy restarted. It waits for you: send it, edit it or remove it",
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
