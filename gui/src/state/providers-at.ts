// The machine Settings → Providers is showing: the one the window is on, or one of the user's servers, read and
// changed over a connection of this window's own to the Cavvy there (lib/machine-links.ts). The rows are the same
// either way: they ask this for where to call, and what to read again after a change.

import { createContext, useContext } from "solid-js";
import type { ProviderInfo } from "@shared/protocol";
import type { Rpc } from "../lib/rpc";
import { app, refreshModels, refreshProviders, refreshSettings, rpc } from "./app";

export interface ProvidersAt {
    /** The server's name; left out for the machine the window is on. */
    server?: string;
    link: Rpc;
    list: () => readonly ProviderInfo[];
    /** Reads its providers again. */
    refresh: () => Promise<void>;
    /** After a change to them: its providers, and what else of the window follows from them. */
    changed: () => Promise<void>;
}

const own: ProvidersAt = {
    link: rpc,
    list: () => app.providers,
    refresh: refreshProviders,
    changed: async () => void (await Promise.all([refreshProviders(), refreshModels(), refreshSettings()])),
};

export const ProvidersAtContext = createContext<ProvidersAt>(own);
export const useProvidersAt = () => useContext(ProvidersAtContext);
