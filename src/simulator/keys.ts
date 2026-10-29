// Keys as the simulator's hardware keyboard takes them: USB HID usages (the "Keyboard/Keypad" page), each pressed
// and released. Text is typed key by key; text a US keyboard can't type goes by the pasteboard instead (session.ts).

/** A key going down (true) or up. */
export type KeyStroke = [usage: number, down: boolean];

const SHIFT = 0xe1;

/** Keys by the names KeyboardEvent.code gives them (the GUI's keys), which are also the names the agent can press. */
const CODES: Record<string, number> = {
    Enter: 0x28,
    Escape: 0x29,
    Backspace: 0x2a,
    Tab: 0x2b,
    Space: 0x2c,
    Minus: 0x2d,
    Equal: 0x2e,
    BracketLeft: 0x2f,
    BracketRight: 0x30,
    Backslash: 0x31,
    Semicolon: 0x33,
    Quote: 0x34,
    Backquote: 0x35,
    Comma: 0x36,
    Period: 0x37,
    Slash: 0x38,
    CapsLock: 0x39,
    Home: 0x4a,
    PageUp: 0x4b,
    Delete: 0x4c,
    End: 0x4d,
    PageDown: 0x4e,
    ArrowRight: 0x4f,
    ArrowLeft: 0x50,
    ArrowDown: 0x51,
    ArrowUp: 0x52,
    ControlLeft: 0xe0,
    ShiftLeft: 0xe1,
    AltLeft: 0xe2,
    MetaLeft: 0xe3,
    ControlRight: 0xe4,
    ShiftRight: 0xe5,
    AltRight: 0xe6,
    MetaRight: 0xe7,
};
for (let i = 0; i < 26; i++) CODES[`Key${String.fromCharCode(65 + i)}`] = 0x04 + i;
for (let i = 1; i <= 9; i++) CODES[`Digit${i}`] = 0x1d + i;
CODES.Digit0 = 0x27;
for (let i = 1; i <= 12; i++) CODES[`F${i}`] = 0x39 + i;

/** The HID usage of a key by its KeyboardEvent.code; undefined for one the simulator has no key for. */
export function usageOfCode(code: string): number | undefined {
    return CODES[code];
}

/** Characters and the key that types them, unshifted then shifted, as on a US keyboard. */
const UNSHIFTED = "`1234567890-=[]\\;',./";
const SHIFTED = "~!@#$%^&*()_+{}|:\"<>?";
const PUNCTUATION_CODES = ["Backquote", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "Digit0", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash"];

/** The key (and whether Shift is held) that types a character; undefined when a US keyboard has none. */
export function keyOfChar(ch: string): { usage: number; shift: boolean } | undefined {
    if (/^[a-z]$/.test(ch)) return { usage: CODES[`Key${ch.toUpperCase()}`]!, shift: false };
    if (/^[A-Z]$/.test(ch)) return { usage: CODES[`Key${ch}`]!, shift: true };
    if (ch === " ") return { usage: CODES.Space!, shift: false };
    if (ch === "\n") return { usage: CODES.Enter!, shift: false };
    if (ch === "\t") return { usage: CODES.Tab!, shift: false };
    let i = UNSHIFTED.indexOf(ch);
    if (i >= 0) return { usage: CODES[PUNCTUATION_CODES[i]!]!, shift: false };
    i = SHIFTED.indexOf(ch);
    if (i >= 0) return { usage: CODES[PUNCTUATION_CODES[i]!]!, shift: true };
    return undefined;
}

/** The strokes that type `text`, or undefined when a character has no key (it goes by the pasteboard then). */
export function strokesForText(text: string): KeyStroke[] | undefined {
    const out: KeyStroke[] = [];
    for (const ch of text.replace(/\r\n?/g, "\n")) {
        const k = keyOfChar(ch);
        if (!k) return undefined;
        if (k.shift) out.push([SHIFT, true]);
        out.push([k.usage, true], [k.usage, false]);
        if (k.shift) out.push([SHIFT, false]);
    }
    return out;
}

const MODIFIERS: Record<string, number> = { control: 0xe0, ctrl: 0xe0, shift: 0xe1, alt: 0xe2, option: 0xe2, meta: 0xe3, command: 0xe3, cmd: 0xe3 };

/** Names the agent may use for keys, besides KeyboardEvent.code's: a letter or digit, and the common short names. */
const ALIASES: Record<string, string> = { return: "Enter", esc: "Escape", backspace: "Backspace", delete: "Backspace", forwarddelete: "Delete", tab: "Tab", space: "Space", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" };

/**
 * The strokes for a key press like "Enter", "ArrowDown" or "Meta+A" (modifiers held while the key goes down and up),
 * with more modifiers in `held`. Throws for a name with no key.
 */
export function strokesForPress(key: string, held: string[] = []): KeyStroke[] {
    const parts = key.split("+").map((p) => p.trim()).filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error("press needs a key");
    const mods: number[] = [];
    for (const m of [...parts, ...held]) {
        const usage = MODIFIERS[m.toLowerCase()];
        if (usage === undefined) throw new Error(`Unknown modifier "${m}"`);
        if (!mods.includes(usage)) mods.push(usage);
    }
    const usage = keyUsage(name);
    if (usage === undefined) throw new Error(`The simulator has no key "${name}"`);
    return [...mods.map((m): KeyStroke => [m, true]), [usage, true], [usage, false], ...mods.reverse().map((m): KeyStroke => [m, false])];
}

function keyUsage(name: string): number | undefined {
    if (CODES[name] !== undefined) return CODES[name];
    const alias = ALIASES[name.toLowerCase()];
    if (alias) return CODES[alias];
    if (/^[a-z0-9]$/i.test(name)) return keyOfChar(name.toLowerCase())?.usage;
    const exact = Object.keys(CODES).find((c) => c.toLowerCase() === name.toLowerCase());
    return exact ? CODES[exact] : undefined;
}
