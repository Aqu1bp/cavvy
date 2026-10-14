// Terminal renderer. The harness takes over the whole window: output fills it
// from the top and the "live region" (streaming text and running tools right
// after the output; spinner, prompt, dialogs and footer pinned to the bottom)
// is redrawn in place. Finished
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
/** Home, clear the screen, then the scrollback (which some terminals fill on a clear). */
const CLEAR_ALL = "\x1b[H\x1b[2J\x1b[3J";
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
    /** Leading live lines that go right after the output, before the gap. */
    private liveFlow = 0;
    /** Rows the live region (with its gap) occupies on screen right now. */
    private liveRows = 0;
    private log: Entry[] = [];
    /** Printed but not drawn yet. */
    private pending: Entry[] = [];
    /** Screen row (0-based) the live region starts on, right after the output. */
    private top = 0;
    /** Fill the space below the output so the live region sits at the bottom. */
    private pinned = true;
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
        this.pinned = true;
        process.stdin.setRawMode(true);
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", this.dataListener);
        process.stdin.resume();
        process.stdout.on("resize", this.resizeListener);
        // bracketed paste on, cursor hidden (we draw our own), and the window is ours
        process.stdout.write("\x1b[?2004h" + cursor.hide + CLEAR_ALL);
        this.top = 0;
        this.liveRows = 0;
    }

    stop() {
        if (!this.started) return;
        clearTimeout(this.resizeTimer);
        this.redrawPending = false;
        // No gap below the output: the shell prompt goes right after it.
        this.pinned = false;
        this.flushNow();
        this.started = false;
        process.stdin.off("data", this.dataListener);
        process.stdout.off("resize", this.resizeListener);
        try {
            process.stdin.setRawMode(false);
        } catch {
            // ignore
        }
        process.stdin.pause();
        process.stdout.write("\x1b[?2004l" + cursor.show);
    }

    /** Temporarily hand the terminal to a child process (external editor). */
    async suspend<T>(fn: () => Promise<T> | T): Promise<T> {
        this.clearLive();
        this.suspended = true;
        const wasStarted = this.started;
        if (wasStarted) {
            process.stdin.off("data", this.dataListener);
            process.stdin.setRawMode(false);
            process.stdout.write("\x1b[?2004l" + cursor.show);
        }
        try {
            return await fn();
        } finally {
            if (wasStarted) {
                process.stdin.setRawMode(true);
                process.stdin.on("data", this.dataListener);
                process.stdin.resume();
                process.stdout.write("\x1b[?2004h" + cursor.hide);
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
        for (const k of this.parser.feed(d)) this.keyHandler?.(k);
        if (this.parser.pendingEscape) {
            this.escTimer = setTimeout(() => {
                this.escTimer = undefined;
                for (const k of this.parser.flushEscape()) this.keyHandler?.(k);
            }, 40);
        }
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
     * The live region. Its first `flow` lines continue the output (a reply
     * still streaming, a running tool); the blank space that keeps the rest
     * on the bottom rows goes after them.
     */
    setLive(lines: string[], flow = 0) {
        // One entry per terminal row, or the redraw loses track of the region's height.
        const split = (ls: string[]) => ls.flatMap((l) => sanitizeLine(l).split("\n"));
        const head = split(lines.slice(0, flow));
        this.live = [...head, ...split(lines.slice(flow))];
        this.liveFlow = head.length;
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

    /**
     * The live region, starting on screen row `from` (0-based), with blank rows
     * after its flowing part so it ends on the last row. Records where it landed.
     */
    private drawLive(from: number, cols: number, rows: number): string {
        let live = this.live;
        let flow = this.liveFlow;
        // Keep it within the screen so we can always move back to its top.
        if (live.length > rows - 1) {
            const cut = live.length - (rows - 1);
            live = live.slice(cut);
            flow = Math.max(0, flow - cut);
        }
        const fitted = live.map((l) => (width(l) > cols - 1 ? truncate(l, cols - 1) : l));
        const gap = this.pinned && fitted.length ? Math.max(0, rows - from - fitted.length) : 0;
        const block = [...fitted.slice(0, flow), ...Array<string>(gap).fill(""), ...fitted.slice(flow)];
        // Rows past the bottom scroll the screen up.
        const scrolled = Math.max(0, from + block.length - rows);
        this.top = from - scrolled;
        this.liveRows = block.length;
        return block.map((l) => l + RESET).join("\n");
    }

    render() {
        if (!this.interactive || this.suspended || this.redrawPending) return;
        const cols = termCols();
        const rows = termRows();
        let out = SYNC_START;
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
