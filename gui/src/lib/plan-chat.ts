// The plan in the conversation: the Steps strip on top of the composer (the
// agent's to-do list) and the card a proposed plan gets in its turn. What
// they say and when they show, pure, so the rules are tested without a browser.

import type { TodoEntry, ToolBlock } from "@shared/protocol";
import { planTitle } from "@shared/plan-title";

export { planTitle };

/** The Steps strip's one line: how far along, and the step under way (or "All steps done"). */
export interface StepsLine {
    done: number;
    total: number;
    now: string;
    all: boolean;
}

export function stepsLine(todos: readonly TodoEntry[]): StepsLine {
    const done = todos.filter((t) => t.status === "completed").length;
    const all = todos.length > 0 && done === todos.length;
    const under = todos.find((t) => t.status === "in_progress");
    const now = all ? "All steps done" : under ? (under.activeForm ?? under.content) : (todos.find((t) => t.status === "pending")?.content ?? "");
    return { done, total: todos.length, now, all };
}

/** The list as it stands (each step's words and status): hiding the strip lasts until this changes. */
export function stepsKey(todos: readonly TodoEntry[]): string {
    return JSON.stringify(todos.map((t) => [t.content, t.status]));
}

/**
 * A finished list is left from an earlier turn: a turn has started since the one that last wrote it. The strip
 * says "All steps done" until then. A list still under way is never stale, and one whose writing can't be found
 * (compacted away) is kept: the strip's ✕ hides it.
 */
export function stepsStale(todos: readonly TodoEntry[], turns: readonly { blocks: readonly { t: string; name?: string }[] }[]): boolean {
    if (!todos.length || todos.some((t) => t.status !== "completed")) return false;
    for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i]!.blocks.some((b) => b.t === "tool" && b.name === "TodoWrite")) return i < turns.length - 1;
    }
    return false;
}

/** The plan under its title: what the card's preview shows (the title's own line isn't repeated). */
export function planBody(plan: string): string {
    const lines = plan.split("\n");
    const trimmed = lines.map((l) => l.trim());
    let at = trimmed.findIndex((l) => /^#{1,6}\s+\S/.test(l));
    if (at < 0) at = trimmed.findIndex(Boolean);
    if (at >= 0) lines.splice(at, 1);
    return lines.join("\n").trim();
}

/** What the card says about where the plan stands: waiting on you (amber), approved (green), or set aside. */
export interface PlanState {
    label: string;
    tone: "ok" | "wait" | "quiet";
}

/** The modes a plan is approved in (the plan card's buttons), as the approved plan's state names them. */
const APPROVED_IN: Record<string, string> = { "accept edits": "auto-accept edits", manual: "ask for edits", auto: "auto mode" };

/**
 * The plan's state, from its ExitPlanMode call: `waiting` while its request card is up. Harness's own agent
 * names the mode it went on in ("permission mode: Accept edits"); Claude Code's result doesn't, so that's
 * just "Approved". Undefined while the call is still on its way to the card, or when it never got there.
 */
export function planState(t: Pick<ToolBlock, "status" | "summary" | "output">, waiting: boolean): PlanState | undefined {
    if (waiting || t.status === "awaiting") return { label: "Needs you", tone: "wait" };
    const said = `${t.summary ?? ""}\n${t.output ?? ""}`;
    if (t.status === "ok") {
        const mode = APPROVED_IN[/permission mode: ([^)]+)\)/.exec(t.output ?? "")?.[1]?.trim().toLowerCase() ?? ""];
        return { label: mode ? `Approved · ${mode}` : "Approved", tone: "ok" };
    }
    if (t.status === "denied") return { label: "Kept planning", tone: "quiet" };
    if (t.status !== "error") return undefined;
    if (/handed off|in another session/i.test(said)) return { label: "Moved to a worktree", tone: "quiet" };
    if (t.summary === "Interrupted" || t.summary === "Not run") return { label: "Stopped", tone: "quiet" };
    if (/rejected|wants changes|keep planning/i.test(said)) return { label: "Kept planning", tone: "quiet" };
    // Refused before it reached you (not in plan mode, say): it was never up for review.
    return undefined;
}

/**
 * The plan card a worktree link goes on: the plan it names (none of these, when that plan isn't among them).
 * An older link doesn't name one: then the newest plan presented before the link was made (one without a
 * time, as a reopened session's are, counts as before it).
 */
export function linkOwner(plans: readonly { id: string; at?: number }[], link: { at: number; plan?: string }): string | undefined {
    if (link.plan !== undefined) return plans.some((p) => p.id === link.plan) ? link.plan : undefined;
    let owner: string | undefined;
    for (const p of plans) if (p.at === undefined || p.at <= link.at) owner = p.id;
    return owner ?? plans[0]?.id;
}

/** The plans a session's turns presented (its ExitPlanMode calls), in order, with when each began. */
export function planCalls(turns: readonly { blocks: readonly { t: string; id: string; name?: string; startedAt?: number }[] }[]): { id: string; at?: number }[] {
    const out: { id: string; at?: number }[] = [];
    for (const turn of turns) for (const b of turn.blocks) if (b.t === "tool" && b.name === "ExitPlanMode") out.push({ id: b.id, at: b.startedAt });
    return out;
}
