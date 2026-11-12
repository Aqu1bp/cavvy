// Other sessions, as the agent in one sees them: listing them, reading what
// was said in one, sending one a message and starting a new one. The host
// says what it can do: the terminal reads sessions from disk; the app also
// reaches the ones it has open, and can send to and start them. A message
// from another session arrives as a wake (src/agent/wakes.ts): it joins a
// running turn at its next step, or starts one, and is shown there whole,
// from whom. It's held when the user stops that session, and messages start
// or join at most so many turns an hour, which bounds two agents answering
// each other. The app remembers both per session while it runs (WakeMemory).

import { readFileSync, realpathSync, statSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import type { Message, UserMessage } from "../providers/types";
import type { PermissionMode } from "../permissions/modes";
import { redact } from "../util/redact";
import { findSessionAnywhere, listAllSessions, Session, sessionHolder } from "./session";
import type { WakeInput } from "./wakes";

/** How another session stands. */
export type PeerStatus = "working" | "waiting" | "idle" | "elsewhere";

export interface PeerSummary {
    id: string;
    title: string;
    cwd: string;
    status: PeerStatus;
    /** provider:model. */
    model?: string;
    /** When it last worked (ms). */
    updatedAt: number;
}

/**
 * What a send did: it started a turn, joins the running one (or the one coming) at its next step, waits for the user
 * (to answer that session, or to pick an account for it), waits for them to send it something (they stopped it), or
 * waits for the hour's limit on what wakes start and join.
 */
export type Delivery = "started" | "joined" | "held" | "waiting" | "limited";

export interface SessionPeers {
    /** This session's id: it's left out of listings, and can't be sent to. */
    readonly self: string;
    /** This session's folder: "this project" is its repository's. */
    readonly cwd: string;
    /** Newest first: the newest `limit` that `match` accepts (all, without one); `capped` when it stopped looking before finding them. */
    list(o: { limit: number; match?: (s: PeerSummary) => boolean }): { rows: PeerSummary[]; capped?: boolean };
    /** Its summary and messages, or undefined when there's no such session. */
    read(id: string): { summary: PeerSummary; messages: Message[] } | undefined;
    /** Missing where sessions can't be driven from here (the terminal). Throws PeerError. */
    send?(id: string, text: string): Promise<{ summary: PeerSummary; delivery: Delivery }>;
    /** A new session in this one's folder, given `prompt` as a message from this one. Throws PeerError. */
    start?(o: { prompt: string; title: string; model?: string }): Promise<PeerSummary>;
}

/** A refusal the model is told as it is. */
export class PeerError extends Error {}

export const PEER_LIMITS = {
    /** Longest message or first prompt. */
    maxMessage: 20_000,
    /** Most sessions listed. */
    maxList: 100,
    /** Turns read by default, and at most. */
    readTurns: 6,
    maxReadTurns: 50,
    /** What a read returns at most. */
    maxReadChars: 40_000,
    /** Session files read at most for one listing (newest first): under the session-head cache's size, so it isn't thrashed. */
    scan: 2_000,
};

// ---------------------------------------------------------------------------
// Projects: a repository's main checkout and its worktrees are one project.

function real(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/**
 * The folder that names a session's project: its repository's main checkout (a worktree's `.git` file points into
 * it), or the folder itself outside one. Read from the files, so no git runs.
 */
/** Folders' projects, kept across listings (a repository's layout seldom changes): bounded, the oldest go first. */
const projects = new Map<string, string>();
const MAX_PROJECTS = 5_000;

export function projectOf(cwd: string, cache: Map<string, string> = projects): string {
    // Real paths: git writes them in a worktree's .git file, and a folder opened through a link (macOS's /tmp) has another.
    const key = real(resolve(cwd));
    const hit = cache.get(key);
    if (hit) return hit;
    let found = key;
    for (let dir = key; ; ) {
        const dotGit = join(dir, ".git");
        let isDir: boolean | undefined;
        try {
            isDir = statSync(dotGit).isDirectory();
        } catch {
            // none here
        }
        if (isDir === true) {
            found = dir;
            break;
        }
        if (isDir === false) {
            found = dir;
            try {
                const gitdir = readFileSync(dotGit, "utf-8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
                const at = gitdir ? resolve(dir, gitdir).lastIndexOf(`${sep}.git${sep}worktrees${sep}`) : -1;
                if (gitdir && at >= 0) found = real(resolve(dir, gitdir).slice(0, at));
            } catch {
                // unreadable: the folder it's in
            }
            break;
        }
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    cache.set(key, found);
    if (cache === projects && projects.size > MAX_PROJECTS) projects.delete(projects.keys().next().value!);
    return found;
}

// ---------------------------------------------------------------------------
// Sessions on disk: what the terminal sees, and the app for sessions it hasn't open.

/** Sessions on disk: open in another process ("elsewhere") or not open at all. `self` and `cwd` are read when used: the terminal moves between sessions. */
export function diskPeers(self: () => string, cwd: () => string): SessionPeers {
    return {
        get self() {
            return self();
        },
        get cwd() {
            return cwd();
        },
        // Whether another process has it open is read only for the sessions listed.
        list: ({ limit, match }) => {
            let capped = false;
            const found = listAllSessions(limit, { match: match && ((s) => match({ ...s, status: "idle" })), maxRead: PEER_LIMITS.scan, capped: () => (capped = true) });
            return { rows: found.map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, status: sessionHolder(s.file) === undefined ? "idle" : "elsewhere", model: s.model, updatedAt: s.updatedAt })), capped };
        },
        read: (id) => readFromDisk(id),
    };
}

export function readFromDisk(id: string): { summary: PeerSummary; messages: Message[] } | undefined {
    const file = findSessionAnywhere(id);
    if (!file) return undefined;
    let s: Session;
    try {
        s = Session.peek(file);
    } catch {
        return undefined;
    }
    const first = s.messages.find(isTurnStart);
    const title = s.title ?? (first ? promptOf(first as UserMessage) : "(untitled)");
    let updatedAt = s.meta.createdAt;
    try {
        updatedAt = statSync(file).mtimeMs;
    } catch {
        // gone meanwhile
    }
    return { summary: { id, title: oneLine(title, 120), cwd: s.meta.cwd, status: sessionHolder(file) === undefined ? "idle" : "elsewhere", model: s.model, updatedAt }, messages: s.messages };
}

// ---------------------------------------------------------------------------
// What the model reads.

const REMINDERS = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function oneLine(s: string, max: number): string {
    const t = s.replace(REMINDERS, "").replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const STATUS_WORDS: Record<PeerStatus, string> = {
    working: "working",
    waiting: "waiting for the user",
    idle: "idle",
    elsewhere: "open in another Cavvy process (read only from here)",
};

function ago(ms: number, now: number): string {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86_400)}d ago`;
}

/** The listing: other sessions, this project's unless `all`, matching `query` (title or id), newest first. */
export function listText(peers: SessionPeers, o: { all?: boolean; query?: string; limit?: number }, now = Date.now()): { text: string; count: number } {
    const limit = Math.max(1, Math.min(Math.floor(o.limit ?? 20), PEER_LIMITS.maxList));
    const here = projectOf(peers.cwd);
    const q = o.query?.trim().toLowerCase();
    // Filtered as they're read, newest first: a search, or this project's, reads only until it has enough.
    const match = (s: PeerSummary) => s.id !== peers.self && (o.all || projectOf(s.cwd) === here) && (!q || s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
    const listed = peers.list({ limit, match });
    const rows = listed.rows.filter(match).slice(0, limit);
    // It stopped looking before it had enough: say so, not that there are no more.
    const looked = listed.capped ? ` (looked through the newest ${PEER_LIMITS.scan.toLocaleString("en-US")} sessions)` : "";
    const scope = o.all ? "in any project" : `in this project (${here})`;
    if (!rows.length) return { text: `No other sessions ${scope}${q ? ` matching "${o.query}"` : ""}${looked}.${o.all ? "" : " Pass all: true to list every project's."}`, count: 0 };
    const lines = rows.map((s) => {
        const where = real(s.cwd) === here ? "" : `  folder: ${s.cwd}`;
        return `${s.id}  “${redact(oneLine(s.title, 100))}”  ${STATUS_WORDS[s.status]}, ${ago(s.updatedAt, now)}${s.model ? `, ${s.model}` : ""}${where}`;
    });
    return { text: `Sessions ${scope}, newest first (this one left out)${looked}:\n${lines.join("\n")}`, count: rows.length };
}

const isTurnStart = (m: Message): boolean => m.role === "user" && [undefined, "prompt", "command", "wake", "summary"].includes(m.meta?.kind);

function promptOf(m: UserMessage): string {
    const first = m.content.find((p) => p.type === "text" && !p.text.startsWith("<system-reminder>"));
    return (m.meta?.display ?? (first?.type === "text" ? first.text : "")).replace(REMINDERS, "").trim();
}

/** Text quoted under a heading: its own lines that start with "#" are escaped, so it can't pass for another heading ("## User"). */
function quoted(text: string): string {
    return text.replace(/^(\s*)#/gm, "$1\\#");
}

/** One turn as the model reads it: who started it, what was said, and the tools used as one line. */
function turnText(msgs: Message[]): string {
    const head = msgs[0] as UserMessage;
    const kind = head.meta?.kind;
    const from = head.meta?.from;
    const label =
        kind === "summary" ? "Summary of the conversation before this point" : from ? `Message from session ${from.id} (“${oneLine(from.title, 80)}”)` : kind === "wake" ? "Event (not from the user)" : kind === "command" ? "User (command)" : "User";
    const out = [`## ${label}\n${quoted(kind === "summary" ? head.content.map((p) => (p.type === "text" ? p.text : "")).join("") : promptOf(head))}`];
    const said: string[] = [];
    const tools = new Map<string, number>();
    const flushTools = () => {
        if (!tools.size) return;
        said.push(`[used ${[...tools].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ")}]`);
        tools.clear();
    };
    const flushSaid = () => {
        flushTools();
        if (said.length) out.push(`## Assistant\n${said.splice(0).join("\n\n")}`);
    };
    for (const m of msgs.slice(1)) {
        // A message from another session that joined the turn, where it joined.
        if (m.role === "user") {
            if (m.meta?.peers?.length) flushSaid();
            for (const p of m.meta?.peers ?? []) out.push(`## Message from session ${p.from.id} (“${oneLine(p.from.title, 80)}”)\n${quoted(p.text)}`);
            continue;
        }
        for (const p of m.content) {
            if (p.type === "tool_call") tools.set(p.name, (tools.get(p.name) ?? 0) + 1);
            else if (p.type === "text" && p.text.trim()) {
                flushTools();
                said.push(quoted(p.text.trim()));
            }
        }
    }
    flushSaid();
    return out.join("\n\n");
}

