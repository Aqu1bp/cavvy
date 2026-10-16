// What the composer's context ring and card show (no DOM, so it's tested from test/).

import { tokens } from "./format";

export interface ContextView {
    /** The ring is drawn: the window's size is known, or the card was asked for (/context). */
    ring: boolean;
    /** Share used, 0-1; undefined while the window's size isn't known. */
    pct?: number;
    line: string;
}

export function contextView(s: { contextTokens: number; model?: { contextWindow?: number; providerName?: string } } | undefined, cardOpen: boolean): ContextView {
    if (!s) return { ring: false, line: "" };
    const win = s.model?.contextWindow;
    if (win) return { ring: true, pct: s.contextTokens / win, line: `${tokens(s.contextTokens)} of ${tokens(win)} tokens` };
    // Claude Code says how big its window is only with its first result.
    const who = s.model?.providerName ?? "The model";
    return { ring: cardOpen, line: `Not known yet: ${who} reports the window's size after its first reply.` };
}
