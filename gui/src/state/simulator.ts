// What the window knows of each session's simulator: its device and whether it runs (kept current by the server's
// simulator.state events), and whether the agent used it while the Simulator pane wasn't in view.

import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { SimulatorState } from "@shared/protocol";
import { AGENT_ACTIVE_MS } from "../lib/simulator";
import { app, rpc, toast } from "./app";
import { setPrefs } from "./prefs";
import { setInspectorPane } from "./ui";

const [states, setStates] = createStore<Record<string, SimulatorState | undefined>>({});
/** Sessions whose agent used the simulator while the pane wasn't showing, until it's looked at. */
const [unseen, setUnseen] = createStore<Record<string, boolean | undefined>>({});
const [shown, setShown] = createSignal<ReadonlySet<string>>(new Set());

export const simulatorState = (id: string): SimulatorState | undefined => states[id];
export const simulatorUnseen = (id: string): boolean => unseen[id] === true;
/** Whether this Mac has simulators for the session to use (the tab shows only then). */
export const simulatorOffered = (id: string): boolean => {
    const s = states[id];
    return s !== undefined && s.status !== "unavailable";
};

/** The Simulator pane of this session is on screen (or no longer is). */
export function setSimulatorShown(id: string, on: boolean) {
    setShown((s) => {
        const next = new Set(s);
        if (on) next.add(id);
        else next.delete(id);
        return next;
    });
    if (on) setUnseen(id, undefined);
}

export function adoptSimulatorState(id: string, state: SimulatorState) {
    changed(id, state);
}

/** Reads where the session's simulator stands. */
export async function loadSimulatorState(id: string): Promise<void> {
    adoptSimulatorState(id, await rpc.call("simulator.state", { id }));
}

/** Shows the Simulator pane: the panel open, on its tab. */
export function showSimulator() {
    setPrefs("panel", true);
    setInspectorPane("simulator");
}

function changed(id: string, state: SimulatorState) {
    // Read before the store takes the new state: its old object then reads the new values.
    const known = states[id] !== undefined;
    const lastAgentAt = states[id]?.agentAt;
    setStates(id, reconcile(state));
    // The agent did something on it since the window last heard, or just now in a session it hadn't heard of.
    const acted = state.agentAt !== undefined && state.agentAt !== lastAgentAt && (known || Date.now() - state.agentAt < AGENT_ACTIVE_MS);
    if (!acted || shown().has(id) || unseen[id]) return;
    setUnseen(id, true);
    // Told once, in the session on screen: not pulled to it.
    if (app.activeId === id) toast("The agent is using the simulator.", "info", { label: "Show", run: showSimulator });
}

rpc.onEvent((e) => {
    if (e.type === "simulator.state") changed(e.sessionId, e.state);
});
