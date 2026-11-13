// A session on a server that uses this computer's Simulator: in a window that's on that server, the Simulator pane
// of that session shows it, and what this computer asks before it does something for that session shows in the
// session's own chat. Both are this computer's own Cavvy's (src/server/engine.ts, offers.session): the pane's
// pictures and the user's answers go to it directly, never through the server.
//
// Part of the servers code (loaded with components/Servers.tsx): it puts itself where the window asks for a
// session's simulator (state/simulator.ts) and answers what's asked (state/actions.ts).

import { createEffect, createRoot, on } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { LentSession, SessionSummary, SimulatorState } from "@shared/protocol";
import { lentStream } from "./lent-stream";
import { home } from "./machines";
import { machine } from "./platform";
import type { Rpc } from "./rpc";
import { far } from "../state/actions";
import { app, others, rpc, upsertSession } from "../state/app";
import { adoptSimulatorState, sim } from "../state/simulator";

/** What this computer has for each session of this window's server, by the session's id there. */
const [lent, setLent] = createStore<Record<string, LentSession | undefined>>({});
/** The session there that each session here lends to. */
const sessionOf = new Map<string, string>();
/** The server's sessions have simulators of their own (it's a Mac): this computer's aren't shown for them. */
let ownSimulators = false;

function took(session: string, l: LentSession) {
    const before = lent[session]?.id;
    if (before && before !== l.id) sessionOf.delete(before);
    if (l.id) sessionOf.set(l.id, session);
    setLent(session, reconcile(l));
}

function ask(h: Rpc, session: string, open = false): Promise<LentSession> {
    const title = app.sessions.find((s) => s.id === session)?.title;
    return h.call("offers.session", { name: machine!, sessionId: session, ...(title ? { title } : {}), ...(open ? { open } : {}) }).then((l) => {
        took(session, l);
        return l;
    });
}

/** Where the session's simulator stands: the server's own if it has any, else this computer's for that session. */
async function state(h: Rpc, session: string): Promise<SimulatorState> {
    const own = await rpc.call("simulator.state", { id: session });
    if (own.status !== "unavailable") {
        ownSimulators = true;
        return own;
    }
    return lentState(h, await ask(h, session), own);
}

const NONE: SimulatorState = { status: "unavailable", devices: [] };
/** The simulator of a session as this computer has it: its own session's for it, else what could be started. */
const lentState = (h: Rpc, l: LentSession, none = NONE): Promise<SimulatorState> | SimulatorState => (!l.offered ? none : l.id ? h.call("simulator.state", { id: l.id }) : (l.state ?? none));

if (home && machine) {
    const h = home;
    sim.state = (id) => state(h, id);
    sim.stream = (session) =>
        ownSimulators
            ? rpc.browserStream()
            : lentStream(h.browserStream(), { session, guest: () => lent[session()]?.id, open: async (at) => (await ask(h, at, true)).id, outlook: async (at) => lentState(h, await ask(h, at)), none: adoptSimulatorState });
    far.rpc = (id) => (sessionOf.has(id) ? h : undefined);
    far.asks = (session) => {
        const l = lent[session];
        return l?.id && l.asks.length ? { id: l.id, items: l.asks } : undefined;
    };
    // A session this computer asks something for waits for the user, though the server it's on doesn't know it: its
    // row says so, over what the server last said of it (kept, for when the asking is over).
    const said = new Map<string, SessionSummary>();
    others.shown = (s) => {
        if (lent[s.id]) said.set(s.id, s);
        return lent[s.id]?.asks.length && s.status !== "waiting" ? { ...s, status: "waiting", waitingKind: "permission" } : s;
    };
    /** Its row in the list, as it stands now. */
    const row = (session: string) => {
        const s = said.get(session) ?? app.sessions.find((x) => x.id === session);
        if (s) upsertSession(others.shown!(s));
    };
    h.onEvent((e) => {
        if (e.type === "offers.session" && e.name === machine) {
            // Read before the new one is taken in: the store's object is the same one after.
            const hadId = lent[e.sessionId]?.id;
            const asked = Boolean(lent[e.sessionId]?.asks.length);
            took(e.sessionId, e.lent);
            if (asked !== Boolean(e.lent.asks.length)) row(e.sessionId);
            // The session's simulator came to be (its agent used it), or is no more: the pane and its tab follow.
            if (e.lent.id !== hadId) void (e.lent.id ? Promise.resolve(e.lent) : ask(h, e.sessionId)).then((l) => lentState(h, l)).then((s) => adoptSimulatorState(e.sessionId, s), () => undefined);
        } else if (e.type === "simulator.state") {
            const session = sessionOf.get(e.sessionId);
            if (session) adoptSimulatorState(session, e.state);
        }
    });
    // What the session on screen waits for here is asked for when it's opened, and again when this computer's Cavvy
    // comes back: an ask made while the window was away is still there to answer.
    const again = () => {
        const id = app.activeId;
        if (!id || h.state !== "open" || ownSimulators) return;
        void ask(h, id)
            .then((l) => (row(id), lentState(h, l)))
            .then((s) => adoptSimulatorState(id, s), () => undefined);
    };
    /** Every session of this server that this computer asks something for now: their rows say so, whichever is open. */
    const asking = () =>
        void h.call("offers.asking", { name: machine! }).then((list) => {
            for (const a of list) {
                took(a.sessionId, a.lent);
                row(a.sessionId);
            }
        }, () => undefined);
    createRoot(() => createEffect(on(() => app.activeId, again)));
    h.onState((s) => s === "open" && (again(), asking()));
    if (h.state === "open") asking();
}
