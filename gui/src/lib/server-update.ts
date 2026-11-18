// Bringing a server's Cavvy up to this computer's, from a window that isn't waiting on it (the window that is,
// asks in its cover: Servers.tsx MachineCover). Offered when this computer's Cavvy says the one there is behind.

import { homeRpc } from "./machines";
import { reportError, rpc, toast } from "../state/app";

/** How long the offer, and the question when updating would stop work, stay: long enough to read and reach. */
const OFFER_MS = 20_000;

/** The servers being updated: one isn't started twice. */
const updating = new Set<string>();

/** `force`: though sessions there are working or waiting (the user said so). */
export async function updateServer(name: string, force = false): Promise<void> {
    if (updating.has(name)) return;
    updating.add(name);
    toast(`Updating ${name}…`);
    try {
        const r = await homeRpc(rpc).call("servers.update", { name, force });
        if (r.status === "updated") toast(r.note ?? `Updated ${name}`, "success");
        // Updating stops them: asked, with what would stop.
        else if (r.status === "busy") {
            const n = r.working || r.waiting;
            toast(`${n} ${n === 1 ? "session" : "sessions"} on ${name} would stop`, "warn", { label: "Update anyway", run: () => updateServer(name, true) }, OFFER_MS);
        } else if (r.status === "unknown-host") reportError(new Error(`${name}'s key isn't one this computer has seen. Open ${name} to check it, then update.`));
        else reportError(new Error([r.problem.message, r.problem.detail, r.problem.fix].filter(Boolean).join(" ")));
    } catch (e) {
        reportError(e);
    } finally {
        updating.delete(name);
    }
}

/** The servers the user has been told are behind, in this window: each once. */
const told = new Set<string>();

/** This computer's Cavvy says `name` runs another build (or no longer does): offered once, with the way to update it. */
export function serverBehind(name: string, behind: boolean | undefined) {
    if (!behind) return void told.delete(name);
    if (told.has(name) || updating.has(name)) return;
    told.add(name);
    toast(`${name} runs another version of Cavvy`, "info", { label: "Update", run: () => updateServer(name) }, OFFER_MS);
}
