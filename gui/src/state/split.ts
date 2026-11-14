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
