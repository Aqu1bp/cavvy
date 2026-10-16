// Creating and removing a Git worktree from the new-chat worktree picker. The
// server checks everything again; these only collect the choice and show its
// answer next to the field it's about.

import { createSignal, Show } from "solid-js";
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

const errorOf = (e: unknown) => ({ field: (e instanceof RpcError && e.code && FIELD_OF[e.code]) || "general", message: e instanceof Error ? e.message : String(e) }) as { field: Field; message: string };

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
    const [error, setError] = createSignal<{ field: Field; message: string }>();
    const name = () => folder() ?? branch().trim().replaceAll("/", "-");
    const dir = () => parent() ?? `${r.main}/.claude/worktrees`;
    const target = () => `${dir().replace(/\/+$/, "")}/${name()}`;
    const errorFor = (f: Field) => (error()?.field === f ? error()!.message : undefined);
    const close = () => !busy() && p.onClose();

    const choose = async () => {
        const chosen = await chooseFolder({ title: "Choose where to create the worktree", action: "Create it here", start: r.main });
        if (chosen) setParent(chosen);
    };

    const create = async () => {
        if (busy()) return;
        const b = branch().trim();
        if (!b) return setError({ field: "branch", message: "Enter a branch name." });
        setError(undefined);
        setBusy(true);
        try {
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
    /** The main worktree's root: the request runs there, and a new chat moves there if it was in the removed one. */
    main: string;
    worktree: WorktreeInfo;
}

export function RemoveWorktreeDialog(p: { request: RemoveWorktreeRequest; onClose: () => void }) {
    const w = p.request.worktree;
    const [busy, setBusy] = createSignal(false);
    const [error, setError] = createSignal<string>();
    const close = () => !busy() && p.onClose();
    const remove = async () => {
        setError(undefined);
        setBusy(true);
        try {
            await rpc.call("projects.removeWorktree", { path: p.request.main, worktree: w.path });
            setBusy(false);
            p.onClose();
            toast(`Removed worktree ${tildify(w.path, app.hello?.homeDir)}`, "success");
            // Asked rather than compared: the new chat may have reached it through a symlink.
            const here = app.homeCwd;
            if (here && !(await rpc.call("projects.inspect", { path: here }).catch(() => undefined))?.exists) await openProject(p.request.main);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
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
                <Show when={w.exists} fallback="Its folder is already gone; this clears Git's record of it.">
                    Git refuses if it has uncommitted or untracked changes.
                </Show>
            </p>
            <Show when={error()}>
                {(m) => (
                    <div class="rw-confirm">
                        <AlertTriangle size={14} />
                        <span>{m()}</span>
                    </div>
                )}
            </Show>
            <div class="dialog-actions">
                <span class="grow" />
                <button class="btn ghost" disabled={busy()} onClick={close}>
                    Cancel
                </button>
                <button class="btn danger" disabled={busy()} onClick={() => void remove()}>
                    {busy() ? <Spinner size={12} /> : "Remove"}
                </button>
            </div>
        </Dialog>
    );
}
