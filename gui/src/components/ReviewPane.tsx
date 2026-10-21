// The diff reader: the inspector widens into it (lib/layout.ts). Its head names
// the file in view, with Unified | Split and Open in editor; under it, which
// changes (uncommitted, the branch, a turn, or Harness's own edits) and the
// files as pills; then the diff, where lines take comments for the next
// message; Commit and Push at the foot. Opened from the side panel, the title
// bar's changes chip or a turn's Review changes. Git's views show every change
// in the folder, whoever made it; Harness edits shows only what the edit tools
// did, and is all there is outside a Git repository.

import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { ChevronLeft, FolderOpen, GitBranch, GitCommitHorizontal, GitPullRequestArrow, MessageSquare, RefreshCw, SquareArrowOutUpRight, X } from "lucide-solid";
import type { FileDiff, GitFileDiff, GitScope } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { app, reportError, rpc } from "../state/app";
import { prefs, setPrefs } from "../state/prefs";
import { review, reviewSplit, setCommitRequest, setReview, setReviewSplit, shellLayout } from "../state/ui";
import { changedOutside, commitUnavailable, fetchGitChanges, lastView, sessionReadReady, useGitChanges, type ReviewScope } from "../state/changes";
import { editorName, openInEditor } from "../state/actions";
import { canReveal, revealPath } from "../lib/platform";
import { plural } from "../lib/format";
import { CHANGE, dirOf, nameOf, REVIEW_DEFAULT, REVIEW_STEP, reviewDragWidth, reviewWidthRange } from "../lib/inspector";
import { DiffView, type DiffComments } from "./blocks/DiffView";
import { buildComment } from "../lib/review-comments";
import { newCommentId, reviewComments } from "../state/review-comments";
import { PublishStatus } from "./PublishStatus";
import { BasePicker } from "./BasePicker";
import { Segmented, Spinner } from "./ui/bits";

