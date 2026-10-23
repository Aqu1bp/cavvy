// The inspector's small rules, shared by its two contents: the side panel
// (RightPanel) and the diff reader (ReviewPane).

import type { GitFileDiff } from "@shared/protocol";
import { CONVERSATION_MIN } from "./layout";

export type Change = GitFileDiff["change"];

/** git status's letters, spelled out on hover. */
export const CHANGE: Record<Change, { letter: string; label: string }> = {
    added: { letter: "A", label: "Added" },
    modified: { letter: "M", label: "Modified" },
    deleted: { letter: "D", label: "Deleted" },
    untracked: { letter: "U", label: "Untracked" },
    renamed: { letter: "R", label: "Renamed" },
    typechange: { letter: "T", label: "Type changed" },
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
export type InspectorPane = "changes" | "agents" | "commands";

/** How the side panel's tabs give way as it narrows, roomiest first: labels with room around them; with tight
 *  padding; without the count of files (what runs stays); then icons, each tab's label kept as its name and tooltip. */
export const TAB_FITS = ["full", "tight", "lean", "icons"] as const;
export type TabFit = (typeof TAB_FITS)[number];

/** The roomiest fit in which no tab is cut. `cut` lays the tabs out at a fit and says whether any tab's content
 *  overflows it. Icons are the last step, so they aren't tried. */
export function fitTabs(cut: (fit: TabFit) => boolean): TabFit {
    for (const fit of TAB_FITS.slice(0, -1)) if (!cut(fit)) return fit;
    return TAB_FITS[TAB_FITS.length - 1]!;
}

/** A tab's accessible name: its label and what its marks say ("Agents, 4 running"), shown or not. */
export function tabName(label: string, ...marks: (string | false | undefined)[]): string {
    return [label, ...marks.filter(Boolean)].join(", ");
}
