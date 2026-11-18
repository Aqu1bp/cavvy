// Where a submenu (components/ui/Submenu.tsx) goes: loaded with the menus that have one.

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
