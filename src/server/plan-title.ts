// A plan's title, as its card, its file name and its branch name show it. On its own,
// without Node's modules, so the GUI's plan card (lib/plan-chat.ts) uses the same one.

/** The plan's first heading (or first line), without "Plan:" and Markdown marks. */
export function planTitle(plan: string): string {
    const lines = plan.split("\n").map((l) => l.trim());
    const line = lines.find((l) => /^#{1,6}\s+\S/.test(l)) ?? lines.find(Boolean) ?? "";
    return line
        .replace(/^#+\s*/, "")
        .replace(/^(implementation\s+)?plan\s*[:\-–—]\s*/i, "")
        .replace(/[*_`[\]]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
}
