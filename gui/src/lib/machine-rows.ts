// The rules of the one list of every machine's sessions (components/OtherMachines.tsx): which sessions of other
// machines are listed beside the window's own, and where what a row offers is sent.

import { RELAYED_ARCHIVE_OFFER, RELAYED_SESSION_METHODS, type MachineOverview, type SessionSummary } from "@shared/protocol";

/**
 * The other machines' sessions, each with its machine (the server's name; none: this computer). Not the window's
 * own machine's: those are the window's. `mac`: this computer's sessions, for a window that's on a server.
 */
export function otherRows(machine: string | undefined, mac: Iterable<SessionSummary>, servers: Iterable<MachineOverview>): SessionSummary[] {
    const out: SessionSummary[] = [];
    if (machine) for (const s of mac) out.push({ ...s, machine: undefined });
    for (const m of servers) if (m.name !== machine && m.state !== "removed") for (const s of m.sessions) out.push({ ...s, machine: m.name });
    return out;
}

/**
 * Those of `others` that may be listed beside the window's `own`: not one with the id of one of the window's own,
 * nor of another already taken (a server chooses its sessions' ids; it doesn't get to choose a row here).
 */
export function listable(own: readonly SessionSummary[], others: readonly SessionSummary[]): SessionSummary[] {
    const taken = new Set(own.map((s) => s.id));
    return others.filter((s) => !taken.has(s.id) && Boolean(taken.add(s.id)));
}

/**
 * Whether a session of another machine that changed may take the row with its id: when there's none, or it's that
 * same machine's.
 */
export function mayTake(row: Pick<SessionSummary, "machine"> | undefined, machine: string | undefined, from: string | undefined): boolean {
    return !row || (row.machine !== machine && row.machine === from);
}

/**
 * Where a call about a session goes, in a window that lists every machine's. `here`: the window's own connection
 * (it's one of its machine's, or not about a listed session). `mac`: this computer's Cavvy, for one of its own.
 * `relay`: this computer's Cavvy passes it on to that server. `refused`: it's another machine's, and not something
 * a row offers: that's done in a window that's on it. `far`: the listed sessions of other machines, by id, with the
 * server each is on (none: this computer); `gone`: those deleted since, which Undo brings back where they were.
 */
/**
 * The list made again from every machine's sessions as they stand: which are another machine's now (`far`), which
 * left (`out`: with the machine each was on, for what's asked of it next), and whether some machine's sessions are
 * in it that weren't (`joins`).
 */
export function relisted(before: ReadonlyMap<string, string | undefined>, add: readonly Pick<SessionSummary, "id" | "machine">[], joined: ReadonlySet<string | undefined>) {
    const far = new Map(add.map((s) => [s.id, s.machine]));
    const out = [...before].filter(([id]) => !far.has(id));
    const machines = new Set(far.values());
    return { far, out, machines, joins: [...machines].some((m) => !joined.has(m)) };
}

export function routeOf(
    method: string,
    params: unknown,
    far: ReadonlyMap<string, string | undefined>,
    row: (id: string) => Pick<SessionSummary, "machine"> | undefined,
    machine: string | undefined,
    gone: ReadonlyMap<string, string | undefined> = new Map(),
): "here" | "mac" | "refused" | { relay: string } {
    const id = method.startsWith("session.") && params && typeof params === "object" ? (params as { id?: unknown }).id : undefined;
    if (typeof id !== "string") return "here";
    const to = (at: string | undefined) => (at === undefined ? ("mac" as const) : { relay: at });
    // Deleted on another machine, and not listed since: brought back there. (Most calls are about the window's own
    // sessions and end here, without the list being looked through.)
    if (!far.has(id)) return method === "session.restore" && gone.has(id) && !row(id) ? to(gone.get(id)) : "here";
    const now = row(id);
    // Just deleted there (its row is gone, the server hasn't said so yet): Undo is still that machine's.
    if (!now) return method === "session.restore" ? to(far.get(id)) : "here";
    // One of the window's own machine's has that id now: it's that one that's meant.
    if (now.machine === machine) return "here";
    if (method !== RELAYED_ARCHIVE_OFFER && !RELAYED_SESSION_METHODS.some((m) => m === method)) return "refused";
    return to(far.get(id));
}
