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
import { draftedBy } from "../lib/model-name";
import { asksForSetup, setupNote, setupTabLabel } from "../lib/setup";
import { app, homeDraftKey, homeOn, reportError, rpcFor, toast, trustRequest } from "../state/app";
import { composerStorage } from "../lib/drafts";
import { chooseFolder, openProject } from "../state/actions";
import { requestComposerFocus, setFolderPickerOpen, setupObscured, terminalActions } from "../state/ui";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";
import "../styles/worktree-dialogs.css";

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
    // Home's machine, as it was when the dialog opened: the repository is there.
    const rpc = rpcFor(undefined);
    const on = homeOn();
    const away = on !== undefined;
    const [branch, setBranch] = createSignal("");
    const [base, setBase] = createSignal(r.base);
    /** Follows the branch name until edited. */
    // One New worktree dialog at a time: its form, for the Create button in the foot.
    const formId = "new-worktree-form";
    const [folder, setFolder] = createSignal<string>();
    /** A folder elsewhere the user chose to create it in. */
    const [parent, setParent] = createSignal<string>();
    const [busy, setBusy] = createSignal(false);
    const [error, setError] = createSignal<FormError>();
    const name = () => folder() ?? branch().trim().replaceAll("/", "-");
    const dir = () => parent() ?? `${r.main}/.claude/worktrees`;
    const target = () => `${dir().replace(/\/+$/, "")}/${name()}`;
    const errorFor = (f: Field) => (error()?.field === f ? error()!.message : undefined);
    // Suggest: a name from what the new chat is about (Home's composer), else from what's typed in the field, by the
    // project's small model, after its branch prefix. Only on a click.
    const [suggesting, setSuggesting] = createSignal(false);
    const [suggested, setSuggested] = createSignal<{ model: string; error?: undefined } | { error: string; model?: undefined }>();
    const about = () => composerStorage.draft(homeDraftKey()).trim() || branch().trim();
    /** Why Suggest couldn't name it, gone once the name is typed or Create pressed: one error under the field. */
    const dropSuggestError = () => suggested()?.error && setSuggested(undefined);
    const suggest = async () => {
        const text = about();
        if (!text || suggesting()) return;
        setSuggesting(true);
        setSuggested(undefined);
        // What Create said about the name goes with it: the field shows one error, the latest.
        if (error()?.field === "branch") setError(undefined);
        try {
            const got = await rpc.call("projects.suggestBranch", { path: r.cwd, text });
            if (!open) return;
            setBranch(got.branch);
            setSuggested({ model: got.model });
        } catch (e) {
            if (open) setSuggested({ error: (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200) });
        } finally {
            setSuggesting(false);
        }
    };
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
        // Run tries it again as a plain script run, as the project scripts menu does.
        const didnt = () => toast("Setup script didn't run", "warn", terminalActions.runScript ? { label: "Run", run: () => terminalActions.runScript?.(made.path, setup.script) } : undefined);
        // A tab outside the project on screen would run where nobody sees it; so would one under Settings or a dialog.
        if (app.homeCwd !== made.path || setupObscured() || trustRequest() || !terminalActions.runScript) return didnt();
        terminalActions.runScript(made.path, setup.script, { ticket: setup.ticket, label: setupTabLabel(made.path), command: setup.script.command });
    };

    const choose = async () => {
        const o = { title: "Choose where to create the worktree", action: "Create it here", start: r.main };
        // Another machine's folders are chosen from its own, not this computer's picker.
        const chosen = await (away ? new Promise<string | undefined>((then) => setFolderPickerOpen({ then, link: rpc, ...o })) : chooseFolder(o));
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
        dropSuggestError();
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
            if (made.setupError) toast(`Created worktree ${made.branch}; setup script didn't run`, "warn");
            else toast(`Created worktree ${made.branch}`, "success");
            // Home went to another machine meanwhile (a session opened from the palette): the path isn't that one's.
            if (homeOn() === on) {
                await openProject(made.path, true);
                requestComposerFocus();
            }
            // Not opened: says the setup script didn't run.
            if (made.setup) startSetup(made, made.setup);
        } catch (e) {
            setError(errorOf(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open
            onClose={close}
            title="New worktree"
            subtitle="A new branch, in a folder of its own."
            width={520}
            footer={
                <div class="dialog-actions">
                    <Show when={busy()}>
                        <span class="wt-busy">
                            <Spinner size={13} />
                            Checking out files…
                        </span>
                    </Show>
                    <span class="grow" />
                    <button type="button" class="btn" disabled={busy()} onClick={close}>
                        Cancel
                    </button>
                    <button type="submit" form={formId} class="btn primary" disabled={busy() || trusting() || note().kind === "loading" || !branch().trim() || !name()}>
                        Create
                    </button>
                </div>
            }
        >
            <form
                id={formId}
                class="wt-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    void create();
                }}
            >
                <label class="wt-field">
                    <span class="wt-label">Branch name</span>
                    <input class="input mono" autofocus aria-label="Branch name" spellcheck={false} autocomplete="off" placeholder="feature/my-change" maxLength={200} disabled={busy() || suggesting()} value={branch()} onInput={(e) => { dropSuggestError(); setBranch(e.currentTarget.value); }} aria-invalid={Boolean(errorFor("branch"))} />
                    <span class="wt-hint">
                        <button type="button" class="link-btn" disabled={busy() || suggesting() || !about()} title={about() ? (suggested()?.model ? `Suggested by ${draftedBy(suggested()!.model!)}` : undefined) : "Describe the task first"} onClick={() => void suggest()}>
                            {suggesting() ? "Suggesting…" : "Suggest a name"}
                        </button>
                    </span>
                    <Show when={suggested()?.error}>{(m) => <span class="wt-error">{m()}</span>}</Show>
                    <Show when={errorFor("branch")}>{(m) => <span class="wt-error">{m()}</span>}</Show>
                </label>
                <label class="wt-field">
                    <span class="wt-label">Base</span>
                    <input class="input mono" spellcheck={false} autocomplete="off" placeholder="HEAD" maxLength={200} disabled={busy()} value={base()} onInput={(e) => setBase(e.currentTarget.value)} aria-invalid={Boolean(errorFor("base"))} />
                    <Show when={errorFor("base")}>{(m) => <span class="wt-error">{m()}</span>}</Show>
                </label>
                <div class="wt-field">
                    <label class="wt-label" for="wt-folder">
                        Location
                    </label>
                    {/* The folder it goes in, then its own name: together, the whole path. */}
                    <div class="wt-location" title={target()}>
                        <span class="wt-dir mono truncate">{tildify(dir().replace(/\/+$/, ""), app.hello?.homeDir)}/</span>
                        <input id="wt-folder" class="input mono wt-folder" placeholder="folder" spellcheck={false} autocomplete="off" maxLength={255} disabled={busy()} value={name()} onInput={(e) => setFolder(e.currentTarget.value)} aria-invalid={Boolean(errorFor("location"))} />
                    </div>
                    <span class="wt-location-foot">
                        <Show when={errorFor("location")}>{(m) => <span class="wt-error">{m()}</span>}</Show>
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
                            <p class="wt-setup-text">
                                The setup script <strong>{n().script.name}</strong> runs once it's created:
                            </p>
                            <pre class="wt-setup-cmd mono">{n().script.command}</pre>
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
                            <p class="wt-setup-text">
                                Not trusted, so <strong>{n().script.name}</strong> won't run.
                            </p>
                            <pre class="wt-setup-cmd mono">{n().script.command}</pre>
                            <span class="wt-hint">Trusting also turns on its settings, hooks and MCP servers.</span>
                            <div>
                                <button type="button" class="btn sm" disabled={busy() || trusting()} onClick={() => void trustRepository(n().main)}>
                                    {trusting() ? <Spinner size={12} /> : "Trust this repository"}
                                </button>
                            </div>
                        </div>
                    )}
                </Show>
                <Show when={unreadable()}>
                    {(n) => (
                        <div class="wt-setup">
                            <p class="wt-setup-text">Couldn't read the project scripts: no setup script runs. {n().message}</p>
                        </div>
                    )}
                </Show>
            </form>
        </Dialog>
    );
}

