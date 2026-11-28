import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { Copy, Ellipsis, FolderGit2, GitBranch, Save } from "lucide-solid";
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
    // The worktrees this plan was taken to: the links that name it (an older link, the newest plan before it).
    const links = createMemo(() => {
        const to = (view()?.state.planLinks ?? []).filter((l) => l.role === "to");
        if (!to.length) return [];
        if (to.every((l) => l.plan !== undefined)) return to.filter((l) => l.plan === p.tool.id);
        const plans = planCalls(view()!.turns);
        return to.filter((l) => linkOwner(plans, l) === p.tool.id);
    });
    return (
        <div class="plan" data-state={state()?.tone} data-find={p.tool.id}>
            <div class="plan-top" data-find-skip>
                <span class="plan-kicker">Plan</span>
                <Show when={state()}>{(s) => <span class="plan-state truncate">{s().label}</span>}</Show>
                <span class="grow" />
                <button ref={more} class="hb sm" aria-label="Plan actions" aria-haspopup="menu" aria-expanded={menu()} onClick={() => setMenu(!menu())}>
                    <Ellipsis size={14} />
                </button>
            </div>
            <Menu label="Plan actions" open={menu()} anchor={() => more} onClose={() => setMenu(false)} width={260}>
                <button
                    role="menuitem"
                    class="menu-item compact"
                    disabled={!info()?.git}
                    title={info()?.notGit ?? (info()?.git ? undefined : info.loading ? "Checking the repository…" : "Repository unavailable")}
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
            <div class="plan-title selectable">{title()}</div>
            <Show when={body()}>
                {/* A glimpse: the links and buttons in it aren't reachable until it's read in full. */}
                <div class="plan-preview" data-find-skip inert>
                    <Markdown text={body()} class="small" />
                </div>
            </Show>
            <div class="plan-foot" data-find-skip>
                <button class="btn btn-sm" onClick={() => open("view")}>
                    Read the plan
                </button>
                <For each={links()}>
                    {(l) => (
                        <span class="plan-impl" title={`${tildify(l.path, app.hello?.homeDir)}${l.base ? `, from ${l.base}` : ""}`}>
                            <GitBranch size={12} aria-hidden="true" />
                            <span class="truncate">
                                Implementing on <span class="mono">{l.branch}</span> ·
                            </span>
                            <button class="link-btn" onClick={() => void activate(l.session)}>
                                Open session
                            </button>
                        </span>
                    )}
                </For>
            </div>
        </div>
    );
}
