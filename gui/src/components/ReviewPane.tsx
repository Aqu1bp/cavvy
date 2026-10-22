// The diff reader: the inspector widens into it (lib/layout.ts). Its head names
// the file in view, with Unified | Split and Open in editor; under it, which
// changes (uncommitted, the branch, a turn, or Harness's own edits) and the
// files as pills; then the diff, where lines take comments for the next
// message; Commit and Push at the foot. Opened from the side panel, the title
// bar's changes chip or a turn's Review changes. Git's views show every change
// in the folder, whoever made it; Harness edits shows only what the edit tools
// did, and is all there is outside a Git repository. A picker beside the views
// looks at another worktree of the repository instead (where an agent works):
// its branch and uncommitted changes only, to read; commenting, committing,
// pushing and opening in the editor stay with the session's own folder.

import { batch, createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show, untrack } from "solid-js";
import { ChevronLeft, FolderOpen, GitBranch, GitCommitHorizontal, GitPullRequestArrow, MessageSquare, RefreshCw, SquareArrowOutUpRight, X } from "lucide-solid";
import type { FileDiff, GitFileDiff, GitScope, SessionWorktreeInfo } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { app, reportError, rpc } from "../state/app";
import { prefs, setPrefs } from "../state/prefs";
import { review, reviewSplit, setCommitRequest, setReview, setReviewDrag, setReviewSplit, shellLayout } from "../state/ui";
import { frameDrag } from "../lib/drag";
import { changedOutside, commitUnavailable, fetchGitChanges, lastView, sessionReadReady, useGitChanges, type ReviewScope } from "../state/changes";
import { editorName, openInEditor } from "../state/actions";
import { canReveal, revealPath } from "../lib/platform";
import { plural } from "../lib/format";
import { CHANGE, dirOf, nameOf, REVIEW_DEFAULT, REVIEW_STEP, reviewDragWidth, reviewWidthRange } from "../lib/inspector";
import { DiffView, type DiffComments } from "./blocks/DiffView";
import { buildComment } from "../lib/review-comments";
import { findPick, pickKey, pickOf, pickParams, type ReviewPick } from "../lib/review-pick";
import { newCommentId, reviewComments } from "../state/review-comments";
import { PublishStatus } from "./PublishStatus";
import { BasePicker } from "./BasePicker";
import { ReviewWorktreePicker } from "./ReviewWorktreePicker";
import { keepWorktree, ownOnScreen, pickScope, pickWorktree, worktreeWork, type ReviewPlace } from "../lib/worktree-work";
import { Segmented, Spinner } from "./ui/bits";

type Row = FileDiff & Partial<Pick<GitFileDiff, "change" | "from" | "kind" | "deferred" | "filter" | "pathToken">>;
/** A file here: by its handle when its name was shown redacted (two can show the same name), else by name. */
const key = (f: Row) => f.pathToken ?? f.path;

const changeOf = (f: Row): GitFileDiff["change"] => f.change ?? f.status;

const SCOPE_NOTE: Record<ReviewScope, string> = {
    uncommitted: "Everything that differs from the last commit: staged, unstaged and untracked files, whoever changed them.",
    branch: "Everything on this branch since it left its base, committed or not.",
    "last-turn": "The last recorded turn’s start and end snapshots. Ignored files are excluded. Changes from other sessions in this folder are included.",
    turn: "This turn’s start and end snapshots. Ignored files are excluded. Changes from other sessions in this folder are included.",
    harness: "Only what Harness's own edit tools changed in this session. Shell commands and Claude Code or Codex edits aren't included.",
};

