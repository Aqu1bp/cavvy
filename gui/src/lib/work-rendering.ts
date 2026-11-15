// Keep tool rows and Markdown blocks mounted (folds, find, selection and accessibility still work), but let the
// browser skip the layout and paint of distant work. Measure each row before it can be skipped:
// guessed heights in a long running turn move the end while the reader is clicking or scrolling.

import { finishEntrancesIn } from "./entrances";
import { settlingObserver, type SettlingObserver } from "./settling-observer";

const ROW = ".worklog > :not(.steps), .steps > *, .reply > .md > *";
const TRACKED = "data-work-row";
const FAR = "data-work-far";
/**
 * Put in again at a remembered size (shown before): what it brings in (a step rising in) came in long ago, so it starts
 * already over (transcript.css). Taken off a while after the row is first drawn, when what it brought in would be over
 * anyway: what plays later (an output opened) plays as it would.
 */
const AGAIN = "data-work-again";
const AGAIN_MS = 2000;
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
 * The rows' sizes of the conversations shown lately, by session: put in again (switched back to), each row is skipped at
 * once at the size it was, rather than all of them laid out before the first frame (a session ending in a 60 KB reply:
 * that reply whole, every switch). Its own turn and place in it say which row is which.
 */
const remembered = new Map<string, Map<string, number>>();
const REMEMBERED = 8;
const turnOf = (el: HTMLElement) => el.closest<HTMLElement>("[data-turn]")?.dataset.turn;

/**
 * `shift`: compensate height changes above the reader when skipped rows become visible again. `parkFar`: whether rows of
 * turns far from the view are let go of (below). `session`: whose conversation it is, so its rows' sizes are kept for
 * the next time it's shown.
 */
