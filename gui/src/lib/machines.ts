// A window on a server: how it reaches the Cavvy there. This computer's own Cavvy makes the connection (an SSH
// tunnel, and a sign-in on the server: src/servers/manager.ts) and says where it is; the window then talks to the
// server's Cavvy directly, as it talks to this computer's when it's on none.

import { createSignal } from "solid-js";
import type { ServerProblem, UnknownHost } from "@shared/protocol";
import { credentials, machine, MACHINE_KEY, windowKey } from "./platform";
import { Rpc, type Credentials } from "./rpc";
import { setConnNote } from "../state/app";

/** Why the window isn't on its server yet, for the cover that says so (components/Servers.tsx). */
export type MachineIssue =
    | { kind: "connecting"; text?: string; percent?: number }
    /** Its key isn't one this computer has seen: shown, and trusted only on the user's word. */
    | { kind: "unknown-host"; unknown: UnknownHost }
    /** The Cavvy there is another version than this one. */
    | { kind: "other-version" }
    /** Cavvy there was stopped on purpose: started again only when the user says. */
    | { kind: "stopped" }
    | { kind: "failed"; problem: ServerProblem };

const [issue, setIssue] = createSignal<MachineIssue | undefined>(machine ? { kind: "connecting" } : undefined);
export const machineIssue = issue;
/** Says where reaching the server stands. A failure is also said, in short, beside the window's "Reconnecting…". */
export function setMachineIssue(i: MachineIssue | undefined) {
    // Connected: the sign-in it was given works.
    if (!i) unproven = false;
    setIssue(i);
    const why = i?.kind === "failed" ? i.problem.message.replace(/\s+/g, " ").trim() : undefined;
    setConnNote(why && why.length > 70 ? `${why.slice(0, 69)}…` : why);
}

/** This computer's own Cavvy, for a window that's on a server; undefined for one that isn't (it's the window's own). */
export const home: Rpc | undefined = machine ? new Rpc(credentials, windowKey) : undefined;
if (home) {
    home.retriesCredentials = true;
    home.onEvent((e) => {
        if (e.type === "servers.progress" && e.name === machine && machineIssue()?.kind === "connecting") setMachineIssue({ kind: "connecting", text: e.text, percent: e.percent });
    });
    void home.connect();
}

function homeOpen(): Promise<void> {
    if (!home || home.state === "open") return Promise.resolve();
    return new Promise((resolve) => {
        const off = home.onState((s) => {
            if (s !== "open") return;
            off();
            resolve();
        });
    });
}

/** The user's yes to the key that was shown: sent with the next attempt, once. */
let trusted: string[] | undefined;
export function trustMachine(fingerprints: string[]) {
    trusted = fingerprints;
}

/**
 * Whether the next attempt is the user's asking (opening the server, Try again, Trust, Start) or the connection
 * trying again by itself, which must not start a server that was stopped on purpose.
 */
let asked = true;
export function userAsked() {
    asked = true;
}

/** A sign-in was handed to the window and it hasn't connected with it yet: handed the same one again, it'd fail again. */
let unproven = false;

/**
 * Where the server's Cavvy is, and what signs this window in there. Asked again each time the connection is made:
 * after a drop it's the same address while the tunnel held, and a new sign-in when the Cavvy there restarted.
 * Throws for a failure that may pass (tried again by itself); undefined when it needs the user (said in machineIssue).
 */
export async function machineCredentials(): Promise<Credentials | undefined> {
    if (!home || !machine) return undefined;
    await homeOpen();
    const trust = trusted;
    trusted = undefined;
    const retry = !asked;
    asked = false;
    const r = await home.call("servers.connect", { name: machine, ...(trust ? { trust } : {}), ...(retry ? { retry } : {}), ...(unproven ? { renew: true } : {}) });
    if (r.status === "connected") {
        unproven = true;
        return { url: r.url, token: r.token };
    }
    if (r.status === "unknown-host") setMachineIssue({ kind: "unknown-host", unknown: r.unknown });
    else if (r.status === "other-version") setMachineIssue({ kind: "other-version" });
    else if (r.status === "stopped") setMachineIssue({ kind: "stopped" });
    else {
        setMachineIssue({ kind: "failed", problem: r.problem });
        throw new Error(r.problem.message);
    }
    return undefined;
}

/** The Rpc that reaches this computer's own Cavvy: for the list of servers and what's done to them. */
export function homeRpc(own: Rpc): Rpc {
    return home ?? own;
}

/** Puts this window on a server, or back on this computer, and loads it again there. */
export function switchMachine(name: string | undefined) {
    try {
        if (name) sessionStorage.setItem(MACHINE_KEY, name);
        else sessionStorage.removeItem(MACHINE_KEY);
        // Where the window was (its session, its project) is the other machine's: here it would name nothing, or the wrong thing.
        sessionStorage.removeItem("cavvy.navigation");
    } catch {
        return;
    }
    location.reload();
}
