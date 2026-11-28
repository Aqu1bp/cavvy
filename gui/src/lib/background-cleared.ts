// Rows cleared from the side panel's Finished folds (BackgroundTasks.tsx), and the tabs' rows without them, for the
// panel's counts (RightPanel.tsx) as well as its lists: apart from the lists, which load with the panes.

import { createSignal } from "solid-js";
import { clearKey, rowLive, type WorkRow } from "./background";

/** Rows cleared from a session's Finished folds, by clearKey: the server keeps no list of sub-agents to clear. */
export const [cleared, setCleared] = createSignal<Record<string, readonly string[]>>({});

/** A tab's rows without those cleared from its fold (running ones always show). */
export function uncleared(sessionId: string, rows: WorkRow[]): WorkRow[] {
    const gone = new Set(cleared()[sessionId] ?? []);
    return gone.size ? rows.filter((r) => rowLive(r) || !gone.has(clearKey(r))) : rows;
}
