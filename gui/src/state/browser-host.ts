// The Electron desktop app's browser tabs (desktop-electron/src/browser-host.ts): each a <webview>, a real Chromium page
// kept by BrowserHostLayer for as long as the tab is open, and laid over the Browser pane's page box when a pane shows it.

import { createSignal } from "solid-js";

export interface HostedTab {
    /** The app's name for the webview. */
    key: string;
    partition: string;
}

export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Never replaced while open: a new object would be a new webview, and the page would be lost with the old one. */
export const [hostedTabs, setHostedTabs] = createSignal<HostedTab[]>([]);
/** The browser's own id for each tab (its targetId), by key, once the app knows it. */
export const [hostedTargets, setHostedTargets] = createSignal<Record<string, string>>({});
/**
 * Where a tab is on screen: the Browser pane's page box (the page takes the box's size, and the person uses it), or the
 * floating view over the chat (`fit`: the page keeps the agent's size, drawn scaled down into the box, to watch).
 * `by` says whose it is, so one going away doesn't take the other's.
 */
export interface Shown {
    targetId: string;
    box: Box;
    by: "pane" | "float";
    fit?: boolean;
}

export const [shownBrowser, setShownBrowser] = createSignal<Shown | undefined>();

/** `by` no longer shows a tab (if the slot is still its). */
export const unshowBrowser = (by: Shown["by"]) => setShownBrowser((s) => (s?.by === by ? undefined : s));
