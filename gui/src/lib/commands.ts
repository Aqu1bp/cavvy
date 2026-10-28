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
export type ClientAction = "model" | "mode" | "new" | "rewind" | "fork" | "mcp" | "settings" | "plugins" | "usage" | "context" | "rename" | "export" | "tasks";

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
    plugin: "plugins",
    plugins: "plugins",
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
export function matchSkills<T extends { name: string; skill?: boolean }>(commands: readonly T[], query: string, limit = 50): T[] {
    const q = query.toLowerCase();
    return commands
        .filter((c) => c.skill && (c.name.startsWith(q) || (q.length > 1 && c.name.includes(q))))
        .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)) || a.name.localeCompare(b.name))
        .slice(0, limit);
}

/** What the /command a message is takes ("[pr|focus]"), shown after it until something's typed there. */
export function argsHint(text: string, commands: readonly { name: string; args?: string }[]): string | undefined {
    const m = text.match(/^\s*\/\S+( *)$/);
    const name = m ? slashName(text) : undefined;
    const args = name ? commands.find((c) => c.name === name)?.args : undefined;
    return args ? `${m![1] ? "" : " "}${args}` : undefined;
}

/** A run of the composer's text: plain, or a command or skill that will run. */
export type TextPiece = { text: string; kind?: "command" | "skill" };

/**
 * The text cut where it names what will run: the /command it starts with and each $skill it mentions, when there's
 * one by that name. Read as the server reads them (slashName above; mentionNames in src/agent/skills.ts), so a path,
 * a price or $HOME stays plain.
 */
export function textPieces(text: string, commands: readonly { name: string; skill?: boolean }[]): TextPiece[] {
    if (!commands.length || !/[/$]/.test(text)) return [{ text }];
    const marks: { start: number; end: number; kind: "command" | "skill" }[] = [];
    const lead = text.match(/^\s*(\/\S+)/);
    const name = slashName(text);
    if (lead && name && commands.some((c) => c.name === name)) marks.push({ start: lead[0].length - lead[1]!.length, end: lead[0].length, kind: "command" });
    const skills = new Set(commands.filter((c) => c.skill).map((c) => c.name));
    for (const m of text.matchAll(/(^|[\s(])\$([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=[\s.,;:!?)]|$)/g)) {
        const raw = m[2]!.replace(/:+$/, "");
        if (!/[a-z]/.test(raw) || !skills.has(raw.toLowerCase())) continue;
        const start = m.index! + m[1]!.length;
        marks.push({ start, end: start + 1 + raw.length, kind: "skill" });
    }
    if (!marks.length) return [{ text }];
    const out: TextPiece[] = [];
    let at = 0;
    for (const mk of marks.sort((a, b) => a.start - b.start)) {
        if (mk.start > at) out.push({ text: text.slice(at, mk.start) });
        out.push({ text: text.slice(mk.start, mk.end), kind: mk.kind });
        at = mk.end;
    }
    if (at < text.length) out.push({ text: text.slice(at) });
    return out;
}
