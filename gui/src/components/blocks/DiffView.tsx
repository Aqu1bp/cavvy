import { RenderBoundary } from "../ui/ErrorBoundary";
import { createComputed, createEffect, createMemo, createSelector, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js";
import { ChevronDown, FileMinus2, FilePlus2, FileText } from "lucide-solid";
import type { DiffLine, FileDiff } from "@shared/protocol";
import { highlightLineStream } from "../../lib/highlight";
import { langOf, plural } from "../../lib/format";
import { escapeHtml } from "../../lib/markdown";
import { AROUND, buildComment, linesPhrase, lineRef, locate, type ReviewComment } from "../../lib/review-comments";
import { Heights, joinRanges, rowsIn, widest, wrappedLines } from "../../lib/diff-window";
import { CommentBox, CommentCard, type CommentEdits } from "./DiffComments";

/** `h`: which hunk the line is in. A comment's lines stay inside one, where the numbers run on. */
type Row = { kind: "line"; line: DiffLine; old?: number; new?: number; idx: number; h: number } | { kind: "sep"; text: string };
type Line = Extract<Row, { kind: "line" }>;
/** Side by side: the old line on the left, the new one on the right; a lone side leaves the other blank. */
type Pair = { kind: "pair"; left?: Line; right?: Line } | { kind: "sep"; text: string };

function pairUp(rows: Row[]): Pair[] {
    const out: Pair[] = [];
    let dels: Line[] = [];
    let adds: Line[] = [];
    const flush = () => {
        for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ kind: "pair", left: dels[i], right: adds[i] });
        dels = [];
        adds = [];
    };
    for (const r of rows) {
        if (r.kind === "sep") {
            flush();
            out.push(r);
        } else if (r.line.t === "del") {
            if (adds.length) flush();
            dels.push(r);
        } else if (r.line.t === "add") adds.push(r);
        else {
            flush();
            out.push({ kind: "pair", left: r, right: r });
        }
    }
    flush();
    return out;
}

/** The same rows: a diff fetched again that didn't change. */
function sameRows(a: Row[], b: Row[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i]!;
        const y = b[i]!;
        if (x.kind === "sep" || y.kind === "sep") {
            if (x.kind !== "sep" || y.kind !== "sep" || x.text !== y.text) return false;
        } else if (x.h !== y.h || x.line.t !== y.line.t || x.line.text !== y.line.text || x.line.a !== y.line.a || x.line.b !== y.line.b) return false;
    }
    return true;
}

export function DiffStat(p: { added: number; removed: number; class?: string }) {
    return (
        <span class={`diffstat ${p.class ?? ""}`}>
            <Show when={p.added || !p.removed}>
                <span class="add">+{p.added}</span>
            </Show>
            <Show when={p.removed}>
                <span class="del">−{p.removed}</span>
            </Show>
        </span>
    );
}

export function FileIcon(p: { status: FileDiff["status"]; size?: number }) {
    const s = p.size ?? 14;
    return (
        <Show when={p.status === "added"} fallback={<Show when={p.status === "deleted"} fallback={<FileText size={s} />}><FileMinus2 size={s} class="tone-del" /></Show>}>
            <FilePlus2 size={s} class="tone-add" />
        </Show>
    );
}

/** Commenting on lines (the review pane): this file's comments, and what to do with new and changed ones. */
export interface DiffComments {
    list: readonly ReviewComment[];
    /** `around`: the lines either side in the hunk, so the comment knows its own lines from copies elsewhere. */
    add: (lines: DiffLine[], text: string, around?: { before: DiffLine[]; after: DiffLine[] }) => void;
    edit: (id: string, text: string) => void;
    remove: (id: string) => void;
}

type DiffProps = { diff: FileDiff; maxLines?: number; header?: boolean; headerAction?: JSX.Element; split?: boolean; oneSide?: boolean; windowed?: boolean; class?: string; comments?: DiffComments };

/**
 * `headerAction`: a control at the end of the header (e.g. "Open in editor"). `oneSide`: a new or deleted
 * file (lib/review-stack.ts oneSided), drawn unified with one line-number column rather than an empty one.
 * `windowed`: draw only the rows near the view (the review pane's diffs, which take comments, always are).
 */
export function DiffView(p: DiffProps) {
    return <RenderBoundary raw={() => p.diff}><DiffViewContent {...p} /></RenderBoundary>;
}

