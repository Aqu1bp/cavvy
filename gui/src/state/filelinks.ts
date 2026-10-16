// Which paths in agent text are files in the session, asked of the server in
// batches and remembered per session, so each path is checked once. A path
// found missing is asked again after a while: the agent may create it.

import { createSignal } from "solid-js";
import { rpc } from "./app";

const BATCH = 200;
const RECHECK_MISSING_MS = 30_000;
const MAX_KNOWN = 5000;

type Known = { abs: string | null; at: number };
const known = new Map<string, Map<string, Known>>();
const asking = new Map<string, Set<string>>();

/** Bumped when answers arrive, so rendered replies look again. */
const [version, setVersion] = createSignal(0);
export const linksVersion = version;

export function pathLookup(sessionId: string): (path: string) => string | null | undefined {
    return (path) => {
        const k = known.get(sessionId)?.get(path);
        if (!k) return undefined;
        if (k.abs === null && Date.now() - k.at > RECHECK_MISSING_MS) return undefined;
        return k.abs;
    };
}

export async function resolvePaths(sessionId: string, paths: Iterable<string>): Promise<void> {
    let m = known.get(sessionId);
    if (!m || m.size > MAX_KNOWN) known.set(sessionId, (m = new Map()));
    const busy = asking.get(sessionId) ?? new Set<string>();
    asking.set(sessionId, busy);
    const lookup = pathLookup(sessionId);
    const todo = [...new Set(paths)].filter((p) => lookup(p) === undefined && !busy.has(p));
    if (!todo.length) return;
    for (const p of todo) busy.add(p);
    const batches: string[][] = [];
    for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
    await Promise.all(
        batches.map(async (batch) => {
            let found: (string | null)[] = [];
            try {
                found = await rpc.call("fs.exists", { sessionId, paths: batch });
            } catch {
                // the session closed, or the server is gone: not links, for now
            }
            const at = Date.now();
            batch.forEach((p, i) => (m!.set(p, { abs: found[i] ?? null, at }), busy.delete(p)));
        }),
    );
    setVersion((v) => v + 1);
}
