import { actionOf } from "../state/keybindings";

/** Shared navigation for action menus and searchable picker panels. */
export function menuIndex(length: number, current: number, key: string): number {
    if (!length) return -1;
    if (key === "Home") return 0;
    if (key === "End") return length - 1;
    if (current < 0) return key === "ArrowUp" ? length - 1 : 0;
    return (current + (key === "ArrowUp" ? -1 : 1) + length) % length;
}

export function menuTypeahead() {
    let buffer = "";
    let last = 0;
    return (labels: string[], current: number, key: string, now = performance.now()) => {
        key = key.toLocaleLowerCase();
        buffer = now - last > 700 ? key : buffer + key;
        last = now;
        // Repeated letters cycle; a multi-letter prefix keeps the current match.
        const repeated = [...buffer].every((c) => c === buffer[0]);
        const query = (repeated ? key : buffer).toLocaleLowerCase();
        for (let step = repeated ? 1 : 0; step <= labels.length; step++) {
            const index = (Math.max(current, 0) + step) % labels.length;
            if (labels[index]?.trim().toLocaleLowerCase().startsWith(query)) return index;
        }
        return -1;
    };
}

export function rowMenuKey(e: KeyboardEvent, open: () => void) {
    if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
    // Keep text fields' native context menus while renaming.
    if ((e.target as HTMLElement)?.closest("input, textarea, [contenteditable]")) return;
    e.preventDefault();
    e.stopPropagation();
    open();
}

export interface MenuBehavior {
    kind: "menu" | "dialog";
    close: () => void;
    returnFocus: () => HTMLElement | undefined;
    initialFocus?: () => HTMLElement | undefined;
    onKeyDown?: (e: KeyboardEvent) => void;
    /** Escape, before it closes the panel: true when the panel took it (closing a list open inside it). */
    onEscape?: () => boolean;
}

const ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
const CONTROLS = 'button, input, select, textarea, a[href], [tabindex]';

// ---- Submenus (components/ui/Submenu.tsx) ----
// A submenu's panel is in a portal, outside its menu's, so the menu knows it by the item that opens it: keys, clicks
// and focus in it are the menu's own. The item hears "submenu" events: { open: true, focus } (Right, Enter) or
// { open: false } (Left, Esc).

/** Each open submenu's panel, and the item it's opened from. */
const submenus = new WeakMap<Element, HTMLElement>();
const SUBMENU = "[data-submenu]";

/** `sub` is open from `item` (an item of another menu) until the returned function is called. */
export function ownSubmenu(sub: HTMLElement, item: HTMLElement): () => void {
    submenus.set(sub, item);
    return () => submenus.delete(sub);
}

/** The panel `node` is in: `panel`, or a submenu opened from it (or from one of its submenus); undefined for neither. */
export function menuOf(panel: HTMLElement, node: unknown): HTMLElement | undefined {
    const el = node as Element | null | undefined;
    if (!el) return undefined;
    if (panel.contains(el)) return panel;
    const sub = el.closest?.<HTMLElement>(SUBMENU);
    const item = sub ? submenus.get(sub) : undefined;
    return item && menuOf(panel, item) ? sub! : undefined;
}

/** Opens (focused on its first item) or closes the submenu `item` opens. */
function submenu(item: HTMLElement, open: boolean) {
    item.dispatchEvent(new CustomEvent("submenu", { detail: { open, focus: open } }));
}

/** Installed only while the panel is mounted; positioning remains Popover's job. */
export function mountMenu(panel: HTMLElement, behavior: MenuBehavior): () => void {
    const doc = panel.ownerDocument;
    const trigger = behavior.returnFocus();
    const typeahead = menuTypeahead();
    const available = (selector: string, scope = panel) => [...scope.querySelectorAll<HTMLElement>(selector)]
        .filter((el) => !el.matches(':disabled, [aria-disabled="true"], [hidden]') && el.getClientRects().length > 0);
    const focus = (el?: HTMLElement) => {
        (el ?? panel).focus({ preventScroll: true });
        el?.scrollIntoView({ block: "nearest" });
    };
    const frame = requestAnimationFrame(() => {
        const items = available(behavior.kind === "menu" ? ITEMS : CONTROLS);
        focus(behavior.initialFocus?.() ?? items.find((el) => el.getAttribute("aria-checked") === "true") ?? items[0]);
    });
    const onKey = (e: KeyboardEvent) => {
        if (e.isComposing || e.keyCode === 229) {
            // Let the IME handle the key, but never let its Escape cancel a turn.
            e.stopPropagation();
            return;
        }
        // The palette, find and Settings are the global shortcuts allowed through: App decides what they do (find
        // does nothing under Settings, where the page's own find would search the conversation it covers). Close
        // first so focus restoration cannot later land in a stale menu.
        const global = actionOf(e, ["Global"]);
        if (global === "app:commandPalette" || global === "app:find" || global === "app:settings") {
            behavior.close();
            return;
        }
        e.stopPropagation();
        // In a submenu: its items, and Left or Escape goes back to the item that opened it.
        const scope = menuOf(panel, doc.activeElement) ?? panel;
        const from = scope === panel ? undefined : submenus.get(scope);
        if (from && (e.key === "Escape" || e.key === "ArrowLeft")) {
            e.preventDefault();
            submenu(from, false);
            focus(from);
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            if (behavior.onEscape?.()) return;
            behavior.close();
            return;
        }
        if (e.key === "Tab") {
            if (behavior.kind === "menu") {
                // Restore synchronously, then let native Tab advance from the trigger.
                behavior.close();
            } else {
                e.preventDefault();
                const items = available(CONTROLS).filter((el) => el.tabIndex >= 0);
                focus(items[menuIndex(items.length, items.indexOf(doc.activeElement as HTMLElement), e.shiftKey ? "ArrowUp" : "ArrowDown")]);
            }
            return;
        }
        behavior.onKeyDown?.(e);
        if (e.defaultPrevented || behavior.kind !== "menu") return;
        const items = available(ITEMS, scope);
        const current = items.indexOf(doc.activeElement as HTMLElement);
        const opens = items[current]?.getAttribute("aria-haspopup") === "menu";
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            focus(items[menuIndex(items.length, current, e.key)]);
        } else if (opens && (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            submenu(items[current]!, true);
        } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            items[current]?.click();
        } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            const labels = items.map((el) => el.getAttribute("aria-label") ?? el.querySelector(".menu-item-name")?.textContent ?? el.textContent ?? "");
            const next = typeahead(labels, current, e.key);
            if (next >= 0) focus(items[next]);
        }
    };
    // A row marked aria-disabled can't be picked by pointer either (a disabled button already isn't).
    const onClick = (e: MouseEvent) => {
        if (!(e.target as HTMLElement | null)?.closest?.('[aria-disabled="true"]')) return;
        e.preventDefault();
        e.stopPropagation();
    };
    doc.addEventListener("keydown", onKey, true);
    panel.addEventListener("click", onClick, true);
    return () => {
        cancelAnimationFrame(frame);
        doc.removeEventListener("keydown", onKey, true);
        panel.removeEventListener("click", onClick, true);
        // Actions can open dialogs or focus a rename field. Never steal that focus,
        // nor the destination of an outside click.
        if (trigger?.isConnected && (menuOf(panel, doc.activeElement) || doc.activeElement === doc.body)) trigger.focus({ preventScroll: true });
    };
}
