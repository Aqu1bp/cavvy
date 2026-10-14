// Low-level terminal styling and text-measurement helpers.
// Everything that touches escape codes or visual width lives here so the rest
// of the UI can work with plain "styled strings".

const env = process.env;

export const colorEnabled = (() => {
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
    if (env.FORCE_COLOR === "0") return false;
    if (env.FORCE_COLOR) return true;
    return Boolean(process.stdout.isTTY);
})();

const trueColor =
    /truecolor|24bit/i.test(env.COLORTERM ?? "") ||
    ["iTerm.app", "WezTerm", "vscode", "ghostty"].includes(env.TERM_PROGRAM ?? "") ||
    Boolean(env.KITTY_WINDOW_ID);

type Style = (s: string) => string;

function make(open: string, close: string): Style {
    if (!colorEnabled) return (s) => s;
    return (s: string) => {
        if (s === "") return s;
        // Re-open the style after any nested close of the same kind so that
        // nesting e.g. red(`a ${blue("b")} c`) keeps "c" red.
        const inner = s.includes(close) ? s.split(close).join(close + open) : s;
        return open + inner + close;
    };
}

function to256(r: number, g: number, b: number): number {
    if (r === g && g === b) {
        if (r < 8) return 16;
        if (r > 248) return 231;
        return Math.round(((r - 8) / 247) * 24) + 232;
    }
    const q = (v: number) => Math.round((v / 255) * 5);
    return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

export function fg(hex: string): Style {
    const [r, g, b] = hexToRgb(hex);
    const open = trueColor ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${to256(r, g, b)}m`;
    return make(open, "\x1b[39m");
}

export function bg(hex: string): Style {
    const [r, g, b] = hexToRgb(hex);
    const open = trueColor ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[48;5;${to256(r, g, b)}m`;
    return make(open, "\x1b[49m");
}

function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export const bold = make("\x1b[1m", "\x1b[22m");
export const dim = make("\x1b[2m", "\x1b[22m");
export const italic = make("\x1b[3m", "\x1b[23m");
export const underline = make("\x1b[4m", "\x1b[24m");
export const inverse = make("\x1b[7m", "\x1b[27m");
export const strike = make("\x1b[9m", "\x1b[29m");

// Theme. One place to tweak the look of the whole app.
export const theme = {
    accent: fg("#D97757"),
    accentBg: bg("#D97757"),
    text: (s: string) => s,
    muted: fg("#8A8A8A"),
    subtle: fg("#5F5F5F"),
    success: fg("#4EBA65"),
    error: fg("#FF6B80"),
    warning: fg("#FFC107"),
    info: fg("#7AB4E8"),
    code: fg("#B1B9F9"),
    link: fg("#7AB4E8"),
    heading: fg("#E5C07B"),
    user: fg("#C0C0C0"),
    permission: fg("#B1B9F9"),
    planMode: fg("#48968C"),
    acceptEdits: fg("#AF87FF"),
    autoMode: fg("#E0B94F"),
    bypass: fg("#FF6B80"),
    bashMode: fg("#FD5DB1"),
    memoryMode: fg("#7AB4E8"),
    diffAdded: bg("#225C2B"),
    diffRemoved: bg("#7A2936"),
    diffAddedWord: bg("#38A660"),
    diffRemovedWord: bg("#B3596B"),
    diffAddedFg: fg("#4EBA65"),
    diffRemovedFg: fg("#FF6B80"),
    // syntax highlighting
    synKeyword: fg("#C678DD"),
    synString: fg("#98C379"),
    synNumber: fg("#D19A66"),
    synComment: fg("#7F848E"),
    synFunc: fg("#61AFEF"),
    synType: fg("#E5C07B"),
    synPunct: fg("#ABB2BF"),
};

// ---------------------------------------------------------------------------
// Measurement

// Any escape sequence: CSI, OSC, DCS/SOS/PM/APC strings, and two/three-byte
// escapes (ESC c, ESC 7, ESC ( B, ...). A lone trailing ESC matches too.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[ -/]*[0-~]?/g;
// The only sequences the UI itself puts inside lines: SGR colors and OSC 8 links.
// eslint-disable-next-line no-control-regex
const SAFE_ESC_RE = /^(?:\x1b\[[0-9;:]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))$/;

export function stripAnsi(s: string): string {
    return s.replace(ANSI_RE, "");
}

/**
 * Make text safe to write to the terminal: keep colors and hyperlinks, drop
 * every other escape sequence and control character (cursor movement, screen
 * clears, terminal resets, title/clipboard OSCs, stray \r), and expand tabs.
 * Model output, tool output and MCP text all pass through here on the way out.
 */
export function sanitizeLine(s: string): string {
    // eslint-disable-next-line no-control-regex
    if (!/[\x00-\x1f\x7f-\x9f]/.test(s)) return s;
    return (
        s
            // Kept links get the ST terminator so the BEL form (`ls --hyperlink`)
            // survives the control-character pass below.
            .replace(ANSI_RE, (m) => (SAFE_ESC_RE.test(m) ? m.replace(/\x07$/, "\x1b\\") : ""))
            .replace(/\t/g, "    ")
            // eslint-disable-next-line no-control-regex
            .replace(/[\x00-\x09\x0b-\x1a\x1c-\x1f\x7f-\x9f]/g, "")
    );
}

/** Visible columns, measured the way sanitizeLine will print it (escapes 0, tabs 4). */
export function width(s: string): number {
    // eslint-disable-next-line no-control-regex
    // Bun measures CSI (colors) itself; strip only what it miscounts.
    if (/\x1b[^[]|\t/.test(s)) s = stripAnsi(s).replace(/\t/g, "    ");
    return Bun.stringWidth(s);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type Token = { esc: true; value: string } | { esc: false; value: string; w: number };

function tokenize(s: string): Token[] {
    const out: Token[] = [];
    let last = 0;
    ANSI_RE.lastIndex = 0;
    for (const m of s.matchAll(ANSI_RE)) {
        const idx = m.index ?? 0;
        if (idx > last) pushText(out, s.slice(last, idx));
        out.push({ esc: true, value: m[0] });
        last = idx + m[0].length;
    }
    if (last < s.length) pushText(out, s.slice(last));
    return out;
}

function pushText(out: Token[], text: string) {
    // Fast path for plain ASCII.
    if (/^[\x20-\x7e]*$/.test(text)) {
        for (const ch of text) out.push({ esc: false, value: ch, w: 1 });
        return;
    }
    for (const { segment } of segmenter.segment(text)) {
        if (segment === "\t") {
            out.push({ esc: false, value: "    ", w: 4 });
            continue;
        }
        out.push({ esc: false, value: segment, w: Bun.stringWidth(segment) });
    }
}

// Tracks SGR state so wrapped/truncated lines can re-open styles.
class SgrState {
    private codes: string[] = [];
    apply(code: string) {
        if (!code.startsWith("\x1b[") || !code.endsWith("m")) return;
        const params = code.slice(2, -1);
        if (params === "" || params === "0") {
            this.codes = [];
            return;
        }
        this.codes.push(code);
        if (this.codes.length > 16) this.codes = this.codes.slice(-16);
    }
    open(): string {
        return this.codes.join("");
    }
    snapshot(): string[] {
        return [...this.codes];
    }
    restore(codes: string[]) {
        this.codes = [...codes];
    }
    active(): boolean {
        return this.codes.length > 0;
    }
}

const RESET = colorEnabled ? "\x1b[0m" : "";

/** True for an OSC 8 sequence that opens a link (a non-empty URL). */
function opensLink(esc: string): boolean | undefined {
    const m = esc.match(/^\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)/);
    return m ? m[1] !== "" : undefined;
}
const LINK_CLOSE = "\x1b]8;;\x1b\\";

/** Truncate to a visual width, appending an ellipsis if cut. ANSI-safe. */
export function truncate(s: string, max: number, ellipsis = "…"): string {
    if (max <= 0) return "";
    if (width(s) <= max) return s;
    const ew = width(ellipsis);
    const tokens = tokenize(s);
    let w = 0;
    let out = "";
    let linkOpen = false;
    for (const t of tokens) {
        if (t.esc) {
            out += t.value;
            const l = opensLink(t.value);
            if (l !== undefined) linkOpen = l;
            continue;
        }
        if (w + t.w > max - ew) break;
        out += t.value;
        w += t.w;
    }
    // A cut inside a hyperlink would otherwise leave it open for the rest of the row.
    return out + (linkOpen ? LINK_CLOSE : "") + RESET + ellipsis;
}

/**
 * Word-wrap a single logical line to `cols` visual columns. ANSI-aware: styles
 * are closed at the end of each output line and re-opened on the next one.
 * `indent` is prefixed to continuation lines (and counts toward the width).
 */
export function wrapLine(line: string, cols: number, indent = ""): string[] {
    if (cols <= 1) return [line];
    if (width(line) <= cols) return [line];
    // An indent that leaves no room for text is dropped rather than overflowing.
    if (width(indent) > cols - 2) indent = "";
    const indentW = width(indent);
    const tokens = tokenize(line);
    const lines: string[] = [];
    const state = new SgrState();
    let start = 0; // token index where the current output line starts
    let startState = ""; // SGR codes open at `start`
    let w = 0; // visible width of tokens[start..i)
    let brk = -1; // token index of the last space we can break at
    let brkCodes: string[] = [];
    let first = true;

    const emit = (from: number, to: number, last = false) => {
        let body = startState;
        for (let k = from; k < to; k++) body += tokens[k]!.value;
        lines.push((first ? "" : indent) + body + (!last && body.includes("\x1b[") ? RESET : ""));
        first = false;
    };

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (t.esc) {
            state.apply(t.value);
            continue;
        }
        const limit = first ? cols : cols - indentW;
        // `w > 0`: a token wider than the whole line still goes somewhere.
        if (w > 0 && w + t.w > limit) {
            if (t.value === " ") {
                // Break right here, swallowing the space.
                emit(start, i);
                startState = state.open();
                start = i + 1;
                w = 0;
                brk = -1;
                continue;
            }
            if (brk >= 0) {
                // Break at the last space and re-scan what followed it, which
                // may itself need wrapping at the (narrower) continuation width.
                emit(start, brk);
                state.restore(brkCodes);
                startState = state.open();
                start = brk + 1;
                w = 0;
                i = brk;
                brk = -1;
                continue;
            }
            emit(start, i);
            startState = state.open();
            start = i;
            w = 0;
        }
        // Only a space with text before it on this line is a useful break.
        if (t.value === " " && w > 0) {
            brk = i;
            brkCodes = state.snapshot();
        }
        w += t.w;
    }
    const rest = tokens.slice(start);
    if (rest.some((t) => !t.esc) || lines.length === 0) emit(start, tokens.length, true);
    // Only escapes left (a reset, a link closer): keep them, but no empty row.
    else if (rest.length) lines[lines.length - 1] += rest.map((t) => t.value).join("");
    return lines;
}

/** Wrap multi-line text. */
export function wrapText(text: string, cols: number, indent = ""): string[] {
    const out: string[] = [];
    for (const line of text.split("\n")) out.push(...wrapLine(line, cols, indent));
    return out;
}

/** Pad a styled string with spaces to a visual width. */
export function padEnd(s: string, w: number): string {
    const cur = width(s);
    return cur >= w ? s : s + " ".repeat(w - cur);
}

export function padStart(s: string, w: number): string {
    const cur = width(s);
    return cur >= w ? s : " ".repeat(w - cur) + s;
}

export function termCols(): number {
    return Math.max(20, process.stdout.columns || 100);
}

export function termRows(): number {
    return Math.max(10, process.stdout.rows || 40);
}

// Cursor / screen control
export const cursor = {
    up: (n = 1) => (n > 0 ? `\x1b[${n}A` : ""),
    down: (n = 1) => (n > 0 ? `\x1b[${n}B` : ""),
    col: (n: number) => `\x1b[${n + 1}G`,
    hide: "\x1b[?25l",
    show: "\x1b[?25h",
    clearDown: "\x1b[J",
    clearLine: "\x1b[2K",
    save: "\x1b7",
    restore: "\x1b8",
};
