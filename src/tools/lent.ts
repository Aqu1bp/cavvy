// Tools one of the user's machines lends another. A server has no iOS simulators; the user's Mac has. While the
// Mac's Cavvy is connected to a server's (src/servers/watch.ts), it can lend its simulator tools: sessions on the
// server then have them, and each call runs on the Mac, through the Mac's own checks (its permission mode, its
// rules, its user), in a session of the Mac's that shows what was done (Engine.lend).
//
// Here: what can be lent, and whether this process has been lent it. How a call travels is the engine's.

import type { ToolResult } from "./types";

/** What a machine can lend, by kind. */
export const LENDABLE = ["simulator"] as const;
export type Lendable = (typeof LENDABLE)[number];

/** A session's way to the machine that lends (ToolState.lends): one call of one of its tools. */
export interface Lends {
    call(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
}

let lentNow: ReadonlySet<Lendable> = new Set();

/** What's lent to this machine now (none: nothing is, or the lender went away). */
export function setLent(kinds: Iterable<Lendable>) {
    lentNow = new Set(kinds);
}

export function lent(kind: Lendable): boolean {
    return lentNow.has(kind);
}
