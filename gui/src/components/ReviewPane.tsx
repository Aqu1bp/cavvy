// The diff reader: the inspector widens into it (lib/layout.ts). One toolbar row: back; a view menu
// for which changes (uncommitted, the branch, a recorded turn, Cavvy's own edits, or another
// worktree's); "vs <base>" in Branch view; the files as a jump list; the view's total; side by side;
// refresh. Under it every file is stacked in one scroll, each under a sticky header that folds it,
// and lines take comments for the next message; Commit and Push at the foot. Opened from the side
// panel, the title bar's changes chip or a turn's Review changes, scrolled to the file asked for.
// Git's views show every change in the folder, whoever made it; Cavvy edits shows only what the
// edit tools did, and is all there is outside a Git repository. Another worktree of the repository
// (where an agent works) can be read too: its branch and uncommitted changes only; commenting,
// committing, pushing and opening in the editor stay with the session's own folder. Only the files
// near the view have their diff drawn (lib/review-stack.ts), so a 300-file view opens like one file.

import { batch, createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Columns2, FolderGit2, FolderOpen, GitCommitHorizontal, GitPullRequestArrow, MessageSquare, RefreshCw, SquareArrowOutUpRight, X } from "lucide-solid";
import type { FileDiff, GitFileDiff, GitScope, SessionWorktreeInfo } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { app, reportError, rpc } from "../state/app";
import { prefs, setPrefs } from "../state/prefs";
import { review, reviewSplit, setCommitRequest, setReview, setReviewDrag, setReviewSplit, shellLayout } from "../state/ui";
import { frameDrag } from "../lib/drag";
import { changedOutside, commitUnavailable, fetchGitChanges, lastView, sessionReadReady, useGitChanges, type ReviewScope } from "../state/changes";
import { editorName, openInEditor } from "../state/actions";
import { canReveal, revealPath } from "../lib/platform";
import { plural, since } from "../lib/format";
import { CHANGE, dirOf, nameOf, REVIEW_DEFAULT, REVIEW_STEP, reviewDragWidth, reviewWidthRange } from "../lib/inspector";
import { DiffView, type DiffComments } from "./blocks/DiffView";
import { buildComment } from "../lib/review-comments";
import { findPick, pickKey, pickParams, type ReviewPick } from "../lib/review-pick";
import { anchorShift, cardAt, foldsSmoothly, oneSided, stackRows, viewLabel, viewMenu, type TurnItem, type ViewItem } from "../lib/review-stack";
import { newCommentId, reviewComments } from "../state/review-comments";
import { PublishStatus } from "./PublishStatus";
import { BasePicker } from "./BasePicker";
import { facts, rankedWorktrees, ReviewWorktreePicker, usable, workNamed, worktreeLabel } from "./ReviewWorktreePicker";
import { followAgent, keepWorktree, ownOnScreen, pickScope, pickWorktree, requestWorktree, worktreeWork, type ReviewPlace, type WorktreeWork } from "../lib/worktree-work";
import { Spinner } from "./ui/bits";
import { Menu } from "./ui/Menu";

type Row = FileDiff & Partial<Pick<GitFileDiff, "change" | "from" | "kind" | "deferred" | "filter" | "pathToken">>;
/** A file here: by its handle when its name was shown redacted (two can show the same name), else by name. */
const key = (f: Row) => f.pathToken ?? f.path;

const changeOf = (f: Row): GitFileDiff["change"] => f.change ?? f.status;

/** What the file is, when its letter doesn't say: "Symbolic link", "Renamed from …". */
function fileTag(f: Row): string | undefined {
    if (f.kind === "link") return "Symbolic link";
    // Its diff, when there is one, is of what git stores (an LFS pointer, say), not the file on disk.
    if (f.filter) return `Filter: ${f.filter}`;
    if (f.kind === "submodule") return "Submodule";
    if (f.kind === "repo") return "Repository";
    if (f.kind === "folder") return "Folder";
    return changeOf(f) === "renamed" && f.from ? `Renamed from ${f.from}` : undefined;
}

/** Side by side, or unified; side by side widens the inspector further (lib/layout.ts). Kept while the app runs. */
function SplitToggle() {
    return (
        <button class="hb" aria-pressed={reviewSplit()} aria-label="Side by side" title={reviewSplit() ? "Unified" : "Side by side (new and deleted files stay unified)"} onClick={() => setReviewSplit(!reviewSplit())}>
            <Columns2 size={15} />
        </button>
    );
}

/**
 * The reader's left edge, while it docks: drag (or arrow keys) to widen it; double-click for
 * the default. It starts from the width shown, which the layout may have widened past the saved one.
 */