/** What was said in a session: its last `turns` turns, newest kept whole when they're too long together. */
export function readText(found: { summary: PeerSummary; messages: Message[] }, o: { turns?: number }, now = Date.now()): { text: string; turns: number } {
    const want = Math.max(1, Math.min(Math.floor(o.turns ?? PEER_LIMITS.readTurns), PEER_LIMITS.maxReadTurns));
    const turns: Message[][] = [];
    for (const m of found.messages) {
        if (isTurnStart(m)) turns.push([m]);
        else turns.at(-1)?.push(m);
    }
    const s = found.summary;
    const head = `Session ${s.id} “${oneLine(s.title, 100)}”: ${STATUS_WORDS[s.status]}, last active ${ago(s.updatedAt, now)}${s.model ? `, ${s.model}` : ""}. Folder: ${s.cwd}.`;
    if (!turns.length) return { text: `${head}\nNothing has been said in it yet.`, turns: 0 };
    const picked: string[] = [];
    let size = 0;
    for (const t of turns.slice(-want).reverse()) {
        let text = turnText(t);
        const room = PEER_LIMITS.maxReadChars - size;
        if (picked.length && text.length > room) break;
        // The newest alone is too long: its start and its end, which has where it got to.
        if (text.length > room) text = `${text.slice(0, Math.floor(room / 3))}\n\n[… ${text.length - room} characters left out …]\n\n${text.slice(text.length - Math.floor((room * 2) / 3))}`;
        picked.unshift(text);
        size += text.length;
    }
    const earlier = turns.length - picked.length;
    const note = earlier ? `\n(${earlier} earlier turn${earlier === 1 ? "" : "s"} not shown: pass a larger turns, up to ${PEER_LIMITS.maxReadTurns}, to see more.)` : "";
    return { text: redact(`${head}${note}\n\n${picked.join("\n\n")}`), turns: picked.length };
}

