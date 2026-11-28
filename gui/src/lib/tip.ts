// What a drawn tooltip says and where it goes (components/ui/Tooltip.tsx shows it).
// Its place is the design's (Radix's Tooltip: side bottom, sideOffset 6, collisionPadding 8).

export const TIP_DELAY = 450;
export const TIP_SKIP = 200;
const OFFSET = 6;
const PAD = 8;

/** The key names a tooltip's "(…)" may hold, as keyText and formatKeys write them (src/keybindings/core.ts). */
const KEY = /^(?:[⌘⌥⇧⌃]|Ctrl|Alt|Shift|Win|Super|Cmd|Esc|Enter|Return|Tab|Space|Backspace|Delete|Insert|Home|End|Page Up|Page Down|Plus|[←→↑↓]|F\d{1,2}|[A-Z0-9]|[^\sA-Za-z0-9()])$/;

/** "Label (⌘K)" → the label and its keys as chips ["⌘", "K"]; anything else is all label. */
export function splitTip(text: string): { label: string; keys?: string[] } {
    const m = /^([\s\S]*\S)\s+\(([^()]+)\)$/.exec(text);
    const keys = m && keysOf(m[2]!);
    return keys ? { label: m[1]!, keys } : { label: text };
}

/** "⌘+K", "⌘K", "Ctrl+Shift+P", "Esc" → one chip per key; undefined when it isn't only keys. */
export function keysOf(text: string): string[] | undefined {
    const keys: string[] = [];
    for (const stroke of text.trim().split(/\s+/)) {
        const parts = stroke.includes("+") && stroke !== "+" ? stroke.split("+").filter(Boolean) : [...stroke.matchAll(/[⌘⌥⇧⌃]|[^⌘⌥⇧⌃]+/g)].map((p) => p[0]);
        if (!parts.length || !parts.every((p) => KEY.test(p))) return undefined;
        keys.push(...parts);
    }
    return keys.length ? keys : undefined;
}

/** Props that give an element a drawn tooltip: `<button {...tip("New chat", shortcut("app:newChat"))}>`. */
export function tip(label: string, keys?: string | string[]): { "data-tip": string; "data-keys"?: string } {
    const list = typeof keys === "string" ? keysOf(keys) : keys;
    return list?.length ? { "data-tip": label, "data-keys": list.join(" ") } : { "data-tip": label };
}

type Box = { left: number; top: number; right: number; bottom: number; width: number };

/** Below the element, centred on it, 6 px away; above when there's no room below and room above; kept 8 px inside the window.
 *  `left` (a rail down the window's right edge): beside it, centred on it, unless there's no room there. */
export function placeTip(r: Box, w: number, h: number, vw: number, vh: number, want?: "left"): { left: number; top: number; side: "bottom" | "top" | "left" } {
    if (want === "left" && r.left - OFFSET - w >= PAD) {
        const mid = (r.top + r.bottom) / 2 - h / 2;
        return { left: Math.round(r.left - OFFSET - w), top: Math.round(Math.min(Math.max(mid, PAD), Math.max(PAD, vh - PAD - h))), side: "left" };
    }
    const below = r.bottom + OFFSET;
    const side = below + h > vh - PAD && r.top - OFFSET - h >= PAD ? "top" : "bottom";
    const top = side === "top" ? r.top - OFFSET - h : below;
    const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, PAD), Math.max(PAD, vw - PAD - w));
    return { left: Math.round(left), top: Math.round(top), side };
}

/**
 * Keys that move focus themselves: Tab and Shift+Tab, and the arrows (with Home and End) that move it along a toolbar,
 * a list or a menu. A focus that follows one of them, in the same moment, is the user's, and shows its tooltip; focus
 * the app moves itself (a drawer opening on its first button, a dialog closing back to what opened it) and a click
 * don't.
 */
const FOCUS_KEYS = new Set(["Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
/** How soon after the key the focus has to come: in the same task (Tab's own move, a toolbar's handler) or the frame after. */
export const FOCUS_KEY_MS = 100;

export function movesFocus(key: string): boolean {
    return FOCUS_KEYS.has(key);
}

/** Whether a focus at `now` came from a key that moves focus, last pressed at `keyAt`. */
export function focusFromKeys(keyAt: number, now: number): boolean {
    return now - keyAt >= 0 && now - keyAt <= FOCUS_KEY_MS;
}

/** Whether an element's box is where it was when its tooltip showed: one that moved or changed size leaves it pointing at nothing. */
export function sameBox(a: { left: number; top: number; width: number; height: number }, b: { left: number; top: number; width: number; height: number }): boolean {
    return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}