/** One file, as a pill: its git letter and name (the path on hover), a box to leave it out of a commit, its comments. */
function FilePill(p: { file: Row; on: boolean; onSelect: () => void; commit?: boolean; checked?: boolean; onCheck?: (checked: boolean) => void; comments?: number }) {
    const c = () => CHANGE[changeOf(p.file)];
    const stat = () => (p.file.added || p.file.removed ? ` · +${p.file.added} −${p.file.removed}` : "");
    return (
        <div class={`rv-file ${p.on ? "on" : ""}`}>
            <Show when={p.commit}>
                <span class="rv-check" title={p.file.kind === "folder" ? "This folder is collapsed; select individual files instead." : p.file.kind === "repo" ? "Nested repositories cannot be committed as files." : `Include ${p.file.path} in commit`}>
                    <input type="checkbox" aria-label={`Include ${p.file.path} in commit`} checked={p.checked} disabled={p.file.kind === "folder" || p.file.kind === "repo"} onChange={(e) => p.onCheck?.(e.currentTarget.checked)} />
                </span>
            </Show>
            <button aria-current={p.on} title={`${p.file.from ? `${p.file.from} → ${p.file.path}` : p.file.path}${stat()}`} onClick={() => p.onSelect()}>
                <span class={`fs ${changeOf(p.file)}`} title={c().label} aria-label={c().label}>
                    {c().letter}
                </span>
                <span class="truncate">{nameOf(p.file.path)}</span>
                <Show when={p.comments}>
                    <span class="rv-cmts" title={plural(p.comments!, "comment")} aria-label={plural(p.comments!, "comment")}>
                        <MessageSquare size={11} aria-hidden="true" />
                        {p.comments}
                    </span>
                </Show>
            </button>
        </div>
    );
}

/** What happened to the file, when it's more than an edit: "New file", "Renamed from …", "Symbolic link". */
function fileTag(f: Row): string | undefined {
    const ch = changeOf(f);
    if (f.kind === "link") return "Symbolic link";
    // Its diff, when there is one, is of what git stores (an LFS pointer, say), not the file on disk.
    if (f.filter) return `Filter: ${f.filter}`;
    if (f.kind === "submodule") return "Submodule";
    if (ch === "modified") return undefined;
    return ch === "added" ? "New file" : ch === "renamed" ? `Renamed from ${f.from}` : CHANGE[ch].label;
}

