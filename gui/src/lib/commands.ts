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
export type ClientAction = "model" | "mode" | "new" | "rewind" | "settings" | "usage" | "context" | "rename" | "export" | "tasks";

const CLIENT: Record<string, ClientAction> = {
    model: "model",
    mode: "mode",
    new: "new",
    clear: "new",
    rewind: "rewind",
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
