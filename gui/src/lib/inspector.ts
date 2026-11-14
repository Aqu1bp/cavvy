// The inspector's small rules, shared by its two contents: the side panel
// (RightPanel) and the diff reader (ReviewPane).

import type { GitFileDiff } from "@shared/protocol";
import { CONVERSATION_MIN } from "./layout";

export type Change = GitFileDiff["change"];

/** A quiet word after a file's name for what's unusual about its change. A modified file, most of them, has none. */
export const CHANGE_WORD: Record<Change, string | undefined> = {
    added: "new",
    untracked: "new",
    modified: undefined,
    deleted: "deleted",
    renamed: "renamed",
    typechange: "type changed",
};

/** "gui/src/lib/" for "gui/src/lib/a.ts"; "" at the top. */
export const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "");
export const nameOf = (path: string) => path.split("/").pop() ?? path;

/** The diff reader's own width (its left edge's handle), within these. */
export const REVIEW_MIN = 420;
export const REVIEW_MAX = 1200;
/** What a double-click on the handle goes back to. */
export const REVIEW_DEFAULT = 720;
/** One arrow-key press on the handle. */
export const REVIEW_STEP = 24;

/**
 * Dragging the reader's left edge `dx` pixels (right is positive) from where it was when the drag
 * began. It starts from the width the reader is shown at, which the layout may have widened past
 * (or capped below) the saved width, so the edge moves with the pointer from the first pixel.
 */
export function reviewDragWidth(shown: number, dx: number): number {
    return Math.round(Math.max(REVIEW_MIN, Math.min(REVIEW_MAX, shown - dx)));
}

/**
 * The handle's range, for assistive tech: from its least width to the most the layout lets it
 * dock at (the conversation keeps CONVERSATION_MIN), widened to take in the width shown.
 */
export function reviewWidthRange(shown: number, sheetWidth: number): { min: number; max: number } {
    return { min: Math.min(REVIEW_MIN, shown), max: Math.max(shown, Math.min(REVIEW_MAX, sheetWidth - CONVERSATION_MIN)) };
}

/** The side panel's tabs. */
export type InspectorPane = "changes" | "agents" | "commands" | "browser" | "simulator";

/** A tab's accessible name: its label and what its marks say ("Agents, 4 running"), shown or not. */
export function tabName(label: string, ...marks: (string | false | undefined)[]): string {
    return [label, ...marks.filter(Boolean)].join(", ");
}
