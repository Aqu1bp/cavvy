// Modal dialogs shown in place of the prompt: pickers, text input, and the
// permission / plan approval prompts. Each dialog renders to lines and
// consumes keys; it resolves a promise when the user is done.

import type { Key } from "./keys";
import { bold, theme, truncate, width, wrapLine } from "./ansi";
import { Editor } from "./editor";
import { SelectList, type SelectItem } from "./components";

export interface Dialog {
    render(cols: number, rows: number): string[];
    onKey(k: Key): void;
    /** Called when the dialog is dismissed from outside (Ctrl+C). */
    cancel(): void;
}

export interface SelectDialogOptions<T> {
    title?: string;
    /** Lines shown above the list (already styled). */
    header?: string[];
    /** Lines shown below the list. */
    footer?: string[];
    items: SelectItem<T>[];
    initial?: number;
    /** Type-to-filter. Otherwise digits pick items directly. */
    searchable?: boolean;
    multi?: boolean;
    numbers?: boolean;
    current?: (v: T) => boolean;
    maxRows?: number;
    color?: (s: string) => string;
    /** Extra keys (left/right for effort in the model picker). Return true if handled. */
    onExtraKey?: (k: Key, d: SelectDialog<T>) => boolean;
    /** Hint line override. */
    hint?: string;
    border?: boolean;
}

export class SelectDialog<T> implements Dialog {
    list: SelectList<T>;
    private resolve!: (v: T | T[] | undefined) => void;
    readonly done: Promise<T | T[] | undefined>;
    header: string[];
    footer: string[];
    title?: string;

    constructor(private o: SelectDialogOptions<T>) {
        this.list = new SelectList(o.items, { initial: o.initial, multi: o.multi });
        this.header = o.header ?? [];
        this.footer = o.footer ?? [];
        this.title = o.title;
        this.done = new Promise((r) => (this.resolve = r));
    }

    private finish(v: T | T[] | undefined) {
        this.resolve(v);
    }

    cancel() {
        this.finish(undefined);
    }

    /** Resolve with a value chosen by an extra key handler. */
    choose(v: T | T[] | undefined) {
        this.finish(v);
    }

    onKey(k: Key) {
        if (this.o.onExtraKey?.(k, this)) return;
        const n = k.name;
        if (n === "escape" || (k.ctrl && n === "c")) return this.finish(undefined);
        if (n === "up" || (k.ctrl && n === "p")) return this.list.move(-1);
        if (n === "down" || (k.ctrl && n === "n")) return this.list.move(1);
        if (n === "tab" && !k.shift) return this.list.move(1);
        if (n === "tab" && k.shift) return this.list.move(-1);
        if (n === "pageup") return this.list.page(-1, 10);
        if (n === "pagedown") return this.list.page(1, 10);
        if (n === "enter") {
            if (this.o.multi) {
                const sel = this.list.selected();
                const cur = this.list.current();
                return this.finish(sel.length ? sel.map((s) => s.value) : cur ? [cur.value] : []);
            }
            const cur = this.list.current();
            if (cur && !cur.disabled) this.finish(cur.value);
            return;
        }
        if (this.o.multi && n === "text" && k.text === " ") return this.list.toggle();
        if (n === "text" && k.text) {
            if (!this.o.searchable && /^[1-9]$/.test(k.text)) {
                const idx = Number(k.text) - 1;
                const f = this.list.filtered();
                const item = f[idx]?.item;
                if (item && !item.disabled) {
                    if (this.o.multi) {
                        this.list.index = idx;
                        this.list.toggle();
                    } else this.finish(item.value);
                }
                return;
            }
            if (this.o.searchable) this.list.setQuery(this.list.query + k.text);
            return;
        }
        // A pasted model id (or anything else) goes into the search, on one line.
        if (n === "paste" && k.paste && this.o.searchable) return this.list.setQuery(this.list.query + k.paste.replace(/\s*\n\s*/g, " ").trim());
        if (n === "backspace" && this.o.searchable) this.list.setQuery(this.list.query.slice(0, -1));
        if (k.ctrl && n === "u" && this.o.searchable) this.list.setQuery("");
    }

