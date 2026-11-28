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
        <Popover open={open()} anchor={() => anchor} onClose={() => setOpen(false)} placement="bottom" align="end" width={400}>
            <div class="menu-head">Worktrees</div>
            {/* What it listed for this folder before stays while it lists them again. */}
            <Show when={here() || !listing.loading} fallback={<div class="menu-note">Loading worktrees…</div>}>
                <Show when={!here()?.error} fallback={<div class="menu-note">{here()?.error}</div>}>
                    <For each={here()?.worktrees} fallback={<div class="menu-note">No working trees found.</div>}>
                        {(w) => <div class="wt-row">
                            <button class={`menu-item ${w.current ? "current" : ""}`} disabled={!w.exists || w.prunable !== undefined} title={w.path} onClick={async () => {
                                setOpen(false);
                                await openProject(w.path, true);
                                requestComposerFocus();
                            }}>
                                <Show when={w.main} fallback={<FolderGit2 size={15} />}>
                                    <GitBranch size={15} />
                                </Show>
                                <span class="menu-text">
                                    <span class="menu-label">{label(w)}</span>
                                    <span class="menu-desc mono truncate">{tildify(w.path, app.hello?.homeDir)}{w.main ? " · main checkout" : ""}</span>
                                    <Show when={!w.exists || w.prunable !== undefined || w.locked !== undefined}>
                                        <span class="menu-desc">{!w.exists ? "Folder missing" : w.prunable !== undefined ? `Unavailable${w.prunable ? `: ${w.prunable}` : ""}` : `Locked${w.locked ? `: ${w.locked}` : ""}`}</span>
                                    </Show>
                                </span>
                                <Show when={w.current}><Check size={14} aria-label="Current worktree" /></Show>
                            </button>
                            <Show when={w.managed && main()}>
                                <button class="icon-btn wt-remove" title="Remove this worktree…" aria-label={`Remove worktree ${label(w)}`} onClick={() => {
                                    setOpen(false);
                                    setRemoving({ cwd: p.cwd, main: main()!.path, worktree: w });
                                }}>
                                    <Trash2 size={14} />
                                </button>
                            </Show>
                        </div>}
                    </For>
                    <Show when={main()}>
                        <div class="menu-sep" />
                        <button class="menu-item compact" onClick={startCreating}>
                            <Plus size={15} />
                            <span class="menu-label">New worktree…</span>
                        </button>
                        <button class="menu-item compact" onClick={() => (setOpen(false), openGit("openPullRequests"))}>
                            <GitPullRequest size={15} />
                            <span class="menu-label">Work on a pull request…</span>
                        </button>
                    </Show>
                </Show>
            </Show>
        </Popover>
        <Show when={creating()}>{(r) => <NewWorktreeDialog request={r()} onClose={() => setCreating(undefined)} />}</Show>
        <Show when={removing()}>{(r) => <RemoveWorktreeDialog request={r()} onClose={() => setRemoving(undefined)} />}</Show>
    </>;
}
