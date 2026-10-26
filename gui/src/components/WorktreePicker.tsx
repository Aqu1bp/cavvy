import { createResource, createSignal, For, Show } from "solid-js";
import { Check, ChevronDown, FolderGit2, GitBranch, Plus, Trash2 } from "lucide-solid";
import type { WorktreeInfo } from "@shared/protocol";
import { app, rpc } from "../state/app";
import { openProject } from "../state/actions";
import { requestComposerFocus } from "../state/ui";
import { tildify } from "../lib/format";
import { Popover } from "./ui/Popover";
import { NewWorktreeDialog, RemoveWorktreeDialog, type NewWorktreeRequest, type RemoveWorktreeRequest } from "./WorktreeDialogs";

/** Home's branch control, in the strip under the composer: the project's worktrees, to run the new chat in one, remove one Harness made, or make one. */
export function WorktreePicker(p: { cwd: string; branch?: string }) {
    const [open, setOpen] = createSignal(false);
    const [creating, setCreating] = createSignal<NewWorktreeRequest>();
    const [removing, setRemoving] = createSignal<RemoveWorktreeRequest>();
    let anchor: HTMLButtonElement | undefined;
    // Listed before it opens: the control shows whether this folder is the main checkout or a worktree of it.
    const [listing, { refetch }] = createResource(
        () => app.conn === "open" && p.cwd,
        async (path): Promise<{ path: string; worktrees: WorktreeInfo[]; error?: string }> => {
            try { return { path, worktrees: await rpc.call("projects.worktrees", { path }) }; }
            catch (e) { return { path, worktrees: [], error: e instanceof Error ? e.message : String(e) }; }
        },
    );
    // Only this folder's: another project's, kept while this one's loads, would open or branch from that one.
    const here = () => (listing()?.path === p.cwd ? listing() : undefined);
    const label = (w: WorktreeInfo) => w.branch || (w.detached ? `Detached · ${w.head?.slice(0, 7) ?? "HEAD"}` : "Worktree");
    const main = () => here()?.worktrees.find((w) => w.main);
    const current = () => here()?.worktrees.find((w) => w.current);
    const toggle = () => {
        // Opened, it lists them again (one may have been made or removed elsewhere since), unless that's under way.
        if (!open() && !listing.loading) void refetch();
        setOpen(!open());
    };
    const startCreating = () => {
        setOpen(false);
        setCreating({ cwd: p.cwd, main: main()!.path, base: p.branch || current()?.head || "" });
    };

    return <>
        <button ref={anchor} class="strip-ctl" title={`${tildify(p.cwd, app.hello?.homeDir)}: choose the worktree for this new chat`} aria-label="Choose worktree" aria-haspopup="menu" aria-expanded={open()} onClick={toggle}>
            <Show when={current() && !current()!.main} fallback={<GitBranch size={14} class="ic" />}>
                <FolderGit2 size={14} class="ic" />
            </Show>
            <span class="truncate">{p.branch || "Detached HEAD"}</span>
            <ChevronDown size={12} stroke-width={2} class="chv" />
        </button>
        <Popover open={open()} anchor={() => anchor} onClose={() => setOpen(false)} placement="bottom" align="start" width={400}>
            <div class="menu-head">Worktrees</div>
            {/* What it listed for this folder before stays while it lists them again. */}
            <Show when={here() || !listing.loading} fallback={<div class="menu-note">Loading worktrees…</div>}>
                <Show when={!here()?.error} fallback={<div class="menu-note">{here()?.error}</div>}>
                    <For each={here()?.worktrees} fallback={<div class="menu-note">No working trees found.</div>}>
                        {(w) => <div class="wt-row">
                            <button class={`menu-item ${w.current ? "current" : ""}`} disabled={!w.exists || w.prunable !== undefined} title={w.path} onClick={async () => {
                                setOpen(false);
                                await openProject(w.path);
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
                    </Show>
                </Show>
            </Show>
            <div class="menu-note">New chats run in the selected folder.</div>
        </Popover>
        <Show when={creating()}>{(r) => <NewWorktreeDialog request={r()} onClose={() => setCreating(undefined)} />}</Show>
        <Show when={removing()}>{(r) => <RemoveWorktreeDialog request={r()} onClose={() => setRemoving(undefined)} />}</Show>
    </>;
}
