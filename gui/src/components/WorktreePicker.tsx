import { createResource, createSignal, For, lazy, Show } from "solid-js";
import { Check, ChevronDown, FolderGit2, GitBranch, GitPullRequest, Plus, Trash2 } from "lucide-solid";
import type { WorktreeInfo } from "@shared/protocol";
import { app, homeOn, rpcFor } from "../state/app";
import { openProject } from "../state/actions";
import { openGit, requestComposerFocus } from "../state/ui";
import { tildify } from "../lib/format";
import { Popover } from "./ui/Popover";
import type { NewWorktreeRequest, RemoveWorktreeRequest } from "./WorktreeDialogs";

/** Not in the startup bundle: fetched as the picker opens, before either is asked for. */
const dialogs = () => import("./WorktreeDialogs");
const NewWorktreeDialog = lazy(() => dialogs().then((m) => ({ default: m.NewWorktreeDialog })));
const RemoveWorktreeDialog = lazy(() => dialogs().then((m) => ({ default: m.RemoveWorktreeDialog })));

/** Home's branch control, in its card: the project's worktrees, to run the new chat in one, remove one Cavvy made, or make one. */
export function WorktreePicker(p: { cwd: string; branch?: string }) {
    const [open, setOpen] = createSignal(false);
    const [creating, setCreating] = createSignal<NewWorktreeRequest>();
    const [removing, setRemoving] = createSignal<RemoveWorktreeRequest>();
    let anchor: HTMLButtonElement | undefined;
    // Listed before it opens: the control shows whether this folder is the main checkout or a worktree of it.
    const [listing, { refetch }] = createResource(
        // Home's machine's (rpcFor): the same path on another machine is another folder.
        () => app.conn === "open" && ([p.cwd, homeOn()] as const),
        async ([path, on]): Promise<{ path: string; on?: string; worktrees: WorktreeInfo[]; error?: string }> => {
            try { return { path, on, worktrees: await rpcFor(undefined).call("projects.worktrees", { path }) }; }
            catch (e) { return { path, on, worktrees: [], error: e instanceof Error ? e.message : String(e) }; }
        },
    );
    // Only this folder's, on this machine: another's, kept while this one's loads, would open or branch from that one.
    const here = () => (listing()?.path === p.cwd && listing()?.on === homeOn() ? listing() : undefined);
    const label = (w: WorktreeInfo) => w.branch || (w.detached ? `Detached · ${w.head?.slice(0, 7) ?? "HEAD"}` : "Worktree");
    const main = () => here()?.worktrees.find((w) => w.main);
    const current = () => here()?.worktrees.find((w) => w.current);
    const tilde = (w: WorktreeInfo) => tildify(w.path, app.hello?.homeDir);
    // Under the branch: inside the main checkout, the path from there; else the whole path, from ~. The tooltip has the
    // whole path where the row shows only part of it.
    const shownPath = (w: WorktreeInfo) => (main() && w.path.startsWith(main()!.path + "/") ? w.path.slice(main()!.path.length + 1) : tilde(w));
    const toggle = () => {
        // Opened, it lists them again (one may have been made or removed elsewhere since), unless that's under way.
        if (!open() && !listing.loading) void refetch();
        if (!open()) void dialogs();
        setOpen(!open());
    };
    const startCreating = () => {
        setOpen(false);
        setCreating({ cwd: p.cwd, main: main()!.path, base: p.branch || current()?.head || "" });
    };

    return <>
        <button ref={anchor} class="select home-select" title="Choose a worktree" aria-label="Choose worktree" aria-haspopup="menu" aria-expanded={open()} onClick={toggle}>
            <Show when={current() && !current()!.main}>
                <FolderGit2 size={14} />
            </Show>
            <span class="select-value mono">{p.branch || "Detached HEAD"}</span>
            <ChevronDown size={13} class="select-caret" />
        </button>
        <Popover open={open()} anchor={() => anchor} onClose={() => setOpen(false)} placement="bottom" align="end" offset={6} width={404} class="menu wt-menu" label="Worktrees">
            <div class="menu-label">Worktrees</div>
            {/* What it listed for this folder before stays while it lists them again. */}
            <Show when={here() || !listing.loading} fallback={<p class="wt-note">Loading worktrees…</p>}>
                <Show when={!here()?.error} fallback={<p class="wt-note">{here()?.error}</p>}>
                    <Show when={here()?.worktrees.length} fallback={<p class="wt-note">No working trees found.</p>}>
                        <div class="wt-list" role="listbox" aria-label="Worktrees">
                            <For each={here()?.worktrees}>
                                {(w) => <div class="wt-row">
                                    <button type="button" role="option" aria-selected={w.current} class="menu-item menu-item-two wt-item" disabled={!w.exists || w.prunable !== undefined} title={shownPath(w) === tilde(w) ? undefined : tilde(w)} onClick={async () => {
                                        setOpen(false);
                                        await openProject(w.path, true);
                                        requestComposerFocus();
                                    }}>
                                        <span class="menu-check">{w.current && <Check size={14} />}</span>
                                        <Show when={w.main} fallback={<FolderGit2 size={14} />}>
                                            <GitBranch size={14} />
                                        </Show>
                                        <span class="menu-item-text">
                                            <span class={`menu-item-name ${w.branch ? "mono" : ""}`}>{label(w)}</span>
                                            <span class="menu-item-sub wt-path">
                                                <span class="mono truncate">{shownPath(w)}</span>
                                                <Show when={w.main}><span class="wt-main">· main checkout</span></Show>
                                            </span>
                                            <Show when={!w.exists || w.prunable !== undefined || w.locked !== undefined}>
                                                <span class="menu-item-sub wt-problem">{!w.exists ? "Folder missing" : w.prunable !== undefined ? `Unavailable${w.prunable ? `: ${w.prunable}` : ""}` : `Locked${w.locked ? `: ${w.locked}` : ""}`}</span>
                                            </Show>
                                        </span>
                                    </button>
                                    <Show when={w.managed && main()}>
                                        <button type="button" class="icon-btn icon-btn-sm wt-remove" title="Remove this worktree…" aria-label={`Remove worktree ${label(w)}`} onClick={() => {
                                            setOpen(false);
                                            setRemoving({ cwd: p.cwd, main: main()!.path, worktree: w });
                                        }}>
                                            <Trash2 size={14} />
                                        </button>
                                    </Show>
                                </div>}
                            </For>
                        </div>
                    </Show>
                    <Show when={main()}>
                        <div class="menu-sep" />
                        <button type="button" class="menu-item" onClick={startCreating}>
                            <Plus size={14} />
                            <span class="menu-item-name">New worktree…</span>
                        </button>
                        <button type="button" class="menu-item" onClick={() => (setOpen(false), openGit("openPullRequests"))}>
                            <GitPullRequest size={14} />
                            <span class="menu-item-name">Work on a pull request…</span>
                        </button>
                    </Show>
                </Show>
            </Show>
        </Popover>
        <Show when={creating()}>{(r) => <NewWorktreeDialog request={r()} onClose={() => setCreating(undefined)} />}</Show>
        <Show when={removing()}>{(r) => <RemoveWorktreeDialog request={r()} onClose={() => setRemoving(undefined)} />}</Show>
    </>;
}