function ReviewResizer() {
    const [dragging, setDragging] = createSignal(false);
    const shown = () => shellLayout().inspector.width;
    const set = (w: number) => setPrefs("reviewWidth", w);
    /** Ends the drag under way, if any: on release, and when the reader closes in the middle of one (Esc). */
    let stop: (() => void) | undefined;
    onCleanup(() => stop?.());
    const start = (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        stop?.();
        const x = e.clientX;
        const from = shown();
        setDragging(true);
        document.body.classList.add("resizing");
        // Shown once a frame, saved to the preferences on release (or when the reader closes mid-drag).
        const drag = frameDrag({
            show: setReviewDrag,
            commit: (w) => batch(() => {
                if (w !== undefined) set(w);
                setReviewDrag(undefined);
            }),
        });
        // On the window, not the handle: the handle can go away mid-drag, and its listeners with it.
        const move = (ev: PointerEvent) => drag.move(reviewDragWidth(from, ev.clientX - x));
        const end = () => {
            drag.end();
            stop = undefined;
            setDragging(false);
            document.body.classList.remove("resizing");
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
        };
        stop = end;
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
    };
    return (
        <div
            class={`insp-resizer rv-resizer ${dragging() ? "drag" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the diff reader"
            aria-valuenow={shown()}
            aria-valuemin={reviewWidthRange(shown(), shellLayout().sheet.w).min}
            aria-valuemax={reviewWidthRange(shown(), shellLayout().sheet.w).max}
            tabIndex={0}
            onPointerDown={start}
            onDblClick={() => set(REVIEW_DEFAULT)}
            onKeyDown={(e) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                e.preventDefault();
                set(reviewDragWidth(shown(), e.key === "ArrowLeft" ? -REVIEW_STEP : REVIEW_STEP));
            }}
        />
    );
}

/** Cards made as the reader opens past the first screen's, then each frame until every file has one. */
const FIRST_CARDS = 3;
const MORE_CARDS = 16;
/** A card's header and gap, and a diff row, in px: enough to tell which files the first screen holds. */
const CARD_PX = 50;
const ROW_PX = 18;

/** Worktrees named in the view menu; the rest are under "Every worktree…". */
const MENU_WORKTREES = 4;

/** The toolbar's view button and its menu: the four views, the recorded turns, and the worktree. */
function ViewMenu(p: {
    label: string;
    /** Another worktree's branch, when one is looked at: a tinted chip in the button. */
    away?: string;
    menu: { views: ViewItem[]; turns: TurnItem[] };
    /** The Worktree section: shown in a repository, or while away. */
    worktreesShown: boolean;
    value?: string;
    worktrees?: SessionWorktreeInfo[];
    loading: boolean;
    error?: string;
    work: () => Map<string, WorktreeWork>;
    onOpen: () => void;
    onView: (scope: ViewItem["scope"]) => void;
    onTurn: (id: number) => void;
    onWorktree: (worktree: string | undefined) => void;
}) {
    let anchor: HTMLButtonElement | undefined;
    const [open, setOpen] = createSignal(false);
    const [every, setEvery] = createSignal(false);
    createEffect(on(open, (o) => o && p.onOpen(), { defer: true }));
    const work = createMemo(() => (open() ? p.work() : new Map<string, WorktreeWork>()));
    /** The first few by rank, and the one looked at wherever it ranks. */
    const shortList = createMemo(() => {
        const all = rankedWorktrees(p.worktrees ?? [], work());
        const top = all.slice(0, MENU_WORKTREES);
        const on = p.value !== undefined ? all.find((w) => w.path === p.value) : undefined;
        return on && !top.includes(on) ? [...top.slice(0, -1), on] : top;
    });
    const isOn = (w: SessionWorktreeInfo) => (p.value === undefined ? w.current : w.path === p.value);
    const pick = (run: () => void) => {
        setOpen(false);
        run();
    };
    const Radio = (r: { on: boolean; disabled?: string; title?: string; onPick: () => void; children: any }) => (
        <button class="menu-item rv-vm-item" role="menuitemradio" aria-checked={r.on} aria-disabled={r.disabled ? "true" : undefined} title={r.disabled ?? r.title} onClick={() => !r.disabled && pick(r.onPick)}>
            <span class="rv-vm-check">
                <Show when={r.on}>
                    <Check size={14} stroke-width={2.2} />
                </Show>
            </span>
            {r.children}
        </button>
    );
    return (
        <>
            <button ref={anchor} class="tb rv-view" aria-haspopup="menu" aria-expanded={open()} title="Which changes" onClick={() => setOpen(!open())}>
                <Show when={p.away}>
                    {(b) => (
                        <span class="wt" title={`Reading ${b()}`}>
                            <FolderGit2 size={12} />
                            <span>{b()}</span>
                        </span>
                    )}
                </Show>
                <span class="lbl">{p.label}</span>
                <ChevronDown size={12} class="chev" />
            </button>
            <Menu label="Which changes" open={open()} anchor={() => anchor} onClose={() => setOpen(false)} placement="bottom" align="start" width={340} maxHeight={620}>
                <div class="rv-vm">
                    <div class="menu-head">Changes</div>
                    <For each={p.menu.views}>
                        {(v) => (
                            <Radio on={v.on} disabled={v.disabled} title={v.note} onPick={() => p.onView(v.scope)}>
                                <span class="menu-text">
                                    <span class="menu-label">{v.label}</span>
                                    <span class="menu-desc">{v.desc}</span>
                                </span>
                            </Radio>
                        )}
                    </For>
                    <Show when={p.menu.turns.length}>
                        <div class="menu-sep" />
                        <div class="menu-head">Recorded turns</div>
                        <For each={p.menu.turns}>
                            {(t) => (
                                <Radio on={t.on} disabled={t.disabled} title={`${t.prompt}\n${new Date(t.startedAt).toLocaleString()}`} onPick={() => p.onTurn(t.id)}>
                                    <span class="menu-text">
                                        <span class="menu-label truncate">
                                            {t.label} · {t.prompt}
                                        </span>
                                        <span class="menu-desc">{t.disabled ?? (since(t.startedAt) === "now" ? "Just now" : `${since(t.startedAt)} ago`)}</span>
                                    </span>
                                </Radio>
                            )}
                        </For>
                    </Show>
                    <Show when={p.worktreesShown}>
                        <div class="menu-sep" />
                        <div class="menu-head">Worktree</div>
                        <Show when={!p.error} fallback={<div class="menu-note">{p.error}</div>}>
                            <Show when={p.worktrees} fallback={<div class="menu-note">{p.loading ? "Loading worktrees…" : "No worktrees."}</div>}>
                                <For each={shortList()}>
                                    {(w) => {
                                        const named = () => workNamed(work().get(w.path));
                                        const who = () => {
                                            const n = named();
                                            if (!n.length) return facts(w);
                                            return `${n[0]!.agent ? "Sub-agent" : "Session"}: ${n[0]!.text}${n.length > 1 ? ` · +${n.length - 1} more` : ""}`;
                                        };
                                        return (
                                            <Radio on={isOn(w)} disabled={usable(w) ? undefined : facts(w)} title={`${w.path}${facts(w) ? `\n${facts(w)}` : ""}`} onPick={() => p.onWorktree(w.current ? undefined : w.path)}>
                                                <span class="menu-text">
                                                    <span class="rv-wt-name">
                                                        <span class="menu-label mono truncate">{worktreeLabel(w)}</span>
                                                        <Show when={w.current}>
                                                            <span class="rv-wt-self">This session</span>
                                                        </Show>
                                                    </span>
                                                    <Show when={who()}>
                                                        <span class="menu-desc truncate">{who()}</span>
                                                    </Show>
                                                </span>
                                            </Radio>
                                        );
                                    }}
                                </For>
                                <Show when={(p.worktrees?.length ?? 0) > shortList().length}>
                                    <button class="menu-item rv-vm-item" role="menuitem" onClick={() => pick(() => setEvery(true))}>
                                        <span class="rv-vm-check" />
                                        <span class="menu-label">Every worktree… ({p.worktrees!.length})</span>
                                    </button>
                                </Show>
                            </Show>
                        </Show>
                    </Show>
                </div>
            </Menu>
            <ReviewWorktreePicker open={every()} anchor={() => anchor} onClose={() => setEvery(false)} value={p.value} worktrees={p.worktrees} loading={p.loading} error={p.error} work={p.work} onOpen={p.onOpen} onPick={p.onWorktree} />
        </>
    );
}

/** A file's +a −d, as DiffStat draws it: −d alone for a deletion. */
function Stat(p: { added: number; removed: number }) {
    return (
        <span class="stat">
            <Show when={p.added || !p.removed}>
                <span class="add">+{p.added}</span>
            </Show>
            <Show when={p.removed}>
                <span class="del">−{p.removed}</span>
            </Show>
        </span>
    );
}

/** The toolbar's "N files": a jump list of the files, with Show and Fold every file. */
function FilesMenu(p: { label: string; files: Row[]; more?: string; comments: (f: Row) => number | undefined; onJump: (f: Row) => void; onFoldAll: (fold: boolean) => void }) {
    let anchor: HTMLButtonElement | undefined;
    const [open, setOpen] = createSignal(false);
    const pick = (run: () => void) => {
        setOpen(false);
        run();
    };
    return (
        <>
            <button ref={anchor} class="tb files" aria-haspopup="menu" aria-expanded={open()} title="Jump to a file" onClick={() => setOpen(!open())}>
                <span class="lbl">{p.label}</span>
                <ChevronDown size={12} class="chev" />
            </button>
            <Menu label="Files" open={open()} anchor={() => anchor} onClose={() => setOpen(false)} placement="bottom" align="end" width={320} maxHeight={560}>
                <div class="rv-fl">
                    <Show when={open()}>
                        <For each={p.files}>
                            {(f) => (
                                <button class="menu-item rv-fl-item" role="menuitem" title={f.from ? `${f.from} → ${f.path}` : f.path} onClick={() => pick(() => p.onJump(f))}>
                                    <span class={`fs ${changeOf(f)}`} aria-label={CHANGE[changeOf(f)].label}>
                                        {CHANGE[changeOf(f)].letter}
                                    </span>
                                    <span class="nm">
                                        <b>{nameOf(f.path)}</b>
                                        <span>{dirOf(f.path) || "./"}</span>
                                    </span>
                                    <span class="aside">
                                        <Show when={p.comments(f)}>
                                            {(n) => (
                                                <span class="cm" aria-label={plural(n(), "comment")}>
                                                    <MessageSquare size={11} aria-hidden="true" />
                                                    {n()}
                                                </span>
                                            )}
                                        </Show>
                                        <Stat added={f.added} removed={f.removed} />
                                    </span>
                                </button>
                            )}
                        </For>
                    </Show>
                    <Show when={p.more}>
                        <div class="menu-note">{p.more}</div>
                    </Show>
                    <div class="menu-sep" />
                    <div class="rv-fl-foot">
                        <button class="btn ghost sm" role="menuitem" onClick={() => pick(() => p.onFoldAll(false))}>
                            Show every file
                        </button>
                        <button class="btn ghost sm" role="menuitem" onClick={() => pick(() => p.onFoldAll(true))}>
                            Fold every file
                        </button>
                    </div>
                </div>
            </Menu>
        </>
    );
}

/**
 * The stacked files' scroller: which files are near the view (their diffs are drawn) and far from it (drawn
 * no longer), the header stuck at the top, and the scroll kept on what's in view when files above it change
 * height (a diff drawn at last, one put away). WebKit doesn't anchor the scroll itself.
 */
function createStack() {
    let root: HTMLElement | undefined;
    let list: HTMLElement | undefined;
    let near: IntersectionObserver | undefined;
    let far: IntersectionObserver | undefined;
    let sizes: ResizeObserver | undefined;
    const cards = new Map<Element, { near: (v: boolean) => void; far: () => void }>();
    const byKey = new Map<string, HTMLElement>();
    const heights = new WeakMap<Element, number>();
    let stuck: Element | undefined;
    let frame = 0;
    const observe = (el: Element) => {
        near?.observe(el);
        far?.observe(el);
        sizes?.observe(el);
    };
    /** The file under the view's top: its header is the stuck one, while its file scrolls under it. */
    const markStuck = () => {
        frame = 0;
        if (!root || !list) return;
        const items = list.children;
        const y = root.scrollTop;
        const i = cardAt(items.length, (n) => (items[n] as HTMLElement).offsetTop, y);
        const card = i >= 0 ? (items[i] as HTMLElement) : undefined;
        const head = card?.firstElementChild as HTMLElement | null | undefined;
        const next = card && head && card.offsetTop < y && card.offsetTop + card.offsetHeight > y + head.offsetHeight ? head : undefined;
        if (next === stuck) return;
        stuck?.classList.remove("stuck");
        next?.classList.add("stuck");
        stuck = next;
    };
    const onScroll = () => {
        if (!frame) frame = requestAnimationFrame(markStuck);
    };
    return {
        /** The scroller and the files' list, once both are in the page. */
        attach(scroller: HTMLElement, files: HTMLElement) {
            root = scroller;
            list = files;
            // Drawn a screen ahead, put away three screens behind: a short scroll back finds them still there.
            near = new IntersectionObserver((entries) => entries.forEach((e) => cards.get(e.target)?.near(e.isIntersecting)), { root, rootMargin: "100% 0px" });
            far = new IntersectionObserver((entries) => entries.forEach((e) => !e.isIntersecting && cards.get(e.target)?.far()), { root, rootMargin: "300% 0px" });
            sizes = new ResizeObserver((entries) => {
                const changes: { top: number; before: number; after: number }[] = [];
                for (const e of entries) {
                    const el = e.target as HTMLElement;
                    const after = e.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight;
                    const before = heights.get(el);
                    heights.set(el, after);
                    if (before !== undefined && before !== after) changes.push({ top: el.offsetTop, before, after });
                }
                if (changes.length && root) {
                    const shift = anchorShift(changes.sort((a, b) => a.top - b.top), root.scrollTop);
                    if (Math.abs(shift) >= 0.5) root.scrollTop += shift;
                }
                onScroll();
            });
            for (const el of cards.keys()) observe(el);
            root.addEventListener("scroll", onScroll, { passive: true });
        },
        detach() {
            near?.disconnect();
            far?.disconnect();
            sizes?.disconnect();
            root?.removeEventListener("scroll", onScroll);
            cancelAnimationFrame(frame);
        },
        add(el: HTMLElement, k: string, hooks: { near: (v: boolean) => void; far: () => void }) {
            cards.set(el, hooks);
            byKey.set(k, el);
            observe(el);
        },
        remove(el: HTMLElement, k: string) {
            cards.delete(el);
            if (byKey.get(k) === el) byKey.delete(k);
            near?.unobserve(el);
            far?.unobserve(el);
            sizes?.unobserve(el);
            if (stuck && el.contains(stuck)) stuck = undefined;
        },
        card: (k: string) => byKey.get(k),
        /** The file whose header is at (or stuck to) the top of the view. */
        top(): HTMLElement | undefined {
            if (!root || !list) return undefined;
            const items = list.children;
            const i = cardAt(items.length, (n) => (items[n] as HTMLElement).offsetTop, root.scrollTop);
            return i >= 0 ? (items[i] as HTMLElement) : undefined;
        },
        /** Puts a file's header at the top of the view: smoothly when it's near and motion is on. */
        scrollTo(el: HTMLElement, smooth: boolean) {
            if (!root) return;
            const still = prefs.motion === "instant" || matchMedia("(prefers-reduced-motion: reduce)").matches;
            const far = Math.abs(el.offsetTop - root.scrollTop) > 2 * root.clientHeight;
            root.scrollTo({ top: el.offsetTop, behavior: smooth && !still && !far ? "smooth" : "auto" });
        },
    };
}
type Stack = ReturnType<typeof createStack>;

/** A selection with an end inside `el`. */
const selectionIn = (el: Element) => {
    const s = document.getSelection();
    return Boolean(s && !s.isCollapsed && ((s.anchorNode && el.contains(s.anchorNode)) || (s.focusNode && el.contains(s.focusNode))));
};

/**
 * One file in the stack: a sticky header (fold, git's letter, name and folder, comments, +a −d, open) over
 * its diff. The diff is drawn once the file nears the view, and put away when it's far and nothing's under
 * way in it (a comment being written, the focus, a selection); a box its last height stands in for it.
 */
function FileCard(p: {
    k: string;
    file: Row;
    stack: Stack;
    closed: boolean;
    split: boolean;
    /** Fixed for the card's life: the session's own folder's diff takes comments. */
    comments?: DiffComments;
    count?: number;
    flash: number;
    onToggle: (all: boolean) => void;
    onOpen?: () => void;
    onReveal?: () => void;
    /** A file whose hunks didn't fit in the list's reply: fetched by itself once drawn. */
    full: (f: Row) => Promise<{ file?: Row; error?: string }>;
    /** In view as the reader opens: drawn at once, not a frame later when the stack sees it near. */
    eager?: boolean;
}) {
    let el!: HTMLElement;
    let body!: HTMLDivElement;
    const [near, setNear] = createSignal(false);
    const [drawn, setDrawn] = createSignal(untrack(() => Boolean(p.eager && !p.closed)));
    /** The diff's height when it was put away, held by the box that stands in for it. */
    const [held, setHeld] = createSignal<number>();
    createEffect(() => {
        if (near() && !p.closed) setDrawn(true);
    });
    const putAway = () => {
        if (!untrack(drawn) || el.querySelector(".dc-box") || el.contains(document.activeElement) || selectionIn(el)) return;
        // Its height while it waited for its hunks says nothing of the diff's.
        setHeld(untrack(() => p.closed || shown().deferred) ? undefined : body.offsetHeight);
        setDrawn(false);
    };
    // Folded: put away once the fold has run (the diff is still there for the animation).
    createEffect(
        on(
            () => p.closed,
            (closed) => {
                if (!closed) return;
                const t = setTimeout(putAway, 450);
                onCleanup(() => clearTimeout(t));
            },
            { defer: true },
        ),
    );
    // Another layout draws every line again at another height.
    createEffect(on(() => p.split, () => setHeld(undefined), { defer: true }));
    onMount(() => p.stack.add(el, p.k, { near: setNear, far: putAway }));
    onCleanup(() => p.stack.remove(el, p.k));
    createEffect(
        on(
            () => p.flash,
            (n) => {
                if (!n) return;
                el.classList.remove("flash");
                void el.offsetWidth;
                el.classList.add("flash");
            },
            { defer: true },
        ),
    );

    // Its hunks, when the list's reply left them out: asked for once the diff is drawn, and again for each new
    // listing (a refresh: the file may have changed even if its counts didn't), not when it's only drawn again.
    // The last ones stay on screen while new ones load, so a comment being written stays with them.
    type Full = { of: Row; file?: Row; error?: string };
    let last: Full | undefined;
    const [full, { refetch }] = createResource<Full, Row>(
        () => drawn() && p.file.deferred && p.file,
        async (f, { refetching }) => (last = !refetching && last?.of === f ? last : { of: f, ...(await p.full(f)) }),
    );
    const [got, setGot] = createSignal<Row>();
    createEffect(() => {
        const r = full();
        if (r?.file) setGot(r.file);
    });
    const shown = (): Row => (p.file.deferred ? (got() ?? p.file) : p.file);
    const one = createMemo(() => oneSided(shown()));
    const rows = () => stackRows(shown());
    const ch = () => changeOf(p.file);
    const tag = () => fileTag(p.file);
    const toggle = (e: MouseEvent) => {
        if ((e.target as Element).closest(".rf-act")) return;
        // Text picked in the header (its name, say) isn't a click on it.
        if (!document.getSelection()?.isCollapsed && selectionIn(e.currentTarget as Element)) return;
        p.onToggle(e.altKey);
    };
    return (
        <section ref={el} class="rf" classList={{ closed: p.closed, instant: !foldsSmoothly(rows()) }} aria-label={p.file.path}>
            <div class="rf-h" onClick={toggle}>
                <button
                    class="tog"
                    aria-expanded={!p.closed}
                    aria-label={`${p.closed ? "Show" : "Fold"} ${p.file.path}`}
                    title={`${p.closed ? "Show" : "Fold"} (⌥-click: every file)`}
                    onClick={(e) => {
                        e.stopPropagation();
                        p.onToggle(e.altKey);
                    }}
                >
                    <ChevronRight size={14} />
                </button>
                <span class={`fs ${ch()}`} title={CHANGE[ch()].label} aria-label={CHANGE[ch()].label}>
                    {CHANGE[ch()].letter}
                </span>
                <span class="path" title={p.file.from ? `${p.file.from} → ${p.file.path}` : p.file.path}>
                    <b class="selectable">{nameOf(p.file.path)}</b>
                    <Show when={dirOf(p.file.path) || tag()}>
                        <span class="selectable">{[dirOf(p.file.path), tag()].filter(Boolean).join(" · ")}</span>
                    </Show>
                </span>
                <Show when={p.count}>
                    {(n) => (
                        <span class="cm" title={plural(n(), "comment")} aria-label={plural(n(), "comment")}>
                            <MessageSquare size={12} aria-hidden="true" />
                            {n()}
                        </span>
                    )}
                </Show>
                <Stat added={shown().added} removed={shown().removed} />
                <Show when={p.onOpen}>
                    <button class="open rf-act" title={`Open in ${editorName() ?? "your editor"}`} aria-label={`Open ${p.file.path} in editor`} onClick={() => p.onOpen!()}>
                        <SquareArrowOutUpRight size={14} />
                    </button>
                </Show>
                <Show when={p.onReveal}>
                    <button class="open rf-act" title="Reveal in Finder" aria-label={`Reveal ${p.file.path} in Finder`} onClick={() => p.onReveal!()}>
                        <FolderOpen size={14} />
                    </button>
                </Show>
            </div>
            <div class="rf-b">
                <div class="rf-in" ref={body}>
                    <Show when={drawn()} fallback={<Show when={!p.closed}>{<div class="rf-ph" style={held() ? { height: `${held()}px` } : { "--rows": rows() }} />}</Show>}>
                        <Show
                            when={!shown().deferred}
                            fallback={
                                <div class="rv-empty rf-wait selectable">
                                    <Show when={!full.loading && full()?.error} fallback={<Spinner size={16} />}>
                                        {full()!.error}{" "}
                                        <button class="link-btn" onClick={() => void refetch()}>
                                            Try again
                                        </button>
                                    </Show>
                                </div>
                            }
                        >
                            <DiffView diff={shown()} split={p.split && !one()} oneSide={one()} windowed comments={p.comments} />
                        </Show>
                    </Show>
                </div>
            </div>
        </section>
    );
}

export function ReviewPane(p: { handle: SessionHandle }) {
    const id = () => p.handle.id;
    const [publishRequest, setPublishRequest] = createSignal<string>();
    createEffect(on(id, () => setPublishRequest(undefined)));
    const saved = lastView.get(p.handle.id);
    /** A request for a file or a view (a turn's Review changes, the side panel's files) is about the session's own folder, unless it names another worktree. */
    const asksOwn = (r: ReturnType<typeof review>) => Boolean(r && r.worktree === undefined && (r.scope || r.turnId !== undefined || r.path));
    const opened = (c: ReviewPlace, r: ReturnType<typeof review>): ReviewPlace => {
        // A turn's card naming another worktree it worked in: that worktree, on its branch.
        if (r?.worktree !== undefined) return requestWorktree(c, r.worktree);
        const here = asksOwn(r) ? pickWorktree(c, undefined) : c;
        return r?.scope ? pickScope(here, r.scope) : here;
    };
    // Which folder, view and base: the session's own, or another worktree's (lib/worktree-work.ts); kept per session while the app runs.
    // First opened while the agent works in another worktree: that one.
    const agentIn = () => p.handle.view.state.workingIn?.path;
    const start: ReviewPlace = saved ? { worktree: saved.worktree, scope: saved.scope ?? "uncommitted", base: saved.base, own: saved.own } : followAgent({ scope: "uncommitted" }, agentIn(), undefined);
    const [place, setPlace] = createSignal<ReviewPlace>(opened(start, review()));
    // The agent moving while the reader is open: it follows.
    createEffect(on(agentIn, (now, was) => setPlace((c) => followAgent(c, now, was)), { defer: true }));
    const scope = () => place().scope;
    const base = () => place().base;
    /** Another worktree being looked at; undefined for the session's own folder. */
    const worktree = () => place().worktree;
    const away = () => worktree() !== undefined;
    const setBase = (b: string | undefined) => setPlace((c) => ({ ...c, base: b }));
    const [turnId, setTurnId] = createSignal<number | undefined>(review()?.turnId ?? saved?.turnId);
    /** The file asked for (the side panel's row, a turn's card): scrolled to once it's listed, or fetched by itself. */
    const [picked, setPicked] = createSignal<ReviewPick>();
    /** A pick still to scroll to. */
    const [jump, setJump] = createSignal<ReviewPick>();
    const asPick = (r: { path?: string; token?: string } | undefined): ReviewPick | undefined => (r?.path !== undefined ? { path: r.path, ...(r.token ? { token: r.token } : {}) } : undefined);
    const ask = (pick: ReviewPick | undefined) => batch(() => {
        setPicked(pick);
        setJump(pick);
    });
    // Start on the file and view it was opened for; a new request moves there.
    createEffect(
        on(
            review,
            (r) => {
                setPlace((c) => opened(c, r));
                if (r?.turnId !== undefined) setTurnId(r.turnId);
                ask(asPick(r));
            },
            { defer: true },
        ),
    );
    ask(asPick(review()));
    createEffect(() => lastView.set(id(), { scope: scope(), base: base(), turnId: turnId(), worktree: worktree(), own: place().own }));

    const gitScope = (): GitScope => (scope() === "cavvy" ? "uncommitted" : (scope() as GitScope));
    const [git, { refetch: refetchGit }] = useGitChanges(() => p.handle, gitScope, () => (gitScope() === "branch" ? base() : undefined), () => (gitScope() === "turn" ? turnId() : undefined), worktree);

    // The repository's worktrees: listed once, and again each time the view menu opens, on Refresh, and when the
    // worktree looked at fails to load, so one that's been removed falls back to the session's folder.
    // (Not with each refresh of the diff: the list counts commits in every worktree.)
    const [listing, { refetch: refetchWorktrees }] = createResource(
        () => sessionReadReady(p.handle) && { id: id() },
        async ({ id }): Promise<{ list?: SessionWorktreeInfo[]; error?: string }> => {
            try {
                return { list: await rpc.call("session.worktrees", { id }) };
            } catch (e) {
                return { error: e instanceof Error ? e.message : String(e) };
            }
        },
    );
    /** The worktree looked at that went away, named until another is picked. */
    const [gone, setGone] = createSignal<string>();
    createEffect(() => {
        const list = listing()?.list;
        const was = untrack(worktree);
        if (!list || was === undefined) return;
        const next = keepWorktree(untrack(place), list);
        if (next.worktree === was) return;
        setGone(was);
        setPlace(next);
        ask(undefined);
    });
    // Its diff failing (the folder deleted, say): check whether it's still there.
    createEffect(on(() => away() && git()?.error, (e) => e && void refetchWorktrees(), { defer: true }));
    const chooseWorktree = (w: string | undefined) => {
        if (w === worktree()) return;
        batch(() => {
            setGone(undefined);
            ask(undefined);
            setPlace((c) => pickWorktree(c, w));
        });
    };
    const chooseScope = (v: ReviewScope) => batch(() => {
        ask(undefined);
        setPlace((c) => pickScope(c, v));
    });
    const chooseTurn = (t: number) => {
        if (away()) return;
        batch(() => {
            ask(undefined);
            setTurnId(t);
            setPlace((c) => pickScope(c, "turn"));
        });
    };
    /** What works in each worktree: the sessions in it, and the sub-agents the server found there. */
    const work = () => worktreeWork(listing()?.list ?? [], app.sessions, { home: app.hello?.homeDir, self: id() });
    /** Outside a Git repository, Cavvy's own record is all there is. */
    const noRepo = () => git()?.repo === false;
    const shownScope = (): ReviewScope => (noRepo() && !away() ? "cavvy" : scope());
    /** The diff on screen is the session's own folder's (not the answer for another worktree, still shown while the session's loads). */
    const own = () => ownOnScreen(worktree(), shownScope(), git());
    /** The folder the files on screen are relative to. */
    const shownRoot = () => (own() ? p.handle.view.state.cwd : (git()?.worktree ?? worktree() ?? p.handle.view.state.cwd));
    const [cavvy, { refetch: refetchCavvy }] = createResource(
        () => sessionReadReady(p.handle) && shownScope() === "cavvy" && { id: id(), n: p.handle.view.state.filesChanged, busy: p.handle.view.state.busy, outside: changedOutside() },
        ({ id }) =>
            rpc.call("session.changes", { id }).catch((e) => {
                if (sessionReadReady(p.handle)) reportError(e);
                return { files: [], added: 0, removed: 0, tracked: true };
            }),
    );
    const view = () => (shownScope() === "cavvy" ? cavvy() : git());
    const loading = () => (shownScope() === "cavvy" ? cavvy.loading : git.loading);
    const files = (): Row[] => view()?.files ?? [];
    const more = () => (shownScope() !== "cavvy" && git()?.more) || 0;
    const error = () => (shownScope() !== "cavvy" ? git()?.error : undefined);
    /** Commit opens the Commit dialog with every file; it picks from there. A collapsed folder or a nested repository can't be. */
    const commitPaths = () => files().filter((f) => f.kind !== "folder" && f.kind !== "repo").map(key);
    const commitDisabled = () => commitUnavailable(p.handle) ?? (loading() ? "Wait for changes to finish loading." : error() ? "Refresh the changes before committing." : !commitPaths().length ? "Nothing to commit." : undefined);

    const absolute = (path: string) => {
        const full = path.startsWith("/") ? path : path.startsWith("~/") && app.hello?.homeDir ? `${app.hello.homeDir}/${path.slice(2)}` : `${shownRoot()}/${path}`;
        // Files elsewhere in the repository come as ../path.
        const parts: string[] = [];
        for (const part of full.split("/")) {
            if (part === "..") parts.pop();
            else if (part !== ".") parts.push(part);
        }
        return parts.join("/") || "/";
    };
    /** Turn cards name files relative to the folder or absolutely; the lists, relative (../ for the rest of the repository). */
    const same = (a: string, b: string) => absolute(a) === absolute(b);
    const listedPick = createMemo(() => {
        const want = picked();
        return want ? findPick(files(), want, same) : undefined;
    });
    // Asked for a file the list doesn't hold (past its 300): fetched by itself, and shown above the rest. Its
    // answer counts only for the view, base and path it was asked for; the resource keeps its last.
    const unlistedKey = () => {
        const want = picked();
        return shownScope() !== "cavvy" && view() && want && !listedPick() ? JSON.stringify([id(), gitScope(), base(), turnId(), worktree(), pickKey(want)]) : undefined;
    };
    const [unlisted, { refetch: refetchUnlisted }] = createResource(
        () => {
            if (!sessionReadReady(p.handle)) return false;
            const key = unlistedKey();
            return key ? { key, id: id(), scope: gitScope(), base: base(), turnId: turnId(), worktree: worktree(), pick: picked()! } : false;
        },
        async (k) => {
            // A handle goes as one, never as a file's name.
            const q = pickParams(k.pick);
            const r = await fetchGitChanges(k.id, k.scope, k.base, q.path, k.turnId, k.worktree, q.pathToken);
            const f = r.files[0];
            return { key: k.key, file: f, error: r.error ?? (f ? undefined : "This file has no changes in this view.") };
        },
    );
    const asked = () => {
        const u = unlisted();
        return u && u.key === unlistedKey() ? u : undefined;
    };
    /** The requested file isn't in the list: it's shown on its own, or why it can't be. */
    const askedFor = () => unlistedKey() !== undefined;
    // A file whose hunks didn't fit in the list's reply, fetched on its own (for the card that draws it).
    const fetchFull = (f: Row) => {
        const k = { id: id(), scope: gitScope(), base: base(), turnId: turnId(), worktree: worktree() };
        return fetchGitChanges(k.id, k.scope, k.base, f.path, k.turnId, k.worktree, f.pathToken).then((r) => {
            const got = r.files[0];
            return { file: got && !got.deferred ? got : undefined, error: r.error ?? (got ? "Couldn't load this diff." : "This file no longer has changes. Refresh the list.") };
        });
    };
    // A failed Branch view (no main branch to default to) still needs branches to pick from.
    const [fallback] = createResource(
        () => (sessionReadReady(p.handle) && gitScope() === "branch" && git()?.error && !git()?.bases.length ? { id: id(), worktree: worktree() } : false),
        (k) => fetchGitChanges(k.id, "uncommitted", undefined, undefined, undefined, k.worktree),
    );
    const bases = () => (git()?.bases.length ? git()!.bases : (fallback()?.bases ?? []));
    /** The picked base's name to show: a handle (a name shown redacted) never is; its listed name is, if known. */
    const baseLabel = () => {
        const b = base();
        if (!b?.startsWith("git:")) return b;
        const i = (git()?.bases.length ? git()!.baseTokens : fallback()?.baseTokens)?.indexOf(b) ?? -1;
        return i >= 0 ? bases()[i] : undefined;
    };

    const refresh = () => {
        void refetchGit();
        if (away()) void refetchWorktrees();
        if (shownScope() === "cavvy") void refetchCavvy();
    };

    /** A file's comments: by its handle when its name was shown redacted (another may show the same), else by name. They wait in this session's composer until the next message. */
    const commentsFor = (f: Row): DiffComments => ({
        get list() {
            return reviewComments.list(id()).filter((c) => (f.pathToken ? c.fileKey === f.pathToken : !c.fileKey && same(c.path, f.path)));
        },
        add: (lines, text, around) => {
            const c = buildComment({ id: newCommentId(), path: f.path, ...(f.pathToken ? { fileKey: f.pathToken } : {}), lines, text, ...around });
            if (c) reviewComments.add(id(), c);
        },
        edit: (commentId, text) => reviewComments.edit(id(), commentId, text),
        remove: (commentId) => reviewComments.remove(id(), [commentId]),
    });
    /** How many comments each listed file has. */
    const commentCounts = createMemo(() => {
        const out = new Map<string, number>();
        // Another worktree's files take no comments, and the session's don't belong on them.
        if (!own()) return out;
        for (const c of reviewComments.list(id())) {
            const k = c.fileKey ?? absolute(c.path);
            out.set(k, (out.get(k) ?? 0) + 1);
        }
        return out;
    });
    const countOf = (f: Row) => commentCounts().get(f.pathToken ?? absolute(f.path));

    const count = () => {
        const n = files().length + more();
        const plus = shownScope() !== "cavvy" && git()?.moreAtLeast ? "+" : "";
        return plus ? `${n.toLocaleString()}+ files` : plural(n, "file");
    };
    const moreLabel = () => (more() ? `${more().toLocaleString()}${git()?.moreAtLeast ? "+" : ""} more not shown` : undefined);
    const branchLabel = () => git()?.head?.branch ?? (git()?.head?.sha ? `HEAD ${git()!.head!.sha!.slice(0, 7)}` : "HEAD");
    const empty = () => {
        const v = view();
        if (!v) return undefined;
        if (shownScope() === "cavvy") return v.tracked === false ? "This session isn't saved yet." : "No file changes yet. Edits Cavvy's tools make show up here as a reviewable diff.";
        if (shownScope() === "branch") return `Nothing has changed since ${branchLabel()} left ${git()?.base?.ref ?? "its base"}.`;
        if (shownScope() === "turn" || shownScope() === "last-turn") return git()?.incomplete ? "This turn’s snapshot is incomplete." : "No file changes in this turn.";
        return "Nothing to commit: the working tree matches the last commit.";
    };
    const menu = createMemo(() => viewMenu({ place: place(), turnId: turnId(), repo: !noRepo(), reason: git()?.reason, turns: git()?.turns, busy: p.handle.view.state.busy, branch: git()?.head ? branchLabel() : undefined, base: git()?.base?.ref ?? baseLabel() ?? git()?.defaultBase }));
    /** The branch of the worktree looked at, for the chip and the notice. */
    const awayBranch = () => {
        const w = worktree();
        if (w === undefined) return undefined;
        const listed = listing()?.list?.find((x) => x.path === w);
        return listed ? worktreeLabel(listed) : (git()?.head?.branch ?? nameOf(w));
    };

    // ---- The stack: which files are folded, the one asked for scrolled to and flashed.
    /** Folded files, by card. Kept as views change: the same file folded in one stays folded in the next. */
    const [closed, setClosed] = createSignal<ReadonlySet<string>>(new Set());
    const [flash, setFlash] = createSignal<{ k: string; n: number }>();
    const stack = createStack();
    let scroller!: HTMLDivElement;
    let listEl!: HTMLDivElement;
    onMount(() => stack.attach(scroller, listEl));
    onCleanup(() => stack.detach());
    /** A card per file and folder: the same file in another worktree is another card (it takes no comments). */
    const cardKey = (f: Row) => JSON.stringify([own() ? null : shownRoot(), key(f)]);
    const ASKED = "asked";
    // By key, not by the file's object: a refresh (an edit landing, a turn ending) updates each diff in place,
    // so a comment being written, the scroll and the focus all stay.
    const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);
    const keys = createMemo(() => files().map(cardKey), [], { equals: sameKeys });
    const byKey = createMemo(() => new Map(files().map((f) => [cardKey(f), f] as const)));
    /** The files in the first screenful, by their rows: drawn as their cards are made. */
    const eager = createMemo(() => {
        const out = new Set<string>();
        let y = 0;
        const room = untrack(() => scroller?.clientHeight) || 900;
        for (const f of files()) {
            if (y > room) break;
            out.add(cardKey(f));
            y += CARD_PX + stackRows(f) * ROW_PX;
        }
        return out;
    });
    // Cards made so far: the first screen's and a few more at once, then a part a frame, so a 300-file
    // view opens like a one-file one. Another view starts over (keeping the cards it still lists).
    const [made, setMade] = createSignal(0);
    const first = () => untrack(eager).size + FIRST_CARDS;
    createEffect(on(() => [shownScope(), base(), turnId(), worktree()], () => setMade(0), { defer: true }));
    createEffect(on(() => keys().length > 0 && made() === 0, (start) => start && setMade(first())));
    createEffect(() => {
        const m = made();
        if (!m || m >= keys().length) return;
        const f = requestAnimationFrame(() => setMade(m + MORE_CARDS));
        onCleanup(() => cancelAnimationFrame(f));
    });
    // A card still listed in another view (another base, say) stays as it is, a comment being written with it;
    // the rest are made a part at a time again.
    const madeKeys = createMemo<readonly string[]>(
        (was) => {
            const kept = new Set(was);
            return keys().filter((k, i) => i < made() || kept.has(k));
        },
        [],
        { equals: sameKeys },
    );
    const setFold = (ks: readonly string[], fold: boolean) =>
        setClosed((old) => {
            const next = new Set(old);
            for (const k of ks) fold ? next.add(k) : next.delete(k);
            return next;
        });
    /** Folding the file being read (its header stuck), or every file: the file at the top stays at the top. */
    const toggle = (k: string, all: boolean) => {
        const fold = !closed().has(k);
        const top = all ? stack.top() : stack.card(k);
        if (top && top.offsetTop < scroller.scrollTop) scroller.scrollTop = top.offsetTop;
        setFold(all ? [...keys(), ...(asked()?.file ? [ASKED] : [])] : [k], fold);
    };
    const jumpTo = (k: string, smooth: boolean) => {
        setFold([k], false);
        const i = keys().indexOf(k);
        if (i >= made()) setMade(i + 1);
        requestAnimationFrame(() => {
            const el = stack.card(k);
            if (!el) return;
            stack.scrollTo(el, smooth);
            setFlash((f) => ({ k, n: (f?.n ?? 0) + 1 }));
        });
    };
    // A file asked for: scrolled to once its card is there (listed, or fetched by itself above the rest).
    // Not against the last view's answer, still shown while the new one loads: its cards are about to go.
    createEffect(() => {
        if (!jump() || loading()) return;
        const f = listedPick();
        const there = f ? cardKey(f) : asked()?.file ? ASKED : undefined;
        if (!there) return;
        setJump(undefined);
        jumpTo(there, false);
    });

    const card = (k: string, f: () => Row, comments: DiffComments | undefined) => (
        <FileCard
            k={k}
            file={f()}
            stack={stack}
            closed={closed().has(k)}
            split={reviewSplit()}
            comments={comments}
            count={countOf(f())}
            flash={flash()?.k === k ? flash()!.n : 0}
            onToggle={(all) => toggle(k, all)}
            // The editor opens files in the session's folders only (fs.open confines it); another worktree's file can be revealed in Finder.
            onOpen={own() && changeOf(f()) !== "deleted" && f().kind !== "repo" && f().kind !== "submodule" ? () => void openInEditor(absolute(f().path), undefined, { gitToken: f().pathToken }) : undefined}
            onReveal={canReveal ? () => void (f().pathToken ? openInEditor("", undefined, { gitToken: f().pathToken, editor: "finder" }) : revealPath(absolute(f().path))).catch(reportError) : undefined}
            full={fetchFull}
            eager={eager().has(k) || (jump() !== undefined && listedPick() !== undefined && cardKey(listedPick()!) === k)}
        />
    );

    return (
        <section class="review" aria-label="Review changes">
            <Show when={shellLayout().inspector.mode === "dock"}>
                <ReviewResizer />
            </Show>
            <div class="rv-h">
                <button class="hb rv-back" title={prefs.panel ? "Back to the side panel (Esc)" : "Close (Esc)"} aria-label="Close review" onClick={() => setReview(undefined)}>
                    <Show when={prefs.panel} fallback={<X size={16} />}>
                        <ChevronLeft size={16} />
                    </Show>
                </button>
                <ViewMenu
                    label={viewLabel(shownScope(), turnId(), git()?.turns)}
                    away={awayBranch()}
                    menu={menu()}
                    worktreesShown={!noRepo() || away()}
                    value={worktree()}
                    worktrees={listing()?.list}
                    loading={listing.loading}
                    error={listing()?.error}
                    work={work}
                    onOpen={() => void refetchWorktrees()}
                    onView={chooseScope}
                    onTurn={chooseTurn}
                    onWorktree={chooseWorktree}
                />
                <Show when={shownScope() === "branch"}>
                    <BasePicker value={git()?.base?.ref ?? baseLabel() ?? git()?.defaultBase} current={git()?.base ? (git()!.base!.refToken ?? git()!.base!.ref) : (base() ?? git()?.defaultBaseToken ?? git()?.defaultBase)} bases={bases()} tokens={git()?.bases.length ? git()!.baseTokens : fallback()?.baseTokens} onPick={setBase} />
                </Show>
                <span class="grow" />
                <Show when={files().length}>
                    <FilesMenu label={count()} files={files()} more={moreLabel()} comments={countOf} onJump={(f) => jumpTo(cardKey(f), true)} onFoldAll={(fold) => {
                        const top = stack.top();
                        if (fold && top && top.offsetTop < scroller.scrollTop) scroller.scrollTop = top.offsetTop;
                        setFold([...keys(), ...(asked()?.file ? [ASKED] : [])], fold);
                    }} />
                    <span class="stat rv-total" title={`${count()}, +${view()?.added ?? 0} −${view()?.removed ?? 0} in all`}>
                        <span class="add">+{view()?.added ?? 0}</span>
                        <span class="del">−{view()?.removed ?? 0}</span>
                    </span>
                    <span class="sep" />
                </Show>
                <SplitToggle />
                <button class="hb" title="Refresh" aria-label="Refresh" disabled={loading()} onClick={refresh}>
                    <Show when={loading()} fallback={<RefreshCw size={15} />}>
                        <Spinner size={14} />
                    </Show>
                </button>
            </div>
            <div ref={scroller} class="insp-body rv-body" aria-busy={loading()}>
                <Show when={away()}>
                    <div class="rv-slim away selectable" role="status">
                        <FolderGit2 size={14} />
                        <span class="grow">
                            Reading <b>{awayBranch()}</b>. Comments, Commit and Push stay with this session's folder.
                        </span>
                        <button class="link-btn" onClick={() => chooseWorktree(undefined)}>
                            Back to this session
                        </button>
                    </div>
                </Show>
                {/* Mounted with Push (its dialog is PublishStatus's); its row shows in Branch view. */}
                <Show when={git()?.repo && own()}>
                    <div class="rv-pr selectable" classList={{ hidden: shownScope() !== "branch" }}>
                        <PublishStatus handle={p.handle} request={publishRequest()} onClose={() => setPublishRequest(undefined)} />
                    </div>
                </Show>
                <Show when={noRepo() && !away() && git()?.reason}>
                    <div class="rv-slim selectable">{git()!.reason} Cavvy edits shows what its own tools changed.</div>
                </Show>
                <Show when={gone()}>
                    {(w) => (
                        <div class="rv-slim warn selectable" role="status" title={`The worktree ${w()} is gone, so this shows this session's folder.`}>
                            The worktree {w()} is gone, so this shows this session's folder.
                        </div>
                    )}
                </Show>
                <Show when={shownScope() !== "cavvy" && (git()?.incomplete || git()?.notes?.length)}>
                    <div class="rv-slim warn selectable" role="status" title={`${git()?.incomplete ? "This turn’s snapshot is incomplete. " : ""}${git()?.notes?.join(" ") ?? ""}`}>
                        {git()?.incomplete ? "This turn’s snapshot is incomplete. " : ""}
                        {git()?.notes?.join(" ")}
                    </div>
                </Show>
                <Show when={askedFor() && !asked()?.file}>
                    <div class="rv-slim selectable">
                        <Show when={!unlisted.loading && asked()?.error} fallback={<Spinner size={14} />}>
                            <span class="grow">
                                {picked()?.path}: {asked()!.error}
                            </span>
                            <button class="link-btn" onClick={() => void refetchUnlisted()}>
                                Try again
                            </button>
                        </Show>
                    </div>
                </Show>
                <div ref={listEl} class="rf-list">
                    {/* By the pick, not the file's object: fetched again, the same file updates in place. */}
                    <Show when={asked()?.file && JSON.stringify([own() ? null : shownRoot(), pickKey(picked()!)])} keyed>
                        {(k) => {
                            let last = asked()!.file!;
                            const f = () => (last = asked()?.file ?? last);
                            return card(ASKED, f, JSON.parse(k)[0] === null ? commentsFor(f()) : undefined);
                        }}
                    </Show>
                    <For each={madeKeys()}>
                        {(k) => {
                            let last = byKey().get(k)!;
                            const f = () => (last = byKey().get(k) ?? last);
                            const [wt] = JSON.parse(k) as [string | null, string];
                            return card(k, f, wt === null ? commentsFor(f()) : undefined);
                        }}
                    </For>
                </div>
                <Show when={moreLabel()}>
                    <div class="rv-more">{moreLabel()}</div>
                </Show>
                <Show when={!files().length && !asked()?.file}>
                    <div class="rv-empty selectable">
                        <Show when={!error()} fallback={<ErrorNote error={error()!} base={base()} onReset={() => setBase(undefined)} />}>
                            <Show when={view()} fallback={<Spinner size={16} />}>
                                {empty()}
                            </Show>
                        </Show>
                    </div>
                </Show>
            </div>
            <Show when={!noRepo() && own()}>
                <div class="insp-foot">
                    <Show when={shownScope() === "uncommitted"}>
                        <span class="grow" title={commitDisabled() ?? "Commit: pick the files in the Commit dialog"}>
                            <button class="btn ghost" disabled={Boolean(commitDisabled())} onClick={() => setCommitRequest({ id: id(), paths: commitPaths() })}>
                                <GitCommitHorizontal size={14} /> Commit…
                            </button>
                        </span>
                    </Show>
                    <span class="grow" title={commitUnavailable(p.handle)?.replace(/committing/g, "pushing") ?? "Push the branch, and open a pull request"}>
                        <button class="btn primary" disabled={Boolean(commitUnavailable(p.handle))} onClick={() => setPublishRequest(id())}>
                            <GitPullRequestArrow size={14} /> Push…
                        </button>
                    </span>
                </div>
            </Show>
        </section>
    );
}

function ErrorNote(p: { error: string; base?: string; onReset: () => void }) {
    return (
        <>
            {p.error}
            <Show when={p.base}>
                {" "}
                <button class="link-btn" onClick={() => p.onReset()}>
                    Compare with the main branch
                </button>
            </Show>
        </>
    );
}
