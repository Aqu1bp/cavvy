// Multi-line prompt editor model: text, cursor, history, kill ring, undo,
// and paste placeholders. Rendering produces wrapped lines with a fake cursor.

import { width, inverse, theme } from "./ansi";

const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(s: string): { index: number; segment: string }[] {
    return [...seg.segment(s)].map((g) => ({ index: g.index, segment: g.segment }));
}

function prevBoundary(s: string, i: number): number {
    if (i <= 0) return 0;
    let prev = 0;
    for (const g of seg.segment(s)) {
        if (g.index >= i) break;
        prev = g.index;
    }
    return prev;
}

function nextBoundary(s: string, i: number): number {
    if (i >= s.length) return s.length;
    for (const g of seg.segment(s)) {
        if (g.index > i) return g.index;
    }
    return s.length;
}

const WORD = /[\p{L}\p{N}_]/u;

export interface RenderedInput {
    lines: string[];
    cursorRow: number;
}

export class Editor {
    text = "";
    cursor = 0;
    /** Mask input (API keys). */
    secret = false;
    private history: string[] = [];
    private histIdx = -1;
    private draft = "";
    private killRing = "";
    private undoStack: { text: string; cursor: number }[] = [];
    private pastes = new Map<number, string>();
    private pasteCounter = 0;
    private lastWasInsert = false;
    /** Where the last insert left the editor; typing only coalesces from exactly there. */
    private insertMark = { cursor: -1, length: -1 };

    setHistory(h: string[]) {
        this.history = [...h];
        this.histIdx = -1;
    }

    pushHistory(entry: string) {
        if (!entry.trim()) return;
        if (this.history[this.history.length - 1] !== entry) this.history.push(entry);
        if (this.history.length > 1000) this.history.shift();
        this.histIdx = -1;
    }

    private snapshot(coalesce = false) {
        // Any move or edit since the last insert (home, word jumps, kills...) starts a new undo step.
        if (coalesce && this.lastWasInsert && this.cursor === this.insertMark.cursor && this.text.length === this.insertMark.length) return;
        this.undoStack.push({ text: this.text, cursor: this.cursor });
        if (this.undoStack.length > 200) this.undoStack.shift();
    }

    set(text: string, cursor = text.length) {
        this.text = text;
        this.cursor = Math.max(0, Math.min(cursor, text.length));
        this.lastWasInsert = false;
    }

    clear() {
        this.snapshot();
        this.set("");
        this.prunePastes();
        this.histIdx = -1;
    }

