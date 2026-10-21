// Raw terminal input -> key events. Handles CSI/SS3 sequences, modifier
// encodings (xterm, CSI u / kitty, modifyOtherKeys), bracketed paste, and
// multi-character "pastes" from terminals without bracketed paste.

export interface Key {
    name: string;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
    /** Printable text to insert (name === "text"). */
    text?: string;
    /** Pasted content (name === "paste"). */
    paste?: string;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function mods(m: number): { shift?: boolean; meta?: boolean; ctrl?: boolean } {
    const b = Math.max(0, m - 1);
    const out: { shift?: boolean; meta?: boolean; ctrl?: boolean } = {};
    if (b & 1) out.shift = true;
    if (b & 2) out.meta = true;
    if (b & 4) out.ctrl = true;
    if (b & 8) out.meta = true; // super/cmd, treat like meta
    return out;
}

/**
 * Ctrl+keys that legacy terminals send as LF, CR, tab, backspace or ESC. The
 * kitty protocol reports them as ctrl+letter; they keep their old meaning.
 */
const LEGACY_CTRL: Record<number, Key> = {
    106: { name: "enter", ctrl: true }, // ctrl+j
    109: { name: "enter" }, // ctrl+m
    105: { name: "tab" }, // ctrl+i
    104: { name: "backspace" }, // ctrl+h
    91: { name: "escape" }, // ctrl+[
};

/** Kitty's keypad keys (57399-57427) as the keys they stand for. */
const KEYPAD = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "/", "*", "-", "+", "enter", "=", ",", "left", "right", "up", "down", "pageup", "pagedown", "home", "end", "insert", "delete"];

function codepointKey(cp: number, m: number): Key {
    const md = mods(m);
    if (md.ctrl && !md.meta && !md.shift && LEGACY_CTRL[cp]) return { ...LEGACY_CTRL[cp]! };
    // Kitty's functional keys live in the private use area; they're never text.
    if (cp >= 0xe000 && cp <= 0xf8ff) {
        const k = KEYPAD[cp - 57399];
        if (k === undefined) return { name: "unknown" };
        return k.length > 1 ? { name: k, ...md } : codepointKey(k.charCodeAt(0), m);
    }
    switch (cp) {
        case 13:
            return { name: "enter", ...md };
        case 9:
            return { name: "tab", ...md };
        case 27:
            return { name: "escape", ...md };
        case 127:
        case 8:
            return { name: "backspace", ...md };
        case 32:
            return md.ctrl || md.meta ? { name: "space", ...md } : { name: "text", text: " " };
    }
    // Not a key: e.g. CSI ? flags u, a kitty terminal reporting its keyboard flags.
    if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return { name: "unknown" };
    const ch = String.fromCodePoint(cp);
    if (md.ctrl || md.meta) return { name: ch.toLowerCase(), ...md };
    return { name: "text", text: md.shift ? ch.toUpperCase() : ch };
}

const CSI_FINAL: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", P: "f1", Q: "f2", R: "f3", S: "f4" };
const TILDE: Record<number, string> = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end", 15: "f5", 17: "f6", 18: "f7", 19: "f8", 20: "f9", 21: "f10", 23: "f11", 24: "f12" };

export class KeyParser {
    private buf = "";
    private pasting = false;
    private pasteBuf = "";

    /** True when the buffer holds a lone ESC that may start a sequence. */
    get pendingEscape(): boolean {
        return !this.pasting && this.buf === "\x1b";
    }

    feed(data: string): Key[] {
        // Terminals without bracketed paste deliver a paste as one chunk with
        // embedded newlines; treat that as a paste rather than as Enter.
        // A single trailing Enter after typed text (fast typing, IMEs, scripts)
        // is still a submit, not a paste.
        const body = data.replace(/\r$/, "");
        if (!this.pasting && !this.buf && body.length > 2 && /[\r\n]/.test(body) && !data.includes("\x1b") && /[^\r\n]/.test(body)) {
            return [{ name: "paste", paste: normalizeNewlines(data) }];
        }
        this.buf += data;
        return this.drain();
    }

    /** Called when no more bytes arrived shortly after a lone ESC. */
    flushEscape(): Key[] {
        if (this.buf === "\x1b") {
            this.buf = "";
            return [{ name: "escape" }];
        }
        return [];
    }

