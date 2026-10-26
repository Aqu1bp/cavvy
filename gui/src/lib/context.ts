// What the composer's context ring and card show (no DOM, so it's tested from test/).

import { tokens } from "./format";

export interface ContextView {
    /** The ring is drawn: the window's size is known, or the card was asked for (/context). */
    ring: boolean;
    /** Share used of `full`, 0-1; undefined while neither the window nor where it compacts is known. */
    pct?: number;
    /** What "full" means: where it compacts on its own (SessionState.compactAt), else the model's window. */
    full?: number;
    /** The model's whole window, when known. */
    window?: number;
    /** It compacts before the window is full (a setting, or Harness's room for the answer). */
    early?: boolean;
    line: string;
}

export function contextView(s: { contextTokens: number; compactAt?: number; model?: { contextWindow?: number; providerName?: string } } | undefined, cardOpen: boolean): ContextView {
    if (!s) return { ring: false, line: "" };
    const win = s.model?.contextWindow;
    const full = s.compactAt && win ? Math.min(s.compactAt, win) : s.compactAt ?? win;
    if (full) return { ring: true, pct: s.contextTokens / full, full, window: win, early: Boolean(win && full < win), line: `${tokens(s.contextTokens)} of ${tokens(full)}` };
    // Claude Code says how big its window is only with its first result.
    const who = s.model?.providerName ?? "the model";
    return { ring: cardOpen, line: `Known after ${who}'s first reply` };
}
