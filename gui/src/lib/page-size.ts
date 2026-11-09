// The size of the desktop app's Browser page, frame by frame, as its box in the pane changes size.
//
// The page is a real one (BrowserHostLayer's <webview>), and each time it's given a new size the window's own next
// frame waits for the page to draw at it. So the page doesn't simply take its box's size on every frame:
// - While the panels slide (a panel opening or closing) it keeps the size it has, and takes the box's once the slide
//   is over: one resize, when nothing is moving for it to hold up.
// - While an edge is dragged or the window resized it follows the box, as long as it keeps up. A page that doesn't
//   (frames come late after it's resized) keeps its size until the box has stopped changing, then takes the box's.
// Meanwhile the page moves with the box, cut to it where the box is smaller (BrowserHostLayer).

import type { Size } from "./browser";

/** A frame this long after the page was resized is the page holding the window up (a frame is 8 to 17ms). */
export const LAG_FRAME_MS = 40;
/** This many of them while the box goes on changing, and the page stops following it. */
export const LAG_FRAMES = 2;
/** The box unchanged for this long has stopped changing: a page that was lagging takes its size. */
export const SETTLE_MS = 150;

export interface PageSizer {
    /** The page's size for this frame: `box` is the pane's page box now, `sliding` whether the panels are sliding. */
    frame(now: number, box: Size, sliding: boolean): Size;
    /** Nothing is shown: the next frame starts afresh. */
    reset(): void;
}

const same = (a: Size, b: Size) => a.width === b.width && a.height === b.height;

export function pageSizer(): PageSizer {
    let size: Size | undefined;
    let box: Size | undefined;
    let boxChangedAt = -Infinity;
    let frameAt = -Infinity;
    /** The last frame gave the page a new size (not its first). */
    let resized = false;
    let late = 0;
    let lagging = false;
    return {
        frame(now, next, sliding) {
            if (resized && now - frameAt > LAG_FRAME_MS && ++late >= LAG_FRAMES) lagging = true;
            if (!box || !same(box, next)) boxChangedAt = now;
            else if (now - boxChangedAt > SETTLE_MS) {
                lagging = false;
                late = 0;
            }
            box = next;
            const to = size && (sliding || lagging) ? size : next;
            resized = size !== undefined && !same(size, to);
            size = to;
            frameAt = now;
            return to;
        },
        reset() {
            size = box = undefined;
            resized = lagging = false;
            late = 0;
        },
    };
}
