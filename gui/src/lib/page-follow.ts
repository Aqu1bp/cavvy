// The desktop app's Browser page over the pane's page box. The page is a real one (BrowserHostLayer's <webview>),
// outside the page's own layout, so it's told where the box is: on every frame while the box may be moving
// (follow-box.ts), at the size lib/page-size.ts gives it. Loaded only where there's such a page (BrowserPane.tsx).

import { followBox, type Follow } from "./follow-box";
import { pageSizer } from "./page-size";
import { setShownBrowser, unshowBrowser } from "../state/browser-host";

interface Edges { left: number; top: number; right: number; bottom: number }
interface Size { width: number; height: number }

/**
 * Where the page goes, in whole pixels. `box`: its place and size, which is the pane's page box, down to 8px above a
 * dialog at the box's foot (`dialogTop`), and right of the panel's edge handle where the handle is over it (`handle`:
 * a page drawn over it would take the press that resizes the panel). `seen`: how much of that, from its top left,
 * shows (`within`: the inspector and the sheet, which cut what's in them as the panel slides open or shut; the page
 * isn't in them, and was drawn over the window's edge). The page is sized by `box`, however little of it shows:
 * sized by what shows, a panel opening gave it a sliver's width. Undefined when none of it shows.
 */
export function shownBox(box: Edges, o: { dialogTop?: number; handle?: Edges; within?: readonly Edges[] }): { box: { x: number; y: number } & Size; seen: Size } | undefined {
    const over = o.handle && o.handle.right > box.left && o.handle.left < box.right;
    const x = Math.round(over ? Math.max(box.left, o.handle!.right) : box.left);
    const y = Math.round(box.top);
    const width = Math.round(box.right) - x;
    const height = Math.round(o.dialogTop === undefined ? box.bottom : Math.max(box.top, o.dialogTop - 8)) - y;
    const within = o.within ?? [];
    const seen = {
        width: Math.min(width, ...within.map((w) => Math.round(w.right) - x)),
        height: Math.min(height, ...within.map((w) => Math.round(w.bottom) - y)),
    };
    const hidden = within.some((w) => w.left >= box.right || w.top >= box.bottom);
    return width > 0 && height > 0 && seen.width > 0 && seen.height > 0 && !hidden ? { box: { x, y, width, height }, seen } : undefined;
}

/** What the page is drawn in: no more of its box than shows (`seen`), nor than the page fills while it keeps another size. */
export function pageFrame(seen: Size, page: Size): Size {
    return { width: Math.min(seen.width, page.width), height: Math.min(seen.height, page.height) };
}

/**
 * Keeps the page over `box`. `target`: the tab's page to show, undefined while there's none to (no tab, the pane
 * hidden or covered); `sliding`: the panels are sliding. `kick` when either may have changed.
 */
export function followPage(box: HTMLElement, target: () => string | undefined, sliding: () => boolean): Follow {
    let placed = "";
    const sizer = pageSizer();
    const follow = followBox(box, () => {
        const targetId = target();
        const shown = targetId === undefined ? undefined : shownBox(box.getBoundingClientRect(), {
            dialogTop: box.querySelector(".br-dialog")?.getBoundingClientRect().top,
            handle: document.querySelector(".insp-resizer")?.getBoundingClientRect(),
            within: [box.closest(".insp"), box.closest(".sheet")].flatMap((el) => (el ? [el.getBoundingClientRect()] : [])),
        });
        if (!shown) {
            if (placed) unshowBrowser("pane");
            placed = "";
            sizer.reset();
            return;
        }
        const { box: at, seen } = shown;
        const page = sizer.frame(performance.now(), { width: at.width, height: at.height }, sliding());
        const frame = pageFrame(seen, page);
        const key = `${targetId} ${at.x} ${at.y} ${page.width} ${page.height} ${frame.width} ${frame.height}`;
        if (key === placed) return;
        placed = key;
        setShownBrowser({ targetId: targetId!, box: at, by: "pane", page, frame });
    });
    return {
        kick: follow.kick,
        stop() {
            follow.stop();
            if (placed) unshowBrowser("pane");
        },
    };
}