/** Unified, or side by side; side by side widens the inspector further (lib/layout.ts). Kept while the app runs. */
function DiffLayout() {
    return (
        <Segmented
            label="Diff layout"
            size="sm"
            value={reviewSplit() ? "split" : "unified"}
            onChange={(v) => setReviewSplit(v === "split")}
            options={[
                { value: "unified", label: "Unified" },
                { value: "split", label: "Split" },
            ]}
        />
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

export function ReviewPane(p: { handle: SessionHandle }) {
    const id = () => p.handle.id;
    const [publishRequest, setPublishRequest] = createSignal<string>();
    createEffect(on(id, () => setPublishRequest(undefined)));
    const saved = lastView.get(p.handle.id);
    /** A request for a file or a view (a turn's Review changes, the side panel's files) is about the session's own folder. */
    const asksOwn = (r: ReturnType<typeof review>) => Boolean(r && (r.scope || r.turnId !== undefined || r.path));
    const opened = (c: ReviewPlace, r: ReturnType<typeof review>): ReviewPlace => {
        const here = asksOwn(r) ? pickWorktree(c, undefined) : c;
        return r?.scope ? pickScope(here, r.scope) : here;
    };
    // Which folder, view and base: the session's own, or another worktree's (lib/worktree-work.ts); kept per session while the app runs.
    const [place, setPlace] = createSignal<ReviewPlace>(opened({ worktree: saved?.worktree, scope: saved?.scope ?? "uncommitted", base: saved?.base, own: saved?.own }, review()));
    const scope = () => place().scope;
    const base = () => place().base;
    /** Another worktree being looked at; undefined for the session's own folder. */
    const worktree = () => place().worktree;
    const away = () => worktree() !== undefined;
    const setScope = (v: ReviewScope) => setPlace((c) => pickScope(c, v));
    const setBase = (b: string | undefined) => setPlace((c) => ({ ...c, base: b }));
    const [turnId, setTurnId] = createSignal<number | undefined>(review()?.turnId ?? saved?.turnId);
    const [picked, setPicked] = createSignal<ReviewPick>();
    const asPick = (r: { path?: string; token?: string } | undefined): ReviewPick | undefined => (r?.path !== undefined ? { path: r.path, ...(r.token ? { token: r.token } : {}) } : undefined);
    const [unchecked, setUnchecked] = createSignal(new Set<string>());
    createEffect(on(id, () => setUnchecked(new Set<string>())));
    // Start on the file and view it was opened for; a new request moves there.
    createEffect(
        on(
            review,
            (r) => {
                setPlace((c) => opened(c, r));
                if (r?.turnId !== undefined) setTurnId(r.turnId);
                setPicked(asPick(r));
            },
            { defer: true },
        ),
    );
    setPicked(asPick(review()));
    createEffect(() => lastView.set(id(), { scope: scope(), base: base(), turnId: turnId(), worktree: worktree(), own: place().own }));

    const gitScope = (): GitScope => (scope() === "harness" ? "uncommitted" : (scope() as GitScope));
    const [git, { refetch: refetchGit }] = useGitChanges(() => p.handle, gitScope, () => (gitScope() === "branch" ? base() : undefined), () => (gitScope() === "turn" ? turnId() : undefined), worktree);

    // The repository's worktrees: listed once, and again each time the picker opens, on Refresh, and when the
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
        setPicked(undefined);
    });
    // Its diff failing (the folder deleted, say): check whether it's still there.
    createEffect(on(() => away() && git()?.error, (e) => e && void refetchWorktrees(), { defer: true }));
    const chooseWorktree = (w: string | undefined) => {
        if (w === worktree()) return;
        setGone(undefined);
        setPicked(undefined);
        setUnchecked(new Set<string>());
        setPlace((c) => pickWorktree(c, w));
    };
    /** What works in each worktree: the sessions in it, and the sub-agents the server found there. */
    const work = () => worktreeWork(listing()?.list ?? [], app.sessions, { home: app.hello?.homeDir, self: id() });
    /** Outside a Git repository, Harness's own record is all there is. */
    const noRepo = () => git()?.repo === false;
    const shownScope = (): ReviewScope => (noRepo() && !away() ? "harness" : scope());
    /** The diff on screen is the session's own folder's (not the answer for another worktree, still shown while the session's loads). */
    const own = () => ownOnScreen(worktree(), shownScope(), git());
    /** The folder the files on screen are relative to. */
    const shownRoot = () => (own() ? p.handle.view.state.cwd : (git()?.worktree ?? worktree() ?? p.handle.view.state.cwd));
    const [harness, { refetch: refetchHarness }] = createResource(
        () => sessionReadReady(p.handle) && shownScope() === "harness" && { id: id(), n: p.handle.view.state.filesChanged, busy: p.handle.view.state.busy, outside: changedOutside() },
        ({ id }) =>
            rpc.call("session.changes", { id }).catch((e) => {
                if (sessionReadReady(p.handle)) reportError(e);
                return { files: [], added: 0, removed: 0, tracked: true };
            }),
    );
    const view = () => (shownScope() === "harness" ? harness() : git());
    const loading = () => (shownScope() === "harness" ? harness.loading : git.loading);
    const files = (): Row[] => view()?.files ?? [];
    const more = () => (shownScope() !== "harness" && git()?.more) || 0;
    const error = () => (shownScope() !== "harness" ? git()?.error : undefined);
    const selected = () => files().filter((f) => f.kind !== "folder" && f.kind !== "repo" && !unchecked().has(key(f))).map(key);
    const commitDisabled = () => commitUnavailable(p.handle) ?? (loading() ? "Wait for changes to finish loading." : error() ? "Refresh the changes before committing." : !selected().length ? "Select files to commit." : undefined);
    const check = (path: string, checked: boolean) => setUnchecked((old) => {
        const next = new Set(old);
        if (checked) next.delete(path);
        else next.add(path);
        return next;
    });

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
    // Asked for a file the list doesn't hold (past its 300): fetched by itself. Its answer
    // counts only for the view, base and path it was asked for; the resource keeps its last.
    const unlistedKey = () => {
        const want = picked();
        return shownScope() !== "harness" && view() && want && !listedPick() ? JSON.stringify([id(), gitScope(), base(), turnId(), worktree(), pickKey(want)]) : undefined;
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
    const file = createMemo((): Row | undefined => listedPick() ?? asked()?.file ?? (askedFor() ? undefined : files()[0]));
    // A file whose hunks didn't fit in the list's reply is fetched on its own.
    // Like the unlisted file, its answer counts only for the session, view, base and path it was asked for.
    const fullKey = () => {
        const f = file();
        return shownScope() !== "harness" && f?.deferred ? JSON.stringify([id(), gitScope(), base(), turnId(), worktree(), key(f)]) : undefined;
    };
    const [full, { refetch: refetchFull }] = createResource(
        () => {
            if (!sessionReadReady(p.handle)) return false;
            const key = fullKey();
            return key ? { key, id: id(), scope: gitScope(), base: base(), turnId: turnId(), worktree: worktree(), path: file()!.path, pathToken: file()!.pathToken } : false;
        },
        async (k) => {
            const r = await fetchGitChanges(k.id, k.scope, k.base, k.path, k.turnId, k.worktree, k.pathToken);
            const f = r.files[0];
            return { key: k.key, file: f && !f.deferred ? f : undefined, error: r.error ?? (f ? "Couldn't load this diff." : "This file no longer has changes. Refresh the list.") };
        },
    );
    const loaded = () => {
        const l = full();
        return l && l.key === fullKey() ? l : undefined;
    };
    const shownFile = (): Row | undefined => (file()?.deferred ? (loaded()?.file ?? file()) : file());
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
        if (shownScope() === "harness") void refetchHarness();
    };

    /** Comments on the shown file: they wait in this session's composer until the next message. */
    /** A file's comments: by its handle when its name was shown redacted (another may show the same), else by name. */
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

    const count = () => {
        const n = files().length + more();
        const plus = shownScope() !== "harness" && git()?.moreAtLeast ? "+" : "";
        return plus ? `${n.toLocaleString()}+ files` : plural(n, "file");
    };
    const branchLabel = () => git()?.head?.branch ?? (git()?.head?.sha ? `HEAD ${git()!.head!.sha!.slice(0, 7)}` : "HEAD");
    const empty = () => {
        const v = view();
        if (!v) return undefined;
        if (shownScope() === "harness") return v.tracked === false ? "This session isn't saved yet." : "No file changes yet. Edits Harness's tools make show up here as a reviewable diff.";
        if (shownScope() === "branch") return `Nothing has changed since ${branchLabel()} left ${git()?.base?.ref ?? "its base"}.`;
        if (shownScope() === "turn" || shownScope() === "last-turn") return git()?.incomplete ? "This turn’s snapshot is incomplete." : "No file changes in this turn.";
        return "Nothing to commit: the working tree matches the last commit.";
    };
    /** "2 of 3 files, +19 −4 in all." */
    const where = () => {
        const shown = file();
        const i = shown ? files().findIndex((f) => key(f) === key(shown)) : -1;
        const all = `+${view()?.added ?? 0} −${view()?.removed ?? 0} in all`;
        return i < 0 ? `${count()}, ${all}.` : `${i + 1} of ${count()}, ${all}.`;
    };
    /** The file the head names: the one shown, or the one asked for while it loads. */
    const headPath = () => shownFile()?.path ?? (askedFor() ? picked()?.path : undefined);
    const headSub = () => {
        const path = headPath();
        if (!path) return files().length ? count() : "";
        const tag = shownFile() && fileTag(shownFile()!);
        const dir = dirOf(path);
        return [dir, tag].filter(Boolean).join(" · ");
    };
    // The editor opens files in the session's folders only (fs.open confines it); another worktree's file can be revealed in Finder.
    const canOpen = () => {
        const f = shownFile();
        return Boolean(own() && f && changeOf(f) !== "deleted" && f.kind !== "repo" && f.kind !== "submodule");
    };
    /** The diff shown is redrawn for a new file, or the same file in another worktree (which takes no comments). */
    const viewKey = createMemo(() => {
        const f = shownFile();
        return f ? JSON.stringify([own() ? null : shownRoot(), key(f)]) : undefined;
    });
    const awayNote = "Looking at another worktree: comments, Commit and Push are for this session's own folder.";

    return (
        <section class="review" aria-label="Review changes">
            <Show when={shellLayout().inspector.mode === "dock"}>
                <ReviewResizer />
            </Show>
            <div class="rv-h" data-tauri-drag-region>
                <button class="hb rv-back" title={prefs.panel ? "Back to the side panel (Esc)" : "Close (Esc)"} aria-label="Close review" onClick={() => setReview(undefined)}>
                    <Show when={prefs.panel} fallback={<X size={16} />}>
                        <ChevronLeft size={16} />
                    </Show>
                </button>
                <div class="nm" data-tauri-drag-region>
                    <Show when={headPath()} fallback={<b>Changes</b>}>
                        {(path) => (
                            <b class="selectable" title={path()}>
                                {nameOf(path())}
                            </b>
                        )}
                    </Show>
                    <Show when={headSub()}>
                        <span class="selectable" title={headSub()}>
                            {headSub()}
                        </span>
                    </Show>
                </div>
                <Show when={shownFile()}>
                    {(f) => (
                        <span class="stat rv-stat">
                            <span class="add">+{f().added}</span>
                            <span class="del">−{f().removed}</span>
                        </span>
                    )}
                </Show>
                <DiffLayout />
                <Show when={canOpen()}>
                    <button class="hb" title={`Open in ${editorName() ?? "your editor"}`} aria-label="Open in editor" onClick={() => void openInEditor(absolute(shownFile()!.path), undefined, { gitToken: shownFile()!.pathToken })}>
                        <SquareArrowOutUpRight size={15} />
                    </button>
                </Show>
                <Show when={canReveal && shownFile()}>
                    <button class="hb rv-reveal" title="Reveal in Finder" aria-label="Reveal in Finder" onClick={() => void (shownFile()!.pathToken ? openInEditor("", undefined, { gitToken: shownFile()!.pathToken, editor: "finder" }) : revealPath(absolute(shownFile()!.path))).catch(reportError)}>
                        <FolderOpen size={15} />
                    </button>
                </Show>
            </div>
            {/* Which changes. Refresh travels with "Earlier turns" (rv-tools), so a wrap never leaves it on a row alone. */}
            <div class="rv-bar">
                <Show when={!noRepo() || away()} fallback={<span class="rv-reason selectable">{git()?.reason}</span>}>
                    <ReviewWorktreePicker
                        value={worktree()}
                        fallbackLabel={git()?.head ? branchLabel() : "This folder"}
                        worktrees={listing()?.list}
                        loading={listing.loading}
                        error={listing()?.error}
                        work={work}
                        onOpen={() => void refetchWorktrees()}
                        onPick={chooseWorktree}
                    />
                    <Segmented
                        label="Changes scope"
                        size="sm"
                        value={scope()}
                        onChange={setScope}
                        options={[
                            { value: "uncommitted", label: "Uncommitted", title: "The working tree against the last commit" },
                            { value: "branch", label: "Branch", title: "Everything since this branch left its base" },
                            {
                                value: "last-turn",
                                label: "Last turn",
                                title: away() ? "Turns are recorded in this session's own folder only. Choose This session in the worktree picker to see them." : "Changes during the last recorded turn",
                                disabled: away(),
                            },
                            {
                                value: "harness",
                                label: "Harness edits",
                                title: away() ? "Harness edits are this session's own, in its own folder. Choose This session in the worktree picker to see them." : "Only what Harness's edit tools changed in this session",
                                disabled: away(),
                            },
                        ]}
                    />
                    <Show when={scope() === "branch"}>
                        <span class="review-branch">
                            <GitBranch size={13} />
                            <span class="mono truncate">{branchLabel()}</span>
                            <span class="arrow">→</span>
                            <BasePicker value={git()?.base?.ref ?? baseLabel() ?? git()?.defaultBase} current={git()?.base ? (git()!.base!.refToken ?? git()!.base!.ref) : (base() ?? git()?.defaultBaseToken ?? git()?.defaultBase)} bases={bases()} tokens={git()?.bases.length ? git()!.baseTokens : fallback()?.baseTokens} onPick={setBase} />
                        </span>
                    </Show>
                </Show>
                <span class="rv-tools">
                    <Show when={!noRepo() && !away() && git()?.turns?.length}>
                        <select
                            class="select review-turn"
                            aria-label="Review a recorded turn"
                            value={scope() === "turn" ? String(turnId() ?? "") : ""}
                            onChange={(e) => {
                                if (!e.currentTarget.value) return;
                                setTurnId(Number(e.currentTarget.value));
                                setScope("turn");
                                setPicked(undefined);
                            }}
                        >
                            <option value="">Earlier turns</option>
                            <For each={git()?.turns}>{(t, i) => <option value={String(t.id)}>Turn {i() + 1} · {new Date(t.startedAt).toLocaleString()} · {t.prompt.slice(0, 80)}</option>}</For>
                        </select>
                    </Show>
                    <button class="hb sm" title="Refresh" aria-label="Refresh" disabled={loading()} onClick={refresh}>
                        <Show when={loading()} fallback={<RefreshCw size={14} />}>
                            <Spinner size={13} />
                        </Show>
                    </button>
                </span>
            </div>
            <Show when={files().length}>
                <nav class="rv-files" aria-label="Changed files" aria-busy={loading()}>
                    <For each={files()}>{(f) => <FilePill file={f} on={file() !== undefined && key(file()!) === key(f)} onSelect={() => setPicked(pickOf(f))} commit={shownScope() === "uncommitted" && own()} checked={f.kind !== "folder" && f.kind !== "repo" && !unchecked().has(key(f))} onCheck={(checked) => check(key(f), checked)} comments={commentCounts().get(f.pathToken ?? absolute(f.path))} />}</For>
                    <Show when={more()}>
                        <span class="rv-more">
                            {more().toLocaleString()}
                            {git()?.moreAtLeast ? "+" : ""} more not shown
                        </span>
                    </Show>
                </nav>
            </Show>
            <div class="insp-body rv-body" aria-busy={loading()}>
                <Show when={git()?.repo && own()}>
                    <div class="rv-pr selectable">
                        <PublishStatus handle={p.handle} request={publishRequest()} onClose={() => setPublishRequest(undefined)} />
                    </div>
                </Show>
                <Show when={gone()}>
                    {(w) => (
                        <div class="rv-warn selectable" role="status">
                            The worktree {w()} is gone, so this shows this session's folder.
                        </div>
                    )}
                </Show>
                <Show when={shownScope() !== "harness" && (git()?.incomplete || git()?.notes?.length)}>
                    <div class="rv-warn selectable" role="status" title={`${git()?.incomplete ? "This turn’s snapshot is incomplete. " : ""}${git()?.notes?.join(" ") ?? ""}`}>
                        {git()?.incomplete ? "This turn’s snapshot is incomplete. " : ""}
                        {git()?.notes?.join(" ")}
                    </div>
                </Show>
                <Show
                    when={files().length}
                    fallback={
                        <div class="rv-empty selectable">
                            <Show when={!error()} fallback={<ErrorNote error={error()!} base={base()} onReset={() => setBase(undefined)} />}>
                                <Show when={view()} fallback={<Spinner size={16} />}>
                                    {empty()}
                                </Show>
                            </Show>
                        </div>
                    }
                >
                    <Show when={askedFor() && !file()}>
                        <div class="rv-empty selectable">
                            <Show when={!unlisted.loading && asked()?.error} fallback={<Spinner size={16} />}>
                                {asked()!.error}{" "}
                                <button class="link-btn" onClick={() => void refetchUnlisted()}>
                                    Try again
                                </button>
                            </Show>
                        </div>
                    </Show>
                    {/* By path, not by the file's object: a refresh (an edit landing, a turn ending) updates the
                        diff in place, so a comment being written, the scroll and the focus all stay. */}
                    <Show when={viewKey()} keyed>
                        {(key) => {
                            const [wt] = JSON.parse(key) as [string | null, string];
                            const comments = wt === null ? commentsFor(shownFile()!) : undefined;
                            let last = shownFile()!;
                            const f = () => (last = shownFile() ?? last);
                            return (
                                <Show
                                    when={!f().deferred}
                                    fallback={
                                        <div class="rv-empty selectable">
                                            <Show when={!full.loading && loaded()} fallback={<Spinner size={16} />}>
                                                {loaded()!.error}{" "}
                                                <button class="link-btn" onClick={() => void refetchFull()}>
                                                    Try again
                                                </button>
                                            </Show>
                                        </div>
                                    }
                                >
                                    <DiffView diff={f()} split={reviewSplit()} comments={comments} />
                                </Show>
                            );
                        }}
                    </Show>
                </Show>
                <p class="rv-note">
                    <Show when={files().length}>{where()} </Show>
                    {SCOPE_NOTE[shownScope()]}
                    <Show when={shownFile() && own()}> Click a line number, or drag across several, to comment; comments go with your next message.</Show>
                    <Show when={!own()}> {awayNote}</Show>
                </p>
            </div>
            <Show when={!noRepo() && own()}>
                <div class="insp-foot">
                    <Show when={shownScope() === "uncommitted"}>
                        <span class="grow" title={commitDisabled() ?? "Commit the checked files"}>
                            <button class="btn ghost" disabled={Boolean(commitDisabled())} onClick={() => setCommitRequest({ id: id(), paths: selected() })}>
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
