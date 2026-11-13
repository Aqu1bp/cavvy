// The Simulator pane's connection for a session on a server that uses this computer's Simulator (lib/lent.ts): a
// connection to this computer's Cavvy, which knows that session by the id of its own session for it. The pane goes
// on speaking of the session it shows; ids are changed on the way out and back.

import type { SimulatorState } from "@shared/protocol";
import type { SimStream } from "../state/simulator";

export function lentStream(
    s: SimStream,
    o: {
        /** The session the pane shows (on the server). */
        session: () => string;
        /** This computer's session for it, once there is one. */
        guest: () => string | undefined;
        /** Has this computer make one (the user started or chose a device before the session's agent used the simulator); undefined: it lends none now. */
        open: (session: string) => Promise<string | undefined>;
        /** Where the session's simulator would stand, while this computer has none for it. */
        outlook: (session: string) => Promise<SimulatorState>;
        /** There's none to be had: what the pane shows instead. */
        none: (session: string, state: SimulatorState) => void;
    },
): SimStream {
    return {
        get state() {
            return s.state;
        },
        connect: () => s.connect(),
        close: () => s.close(),
        onState: (fn) => s.onState(fn),
        // The state comes over the window's own connection to this computer, as it does for a session here.
        onEvent: () => () => {},
        onSimulatorFrame: (fn) => s.onSimulatorFrame((f) => (f.sessionId === o.guest() ? fn({ ...f, sessionId: o.session() }) : undefined)),
        notify: (method, params) => {
            const id = o.guest();
            if (id) s.notify(method, { ...params, id } as never);
        },
        call: (async (method: string, params: object) => {
            const at = o.session();
            let id = o.guest();
            if (!id) {
                // Nothing is made on this computer for a session that's only looked at: the pane shows what could be
                // started, and there's one once the user starts or chooses a device (or the session's agent uses one).
                if (method === "simulator.watch") return o.outlook(at);
                if (method !== "simulator.command") return null;
                const none = (error: string): SimulatorState => {
                    const state: SimulatorState = { status: "unavailable", error, devices: [] };
                    o.none(at, state);
                    return state;
                };
                try {
                    id = await o.open(at);
                } catch (e) {
                    none((e as Error).message);
                    throw e;
                }
                if (!id) return none("This Mac's Simulator isn't available now.");
            }
            return (s.call as (m: string, p: object) => Promise<unknown>)(method, { ...params, id });
        }) as SimStream["call"],
    };
}
