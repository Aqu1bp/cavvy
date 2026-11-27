// The user's servers as this computer's Cavvy lists them, for the parts of a window that aren't the Machines menu
// (Settings → Providers says what each still lacks: lib/server-needs.ts). Asked for when something shows it, and
// again after what changes it: nothing polls.
//
// Loaded with the servers' own code (components/Servers.tsx, which hands it on): nothing that starts with the
// window imports this, so a window without servers doesn't carry it.

import { createSignal } from "solid-js";
import type { ServerSummary } from "@shared/protocol";
import { homeRpc } from "../lib/machines";
import { machine, os } from "../lib/platform";
import { reportError, rpc, toast } from "./app";
import { terminalActions } from "./ui";

/** What the user's own machine is called beside its servers. */
export const HERE = os === "macos" ? "This Mac" : "This computer";

export const [serverList, setServerList] = createSignal<ServerSummary[]>([]);
/** The machine Settings → Providers shows: "" for the one the window is on. Kept while the window is, so coming back from a sign-in's terminal is coming back to the same machine. */
export const [providersOn, setProvidersOn] = createSignal("");
/** Counts up when something was done on a server from here that its providers follow: what shows them reads them again. */
export const [serverTouched, setServerTouched] = createSignal(0);

/** Only a window on the user's own computer: one on a server shows that server's own setup. */
export async function refreshServerList(): Promise<void> {
    if (machine) return;
    try {
        setServerList((await rpc.call("servers.list", {})).servers);
    } catch {
        // No list: nothing is said about servers.
    }
}

/** How many times the key switch was set, per server: an answer to an earlier setting isn't reported. */
const asked = new Map<string, number>();

/**
 * Turns key sync to a server on or off, and says how it went once the server has answered, not when the switch is
 * saved: off takes the keys away there, and a server that can't be reached still has them. It can be put back, so
 * nothing is asked first. `changed` runs whenever what a list shows of the server may have changed.
 */
export async function setKeySync(name: string, next: boolean, changed: () => void = () => {}): Promise<void> {
    const servers = homeRpc(rpc);
    const turn = (asked.get(name) ?? 0) + 1;
    asked.set(name, turn);
    const refresh = () => {
        changed();
        void refreshServerList();
    };
    try {
        await servers.call("servers.setSync", { name, syncSecrets: next });
        refresh();
        const r = (await servers.call("servers.sync", { name })).results[0];
        refresh();
        setServerTouched((n) => n + 1);
        // Switched again meanwhile: that one says how it stands.
        if (asked.get(name) !== turn) return;
        if (next) {
            if (r?.ok) toast(`Syncing API keys to ${name}`, "info");
            else toast(r?.error ?? `Couldn't sync ${name}`, "error");
        } else if (r?.keysLeft?.length) {
            toast(r.error ?? `Couldn't remove your API keys from ${name}`, "error");
        } else if (r && (r.ok || r.warnings?.length)) {
            // Answered, even with something else to say: the keys were dealt with.
            toast(`${name} no longer has your API keys`, "info", { label: "Undo", run: () => setKeySync(name, true, changed) });
        } else {
            toast(`Keys leave ${name} when it reconnects`, "warn");
        }
    } catch (e) {
        if (asked.get(name) === turn) reportError(e);
    }
}

/** A sign-in on a server ended: it's asked how it stands now, and the list follows. */
export async function serverSignedIn(name: string): Promise<void> {
    if (machine) return;
    await rpc.call("servers.sync", { name }).catch(() => undefined);
    await refreshServerList();
    setServerTouched((n) => n + 1);
}

terminalActions.serverSignedIn = (name) => void serverSignedIn(name);
