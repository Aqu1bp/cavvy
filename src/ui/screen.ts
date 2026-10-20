// Terminal renderer. The harness takes over the whole window: output fills it
// from the top and the "live region" (streaming text, running tools, spinner,
// prompt, dialogs and footer) follows it with no gap, redrawn in place; the
// rows it doesn't need stay empty below it. Finished
// output scrolls into the terminal's own scrollback, so scrolling, selecting
// and copying work as usual (no alternate screen).
//
// Everything printed is kept. When the terminal is resized, the screen and
// scrollback are cleared and the output is laid out again at the new width;
// guessing how the terminal re-wrapped what was already there doesn't work.

import { cursor, sanitizeLine, termCols, termRows, truncate, width, wrapLine } from "./ansi";
import { KeyParser, type Key } from "./keys";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const RESET = "\x1b[0m";
/**
 * Bracketed paste, plus the kitty keyboard protocol's "disambiguate" flag so
 * shift+enter and friends arrive as distinct keys. Terminals without the
 * protocol ignore the push and the pop.
 */
const KEYS_ON = "\x1b[?2004h\x1b[>1u";
const KEYS_OFF = "\x1b[?2004l\x1b[<u";
/** Home, clear the screen, then the scrollback (which some terminals fill on a clear). */
const CLEAR_ALL = "\x1b[H\x1b[2J\x1b[3J";
/** Focus reporting: the terminal sends CSI I / CSI O when the window gains or loses focus. */
const FOCUS_ON = "\x1b[?1004h";
const FOCUS_OFF = "\x1b[?1004l";
/** Rows laid out again after a resize; older output stays in the transcript. */
const MAX_REDRAW_ROWS = 10_000;
const MAX_ENTRIES = 20_000;

/** Lines to print, or a function that lays them out for a given width (re-run after a resize). */
export type Printable = string | string[] | ((cols: number) => string[]);

/** One print() call. Opaque outside this file. */
export interface Entry {
    lines?: string[];
    render?: (cols: number) => string[];
    laid?: { cols: number; rows: string[] };
}

export class Screen {
    private live: string[] = [];
    /** Rows the live region occupies on screen right now. */
    private liveRows = 0;
    /** Paint the screen again on the next draw if the region left empty rows (see settle). */
    private settlePending = false;
    /**
     * Output rows at the top of the screen that are also the last rows of the scrollback: brought
     * back by a fill. They're dropped in place rather than scrolled into the scrollback again.
     */
    private restored = 0;
    private log: Entry[] = [];
    /** Printed but not drawn yet. */
    private pending: Entry[] = [];
    /** Screen row (0-based) the live region starts on, right after the output. */
    private top = 0;
    private scheduled = false;
    private redrawPending = false;
    private resizeTimer?: ReturnType<typeof setTimeout>;
    private resizeSince?: number;
    private parser = new KeyParser();
    private escTimer: ReturnType<typeof setTimeout> | undefined;
    private keyHandler?: (k: Key) => void;
    private resizeHandler?: () => void;
    private started = false;
    private suspended = false;
    /** Whether the terminal window has focus; undefined until the terminal says. */
    focus: boolean | undefined;
    readonly interactive: boolean;
    private dataListener = (d: string | Buffer) => this.onData(typeof d === "string" ? d : d.toString("utf-8"));
    private resizeListener = () => this.onResize();

    constructor() {
        this.interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    }

    start(onKey: (k: Key) => void, onResize?: () => void) {
        this.keyHandler = onKey;
        this.resizeHandler = onResize;
        if (!this.interactive || this.started) return;
        this.started = true;
        process.stdin.setRawMode(true);
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", this.dataListener);
        process.stdin.resume();
        process.stdout.on("resize", this.resizeListener);
        // key reporting on, cursor hidden (we draw our own), and the window is ours
        process.stdout.write(KEYS_ON + cursor.hide + CLEAR_ALL);
        this.top = 0;
        this.liveRows = 0;
        this.restored = 0;
        this.setFocusReporting(true);
    }

