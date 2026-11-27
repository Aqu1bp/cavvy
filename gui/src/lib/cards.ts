// Which tool calls get a card of their own in a turn's work. Here, not in the component that draws them, so what
// doesn't draw (finding text in a conversation, on the server too) can ask.
import type { ToolBlock } from "@shared/protocol";

export type Card = "edit" | "command" | "plan" | "suggest";

export const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
/** A task the agent suggested: Cavvy's own tool, and as Claude Code and Codex name it when it isn't mapped back. */
export const SUGGEST_TOOLS = new Set(["SuggestTask", "mcp__cavvy__suggest_task"]);

/** Whether a call gets a card of its own (sub-agents keep their own row). */
export function cardOf(t: ToolBlock): Card | undefined {
    if (t.agent) return undefined;
    if (EDIT_TOOLS.has(t.name)) return "edit";
    if (t.name === "Bash") return "command";
    if (t.name === "ExitPlanMode") return "plan";
    if (SUGGEST_TOOLS.has(t.name)) return "suggest";
    return undefined;
}

/** A card that stays in its turn when the turn's work folds away: a plan, a suggested task (they wait on the user). */
export const staysInTurn = (card: string | undefined): boolean => card === "plan" || card === "suggest";