export function observeWorkRendering(root: HTMLElement, content: HTMLElement, shift: (pixels: number) => void, parkFar: () => boolean = () => true, session?: string) {
    if (typeof IntersectionObserver === "undefined" || typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return () => {};
    const rows = new Map<HTMLElement, { near: boolean; height?: number; intrinsic: string; parkedFar?: boolean }>();
    const to: Callbacks = {};
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let io: SettlingObserver | undefined;
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
    const skippable = (el: HTMLElement) => {
        const row = rows.get(el);
        return !(!row || row.near || row.height === undefined || row.height <= 0 || el.hasAttribute(FAR));
    };
    /** Skipped from here, those of `els` that can be: all their entrances ended first, then all marked (one style pass). */
    const skip = (els: HTMLElement[]) => {
        const going = els.filter(skippable);
        // What they were still bringing in is over now, not left part way (lib/entrances.ts).
        finishEntrancesIn(going);
        for (const el of going) {
            // Content-box size: padding and borders remain the element's own. `auto` remembers later
            // natural sizes too. It also lets native find, focus and selection reveal skipped content.
            el.style.containIntrinsicBlockSize = `auto ${rows.get(el)!.height}px`;
            el.setAttribute(FAR, "");
        }
    };
    const start = () => {
        if (io || rows.size < MIN_ROWS) return;
        to.sizes = (entries) => {
            io?.wake();
            const sized: HTMLElement[] = [];
            for (const entry of entries) {
                const el = entry.target as HTMLElement;
                const row = rows.get(el);
                // A skipped box reports its placeholder, not its new natural height.
                if (!row || el.hasAttribute(FAR)) continue;
                row.height = entry.contentRect.height;
                sized.push(el);
            }
            skip(sized);
            for (const el of sized) el.setAttribute(TRACKED, rows.get(el)!.height! > 0 ? "sized" : "");
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
            const going: HTMLElement[] = [];
            for (const entry of entries) {
                const el = entry.target as HTMLElement;
                const row = rows.get(el);
                if (!row) continue;
                row.near = entry.isIntersecting;
                if (!row.near) going.push(el);
            }
            skip(going);
            const drawn: HTMLElement[] = [];
            for (const entry of entries) {
                const el = entry.target as HTMLElement;
                if (!rows.get(el)?.near) continue;
                el.removeAttribute(FAR);
                if (el.hasAttribute(AGAIN)) drawn.push(el);
            }
            if (drawn.length) {
                const t = setTimeout(() => {
                    timers.delete(t);
                    for (const el of drawn) el.removeAttribute(AGAIN);
                }, AGAIN_MS);
                timers.add(t);
            }
            const moved = above.reduce((sum, { el, height }) => sum + el.getBoundingClientRect().height - height, 0);
            if (Math.abs(moved) > 0.5) shift(moved);
        };
        // Let go of while nothing scrolls or changes size (lib/settling-observer.ts); a row changing size wakes it (sizes).
        io = settlingObserver(intersections(to), { root, rootMargin: "100% 0px" }, [content]);
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
        el.removeAttribute(AGAIN);
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
    // Shown before: its rows skipped at the sizes they were, before anything's laid out (those in view are drawn
    // anyway, and taken as near as soon as they're seen).
    const sizesWere = session !== undefined ? remembered.get(session) : undefined;
    if (sizesWere && rows.size >= MIN_ROWS) {
        // Only a turn with as many rows as it had then: one that changed meanwhile (it went on, its work folded) would
        // have each row after the change take another's size.
        const count = new Map<string, number>();
        for (const el of rows.keys()) {
            const turn = turnOf(el);
            if (turn !== undefined) count.set(turn, (count.get(turn) ?? 0) + 1);
        }
        const nth = new Map<string, number>();
        const known: [HTMLElement, NonNullable<ReturnType<typeof rows.get>>, number][] = [];
        for (const [el, row] of rows) {
            const turn = turnOf(el);
            if (turn === undefined || sizesWere.get(`${turn}#`) !== count.get(turn)) continue;
            const i = nth.get(turn) ?? 0;
            nth.set(turn, i + 1);
            const h = sizesWere.get(`${turn}:${i}`);
            if (h !== undefined && h > 0) known.push([el, row, h]);
        }
        // Not the last two screens of them: shown again at its end, those are in sight, drawn in its first frame as
        // they were (its entrances ended there: Transcript).
        let tail = typeof window === "undefined" ? 0 : 2 * window.innerHeight;
        while (known.length && tail > 0) tail -= known.pop()![2];
        for (const [el, row, h] of known) {
            row.height = h;
            row.near = false;
            el.setAttribute(AGAIN, "");
            el.style.containIntrinsicBlockSize = `auto ${h}px`;
            el.setAttribute(TRACKED, "sized");
            el.setAttribute(FAR, "");
        }
    }
    start();
    sync();
    const mo = new MutationObserver(mutations(to));
    mo.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: [TURN_FAR] });
    return () => {
        io?.disconnect();
        ro?.disconnect();
        mo.disconnect();
        to.intersections = to.sizes = to.mutations = undefined;
        for (const t of timers) clearTimeout(t);
        // Its rows' sizes, for the next time it's shown (in their order in each turn, as they're found then).
        if (session !== undefined) {
            const sizes = new Map<string, number>();
            const nth = new Map<string, number>();
            for (const el of content.querySelectorAll<HTMLElement>(`[${TRACKED}]`)) {
                const turn = turnOf(el);
                if (turn === undefined || !rows.has(el)) continue;
                const i = nth.get(turn) ?? 0;
                nth.set(turn, i + 1);
                const h = rows.get(el)!.height;
                if (h !== undefined && h > 0) sizes.set(`${turn}:${i}`, h);
            }
            for (const [turn, n] of nth) sizes.set(`${turn}#`, n);
            remembered.delete(session);
            if (sizes.size) remembered.set(session, sizes);
            while (remembered.size > REMEMBERED) remembered.delete(remembered.keys().next().value!);
        }
        for (const el of rows.keys()) remove(el);
    };
}
