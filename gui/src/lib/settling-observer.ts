// An IntersectionObserver that lets go of its targets while nothing can move them, and takes them up again the moment
// something might: its root scrolls, or the root or what it holds changes size, or it's given a new target.
//
// Why: while any IntersectionObserver on the page has targets, Chromium runs a main-thread frame (style, layout, the
// observers' work) for every frame of every animation on the page, even one the compositor could draw on its own. A
// spinner waiting on a model then costs the window a main-thread frame at each of its steps, for as long as it waits.
// Measured in headless Chromium: a spinner alone, 0 style recalculations a second; with one observer anywhere on the
// page, 60 (20 with a 20-step spinner). Waiting on a model with a session on screen: 23 a second, and the main thread's
// frames 23 ms a second; with the observer let go of, 4 and 4.6 ms.
//
// Taken up again, it tells of every target where it is now, as when first observed: callers' handling of an entry has
// to be the same whether it's news or not.

/** How long without a scroll or a change in size before the targets are let go of. */
export const SETTLE_MS = 600;

export interface SettlingObserver {
    observe(el: Element): void;
    unobserve(el: Element): void;
    disconnect(): void;
    /** Something may have moved the targets that the observer can't see: watch them again for a while. */
    wake(): void;
}

/**
 * `options.root` is required: its scrolling and its size wake the observer. `sized`: more elements whose size moves the
 * targets (the column the targets are in).
 */
export function settlingObserver(callback: IntersectionObserverCallback, options: IntersectionObserverInit & { root: Element }, sized: Element[] = [], settleMs = SETTLE_MS): SettlingObserver {
    const targets = new Set<Element>();
    let watching = false;
    let told = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const io = new IntersectionObserver((entries, observer) => {
        told = true;
        callback(entries, observer);
    }, options);
    const settle = () => {
        timer = undefined;
        if (!watching || done) return;
        // Not yet told where the targets are since waking (no frame has run): not before it has been.
        if (!told && targets.size) {
            timer = setTimeout(settle, settleMs);
            return;
        }
        // What it saw and hasn't said yet is said first.
        const pending = io.takeRecords();
        if (pending.length) callback(pending, io);
        io.disconnect();
        watching = false;
    };
    const wake = () => {
        if (done) return;
        if (!watching) {
            watching = true;
            told = false;
            for (const el of targets) io.observe(el);
        }
        clearTimeout(timer);
        timer = setTimeout(settle, settleMs);
    };
    const onScroll = () => wake();
    options.root.addEventListener("scroll", onScroll, { passive: true });
    // A ResizeObserver costs no frame of its own: it's checked in the frames that lay out anyway.
    const ro = new ResizeObserver(() => wake());
    ro.observe(options.root);
    for (const el of sized) ro.observe(el);
    return {
        observe(el) {
            if (done) return;
            targets.add(el);
            if (watching) io.observe(el);
            wake();
        },
        unobserve(el) {
            targets.delete(el);
            io.unobserve(el);
        },
        disconnect() {
            done = true;
            watching = false;
            clearTimeout(timer);
            io.disconnect();
            ro.disconnect();
            options.root.removeEventListener("scroll", onScroll);
            targets.clear();
        },
        wake,
    };
}
