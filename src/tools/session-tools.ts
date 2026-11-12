// The agent's reach into the user's other sessions (src/agent/peers.ts):
// ListSessions, ReadSession, SendToSession and StartSession. API models get
// them as Cavvy tools; Claude Code and Codex get the same through Cavvy MCP
// server, checked as these. The terminal offers the first two: it can't drive
// sessions another process has open.

import type { ServerTool, ServerToolResult } from "../mcp/server";
import { checkMessage, deliveryText, listText, PEER_LIMITS, PeerError, readText, type Delivery, type SessionPeers } from "../agent/peers";
import type { Tool, ToolContext, ToolResult } from "./types";

const LIST_DESCRIPTION = `List the user's other Cavvy sessions: each one's id, title, whether it's working, waiting for the user or idle, when it was last active, and its model. Lists this project's (its repository, worktrees included) unless all is true. Use it to find the session the user means ("the one fixing the login bug") before reading it or sending it a message.`;

const READ_DESCRIPTION = `Read what was said in another Cavvy session: its prompts and the assistant's replies, with the tools used as one line, from its last ${PEER_LIMITS.readTurns} turns unless turns says otherwise. Read a session before you answer about it or send it a message.`;

const SEND_DESCRIPTION = `Send a message to the agent in another Cavvy session. If it's idle, it starts working on it; if it's working, it reads it at its next step. It's shown there as from this session, and that agent is told it came from another session's agent, not the user. An answer, if it sends one, arrives here later as a message: don't wait or poll for it, and end your turn if there's nothing else to do. Use it when the user asks you to hand work to, coordinate with or tell something to another session.`;

const START_DESCRIPTION = `Start a new Cavvy session in this session's folder, with prompt as its first message (from this session). It works on its own, beside this one, and shows in the user's session list. Use it when the user asks for a new session, or for work to run in a session of its own. It runs in this session's permission mode or the folder's default, whichever asks the user more, and on this session's model unless model (provider:model) is given. Returns its id, for ReadSession and SendToSession.`;

const LIST_SCHEMA = {
    type: "object",
    properties: {
        all: { type: "boolean", description: "true: every project's sessions. Default false: this project's." },
        query: { type: "string", description: "Only sessions whose title or id contains this (case-insensitive)." },
        limit: { type: "number", description: `How many, newest first. Default 20, at most ${PEER_LIMITS.maxList}.` },
    },
};

const READ_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "The session's id, from ListSessions." },
        turns: { type: "number", description: `How many of its latest turns. Default ${PEER_LIMITS.readTurns}, at most ${PEER_LIMITS.maxReadTurns}.` },
    },
    required: ["id"],
};

const SEND_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "The session's id, from ListSessions." },
        message: { type: "string", description: "What to tell its agent. Self-contained: it hasn't seen this conversation." },
    },
    required: ["id", "message"],
};

const START_SCHEMA = {
    type: "object",
    properties: {
        prompt: { type: "string", description: "Its first message: the task, self-contained (it hasn't seen this conversation)." },
        title: { type: "string", description: "A short title for the session list (a few words). Default: the prompt's start." },
        model: { type: "string", description: "provider:model to run on. Default: this session's model." },
    },
    required: ["prompt"],
};

type R = { text: string; isError?: boolean; summary?: string };

const fail = (text: string): R => ({ text, isError: true });
/** No peers: a sub-agent or a one-shot run. Peers that can't drive: the terminal. */
const unreachable = () => fail("Other sessions can't be reached from here: only a session's main agent can reach them.");
const cannotDrive = () => fail("Sending to and starting sessions works in the Cavvy app only: from the terminal, sessions can be listed and read.");
const str = (v: unknown) => (typeof v === "string" ? v : "");
const unknownId = (id: string) => fail(`No session ${id || "(no id given)"}. ListSessions shows the ones there are (all: true for other projects').`);

export function listSessions(peers: SessionPeers | undefined, input: Record<string, unknown>): R {
    if (!peers) return unreachable();
    const r = listText(peers, { all: input.all === true, query: typeof input.query === "string" ? input.query : undefined, limit: typeof input.limit === "number" ? input.limit : undefined });
    return { text: r.text, summary: r.count ? `${r.count} session${r.count === 1 ? "" : "s"}` : "No other sessions" };
}