    render(cols: number, rows: number): string[] {
        const color = this.o.color ?? theme.permission;
        const out: string[] = [];
        const inner = this.o.border === false ? cols - 2 : frameInner(cols);
        if (this.title) out.push(color(bold(this.title)));
        for (const h of this.header) out.push(...wrapLine(h, inner));
        if (this.o.searchable) {
            const q = this.list.query;
            out.push(theme.muted("Search: ") + (q ? q : theme.subtle("type to filter")) + theme.permission("▏"));
        }
        const reserved = out.length + this.footer.length + 3;
        const maxRows = Math.max(3, Math.min(this.o.maxRows ?? 14, rows - reserved));
        out.push(...this.list.render(inner, maxRows, { numbers: this.o.numbers ?? !this.o.searchable, current: this.o.current }));
        for (const f of this.footer) out.push(...wrapLine(f, inner));
        const hint =
            this.o.hint ??
            (this.o.multi ? "space to toggle · enter to confirm · esc to cancel" : this.o.searchable ? "↑↓ to select · enter to confirm · esc to cancel" : "enter to confirm · esc to cancel");
        out.push(theme.subtle(hint));
        // Unframed: title, search line, hint and group headers aren't wrapped above, so clip them.
        if (this.o.border === false) return out.map((l) => " " + truncate(l, inner));
        return frame(out, cols, color);
    }
}

export interface InputDialogOptions {
    title: string;
    header?: string[];
    placeholder?: string;
    secret?: boolean;
    initial?: string;
    multiline?: boolean;
    color?: (s: string) => string;
    hint?: string;
    /** Return an error message to keep the dialog open. */
    validate?: (v: string) => string | undefined;
}

export class InputDialog implements Dialog {
    editor = new Editor();
    private resolve!: (v: string | undefined) => void;
    readonly done: Promise<string | undefined>;
    error?: string;

    constructor(private o: InputDialogOptions) {
        this.editor.secret = Boolean(o.secret);
        if (o.initial) this.editor.set(o.initial);
        this.done = new Promise((r) => (this.resolve = r));
    }

    cancel() {
        this.resolve(undefined);
    }

    onKey(k: Key) {
        const e = this.editor;
        const n = k.name;
        if (n === "escape" || (k.ctrl && n === "c")) return this.resolve(undefined);
        if (n === "enter" && !(this.o.multiline && (k.shift || k.meta || k.ctrl))) {
            const v = e.value();
            const err = this.o.validate?.(v);
            if (err) {
                this.error = err;
                return;
            }
            return this.resolve(v);
        }
        this.error = undefined;
        if (n === "enter") return e.insert("\n");
        if (n === "paste" && k.paste) return e.paste(k.paste);
        if (n === "text" && k.text) return e.insert(k.text);
        if (n === "backspace") return k.meta || k.ctrl ? e.killWordLeft() : e.backspace();
        if (n === "delete") return e.del();
        if (n === "left") return k.meta || k.ctrl ? e.wordLeft() : e.left();
        if (n === "right") return k.meta || k.ctrl ? e.wordRight() : e.right();
        if (n === "home" || (k.ctrl && n === "a")) return e.home();
        if (n === "end" || (k.ctrl && n === "e")) return e.end();
        if (k.ctrl && n === "u") return e.killToStart();
        if (k.ctrl && n === "k") return e.killToEnd();
        if (k.ctrl && n === "w") return e.killWordLeft();
        if (n === "up") return void e.up();
        if (n === "down") return void e.down();
    }

    render(cols: number): string[] {
        const color = this.o.color ?? theme.permission;
        const out: string[] = [color(bold(this.o.title))];
        for (const h of this.o.header ?? []) out.push(...wrapLine(h, frameInner(cols)));
        const r = this.editor.render(frameInner(cols), "> ", "  ", { showCursor: true, placeholder: this.o.placeholder });
        out.push(...r.lines);
        if (this.error) out.push(theme.error(this.error));
        out.push(theme.subtle(this.o.hint ?? "enter to submit · esc to cancel"));
        return frame(out, cols, color);
    }
}

/** Content width inside frame(): "│ " + content + " │" fits in cols - 1. */
export function frameInner(cols: number): number {
    // cols - 1 total: the renderer keeps lines out of the terminal's last column.
    return Math.max(10, cols - 5);
}

/** A rounded frame around dialog content. */
export function frame(lines: string[], cols: number, color: (s: string) => string): string[] {
    const inner = frameInner(cols);
    const out = [color("╭" + "─".repeat(inner + 2) + "╮")];
    for (const l of lines) {
        for (const w of wrapLine(l, inner)) {
            const t = truncate(w, inner);
            out.push(color("│") + " " + t + " ".repeat(Math.max(0, inner - width(t))) + " " + color("│"));
        }
    }
    out.push(color("╰" + "─".repeat(inner + 2) + "╯"));
    return out;
}

/** A dialog that only shows progress text (e.g. "Checking key…"). */
export class MessageDialog implements Dialog {
    constructor(
        public lines: string[],
        private color: (s: string) => string = theme.permission,
        private onCancel?: () => void,
    ) {}
    render(cols: number): string[] {
        return frame(this.lines, cols, this.color);
    }
    onKey(k: Key) {
        if (k.name === "escape" || (k.ctrl && k.name === "c")) this.cancel();
    }
    cancel() {
        this.onCancel?.();
    }
}
