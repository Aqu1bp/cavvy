import { createResource, createSignal, For, Show } from "solid-js";
import { Check, ChevronDown, GitBranch } from "lucide-solid";
import type { WorktreeInfo } from "@shared/protocol";
import { app, rpc } from "../state/app";
import { openProject } from "../state/actions";
import { requestComposerFocus } from "../state/ui";
import { tildify } from "../lib/format";
import { Popover } from "./ui/Popover";

export function WorktreePicker(p: { cwd: string; branch?: string }) {
    const [open, setOpen] = createSignal(false);
    let anchor: HTMLButtonElement | undefined;
    const [listing] = createResource(
        () => open() && p.cwd,
        async (path): Promise<{ worktrees: WorktreeInfo[]; error?: string }> => {
            try { return { worktrees: await rpc.call("projects.worktrees", { path }) }; }
            catch (e) { return { worktrees: [], error: e instanceof Error ? e.message : String(e) }; }
        },
    );
    const label = (w: WorktreeInfo) => w.branch || (w.detached ? `Detached · ${w.head?.slice(0, 7) ?? "HEAD"}` : "Worktree");

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
                        {(w) => <button class={`menu-item ${w.current ? "current" : ""}`} disabled={!w.exists || w.prunable !== undefined} title={w.path} onClick={async () => {
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
                        </button>}
                    </For>
                </Show>
            </Show>
            <div class="menu-note">New chats run in the selected folder. Create worktrees with git worktree add.</div>
        </Popover>
    </>;
}