    /** Drop pasted text nothing can bring back; undo (or a yank) can restore a placeholder. */
    private prunePastes() {
        const live = new Set<number>();
        for (const t of [this.text, this.draft, this.killRing, ...this.undoStack.map((u) => u.text)]) {
            for (const m of t.matchAll(/\[Pasted text #(\d+) \+\d+ lines\]/g)) live.add(Number(m[1]));
        }
        for (const id of this.pastes.keys()) if (!live.has(id)) this.pastes.delete(id);
    }

    get isEmpty(): boolean {
        return this.text.length === 0;
    }

    insert(s: string) {
        if (!s) return;
        this.snapshot(true);
        this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor);
        this.cursor += s.length;
        this.lastWasInsert = !/\s/.test(s);
        this.insertMark = { cursor: this.cursor, length: this.text.length };
        this.histIdx = -1;
    }

    /** Large pastes collapse into a placeholder that expands on submit. */
    paste(s: string) {
        this.lastWasInsert = false; // a paste is its own undo step
        const lines = s.split("\n").length;
        if (!this.secret && (lines > 8 || s.length > 1500)) {
            const id = ++this.pasteCounter;
            this.pastes.set(id, s);
            this.insert(`[Pasted text #${id} +${lines} lines]`);
        } else this.insert(this.secret ? s.replace(/\s+/g, "") : s);
        this.lastWasInsert = false;
    }

    /** Final text with paste placeholders expanded. */
    value(): string {
        return this.text.replace(/\[Pasted text #(\d+) \+\d+ lines\]/g, (m, id) => this.pastes.get(Number(id)) ?? m);
    }

    backspace() {
        if (this.cursor === 0) return;
        this.snapshot();
        // Delete a whole paste placeholder at once.
        const before = this.text.slice(0, this.cursor);
        const ph = before.match(/\[Pasted text #\d+ \+\d+ lines\]$/);
        const start = ph ? this.cursor - ph[0].length : prevBoundary(this.text, this.cursor);
        this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
        this.cursor = start;
        this.lastWasInsert = false;
    }

    del() {
        if (this.cursor >= this.text.length) return;
        this.snapshot();
        const end = nextBoundary(this.text, this.cursor);
        this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
        this.lastWasInsert = false;
    }

    left() {
        this.cursor = prevBoundary(this.text, this.cursor);
        this.lastWasInsert = false;
    }

    right() {
        this.cursor = nextBoundary(this.text, this.cursor);
        this.lastWasInsert = false;
    }

    wordLeft() {
        let i = this.cursor;
        while (i > 0 && !WORD.test(this.text[i - 1]!)) i--;
        while (i > 0 && WORD.test(this.text[i - 1]!)) i--;
        this.cursor = i;
    }

    wordRight() {
        let i = this.cursor;
        const n = this.text.length;
        while (i < n && !WORD.test(this.text[i]!)) i++;
        while (i < n && WORD.test(this.text[i]!)) i++;
        this.cursor = i;
    }

    private lineStart(i = this.cursor): number {
        return this.text.lastIndexOf("\n", i - 1) + 1;
    }

    private lineEnd(i = this.cursor): number {
        const e = this.text.indexOf("\n", i);
        return e < 0 ? this.text.length : e;
    }

    home() {
        this.cursor = this.lineStart();
    }

    end() {
        this.cursor = this.lineEnd();
    }

    get onFirstLine(): boolean {
        return this.lineStart() === 0;
    }

    get onLastLine(): boolean {
        return this.lineEnd() === this.text.length;
    }

    /** Move up a line; returns false when already on the first line. */
    up(): boolean {
        if (this.onFirstLine) return false;
        const col = width(this.text.slice(this.lineStart(), this.cursor));
        const prevEnd = this.lineStart() - 1;
        const prevStart = this.lineStart(prevEnd);
        this.cursor = this.offsetAtCol(prevStart, prevEnd, col);
        return true;
    }

    down(): boolean {
        if (this.onLastLine) return false;
        const col = width(this.text.slice(this.lineStart(), this.cursor));
        const nextStart = this.lineEnd() + 1;
        const nextEnd = this.lineEnd(nextStart);
        this.cursor = this.offsetAtCol(nextStart, nextEnd, col);
        return true;
    }

    private offsetAtCol(start: number, end: number, col: number): number {
        let w = 0;
        for (const g of graphemes(this.text.slice(start, end))) {
            const gw = width(g.segment);
            if (w + gw > col) return start + g.index;
            w += gw;
        }
        return end;
    }

    historyPrev(): boolean {
        if (!this.history.length) return false;
        if (this.histIdx === -1) {
            this.draft = this.text;
            this.histIdx = this.history.length - 1;
        } else if (this.histIdx > 0) this.histIdx--;
        else return false;
        this.set(this.history[this.histIdx]!, 0);
        this.cursor = this.text.length;
        return true;
    }

    historyNext(): boolean {
        if (this.histIdx === -1) return false;
        if (this.histIdx < this.history.length - 1) {
            this.histIdx++;
            this.set(this.history[this.histIdx]!);
        } else {
            this.histIdx = -1;
            this.set(this.draft);
        }
        return true;
    }

    killToEnd() {
        this.snapshot();
        let end = this.lineEnd();
        if (end === this.cursor && end < this.text.length) end++; // join lines
        this.setKill(this.text.slice(this.cursor, end));
        this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
    }

    killToStart() {
        this.snapshot();
        const start = this.lineStart();
        this.setKill(this.text.slice(start, this.cursor));
        this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
        this.cursor = start;
    }

    killWordLeft() {
        this.snapshot();
        const end = this.cursor;
        this.wordLeft();
        this.setKill(this.text.slice(this.cursor, end));
        this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
    }

    killWordRight() {
        this.snapshot();
        const start = this.cursor;
        this.wordRight();
        this.setKill(this.text.slice(start, this.cursor));
        this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
        this.cursor = start;
    }

    /** Killing nothing (ctrl+k at the end) leaves the kill ring alone. */
    private setKill(text: string) {
        if (text) this.killRing = text;
    }

    yank() {
        if (this.killRing) this.insert(this.killRing);
    }

    undo() {
        const s = this.undoStack.pop();
        if (!s) return;
        this.text = s.text;
        this.cursor = s.cursor;
        this.lastWasInsert = false;
    }

    /** Word (from the last whitespace) ending at the cursor, e.g. "@src/ma". */
    tokenAtCursor(): { start: number; text: string } {
        const before = this.text.slice(0, this.cursor);
        const m = before.match(/(\S*)$/);
        const t = m?.[1] ?? "";
        return { start: this.cursor - t.length, text: t };
    }

    replaceRange(start: number, end: number, s: string) {
        this.snapshot();
        this.text = this.text.slice(0, start) + s + this.text.slice(end);
        this.cursor = start + s.length;
    }

    /**
     * Wrapped lines for display. `firstPrefix`/`restPrefix` are prepended
     * (e.g. "> " and "  "); cols is the total width available.
     */
    render(cols: number, firstPrefix: string, restPrefix: string, opts: { showCursor: boolean; placeholder?: string }): RenderedInput {
        const pw = Math.max(width(firstPrefix), width(restPrefix));
        const avail = Math.max(4, cols - pw);
        const out: string[] = [];
        let cursorRow = 0;
        const display = this.secret ? "•".repeat([...this.text].length) : this.text;
        const cursorIdx = this.secret ? [...this.text.slice(0, this.cursor)].length : this.cursor;
        if (!display.length) {
            const ph = opts.placeholder ? theme.subtle(opts.placeholder) : "";
            const cur = opts.showCursor ? inverse(opts.placeholder ? opts.placeholder[0]! : " ") : "";
            const rest = opts.placeholder ? theme.subtle(opts.placeholder.slice(1)) : "";
            out.push(firstPrefix + (opts.showCursor ? cur + rest : ph));
            return { lines: out, cursorRow: 0 };
        }
        let offset = 0;
        const logical = display.split("\n");
        for (let li = 0; li < logical.length; li++) {
            const line = logical[li]!;
            const gs = graphemes(line);
            let row = "";
            let rowW = 0;
            const flushRow = () => {
                out.push((out.length === 0 ? firstPrefix : restPrefix) + row);
                row = "";
                rowW = 0;
            };
            for (const g of gs) {
                const gw = Math.max(1, width(g.segment));
                if (rowW + gw > avail) flushRow();
                const abs = offset + g.index;
                if (opts.showCursor && abs === cursorIdx) {
                    row += inverse(g.segment);
                    cursorRow = out.length;
                } else row += g.segment;
                rowW += gw;
            }
            const endAbs = offset + line.length;
            if (opts.showCursor && endAbs === cursorIdx) {
                if (rowW + 1 > avail) flushRow();
                row += inverse(" ");
                cursorRow = out.length;
            }
            flushRow();
            offset += line.length + 1;
        }
        return { lines: out, cursorRow };
    }
}
