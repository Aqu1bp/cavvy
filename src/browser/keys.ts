// Keys as the browser wants them (Input.dispatchKeyEvent), from the names an agent presses ("Enter", "Control+A") and
// from what a person's keyboard reports in the GUI pane (a KeyboardEvent's key, code and modifiers). Pure.

/** Input.dispatchKeyEvent's modifiers bitmask. */
export const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
export type Modifier = keyof typeof MODIFIER_BITS;

export interface KeyPress {
    key: string;
    code: string;
    windowsVirtualKeyCode: number;
    modifiers: number;
    /** What typing it inserts: only keys that print, and not with Control or Meta held. */
    text?: string;
    /** Editing commands Chrome runs for it (a headless browser has no menu to take Control+A from). */
    commands?: string[];
}

/** key -> [code, virtual key code], for keys that don't print. */
const NAMED: Record<string, [string, number]> = {
    Backspace: ["Backspace", 8],
    Tab: ["Tab", 9],
    Enter: ["Enter", 13],
    Escape: ["Escape", 27],
    " ": ["Space", 32],
    PageUp: ["PageUp", 33],
    PageDown: ["PageDown", 34],
    End: ["End", 35],
    Home: ["Home", 36],
    ArrowLeft: ["ArrowLeft", 37],
    ArrowUp: ["ArrowUp", 38],
    ArrowRight: ["ArrowRight", 39],
    ArrowDown: ["ArrowDown", 40],
    Insert: ["Insert", 45],
    Delete: ["Delete", 46],
    Shift: ["ShiftLeft", 16],
    Control: ["ControlLeft", 17],
    Alt: ["AltLeft", 18],
    Meta: ["MetaLeft", 91],
    CapsLock: ["CapsLock", 20],
    ContextMenu: ["ContextMenu", 93],
};
for (let n = 1; n <= 12; n++) NAMED[`F${n}`] = [`F${n}`, 111 + n];

/** How an agent may spell a key, by what it's called here. */
const ALIASES: Record<string, string> = {
    return: "Enter",
    esc: "Escape",
    space: " ",
    spacebar: " ",
    del: "Delete",
    ins: "Insert",
    pgup: "PageUp",
    pgdn: "PageDown",
    pageup: "PageUp",
    pagedown: "PageDown",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    ctrl: "Control",
    control: "Control",
    cmd: "Meta",
    command: "Meta",
    super: "Meta",
    option: "Alt",
    opt: "Alt",
    shift: "Shift",
    alt: "Alt",
    meta: "Meta",
};

/** Punctuation on a US keyboard: key -> [code, virtual key code, the key with Shift]. */
const PUNCTUATION: Record<string, [string, number, string]> = {
    ";": ["Semicolon", 186, ":"],
    "=": ["Equal", 187, "+"],
    ",": ["Comma", 188, "<"],
    "-": ["Minus", 189, "_"],
    ".": ["Period", 190, ">"],
    "/": ["Slash", 191, "?"],
    "`": ["Backquote", 192, "~"],
    "[": ["BracketLeft", 219, "{"],
    "\\": ["Backslash", 220, "|"],
    "]": ["BracketRight", 221, "}"],
    "'": ["Quote", 222, '"'],
};
/** What Shift makes of each: the shifted character -> [code, virtual key code, the plain key]. */
const SHIFTED = new Map(Object.entries(PUNCTUATION).map(([k, [code, vk, shifted]]) => [shifted, [code, vk] as const]));
const SHIFTED_DIGITS = ")!@#$%^&*(";

/** Editing shortcuts, by the letter held with Control or Meta. */
const COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo", y: "redo" };

export function modifierBits(mods: Iterable<string>): number {
    let bits = 0;
    for (const m of mods) {
        const name = ALIASES[m.toLowerCase()] ?? m;
        if (name in MODIFIER_BITS) bits |= MODIFIER_BITS[name as Modifier];
    }
    return bits;
}

