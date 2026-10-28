// Creating and removing a Git worktree from the new-chat worktree picker. The
// server checks everything again; these only collect the choice and show its
// answer next to the field it's about. A new worktree may get the project's
// setup script, typed into a terminal tab there: shown here first, skippable,
// and only in a repository the user trusted (the server holds the gate).

import { createSignal, For, onCleanup, Show } from "solid-js";
import { AlertTriangle } from "lucide-solid";
import type { CreateWorktreeResult, SetupInfo, WorktreeInfo } from "@shared/protocol";
import { RpcError } from "../lib/rpc";
import { tildify } from "../lib/format";
import { asksForSetup, setupNote, setupTabLabel } from "../lib/setup";
import { app, reportError, rpc, toast, trustRequest } from "../state/app";
import { chooseFolder, openProject } from "../state/actions";
import { requestComposerFocus, setupObscured, terminalActions } from "../state/ui";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

export type Field = "branch" | "base" | "location" | "general";

export const FIELD_OF: Record<string, Field> = {
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
export type FormError = { field: Field; message: string; code?: string; folder?: string };

export const errorOf = (e: unknown): FormError => {
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

    const [setupInfo, setSetupInfo] = createSignal<SetupInfo>();
    const [setupError, setSetupError] = createSignal<string>();
    const [skipSetup, setSkipSetup] = createSignal(false);
    const [trusting, setTrusting] = createSignal(false);
    const note = () => setupNote(setupInfo(), setupError());
    const runs = () => { const n = note(); return n.kind === "runs" ? n : undefined; };
    const untrusted = () => { const n = note(); return n.kind === "untrusted" ? n : undefined; };
    const unreadable = () => { const n = note(); return n.kind === "error" ? n : undefined; };
    let setupLoad = 0;
    const loadSetup = async () => {
        const request = ++setupLoad;
        setSetupInfo(undefined);
        setSetupError(undefined);
        try {
            const info = await rpc.call("scripts.setupInfo", { cwd: r.main });
            if (open && request === setupLoad) setSetupInfo(info);
        } catch (e) {
            if (open && request === setupLoad) setSetupError(e instanceof Error ? e.message : String(e));
        }
    };
    void loadSetup();
    const offEvent = rpc.onEvent((e) => { if (e.type === "scripts.changed") void loadSetup(); });
    onCleanup(offEvent);
    /** Only on the user's click: trusting also turns on the repository's own Cavvy configuration. */
    const trustRepository = async (main: string) => {
        setTrusting(true);
        try {
            await rpc.call("projects.trust", { path: main, trust: true });
            await loadSetup();
        } catch (e) {
            reportError(e);
        } finally {
            setTrusting(false);
        }
    };

    /** In the new worktree, now open: a tab of its own, with the command typed once its shell is reading. */
    const startSetup = (made: CreateWorktreeResult, setup: NonNullable<CreateWorktreeResult["setup"]>) => {
        const didnt = (why: string) => toast(`Setup script “${setup.script.name}” didn't run: ${why} Run it from the project scripts menu.`, "warn");
        // A tab outside the project on screen would run where nobody sees it.
        if (app.homeCwd !== made.path) return didnt("the new worktree couldn't be opened.");
        if (setupObscured() || trustRequest()) return didnt("Settings or another dialog is covering the new worktree.");
        if (!terminalActions.runScript) return didnt("the terminal isn't available here.");
        terminalActions.runScript(made.path, setup.script, { ticket: setup.ticket, label: setupTabLabel(made.path), command: setup.script.command });
    };

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
        if (busy() || trusting() || note().kind === "loading") return;
        // Only request the setup already shown before the user clicked Create.
        const preview = note();
        const setup = asksForSetup(preview, skipSetup()) && preview.kind === "runs" ? { id: preview.script.id, command: preview.script.command } : undefined;
        const b = branch().trim();
        if (!b) return setError({ field: "branch", message: "Enter a branch name." });
        setError(undefined);
        setBusy(true);
        try {
            if (trust) await rpc.call("projects.trust", { path: trust, trust: true });
            if (!open) return;
            const made = await rpc.call("projects.createWorktree", { path: r.cwd, branch: b, base: base().trim() || undefined, ...(parent() ? { location: target() } : { folder: name() }), ...(setup ? { setup: true, setupScript: setup } : {}) });
            setBusy(false);
            p.onClose();
            if (made.setupError) toast(`Created worktree ${made.branch}. ${made.setupError} Run it from the project scripts menu.`, "warn");
            else toast(`Created worktree ${made.branch}`, "success");
            await openProject(made.path);
            requestComposerFocus();
            if (made.setup) startSetup(made, made.setup);
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
                <Show when={note().kind === "loading"}>
                    <span class="wt-hint">Checking the project's setup script…</span>
                </Show>
                <Show when={runs()}>
                    {(n) => (
                        <div class="wt-setup">
                            <span>
                                The setup script <strong>{n().script.name}</strong> runs once it's created:
                            </span>
                            <pre class="wt-setup-command mono">{n().script.command}</pre>
                            <label class="check-row">
                                <input type="checkbox" checked={skipSetup()} disabled={busy()} onChange={(e) => setSkipSetup(e.currentTarget.checked)} />
                                <span>Don't run it this time</span>
                            </label>
                        </div>
                    )}
                </Show>
                <Show when={untrusted()}>
                    {(n) => (
                        <div class="wt-setup">
                            <span>
                                The setup script <strong>{n().script.name}</strong> won't run: you haven't trusted this repository.
                            </span>
                            <pre class="wt-setup-command mono">{n().script.command}</pre>
                            <span class="wt-hint">Trusting it also turns on its .cavvy settings, hooks and MCP servers.</span>
                            <div>
                                <button type="button" class="btn secondary sm" disabled={busy() || trusting()} onClick={() => void trustRepository(n().main)}>
                                    {trusting() ? <Spinner size={12} /> : "Trust this repository"}
                                </button>
                            </div>
                        </div>
                    )}
                </Show>
                <Show when={unreadable()}>
                    {(n) => (
                        <div class="wt-setup">
                            <span>The project scripts couldn't be read, so no setup script will run. {n().message}</span>
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
                    <button type="submit" class="btn primary" disabled={busy() || trusting() || note().kind === "loading" || !branch().trim() || !name()}>
                        {busy() ? <Spinner size={12} /> : "Create"}
                    </button>
                </div>
            </form>
        </Dialog>
    );
}

/** The ignored files and folders Git would delete with a worktree: removal waits for the user to agree to exactly these. */
export function IgnoredFiles(p: { names: string[]; total: number }) {
    return (
        <div class="rw-confirm wt-ignored">
            <AlertTriangle size={14} />
            <div>
                <div>These ignored {p.total === 1 ? "file would" : "files and folders would"} be deleted with it:</div>
                <ul class="mono">
                    <For each={p.names}>{(n) => <li>{n}</li>}</For>
                </ul>
                <Show when={p.total > p.names.length}>
                    <div>and {p.total - p.names.length} more.</div>
                </Show>
            </div>
        </div>
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
        <Dialog open onClose={close} title="Remove this worktree?" subtitle={<span class="mono">{tildify(w.path, app.hello?.homeDir)}</span>} width={500}>
            <p class="wt-confirm">
                <Show when={w.branch} fallback="Its commit stays in the repository.">
                    Branch <span class="mono">{w.branch}</span> is kept.
                </Show>
            </p>
            <p class="muted small">
                <Show when={w.exists} fallback="Its folder is already gone.">
                    Uncommitted changes stop the removal. Ignored files, like .env, are listed before they're deleted.
                </Show>
            </p>
            <Show when={ignored()}>{(i) => <IgnoredFiles names={i().names} total={i().total} />}</Show>
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
