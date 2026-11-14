import { createSignal } from "solid-js";

/** Original on the left, most recently dropped on the right. */
export const [splitSessions, setSplitSessions] = createSignal<readonly [string, string]>();
export const SESSION_DRAG = "application/x-cavvy-session";
export function dragSession(event: DragEvent, id: string) {
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(SESSION_DRAG, id);
}
export { splitPair } from "../lib/session-split";

const RATIO_KEY = "cavvy.splitRatio";
function loadRatio(): number {
    try {
        const value = Number(localStorage.getItem(RATIO_KEY));
        if (value > 0 && value < 1) return value;
    } catch { /* Storage is optional. */ }
    return 0.5;
}
export const [splitRatio, setSplitRatio] = createSignal(loadRatio());
export function saveSplitRatio() {
    try { localStorage.setItem(RATIO_KEY, String(splitRatio())); } catch { /* Keep it for this window. */ }
}