/**
 * The key press for a key's name ("a", "Enter", "ArrowDown", "F5") with modifiers held. `spec` may carry them too:
 * "Control+Shift+P", "Meta+a". Undefined when something in it isn't a key or a modifier.
 */
export function parseKey(spec: string, modifiers: readonly string[] = []): KeyPress | undefined {
    // A "+" last is the plus key itself ("Control++").
    const parts = spec.length > 1 && spec.endsWith("+") ? [...spec.slice(0, -2).split("+"), "+"] : spec.split("+");
    const base = parts.pop();
    if (!base) return undefined;
    const held = [...modifiers, ...parts];
    if (held.some((m) => !((ALIASES[m.toLowerCase()] ?? m) in MODIFIER_BITS))) return undefined;
    return describe(ALIASES[base.toLowerCase()] ?? base, modifierBits(held));
}

function describe(key: string, modifiers: number): KeyPress | undefined {
    const shift = (modifiers & MODIFIER_BITS.Shift) !== 0;
    const command = (modifiers & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta)) !== 0;
    const named = NAMED[key];
    if (named) {
        const [code, windowsVirtualKeyCode] = named;
        // A modifier key carries its own bit while it's down.
        const own = key in MODIFIER_BITS ? MODIFIER_BITS[key as Modifier] : 0;
        const text = command ? undefined : key === " " ? " " : key === "Enter" ? "\r" : undefined;
        return { key, code, windowsVirtualKeyCode, modifiers: modifiers | own, ...(text ? { text } : {}) };
    }
    if (key.length !== 1) return undefined;
    let code: string;
    let vk: number;
    let printed = key;
    if (/^[a-z]$/i.test(key)) {
        code = `Key${key.toUpperCase()}`;
        vk = key.toUpperCase().charCodeAt(0);
        printed = shift ? key.toUpperCase() : key;
    } else if (/^[0-9]$/.test(key)) {
        code = `Digit${key}`;
        vk = key.charCodeAt(0);
        printed = shift ? SHIFTED_DIGITS[Number(key)]! : key;
    } else if (PUNCTUATION[key]) {
        [code, vk] = PUNCTUATION[key]!;
        printed = shift ? PUNCTUATION[key]![2] : key;
    } else if (SHIFTED_DIGITS.includes(key)) {
        const digit = (SHIFTED_DIGITS.indexOf(key) + 1) % 10;
        code = `Digit${digit}`;
        vk = 48 + digit;
        modifiers |= MODIFIER_BITS.Shift;
    } else if (SHIFTED.has(key)) {
        [code, vk] = SHIFTED.get(key)!;
        modifiers |= MODIFIER_BITS.Shift;
    } else {
        // Not on a US keyboard (é, 日): it is typed, not pressed.
        return { key, code: "", windowsVirtualKeyCode: 0, modifiers, ...(command ? {} : { text: key }) };
    }
    const press: KeyPress = { key: printed, code, windowsVirtualKeyCode: vk, modifiers };
    if (!command) press.text = printed;
    const edit = command ? COMMANDS[key.toLowerCase()] : undefined;
    if (edit) press.commands = [shift && edit === "undo" ? "redo" : edit];
    return press;
}

/** What a KeyboardEvent says, as the GUI pane sends it. */
export interface KeyEventInput {
    key: string;
    code: string;
    modifiers: number;
}

/**
 * The key press for a person's KeyboardEvent. Its key and code stand as they are (another layout's keys stay right);
 * the virtual key code comes from the key's name. Undefined for keys that aren't one ("Dead", "Process", "Unidentified").
 */
export function fromKeyboardEvent(e: KeyEventInput): KeyPress | undefined {
    if (typeof e.key !== "string" || typeof e.code !== "string" || typeof e.modifiers !== "number") return undefined;
    const base = describe(e.key, e.modifiers);
    return base && { ...base, key: e.key, code: e.code || base.code, modifiers: e.modifiers };
}
