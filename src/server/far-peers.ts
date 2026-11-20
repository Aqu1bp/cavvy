// Sessions on the user's other machines, for an agent's ListSessions, ReadSession and SendToSession (src/agent/peers.ts
// FarPeers). Every machine reaches the others through the user's own computer: it keeps a connection to each server
// (src/servers/watch.ts), over which it asks a server about that server's sessions, and over which a server asks it
// (`peers.call`) about its own and the other servers'. A session's id names its machine as the asking machine calls
// it: on a server, `mac/<id>` is one of the user's computer's and `box/<id>` one of server box's.
//
// A message carries its sender's id as the receiving machine would name it, so its answer goes back the same way.

import { homedir } from "os";
import { findMatch, parseRule } from "../permissions/rules";
import { MCP_SERVER_NAME } from "../config/name";
import { checkMessage, PeerError, PeerUnsure, type Delivery, type FarPeers, type FarStart, type PeerSummary, type StartChoice } from "../agent/peers";
import { EFFORT_LEVELS, type Effort } from "../config/settings";
import type { PermissionMode } from "../permissions/modes";

/** What the user's own computer is called on its servers. */
export const HOME_NAME = process.platform === "darwin" ? "mac" : "desktop";

type Read = { text: string; title: string; turns: number } | undefined;
type Sent = { text: string; delivery: Delivery; title: string };
type From = { id: string; title: string; mode: PermissionMode };
type Started = PeerSummary & { effort?: Effort };