    stop() {
        if (!this.started) return;
        clearTimeout(this.resizeTimer);
        this.redrawPending = false;
        this.flushNow();
        this.setFocusReporting(false);
        this.started = false;
        process.stdin.off("data", this.dataListener);
        process.stdout.off("resize", this.resizeListener);
        try {
            process.stdin.setRawMode(false);
        } catch {
            // ignore
        }
        process.stdin.pause();
        process.stdout.write(KEYS_OFF + cursor.show);
    }

    /** Temporarily hand the terminal to a child process (external editor). */
    async suspend<T>(fn: () => Promise<T> | T): Promise<T> {
        this.clearLive();
        this.suspended = true;
        const wasStarted = this.started;
        if (wasStarted) {
            this.setFocusReporting(false);
            process.stdin.off("data", this.dataListener);
            process.stdin.setRawMode(false);
            process.stdout.write(KEYS_OFF + cursor.show);
        }
        try {
            return await fn();
        } finally {
            if (wasStarted) {
                this.setFocusReporting(true);
                process.stdin.setRawMode(true);
                process.stdin.on("data", this.dataListener);
                process.stdin.resume();
                process.stdout.write(KEYS_ON + cursor.hide);
            }
            this.suspended = false;
            // Whatever the child drew is gone after this.
            this.redraw();
        }
    }

    private onData(d: string) {
        if (this.escTimer) {
            clearTimeout(this.escTimer);
            this.escTimer = undefined;
        }
        for (const k of this.parser.feed(d)) {
            // Focus changes are tracked here and never reach the input.
            if (k.name === "focus-in" || k.name === "focus-out") this.focus = k.name === "focus-in";
            else this.keyHandler?.(k);
        }
        if (this.parser.pendingEscape) {
            this.escTimer = setTimeout(() => {
                this.escTimer = undefined;
                for (const k of this.parser.flushEscape()) this.keyHandler?.(k);
            }, 40);
        }
    }

    /** Turn focus reporting on or off (off whenever another program gets the terminal). */
    private setFocusReporting(on: boolean) {
        if (!this.started) return;
        process.stdout.write(on ? FOCUS_ON : FOCUS_OFF);
        // Changes while it was off went unreported.
        this.focus = undefined;
    }

    private onResize() {
        // The terminal has already re-wrapped the screen its own way; draw nothing
        // until the size settles (at most every 150ms while a window is dragged).
        this.redrawPending = true;
        const now = Date.now();
        this.resizeSince ??= now;
        clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(
            () => {
                this.resizeSince = undefined;
                this.redrawPending = false;
                this.resizeHandler?.();
                this.redraw();
            },
            now - this.resizeSince >= 150 ? 0 : 40,
        );
    }

    /** Append finished output above the live region. Returns a handle for replace(). */
    print(content: Printable): Entry {
        const entry = toEntry(content);
        if (!this.interactive) {
            const lines = entry.lines ?? safeRender(entry.render!, termCols()).map(sanitizeLine);
            process.stdout.write(lines.join("\n") + "\n");
            return entry;
        }
        this.log.push(entry);
        if (this.log.length > MAX_ENTRIES) this.log.splice(0, this.log.length - MAX_ENTRIES);
        this.pending.push(entry);
        this.schedule();
        return entry;
    }

    /**
     * Swap already-printed entries for one that can be laid out again (say,
     * streamed lines for the whole message). What's on screen stays as it is;
     * the new entry is used from the next resize on.
     */
    replace(entries: Entry[], content: Printable) {
        if (!entries.length || !this.interactive) return;
        if (entries.some((e) => this.pending.includes(e))) this.flushNow();
        const idx = this.log.indexOf(entries[0]!);
        if (idx < 0) return;
        const drop = new Set(entries);
        const next = toEntry(content);
        this.log = [...this.log.slice(0, idx).filter((e) => !drop.has(e)), next, ...this.log.slice(idx).filter((e) => !drop.has(e))];
    }

