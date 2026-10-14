// Inline terminal renderer (no alternate screen): finished output is printed
// once and scrolls into the terminal's scrollback; a "live region" at the
// bottom (spinner, streaming text, prompt, dialogs) is redrawn in place.

import { cursor, sanitizeLine, termCols, termRows, truncate, width } from "./ansi";
import { KeyParser, type Key } from "./keys";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

export class Screen {
    private live: string[] = [];
    /** Rows the live region occupies on screen right now. */
    private liveRows = 0;
    private liveWidths: number[] = [];
    private pendingStatic: string[] = [];
    private scheduled = false;
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
        process.stdin.setRawMode(true);
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", this.dataListener);
        process.stdin.resume();
        process.stdout.on("resize", this.resizeListener);
        // bracketed paste on, cursor hidden (we draw our own)
        process.stdout.write("\x1b[?2004h" + cursor.hide);
    }

    stop() {
        if (!this.started) return;
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
            this.liveRows = 0;
            this.render();
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
        // Rows the old live region takes after the terminal reflowed it.
        const cols = termCols();
        this.liveRows = this.liveWidths.reduce((n, w) => n + Math.max(1, Math.ceil(w / cols)), 0);
        this.resizeHandler?.();
        this.render();
    }

    /** Append finished lines above the live region. */
    print(lines: string | string[]) {
        const arr = (typeof lines === "string" ? lines.split("\n") : lines).map(sanitizeLine);
        if (!this.interactive) {
            process.stdout.write(arr.join("\n") + "\n");
            return;
        }
        this.pendingStatic.push(...arr);
        this.schedule();
    }

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

    /** Clear the visible screen and scrollback, then redraw the live region at the top. */
    clearScreen() {
        if (!this.interactive) return;
        this.pendingStatic = [];
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
        this.liveRows = 0;
        this.liveWidths = [];
        this.render();
    }

    private clearLive() {
        if (!this.interactive || this.liveRows === 0) return;
        process.stdout.write("\r" + cursor.up(this.liveRows - 1) + cursor.clearDown);
        this.liveRows = 0;
        this.liveWidths = [];
    }

    render() {
        if (!this.interactive || this.suspended) return;
        const cols = termCols();
        const rows = termRows();
        let out = SYNC_START;
        if (this.liveRows > 0) out += "\r" + cursor.up(this.liveRows - 1) + cursor.clearDown;
        else out += "\r";
        if (this.pendingStatic.length) {
            out += this.pendingStatic.map((l) => l + "\x1b[0m").join("\n") + "\n";
            this.pendingStatic = [];
        }
        // Keep the live region within the screen so we can always move back to its top.
        let live = this.live;
        if (live.length > rows - 1) live = live.slice(live.length - (rows - 1));
        const fitted = live.map((l) => (width(l) > cols - 1 ? truncate(l, cols - 1) : l));
        out += fitted.map((l) => l + "\x1b[0m").join("\n");
        out += SYNC_END;
        process.stdout.write(out);
        this.liveRows = fitted.length;
        this.liveWidths = fitted.map((l) => width(l));
    }
}
