// Multi-line prompt editor model: text, cursor, history, kill ring, undo,
// and paste placeholders. Rendering produces wrapped lines with a fake cursor.

import { width, inverse, theme } from "./ansi";
import type { NamedImage } from "./images";

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

// An image's placeholder is `[Image #N]` led by a private-use code point that
// names the attachment. Nothing typed or pasted can carry one (insert strips
// them), so a typed "[Image #1]" is only text, and undo, the kill ring and
// history keep the identity along with the text.
const MARK_BASE = 0x100000;
const MARK_COUNT = 0xfffd;
const MARKS = /[\u{100000}-\u{10fffd}]/gu;
const TOKEN = /([\u{100000}-\u{10fffd}])\[Image #(\d+)\]/gu;
const TOKEN_END = /[\u{100000}-\u{10fffd}]\[Image #\d+\]$/u;

const markOf = (uid: number) => String.fromCodePoint(MARK_BASE + uid);
const uidOf = (mark: string) => mark.codePointAt(0)! - MARK_BASE;
const isMark = (s: string) => /^[\u{100000}-\u{10fffd}]$/u.test(s);

/** Text as the model and history see it: placeholders stay, their markers go. */
export function plainText(s: string): string {
    return s.replace(MARKS, "");
}

export interface Attachment {
    /** The number shown in its placeholder. */
    n: number;
    /** Still being read or shrunk. */
    image?: NamedImage;
}

/** A prompt with the images behind its placeholders: what a queue holds, independent of the editor's undo history. */
export interface Draft {
    /** Paste placeholders expanded, image markers kept. */
    text: string;
    attachments: Map<number, Attachment>;
}

/** A placeholder's span in `text` at or after `from`, marker included. */
function tokenSpan(text: string, uid: number, from = 0): { start: number; end: number } | undefined {
    const start = text.indexOf(markOf(uid), from);
    if (start < 0) return undefined;
    const m = text.slice(start).match(/^[\u{100000}-\u{10fffd}]\[Image #\d+\]/u);
    return { start, end: start + (m ? m[0].length : 2) };
}

/** `text` with every placeholder of `uid` replaced (a double yank can leave two); `cursor` follows the edits. */
function replaceTokens(text: string, uid: number, replacement: string, cursor = 0): { text: string; cursor: number } {
    let from = 0;
    for (let s = tokenSpan(text, uid); s; s = tokenSpan(text, uid, from)) {
        text = text.slice(0, s.start) + replacement + text.slice(s.end);
        if (cursor >= s.end) cursor += replacement.length - (s.end - s.start);
        else if (cursor > s.start) cursor = s.start + replacement.length;
        from = s.start + replacement.length;
    }
    return { text, cursor };
}

/** Take an attachment out of a draft, putting `replacement` where its placeholders were. */
export function withoutImage(d: Draft, uid: number, replacement = "") {
    d.attachments.delete(uid);
    d.text = replaceTokens(d.text, uid, replacement).text;
}

/** The images of a text's placeholders, in the order they appear. A placeholder duplicated by yanking twice sends its image once, at the first. */
export function imagesIn(text: string, attachments: Map<number, Attachment>): NamedImage[] {
    const out: NamedImage[] = [];
    const seen = new Set<number>();
    for (const m of text.matchAll(TOKEN)) {
        const uid = uidOf(m[1]!);
        const a = attachments.get(uid);
        if (a?.image && a.n === Number(m[2]) && !seen.has(uid)) {
            seen.add(uid);
            out.push(a.image);
        }
    }
    return out;
}

/** How many recent history entries keep their images (in memory only; history on disk is plain text). */
export const HISTORY_IMAGES = 20;

interface HistoryEntry {
    /** Marker-bearing when `attachments` is set, plain otherwise. */
    text: string;
    attachments?: Map<number, Attachment>;
}

export interface RenderedInput {
    lines: string[];
    cursorRow: number;
}

export class Editor {
    text = "";
    cursor = 0;
    /** Mask input (API keys). */
    secret = false;
    /** In secret mode, a paste keeps its spaces (a password's), dropping only the line breaks around it. */
    keepSpaces = false;
    private history: HistoryEntry[] = [];
    private histIdx = -1;
    private draft = "";
    private killRing = "";
    private undoStack: { text: string; cursor: number }[] = [];
    private pastes = new Map<number, string>();
    private pasteCounter = 0;
    private attachments = new Map<number, Attachment>();
    private attachCounter = 0;
    private imageCounter = 0;
    private lastWasInsert = false;
    /** Where the last insert left the editor; typing only coalesces from exactly there. */
    private insertMark = { cursor: -1, length: -1 };

    setHistory(h: string[]) {
        this.history = h.map((text) => ({ text }));
        this.histIdx = -1;
    }

    /** `draft` is the prompt behind a plain `entry`; its images come back when the entry is recalled. */
    pushHistory(entry: string, draft?: Draft) {
        if (!entry.trim()) return;
        const e: HistoryEntry = draft?.attachments.size ? { text: draft.text, attachments: new Map([...draft.attachments].map(([uid, a]) => [uid, { ...a }])) } : { text: entry };
        if (this.history[this.history.length - 1]?.text !== e.text) this.history.push(e);
        if (this.history.length > 1000) this.history.shift();
        const old = this.history[this.history.length - 1 - HISTORY_IMAGES];
        if (old?.attachments) {
            old.text = plainText(old.text);
            old.attachments = undefined;
        }
        this.histIdx = -1;
    }

    private recall(i: number) {
        const h = this.history[i]!;
        for (const [uid, a] of h.attachments ?? []) this.attachments.set(uid, { ...a });
        this.set(h.text);
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
        this.offMark();
    }

    clear() {
        this.snapshot();
        this.set("");
        this.prunePastes();
        this.histIdx = -1;
    }

    /** Drop pasted text and images nothing can bring back; undo (or a yank) can restore a placeholder. */
    private prunePastes() {
        const live = new Set<number>();
        const liveImages = new Set<number>();
        for (const t of [this.text, this.draft, this.killRing, ...this.undoStack.map((u) => u.text)]) {
            for (const m of t.matchAll(/\[Pasted text #(\d+) \+\d+ lines\]/g)) live.add(Number(m[1]));
            for (const m of t.matchAll(MARKS)) liveImages.add(uidOf(m[0]));
        }
        for (const id of this.pastes.keys()) if (!live.has(id)) this.pastes.delete(id);
        for (const id of this.attachments.keys()) if (!liveImages.has(id)) this.attachments.delete(id);
    }

    /** Insert an `[Image #N]` placeholder; the image goes out with the prompt. Returns its attachment id. */
    attachImage(img: NamedImage): number {
        return this.addAttachment(img);
    }

    /** A placeholder for an image still being read or shrunk; fill it with resolveImage, or drop it with dropImage. */
    reserveImage(): number {
        return this.addAttachment(undefined);
    }

    private addAttachment(image: NamedImage | undefined): number {
        let uid = (this.attachCounter % MARK_COUNT) + 1;
        // History entries keep their ids, so a recalled one can't collide with a newer image.
        const inHistory = new Set(this.history.flatMap((h) => [...(h.attachments?.keys() ?? [])]));
        while (this.attachments.has(uid) || inHistory.has(uid)) uid = (uid % MARK_COUNT) + 1;
        this.attachCounter = uid;
        const n = ++this.imageCounter;
        this.attachments.set(uid, { n, image });
        this.lastWasInsert = false;
        this.rawInsert(`${markOf(uid)}[Image #${n}]`);
        this.lastWasInsert = false;
        return uid;
    }

    /** A reserved placeholder's image. False when nothing holds the placeholder any more (it went with a sent or dropped prompt). */
    resolveImage(uid: number, img: NamedImage): boolean {
        for (const h of this.history) {
            const a = h.attachments?.get(uid);
            if (a && !a.image) a.image = img;
        }
        const a = this.attachments.get(uid);
        if (!a || a.image) return false;
        a.image = img;
        return true;
    }

    /** Forget an attachment, putting `replacement` where its placeholder is in the current text. */
    dropImage(uid: number, replacement = "") {
        this.attachments.delete(uid);
        ({ text: this.text, cursor: this.cursor } = replaceTokens(this.text, uid, replacement, this.cursor));
        for (let i = this.history.length - 1; i >= 0; i--) {
            const h = this.history[i]!;
            if (!h.attachments?.has(uid)) continue;
            withoutImage(h as Draft, uid, replacement);
            if (h.text.trim()) continue;
            // An entry that was only this image is nothing to recall.
            this.history.splice(i, 1);
            if (this.histIdx > i) this.histIdx--;
            else if (this.histIdx === i) this.histIdx = Math.min(i, this.history.length - 1);
        }
    }

    /** The images whose placeholders are in the text, in the order they appear. */
    attachedImages(): NamedImage[] {
        return imagesIn(this.text, this.attachments);
    }

    /** Placeholders in the text whose images aren't ready yet. */
    pendingImages(): { uid: number; n: number }[] {
        const out: { uid: number; n: number }[] = [];
        for (const m of this.text.matchAll(TOKEN)) {
            const uid = uidOf(m[1]!);
            const a = this.attachments.get(uid);
            if (a && !a.image && a.n === Number(m[2]) && !out.some((p) => p.uid === uid)) out.push({ uid, n: a.n });
        }
        return out;
    }

    /** The prompt as it would be sent, with what its placeholders stand for. */
    capture(): Draft {
        const text = this.value(true);
        const attachments = new Map<number, Attachment>();
        for (const m of text.matchAll(TOKEN)) {
            const uid = uidOf(m[1]!);
            const a = this.attachments.get(uid);
            if (a) attachments.set(uid, { ...a });
        }
        return { text, attachments };
    }

    /** Put drafts (and their images) back in the prompt, ahead of what's there. */
    restore(drafts: Draft[]) {
        for (const d of drafts) for (const [uid, a] of d.attachments) this.attachments.set(uid, { ...a });
        this.set([...drafts.map((d) => d.text), this.text].filter(Boolean).join("\n"));
    }

    /**
     * Text edited outside (Ctrl+G), which can't carry markers. Each of `from`'s
     * attachments comes back where its exact label appears exactly once; any
     * other label, typed or duplicated, stays plain text.
     */
    setEdited(text: string, from: Draft) {
        text = plainText(text);
        const at: { i: number; uid: number }[] = [];
        for (const m of from.text.matchAll(TOKEN)) {
            const uid = uidOf(m[1]!);
            const a = from.attachments.get(uid);
            if (!a || a.n !== Number(m[2])) continue;
            const label = `[Image #${a.n}]`;
            const i = text.indexOf(label);
            if (i < 0 || text.includes(label, i + 1)) continue;
            at.push({ i, uid });
            this.attachments.set(uid, { ...a });
        }
        at.sort((a, b) => b.i - a.i);
        for (const { i, uid } of at) text = text.slice(0, i) + markOf(uid) + text.slice(i);
        this.snapshot();
        this.set(text);
        this.histIdx = -1;
    }

    /** A cursor never rests between a marker and its placeholder. */
    private offMark() {
        if (this.cursor >= 2 && isMark(this.text.slice(this.cursor - 2, this.cursor))) this.cursor -= 2;
    }

    /** Markers whose placeholder was edited away (or renumbered by hand) go, leaving plain text. */
    private tidy() {
        const re = /[\u{100000}-\u{10fffd}]/gu;
        let out = "";
        let last = 0;
        let shift = 0;
        for (const m of this.text.matchAll(re)) {
            const i = m.index!;
            const t = this.text.slice(i).match(/^[\u{100000}-\u{10fffd}]\[Image #(\d+)\]/u);
            const a = this.attachments.get(uidOf(m[0]));
            if (t && (!a || a.n === Number(t[1]))) continue;
            out += this.text.slice(last, i);
            last = i + m[0].length;
            if (this.cursor > i) shift += Math.min(m[0].length, this.cursor - i);
        }
        if (!last) return;
        this.text = out + this.text.slice(last);
        this.cursor -= shift;
    }

    get isEmpty(): boolean {
        return this.text.length === 0;
    }

    insert(s: string) {
        this.rawInsert(s.replace(MARKS, ""));
    }

    private rawInsert(s: string) {
        if (!s) return;
        this.offMark();
        this.snapshot(true);
        this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor);
        this.cursor += s.length;
        this.lastWasInsert = !/\s/.test(s);
        this.tidy();
        this.insertMark = { cursor: this.cursor, length: this.text.length };
        this.histIdx = -1;
    }

    /** Large pastes collapse into a placeholder that expands on submit. */
    paste(s: string) {
        s = s.replace(MARKS, "");
        this.lastWasInsert = false; // a paste is its own undo step
        const lines = s.split("\n").length;
        if (!this.secret && (lines > 8 || s.length > 1500)) {
            const id = ++this.pasteCounter;
            this.pastes.set(id, s);
            this.insert(`[Pasted text #${id} +${lines} lines]`);
        } else this.insert(!this.secret ? s : this.keepSpaces ? s.replace(/^[\r\n]+|[\r\n]+$/g, "") : s.replace(/\s+/g, ""));
        this.lastWasInsert = false;
    }

    /** Final text with paste placeholders expanded (and image markers dropped unless `marks`). */
    value(marks = false): string {
        const v = this.text.replace(/\[Pasted text #(\d+) \+\d+ lines\]/g, (m, id) => this.pastes.get(Number(id)) ?? m);
        return marks ? v : plainText(v);
    }

    backspace() {
        this.offMark();
        if (this.cursor === 0) return;
        this.snapshot();
        // Delete a whole paste or image placeholder at once.
        const before = this.text.slice(0, this.cursor);
        const ph = before.match(/\[Pasted text #\d+ \+\d+ lines\]$/) ?? before.match(TOKEN_END);
        const start = ph ? this.cursor - ph[0].length : prevBoundary(this.text, this.cursor);
        this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
        this.cursor = start;
        this.lastWasInsert = false;
        this.tidy();
    }

    del() {
        this.offMark();
        if (this.cursor >= this.text.length) return;
        this.snapshot();
        const rest = this.text.slice(this.cursor);
        const ph = rest.match(/^[\u{100000}-\u{10fffd}]\[Image #\d+\]/u);
        const end = ph ? this.cursor + ph[0].length : nextBoundary(this.text, this.cursor);
        this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
        this.lastWasInsert = false;
        this.tidy();
    }

    left() {
        this.cursor = prevBoundary(this.text, this.cursor);
        this.offMark();
        this.lastWasInsert = false;
    }

    right() {
        this.cursor = nextBoundary(this.text, this.cursor);
        if (this.cursor >= 2 && isMark(this.text.slice(this.cursor - 2, this.cursor))) this.cursor = nextBoundary(this.text, this.cursor);
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
        const col = width(plainText(this.text.slice(this.lineStart(), this.cursor)));
        const prevEnd = this.lineStart() - 1;
        const prevStart = this.lineStart(prevEnd);
        this.cursor = this.offsetAtCol(prevStart, prevEnd, col);
        this.offMark();
        return true;
    }

    down(): boolean {
        if (this.onLastLine) return false;
        const col = width(plainText(this.text.slice(this.lineStart(), this.cursor)));
        const nextStart = this.lineEnd() + 1;
        const nextEnd = this.lineEnd(nextStart);
        this.cursor = this.offsetAtCol(nextStart, nextEnd, col);
        this.offMark();
        return true;
    }

    private offsetAtCol(start: number, end: number, col: number): number {
        let w = 0;
        for (const g of graphemes(this.text.slice(start, end))) {
            const gw = isMark(g.segment) ? 0 : width(g.segment);
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
        this.recall(this.histIdx);
        this.cursor = this.text.length;
        return true;
    }

    historyNext(): boolean {
        if (this.histIdx === -1) return false;
        if (this.histIdx < this.history.length - 1) {
            this.histIdx++;
            this.recall(this.histIdx);
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
        this.tidy();
    }

    killToStart() {
        this.snapshot();
        const start = this.lineStart();
        this.setKill(this.text.slice(start, this.cursor));
        this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
        this.cursor = start;
        this.tidy();
    }

    killWordLeft() {
        this.snapshot();
        const end = this.cursor;
        this.wordLeft();
        this.setKill(this.text.slice(this.cursor, end));
        this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
        this.tidy();
    }

    killWordRight() {
        this.snapshot();
        const start = this.cursor;
        this.wordRight();
        this.setKill(this.text.slice(start, this.cursor));
        this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
        this.cursor = start;
        this.tidy();
    }

    /** Killing nothing (ctrl+k at the end) leaves the kill ring alone. */
    private setKill(text: string) {
        if (text) this.killRing = text;
    }

    yank() {
        if (this.killRing) this.rawInsert(this.killRing);
    }

    undo() {
        const s = this.undoStack.pop();
        if (!s) return;
        this.text = s.text;
        this.cursor = s.cursor;
        this.lastWasInsert = false;
        this.offMark();
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
        this.text = this.text.slice(0, start) + s.replace(MARKS, "") + this.text.slice(end);
        this.cursor = start + s.replace(MARKS, "").length;
        this.tidy();
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
        const shown = plainText(this.text);
        const display = this.secret ? "•".repeat([...shown].length) : shown;
        const before = plainText(this.text.slice(0, this.cursor));
        const cursorIdx = this.secret ? [...before].length : before.length;
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
