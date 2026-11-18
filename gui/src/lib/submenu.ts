// Where a submenu (components/ui/Submenu.tsx) goes, and its Escape: loaded with the menus that have one.

/**
 * A submenu: beside its menu (`menu`, its left and right edges), its top level with the item that opens it (less
 * `pad`, so the first item lines up with that item), on the right, or on the left where the right hasn't room for it.
 * Kept 8px inside the viewport, and as tall as it is at most.
 */
export function placeSubmenu(
    item: { top: number },
    menu: { left: number; right: number },
    o: { width: number; height: number; pad: number; vw: number; vh: number },
): { left: number; top: number; width: number; maxHeight: number; side: "right" | "left" } {
    const width = Math.max(0, Math.min(o.width, o.vw - 16));
    const right = menu.right + 2;
    const left = menu.left - 2 - width;
    const side = right + width <= o.vw - 8 || o.vw - menu.right > menu.left ? "right" : "left";
    const x = Math.max(8, Math.min(side === "right" ? right : left, o.vw - width - 8));
    const maxHeight = Math.max(0, o.vh - 16);
    const top = Math.max(8, Math.min(item.top - o.pad, o.vh - 8 - Math.min(o.height, maxHeight)));
    return { left: x, top, width, maxHeight, side };
}

/**
 * Opened by the pointer, a submenu leaves the keys on the menu it's from (on its item): Escape there closes just it,
 * its item focused, as when the keys opened it. Heard before that menu's own keys (lib/menu.ts mountMenu, on the
 * document), which would close the whole menu. Until the returned function is called.
 */
export function escapeToItem(win: Pick<Window, "addEventListener" | "removeEventListener">, item: HTMLElement, panel: () => HTMLElement | undefined, hide: () => void): () => void {
    const key = (e: KeyboardEvent) => {
        const at = item.ownerDocument.activeElement;
        if (e.key !== "Escape" || e.isComposing || panel()?.contains(at) || !item.closest('[role="menu"]')?.contains(at)) return;
        e.preventDefault();
        e.stopPropagation();
        hide();
        item.focus({ preventScroll: true });
    };
    win.addEventListener("keydown", key, true);
    return () => win.removeEventListener("keydown", key, true);
}
