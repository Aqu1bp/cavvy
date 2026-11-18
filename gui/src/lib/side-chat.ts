// The side chat's words for the session it's about (SideChatPane): what Bring back attaches to its message
// (lib/attachments.ts sideChatText).

import type { Turn } from "@shared/protocol";

/** The last thing the side chat said: its latest turn's last words. */
export function lastAnswer(turns: readonly Turn[]): string | undefined {
    for (let i = turns.length - 1; i >= 0; i--) {
        const blocks = turns[i]!.blocks;
        for (let j = blocks.length - 1; j >= 0; j--) {
            const b = blocks[j]!;
            if (b.t === "text" && b.text.trim()) return b.text;
        }
    }
    return undefined;
}
