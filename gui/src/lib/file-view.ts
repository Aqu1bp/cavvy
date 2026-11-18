// Opening a session's file from Go to file, Search in project and the file viewer: in the viewer (in the
// inspector column, where the diff reader goes), in the editor, or into the composer as an @-mention. Loaded with them.

import { setReview } from "../state/ui";
import { os } from "./platform";

/** The file viewer on `path` (relative to the session's folder), at `line`. */
export function viewFile(path: string, line?: number) {
    setReview({ file: { path, ...(line ? { line } : {}) } });
}

/** "@path", quoted when it has a space, as the composer's @ menu writes it. */
export const mentionOf = (rel: string) => `@${/\s/.test(rel) ? `"${rel}"` : rel}`;

/**
 * The file as an @-mention at the end of what's in the input of the session on screen (the focused one in a split),
 * as if typed there: the input takes it as it takes typing (and Undo takes it back). False when there's no input.
 */
export function addToChat(rel: string): boolean {
    const ta = document.querySelector<HTMLTextAreaElement>('.stage-pane:not([data-focused="off"]):not([data-parked]) .composer-field textarea');
    if (!ta) return false;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const text = `${/\S$/.test(ta.value) ? " " : ""}${mentionOf(rel)} `;
    if (!document.execCommand("insertText", false, text)) {
        ta.value += text;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
}

/** "path:12" (or "path:12:3"): the path and the line typed after it. */
export function withLine(query: string): { query: string; line?: number } {
    const m = query.match(/^(.*?):(\d+)(?::\d+)?$/);
    return m && m[1] ? { query: m[1], line: Number(m[2]) || undefined } : { query };
}

/** The names of the keys the finder's rows take, for its footer. */
export const altKey = os === "macos" ? "⌥" : "Alt+";
