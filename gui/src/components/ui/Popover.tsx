import { createEffect, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

export interface PopoverProps {
    open: boolean;
    anchor: () => HTMLElement | undefined;
    onClose: () => void;
    /** Preferred side; flips when there's no room. */
    placement?: "top" | "bottom";
    align?: "start" | "end";
    /** Opens beyond this element's edge instead of the anchor's (the composer's menus clear the whole card). */
    edge?: () => HTMLElement | undefined;
    width?: number;
    /** Its tallest (default 560); a longer list scrolls inside. */
    maxHeight?: number;
    /** How short it can get, scrolling, and still stay on the preferred side (default: its full height). */
    minHeight?: number;
    class?: string;
    children: JSX.Element;
}

/** A floating panel next to an anchor, in a portal so no overflow clips it. */
export function Popover(p: PopoverProps) {
    const [pos, setPos] = createSignal<{ left: number; top?: number; bottom?: number; maxHeight: number }>();
    let el: HTMLDivElement | undefined;

    const place = () => {
        const a = p.anchor();
        if (!a) return;
        const r = a.getBoundingClientRect();
        const e = p.edge?.()?.getBoundingClientRect();
        const top = e ? Math.min(e.top, r.top) : r.top;
        const bottom = e ? Math.max(e.bottom, r.bottom) : r.bottom;
        const width = p.width ?? 320;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = p.align === "end" ? r.right - width : r.left;
        left = Math.max(8, Math.min(left, vw - width - 8));
        const below = vh - bottom - 12;
        const above = top - 12;
        // Its own height once rendered, so a tall menu opens on the side it fits.
        const need = Math.min(el?.scrollHeight || 220, p.maxHeight ?? 560);
        const least = Math.min(need, p.minHeight ?? need);
        const wantTop = (p.placement ?? "bottom") === "top";
        const useTop = wantTop ? above >= least || above > below : below < least && above > below;
        if (useTop) setPos({ left, bottom: vh - top + 6, maxHeight: Math.max(160, above) });
        else setPos({ left, top: bottom + 6, maxHeight: Math.max(160, below) });
    };

    createEffect(() => {
        if (p.open) requestAnimationFrame(place);
    });

    onMount(() => {
        const onDown = (e: PointerEvent) => {
            if (!p.open) return;
            const t = e.target as Node;
            if (el?.contains(t) || p.anchor()?.contains(t)) return;
            p.onClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (p.open && e.key === "Escape") {
                e.stopPropagation();
                p.onClose();
            }
        };
        const onResize = () => p.open && place();
        document.addEventListener("pointerdown", onDown, true);
        document.addEventListener("keydown", onKey, true);
        window.addEventListener("resize", onResize);
        onCleanup(() => {
            document.removeEventListener("pointerdown", onDown, true);
            document.removeEventListener("keydown", onKey, true);
            window.removeEventListener("resize", onResize);
        });
    });

    return (
        <Show when={p.open}>
            <Portal>
                <div
                    ref={el}
                    class={`popover ${p.class ?? ""}`}
                    style={{
                        left: `${pos()?.left ?? -9999}px`,
                        top: pos()?.top !== undefined ? `${pos()!.top}px` : undefined,
                        bottom: pos()?.bottom !== undefined ? `${pos()!.bottom}px` : undefined,
                        width: `${p.width ?? 320}px`,
                        "max-height": `${Math.min(pos()?.maxHeight ?? 480, p.maxHeight ?? 560)}px`,
                    }}
                    data-side={pos()?.bottom !== undefined ? "top" : "bottom"}
                >
                    {p.children}
                </div>
            </Portal>
        </Show>
    );
}