function DiffViewContent(p: DiffProps) {
    const [expanded, setExpanded] = createSignal(false);
    const [visible, setVisible] = createSignal(false);
    /** Each side's lines highlighted, filled in a part at a time; `hlVersion` says when a part landed. */
    let oldHl: (string | undefined)[] = [];
    let newHl: (string | undefined)[] = [];
    const [hlVersion, setHlVersion] = createSignal(0);
    let el: HTMLDivElement | undefined;
    const [failure, setFailure] = createSignal<unknown>();
    createEffect(() => { if (failure()) throw failure(); });
    let token = 0;
    onCleanup(() => token++);

    // The same lines fetched again (a refresh, a turn ending) keep the rows as they are: nothing is drawn again.
    const rows = createMemo<Row[]>(() => {
        const out: Row[] = [];
        let oi = 0;
        let ni = 0;
        p.diff.hunks.forEach((h, hi) => {
            if (hi > 0 || h.oldStart > 1) out.push({ kind: "sep", text: `@@ −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` });
            for (const l of h.lines) {
                const r: Row = { kind: "line", line: l, idx: out.length, h: hi };
                if (l.t !== "add") r.old = oi++;
                if (l.t !== "del") r.new = ni++;
                out.push(r);
            }
        });
        return out;
    }, [], { equals: sameRows });
    const total = () => rows().filter((r) => r.kind === "line").length;
    const limit = () => (expanded() || !p.maxLines ? Infinity : p.maxLines);
    const shown = createMemo(() => {
        let n = 0;
        return rows().filter((r) => (r.kind === "line" ? ++n <= limit() : n < limit()));
    });

    onMount(() => {
        if (!el) return;
        const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: "300px" });
        io.observe(el);
        onCleanup(() => io.disconnect());
    });

    // Highlight each side once the diff is on screen, a part at a time from the top: the first screenful
    // is colored at once. Until a line's part lands it keeps what it had (plain, or the last version's colors).
    createEffect(
        on([visible, rows, () => p.diff.path], ([v]) => {
            const mine = ++token;
            if (!v) return;
            const d = untrack(() => p.diff);
            const lang = langOf(d.path);
            if (!lang) return;
            const lines = d.hunks.flatMap((h) => h.lines);
            const failed = (error: unknown) => {
                if (mine === token) setFailure(() => error || new Error("Highlighting failed"));
            };
            const side = (keep: (l: DiffLine) => boolean, set: (hl: (string | undefined)[]) => void, get: () => (string | undefined)[]) => {
                const text = lines.filter(keep).map((l) => l.text);
                let fresh = false;
                const stream = highlightLineStream(text.join("\n"), lang, (from, part) => {
                    if (mine !== token) return;
                    // The first part: this version's lines from here on, the rest as they were until theirs come.
                    if (!fresh) {
                        fresh = true;
                        set(get().slice(0, text.length));
                    }
                    const hl = get();
                    for (let i = 0; i < part.length; i++) hl[from + i] = part[i];
                    setHlVersion((n) => n + 1);
                });
                // Nothing colored (a language Shiki can't do, too long a side): plain, not the last version's colors.
                stream.done.then(() => {
                    if (mine !== token || fresh) return;
                    set([]);
                    setHlVersion((n) => n + 1);
                }, failed);
                onCleanup(stream.cancel);
            };
            side((l) => l.t !== "add", (hl) => (oldHl = hl), () => oldHl);
            side((l) => l.t !== "del", (hl) => (newHl = hl), () => newHl);
        }),
    );

    const pairs = createMemo(() => (p.split ? pairUp(shown()) : []));
    const html = (r: Line) => {
        hlVersion();
        const hl = r.line.t === "del" ? oldHl[r.old ?? -1] : newHl[r.new ?? -1];
        return hl ?? escapeHtml(r.line.text);
    };

    // ---- comments: on the review pane's diffs only
    let rowsEl: HTMLDivElement | undefined;
    /** Lines picked for a comment: from `anchor` to `head`, by row index. */
    const [sel, setSel] = createSignal<{ anchor: number; head: number }>();
    /** The comment being written: its lines. What's been typed is kept aside (so typing redraws nothing) and survives picking other lines. */
    const [draft, setDraft] = createSignal<{ lo: number; hi: number }>();
    let draftText = "";
    const draftAt = createSelector(() => draft()?.hi);
    /** Fixed for the view's life: the review pane's diffs take comments, the transcript's never do, and pay nothing for it. */
    const commentable = untrack(() => Boolean(p.comments));
    /** The keyboard's line, shown while the diff has focus. Mouse picks don't move it. */
    const [cursor, setCursor] = createSignal<number>();
    const [focused, setFocused] = createSignal(false);
    const [hovered, setHovered] = createSignal<{ lo: number; hi: number }>();
    const lineAt = (idx: number): Line | undefined => {
        const r = rows()[idx];
        return r?.kind === "line" ? r : undefined;
    };
    /** The far end of a pick, kept inside the anchor's hunk. */
    const clamp = (anchor: number, head: number) => {
        const h = lineAt(anchor)?.h;
        const step = head > anchor ? 1 : -1;
        let i = anchor;
        while (i !== head && lineAt(i + step)?.h === h) i += step;
        return i;
    };
    const span = (s: { anchor: number; head: number }) => ({ lo: Math.min(s.anchor, s.head), hi: Math.max(s.anchor, s.head) });
    const linesIn = (lo: number, hi: number) => rows().slice(lo, hi + 1).flatMap((r) => (r.kind === "line" ? [r.line] : []));
    /** Up to AROUND lines of the same hunk past `from` in these rows, in file order. */
    const nearIn = (list: readonly Row[], from: number, step: 1 | -1) => {
        const at = (i: number) => (list[i]?.kind === "line" ? (list[i] as Line) : undefined);
        const h = at(from)?.h;
        const out: DiffLine[] = [];
        for (let i = from + step; out.length < AROUND && h !== undefined && at(i)?.h === h; i += step) out.push(at(i)!.line);
        return step === 1 ? out : out.reverse();
    };
    const near = (from: number, step: 1 | -1) => nearIn(rows(), from, step);
    const lineRows = createMemo(() => (p.comments ? rows().filter((r): r is Line => r.kind === "line") : []));
    // Saved comments being changed: what's typed, by comment id, so a redrawn card (a refresh, another
    // window's write) opens its box again with the text, and the focus if it had it.
    const editText = new Map<string, string>();
    const [editing, setEditing] = createSignal<ReadonlySet<string>>(new Set());
    let editFocus: string | undefined;
    const edits: CommentEdits = {
        text: (id) => (editing().has(id) ? (editText.get(id) ?? "") : undefined),
        set(id, text) {
            if (text === undefined) {
                editText.delete(id);
                if (editing().has(id)) setEditing((s) => new Set([...s].filter((x) => x !== id)));
                return;
            }
            editText.set(id, text);
            if (!editing().has(id)) {
                editFocus = id;
                setEditing((s) => new Set(s).add(id));
            }
        },
        takeFocus(id) {
            if (editFocus !== id) return false;
            editFocus = undefined;
            return true;
        },
    };
    /** Before the cards are drawn again: the edit box with the focus gets it back. */
    const keepEditFocus = () => {
        if (!untrack(editing).size) return;
        const id = (document.activeElement?.closest?.(".dc-box") as HTMLElement | null | undefined)?.dataset.edit;
        if (id && el?.contains(document.activeElement)) editFocus = id;
    };

    /** Each comment under the last line it covers, if its lines are still here; the rest are outdated. */
    const placed = createMemo(() => {
        keepEditFocus();
        const at = new Map<number, { c: ReviewComment; lo: number }[]>();
        const outdated: ReviewComment[] = [];
        const list = p.comments?.list ?? [];
        if (!list.length) return { at, outdated };
        const lines = lineRows().map((r) => r.line);
        for (const c of list) {
            const i = locate(c, lines);
            if (i === undefined) {
                outdated.push(c);
                continue;
            }
            const hi = lineRows()[i]!.idx;
            const n = c.snippet.split("\n").length - 1;
            const lo = lineRows()[Math.max(0, i - n + 1)]!.idx;
            at.set(hi, [...(at.get(hi) ?? []), { c, lo }]);
        }
        return { at, outdated };
    });

    // The diff was fetched again (an edit landed, a turn ended): the comment being written follows its lines,
    // found by their text as comments are. Before the rows are drawn, so its box is drawn in the right place once,
    // and takes focus back only if it had it. Lines that are gone close it; what was typed waits for the next pick.
    let boxFocus = true;
    const takeBoxFocus = () => {
        const v = boxFocus;
        boxFocus = true;
        return v;
    };
    createComputed(on(rows, (now, before) => {
        if (!commentable || !before) return;
        setSel(undefined);
        setHovered(undefined);
        const lines = now.filter((r): r is Line => r.kind === "line");
        const follow = (lo: number, hi: number) => {
            const was = before.slice(lo, hi + 1).flatMap((r) => (r.kind === "line" ? [r.line] : []));
            const probe = was.length ? buildComment({ id: "", path: "", lines: was, before: nearIn(before, lo, -1), after: nearIn(before, hi, 1), text: "-" }) : undefined;
            const i = probe && locate(probe, lines.map((r) => r.line));
            return i === undefined ? undefined : { lo: lines[Math.max(0, i - was.length + 1)]!.idx, hi: lines[i]!.idx };
        };
        const d = untrack(draft);
        if (d) {
            const active = document.activeElement;
            boxFocus = Boolean(active && rowsEl?.contains(active) && active.closest(".dc-box:not([data-edit])"));
            const moved = follow(d.lo, d.hi);
            // Closed: the next box opened by hand takes the focus as usual.
            if (!moved) boxFocus = true;
            setDraft(moved);
        }
        const c = untrack(cursor);
        if (c !== undefined) setCursor(follow(c, c)?.hi);
    }));

    // Picked lines are marked on the rows themselves, so a drag over a long diff touches only the rows it changes.
    let byIdx: Map<number, HTMLElement[]> | undefined;
    createEffect(on([() => items(), () => p.split], () => (byIdx = undefined)));
    const elementsFor = (idx: number) => {
        if (!byIdx && rowsEl) {
            byIdx = new Map();
            for (const el of Array.from(rowsEl.children) as HTMLElement[]) {
                for (const key of [el.dataset.i, el.dataset.l, el.dataset.r]) {
                    if (key === undefined) continue;
                    const list = byIdx.get(Number(key)) ?? [];
                    if (!list.includes(el)) list.push(el);
                    byIdx.set(Number(key), list);
                }
            }
        }
        return byIdx?.get(idx) ?? [];
    };
    const marked = new Set<HTMLElement>();
    const paint = (range: { lo: number; hi: number } | undefined, cur: number | undefined) => {
        const want = new Set<HTMLElement>();
        if (range) for (let i = range.lo; i <= range.hi; i++) for (const el of elementsFor(i)) want.add(el);
        for (const el of marked) if (!want.has(el)) el.classList.remove("csel");
        for (const el of want) if (!marked.has(el)) el.classList.add("csel");
        marked.clear();
        for (const el of want) marked.add(el);
        rowsEl?.querySelector(".ccur")?.classList.remove("ccur");
        if (cur !== undefined) elementsFor(cur)[0]?.classList.add("ccur");
    };
    createEffect(() => {
        if (!p.comments) return;
        items();
        void p.split;
        const s = sel();
        const d = draft();
        paint(s ? span(s) : d ? { lo: d.lo, hi: d.hi } : hovered(), focused() ? cursor() : undefined);
    });

    const open = (lo: number, hi: number, fromKeyboard = false) => {
        setDraft({ lo, hi });
        setSel(undefined);
        if (fromKeyboard) setCursor(hi);
    };
    const closeDraft = (refocus: boolean) => {
        setDraft(undefined);
        draftText = "";
        if (refocus) rowsEl?.focus({ preventScroll: true });
    };
    const submit = (text: string) => {
        const d = draft();
        if (!d || !p.comments) return;
        p.comments.add(linesIn(d.lo, d.hi), text, { before: near(d.lo, -1), after: near(d.hi, 1) });
        closeDraft(true);
    };
    const rangeLabel = (lo: number, hi: number) => {
        const a = lineAt(lo) && lineRef(lineAt(lo)!.line);
        const b = lineAt(hi) && lineRef(lineAt(hi)!.line);
        return a && b ? linesPhrase({ start: a, end: b }) : "these lines";
    };

    /** The row index under a gutter cell, or the nearest line of the pick's own side in split view. */
    const gutterIdx = (target: EventTarget | null): number | undefined => {
        const cell = (target as HTMLElement | null)?.closest?.<HTMLElement>(".ln[data-g]");
        return cell ? Number(cell.dataset.g) : undefined;
    };
    const rowIdx = (target: Element | null, prefer: "l" | "r" | undefined): number | undefined => {
        const row = target?.closest<HTMLElement>("[data-i], [data-l], [data-r]");
        if (!row) return undefined;
        const v = row.dataset.i ?? (prefer === "l" ? (row.dataset.l ?? row.dataset.r) : (row.dataset.r ?? row.dataset.l));
        return v === undefined ? undefined : Number(v);
    };
    const onGutterDown = (e: PointerEvent) => {
        if (!p.comments || e.button !== 0) return;
        const idx = gutterIdx(e.target);
        if (idx === undefined || !lineAt(idx)) return;
        e.preventDefault();
        const side = (e.target as HTMLElement).closest<HTMLElement>(".ln")?.classList.contains("r") ? "r" : "l";
        const d = draft();
        const anchor = e.shiftKey && d ? (idx >= d.lo ? d.lo : d.hi) : idx;
        setSel({ anchor, head: clamp(anchor, idx) });
        rowsEl?.focus({ preventScroll: true });
        const move = (ev: PointerEvent) => {
            const i = rowIdx(document.elementFromPoint(ev.clientX, ev.clientY), side);
            if (i !== undefined && lineAt(i)) setSel((s) => s && { anchor: s.anchor, head: clamp(s.anchor, i) });
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            const s = sel();
            if (s) open(span(s).lo, span(s).hi);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
    };
    /** One tab stop for the whole diff: arrows move between lines, Shift picks several, Enter or C comments. */
    const onRowsKey = (e: KeyboardEvent) => {
        if (!p.comments || e.target !== rowsEl || e.metaKey || e.ctrlKey || e.altKey) return;
        const lines = lineRows();
        if (!lines.length) return;
        const cur = cursor();
        const pos = cur === undefined ? -1 : lines.findIndex((r) => r.idx === cur);
        const moves: Record<string, number> = { ArrowDown: pos < 0 ? 0 : pos + 1, ArrowUp: pos < 0 ? 0 : pos - 1, Home: 0, End: lines.length - 1 };
        if (e.key in moves) {
            e.preventDefault();
            const next = lines[Math.max(0, Math.min(lines.length - 1, moves[e.key]!))]!.idx;
            if (e.shiftKey) {
                const s = sel() ?? { anchor: cur ?? next, head: cur ?? next };
                const head = clamp(s.anchor, next);
                setSel({ anchor: s.anchor, head });
                setCursor(head);
            } else {
                setSel(undefined);
                setCursor(next);
            }
            revealRow(cursor()!);
        } else if ((e.key === "Enter" || e.key === "c") && !e.shiftKey) {
            const s = sel() ?? (cur !== undefined ? { anchor: cur, head: cur } : undefined);
            if (!s) return;
            e.preventDefault();
            open(span(s).lo, span(s).hi, true);
        } else if (e.key === "Escape" && sel()) {
            e.preventDefault();
            setSel(undefined);
        }
    };
    // Each row asks only whether something goes under it, and only the rows whose answer changed are told.
    const anchoredAt = createSelector(() => placed().at, (idx: number, at: ReadonlyMap<number, unknown>) => at.has(idx));
    const hasSlot = (idx: number) => anchoredAt(idx) || draftAt(idx);
    /** What goes under a row: the comments that end on it, and the one being written. */
    const Slot = (s: { idx: number }) => (
        <div class="dc-slot" data-slot>
            <For each={placed().at.get(s.idx) ?? []}>
                {(x) => <CommentCard id={x.c.id} edits={edits} label={rangeLabel(x.lo, s.idx)} text={x.c.text} onEdit={(t) => p.comments!.edit(x.c.id, t)} onRemove={() => {
                    setHovered(undefined);
                    p.comments!.remove(x.c.id);
                }} onHover={(on) => setHovered(on ? { lo: x.lo, hi: s.idx } : undefined)} />}
            </For>
            <Show when={draftAt(s.idx)}>
                <CommentBox label={rangeLabel(draft()!.lo, draft()!.hi)} initial={draftText} autofocus={takeBoxFocus()} onText={(text) => (draftText = text)} onSubmit={submit} onCancel={() => closeDraft(true)} />
            </Show>
        </div>
    );
    // ---- Long diffs in the review pane: only the rows near the view are drawn (a few screens' worth),
    // with spacers standing in for the rest. WebKit pays for every drawn row's positioned cells on each
    // frame of a scroll, so a 1,500-line diff drawn whole scrolls at a few frames a second. Rows a
    // selection, a comment being written or changed, or the focus is in stay drawn wherever they are.
    /** Fixed for the view's life, like `commentable`: the review pane's diffs (another worktree's too, which take no comments); the transcript's are short. */
    const windowed = commentable || untrack(() => Boolean(p.windowed));
    type Unit = Row | Pair;
    type Gap = { gap: true; from: number; to: number };
    /** What's drawn one after another: rows, or pairs side by side, each with the comments under it. */
    const units = createMemo<readonly Unit[]>(() => (p.split ? pairs() : shown()));
    const unitIndex = createMemo(() => new Map<Unit, number>(units().map((u, i) => [u, i])));
    const unitOfRow = createMemo(() => {
        const m = new Map<number, number>();
        units().forEach((u, i) => {
            if (u.kind === "line") m.set(u.idx, i);
            else if (u.kind === "pair") {
                if (u.left) m.set(u.left.idx, i);
                if (u.right) m.set(u.right.idx, i);
            }
        });
        return m;
    });
    /** Measured on the drawn rows: a code line's height, a hunk header's, a comment's, and how many characters fit a side-by-side line. */
    const typical = { line: 0, empty: 0, sep: 0, slot: 72, cols: 0, charW: 0 };
    /** Code lines measured so far: their total height, how many, and the shortest (a line that doesn't wrap). An empty line
     * is shorter (it has no text, only its numbers), so it's kept apart. */
    const measuredLines = { sum: 0, n: 0, min: 0, empty: 0 };
    const guess = (u: Unit) => {
        const line = typical.line || 21;
        if (u.kind === "sep") return typical.sep || line + 6;
        const empty = u.kind === "line" ? !u.line.text : !u.left?.line.text && !u.right?.line.text;
        let h = empty ? typical.empty || line : line;
        if (u.kind === "pair" && typical.cols > 0 && !empty) {
            const wraps = (l?: Line) => (l ? wrappedLines(l.line.text, typical.cols) : 1);
            h = line * Math.max(wraps(u.left), wraps(u.right));
        }
        const at = untrack(() => placed().at);
        const d = untrack(draft);
        const has = (idx?: number) => idx !== undefined && (at.has(idx) || d?.hi === idx);
        const slots = u.kind === "line" ? Number(has(u.idx)) : Number(has(u.left?.idx)) + Number(u.right !== u.left && has(u.right?.idx));
        return h + slots * typical.slot;
    };
    const heights = createMemo(() => {
        const list = units();
        Object.assign(measuredLines, { sum: 0, n: 0, min: 0, empty: 0 });
        return new Heights(list.length, (i) => guess(list[i]!));
    });
    /** The rows near the view, by index into `units`. */
    const [around, setAround] = createSignal<[number, number]>([0, 59], { equals: (a, b) => a[0] === b[0] && a[1] === b[1] });
    /** Bumped when measured heights change, so the spacers follow. */
    const [measured, setMeasured] = createSignal<void>(undefined, { equals: false });
    const samePin = (a?: [number, number], b?: [number, number]) => a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);
    const [selectionPin, setSelectionPin] = createSignal<[number, number] | undefined>(undefined, { equals: samePin });
    const [focusPin, setFocusPin] = createSignal<number>();
    const segments = createMemo(
        () => {
            if (!windowed) return undefined;
            const n = units().length;
            const map = unitOfRow();
            const clampTo = (a: number, b: number): [number, number] => [Math.max(0, a), Math.min(n - 1, b)];
            const ranges: [number, number][] = [clampTo(...around())];
            const s = selectionPin();
            if (s) ranges.push(clampTo(...s));
            const f = focusPin();
            if (f !== undefined) ranges.push(clampTo(f, f));
            const d = draft();
            const du = d && map.get(d.hi);
            if (du !== undefined) ranges.push([du, du]);
            const ed = editing();
            if (ed.size) {
                for (const [idx, list] of placed().at) {
                    const u = map.get(idx);
                    if (u !== undefined && list.some((x) => ed.has(x.c.id))) ranges.push([u, u]);
                }
            }
            return joinRanges(ranges);
        },
        undefined,
        { equals: (a, b) => a === b || (!!a && !!b && a.length === b.length && a.every((r, i) => r[0] === b[i]![0] && r[1] === b[i]![1])) },
    );
    /** The rows drawn, and spacers for the runs of rows that aren't. */
    const items = createMemo<readonly (Unit | Gap)[]>(() => {
        const list = units();
        const segs = segments();
        if (!segs) return list;
        const out: (Unit | Gap)[] = [];
        let at = 0;
        for (const [a, b] of segs) {
            if (a > at) out.push({ gap: true, from: at, to: a });
            for (let i = a; i <= b; i++) out.push(list[i]!);
            at = b + 1;
        }
        if (at < list.length) out.push({ gap: true, from: at, to: list.length });
        return out;
    });
    const gapHeight = (g: Gap) => {
        measured();
        const h = heights();
        return h.offset(g.to) - h.offset(g.from);
    };
    /** The widest lines, in a row of no height: the diff scrolls sideways as far as its widest line, drawn or not. */
    const widestText = createMemo(() => (windowed && !p.split ? widest(rows().flatMap((r) => (r.kind === "line" ? [r.line.text] : []))).join("\n") : ""));

    /** The boxes that clip the rows (the scroller among them), outermost last. */
    let clips: HTMLElement[] = [];
    const findClips = () => {
        clips = [];
        for (let e = rowsEl?.parentElement; e && e !== document.body; e = e.parentElement) {
            const cs = getComputedStyle(e);
            if (cs.overflowY !== "visible" || cs.overflowX !== "visible") clips.push(e);
        }
    };
    /** The part of the rows in view: px from their top. */
    const viewport = (): [number, number] | undefined => {
        if (!rowsEl) return undefined;
        const r = rowsEl.getBoundingClientRect();
        let top = 0;
        let bottom = window.innerHeight;
        for (const c of clips) {
            const b = c.getBoundingClientRect();
            top = Math.max(top, b.top);
            bottom = Math.min(bottom, b.bottom);
        }
        return [top - r.top, bottom - r.top];
    };
    const scroller = () => clips.find((c) => c.scrollHeight > c.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(c).overflowY));
    const drawnRows = () => (rowsEl ? (Array.from(rowsEl.children) as HTMLElement[]) : []);
    /** The first drawn row in view, and where it is: kept in place while spacers above it change. */
    const anchorRow = () => {
        const v = viewport();
        if (!v || !rowsEl) return undefined;
        const top = rowsEl.getBoundingClientRect().top + v[0];
        for (const e of drawnRows()) {
            if (e.dataset.u === undefined) continue;
            const b = e.getBoundingClientRect();
            if (b.bottom > top) return { e, top: b.top };
        }
        return undefined;
    };
    let width = 0;
    /** The drawn rows' heights (with the comments under them): true when one changed. */
    const measure = (): boolean => {
        if (!rowsEl) return false;
        const h = heights();
        let changed = false;
        const w = rowsEl.clientWidth;
        // Side by side, lines wrap: a new width changes every row's height.
        if (w !== width) {
            width = w;
            if (p.split) {
                h.reset();
                Object.assign(measuredLines, { sum: 0, n: 0, min: 0, empty: 0 });
                typical.cols = 0;
                changed = true;
            }
        }
        const slots = { sum: 0, n: 0 };
        let sep = 0;
        let open: number | undefined;
        let openTop = 0;
        let openSep = false;
        let openSlots = false;
        let openEmpty = false;
        const close = (y: number) => {
            if (open === undefined) return;
            const first = !h.measured(open);
            if (h.set(open, y - openTop)) changed = true;
            // A plain code line, measured for the first time: part of the average the guesses use.
            if (first && !openSep && !openSlots && openEmpty) measuredLines.empty ||= y - openTop;
            else if (first && !openSep && !openSlots) {
                measuredLines.sum += y - openTop;
                measuredLines.n++;
                measuredLines.min = measuredLines.min ? Math.min(measuredLines.min, y - openTop) : y - openTop;
            }
            open = undefined;
        };
        for (const e of drawnRows()) {
            const b = e.getBoundingClientRect();
            if (e.dataset.slot !== undefined) {
                slots.sum += b.height;
                slots.n++;
                openSlots = true;
                continue;
            }
            close(b.top);
            if (e.dataset.u === undefined) continue;
            open = Number(e.dataset.u);
            openTop = b.top;
            openSep = e.classList.contains("sep");
            openSlots = false;
            openEmpty = !Array.from(e.querySelectorAll(".txt")).some((t) => t.textContent);
            if (openSep) sep ||= b.height;
        }
        close(rowsEl.getBoundingClientRect().bottom);
        // The guesses for rows not drawn yet, from what's drawn.
        let guesses = false;
        // Side by side, a line's own height (the guesses multiply it by its wraps); else the average row's.
        const line = p.split ? measuredLines.min : measuredLines.n ? measuredLines.sum / measuredLines.n : 0;
        if (line && Math.abs(line - typical.line) >= 0.01) {
            typical.line = line;
            guesses = true;
        }
        if (measuredLines.empty !== typical.empty) {
            typical.empty = measuredLines.empty;
            guesses = true;
        }
        // Any guess that changes changes the sums the spacers are drawn from.
        const slot = slots.n ? slots.sum / slots.n : typical.slot;
        if (Math.abs(slot - typical.slot) >= 0.01) {
            typical.slot = slot;
            guesses = true;
        }
        if (sep && !typical.sep) {
            typical.sep = sep;
            guesses = true;
        }
        if (p.split && !typical.cols) {
            const txt = rowsEl.querySelector<HTMLElement>(".sl:not(.sep) > .txt");
            if (txt) {
                const cs = getComputedStyle(txt);
                if (!typical.charW) {
                    // In the rows' own font: a line of 100 characters, measured and taken away.
                    const probe = document.createElement("span");
                    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
                    probe.textContent = "0".repeat(100);
                    txt.append(probe);
                    typical.charW = probe.getBoundingClientRect().width / 100;
                    probe.remove();
                }
                const inner = txt.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
                if (typical.charW > 0 && inner > 0) {
                    typical.cols = Math.max(1, Math.floor(inner / typical.charW));
                    guesses = true;
                }
            }
        }
        if (guesses) {
            h.invalidate();
            changed = true;
        }
        return changed;
    };
    let updating = false;
    let guessed = true;
    /** Measures what's drawn, keeps the row in view where it was, and draws the rows near the view. */
    const update = () => {
        if (!windowed || !rowsEl?.isConnected || updating) return;
        updating = true;
        try {
            // Side by side at a new width, every line wraps anew: like rows drawn for the first time.
            if (p.split && rowsEl.clientWidth !== width) guessed = true;
            // The row in view, taken before anything changes and held where it is through every pass: rows drawn
            // above it come in at their real heights (a tall comment under one), and the page moves to make up for it.
            // Rows just drawn for the first time (another layout) are measured before anything is held in place:
            // until then the spacers are guesses, and the page keeps its scroll position as it would drawn whole.
            let anchor = guessed ? undefined : anchorRow();
            for (let pass = 0; pass < 4; pass++) {
                const changed = measure();
                if (changed) setMeasured();
                if (guessed) {
                    guessed = false;
                    anchor = anchorRow();
                } else if (anchor?.e.isConnected) {
                    const d = anchor.e.getBoundingClientRect().top - anchor.top;
                    const sc = Math.abs(d) >= 0.5 ? scroller() : undefined;
                    if (sc) sc.scrollTop += d;
                }
                const v = viewport();
                if (!v) break;
                const over = Math.max(400, v[1] - v[0]);
                const h = heights();
                const [lo, hi] = around();
                const need = rowsIn(h, v[0], v[1], over / 2);
                const want = rowsIn(h, v[0], v[1], over);
                // Drawn again only when the view nears the end of what's drawn, not on every scroll event.
                const covers = need[0] >= lo && need[1] <= hi && hi - lo <= 3 * (want[1] - want[0] + 1);
                if (covers) {
                    if (!changed) break;
                    continue;
                }
                setAround(want);
            }
        } finally {
            updating = false;
        }
    };
    let frame = 0;
    const later = () => {
        if (!frame) frame = requestAnimationFrame(() => {
            frame = 0;
            update();
        });
    };
    /** The row (by index into `units`) holding a node of the page: a comment under a row is that row's. */
    const unitAt = (node: Node | null, offset = 0): number => {
        const n = units().length;
        if (!node || !rowsEl) return 0;
        if (node === rowsEl) node = rowsEl.children[Math.min(offset, rowsEl.children.length - 1)] ?? rowsEl;
        if (!rowsEl.contains(node) || node === rowsEl) return rowsEl.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING ? 0 : n - 1;
        let e: Element | null = node instanceof Element ? node : node.parentElement;
        while (e && e.parentElement !== rowsEl) e = e.parentElement;
        for (let x = e as HTMLElement | null; x; x = x.previousElementSibling as HTMLElement | null) {
            if (x.dataset.u !== undefined) return Number(x.dataset.u);
            if (x.dataset.to !== undefined) return x === e ? Number(x.dataset.from) : Number(x.dataset.to) - 1;
        }
        return 0;
    };
    const onSelection = () => {
        const s = document.getSelection();
        if (!rowsEl || !s || !s.rangeCount || s.isCollapsed || !s.containsNode(rowsEl, true)) return setSelectionPin(undefined);
        const a = unitAt(s.anchorNode, s.anchorOffset);
        const b = unitAt(s.focusNode, s.focusOffset);
        setSelectionPin([Math.min(a, b), Math.max(a, b)]);
    };
    /** Focus on something under a row (a comment's button, its box): that row stays drawn while it has it. */
    const onFocusIn = (e: FocusEvent) => {
        if (windowed && rowsEl && e.target !== rowsEl) setFocusPin(unitAt(e.target as Node));
    };
    const onFocusOut = (e: FocusEvent) => {
        const next = e.relatedTarget as Node | null;
        if (windowed && !(next && next !== rowsEl && rowsEl?.contains(next))) setFocusPin(undefined);
    };
    if (windowed) {
        onMount(() => {
            const onScroll = (e: Event) => {
                if (rowsEl && (e.target === document || (e.target as Node).contains?.(rowsEl))) update();
            };
            document.addEventListener("scroll", onScroll, { capture: true, passive: true });
            document.addEventListener("selectionchange", onSelection);
            const ro = new ResizeObserver(later);
            onCleanup(() => {
                document.removeEventListener("scroll", onScroll, { capture: true });
                document.removeEventListener("selectionchange", onSelection);
                ro.disconnect();
                cancelAnimationFrame(frame);
            });
            // The rows' box is a new one when the layout switches: watched again, with its clipping boxes.
            createEffect(on(() => p.split, () => {
                ro.disconnect();
                findClips();
                if (rowsEl) ro.observe(rowsEl);
                for (const c of clips) ro.observe(c);
                width = 0;
            }));
            // New rows (another diff, the other layout): measured and placed once drawn.
            createEffect(on(units, () => {
                guessed = true;
                update();
            }));
        });
    }
    // Drawing other rows can move a kept one in the page (Solid's list puts a row back rather than insert many
    // before it), which takes the focus from a comment box in it and loses a selection in it. Both are put back.
    let held: { focus?: HTMLElement; caret?: [number, number, "forward" | "backward" | "none"]; sel?: [Node, number, Node, number] } | undefined;
    createComputed(on(items, () => {
        held = undefined;
        if (!windowed || !rowsEl) return;
        const active = document.activeElement as HTMLElement | null;
        const s = document.getSelection();
        held = {};
        if (active && active !== rowsEl && rowsEl.contains(active)) {
            held.focus = active;
            if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) held.caret = [active.selectionStart ?? 0, active.selectionEnd ?? 0, active.selectionDirection ?? "none"];
        }
        if (s?.rangeCount && !s.isCollapsed && s.anchorNode && s.focusNode && (rowsEl.contains(s.anchorNode) || rowsEl.contains(s.focusNode))) held.sel = [s.anchorNode, s.anchorOffset, s.focusNode, s.focusOffset];
    }, { defer: true }));
    createEffect(on(items, () => {
        const h = held;
        held = undefined;
        if (!h) return;
        if (h.focus?.isConnected && document.activeElement !== h.focus) {
            h.focus.focus({ preventScroll: true });
            if (h.caret && (h.focus instanceof HTMLTextAreaElement || h.focus instanceof HTMLInputElement)) h.focus.setSelectionRange(...h.caret);
        }
        const s = document.getSelection();
        // Only ends inside a row's own text: an offset into the rows' box counts rows that have since changed.
        const fits = (n: Node, o: number) => n !== rowsEl && n.isConnected && o <= (n.nodeType === Node.TEXT_NODE ? (n.nodeValue?.length ?? 0) : n.childNodes.length);
        if (h.sel && s && fits(h.sel[0], h.sel[1]) && fits(h.sel[2], h.sel[3]) && (s.anchorNode !== h.sel[0] || s.anchorOffset !== h.sel[1] || s.focusNode !== h.sel[2] || s.focusOffset !== h.sel[3])) s.setBaseAndExtent(...h.sel);
    }, { defer: true }));

    /** Brings a row into view, drawing it first if it isn't. */
    const revealRow = (idx: number) => {
        const drawn = elementsFor(idx)[0];
        if (drawn || !windowed) return drawn?.scrollIntoView({ block: "nearest" });
        const u = unitOfRow().get(idx);
        const sc = scroller();
        if (u === undefined || !sc || !rowsEl) return;
        const h = heights();
        const base = rowsEl.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
        const top = base + h.offset(u);
        const bottom = base + h.offset(u + 1);
        if (top < sc.scrollTop) sc.scrollTop = top;
        else if (bottom > sc.scrollTop + sc.clientHeight) sc.scrollTop = bottom - sc.clientHeight;
        update();
        elementsFor(idx)[0]?.scrollIntoView({ block: "nearest" });
    };

    /** A line's code: set again only when its highlighting changes, not each time a part of the file's lands. */
    const Code = (c: { class: string; row?: Line }) => {
        // While a row is inside a live selection, its markup is held as it is: swapping innerHTML (a highlight
        // part landing for it once the view has scrolled past, say) would destroy the text nodes the selection
        // points into and truncate it (#6). It takes the newest highlighting once the selection leaves it.
        const pinned = () => {
            if (!windowed || !c.row) return false;
            const u = unitOfRow().get(c.row.idx);
            const s = selectionPin();
            return u !== undefined && s !== undefined && u >= s[0] && u <= s[1];
        };
        const content = createMemo<string>((prev) => {
            const next = c.row ? html(c.row) : "";
            return pinned() && prev !== undefined ? prev : next;
        });
        return <span class={c.class} innerHTML={content()} />;
    };
    /** Stands in for rows that aren't drawn, at their height. */
    const Spacer = (s: { gap: Gap }) => <div class="dv-gap" aria-hidden="true" data-from={s.gap.from} data-to={s.gap.to} style={{ height: `${gapHeight(s.gap)}px` }} />;

    const rowsLabel = () => `Diff of ${p.diff.path}. Arrow keys move between lines, Home and End go to the first and last, Shift picks several, Enter comments.`;

    return (
        <div ref={el} class={`diff ${p.class ?? ""}`}>
            <Show when={p.header}>
                <div class="diff-head">
                    <FileIcon status={p.diff.status} />
                    <span class="diff-path">{p.diff.path}</span>
                    <DiffStat added={p.diff.added} removed={p.diff.removed} />
                    {p.headerAction}
                </div>
            </Show>
            <Show when={p.diff.note && !p.diff.hunks.length}>
                <div class="diff-note">{p.diff.note}</div>
            </Show>
            <Show when={p.comments && placed().outdated.length}>
                <div class="dc-outdated" data-find-skip>
                    <div class="dc-outdated-head">{plural(placed().outdated.length, "comment")} on lines that have changed since</div>
                    <For each={placed().outdated}>
                        {(c) => <CommentCard id={c.id} edits={edits} label={linesPhrase(c)} text={c.text} outdated snippet={c.snippet} onEdit={(t) => p.comments!.edit(c.id, t)} onRemove={() => p.comments!.remove(c.id)} />}
                    </For>
                </div>
            </Show>
            <Show when={p.diff.hunks.length && p.split}>
                <div class={commentable ? "diff-scroll has-comments" : "diff-scroll"}>
                    <div
                        ref={rowsEl}
                        class={`diff-rows split ${p.comments ? "commentable" : ""}`}
                        tabIndex={p.comments ? 0 : undefined}
                        role={p.comments ? "group" : undefined}
                        aria-label={p.comments ? rowsLabel() : undefined}
                        onPointerDown={onGutterDown}
                        onKeyDown={onRowsKey}
                        onFocus={(e) => setFocused(e.target === e.currentTarget)}
                        onBlur={() => setFocused(false)}
                        onFocusIn={onFocusIn}
                        onFocusOut={onFocusOut}
                    >
                        <For each={items()}>
                            {(r) =>
                                "gap" in r ? (
                                    <Spacer gap={r} />
                                ) : r.kind === "sep" ? (
                                    <div class="sl sep" data-u={windowed ? unitIndex().get(r) : undefined}>
                                        <span class="txt">{r.text}</span>
                                    </div>
                                ) : r.kind === "pair" ? (
                                    <>
                                        <div class="sl" data-l={r.left?.idx} data-r={r.right?.idx} data-u={windowed ? unitIndex().get(r) : undefined}>
                                            <span class={`ln l ${r.left ? r.left.line.t : "none"}`} data-g={r.left?.idx}>{r.left?.line.a ?? ""}</span>
                                            <Code class={`txt ${r.left ? r.left.line.t : "none"}`} row={r.left} />
                                            <span class={`ln r ${r.right ? r.right.line.t : "none"}`} data-g={r.right?.idx}>{r.right?.line.b ?? ""}</span>
                                            <Code class={`txt ${r.right ? r.right.line.t : "none"}`} row={r.right} />
                                        </div>
                                        {commentable && r.left && hasSlot(r.left.idx) ? <Slot idx={r.left.idx} /> : undefined}
                                        {commentable && r.right && r.right !== r.left && hasSlot(r.right.idx) ? <Slot idx={r.right.idx} /> : undefined}
                                    </>
                                ) : undefined
                            }
                        </For>
                    </div>
                </div>
            </Show>
            <Show when={p.diff.hunks.length && !p.split}>
                <div class={commentable ? "diff-scroll has-comments" : "diff-scroll"}>
                    <div
                        ref={rowsEl}
                        class={`diff-rows ${p.comments ? "commentable" : ""}`}
                        tabIndex={p.comments ? 0 : undefined}
                        role={p.comments ? "group" : undefined}
                        aria-label={p.comments ? rowsLabel() : undefined}
                        onPointerDown={onGutterDown}
                        onKeyDown={onRowsKey}
                        onFocus={(e) => setFocused(e.target === e.currentTarget)}
                        onBlur={() => setFocused(false)}
                        onFocusIn={onFocusIn}
                        onFocusOut={onFocusOut}
                    >
                        <For each={items()}>
                            {(r) =>
                                "gap" in r ? (
                                    <Spacer gap={r} />
                                ) : r.kind === "sep" ? (
                                    <div class={p.oneSide ? "dl sep one" : "dl sep"} data-u={windowed ? unitIndex().get(r) : undefined}>
                                        <span class="ln" />
                                        {p.oneSide ? undefined : <span class="ln" />}
                                        <span class="txt">{r.text}</span>
                                    </div>
                                ) : r.kind === "line" ? (
                                    <>
                                        <div class={`dl ${r.line.t}${p.oneSide ? " one" : ""}`} data-i={r.idx} data-u={windowed ? unitIndex().get(r) : undefined}>
                                            {p.oneSide ? (
                                                <span class="ln" data-g={r.idx}>{r.line.b ?? r.line.a ?? ""}</span>
                                            ) : (
                                                <>
                                                    <span class="ln" data-g={r.idx}>{r.line.a ?? ""}</span>
                                                    <span class="ln" data-g={r.idx}>{r.line.b ?? ""}</span>
                                                </>
                                            )}
                                            <Code class="txt" row={r} />
                                        </div>
                                        {commentable && hasSlot(r.idx) ? <Slot idx={r.idx} /> : undefined}
                                    </>
                                ) : undefined
                            }
                        </For>
                        <Show when={widestText()}>
                            <div class={p.oneSide ? "dl dv-sizer one" : "dl dv-sizer"} aria-hidden="true" data-find-skip>
                                <span class="ln" />
                                {p.oneSide ? undefined : <span class="ln" />}
                                <span class="txt">{widestText()}</span>
                            </div>
                        </Show>
                    </div>
                </div>
            </Show>
            <Show when={total() > limit()}>
                <button class="diff-more" onClick={() => setExpanded(true)}>
                    <ChevronDown size={14} /> Show {plural(total() - (p.maxLines ?? 0), "more line")}
                </button>
            </Show>
            <Show when={p.diff.truncated && (expanded() || !p.maxLines || total() <= limit())}>
                <div class="diff-note">The rest of this diff is too long to show here.</div>
            </Show>
        </div>
    );
}
