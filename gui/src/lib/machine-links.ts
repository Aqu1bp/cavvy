// Connections from this window to the Cavvy on other machines, for their sessions opened here (state/app.ts
// activate): picking one doesn't load the window again on that machine, it's opened in this page over a connection of
// its own, kept for as long as the page (going back to it is then as quick as to any session already open). This
// computer's Cavvy says where each server's is and signs the window in there (servers.connect), as it does for a
// window on that server (lib/machines.ts).

import { Rpc, type Credentials } from "./rpc";
import { windowKey } from "./platform";

/** A machine's name, or "" for this computer (a session of its, in a window on a server). */
const links = new Map<string, Rpc>();

/**
 * The connection to `name`'s Cavvy (undefined: this computer's), made the first time it's asked for. `via`: this
 * computer's Cavvy, which gives the address and the sign-in; `own`: the connection to this computer's Cavvy, when the
 * window is on a server (that one is used for this computer's sessions as it is). `heard`: what it says, as it says it.
 */
export function linkTo(name: string | undefined, via: Rpc, own: Rpc | undefined, heard: (e: Parameters<Parameters<Rpc["onEvent"]>[0]>[0], link: Rpc) => void): Rpc {
    if (name === undefined && own) return own;
    const key = name ?? "";
    let link = links.get(key);
    if (link) return link;
    const credentials = async (): Promise<Credentials | undefined> => {
        if (name === undefined) return undefined;
        const r = await via.call("servers.connect", { name });
        if (r.status !== "connected") throw new Error(r.status === "failed" ? r.problem.message : `${name}: ${r.status}`);
        return { url: r.url, token: r.token };
    };
    link = new Rpc(credentials, windowKey);
    const made = link;
    made.onEvent((e) => heard(e, made));
    links.set(key, made);
    void made.connect();
    return made;
}

/** The connection already made to that machine, if there is one. */
export function linkOf(name: string | undefined): Rpc | undefined {
    return links.get(name ?? "");
}

/** Once it's open (now, when it is). */
export function opened(link: Rpc): Promise<void> {
    if (link.state === "open") return Promise.resolve();
    return new Promise((resolve, reject) => {
        const off = link.onState((s) => {
            if (s === "open") {
                off();
                resolve();
            } else if (s === "unauthorized" || s === "unavailable") {
                off();
                reject(new Error("Couldn't reach that machine's Cavvy."));
            }
        });
    });
}
