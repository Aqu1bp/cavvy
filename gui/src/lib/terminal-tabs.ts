// What a terminal tab is, and what its first shell takes that's kept off the tab (TerminalPanel, TerminalScreen).

import type { SavedTab } from "./terminal";

/**
 * `script`: the project script the tab was opened to run (once: restarting it gives a plain shell), and is named after.
 * `terminal`: its shell's id (a restart gives a new one). `attach`: the shell was running before this page loaded
 * (it was reloaded): the tab attaches to it, and never runs its script.
 */
export interface Tab extends SavedTab { attach?: boolean; closing?: boolean }
/** Setup tickets by tab, taken by the tab's first shell: kept off the tab so nothing that keeps tabs keeps one. */
export const setupTickets = new Map<string, string>();
/** A sign-in card's command for a tab's first shell to type (the server has the text), kept off the tab like a ticket. */
export const signInTabs = new Map<string, { session: string; interaction: string }>();
