// A finished turn's changes card, wherever the turn worked: the session's own folder (its snapshot) and the
// other worktrees it worked in (the server's TurnPlace). One place shows its files; several are one row each,
// the session's folder first, then the busiest, with who worked there.

import type { AgentRun, Block, TurnPlace } from "@shared/protocol";
import { agentWorktree, normalPath } from "@shared/worktree-agents";

/** The places shown before "N more places". */
export const PLACES_SHOWN = 4;
/** Who worked in a place, named; the rest are counted. */
export const WHO_NAMED = 2;

/** The session's own folder as a row: what its snapshot counted. */
export interface OwnPlace {
    files: number;
    added: number;
    removed: number;
}

export type PlaceRow = { own: true; place: OwnPlace } | { own: false; place: TurnPlace };

/** How the card shows: its own folder's files, one worktree's files, or a row per place. */
export function cardShape(own: OwnPlace | undefined, places: readonly TurnPlace[]): "files" | "worktree" | "places" {
    if (!places.length) return "files";
    return places.length === 1 && !own ? "worktree" : "places";
}

/** The rows: the session's own folder first (when it changed), then the other worktrees, most files first. */
export function placeRows(own: OwnPlace | undefined, places: readonly TurnPlace[]): PlaceRow[] {
    const rest = [...places].sort((a, b) => (b.files ?? 0) - (a.files ?? 0) || (b.added ?? 0) + (b.removed ?? 0) - ((a.added ?? 0) + (a.removed ?? 0)));
    return [...(own ? [{ own: true as const, place: own }] : []), ...rest.map((place) => ({ own: false as const, place }))];
}

/** The whole card's count, for its head. */
export function placesTotal(rows: readonly PlaceRow[]): OwnPlace {
    return rows.reduce((t, r) => ({ files: t.files + (r.place.files ?? 0), added: t.added + (r.place.added ?? 0), removed: t.removed + (r.place.removed ?? 0) }), { files: 0, added: 0, removed: 0 });
}

/** One that worked in a place: a sub-agent of the turn, or the session itself ("You"). */
export interface Worker {
    id: string;
    label: string;
    /** Its provider, for its mark; the session's own when not known. */
    provider?: string;
    you?: boolean;
}

/**
 * Who worked in each place this turn: its sub-agents, by the paths their calls name (worktree-agents.ts), and
 * the session itself when its own calls went there. Keyed by the place's path as the server gave it.
 */
export function workers(places: readonly TurnPlace[], o: { turnId: string; agents?: readonly AgentRun[]; blocks?: readonly Block[]; home?: string; provider?: (a: AgentRun) => string | undefined; own?: string }): Map<string, Worker[]> {
    const byNormal = new Map<string, string>();
    for (const p of places) {
        const n = normalPath(p.path, o.home);
        if (n && !byNormal.has(n)) byNormal.set(n, p.path);
    }
    const normals = [...byNormal.keys()];
    const out = new Map<string, Worker[]>();
    const add = (where: string | undefined, w: Worker) => {
        const key = where && byNormal.get(where);
        if (key) out.set(key, [...(out.get(key) ?? []), w]);
    };
    const tools = (o.blocks ?? []).filter((b) => b.t === "tool");
    if (tools.length) add(agentWorktree({ blocks: tools }, normals, o.home), { id: "you", label: "You", provider: o.own, you: true });
    for (const a of o.agents ?? []) {
        if (a.turnId !== o.turnId) continue;
        add(agentWorktree(a, normals, o.home), { id: a.id, label: a.description || "Sub-agent", provider: o.provider?.(a) ?? o.own });
    }
    return out;
}

/** The snapshot's policy, which every result carries: not news on a card. */
const POLICY = /^Ignored files are not captured\./;

/**
 * An incomplete snapshot in one line: how many paths it left out, else that it's incomplete; the reasons go
 * in its tooltip, without the snapshot's standing policy.
 */
export function incompleteLine(notes: readonly string[] = []): { text: string; detail: string } {
    const said = notes.filter((n) => !POLICY.test(n));
    const listed = said.filter((n) => n.startsWith("Not captured: ")).length;
    const others = said.map((n) => /^(\d+) other paths were not captured\.$/.exec(n)?.[1]).find(Boolean);
    const left = listed + (others ? Number(others) : 0);
    return { text: left ? `${left === 1 ? "1 path" : `${left} paths`} not captured` : "Snapshot incomplete", detail: said.join("\n") };
}