// ---------------------------------------------------------------------------
// Messages between sessions.

/** The wake a message arrives as, in the session it's sent to. */
export function peerWake(from: { id: string; title: string }, text: string): WakeInput {
    const title = oneLine(from.title, 80);
    return {
        source: "session",
        key: `session:${from.id}`,
        label: `Message from “${title}”`,
        text: `From session ${from.id} (“${title}”):\n\n${text}\n\nTo answer, send a message to session ${from.id} (SendToSession, or send_to_session among Cavvy's tools). Answer only when there's something it needs: not to acknowledge.`,
        from: { id: from.id, title },
        message: text,
    };
}

/** Modes from least to most free: a session can't hand work to one that may do more without asking than it may. */
const MODE_RANK: Record<PermissionMode, number> = { plan: 0, default: 1, acceptEdits: 2, auto: 3, bypassPermissions: 4 };

export function freerMode(target: PermissionMode, than: PermissionMode): boolean {
    return MODE_RANK[target] > MODE_RANK[than];
}

/** The less free of two modes: a session another starts gets no more than its starter has. */
export function narrowerMode(a: PermissionMode, b: PermissionMode): PermissionMode {
    return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}

/** A message or first prompt as it may be sent, or why not. */
export function checkMessage(text: unknown, what = "message"): string {
    if (typeof text !== "string" || !text.trim()) throw new PeerError(`${what} must be a non-empty string.`);
    if (text.length > PEER_LIMITS.maxMessage) throw new PeerError(`${what} must be at most ${PEER_LIMITS.maxMessage} characters.`);
    return text.trim();
}

export function deliveryText(s: PeerSummary, d: Delivery): string {
    const to = `Sent to session ${s.id} (“${oneLine(s.title, 80)}”).`;
    if (d === "started") return `${to} It was idle: it's working on it now. Its answer, if it sends one, arrives as a message here.`;
    if (d === "joined") return `${to} It's working: it reads this at its next step.`;
    if (d === "held") return `${to} It's waiting for the user: it reads this once they've acted on it.`;
    if (d === "limited") return `${to} It has started as many turns for messages and events as it may this hour, so it reads this later.`;
    return `${to} The user stopped that session, so it reads this when they next send it something.`;
}
