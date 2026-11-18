// Sessions on the user's other machines, for an agent's ListSessions, ReadSession and SendToSession (src/agent/peers.ts
// FarPeers). Every machine reaches the others through the user's own computer: it keeps a connection to each server
// (src/servers/watch.ts), over which it asks a server about that server's sessions, and over which a server asks it
// (`peers.call`) about its own and the other servers'. A session's id names its machine as the asking machine calls
// it: on a server, `mac/<id>` is one of the user's computer's and `box/<id>` one of server box's.
//
// A message carries its sender's id as the receiving machine would name it, so its answer goes back the same way.

import { checkMessage, PeerError, type Delivery, type FarPeers, type PeerSummary } from "../agent/peers";
import type { PermissionMode } from "../permissions/modes";

/** What the user's own computer is called on its servers. */
export const HOME_NAME = process.platform === "darwin" ? "mac" : "desktop";

type Read = { text: string; title: string; turns: number } | undefined;
type Sent = { text: string; delivery: Delivery; title: string };
type From = { id: string; title: string; mode: PermissionMode };

/** One machine's own sessions, by their ids there (session-peers.ts peerOps). */
export interface PeerOps {
    list(o: { query?: string; limit: number }): PeerSummary[];
    read(id: string, turns?: number): Read;
    send(id: string, text: string, from: From): Promise<Sent>;
}

