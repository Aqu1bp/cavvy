// Tools one of the user's machines lends another. A server has no iOS simulators; the user's Mac has. While the
// Mac's Cavvy is connected to a server's (src/servers/watch.ts), it can lend its simulator tools: sessions on the
// server then have them, and each call runs on the Mac, through the Mac's own checks (its permission mode, its
// rules, its user), in a session of the Mac's that shows what was done (Engine.lend).
//
// Here: what can be lent, and whether this process has been lent it. How a call travels is the engine's.

import type { PermissionMode } from "../permissions/modes";
import { simulatorsLikely } from "../simulator/simctl";
import type { ToolResult } from "./types";

/** What a machine can lend, by kind. */
export const LENDABLE = ["simulator"] as const;
export type Lendable = (typeof LENDABLE)[number];

/** A session's way to the machine that lends (ToolState.lends): one call of one of its tools. */
export interface Lends {
    /** `decided`: the lender's mode the call was decided under here (lentAs), sent with it; none, it isn't sent. */
    call(tool: string, input: Record<string, unknown>, signal: AbortSignal, decided?: PermissionMode): Promise<ToolResult>;
}

let lentNow: ReadonlySet<Lendable> = new Set();
let lenderMode: PermissionMode = "default";
/** As the lender said it. */
let lenderSaid: PermissionMode = "default";

/** What's lent to this machine now (none: nothing is, or the lender went away), and the lender's own default mode. */
export function setLent(kinds: Iterable<Lendable>, mode: PermissionMode = "default") {
    lentNow = new Set(kinds);
    // Plan there would refuse every call: it holds them as Manual does.
    lenderMode = mode === "plan" ? "default" : mode;
    lenderSaid = mode;
}

/**
 * The lender's mode as it said it, for a call decided now: sent with the call, so the lender turns away one decided
 * under a mode it has left since (while the reviewer or the user was answering).
 */
export const lentAs = (): PermissionMode => lenderSaid;

/**
 * A call of `tool` here runs on the lending machine (the user's Mac): the mode it's held to there, its user's default.
 * A session's call of it is decided under the stricter of that and its own (Agent.prepare): Bypass on a server is
 * for the server. A Mac server runs the call on its own simulators, as simulator-tools.ts routes it: none.
 */
export function lentMode(tool: string): PermissionMode | undefined {
    return /^Simulator/.test(tool) && lentNow.has("simulator") && !simulatorsLikely() ? lenderMode : undefined;
}

export function lent(kind: Lendable): boolean {
    return lentNow.has(kind);
}
