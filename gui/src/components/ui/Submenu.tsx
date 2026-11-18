import { createSignal, createUniqueId, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { ChevronRight } from "lucide-solid";
import { ownSubmenu } from "../../lib/menu";
import { placeSubmenu } from "../../lib/submenu";
import { sp } from "../../state/prefs";

/** How long the pointer rests on its item before it opens, and how long it may be away (on its way in) before it closes. */
const OPEN_MS = 150;
const CLOSE_MS = 250;

/** The open submenu of each menu: one at a time. */
const shown = new WeakMap<Element, () => void>();

/**
 * An item of a menu (Menu.tsx) that opens more items beside it: on Right, Enter or a click, or once the pointer rests
 * on it. Left or Esc goes back to it (lib/menu.ts has the keys); picking an item closes the whole menu, as the item's
 * own action does. `icon` and `label` are the item's.
 */
export function Submenu(p: { icon?: JSX.Element; label: string; width?: number; children: JSX.Element }) {
    const id = createUniqueId();
    const [open, setOpen] = createSignal(false);
    const [pos, setPos] = createSignal<ReturnType<typeof placeSubmenu>>();
    let item!: HTMLButtonElement;
    let panel: HTMLDivElement | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = (fn: () => void, ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(fn, ms);
    };
    const menu = () => item.closest<HTMLElement>('[role="menu"]');
    const first = () => panel?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])') ?? undefined;
    const place = () => {
        const m = menu();
        if (!panel || !m) return;
        setPos(placeSubmenu(item.getBoundingClientRect(), m.getBoundingClientRect(), { width: sp(p.width ?? 220), height: panel.scrollHeight, pad: parseFloat(getComputedStyle(panel).paddingTop) || 0, vw: window.innerWidth, vh: window.innerHeight }));
    };
    const show = (focus: boolean) => {
        clearTimeout(timer);
        const m = menu();
        if (m) {
            const other = shown.get(m);
            if (other && other !== hide) other();
            shown.set(m, hide);
        }
        setOpen(true);
        requestAnimationFrame(() => {
            place();
            if (focus) first()?.focus({ preventScroll: true });
        });
    };
    function hide() {
        clearTimeout(timer);
        if (!open()) return;
        // Its focus goes back to the item, not to the page.
        if (panel?.contains(document.activeElement)) item.focus({ preventScroll: true });
        setOpen(false);
        setPos(undefined);
        const m = menu();
        if (m && shown.get(m) === hide) shown.delete(m);
    }
    onMount(() => {
        const heard = (e: Event) => {
            const d = (e as CustomEvent<{ open: boolean; focus?: boolean }>).detail;
            if (d.open) show(Boolean(d.focus));
            else hide();
        };
        item.addEventListener("submenu", heard);
        // The window resized: its menu moves (Popover), so it closes rather than stay where it was.
        window.addEventListener("resize", hide);
        onCleanup(() => {
            item.removeEventListener("submenu", heard);
            window.removeEventListener("resize", hide);
        });
    });
    onCleanup(() => clearTimeout(timer));
    // Pointing elsewhere in the menu, or the keys moving on in it: it closes.
    const away = (e: FocusEvent) => {
        const to = e.relatedTarget as Node | null;
        if (to && !panel?.contains(to) && menu()?.contains(to)) hide();
    };
    return (
        <>
            <button
                ref={item}
                role="menuitem"
                class="menu-item compact menu-sub"
                aria-haspopup="menu"
                aria-expanded={open()}
                aria-controls={open() ? id : undefined}
                // From the keyboard or a screen reader (no pointer: detail 0), into its first item.
                onClick={(e) => show(e.detail === 0)}
                // Opened by the pointer, the keys go on from its item (Right goes in), not from where they were.
                onPointerEnter={(e) => e.pointerType === "mouse" && (open() ? clearTimeout(timer) : later(() => (item.focus({ preventScroll: true }), show(false)), OPEN_MS))}
                onPointerLeave={(e) => e.pointerType === "mouse" && later(hide, CLOSE_MS)}
                onFocusOut={away}
            >
                {p.icon} <span>{p.label}</span>
                <ChevronRight size={14} class="menu-sub-chev" />
            </button>
            <Show when={open()}>
                <Portal>
                    <div
                        ref={(el) => {
                            panel = el;
                            onCleanup(ownSubmenu(el, item));
                        }}
                        id={id}
                        role="menu"
                        aria-label={p.label}
                        tabIndex={-1}
                        data-submenu=""
                        data-side={pos()?.side ?? "right"}
                        class="popover submenu"
                        style={{ left: `${pos()?.left ?? -9999}px`, top: `${pos()?.top ?? 0}px`, width: `${pos()?.width ?? sp(p.width ?? 220)}px`, "max-height": pos() ? `${pos()!.maxHeight}px` : undefined }}
                        onPointerEnter={() => clearTimeout(timer)}
                        onPointerLeave={(e) => e.pointerType === "mouse" && later(hide, CLOSE_MS)}
                    >
                        {p.children}
                    </div>
                </Portal>
            </Show>
        </>
    );
}
