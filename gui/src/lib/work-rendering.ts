// Keep tool rows and Markdown blocks mounted (folds, find, selection and accessibility still work), but let the
// browser skip the layout and paint of distant work. Measure each row before it can be skipped:
// guessed heights in a long running turn move the end while the reader is clicking or scrolling.

const ROW = ".worklog > :not(.steps), .steps > *, .reply > .md > *";
const TRACKED = "data-work-row";
const FAR = "data-work-far";
/** A turn a screen or more from the view (Transcript.tsx): its rows skip their layout with it, so they aren't watched. */
const TURN_FAR = "data-far";
const MIN_ROWS = 80;

type Callbacks = {
    intersections?: IntersectionObserverCallback;
    sizes?: ResizeObserverCallback;
    mutations?: MutationCallback;
};
// WebKit can retain observer callbacks after disconnect. They hold only this cleared relay,
// not the transcript, its DOM, or a session's history.
const intersections = (to: Callbacks): IntersectionObserverCallback => (entries, observer) => to.intersections?.(entries, observer);
const sizes = (to: Callbacks): ResizeObserverCallback => (entries, observer) => to.sizes?.(entries, observer);
const mutations = (to: Callbacks): MutationCallback => (entries, observer) => to.mutations?.(entries, observer);

/**
 * `shift`: compensate height changes above the reader when skipped rows become visible again. `parkFar`: whether rows of
 * turns far from the view are let go of (below).
 */