type Row = FileDiff & Partial<Pick<GitFileDiff, "change" | "from" | "kind" | "deferred" | "filter">>;

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
        // On the window, not the handle: the handle can go away mid-drag, and its listeners with it.
        const move = (ev: PointerEvent) => set(reviewDragWidth(from, ev.clientX - x));
        const end = () => {
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
    const [scope, setScope] = createSignal<ReviewScope>(review()?.scope ?? saved?.scope ?? "uncommitted");
    const [turnId, setTurnId] = createSignal<number | undefined>(review()?.turnId ?? saved?.turnId);
    const [base, setBase] = createSignal<string | undefined>(saved?.base);
    const [picked, setPicked] = createSignal<string>();
    const [unchecked, setUnchecked] = createSignal(new Set<string>());
    createEffect(on(id, () => setUnchecked(new Set<string>())));
    // Start on the file and view it was opened for; a new request moves there.
    createEffect(
        on(review, (r) => {
            if (r?.scope) setScope(r.scope);
            if (r?.turnId !== undefined) setTurnId(r.turnId);
            setPicked(r?.path);
        }),
    );
    createEffect(() => lastView.set(id(), { scope: scope(), base: base(), turnId: turnId() }));

    const gitScope = (): GitScope => (scope() === "harness" ? "uncommitted" : (scope() as GitScope));
    const [git, { refetch: refetchGit }] = useGitChanges(() => p.handle, gitScope, () => (gitScope() === "branch" ? base() : undefined), () => (gitScope() === "turn" ? turnId() : undefined));
    /** Outside a Git repository, Harness's own record is all there is. */
    const noRepo = () => git()?.repo === false;
    const shownScope = (): ReviewScope => (noRepo() ? "harness" : scope());
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
    const selected = () => files().filter((f) => f.kind !== "folder" && f.kind !== "repo" && !unchecked().has(f.path)).map((f) => f.path);
    const commitDisabled = () => commitUnavailable(p.handle) ?? (loading() ? "Wait for changes to finish loading." : error() ? "Refresh the changes before committing." : !selected().length ? "Select files to commit." : undefined);
    const check = (path: string, checked: boolean) => setUnchecked((old) => {
        const next = new Set(old);
        if (checked) next.delete(path);
        else next.add(path);
        return next;
    });

    const absolute = (path: string) => {
        const full = path.startsWith("/") ? path : path.startsWith("~/") && app.hello?.homeDir ? `${app.hello.homeDir}/${path.slice(2)}` : `${p.handle.view.state.cwd}/${path}`;
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
        return want ? files().find((f) => same(f.path, want)) : undefined;
    });
    // Asked for a file the list doesn't hold (past its 300): fetched by itself. Its answer
    // counts only for the view, base and path it was asked for; the resource keeps its last.
    const unlistedKey = () => {
        const want = picked();
        return shownScope() !== "harness" && view() && want && !listedPick() ? JSON.stringify([id(), gitScope(), base(), turnId(), want]) : undefined;
    };
    const [unlisted, { refetch: refetchUnlisted }] = createResource(
        () => {
            if (!sessionReadReady(p.handle)) return false;
            const key = unlistedKey();
            return key ? { key, id: id(), scope: gitScope(), base: base(), turnId: turnId(), path: picked()! } : false;
        },
        async (k) => {
            const r = await fetchGitChanges(k.id, k.scope, k.base, k.path, k.turnId);
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
        return shownScope() !== "harness" && f?.deferred ? JSON.stringify([id(), gitScope(), base(), turnId(), f.path]) : undefined;
    };
    const [full, { refetch: refetchFull }] = createResource(
        () => {
            if (!sessionReadReady(p.handle)) return false;
            const key = fullKey();
            return key ? { key, id: id(), scope: gitScope(), base: base(), turnId: turnId(), path: file()!.path } : false;
        },
        async (k) => {
            const r = await fetchGitChanges(k.id, k.scope, k.base, k.path, k.turnId);
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
        () => sessionReadReady(p.handle) && gitScope() === "branch" && git()?.error && !git()?.bases.length && id(),
        (id) => fetchGitChanges(id, "uncommitted"),
    );
    const bases = () => (git()?.bases.length ? git()!.bases : (fallback()?.bases ?? []));

    const refresh = () => {
        void refetchGit();
        if (shownScope() === "harness") void refetchHarness();
    };

    /** Comments on the shown file: they wait in this session's composer until the next message. */
    const commentsFor = (path: string): DiffComments => ({
        get list() {
            return reviewComments.list(id()).filter((c) => same(c.path, path));
        },
        add: (lines, text, around) => {
            const c = buildComment({ id: newCommentId(), path, lines, text, ...around });
            if (c) reviewComments.add(id(), c);
        },
        edit: (commentId, text) => reviewComments.edit(id(), commentId, text),
        remove: (commentId) => reviewComments.remove(id(), [commentId]),
    });
    /** How many comments each listed file has. */
    const commentCounts = createMemo(() => {
        const out = new Map<string, number>();
        for (const c of reviewComments.list(id())) out.set(absolute(c.path), (out.get(absolute(c.path)) ?? 0) + 1);
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
        const i = files().findIndex((f) => f.path === file()?.path);
        const all = `+${view()?.added ?? 0} −${view()?.removed ?? 0} in all`;
        return i < 0 ? `${count()}, ${all}.` : `${i + 1} of ${count()}, ${all}.`;
    };
    /** The file the head names: the one shown, or the one asked for while it loads. */
    const headPath = () => shownFile()?.path ?? (askedFor() ? picked() : undefined);
    const headSub = () => {
        const path = headPath();
        if (!path) return files().length ? count() : "";
        const tag = shownFile() && fileTag(shownFile()!);
        const dir = dirOf(path);
        return [dir, tag].filter(Boolean).join(" · ");
    };
    const canOpen = () => {
        const f = shownFile();
        return Boolean(f && changeOf(f) !== "deleted" && f.kind !== "repo" && f.kind !== "submodule");
    };

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
                    <button class="hb" title={`Open in ${editorName() ?? "your editor"}`} aria-label="Open in editor" onClick={() => void openInEditor(absolute(shownFile()!.path))}>
                        <SquareArrowOutUpRight size={15} />
                    </button>
                </Show>
                <Show when={canReveal && shownFile()}>
                    <button class="hb rv-reveal" title="Reveal in Finder" aria-label="Reveal in Finder" onClick={() => void revealPath(absolute(shownFile()!.path)).catch(reportError)}>
                        <FolderOpen size={15} />
                    </button>
                </Show>
            </div>
            {/* Which changes. Refresh travels with "Earlier turns" (rv-tools), so a wrap never leaves it on a row alone. */}
            <div class="rv-bar">
                <Show when={!noRepo()} fallback={<span class="rv-reason selectable">{git()?.reason}</span>}>
                    <Segmented
                        label="Changes scope"
                        size="sm"
                        value={scope()}
                        onChange={setScope}
                        options={[
                            { value: "uncommitted", label: "Uncommitted", title: "The working tree against the last commit" },
                            { value: "branch", label: "Branch", title: "Everything since this branch left its base" },
                            { value: "last-turn", label: "Last turn", title: "Changes during the last recorded turn" },
                            { value: "harness", label: "Harness edits", title: "Only what Harness's edit tools changed in this session" },
                        ]}
                    />
                    <Show when={scope() === "branch"}>
                        <span class="review-branch">
                            <GitBranch size={13} />
                            <span class="mono truncate">{branchLabel()}</span>
                            <span class="arrow">→</span>
                            <BasePicker value={git()?.base?.ref ?? base() ?? git()?.defaultBase} bases={bases()} onPick={setBase} />
                        </span>
                    </Show>
                </Show>
                <span class="rv-tools">
                    <Show when={!noRepo() && git()?.turns?.length}>
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
                    <For each={files()}>{(f) => <FilePill file={f} on={file()?.path === f.path} onSelect={() => setPicked(f.path)} commit={shownScope() === "uncommitted"} checked={f.kind !== "folder" && f.kind !== "repo" && !unchecked().has(f.path)} onCheck={(checked) => check(f.path, checked)} comments={commentCounts().get(absolute(f.path))} />}</For>
                    <Show when={more()}>
                        <span class="rv-more">
                            {more().toLocaleString()}
                            {git()?.moreAtLeast ? "+" : ""} more not shown
                        </span>
                    </Show>
                </nav>
            </Show>
            <div class="insp-body rv-body" aria-busy={loading()}>
                <Show when={git()?.repo}>
                    <div class="rv-pr selectable">
                        <PublishStatus handle={p.handle} request={publishRequest()} onClose={() => setPublishRequest(undefined)} />
                    </div>
                </Show>
                <Show when={shownScope() !== "harness" && (git()?.incomplete || git()?.notes?.length)}>
                    <div class="rv-warn selectable" role="status">
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
                    <Show when={shownFile()?.path} keyed>
                        {(path) => {
                            const comments = commentsFor(path);
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
                    <Show when={shownFile()}> Click a line number, or drag across several, to comment; comments go with your next message.</Show>
                </p>
            </div>
            <Show when={!noRepo()}>
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