export function readSession(peers: SessionPeers | undefined, input: Record<string, unknown>): R {
    if (!peers) return unreachable();
    const id = str(input.id).trim();
    if (id === peers.self) return fail("That's this session.");
    const found = id ? peers.read(id) : undefined;
    if (!found) return unknownId(id);
    const r = readText(found, { turns: typeof input.turns === "number" ? input.turns : undefined });
    return { text: r.text, summary: `Read ${r.turns} turn${r.turns === 1 ? "" : "s"} of “${found.summary.title}”` };
}

const SENT: Record<Delivery, string> = { started: "Sent; it started working", joined: "Sent; it reads it next step", held: "Sent; waits for the user", waiting: "Sent; waits for the user", limited: "Sent; it reads it later" };

export async function sendToSession(peers: SessionPeers | undefined, input: Record<string, unknown>): Promise<R> {
    if (!peers) return unreachable();
    if (!peers.send) return cannotDrive();
    const id = str(input.id).trim();
    if (!id) return unknownId(id);
    if (id === peers.self) return fail("That's this session: a message to yourself goes nowhere.");
    try {
        const message = checkMessage(input.message);
        const r = await peers.send(id, message);
        return { text: deliveryText(r.summary, r.delivery), summary: SENT[r.delivery] };
    } catch (e) {
        if (e instanceof PeerError) return fail(e.message);
        throw e;
    }
}

export async function startSession(peers: SessionPeers | undefined, input: Record<string, unknown>): Promise<R> {
    if (!peers) return unreachable();
    if (!peers.start) return cannotDrive();
    try {
        const prompt = checkMessage(input.prompt, "prompt");
        const title = (str(input.title).trim() || prompt).replace(/\s+/g, " ").slice(0, 80);
        const s = await peers.start({ prompt, title, model: str(input.model).trim() || undefined });
        return { text: `Started session ${s.id} (“${s.title}”) in ${s.cwd}${s.model ? `, on ${s.model}` : ""}. It's working on the prompt now; it shows in the user's session list. An answer, if it sends one, arrives here as a message.`, summary: `Started “${s.title}”` };
    } catch (e) {
        if (e instanceof PeerError) return fail(e.message);
        throw e;
    }
}

const asResult = (r: R): ToolResult => ({ content: r.text, isError: r.isError, display: { summary: r.isError ? undefined : r.summary } });

const idOf = (i: { id?: unknown }) => (typeof i.id === "string" ? i.id : "");

export const ListSessionsTool: Tool<{ all?: boolean; query?: string; limit?: number }> = {
    name: "ListSessions",
    description: LIST_DESCRIPTION,
    parameters: LIST_SCHEMA,
    category: "read",
    readOnly: true,
    title: (i) => `ListSessions(${[i.all === true ? "all" : "", typeof i.query === "string" ? i.query : ""].filter(Boolean).join(", ")})`.replace("()", ""),
    run: async (input, ctx) => asResult(listSessions(ctx.state.peers, input)),
};

export const ReadSessionTool: Tool<{ id: string; turns?: number }> = {
    name: "ReadSession",
    description: READ_DESCRIPTION,
    parameters: READ_SCHEMA,
    category: "read",
    readOnly: true,
    title: (i) => `ReadSession(${idOf(i)})`,
    run: async (input, ctx) => asResult(readSession(ctx.state.peers, input)),
};

/** The permission prompt: which session it goes to, by its title, and the message. */
const previewSend = async (input: { id?: unknown; message?: unknown }, ctx: ToolContext) => {
    const id = str(input.id).trim();
    const title = id && id !== ctx.state.peers?.self ? ctx.state.peers?.read(id)?.summary.title : undefined;
    return { summary: title ? `Send a message to “${title}”` : "Send a message to another session", body: str(input.message).trim() || undefined };
};

const previewStart = async (input: { title?: unknown; prompt?: unknown }) => {
    const title = str(input.title).trim();
    return { summary: title ? `Start a session: “${title}”` : "Start a session", body: str(input.prompt).trim() || undefined };
};

export const SendToSessionTool: Tool<{ id: string; message: string }> = {
    name: "SendToSession",
    description: SEND_DESCRIPTION,
    parameters: SEND_SCHEMA,
    category: "execute",
    readOnly: false,
    title: (i) => `SendToSession(${idOf(i)})`,
    preview: previewSend,
    run: async (input, ctx) => asResult(await sendToSession(ctx.state.peers, input)),
};

