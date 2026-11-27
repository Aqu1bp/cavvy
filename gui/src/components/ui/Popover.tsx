import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { mountMenu, type MenuBehavior } from "../../lib/menu";
import { placePopover, type PopoverPlace } from "../../lib/popover";
import { sp } from "../../state/prefs";
import { settingsTab } from "../../state/ui";
import { usePane } from "../../state/split";

export interface PopoverProps {
    open: boolean;
    role?: "menu" | "dialog";
    label?: string;
    behavior?: MenuBehavior;
    point?: { x: number; y: number };
    anchor: () => HTMLElement | undefined;
    onClose: () => void;
    /** Preferred side; flips when there's no room. */
    placement?: "top" | "bottom";
    align?: "start" | "end";
    /** Its width (default 320), and the heights below, in px at text size 14: they follow the text (`sp`). */
    width?: number;
    /** Lines up with this element's left and right edges instead (a panel that stays inside its column). */
    span?: () => HTMLElement | undefined;
    /** Its tallest (default 560); a longer list scrolls inside. */
    maxHeight?: number;
    /** How short it can get, scrolling, and still stay on the preferred side (default: its full height). */
    minHeight?: number;
    class?: string;
    /** Fade out on close: a still copy of the panel, which no one can focus or click, goes after the real one has. */
    exit?: boolean;
    children: JSX.Element;
}

/**
 * The closing copy: the real panel is gone already (focus is back on the anchor, its keys
 * are off), so the copy is only a picture of it. Scrolled lists keep their place; a detached
 * element reads 0, so the positions come from its scroll events.
 */
function fadeOut(el: HTMLElement, scrolled: Map<Element, number>) {
    const doc = el.ownerDocument;
    if (doc.documentElement.dataset.motion === "instant" || doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ghost = el.cloneNode(true) as HTMLElement;
    for (const n of [ghost, ...ghost.querySelectorAll("[id]")]) n.removeAttribute("id");
    ghost.removeAttribute("role");
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    ghost.classList.add("closing");
    doc.body.append(ghost);
    if (scrolled.size) {
        const from = [...el.querySelectorAll("*")];
        const to = ghost.querySelectorAll("*");
        for (const [n, top] of scrolled) {
            const copy = n === el ? ghost : to[from.indexOf(n)];
            if (copy) copy.scrollTop = top;
        }
    }
    const done = () => ghost.remove();
    ghost.addEventListener("animationend", (e) => e.target === ghost && done());
    setTimeout(done, 400);
}

/** A floating panel next to an anchor, in a portal so no overflow clips it. */
export function Popover(p: PopoverProps) {
    const [pos, setPos] = createSignal<PopoverPlace>();
    let el: HTMLDivElement | undefined;
    // `open` read once, here, where it's owned. A prop like `open={a() && b()}` is compiled to a getter that makes a memo
    // each time it's read: read from the page's listeners below (every pointerdown, key and resize), outside anything
    // that owns it, each was never let go of, and kept the component that passed it (the composer, its conversation
    // with it) alive after it was gone: 2.3 MB and 13,000 nodes a session switch.
    const open = createMemo(() => Boolean(p.open));

    const place = () => {
        const a = p.anchor();
        if (!a) return;
        const at = p.point ? { top: p.point.y, bottom: p.point.y, left: p.point.x, right: p.point.x } : a.getBoundingClientRect();
        const span = p.span?.()?.getBoundingClientRect();
        const r = span ? { top: at.top, bottom: at.bottom, left: span.left, right: span.right } : at;
        // Its own height once rendered, so a tall menu opens on the side it fits.
        const need = Math.min(el?.scrollHeight || 220, sp(p.maxHeight ?? 560));
        setPos(placePopover(r, { width: span ? span.width : sp(p.width ?? 320), least: Math.min(need, p.minHeight === undefined ? need : sp(p.minHeight)), placement: p.placement ?? "bottom", align: p.point || span ? "start" : p.align, vw: window.innerWidth, vh: window.innerHeight }));
    };

    // Placed as it opens, and again when it asks for another width (the model picker's two views differ).
    createEffect(() => {
        if (!open()) return;
        void p.width;
        requestAnimationFrame(place);
    });

    createEffect(() => {
        if (open() && el && p.behavior) onCleanup(mountMenu(el, p.behavior));
    });

    // Settings hides what it covers without unmounting it (App.tsx): a menu there closes as Settings opens, as it did
    // when that went, and one opened while it's covered (a shortcut, say) closes at once. A dialog is over Settings.
    createEffect(() => {
        if (settingsTab() && open() && !p.anchor()?.closest(".settings-page, .settings-nav, .dialog")) p.onClose();
    });
    // Its session switched away from by a key, kept out of sight (Panes.tsx): closed as it would be with the session gone,
    // not left over the next one, acting on this one.
    const pane = usePane();
    createEffect(() => {
        if (pane.parked() && open()) p.onClose();
    });

    onMount(() => {
        const onDown = (e: PointerEvent) => {
            if (!open()) return;
            const t = e.target as Node;
            if (el?.contains(t) || p.anchor()?.contains(t)) return;
            p.onClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (open() && !p.behavior && e.key === "Escape") {
                e.stopPropagation();
                p.onClose();
            }
        };
        const onResize = () => open() && place();
        document.addEventListener("pointerdown", onDown, true);
        document.addEventListener("keydown", onKey, true);
        window.addEventListener("resize", onResize);
        onCleanup(() => {
            document.removeEventListener("pointerdown", onDown, true);
            document.removeEventListener("keydown", onKey, true);
            window.removeEventListener("resize", onResize);
        });
    });

    // Tracked while open, for fadeOut.
    const scrolled = new Map<Element, number>();
    const onScroll = (e: Event) => scrolled.set(e.target as Element, (e.target as Element).scrollTop);

    return (
        <Show when={open()}>
            {(() => {
                if (p.exit) {
                    scrolled.clear();
                    onCleanup(() => el && fadeOut(el, scrolled));
                }
                return null;
            })()}
            <Portal>
                <div
                    ref={(e) => {
                        el = e;
                        // Scroll doesn't bubble: the lists inside are heard in the capture phase.
                        if (p.exit) e.addEventListener("scroll", onScroll, true);
                    }}
                    role={p.role}
                    aria-label={p.label}
                    tabIndex={p.behavior ? -1 : undefined}
                    class={`popover ${p.anchor()?.closest?.(".dialog") ? "over-dialog " : ""}${p.class ?? ""}`}
                    style={{
                        left: `${pos()?.left ?? -9999}px`,
                        top: pos()?.top !== undefined ? `${pos()!.top}px` : undefined,
                        bottom: pos()?.bottom !== undefined ? `${pos()!.bottom}px` : undefined,
                        width: `${pos()?.width ?? sp(p.width ?? 320)}px`,
                        "max-height": `${Math.min(pos()?.maxHeight ?? 480, sp(p.maxHeight ?? 560))}px`,
                    }}
                    data-side={pos()?.bottom !== undefined ? "top" : "bottom"}
                    data-align={!p.point && p.align === "end" ? "end" : "start"}
                >
                    {p.children}
                </div>
            </Portal>
        </Show>
    );
}
