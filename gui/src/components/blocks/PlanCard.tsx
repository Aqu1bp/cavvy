import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { ClipboardList, Copy, Ellipsis, FolderGit2, GitBranchPlus, Save } from "lucide-solid";
import type { ToolBlock } from "@shared/protocol";
import { activate, app, handleFor, reportError, rpc, toast } from "../../state/app";
import { setPlanDialog } from "../../state/ui";
import { copyText } from "../../lib/platform";
import { tildify } from "../../lib/format";
import { linkOwner, planBody, planCalls, planState, planTitle } from "../../lib/plan-chat";
import { Menu } from "../ui/Menu";
import { Markdown } from "./Markdown";

/**
 * A plan the agent presented (its ExitPlanMode call), as a card in its turn: "Plan" and where it stands
 * (approved, waiting on you, set aside), its title and the start of it, Read the plan (the plan dialog), and
 * a ⋯ menu with what else can be done with it: take it to a new worktree, save it, copy it. A plan taken to a
 * worktree says where, at its foot, and opens that session.
 */
export function PlanCard(p: { tool: ToolBlock; sessionId?: string }) {
    let more: HTMLButtonElement | undefined;
    const [menu, setMenu] = createSignal(false);
    const view = () => handleFor(p.sessionId)?.view;
    const text = () => String(p.tool.input?.plan ?? "");
    const title = () => planTitle(text()) || "Plan";
    const body = createMemo(() => planBody(text()));
    const waiting = () => Boolean(view()?.state.interactions.some((i) => i.kind === "plan" && (i.toolId ?? i.id) === p.tool.id));
    const state = () => planState(p.tool, waiting());
    // Whether there's a repository to make a worktree in (and, if not, why): asked when the menu opens.
    const [info] = createResource(
        () => (menu() && p.sessionId ? { id: p.sessionId, toolId: p.tool.id } : undefined),
        (q) => rpc.call("session.planInfo", q).catch(() => undefined),
    );
    const open = (kind: "view" | "save" | "worktree") => {
        setMenu(false);
        if (p.sessionId) setPlanDialog({ kind, sessionId: p.sessionId, planId: p.tool.id });
    };
    const copy = async () => {
        setMenu(false);
        if (!p.sessionId) return;
        // The whole plan: the call's input is cut when it's long.
        const r = await rpc.call("session.planInfo", { id: p.sessionId, toolId: p.tool.id }).catch(reportError);
        if (r && (await copyText(r.plan))) toast("Copied the plan", "success");
    };
    // The worktrees this plan was taken to. Links don't name their plan: each goes on the newest plan before it.
    const links = createMemo(() => {
        const to = (view()?.state.planLinks ?? []).filter((l) => l.role === "to");
        if (!to.length) return [];
        const plans = planCalls(view()!.turns);
        return to.filter((l) => linkOwner(plans, l.at) === p.tool.id);
    });
    return (
        <div class="tcard plan-card" data-find={p.tool.id}>
            <div class="pc-h" data-find-skip>
                <ClipboardList size={14} aria-hidden="true" />
                <span>Plan</span>
                <span class="grow" />
                <Show when={state()}>
                    {(s) => (
                        <span class={`pc-state truncate ${s().tone}`}>
                            {s().label}
                        </span>
                    )}
                </Show>
                <button ref={more} class="hb sm" title="Plan actions" aria-label="Plan actions" aria-haspopup="menu" aria-expanded={menu()} onClick={() => setMenu(!menu())}>
                    <Ellipsis size={15} />
                </button>
            </div>
            <Menu label="Plan actions" open={menu()} anchor={() => more} onClose={() => setMenu(false)} width={260}>
                <button
                    role="menuitem"
                    class="menu-item compact"
                    disabled={!info()?.git}
                    title={info()?.notGit ?? (info()?.git ? "Implement the plan in a new worktree" : info.loading ? "Checking the repository…" : "Repository information unavailable")}
                    onClick={() => open("worktree")}
                >
                    <FolderGit2 size={14} /> Implement in a new worktree…
                </button>
                <button role="menuitem" class="menu-item compact" onClick={() => open("save")}>
                    <Save size={14} /> Save plan…
                </button>
                <button role="menuitem" class="menu-item compact" onClick={() => void copy()}>
                    <Copy size={14} /> Copy plan
                </button>
            </Menu>
            <div class="pc-t selectable">{title()}</div>
            <Show when={body()}>
                {/* A glimpse: the links and buttons in it aren't reachable until it's read in full. */}
                <div class="pc-p" data-find-skip inert>
                    <Markdown text={body()} class="small" />
                </div>
            </Show>
            <div class="pc-f" data-find-skip>
                <button class="btn ghost sm" onClick={() => open("view")}>
                    Read the plan
                </button>
            </div>
            <For each={links()}>
                {(l) => (
                    <button
                        class="pc-link"
                        data-find-skip
                        title={`Implemented: ${tildify(l.path, app.hello?.homeDir)} on ${l.branch}${l.base ? `, from ${l.base}` : ""}. Open that session.`}
                        onClick={() => void activate(l.session)}
                    >
                        <GitBranchPlus size={14} aria-hidden="true" />
                        <span class="truncate">
                            Implementing on <span class="mono">{l.branch}</span>
                        </span>
                        <span class="go">Open session</span>
                    </button>
                )}
            </For>
        </div>
    );
}
