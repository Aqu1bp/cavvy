// The floating browser's size (FloatingBrowser.tsx). It's pinned at the conversation's top right, and its width sets
// the rest: the page in it keeps the agent's shape (1280×800), under the title bar and inside a thin frame.

/** The page's height for its width. */
export const PAGE_RATIO = 800 / 1280;
export const FLOAT_DEFAULT = 400;
export const FLOAT_MIN = 260;
/** The agent's page width: wider, the page would be drawn larger than it is. */
const PAGE_MOST = 1280;

/**
 * The room it has: the stage's width less its margins, and the height from its top to the composer's dock less a
 * margin. `chromeW` and `chromeH`: what isn't the page (the frame, and the title bar).
 */
export interface FloatRoom {
    w: number;
    h: number;
    chromeW: number;
    chromeH: number;
}

/** The widest it can be: inside its room (so clear of the composer), and no wider than the agent's page. */
export function floatMax(r: FloatRoom): number {
    return Math.min(r.w, r.chromeW + (r.h - r.chromeH) / PAGE_RATIO, r.chromeW + PAGE_MOST);
}

/** A width it takes: at most `max`, and at least FLOAT_MIN even where the room is smaller. */
export function clampFloat(width: number, max: number): number {
    return Math.round(Math.max(FLOAT_MIN, Math.min(width, max)));
}

/** The edges it's resized by: the free ones (the left, the bottom, and the corner between). */
export type FloatEdge = "left" | "bottom" | "corner";

/**
 * Its width while an edge is dragged, from `from` wide, by the pointer's travel since. The corner follows whichever way
 * the pointer went further out, as an edge would: the page's shape is kept either way.
 */
export function dragWidth(from: number, edge: FloatEdge, dx: number, dy: number): number {
    const byX = from - dx;
    const byY = from + dy / PAGE_RATIO;
    return edge === "left" ? byX : edge === "bottom" ? byY : Math.max(byX, byY);
}

/** The arrow keys on its resize handle: left and down grow it, right and up shrink it. */
export function keyWidth(width: number, key: string, step = 40): number | undefined {
    if (key === "ArrowLeft" || key === "ArrowDown") return width + step;
    if (key === "ArrowRight" || key === "ArrowUp") return width - step;
    return undefined;
}

/**
 * Whether it shows. Not when the agent has no tab of its own, it was closed, or the page shows elsewhere (the side
 * panel, Settings over the conversation). Then, once the person has used it (`kept`), until they close it; otherwise
 * while the agent's turn runs, a moment after (`lingering`) and while the pointer is on it, if the agent used the
 * browser in this turn.
 */
export function floatShown(o: { agentTab: boolean; closed: boolean; elsewhere: boolean; kept: boolean; busy: boolean; lingering: boolean; hovered: boolean; usedThisTurn: boolean }): boolean {
    if (!o.agentTab || o.closed || o.elsewhere) return false;
    return o.kept || ((o.busy || o.lingering || o.hovered) && o.usedThisTurn);
}

/** Its host, shown after the page's title (not when the title is the host). */
export function floatHost(url: string, title: string): string | undefined {
    try {
        const host = new URL(url).host;
        return host && host !== title ? host : undefined;
    } catch {
        return undefined;
    }
}
