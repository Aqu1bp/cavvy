// Reviewing what changed: docked on the right, files on its left, the chosen
// file's diff beside them. Opened from the panel's Changes row or a turn's
// Review changes. Git's view (uncommitted, or the whole branch) shows every
// change in the folder, whoever made it; Harness edits shows only what the
// edit tools did, and is all there is outside a Git repository.

import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import { FolderOpen, GitBranch, RefreshCw, X } from "lucide-solid";
import type { FileDiff, GitFileDiff, GitScope } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { app, reportError, rpc } from "../state/app";
import { prefs, setPrefs } from "../state/prefs";
import { review, setReview, setCommitRequest } from "../state/ui";
import { changedOutside, commitUnavailable, fetchGitChanges, lastView, sessionReadReady, useGitChanges, type ReviewScope } from "../state/changes";
import { canReveal, revealPath } from "../lib/platform";
import { plural } from "../lib/format";
import { DiffView } from "./blocks/DiffView";
import { PublishStatus } from "./PublishStatus";
import { BasePicker } from "./BasePicker";
import { Segmented, Spinner } from "./ui/bits";

/** Kept while the app runs, so the pane opens the way you left it. */
const [split, setSplit] = createSignal(false);

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "");
const nameOf = (path: string) => path.split("/").pop() ?? path;

type Row = FileDiff & Partial<Pick<GitFileDiff, "change" | "from" | "kind" | "deferred" | "filter">>;

/** git status's letters, spelled out on hover. */
const CHANGE: Record<GitFileDiff["change"], { letter: string; label: string }> = {
    added: { letter: "A", label: "Added" },
    modified: { letter: "M", label: "Modified" },
    deleted: { letter: "D", label: "Deleted" },
    untracked: { letter: "U", label: "Untracked" },
    renamed: { letter: "R", label: "Renamed" },
    typechange: { letter: "T", label: "Type changed" },
};
const changeOf = (f: Row): GitFileDiff["change"] => f.change ?? f.status;

const SCOPE_NOTE: Record<ReviewScope, string> = {
    uncommitted: "Everything that differs from the last commit: staged, unstaged and untracked files, whoever changed them.",
    branch: "Everything on this branch since it left its base, committed or not.",
    "last-turn": "The last recorded turn’s start and end snapshots. Ignored files are excluded. Changes from other sessions in this folder are included.",
    turn: "This turn’s start and end snapshots. Ignored files are excluded. Changes from other sessions in this folder are included.",
    harness: "Only what Harness's own edit tools changed in this session. Shell commands and Claude Code or Codex edits aren't included.",
};

/** One file in the list. Kept on its own so rows can grow actions. */
function FileRow(p: { file: Row; on: boolean; onSelect: () => void; commit?: boolean; checked?: boolean; onCheck?: (checked: boolean) => void }) {
    const c = () => CHANGE[changeOf(p.file)];
    return (
        <div class={`rf-row ${p.on ? "on" : ""}`}>
            <Show when={p.commit}>
                <span title={p.file.kind === "folder" ? "This folder is collapsed; select individual files instead." : p.file.kind === "repo" ? "Nested repositories cannot be committed as files." : `Include ${p.file.path} in commit`}>
                    <input type="checkbox" aria-label={`Include ${p.file.path} in commit`} checked={p.checked} disabled={p.file.kind === "folder" || p.file.kind === "repo"} onChange={(e) => p.onCheck?.(e.currentTarget.checked)} />
                </span>
            </Show>
            <button class={`rf ${p.on ? "on" : ""}`} aria-current={p.on} title={p.file.from ? `${p.file.from} → ${p.file.path}` : p.file.path} onClick={() => p.onSelect()}>
                <span class={`rf-change ${changeOf(p.file)}`} title={c().label} aria-label={c().label}>
                    {c().letter}
                </span>
                <span class="rf-text">
                    <span class="rf-name mono truncate">{nameOf(p.file.path)}</span>
                    <Show when={dirOf(p.file.path)}>
                        <span class="rf-dir mono truncate">{dirOf(p.file.path)}</span>
                    </Show>
                </span>
                <Show when={p.file.added || p.file.removed}>
                    <span class="stat rf-stat">
                        <span class="add">+{p.file.added}</span>
                        <span class="del">−{p.file.removed}</span>
                    </span>
                </Show>
            </button>
        </div>
    );
}

