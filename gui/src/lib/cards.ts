// Which tool calls get a card of their own in a turn's work. Here, not in the component that draws them, so what
// doesn't draw (finding text in a conversation, on the server too) can ask.
import type { ToolBlock } from "@shared/protocol";

export type Card = "edit" | "command" | "plan";

export const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** Whether a call gets a card of its own (sub-agents keep their own row). */
export function cardOf(t: ToolBlock): Card | undefined {
    if (t.agent) return undefined;
    if (EDIT_TOOLS.has(t.name)) return "edit";
    if (t.name === "Bash") return "command";
    if (t.name === "ExitPlanMode") return "plan";
    return undefined;
}
