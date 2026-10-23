import { Popover, type PopoverProps } from "./Popover";

/** Action menus share focus, navigation and dismissal; searchable pickers use
 * the same focus boundary while retaining their search-specific keys. */
export function Menu(p: PopoverProps & {
    label: string;
    kind?: "menu" | "dialog";
    returnFocus?: () => HTMLElement | undefined;
    initialFocus?: () => HTMLElement | undefined;
    onKeyDown?: (e: KeyboardEvent) => void;
    onEscape?: () => boolean;
}) {
    return <Popover {...p} role={p.kind ?? "menu"} label={p.label} behavior={{
        kind: p.kind ?? "menu",
        close: p.onClose,
        returnFocus: p.returnFocus ?? p.anchor,
        initialFocus: p.initialFocus,
        onKeyDown: p.onKeyDown,
        onEscape: p.onEscape,
    }} />;
}
