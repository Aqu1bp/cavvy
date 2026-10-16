import type { Turn } from "@shared/protocol";

/** The prompt whose response a turn belongs to, including messages sent while it worked. */
export function forkAnchor(turns: Turn[], i: number): { index: number; text: string; turn: string } | undefined {
    for (let k = i; k >= 0; k--) {
        const t = turns[k]!;
        if (t.archived) return undefined;
        // Imported turns cannot rewind, so their prompt has no rewind index. Forking
        // keeps the original intact and can use their position in the current history.
        const index = t.prompt?.index ?? (t.imported ? t.pos?.index : undefined);
        if (t.prompt && index !== undefined) return { index, text: t.prompt.text, turn: t.id };
    }
    return undefined;
}
