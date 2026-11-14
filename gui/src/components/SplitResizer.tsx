import { createSignal, onCleanup } from "solid-js";
import { frameDrag } from "../lib/drag";
import { clampSplitRatio } from "../lib/session-split";
import { setSplitRatio, splitRatio, saveSplitRatio } from "../state/split";

/** The divider stays in place in the DOM while either conversation updates. */
export function SplitResizer(p: { width: number; ratio: number }) {
    const [dragging, setDragging] = createSignal(false);
    let stop: ((cancel?: boolean) => void) | undefined;
    onCleanup(() => stop?.());
    const set = (ratio: number) => {
        setSplitRatio(clampSplitRatio(ratio, p.width));
        saveSplitRatio();
    };
    const start = (e: PointerEvent) => {
        if (e.button !== 0 || !p.width) return;
        e.preventDefault();
        stop?.();
        const target = e.currentTarget as HTMLElement;
        const x = e.clientX;
        const width = p.width;
        const from = p.ratio;
        const saved = splitRatio();
        target.focus({ preventScroll: true });
        target.setPointerCapture(e.pointerId);
        setDragging(true);
        document.body.classList.add("resizing");
        let cancelled = false;
        const drag = frameDrag({
            show: setSplitRatio,
            commit: (ratio) => {
                if (cancelled) setSplitRatio(saved);
                else if (ratio !== undefined) set(ratio);
            },
        });
        const move = (ev: PointerEvent) => drag.move(clampSplitRatio(from + (ev.clientX - x) / width, p.width));
        const end = (cancel = false) => {
            stop = undefined;
            cancelled = cancel;
            drag.end();
            setDragging(false);
            document.body.classList.remove("resizing");
            target.removeEventListener("pointermove", move);
            target.removeEventListener("lostpointercapture", released);
            target.removeEventListener("pointercancel", cancelDrag);
            window.removeEventListener("keydown", key, true);
            if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
        };
        const released = () => end();
        const cancelDrag = () => end(true);
        const key = (ev: KeyboardEvent) => {
            if (ev.key !== "Escape") return;
            ev.preventDefault();
            ev.stopImmediatePropagation();
            end(true);
        };
        stop = end;
        target.addEventListener("pointermove", move);
        target.addEventListener("lostpointercapture", released);
        target.addEventListener("pointercancel", cancelDrag);
        window.addEventListener("keydown", key, true);
    };
    return <div class="split-resizer" classList={{ drag: dragging() }} style={{ left: `${p.ratio * 100}%` }}
        role="separator" aria-orientation="vertical" aria-label="Resize chats"
        aria-valuemin={Math.round(clampSplitRatio(0, p.width) * 100)}
        aria-valuemax={Math.round(clampSplitRatio(1, p.width) * 100)}
        aria-valuenow={Math.round(p.ratio * 100)} tabIndex={0}
        title="Drag to resize chats. Double-click to reset."
        onPointerDown={start} onDblClick={() => set(0.5)}
        onKeyDown={(e) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(e.key)) return;
            e.preventDefault();
            const next = e.key === "Home" ? 0 : e.key === "End" ? 1 : e.key === "Enter" ? 0.5
                : p.ratio + (e.key === "ArrowLeft" ? -24 : 24) / Math.max(1, p.width);
            set(next);
        }} />;
}