/** The ignored files and folders Git would delete with a worktree: removal waits for the user to agree to exactly these. */
export function IgnoredFiles(p: { names: string[]; total: number }) {
    return (
        <div class="wt-del">
            <p class="wt-del-head">Ignored {p.total === 1 ? "file" : "files"} Git would delete</p>
            <ul>
                <For each={p.names}>{(n) => <li class="mono">{n}</li>}</For>
                <Show when={p.total > p.names.length}>
                    <li>and {p.total - p.names.length} more</li>
                </Show>
            </ul>
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
    // Read now: once the dialog is closed, what it was opened with can't be (the picker's Show has let go of it).
    const { worktree: w, cwd, main } = p.request;
    const rpc = rpcFor(undefined);
    const on = homeOn();
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
            const r = await rpc.call("projects.removeWorktree", { path: cwd, worktree: w.path, deleteIgnored });
            if (!r.removed) return setIgnored({ names: r.ignored, total: r.total, confirm: r.confirm });
            setBusy(false);
            p.onClose();
            toast(`Removed worktree ${tildify(w.path, app.hello?.homeDir)}`, "success");
            // Asked rather than compared: the new chat may have reached it through a symlink.
            const here = homeOn() === on && app.homeCwd;
            // Still there once it's answered: the user may have gone elsewhere meanwhile.
            if (here && !(await rpc.call("projects.inspect", { path: here }).catch(() => undefined))?.exists && homeOn() === on && app.homeCwd === here) await openProject(main, true);
        } catch (e) {
            setError(errorOf(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog open onClose={close} title="Remove this worktree?" subtitle={<span class="mono wt-sub-path">{tildify(w.path, app.hello?.homeDir)}</span>} width={500}>
            <p class="wt-confirm">
                <Show when={w.branch} fallback="Its commit stays in the repository.">
                    Branch <code class="mono">{w.branch}</code> is kept.
                </Show>
                <Show when={!w.exists}> Its folder is already gone.</Show>
            </p>
            <Show when={w.exists}>
                <p class="wt-hint">Uncommitted changes stop the removal.</p>
            </Show>
            <Show when={ignored()}>{(i) => <IgnoredFiles names={i().names} total={i().total} />}</Show>
            <Show when={error()}>
                {(m) => (
                    <div class="rw-confirm">
                        <AlertTriangle size={14} />
                        <span>{m().message}</span>
                        <Show when={m().code === "needs_trust"}>
                            <button class="btn secondary sm" disabled={busy()} onClick={() => void remove(ignored()?.confirm, m().folder ?? cwd)}>
                                Trust and remove
                            </button>
                        </Show>
                    </div>
                )}
            </Show>
            <div class="dialog-actions">
                <span class="grow" />
                <button class="btn" disabled={busy()} onClick={close}>
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
