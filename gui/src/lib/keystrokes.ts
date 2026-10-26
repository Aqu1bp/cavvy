// Browser key events as the keybindings file names keys.

import { strokeId } from "../../../src/keybindings/core";

const NAMED: Record<string, string> = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    Enter: "enter",
    Escape: "escape",
    Tab: "tab",
    Backspace: "backspace",
    Delete: "delete",
    Insert: "insert",
    Home: "home",
    End: "end",
    PageUp: "pageup",
    PageDown: "pagedown",
    " ": "space",
};

const CODES: Record<string, string> = {
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Space: "space",
};

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

function fromKey(key: string): string | undefined {
    if (NAMED[key]) return NAMED[key];
    if (/^F\d{1,2}$/.test(key)) return key.toLowerCase();
    if ([...key].length === 1) return key.toLowerCase();
    return undefined; // Shift, Dead, Unidentified, Process…
}

function fromCode(code: string): string | undefined {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit\d$/.test(code)) return code.slice(5);
    return CODES[code];
}

/**
 * The ids a key press may go by, best first: the character it typed (the
 * layout's), then the key on the keyboard, for Option on a Mac ("∫" for
 * Option+B) and shifted symbols ("?" for Shift+/).
 */
export function eventStrokes(e: KeyLike): string[] {
    const mods = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, cmd: e.metaKey };
    const out: string[] = [];
    const k = fromKey(e.key);
    if (k) out.push(strokeId({ key: k, ...mods }));
    // A symbol Shift had to make on this layout ("/" is Shift+7 on a German keyboard) matches without Shift too.
    if (k && e.shiftKey && k.length === 1 && k.toLowerCase() === k.toUpperCase() && !/\d/.test(k)) out.push(strokeId({ key: k, ...mods, shift: false }));
    const c = fromCode(e.code);
    if (c && c !== k) out.push(strokeId({ key: c, ...mods }));
    return out;
}
