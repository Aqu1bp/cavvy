// The side chat's words for the session it's about (SideChatPane): what Bring back puts in its input.

import type { Turn } from "@shared/protocol";

/** Quoted, a line at a time, for the message box: what it's about, not what's asked. */
export function quoted(text: string): string {
    return `${text.trim().split("\n").map((l) => (l.trim() ? `> ${l}` : ">")).join("\n")}\n\n`;
}

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
