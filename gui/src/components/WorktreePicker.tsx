import { createResource, createSignal, For, Show } from "solid-js";
import { Check, ChevronDown, GitBranch, Plus, Trash2 } from "lucide-solid";
import type { WorktreeInfo } from "@shared/protocol";
import { app, rpc } from "../state/app";
import { openProject } from "../state/actions";
import { requestComposerFocus } from "../state/ui";
import { tildify } from "../lib/format";
import { Popover } from "./ui/Popover";
import { NewWorktreeDialog, RemoveWorktreeDialog, type NewWorktreeRequest, type RemoveWorktreeRequest } from "./WorktreeDialogs";

export function WorktreePicker(p: { cwd: string; branch?: string }) {
    const [open, setOpen] = createSignal(false);
    const [creating, setCreating] = createSignal<NewWorktreeRequest>();
    const [removing, setRemoving] = createSignal<RemoveWorktreeRequest>();
    let anchor: HTMLButtonElement | undefined;
    const [listing] = createResource(
        () => open() && p.cwd,
        async (path): Promise<{ worktrees: WorktreeInfo[]; error?: string }> => {
            try { return { worktrees: await rpc.call("projects.worktrees", { path }) }; }
            catch (e) { return { worktrees: [], error: e instanceof Error ? e.message : String(e) }; }
        },
    );
    const label = (w: WorktreeInfo) => w.branch || (w.detached ? `Detached · ${w.head?.slice(0, 7) ?? "HEAD"}` : "Worktree");
    const main = () => listing()?.worktrees.find((w) => w.main);
    const startCreating = () => {
        const current = listing()?.worktrees.find((w) => w.current);
        setOpen(false);
        setCreating({ cwd: p.cwd, main: main()!.path, base: p.branch || current?.head || "" });
    };

    return <>
        <button ref={anchor} class="strip-ctl" title="Choose the worktree for this new chat" aria-label="Choose worktree" aria-haspopup="menu" aria-expanded={open()} onClick={() => setOpen(!open())}>
            <GitBranch size={13} />
            <span class="truncate">{p.branch || "Detached HEAD"}</span>
            <ChevronDown size={12} class="chv" />
        </button>
        <Popover open={open()} anchor={() => anchor} onClose={() => setOpen(false)} placement="top" align="end" width={420}>
            <div class="menu-head">Worktrees</div>
            <Show when={!listing.loading} fallback={<div class="menu-note">Loading worktrees…</div>}>
                <Show when={!listing()?.error} fallback={<div class="menu-note">{listing()?.error}</div>}>
                    <For each={listing()?.worktrees} fallback={<div class="menu-note">No working trees found.</div>}>
                        {(w) => <div class="wt-row">
                            <button class={`menu-item ${w.current ? "current" : ""}`} disabled={!w.exists || w.prunable !== undefined} title={w.path} onClick={async () => {
                                setOpen(false);
                                await openProject(w.path);
                                requestComposerFocus();
                            }}>
                                <GitBranch size={15} />
                                <span class="menu-text">
                                    <span class="menu-label">{label(w)}</span>
                                    <span class="menu-desc mono truncate">{tildify(w.path, app.hello?.homeDir)}</span>
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