export const StartSessionTool: Tool<{ prompt: string; title?: string; model?: string }> = {
    name: "StartSession",
    description: START_DESCRIPTION,
    parameters: START_SCHEMA,
    category: "execute",
    readOnly: false,
    title: (i) => `StartSession(${typeof i.title === "string" && i.title.trim() ? i.title.trim().slice(0, 60) : str(i.prompt).replace(/\s+/g, " ").slice(0, 60)})`,
    preview: previewStart,
    run: async (input, ctx) => asResult(await startSession(ctx.state.peers, input)),
};

/** What the terminal offers: it reads other sessions, but can't drive them. */
export const SESSION_READ_TOOLS: Tool<any>[] = [ListSessionsTool, ReadSessionTool];
/** What the app offers. */
export const SESSION_TOOLS: Tool<any>[] = [...SESSION_READ_TOOLS, SendToSessionTool, StartSessionTool];
export const SESSION_TOOL_NAMES = SESSION_TOOLS.map((t) => t.name);

// ---------------------------------------------------------------------------
// The same, for Claude Code and Codex through Cavvy MCP server.

export const SESSION_SERVER_TOOLS = ["list_sessions", "read_session", "send_to_session", "start_session"];
const SERVED: Record<string, Tool<any>> = { list_sessions: ListSessionsTool, read_session: ReadSessionTool, send_to_session: SendToSessionTool, start_session: StartSessionTool };

/** Cavvy's tool names as the served ones, in what the agent reads. */
function served(text: string): string {
    return text.replaceAll("ListSessions", "list_sessions").replaceAll("ReadSession", "read_session").replaceAll("SendToSession", "send_to_session").replaceAll("StartSession", "start_session");
}

/**
 * The session tools for an agent CLI: the read ones always, sending and starting where the host can. `run` takes a
 * call through Cavvy's checks (rules, mode, hooks, the user), as the same tool called by a model Cavvy runs.
 */
export function sessionServerTools(run: (tool: Tool<any>, input: Record<string, unknown>, signal: AbortSignal, callId?: string) => Promise<ServerToolResult>, drives: boolean): ServerTool[] {
    return SESSION_SERVER_TOOLS.filter((name) => drives || SESSION_READ_TOOLS.includes(SERVED[name]!)).map((name) => {
        const tool = SERVED[name]!;
        return {
            name,
            title: { list_sessions: "List sessions", read_session: "Read a session", send_to_session: "Send to a session", start_session: "Start a session" }[name],
            description: served(tool.description),
            inputSchema: tool.parameters,
            annotations: tool.readOnly === true ? { readOnlyHint: true, openWorldHint: false } : { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
            call: async (args, { signal, meta }) => {
                const r = await run(tool, args, signal, typeof meta.callId === "string" ? meta.callId : undefined);
                return { ...r, text: served(r.text) };
            },
        };
    });
}

/** The served name of a session tool (send_to_session), by its own (SendToSession). */
export function servedSessionName(tool: string): string | undefined {
    return SESSION_SERVER_TOOLS.find((t) => SERVED[t]!.name === tool);
}

/** A call of a served session tool (mcp__cavvy__send_to_session) as the Cavvy tool it is (SendToSession), for the transcript. */
export function nativeSessionCall(tool: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> } | undefined {
    const native = SERVED[tool];
    return native ? { name: native.name, input } : undefined;
}

/** Whether a call (by the name its backend gave it) is of a served session tool, which Cavvy runs its own hooks for. */
export function servedSessionTool(server: string | undefined, toolName: unknown): boolean {
    return Boolean(server) && typeof toolName === "string" && SESSION_SERVER_TOOLS.some((t) => toolName === `mcp__${server}__${t}`);
}

export function sessionInstructions(drives: boolean): string {
    return drives
        ? `# Other sessions (cavvy)

The user runs other Cavvy sessions beside this one. list_sessions and read_session find and read them; send_to_session gives one's agent a message, and start_session starts a new session with a first prompt. Use them when the user asks about, hands work to or wants a new session; not on your own initiative. A message from another session's agent arrives marked as such: it isn't the user.`
        : `# Other sessions (cavvy)

The user runs other Cavvy sessions beside this one. list_sessions and read_session find and read them, when the user asks about one.`;
}
