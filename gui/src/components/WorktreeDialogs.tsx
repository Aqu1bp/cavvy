// Creating and removing a Git worktree from the new-chat worktree picker. The
// server checks everything again; these only collect the choice and show its
// answer next to the field it's about.

import { createSignal, For, onCleanup, Show } from "solid-js";
import { AlertTriangle } from "lucide-solid";
import type { WorktreeInfo } from "@shared/protocol";
import { RpcError } from "../lib/rpc";
import { tildify } from "../lib/format";
import { app, rpc, toast } from "../state/app";
import { chooseFolder, openProject } from "../state/actions";
import { requestComposerFocus } from "../state/ui";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

type Field = "branch" | "base" | "location" | "general";

const FIELD_OF: Record<string, Field> = {
    invalid_branch: "branch",
    branch_exists: "branch",
    branch_in_use: "branch",
    bad_base: "base",
    bad_folder: "location",
    bad_location: "location",
    path_exists: "location",
    path_outside: "location",
};

/** `folder`: with needs_trust, the folder the server says to trust. */
type FormError = { field: Field; message: string; code?: string; folder?: string };

const errorOf = (e: unknown): FormError => {
    const code = e instanceof RpcError ? e.code : undefined;
    return { field: (code && FIELD_OF[code]) || "general", message: e instanceof Error ? e.message : String(e), code, folder: e instanceof RpcError ? e.folder : undefined };
};

export interface NewWorktreeRequest {
    /** The folder the picker was opened in. */
    cwd: string;
    /** The main worktree's root. */
    main: string;
    /** Its current branch, or HEAD's commit when detached. */
    base: string;
}

