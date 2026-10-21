// The window's responsive rules (design/glass, app.js `layout()` and `fitFloat()`), as pure
// functions of the window's size. The shell (App.tsx) feeds them and applies the result.
//
// The window: the rail on the glass at the left, then one sheet inset 8px from the window's
// edges. The sheet holds the conversation, the inspector beside it, and the terminal under both.

/** The rail docks beside the sheet from this window width; narrower, it's a drawer over it. */
export const RAIL_DOCK_MIN = 900;
/** The sheet's inset from the window's edges (and from the rail). */
export const WINDOW_PAD = 8;
/** A docked inspector leaves the conversation at least this wide; otherwise it floats over it. */
export const CONVERSATION_MIN = 480;
/** A floating inspector's top, clear of the title bar, and its gap to what's under it. */
export const FLOAT_TOP = 54;
export const FLOAT_GAP = 8;
/** A floating inspector shorter than this above the dock takes the full height instead. */
export const FLOAT_MIN = 260;
/** The terminal's height: at least this, and the conversation keeps `TERMINAL_KEEP` above it. */
export const TERMINAL_MIN = 120;
export const TERMINAL_KEEP = 300;
/** The inspector's width (its resizer). */
export const INSPECTOR_MIN = 280;
export const INSPECTOR_MAX = 620;
export const INSPECTOR_DEFAULT = 360;

export type RailMode = "dock" | "overlay";
export type InspectorMode = "dock" | "float";
export interface Size { w: number; h: number }

export function railMode(windowWidth: number): RailMode {
    return windowWidth >= RAIL_DOCK_MIN ? "dock" : "overlay";
}

/** The sheet's size: the window less its inset, and less the rail when the rail is docked and showing. */
export function sheetSize(win: Size, railDocked: boolean, railWidth: number): Size {
    return {
        w: Math.max(0, win.w - WINDOW_PAD - (railDocked ? railWidth : WINDOW_PAD)),
        h: Math.max(0, win.h - 2 * WINDOW_PAD),
    };
}

/**
 * The diff reader widens the inspector: to 55% of the sheet (68% side by side), up to 860px
 * (1120px side by side), and never narrower than the width the reader was given (`base`).
 */
export function reviewWidth(base: number, sheetWidth: number, split: boolean): number {
    const cap = split ? 1120 : 860;
    const share = Math.round(sheetWidth * (split ? 0.68 : 0.55));
    return Math.max(base, Math.min(cap, share));
}

/** The inspector docks while the conversation keeps `CONVERSATION_MIN` beside it. */
export function inspectorMode(sheetWidth: number, inspectorWidth: number): InspectorMode {
    return sheetWidth - inspectorWidth >= CONVERSATION_MIN ? "dock" : "float";
}

/** Dragging the docked inspector's edge: within its bounds, and never so wide it stops docking. */
export function clampInspectorWidth(width: number, sheetWidth: number): number {
    const most = Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, sheetWidth - CONVERSATION_MIN));
    return Math.round(Math.max(INSPECTOR_MIN, Math.min(most, width)));
}

/** The terminal's row: the preferred height within its bounds; maximized, the whole sheet. */
export function terminalHeight(preferred: number, sheetHeight: number, maximized: boolean): number {
    if (maximized) return sheetHeight;
    return Math.round(Math.max(TERMINAL_MIN, Math.min(preferred, sheetHeight - TERMINAL_KEEP)));
}

/** The tallest the terminal can be dragged to (and what a drag stores). */
export function clampTerminalHeight(height: number, sheetHeight: number): number {
    return Math.round(Math.max(TERMINAL_MIN, Math.min(height, Math.max(TERMINAL_MIN, sheetHeight - TERMINAL_KEEP))));
}

/**
 * A floating inspector ends above the composer and any request card (`dock`: their height),
 * so it never hides them. When that leaves it shorter than `FLOAT_MIN`, it's "short": it takes
 * the full height instead.
 */
export function floatShort(sheetHeight: number, terminal: number, dock: number): boolean {
    return sheetHeight - terminal - FLOAT_TOP - dock - FLOAT_GAP < FLOAT_MIN;
}

/** Where a floating inspector's bottom edge is, from the sheet's bottom. */
export function floatBottom(terminal: number, dock: number, short: boolean): number {
    return terminal + (short ? 0 : dock) + FLOAT_GAP;
}

/**
 * Shrinking the window past the point where the inspector fits closes it, like a Mac inspector;
 * opening it again on a narrow window floats it. The diff reader stays open (it floats).
 */
export function closesOnShrink(from: InspectorMode | undefined, to: InspectorMode, open: boolean, reviewing: boolean): boolean {
    return from === "dock" && to === "float" && open && !reviewing;
}

/**
 * A request arriving closes a short floating inspector, which would cover it. Once per request:
 * `request` is a key for the requests showing (none: undefined), `cleared` the one already dealt
 * with. The inspector opened while a request shows stays open for it, and so does one opened
 * again after it closed for it. Returns whether to close it now, and what's dealt with next time.
 */
export function requestCloses(cleared: string | undefined, wasOpen: boolean, o: { request?: string; mode: InspectorMode; short: boolean; open: boolean }): { close: boolean; cleared?: string } {
    if (o.open && !wasOpen) cleared = o.request;
    if (o.request && o.request !== cleared && o.mode === "float" && o.short && o.open) return { close: true, cleared: o.request };
    return { close: false, cleared };
}

/** The whole layout for one window size and state; what the shell draws. */
export interface WindowLayout {
    railMode: RailMode;
    /** The rail is showing: docked and turned on, or the drawer is open. */
    railShown: boolean;
    sheet: Size;
    inspector: { open: boolean; mode: InspectorMode; width: number; short: boolean; bottom: number };
    terminal: { shown: boolean; height: number; maximized: boolean; most: number };
}

export function windowLayout(o: {
    win: Size;
    /** The rail (sidebar) preference: on, docked. */
    rail: boolean;
    railOpen: boolean;
    railWidth: number;
    panel: boolean;
    review: boolean;
    split: boolean;
    reviewBase: number;
    inspectorWidth: number;
    terminalShown: boolean;
    terminalPreferred: number;
    terminalMax: boolean;
    dock: number;
}): WindowLayout {
    const mode = railMode(o.win.w);
    const docked = mode === "dock" && o.rail;
    const sheet = sheetSize(o.win, docked, o.railWidth);
    const width = o.review ? reviewWidth(o.reviewBase, sheet.w, o.split) : Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, o.inspectorWidth));
    const term = o.terminalShown ? terminalHeight(o.terminalPreferred, sheet.h, o.terminalMax) : 0;
    const short = floatShort(sheet.h, term, o.dock);
    return {
        railMode: mode,
        railShown: mode === "dock" ? o.rail : o.railOpen,
        sheet,
        inspector: { open: o.panel || o.review, mode: inspectorMode(sheet.w, width), width, short, bottom: floatBottom(term, o.dock, short) },
        terminal: { shown: o.terminalShown, height: term, maximized: o.terminalShown && o.terminalMax, most: Math.max(TERMINAL_MIN, sheet.h - TERMINAL_KEEP) },
    };
}
