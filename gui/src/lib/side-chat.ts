// The side chat's words for the session it's about (SideChatPane): what Bring back attaches to its message
// (lib/attachments.ts sideChatText).

import type { Turn } from "@shared/protocol";

/** The last thing the side chat said: its latest finished turn's last words (not one still being written). */
export function lastAnswer(turns: readonly Turn[]): string | undefined {
    for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i]!.status === "running") continue;
        const blocks = turns[i]!.blocks;
        for (let j = blocks.length - 1; j >= 0; j--) {
            const b = blocks[j]!;
            if (b.t === "text" && b.text.trim()) return b.text;
        }
    }
    return undefined;
}

/**
 * Whether the side chat may have changed the folder since it was last looked at: an edit landed, or a turn ended.
 * `before` and `now` are [files changed, busy]; nothing on the first look (the side chat just opened).
 */
export function sideChatMoved(before: readonly [number | undefined, boolean] | undefined, now: readonly [number | undefined, boolean]): boolean {
    return before?.[0] !== undefined && (now[0] !== before[0] || (before[1] && !now[1]));
}
