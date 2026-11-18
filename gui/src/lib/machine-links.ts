// Connections from this window to the Cavvy on other machines, for their sessions opened here (state/app.ts
// activate): picking one doesn't load the window again on that machine, it's opened in this page over a connection of
// its own, kept for as long as the page (going back to it is then as quick as to any session already open). This
// computer's Cavvy says where each server's is and signs the window in there (servers.connect), as it does for a
// window on that server (lib/machines.ts).

import { Rpc, type Credentials } from "./rpc";
import { windowKey } from "./platform";
import { keepOwnTabs, keyOn, leaveTabs, takeLeftTabs } from "./terminal";
import type { ConnectResult } from "@shared/protocol";

/** Why a machine's Cavvy couldn't be reached: what servers.connect said, when it didn't sign the window in. */
export type LinkProblem = { status: Exclude<ConnectResult["status"], "connected">; message: string };

/** A machine's name, or "" for this computer (a session of its, in a window on a server). */
const links = new Map<string, Rpc>();
/** The last time each couldn't be reached, until it is again. */
const problems = new WeakMap<Rpc, LinkProblem>();

/** Opening a session over a link failed: why, and what servers.connect said if it was that. */
export class LinkError extends Error {
    constructor(message: string, readonly problem?: LinkProblem) {
        super(message);
    }
}

function problemOf(name: string, r: Exclude<ConnectResult, { status: "connected" }>): LinkProblem {
    switch (r.status) {
        case "failed": return { status: r.status, message: `Couldn't reach ${name}: ${r.problem.message}` };
        case "unknown-host": return { status: r.status, message: `${name}'s host key isn't trusted yet.` };
        case "other-version": return { status: r.status, message: `${name} runs another version of Cavvy.` };
        case "stopped": return { status: r.status, message: `Cavvy is stopped on ${name}.` };
    }
}

/**
 * The connection to `name`'s Cavvy (undefined: this computer's), made the first time it's asked for. `via`: this
 * computer's Cavvy, which gives the address and the sign-in; `own`: the connection to this computer's Cavvy, when the
 * window is on a server (that one is used for this computer's sessions as it is). `heard`: what it says, as it says it.
 *
 * It's asked for as a connection trying again by itself (`retry`) each time, a click included: a server stopped or
 * disconnected on purpose stays so (lib/machines.ts asks the user before starting it), and one that can't be reached
 * is tried again, as the window's own connection is, until it can.
 */
export function linkTo(name: string | undefined, via: Rpc, own: Rpc | undefined, heard: (e: Parameters<Parameters<Rpc["onEvent"]>[0]>[0], link: Rpc) => void): Rpc {
    if (name === undefined && own) return own;
    const key = name ?? "";
    let link = links.get(key);
    if (link) return link;
    /** A sign-in was given and hasn't opened anything yet: the next one asked for is a new one (a restart there, an expiry). */
    let unproven = false;
    const credentials = async (): Promise<Credentials | undefined> => {
        if (name === undefined) return undefined;
        const r = await via.call("servers.connect", { name, link: true, retry: true, ...(unproven ? { renew: true } : {}) });
        if (r.status !== "connected") {
            const problem = problemOf(name, r);
            problems.set(made, problem);
            throw new LinkError(problem.message, problem);
        }
        problems.delete(made);
        unproven = true;
        return { url: r.url, token: r.token };
    };
    // A server's shells left by a window that went are this window's now, under that window's key (lib/terminal.ts).
    if (name) takeLeftTabs(name, windowKey);
    link = new Rpc(credentials, name ? () => keyOn(name, windowKey) : windowKey);
    const made = link;
    made.retriesCredentials = true;
    made.onState((s) => { if (s === "open") unproven = false; });
    made.onEvent((e) => heard(e, made));
    links.set(key, made);
    void made.connect();
    return made;
}

/** Why the connection couldn't be made the last time it was tried, until it's made. */
export function linkProblem(link: Rpc): LinkProblem | undefined {
    return problems.get(link);
}

/** The connection already made to that machine, if there is one. */
export function linkOf(name: string | undefined): Rpc | undefined {
    return links.get(name ?? "");
}

/** Every connection made to another machine. */
export function allLinks(): Rpc[] {
    return [...links.values()];
}

/** Let go of the connection to that machine (nothing of it is open here, and it couldn't be reached). */
export function dropLink(name: string | undefined) {
    const link = links.get(name ?? "");
    if (!link) return;
    links.delete(name ?? "");
    link.close();
}

/**
 * Once it's open (now, when it is). Waiting to try again (it couldn't be reached), it's tried now: the user asked.
 * Rejected as soon as that try fails, with why, rather than after every try it makes by itself.
 */
export function opened(link: Rpc): Promise<void> {
    if (link.state === "open") return Promise.resolve();
    if (link.idle) link.reconnectNow();
    return new Promise((resolve, reject) => {
        const off = link.onState((s) => {
            if (s === "open") {
                off();
                resolve();
            } else if (s !== "connecting") {
                off();
                const problem = problems.get(link);
                reject(new LinkError(problem?.message ?? "Couldn't reach that machine's Cavvy.", problem));
            }
        });
    });
}

// A window that goes (closed, or the app quitting) leaves word of its shells on servers for the next one.
// Back after a reload, it keeps what it left itself.
if (typeof window !== "undefined") {
    keepOwnTabs(windowKey);
    window.addEventListener?.("pagehide", () => leaveTabs(windowKey));
}