export function NewWorktreeDialog(p: { request: NewWorktreeRequest; onClose: () => void }) {
    const r = p.request;
    const [branch, setBranch] = createSignal("");
    const [base, setBase] = createSignal(r.base);
    /** Follows the branch name until edited. */
    const [folder, setFolder] = createSignal<string>();
    /** A folder elsewhere the user chose to create it in. */
    const [parent, setParent] = createSignal<string>();
    const [busy, setBusy] = createSignal(false);
    const [error, setError] = createSignal<FormError>();
    const name = () => folder() ?? branch().trim().replaceAll("/", "-");
    const dir = () => parent() ?? `${r.main}/.claude/worktrees`;
    const target = () => `${dir().replace(/\/+$/, "")}/${name()}`;
    const errorFor = (f: Field) => (error()?.field === f ? error()!.message : undefined);
    const close = () => !busy() && p.onClose();
    let open = true;
    onCleanup(() => (open = false));

    const choose = async () => {
        const chosen = await chooseFolder({ title: "Choose where to create the worktree", action: "Create it here", start: r.main });
        if (chosen) setParent(chosen);
    };

    /**
     * Busy from start to end, so it can't be started twice or the dialog closed
     * midway. `trust`: a folder the user just agreed to trust (the repository's
     * own Git config can run commands on checkout), trusted first.
     */
    const create = async (trust?: string) => {
        if (busy()) return;
        const b = branch().trim();
        if (!b) return setError({ field: "branch", message: "Enter a branch name." });
        setError(undefined);
        setBusy(true);
        try {
            if (trust) await rpc.call("projects.trust", { path: trust, trust: true });
            if (!open) return;
            const made = await rpc.call("projects.createWorktree", { path: r.cwd, branch: b, base: base().trim() || undefined, ...(parent() ? { location: target() } : { folder: name() }) });
            setBusy(false);
            p.onClose();
            toast(`Created worktree ${made.branch}`, "success");
            await openProject(made.path);
            requestComposerFocus();
        } catch (e) {
            setError(errorOf(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open onClose={close} title="New worktree" subtitle="A new branch, checked out in a folder of its own." width={540}>
            <form
                class="wt-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    void create();
                }}
            >
                <label class="wt-field">
                    <span class="wt-label">Branch name</span>
                    <input class="input mono" autofocus spellcheck={false} autocomplete="off" placeholder="feature/my-change" maxLength={200} disabled={busy()} value={branch()} onInput={(e) => setBranch(e.currentTarget.value)} aria-invalid={Boolean(errorFor("branch"))} />
                    <Show when={errorFor("branch")}>{(m) => <span class="wt-error">{m()}</span>}</Show>
                </label>
                <label class="wt-field">
                    <span class="wt-label">Base</span>
                    <input class="input mono" spellcheck={false} autocomplete="off" placeholder="HEAD" maxLength={200} disabled={busy()} value={base()} onInput={(e) => setBase(e.currentTarget.value)} aria-invalid={Boolean(errorFor("base"))} />
                    <span class="wt-hint">The branch or commit the new branch starts from.</span>
                    <Show when={errorFor("base")}>{(m) => <span class="wt-error">{m()}</span>}</Show>
                </label>
                <div class="wt-field">
                    <label class="wt-label" for="wt-folder">
                        Location
                    </label>
                    <div class="wt-location">
                        <span class="wt-dir mono" title={dir()}>
                            <bdi>{tildify(dir().replace(/\/+$/, ""), app.hello?.homeDir)}</bdi>
                        </span>
                        <span class="wt-sep mono">/</span>
                        <input id="wt-folder" class="input mono" spellcheck={false} autocomplete="off" maxLength={255} disabled={busy()} value={name()} onInput={(e) => setFolder(e.currentTarget.value)} aria-invalid={Boolean(errorFor("location"))} />
                    </div>
                    <span class="wt-path mono" title={target()}>
                        {target()}
                    </span>
                    <span class="wt-hint">
                        <Show
                            when={parent()}
                            fallback={
                                <button type="button" class="link-btn" disabled={busy()} onClick={() => void choose()}>
                                    Choose another folder…
                                </button>
                            }
                        >
                            <button type="button" class="link-btn" disabled={busy()} onClick={() => setParent(undefined)}>
                                Use .claude/worktrees
                            </button>
                        </Show>
                    </span>
                    <Show when={errorFor("location")}>{(m) => <span class="wt-error">{m()}</span>}</Show>
                </div>
                <Show when={errorFor("general")}>
                    {(m) => (
                        <div class="rw-confirm">
                            <AlertTriangle size={14} />
                            <span>{m()}</span>
                            <Show when={error()?.code === "needs_trust"}>
                                <button type="button" class="btn secondary sm" disabled={busy()} onClick={() => void create(error()?.folder ?? r.cwd)}>
                                    Trust and create
                                </button>
                            </Show>
                        </div>
                    )}
                </Show>
                <div class="dialog-actions">
                    <Show when={busy()}>
                        <span class="muted small">Checking out files; a big repository takes a while…</span>
                    </Show>
                    <span class="grow" />
                    <button type="button" class="btn ghost" disabled={busy()} onClick={close}>
                        Cancel
                    </button>
                    <button type="submit" class="btn primary" disabled={busy() || !branch().trim() || !name()}>
                        {busy() ? <Spinner size={12} /> : "Create"}
                    </button>
                </div>
            </form>
        </Dialog>
    );
}

export interface RemoveWorktreeRequest {
    /** The folder the picker was opened in: the request names it, and trusting means trusting it. */
    cwd: string;
    /** The main worktree's root: a new chat moves there if it was in the removed one. */
    main: string;
    worktree: WorktreeInfo;
}

export function RemoveWorktreeDialog(p: { request: RemoveWorktreeRequest; onClose: () => void }) {
    const w = p.request.worktree;
    const [busy, setBusy] = createSignal(false);
    const [error, setError] = createSignal<FormError>();
    /** Ignored files Git would delete with it: removal waits for the user to agree to exactly these. */
    const [ignored, setIgnored] = createSignal<{ names: string[]; total: number; confirm: string }>();
    const close = () => !busy() && p.onClose();
    let open = true;
    onCleanup(() => (open = false));
    /**
     * Busy from start to end, so it can't be started twice or the dialog closed
     * midway. `trust`: a folder the user just agreed to trust (the repository's
     * own Git config can run commands when Git compares the files), trusted first.
     */
    const remove = async (deleteIgnored?: string, trust?: string) => {
        if (busy()) return;
        setError(undefined);
        setBusy(true);
        try {
            if (trust) await rpc.call("projects.trust", { path: trust, trust: true });
            if (!open) return;
            const r = await rpc.call("projects.removeWorktree", { path: p.request.cwd, worktree: w.path, deleteIgnored });
            if (!r.removed) return setIgnored({ names: r.ignored, total: r.total, confirm: r.confirm });
            setBusy(false);
            p.onClose();
            toast(`Removed worktree ${tildify(w.path, app.hello?.homeDir)}`, "success");
            // Asked rather than compared: the new chat may have reached it through a symlink.
            const here = app.homeCwd;
            if (here && !(await rpc.call("projects.inspect", { path: here }).catch(() => undefined))?.exists) await openProject(p.request.main);
        } catch (e) {
            setError(errorOf(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog open onClose={close} title="Remove worktree" width={500}>
            <p class="wt-confirm">
                Remove worktree <span class="mono">{tildify(w.path, app.hello?.homeDir)}</span>?{" "}
                <Show when={w.branch} fallback="Its commit stays in the repository.">
                    Branch <span class="mono">{w.branch}</span> is kept.
                </Show>
            </p>
            <p class="muted small">
                <Show when={w.exists} fallback="Its folder is already gone; this clears Git's record of it (and only its).">
                    Git refuses if it has uncommitted or untracked changes. Ignored files (an .env, node_modules) are listed for you before anything is deleted.
                </Show>
            </p>
            <Show when={ignored()}>
                {(i) => (
                    <div class="rw-confirm wt-ignored">
                        <AlertTriangle size={14} />
                        <div>
                            <div>
                                These ignored {i().total === 1 ? "file would" : "files and folders would"} be deleted with it:
                            </div>
                            <ul class="mono">
                                <For each={i().names}>{(n) => <li>{n}</li>}</For>
                            </ul>
                            <Show when={i().total > i().names.length}>
                                <div>and {i().total - i().names.length} more.</div>
                            </Show>
                        </div>
                    </div>
                )}
            </Show>
            <Show when={error()}>
                {(m) => (
                    <div class="rw-confirm">
                        <AlertTriangle size={14} />
                        <span>{m().message}</span>
                        <Show when={m().code === "needs_trust"}>
                            <button class="btn secondary sm" disabled={busy()} onClick={() => void remove(ignored()?.confirm, m().folder ?? p.request.cwd)}>
                                Trust and remove
                            </button>
                        </Show>
                    </div>
                )}
            </Show>
            <div class="dialog-actions">
                <span class="grow" />
                <button class="btn ghost" disabled={busy()} onClick={close}>
                    Cancel
                </button>
                <Show
                    when={ignored()}
                    fallback={
                        <button class="btn danger" disabled={busy()} onClick={() => void remove()}>
                            {busy() ? <Spinner size={12} /> : "Remove"}
                        </button>
                    }
                >
                    {(i) => (
                        <button class="btn danger" disabled={busy()} onClick={() => void remove(i().confirm)}>
                            {busy() ? <Spinner size={12} /> : "Delete them and remove"}
                        </button>
                    )}
                </Show>
            </div>
        </Dialog>
    );
}