/** One machine's own sessions, by their ids there (session-peers.ts peerOps). */
export interface PeerOps {
    list(o: { query?: string; limit: number }): PeerSummary[];
    read(id: string, turns?: number): Read;
    send(id: string, text: string, from: From): Promise<Sent>;
    start(o: { cwd: string; prompt: string; title: string } & StartChoice, from: From): Promise<Started>;
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
/** What a machine read of its session, naming it as this machine names it (`<machine>/<id>`). */
function readOf(id: string, v: unknown): Read {
    const read = readFrom(v);
    return read && { ...read, text: read.text.replace(/^Session \S+ /, () => `Session ${id} `) };
}
/** A server's refusal (PeerError there) is the model's to read, as one here would be. */
/** The session a machine says it started, named as this machine names it (`<machine>/<id>`); a PeerError when what it answered isn't one. */
function startedOn(on: string, v: unknown): Started {
    const row = rowFrom(v, on);
    // The session and where it is: one without a folder isn't one it started.
    if (!row?.cwd.trim()) throw new PeerUnsure(`${on} didn't say which session it started. It may have started one all the same: ${LOOK_FIRST}`);
    const effort = EFFORT_LEVELS.find((e) => e === (v as { effort?: unknown }).effort);
    return { ...row, ...(effort ? { effort } : {}) };
}

/** What a start asks of the machine it's for, of the kinds it takes. */
function startOf(params: Record<string, unknown>): { cwd: string; prompt: string; title: string } & StartChoice {
    const cwd = str(params.cwd, 1000).trim();
    if (!cwd) throw new PeerError("Say which folder on that machine the session starts in (folder).");
    const prompt = checkMessage(params.prompt, "prompt");
    const model = str(params.model, 200).trim();
    const effort = str(params.effort, 40).trim();
    return { cwd, prompt, title: str(params.title, 80).replace(/\s+/g, " ").trim() || prompt.replace(/\s+/g, " ").slice(0, 80), ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** The session a request says it's from, with the mode it runs in. */
function fromOf(params: Record<string, unknown>): { id: string; title: string; mode: PermissionMode } {
    const f = (params.from && typeof params.from === "object" ? params.from : {}) as Record<string, unknown>;
    if (typeof f.id !== "string" || !/^[\w.-]{1,120}$/.test(f.id)) throw new PeerError("That message names no session it's from.");
    const mode = (["plan", "default", "acceptEdits", "auto", "bypassPermissions"] as const).find((m) => m === f.mode);
    if (!mode) throw new PeerError("That message doesn't say what mode its session runs in.");
    return { id: f.id, title: str(f.title, 300), mode };
}

/**
 * As `refused`, for a start: a machine that didn't answer (in time, or went away) may have started the session all
 * the same, which is said, and told apart from a refusal (the starter's count keeps it).
 */
const startRefused = (e: unknown): never => {
    const said = e instanceof Error ? e.message : String(e);
    // Said so already, by a machine this one asked through.
    if (said.includes(LOOK_FIRST)) throw new PeerUnsure(said);
    if (NO_ANSWER.test(said)) throw new PeerUnsure(`${said} The session may have started all the same: ${LOOK_FIRST}`);
    throw new PeerError(said);
};
/** What an unanswered start ends with, wherever it's said: how it's known for one across the machines it's told through. */
const LOOK_FIRST = "look with ListSessions (all: true) before starting it again.";
/** A call that got no answer, as the connections say it (watch.ts request; engine.ts peers.call, dropHub): the whole of what they say. */
const NO_ANSWER = /^(?:[\w.-]+ didn't answer\.|[\w.-]+ went away before it answered\.|Cavvy on your computer didn't answer in time\.|Cavvy on your computer went away before it answered\.)$/;

const refused = (e: unknown): never => {
    throw new PeerError(e instanceof Error ? e.message : String(e));
};
/** As `refused`, naming the session as this machine names it (`<machine>/<id>`), not by the id it has there. */
const refusedOf = (id: string) => (e: unknown): never => {
    throw new PeerError((e instanceof Error ? e.message : String(e)).replace(/^Session \S+ /, () => `Session ${id} `));
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
            return readOf(id, await s.link.ask("peers.read", { id: s.id, turns }).catch(refused));
        },
        send: async (id, message, from) => {
            const s = at(id);
            // Named as the server names this computer's sessions.
            return sentTo(id, await s.link.ask("peers.send", { id: s.id, message, from: { ...from, id: `${HOME_NAME}/${from.id}` } }).catch(refusedOf(id)));
        },
        start: async ({ machine, ...o }, from) => {
            const link = servers().get(machine);
            if (!link) throw new PeerError(noMachine(machine, [...servers().keys()]));
            return startedOn(machine, await link.ask("peers.start", { ...o, from: { ...from, id: `${HOME_NAME}/${from.id}` } }).catch(startRefused));
        },
    };
}

/** No machine by that name to start a session on: with the ones there are. */
const noMachine = (machine: string, known: string[]) =>
    `No machine "${machine.slice(0, 60)}" to start a session on${known.length ? `. The user's other machines connected now: ${known.join(", ")}` : ": none of the user's other machines is connected right now"}. Leave machine out to start one on this machine.`;

/**
 * On the user's own computer: what a server asks it for a session of that server's (`asker`), over its connection
 * there: this computer's sessions (`mac/<id>`) and the other servers' (`<name>/<id>`).
 */
export async function answerPeers(asker: string, op: string, params: Record<string, unknown>, here: PeerOps, servers: Map<string, ServerAsk>, denied: (tool: "ListSessions" | "ReadSession" | "SendToSession" | "StartSession") => string | undefined = () => undefined): Promise<unknown> {
    // Its sessions would be named as this computer's are, there and everywhere else.
    if (asker === HOME_NAME) throw new PeerError(`A server named ${HOME_NAME} can't reach sessions on other machines: rename it in Cavvy on your computer to reach them.`);
    /** This computer's own rules, for one of its own sessions. */
    const allowed = (tool: "ListSessions" | "ReadSession" | "SendToSession" | "StartSession") => {
        const why = denied(tool);
        if (why) throw new PeerError(why);
    };
    // Not one named as this computer is there: its sessions would pass for this computer's.
    const others = new Map([...servers].filter(([n]) => n !== asker && n !== HOME_NAME));
    const far = homeFarPeers(() => others);
    const limit = Math.max(1, Math.min(Number(params.limit) || 20, 200));
    if (op === "list") {
        const query = typeof params.query === "string" ? params.query : undefined;
        // This computer's rules stand for what goes through it too: another server's sessions as its own.
        allowed("ListSessions");
        const mine = here.list({ query, limit }).map((s) => ({ ...s, id: `${HOME_NAME}/${s.id}`, machine: HOME_NAME }));
        // The other servers not answering leaves this computer's.
        const theirs = await far.list({ query, limit }).catch(() => []);
        return newest([...mine, ...theirs], limit);
    }
    if (op === "start") {
        const machine = str(params.machine, 60).trim();
        const o = startOf(params);
        const f = fromOf(params);
        // Its own machine, named as another would name it.
        if (machine === asker) throw new PeerError(`${machine} is this machine: leave machine out to start a session here.`);
        allowed("StartSession");
        // Named as the receiving machine names the asker's sessions: through this computer, by the asker's name.
        const from: From = { id: `${asker}/${f.id}`, title: f.title, mode: f.mode };
        // On this computer: a server's session counts as Auto at most, so what it starts here asks no less than Auto does.
        if (machine === HOME_NAME) {
            const s = await here.start(o, { ...from, mode: f.mode === "bypassPermissions" ? "auto" : f.mode });
            return { ...s, id: `${HOME_NAME}/${s.id}`, machine: HOME_NAME };
        }
        const link = others.get(machine);
        if (!link) throw new PeerError(noMachine(machine, [HOME_NAME, ...others.keys()]));
        return startedOn(machine, await link.ask("peers.start", { ...o, from }).catch(startRefused));
    }
    const id = str(params.id, 300);
    const s = split(id);
    if (!s) throw new PeerError(`No session ${id}. ListSessions (all: true) shows the ones there are.`);
    // Its own machine's, named as another machine would name it.
    if (s.on === asker) throw new PeerError(`${id} is on this machine: a session here goes by its id alone (${s.id}).`);
    if (op === "read") {
        const turns = typeof params.turns === "number" ? params.turns : undefined;
        allowed("ReadSession");
        if (s.on !== HOME_NAME) return far.read(id, turns);
        return here.read(s.id, turns);
    }
    if (op === "send") {
        const f = fromOf(params);
        const mode = f.mode;
        // Named as the receiving machine names the asker's sessions: through this computer, by the asker's name.
        const from: From = { id: `${asker}/${f.id}`, title: f.title, mode };
        const message = checkMessage(params.message);
        // Into one of this computer's: a server's session counts as Auto at most, so one here in Bypass takes no work
        // from a server (the user's computer is reached only through what it offers; a server can be rebuilt, it can't).
        allowed("SendToSession");
        if (s.on === HOME_NAME) {
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
        read: async (id, turns) => readOf(id, await call("read", { id, turns }).catch(refused)),
        send: async (id, message, from) => sentTo(id, await call("send", { id, message, from }).catch(refusedOf(id))),
        start: async (o, from) => {
            const v = await call("start", { ...o, from }).catch(startRefused);
            // Already named as this machine names it (`mac/<id>`, `box/<id>`).
            const s = v && typeof v === "object" ? split(String((v as { id?: unknown }).id ?? "")) : undefined;
            if (!s || !/^[\w.-]{1,40}$/.test(s.on)) throw new PeerUnsure(`The user's computer didn't say which session was started. One may have been all the same: ${LOOK_FIRST}`);
            return startedOn(s.on, { ...(v as object), id: s.id });
        },
    };
}

/** How long a server waits for the user's computer to answer about a session there. */
export const PEERS_WAIT_MS = PEERS_MS;

/**
 * Whether the computer's deny rules keep `tool` (ListSessions, ReadSession, SendToSession) from another machine's
 * sessions. A rule that names the tool at all denies it, whatever it says of its input (none is given for another
 * machine's call), under its own name or the one the CLIs call it by.
 */
export function peersDenied(deny: string[], tool: string): boolean {
    const named = deny.map((r) => parseRule(r).tool);
    const cli = `mcp__${MCP_SERVER_NAME}__${tool.replace(/[A-Z]/g, (c, i) => (i ? "_" : "") + c.toLowerCase())}`;
    return [tool, cli].some((n) => findMatch(named, { toolName: n }, homedir(), "deny") !== undefined);
}