    /**
     * The live region, right after the output: when it grows (a spinner, a running tool) it takes
     * the empty rows below it, and when it shrinks the prompt moves back up to the output.
     */
    setLive(lines: string[]) {
        // One entry per terminal row, or the redraw loses track of the region's height.
        this.live = lines.flatMap((l) => sanitizeLine(l).split("\n"));
        this.schedule();
    }

    private schedule() {
        if (this.scheduled) return;
        this.scheduled = true;
        setTimeout(() => {
            this.scheduled = false;
            this.render();
        }, 16);
    }

    flushNow() {
        this.scheduled = false;
        this.render();
    }

    /**
     * The screen painted again from the top: the newest output rows that fit above the live
     * region, then the region. Undefined when no empty rows would be left under the region, or
     * nothing more is out of sight above. Rows are overwritten in place, never cleared as a
     * screen, so nothing extra goes to the scrollback; the rows brought back are already in it.
     */
    private fill(cols: number, rows: number): string | undefined {
        // Nothing to sit on the bottom rows (it's stopping): the output just ends where it is.
        if (!this.live.length) return undefined;
        const pendingRows = this.pending.reduce((n, e) => n + this.layout(e, cols).length, 0);
        const end = Math.min(this.top + pendingRows, rows - 1);
        const room = rows - Math.min(this.live.length, rows - 1);
        if (end >= room) return undefined;
        const tail: string[] = [];
        for (let i = this.log.length - 1; i >= 0 && tail.length < room; i--) tail.unshift(...this.layout(this.log[i]!, cols));
        const shown = tail.slice(-room);
        if (shown.length <= end) return undefined;
        this.pending = [];
        this.restored = Math.min(shown.length, this.restored + shown.length - end);
        const output = shown.map((l) => cursor.clearLine + l + RESET).join("\n") + "\n";
        return SYNC_START + "\x1b[H" + output + cursor.clearDown + this.drawLive(shown.length, cols, rows) + SYNC_END;
    }

    /**
     * Before a draw that would scroll rows brought back by a fill into the scrollback again: paint
     * the screen in place without as many of them as would scroll, so only new rows scroll.
     * Leaves the cursor where the live region starts, with the region erased.
     */
    private dropRestored(cols: number, rows: number): string {
        if (!this.restored || !this.live.length) return "";
        const pendingRows = this.pending.reduce((n, e) => n + this.layout(e, cols).length, 0);
        const scroll = Math.max(0, this.top + pendingRows + Math.min(this.live.length, rows - 1) - rows);
        const drop = Math.min(scroll, this.restored, this.top);
        if (!drop) return "";
        // What's on screen above the live region: the newest output rows printed so far (pending ones are last in the log).
        const pending = new Set(this.pending);
        const visible: string[] = [];
        for (let i = this.log.length - 1; i >= 0 && visible.length < this.top; i--) {
            if (!pending.has(this.log[i]!)) visible.unshift(...this.layout(this.log[i]!, cols));
        }
        const kept = visible.slice(-this.top).slice(drop);
        this.top -= drop;
        this.restored -= drop;
        this.liveRows = 0;
        return "\x1b[H" + kept.map((l) => cursor.clearLine + l + RESET + "\n").join("") + cursor.clearDown;
    }

    /** Clear the screen, the scrollback and everything printed so far. */
    clearScreen() {
        if (!this.interactive) return;
        this.log = [];
        this.pending = [];
        this.redraw();
    }

    private clearLive() {
        if (!this.interactive || this.liveRows === 0) return;
        process.stdout.write("\r" + cursor.up(this.liveRows - 1) + cursor.clearDown);
        this.liveRows = 0;
    }

