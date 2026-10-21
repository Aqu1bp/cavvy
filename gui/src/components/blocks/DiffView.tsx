import { RenderBoundary } from "../ui/ErrorBoundary";
import { createComputed, createEffect, createMemo, createSelector, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js";
import { ChevronDown, FileMinus2, FilePlus2, FileText } from "lucide-solid";
import type { DiffLine, FileDiff } from "@shared/protocol";
import { highlightLines } from "../../lib/highlight";
import { langOf, plural } from "../../lib/format";
import { escapeHtml } from "../../lib/markdown";
import { AROUND, buildComment, linesPhrase, lineRef, locate, type ReviewComment } from "../../lib/review-comments";
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

type DiffProps = { diff: FileDiff; maxLines?: number; header?: boolean; headerAction?: JSX.Element; split?: boolean; class?: string; comments?: DiffComments };

/** `headerAction`: a control at the end of the header (e.g. "Open in editor"). */
export function DiffView(p: DiffProps) {
    return <RenderBoundary raw={() => p.diff}><DiffViewContent {...p} /></RenderBoundary>;
}

function DiffViewContent(p: DiffProps) {
    const [expanded, setExpanded] = createSignal(false);
    const [visible, setVisible] = createSignal(false);
    const [oldHl, setOldHl] = createSignal<string[]>();
    const [newHl, setNewHl] = createSignal<string[]>();
    let el: HTMLDivElement | undefined;
    const [failure, setFailure] = createSignal<unknown>();
    createEffect(() => { if (failure()) throw failure(); });
    let token = 0;
    onCleanup(() => token++);

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
    });
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

    // Highlight each side once the diff is on screen.
    createEffect(
        on([visible, () => p.diff], ([v, d]) => {
            const mine = ++token;
            if (!v) return;
            const lang = langOf(d.path);
            if (!lang) return;
            const lines = d.hunks.flatMap((h) => h.lines);
            const failed = (error: unknown) => {
                if (mine === token) setFailure(() => error || new Error("Highlighting failed"));
            };
            void highlightLines(lines.filter((l) => l.t !== "add").map((l) => l.text).join("\n"), lang)
                .then((html) => { if (mine === token) setOldHl(html); }).catch(failed);
            void highlightLines(lines.filter((l) => l.t !== "del").map((l) => l.text).join("\n"), lang)
                .then((html) => { if (mine === token) setNewHl(html); }).catch(failed);
        }),
    );

    const pairs = createMemo(() => (p.split ? pairUp(shown()) : []));
    const html = (r: Line) => {
        const hl = r.line.t === "del" ? oldHl()?.[r.old ?? -1] : newHl()?.[r.new ?? -1];
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
    createEffect(on([shown, () => p.split], () => (byIdx = undefined)));
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
        shown();
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
            elementsFor(cursor()!)[0]?.scrollIntoView({ block: "nearest" });
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
                    >
                        <For each={pairs()}>
                            {(r) =>
                                r.kind === "sep" ? (
                                    <div class="sl sep">
                                        <span class="txt">{r.text}</span>
                                    </div>
                                ) : (
                                    <>
                                        <div class="sl" data-l={r.left?.idx} data-r={r.right?.idx}>
                                            <span class={`ln l ${r.left ? r.left.line.t : "none"}`} data-g={r.left?.idx}>{r.left?.line.a ?? ""}</span>
                                            <span class={`txt ${r.left ? r.left.line.t : "none"}`} innerHTML={r.left ? html(r.left) : ""} />
                                            <span class={`ln r ${r.right ? r.right.line.t : "none"}`} data-g={r.right?.idx}>{r.right?.line.b ?? ""}</span>
                                            <span class={`txt ${r.right ? r.right.line.t : "none"}`} innerHTML={r.right ? html(r.right) : ""} />
                                        </div>
                                        {commentable && r.left && hasSlot(r.left.idx) ? <Slot idx={r.left.idx} /> : undefined}
                                        {commentable && r.right && r.right !== r.left && hasSlot(r.right.idx) ? <Slot idx={r.right.idx} /> : undefined}
                                    </>
                                )
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
                    >
                        <For each={shown()}>
                            {(r) =>
                                r.kind === "sep" ? (
                                    <div class="dl sep">
                                        <span class="ln" />
                                        <span class="ln" />
                                        <span class="txt">{r.text}</span>
                                    </div>
                                ) : (
                                    <>
                                        <div class={`dl ${r.line.t}`} data-i={r.idx}>
                                            <span class="ln" data-g={r.idx}>{r.line.a ?? ""}</span>
                                            <span class="ln" data-g={r.idx}>{r.line.b ?? ""}</span>
                                            <span class="txt" innerHTML={html(r)} />
                                        </div>
                                        {commentable && hasSlot(r.idx) ? <Slot idx={r.idx} /> : undefined}
                                    </>
                                )
                            }
                        </For>
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