    private drain(): Key[] {
        const keys: Key[] = [];
        while (this.buf.length) {
            if (this.pasting) {
                const end = this.buf.indexOf(PASTE_END);
                if (end < 0) {
                    // keep a tail in case the end marker is split across chunks
                    const keep = Math.max(0, this.buf.length - (PASTE_END.length - 1));
                    this.pasteBuf += this.buf.slice(0, keep);
                    this.buf = this.buf.slice(keep);
                    return keys;
                }
                this.pasteBuf += this.buf.slice(0, end);
                this.buf = this.buf.slice(end + PASTE_END.length);
                this.pasting = false;
                keys.push({ name: "paste", paste: normalizeNewlines(this.pasteBuf) });
                this.pasteBuf = "";
                continue;
            }
            if (this.buf.startsWith(PASTE_START)) {
                this.buf = this.buf.slice(PASTE_START.length);
                this.pasting = true;
                continue;
            }
            const c = this.buf[0]!;
            if (c === "\x1b") {
                if (this.buf.length === 1) return keys; // wait for more (or flushEscape)
                const r = this.parseEscape();
                if (r === "incomplete") return keys;
                keys.push(...r);
                continue;
            }
            this.buf = this.buf.slice(1);
            const code = c.charCodeAt(0);
            if (c === "\r") keys.push({ name: "enter" });
            else if (c === "\n") keys.push({ name: "enter", ctrl: true });
            else if (c === "\t") keys.push({ name: "tab" });
            else if (c === "\x7f" || c === "\x08") keys.push({ name: "backspace" });
            else if (code === 0) keys.push({ name: "space", ctrl: true });
            else if (code < 27) keys.push({ name: String.fromCharCode(code + 96), ctrl: true });
            else if (code === 28) keys.push({ name: "\\", ctrl: true });
            else if (code === 29) keys.push({ name: "]", ctrl: true });
            else if (code === 31) keys.push({ name: "_", ctrl: true });
            else if (code < 32) continue;
            else {
                // Group consecutive printable characters into one text key.
                let text = c;
                // keep surrogate pairs together
                while (this.buf.length) {
                    const n = this.buf[0]!;
                    const nc = n.charCodeAt(0);
                    if (nc < 32 || n === "\x7f" || n === "\x1b") break;
                    text += n;
                    this.buf = this.buf.slice(1);
                }
                const last = keys[keys.length - 1];
                if (last?.name === "text" && last.text !== undefined) last.text += text;
                else keys.push({ name: "text", text });
            }
        }
        return keys;
    }

    private parseEscape(): Key[] | "incomplete" {
        const b = this.buf;
        const second = b[1]!;
        if (second === "[") {
            // CSI: params (0x30-0x3F), intermediates (0x20-0x2F), final (0x40-0x7E)
            let i = 2;
            while (i < b.length && b.charCodeAt(i) >= 0x30 && b.charCodeAt(i) <= 0x3f) i++;
            while (i < b.length && b.charCodeAt(i) >= 0x20 && b.charCodeAt(i) <= 0x2f) i++;
            if (i >= b.length) return b.length > 32 ? this.consumeGarbage() : "incomplete";
            const final = b[i]!;
            const params = b.slice(2, i);
            this.buf = b.slice(i + 1);
            if (b.startsWith(PASTE_START)) {
                this.pasting = true;
                return [];
            }
            return [this.csiKey(params, final)];
        }
        if (second === "O") {
            if (b.length < 3) return "incomplete";
            const final = b[2]!;
            this.buf = b.slice(3);
            const name = CSI_FINAL[final];
            return name ? [{ name }] : [];
        }
        if (second === "\x1b") {
            // ESC ESC: an escape, then process the rest normally
            this.buf = b.slice(1);
            return [{ name: "escape" }];
        }
        // Meta + key (Option as Meta on macOS).
        this.buf = b.slice(2);
        if (second === "\r") return [{ name: "enter", meta: true }];
        if (second === "\x7f" || second === "\x08") return [{ name: "backspace", meta: true }];
        const code = second.charCodeAt(0);
        if (code < 27 && code > 0) return [{ name: String.fromCharCode(code + 96), ctrl: true, meta: true }];
        return [{ name: second.toLowerCase(), meta: true, shift: second !== second.toLowerCase() || undefined }];
    }

    private consumeGarbage(): Key[] {
        this.buf = this.buf.slice(1);
        return [];
    }

    private csiKey(params: string, final: string): Key {
        const parts = params.split(";");
        if (final === "~") {
            const n = Number(parts[0]);
            if (n === 27 && parts.length >= 3) return codepointKey(Number(parts[2]), Number(parts[1]) || 1); // modifyOtherKeys
            const name = TILDE[n] ?? `unknown`;
            return { name, ...mods(Number(parts[1]) || 1) };
        }
        if (final === "u") {
            const cp = Number(parts[0]?.split(":")[0]);
            return codepointKey(cp, Number(parts[1]?.split(":")[0]) || 1);
        }
        if (final === "Z") return { name: "tab", shift: true };
        // Focus reporting (?1004): CSI I when the window gains focus, CSI O when it loses it.
        if (!params && (final === "I" || final === "O")) return { name: final === "I" ? "focus-in" : "focus-out" };
        const name = CSI_FINAL[final];
        if (name) return { name, ...mods(Number(parts[1]) || 1) };
        return { name: "unknown" };
    }
}

function normalizeNewlines(s: string): string {
    return s.replace(/\r\n?/g, "\n");
}

export function keyLabel(k: Key): string {
    if (k.name === "text") return k.text ?? "";
    return `${k.ctrl ? "ctrl+" : ""}${k.meta ? "meta+" : ""}${k.shift ? "shift+" : ""}${k.name}`;
}