/** A connection to a server's Cavvy, asked as this computer (watch.ts ask). */
export interface ServerAsk {
    ask(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** `<machine>/<id>`, split. */
function split(id: string): { on: string; id: string } | undefined {
    const at = id.indexOf("/");
    if (at <= 0 || at === id.length - 1) return undefined;
    return { on: id.slice(0, at), id: id.slice(at + 1) };
}

const PEERS_MS = 30_000;
const str = (v: unknown, max = 100_000) => (typeof v === "string" ? v.slice(0, max) : "");
const DELIVERIES: Delivery[] = ["started", "joined", "held", "waiting", "limited"];

/** What a server answered for one of its sessions, kept to the shape it should have. */
function rowFrom(v: unknown, on: string): PeerSummary | undefined {
    if (!v || typeof v !== "object") return undefined;
    const r = v as Record<string, unknown>;
    if (typeof r.id !== "string" || !/^[\w.-]{1,120}$/.test(r.id)) return undefined;
    const status = r.status === "working" || r.status === "waiting" ? r.status : "idle";
    return { id: `${on}/${r.id}`, machine: on, title: str(r.title, 300), cwd: str(r.cwd, 1000), status, ...(typeof r.model === "string" ? { model: r.model.slice(0, 200) } : {}), updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0 };
}
const readFrom = (v: unknown): Read => (v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string" ? { text: str((v as { text: string }).text), title: str((v as { title?: unknown }).title, 300), turns: Number((v as { turns?: unknown }).turns) || 0 } : undefined);
function sentFrom(v: unknown): Sent {
    const r = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const delivery = DELIVERIES.find((d) => d === r.delivery) ?? "started";
    return { text: str(r.text, 2000), delivery, title: str(r.title, 300) };
}
/** What the machine a message went to said of it, naming the session as this machine names it (`<machine>/<id>`), not by the id it has there. */
function sentTo(id: string, v: unknown): Sent {
    const sent = sentFrom(v);
    // The id it leads with is the one that machine keeps (in its own spelling): the one asked for stands in its place.
    return { ...sent, text: sent.text.replace(/^Sent to session \S+ /, () => `Sent to session ${id} `) };
}
/** A server's refusal (PeerError there) is the model's to read, as one here would be. */
const refused = (e: unknown): never => {
    throw new PeerError(e instanceof Error ? e.message : String(e));
};

/** Newest first, at most `limit`. */
const newest = (rows: PeerSummary[], limit: number) => rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);

/**
 * On the user's own computer: its servers' sessions, asked of each server it's connected to. `servers`: those
 * connected now, by name.
 */
export function homeFarPeers(servers: () => Map<string, ServerAsk>): FarPeers {
    const at = (id: string) => {
        const s = split(id);
        const link = s && servers().get(s.on);
        if (!s || !link) throw new PeerError(`No session ${id}: ${s ? `${s.on} isn't one of the user's machines, or isn't connected right now` : "a session on another machine is named <machine>/<id>"}. ListSessions (all: true) shows the ones there are.`);
        return { ...s, link };
    };
    return {
        list: async ({ query, limit }) => {
            const asked = [...servers()];
            if (!asked.length) throw new PeerError("none of the user's servers is connected right now.");
            const lists = await Promise.allSettled(asked.map(([on, link]) => link.ask("peers.list", { query, limit }).then((rows) => (Array.isArray(rows) ? rows : []).flatMap((r) => rowFrom(r, on) ?? []))));
            // None answered: why, not none (one that didn't, among others that did, is left out).
            const failed = lists.flatMap((r, i) => (r.status === "rejected" ? [`${asked[i]![0]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`] : []));
            if (asked.length && failed.length === asked.length) throw new PeerError(failed.join("; "));
            return newest(lists.flatMap((r) => (r.status === "fulfilled" ? r.value : [])), limit);
        },
        read: async (id, turns) => {
            const s = at(id);
            return readFrom(await s.link.ask("peers.read", { id: s.id, turns }).catch(refused));
        },
        send: async (id, message, from) => {
            const s = at(id);
            // Named as the server names this computer's sessions.
            return sentTo(id, await s.link.ask("peers.send", { id: s.id, message, from: { ...from, id: `${HOME_NAME}/${from.id}` } }).catch(refused));
        },
    };
}

/**
 * On the user's own computer: what a server asks it for a session of that server's (`asker`), over its connection
 * there: this computer's sessions (`mac/<id>`) and the other servers' (`<name>/<id>`).
 */
export async function answerPeers(asker: string, op: string, params: Record<string, unknown>, here: PeerOps, servers: Map<string, ServerAsk>, denied: (tool: "ListSessions" | "ReadSession" | "SendToSession") => string | undefined = () => undefined): Promise<unknown> {
    // Its sessions would be named as this computer's are, there and everywhere else.
    if (asker === HOME_NAME) throw new PeerError(`A server named ${HOME_NAME} can't reach sessions on other machines: rename it in Cavvy on your computer to reach them.`);
    /** This computer's own rules, for one of its own sessions. */
    const allowed = (tool: "ListSessions" | "ReadSession" | "SendToSession") => {
        const why = denied(tool);
        if (why) throw new PeerError(why);
    };
    // Not one named as this computer is there: its sessions would pass for this computer's.
    const others = new Map([...servers].filter(([n]) => n !== asker && n !== HOME_NAME));
    const far = homeFarPeers(() => others);
    const limit = Math.max(1, Math.min(Number(params.limit) || 20, 200));
    if (op === "list") {
        const query = typeof params.query === "string" ? params.query : undefined;
        const mine = denied("ListSessions") ? [] : here.list({ query, limit }).map((s) => ({ ...s, id: `${HOME_NAME}/${s.id}`, machine: HOME_NAME }));
        // The other servers not answering leaves this computer's.
        return newest([...mine, ...(await far.list({ query, limit }).catch(() => []))], limit);
    }
    const id = str(params.id, 300);
    const s = split(id);
    if (!s) throw new PeerError(`No session ${id}. ListSessions (all: true) shows the ones there are.`);
    // Its own machine's, named as another machine would name it.
    if (s.on === asker) throw new PeerError(`${id} is on this machine: a session here goes by its id alone (${s.id}).`);
    if (op === "read") {
        const turns = typeof params.turns === "number" ? params.turns : undefined;
        if (s.on !== HOME_NAME) return far.read(id, turns);
        allowed("ReadSession");
        return here.read(s.id, turns);
    }
    if (op === "send") {
        const f = (params.from && typeof params.from === "object" ? params.from : {}) as Record<string, unknown>;
        if (typeof f.id !== "string" || !/^[\w.-]{1,120}$/.test(f.id)) throw new PeerError("That message names no session it's from.");
        const mode = (["plan", "default", "acceptEdits", "auto", "bypassPermissions"] as const).find((m) => m === f.mode);
        if (!mode) throw new PeerError("That message doesn't say what mode its session runs in.");
        // Named as the receiving machine names the asker's sessions: through this computer, by the asker's name.
        const from: From = { id: `${asker}/${f.id}`, title: str(f.title, 300), mode };
        const message = checkMessage(params.message);
        // Into one of this computer's: a server's session counts as Auto at most, so one here in Bypass takes no work
        // from a server (the user's computer is reached only through what it offers; a server can be rebuilt, it can't).
        if (s.on === HOME_NAME) {
            allowed("SendToSession");
            return here.send(s.id, message, { ...from, mode: mode === "bypassPermissions" ? "auto" : mode });
        }
        const link = others.get(s.on);
        if (!link) throw new PeerError(`No session ${id}: ${s.on} isn't one of the user's machines, or isn't connected right now.`);
        return sentFrom(await link.ask("peers.send", { id: s.id, message, from }).catch(refused));
    }
    throw new PeerError(`Unknown request ${op}.`);
}

/**
 * On a server: the user's own computer's Cavvy, connected here, answers for every other machine (answerPeers).
 * `call` sends it one request and resolves with its answer.
 */
export function serverFarPeers(call: (op: string, params: Record<string, unknown>) => Promise<unknown>): FarPeers {
    return {
        list: async (o) => {
            // Refused or not answered: said (session-tools.ts), not taken for none.
            const rows = await call("list", o).catch(refused);
            return newest(
                (Array.isArray(rows) ? rows : []).flatMap((r) => {
                    // Each already named as this machine names it (`mac/<id>`, `box/<id>`).
                    const s = r && typeof r === "object" ? split(String((r as { id?: unknown }).id ?? "")) : undefined;
                    const row = s && /^[\w.-]{1,40}$/.test(s.on) ? rowFrom({ ...(r as object), id: s.id }, s.on) : undefined;
                    return row ? [row] : [];
                }),
                o.limit,
            );
        },
        read: async (id, turns) => readFrom(await call("read", { id, turns }).catch(refused)),
        send: async (id, message, from) => sentTo(id, await call("send", { id, message, from }).catch(refused)),
    };
}

/** How long a server waits for the user's computer to answer about a session there. */
export const PEERS_WAIT_MS = PEERS_MS;