/** The chosen file's heading: its path, what happened to it, its counts. Actions go at the end. */
function FileHead(p: { file: Row }) {
    const tag = () => {
        const ch = changeOf(p.file);
        if (p.file.kind === "link") return "Symbolic link";
        // Its diff, when there is one, is of what git stores (an LFS pointer, say), not the file on disk.
        if (p.file.filter) return `Filter: ${p.file.filter}`;
        if (p.file.kind === "submodule") return "Submodule";
        if (ch === "modified") return undefined;
        return ch === "added" ? "New file" : ch === "renamed" ? `Renamed from ${p.file.from}` : CHANGE[ch].label;
    };
    return (
        <div class="review-file-head">
            <span class="path truncate" title={p.file.path}>
                {p.file.path}
            </span>
            <Show when={tag()}>
                <span class={`file-tag ${p.file.status}`}>{tag()}</span>
            </Show>
            <span class="grow" />
            <span class="stat">
                <span class="add">+{p.file.added}</span>
                <span class="del">−{p.file.removed}</span>
            </span>
        </div>
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

    let dragStart = 0;
    let widthStart = 0;
    const onResize = (e: PointerEvent) => {
        dragStart = e.clientX;
        widthStart = prefs.reviewWidth;
        const move = (ev: PointerEvent) => setPrefs("reviewWidth", Math.round(Math.max(420, Math.min(1200, widthStart - (ev.clientX - dragStart)))));
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            document.body.classList.remove("resizing");
        };
        document.body.classList.add("resizing");
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };

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

    return (
        <section class="review" aria-label="Review changes">
            <div class="resize-handle left" onPointerDown={onResize} onDblClick={() => setPrefs("reviewWidth", 720)} />
            <div class="review-head" data-tauri-drag-region>
                <span class="review-title">Changes</span>
                <Show when={files().length}>
                    <span class="review-count">{count()}</span>
                    <span class="stat">
                        <span class="add">+{view()!.added}</span>
                        <span class="del">−{view()!.removed}</span>
                    </span>
                </Show>
                <span class="grow" data-tauri-drag-region />
                <Show when={shownScope() === "uncommitted"}>
                    <span title={commitDisabled() ?? "Commit the checked files"}>
                        <button class="btn sm" disabled={Boolean(commitDisabled())} onClick={() => setCommitRequest({ id: id(), paths: selected() })}>Commit…</button>
                    </span>
                </Show>
                <Show when={!noRepo()}><button class="btn sm" disabled={Boolean(commitUnavailable(p.handle))} onClick={() => setPublishRequest(id())}>Push…</button></Show>
                <Segmented
                    label="Diff layout"
                    size="sm"
                    value={split() ? "split" : "unified"}
                    onChange={(v) => setSplit(v === "split")}
                    options={[
                        { value: "unified", label: "Unified" },
                        { value: "split", label: "Split" },
                    ]}
                />
                <Show when={canReveal && shownFile()}>
                    <button class="hb" title="Reveal in Finder" aria-label="Reveal in Finder" onClick={() => void revealPath(absolute(shownFile()!.path)).catch(reportError)}>
                        <FolderOpen size={16} />
                    </button>
                </Show>
                <button class="hb" title="Refresh" aria-label="Refresh" disabled={loading()} onClick={refresh}>
                    <Show when={loading()} fallback={<RefreshCw size={15} />}>
                        <Spinner size={14} />
                    </Show>
                </button>
                <button class="hb" title="Close (Esc)" aria-label="Close review" onClick={() => setReview(undefined)}>
                    <X size={16} />
                </button>
            </div>
            <Show when={git()?.repo}><PublishStatus handle={p.handle} request={publishRequest()} onClose={() => setPublishRequest(undefined)} /></Show>
            <div class="review-bar">
                <Show when={!noRepo()} fallback={<span class="review-scope-note">{git()?.reason}</span>}>
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
                    <Show when={git()?.turns?.length}>
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
                    <span class="grow" />
                    <Show when={scope() === "branch"}>
                        <span class="review-branch">
                            <GitBranch size={13} />
                            <span class="mono truncate">{branchLabel()}</span>
                            <span class="arrow">→</span>
                            <BasePicker value={git()?.base?.ref ?? base() ?? git()?.defaultBase} bases={bases()} onPick={setBase} />
                        </span>
                    </Show>
                </Show>
            </div>
            <Show
                when={files().length}
                fallback={
                    <div class="review-empty">
                        <Show when={!error()} fallback={<ErrorNote error={error()!} base={base()} onReset={() => setBase(undefined)} />}>
                            <Show when={view()} fallback={<Spinner size={16} />}>
                                {empty()}
                            </Show>
                        </Show>
                    </div>
                }
            >
                <div class="review-body" aria-busy={loading()}>
                    <nav class="review-files" aria-label="Changed files">
                        <For each={files()}>{(f) => <FileRow file={f} on={file()?.path === f.path} onSelect={() => setPicked(f.path)} commit={shownScope() === "uncommitted"} checked={f.kind !== "folder" && f.kind !== "repo" && !unchecked().has(f.path)} onCheck={(checked) => check(f.path, checked)} />}</For>
                        <Show when={more()}>
                            <div class="rf-more">
                                {more().toLocaleString()}
                                {git()?.moreAtLeast ? "+" : ""} more not shown
                            </div>
                        </Show>
                    </nav>
                    <div class="review-diff">
                        <Show when={askedFor() && !file()}>
                            <div class="review-file-head">
                                <span class="path truncate">{picked()}</span>
                            </div>
                            <div class="review-empty">
                                <Show when={!unlisted.loading && asked()?.error} fallback={<Spinner size={16} />}>
                                    {asked()!.error}{" "}
                                    <button class="link-btn" onClick={() => void refetchUnlisted()}>
                                        Try again
                                    </button>
                                </Show>
                            </div>
                        </Show>
                        <Show when={shownFile()} keyed>
                            {(f) => (
                                <>
                                    <FileHead file={f} />
                                    <Show
                                        when={!f.deferred}
                                        fallback={
                                            <div class="review-empty">
                                                <Show when={!full.loading && loaded()} fallback={<Spinner size={16} />}>
                                                    {loaded()!.error}{" "}
                                                    <button class="link-btn" onClick={() => void refetchFull()}>
                                                        Try again
                                                    </button>
                                                </Show>
                                            </div>
                                        }
                                    >
                                        <DiffView diff={f} split={split()} />
                                    </Show>
                                </>
                            )}
                        </Show>
                    </div>
                </div>
            </Show>
            <Show when={shownScope() !== "harness" && (git()?.incomplete || git()?.notes?.length)}><div class="review-note" role="status">{git()?.incomplete ? "This turn’s snapshot is incomplete. " : ""}{git()?.notes?.join(" ")}</div></Show>
            <div class="review-note">{SCOPE_NOTE[shownScope()]}</div>
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
