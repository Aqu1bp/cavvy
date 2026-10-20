// Slash commands as the composer reads them (the server reads them the same
// way: src/commands/custom.ts slashCommand).

/** The command a message starts with; "//x" and a path ("/Users/me/app.ts fails") are messages. */
export function slashName(text: string): string | undefined {
    const t = text.trim();
    if (!t.startsWith("/") || t.startsWith("//")) return undefined;
    const name = t.match(/^\/(\S+)/)?.[1];
    if (!name || name.includes("/") || name.includes(".")) return undefined;
    return name.toLowerCase();
}

/** What the GUI does itself for a slash command; the rest go to the server. */
export type ClientAction = "model" | "mode" | "new" | "rewind" | "fork" | "mcp" | "settings" | "usage" | "context" | "rename" | "export" | "tasks";

const CLIENT: Record<string, ClientAction> = {
    model: "model",
    mode: "mode",
    new: "new",
    clear: "new",
    rewind: "rewind",
    fork: "fork",
    mcp: "mcp",
    settings: "settings",
    config: "settings",
    // What the session and the plan have used: shown, not asked of the model.
    cost: "usage",
    usage: "usage",
    context: "context",
    rename: "rename",
    export: "export",
    tasks: "tasks",
};

export function clientAction(text: string): { action: ClientAction; args: string } | undefined {
    const name = slashName(text);
    const action = name ? CLIENT[name] : undefined;
    if (!action) return undefined;
    return { action, args: text.trim().replace(/^\/\S+\s*/, "") };
}

/** The $skill being typed at the cursor (`upto`: the text before it): what follows the $, and where the $ is. */
export function skillToken(upto: string): { query: string; start: number } | undefined {
    // Lowercase only: $HOME is a shell variable.
    const m = upto.match(/(?:^|\s)\$([a-z0-9][a-z0-9:_-]*)?$/);
    if (!m) return undefined;
    const query = m[1] ?? "";
    return { query, start: upto.length - query.length - 1 };
}

/** The skills a $query offers, names that start with it first. */
export function matchSkills<T extends { name: string; skill?: boolean }>(commands: readonly T[], query: string, limit = 8): T[] {
    const q = query.toLowerCase();
    return commands
        .filter((c) => c.skill && (c.name.startsWith(q) || (q.length > 1 && c.name.includes(q))))
        .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)) || a.name.localeCompare(b.name))
        .slice(0, limit);
}
