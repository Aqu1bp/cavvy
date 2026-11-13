// A session on a server that uses this computer's Simulator: in a window that's on that server, the Simulator pane
// of that session shows it, and what this computer asks before it does something for that session shows in the
// session's own chat. Both are this computer's own Cavvy's (src/server/engine.ts, offers.session): the pane's
// pictures and the user's answers go to it directly, never through the server.
//
// Part of the servers code (loaded with components/Servers.tsx): it puts itself where the window asks for a
// session's simulator (state/simulator.ts) and answers what's asked (state/actions.ts).

import { createEffect, createRoot, on } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { LentSession, SimulatorState } from "@shared/protocol";
import { lentStream } from "./lent-stream";
import { home } from "./machines";
import { machine } from "./platform";
import type { Rpc } from "./rpc";
import { far } from "../state/actions";
import { app, rpc } from "../state/app";
import { adoptSimulatorState, sim } from "../state/simulator";

/** What this computer has for each session of this window's server, by the session's id there. */
const [lent, setLent] = createStore<Record<string, LentSession | undefined>>({});
/** The session there that each session here lends to. */
const sessionOf = new Map<string, string>();
/** The server's sessions have simulators of their own (it's a Mac): this computer's aren't shown for them. */
let ownSimulators = false;

/** Shown while this computer gets a session's simulator ready, before there's anything of it to show. */
const GETTING_READY: SimulatorState = { status: "booting", devices: [] };

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
    const l = await ask(h, session);
    if (!l.offered) return own;
    return l.id ? h.call("simulator.state", { id: l.id }) : GETTING_READY;
}

if (home && machine) {
    const h = home;
    sim.state = (id) => state(h, id);
    sim.stream = (session) =>
        ownSimulators
            ? rpc.browserStream()
            : lentStream(h.browserStream(), { session, guest: () => lent[session()]?.id, open: async (at) => (await ask(h, at, true)).id, none: adoptSimulatorState });
    far.rpc = (id) => (sessionOf.has(id) ? h : undefined);
    far.asks = (session) => {
        const l = lent[session];
        return l?.id && l.asks.length ? { id: l.id, items: l.asks } : undefined;
    };
    h.onEvent((e) => {
        if (e.type === "offers.session" && e.name === machine) {
            const had = lent[e.sessionId]?.id;
            took(e.sessionId, e.lent);
            // The session's simulator came to be (its agent used it), or is no more: the pane and its tab follow.
            if (e.lent.id && e.lent.id !== had) void h.call("simulator.state", { id: e.lent.id }).then((s) => adoptSimulatorState(e.sessionId, s), () => undefined);
            else if (!e.lent.id && had) adoptSimulatorState(e.sessionId, e.lent.offered ? GETTING_READY : { status: "unavailable", devices: [] });
        } else if (e.type === "simulator.state") {
            const session = sessionOf.get(e.sessionId);
            if (session) adoptSimulatorState(session, e.state);
        }
    });
    // What the session on screen waits for here is asked for when it's opened, and again when this computer's Cavvy
    // comes back: an ask made while the window was away is still there to answer.
    const again = () => {
        const id = app.activeId;
        if (id && h.state === "open" && !ownSimulators) void ask(h, id).catch(() => undefined);
    };
    createRoot(() => createEffect(on(() => app.activeId, again)));
    h.onState((s) => s === "open" && again());
}