export function observeWorkRendering(root: HTMLElement, content: HTMLElement, shift: (pixels: number) => void, parkFar: () => boolean = () => true) {
    if (typeof IntersectionObserver === "undefined" || typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return () => {};
    const rows = new Map<HTMLElement, { near: boolean; height?: number; intrinsic: string; parkedFar?: boolean }>();
    const to: Callbacks = {};
    let io: IntersectionObserver | undefined;
    let ro: ResizeObserver | undefined;
    // With many turns drawn, only rows in turns near the view are watched or skipped on their own: what they cost each
    // frame (our observers, and the browser's for each skipped box) goes with what's near, not with how much of the
    // conversation is drawn. With few, it's little, and letting them go as a session opens would cost the opening.
    let parking = false;
    const parked = (el: HTMLElement) => parking && !!el.closest(`[${TURN_FAR}]`);
    const watch = (el: HTMLElement) => { io?.observe(el); ro?.observe(el); };
    const unwatch = (el: HTMLElement) => { io?.unobserve(el); ro?.unobserve(el); };
    /** Its turn gone far: the turn skips it. Skipped on its own before, it is again as the turn comes near, at its size. */
    const park = (el: HTMLElement) => {
        unwatch(el);
        const row = rows.get(el);
        if (!row || !el.hasAttribute(FAR)) return;
        el.removeAttribute(FAR);
        row.parkedFar = true;
    };
    const wake = (el: HTMLElement) => {
        const row = rows.get(el);
        if (row?.parkedFar) el.setAttribute(FAR, "");
        if (row) row.parkedFar = false;
        watch(el);
    };
    const skip = (el: HTMLElement) => {
        const row = rows.get(el);
        if (!row || row.near || row.height === undefined || row.height <= 0 || el.hasAttribute(FAR)) return;
        // Content-box size: padding and borders remain the element's own. `auto` remembers later
        // natural sizes too. It also lets native find, focus and selection reveal skipped content.
        el.style.containIntrinsicBlockSize = `auto ${row.height}px`;
        el.setAttribute(FAR, "");
    };
    const start = () => {
        if (io || rows.size < MIN_ROWS) return;
        to.sizes = (entries) => {
            for (const entry of entries) {
                const el = entry.target as HTMLElement;
                const row = rows.get(el);
                // A skipped box reports its placeholder, not its new natural height.
                if (!row || el.hasAttribute(FAR)) continue;
                row.height = entry.contentRect.height;
                el.setAttribute(TRACKED, row.height > 0 ? "sized" : "");
                skip(el);
            }
        };
        to.intersections = (entries) => {
            const top = root.getBoundingClientRect().top;
            const above: { el: HTMLElement; height: number }[] = [];
            // Read, then write, then read: at most one layout for the batch of newly near rows.
            for (const entry of entries) {
                const el = entry.target as HTMLElement;
                if (entry.isIntersecting && rows.has(el) && el.hasAttribute(FAR)) {
                    const box = el.getBoundingClientRect();
                    if (box.bottom <= top) above.push({ el, height: box.height });
                }
            }
            for (const entry of entries) {
                const el = entry.target as HTMLElement;
                const row = rows.get(el);
                if (!row) continue;
                row.near = entry.isIntersecting;
                if (row.near) el.removeAttribute(FAR);
                else skip(el);
            }
            const moved = above.reduce((sum, { el, height }) => sum + el.getBoundingClientRect().height - height, 0);
            if (Math.abs(moved) > 0.5) shift(moved);
        };
        io = new IntersectionObserver(intersections(to), { root, rootMargin: "100% 0px" });
        ro = new ResizeObserver(sizes(to));
        for (const el of rows.keys()) if (!parked(el)) watch(el);
    };
    const add = (el: HTMLElement) => {
        if (rows.has(el) || !el.matches(ROW) || el.parentElement?.closest(ROW)) return;
        rows.set(el, { near: true, intrinsic: el.style.containIntrinsicBlockSize });
        el.setAttribute(TRACKED, "");
        if (!parked(el)) watch(el);
    };
    const collect = (node: Node) => {
        // MutationObserver can deliver changes made inside a removed subtree in the same
        // batch as its removal. Do not register those detached descendants again.
        if (node.nodeType !== 1 || !content.contains(node)) return;
        const el = node as HTMLElement;
        // Highlighted output can replace thousands of spans inside a row. Its outer box is
        // already observed; descendants cannot be independent regions, so do not rescan them.
        if (el.parentElement?.closest(ROW)) return;
        add(el);
        if (rows.has(el)) return;
        for (const child of el.querySelectorAll<HTMLElement>(ROW)) add(child);
    };
    const remove = (el: HTMLElement) => {
        const row = rows.get(el);
        if (!row) return;
        unwatch(el);
        el.removeAttribute(TRACKED);
        el.removeAttribute(FAR);
        el.style.containIntrinsicBlockSize = row.intrinsic;
        rows.delete(el);
    };
    to.mutations = (records) => {
        for (const record of records) {
            // A turn gone far or come near: its rows' watch stops, or starts again (each told at once where it is).
            if (record.type === "attributes") {
                const turn = record.target as HTMLElement;
                if (!io || !parking || !content.contains(turn)) continue;
                const far = turn.hasAttribute(TURN_FAR);
                for (const el of turn.querySelectorAll<HTMLElement>(`[${TRACKED}]`)) if (rows.has(el)) (far ? park : wake)(el);
                continue;
            }
            for (const node of record.removedNodes) {
                if (node.nodeType !== 1 || content.contains(node)) continue;
                const el = node as HTMLElement;
                for (const child of el.querySelectorAll<HTMLElement>(`[${TRACKED}]`)) remove(child);
                remove(el);
            }
            for (const node of record.addedNodes) collect(node);
        }
        start();
        sync();
    };
    /** Rows of the turns already far let go of, or taken back, as `parkFar` changes (turns going in or out). */
    const sync = () => {
        const want = !!io && parkFar();
        if (want === parking) return;
        parking = want;
        for (const turn of content.querySelectorAll<HTMLElement>(`[${TURN_FAR}]`)) {
            for (const el of turn.querySelectorAll<HTMLElement>(`[${TRACKED}]`)) if (rows.has(el)) (want ? park : wake)(el);
        }
    };
    collect(content);
    start();
    sync();
    const mo = new MutationObserver(mutations(to));
    mo.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: [TURN_FAR] });
    return () => {
        io?.disconnect();
        ro?.disconnect();
        mo.disconnect();
        to.intersections = to.sizes = to.mutations = undefined;
        for (const el of rows.keys()) remove(el);
    };
}
