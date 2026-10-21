/** Where a popover goes: by its anchor, as design/glass's placePop puts it. */
export interface PopoverPlace {
    left: number;
    /** From the viewport's top (opening below), or its bottom (opening above). */
    top?: number;
    bottom?: number;
    maxHeight: number;
}

/**
 * On its preferred side of the anchor, 6px from it, at the anchor's leading
 * edge (`end`: its trailing edge), kept 8px inside the viewport. It flips to
 * the other side when the preferred one can't fit `least` (its height, or less
 * when it may scroll) and the other side has more room.
 */
export function placePopover(
    anchor: { top: number; bottom: number; left: number; right: number },
    o: { width: number; least: number; placement: "top" | "bottom"; align?: "start" | "end"; vw: number; vh: number },
): PopoverPlace {
    let left = o.align === "end" ? anchor.right - o.width : anchor.left;
    left = Math.max(8, Math.min(left, o.vw - o.width - 8));
    const below = o.vh - anchor.bottom - 12;
    const above = anchor.top - 12;
    const useTop = o.placement === "top" ? above >= o.least || above > below : below < o.least && above > below;
    return useTop ? { left, bottom: o.vh - anchor.top + 6, maxHeight: Math.max(160, above) } : { left, top: anchor.bottom + 6, maxHeight: Math.max(160, below) };
}