    /** Rows for one entry at this width, each exactly one terminal row. */
    private layout(e: Entry, cols: number): string[] {
        if (e.laid?.cols === cols) return e.laid.rows;
        const src = e.lines ?? safeRender(e.render!, cols).flatMap((l) => sanitizeLine(l).split("\n"));
        // A row may fill the line: the newline after it ends the line without an extra wrap.
        const rows = src.flatMap((l) => (width(l) > cols ? wrapLine(l, cols) : [l]));
        e.laid = { cols, rows };
        return rows;
    }

    /** The live region, starting on screen row `from` (0-based). Records where it landed. */
    private drawLive(from: number, cols: number, rows: number): string {
        // Keep it within the screen so we can always move back to its top.
        const live = this.live.length > rows - 1 ? this.live.slice(this.live.length - (rows - 1)) : this.live;
        const block = live.map((l) => (width(l) > cols - 1 ? truncate(l, cols - 1) : l));
        // Rows past the bottom scroll the screen up.
        const scrolled = Math.max(0, from + block.length - rows);
        this.top = from - scrolled;
        this.liveRows = block.length;
        return block.map((l) => l + RESET).join("\n");
    }

    /**
     * At the end of a turn: if the live region has shrunk and left empty rows under it while
     * earlier output is out of sight above, the next draw paints the screen again from the
     * newest output down, so the output reaches the prompt and the prompt sits on the bottom rows.
     */
    settle() {
        this.settlePending = true;
        this.schedule();
    }

    render() {
        if (!this.interactive || this.suspended || this.redrawPending) return;
        const cols = termCols();
        const rows = termRows();
        if (this.settlePending) {
            this.settlePending = false;
            const filled = this.fill(cols, rows);
            if (filled) return void process.stdout.write(filled);
        }
        let out = SYNC_START + this.dropRestored(cols, rows);
        if (this.liveRows > 0) out += "\r" + cursor.up(this.liveRows - 1) + cursor.clearDown;
        else out += "\r";
        let row = this.top;
        if (this.pending.length) {
            const printed = this.pending.flatMap((e) => this.layout(e, cols));
            this.pending = [];
            out += printed.map((l) => l + RESET).join("\n") + "\n";
            row = Math.min(row + printed.length, rows - 1);
        }
        out += this.drawLive(row, cols, rows);
        out += SYNC_END;
        process.stdout.write(out);
    }

    /** Clear the screen and scrollback and lay everything out again at the current size. */
    redraw() {
        if (!this.interactive || this.suspended) return;
        this.scheduled = false;
        const cols = termCols();
        const rows = termRows();
        // The newest output first, back to the row limit.
        const chunks: string[][] = [];
        let count = 0;
        let i = this.log.length - 1;
        for (; i >= 0 && count < MAX_REDRAW_ROWS; i--) {
            const r = this.layout(this.log[i]!, cols);
            chunks.push(r);
            count += r.length;
        }
        let printed = chunks.reverse().flat();
        if (i >= 0 || printed.length > MAX_REDRAW_ROWS) {
            printed = ["\x1b[2m… earlier output isn't shown again after a resize (/export saves the whole conversation)\x1b[22m", ...printed.slice(-MAX_REDRAW_ROWS)];
        }
        this.pending = [];
        // The scrollback is cleared too: nothing on screen is in it.
        this.restored = 0;
        let out = SYNC_START + CLEAR_ALL;
        if (printed.length) out += printed.map((l) => l + RESET).join("\n") + "\n";
        out += this.drawLive(Math.min(printed.length, rows - 1), cols, rows);
        out += SYNC_END;
        process.stdout.write(out);
    }
}

function toEntry(content: Printable): Entry {
    if (typeof content === "function") return { render: content };
    // Split embedded newlines so each line is one row.
    return { lines: (typeof content === "string" ? [content] : content).flatMap((l) => sanitizeLine(l).split("\n")) };
}

function safeRender(fn: (cols: number) => string[], cols: number): string[] {
    try {
        return fn(cols);
    } catch (e) {
        return [`(couldn't draw this output: ${(e as Error).message})`];
    }
}
