// What the window knows of each session's browser: its tabs and who drives them (kept current by the server's
// browser.state events), the frames of the tab being watched, and whether the agent opened a page while the
// Browser pane wasn't in view.

import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { BrowserState, ServerEvent } from "@shared/protocol";
import { agentOpened } from "../lib/browser";
import { app, rpc, toast } from "./app";
import { setPrefs } from "./prefs";
import { setInspectorPane } from "./ui";

export type BrowserFrame = Extract<ServerEvent, { type: "browser.frame" }>;

const [states, setStates] = createStore<Record<string, BrowserState | undefined>>({});
/** Sessions whose agent opened a page while the pane wasn't showing, until it's looked at. */
const [unseen, setUnseen] = createStore<Record<string, boolean | undefined>>({});
const [shown, setShown] = createSignal<ReadonlySet<string>>(new Set());
const frameListeners = new Map<string, (frame: BrowserFrame) => void>();

export const browserState = (id: string): BrowserState | undefined => states[id];
export const browserUnseen = (id: string): boolean => unseen[id] === true;

/** The Browser pane of this session is on screen (or no longer is). */
export function setBrowserShown(id: string, on: boolean) {
    setShown((s) => {
        const next = new Set(s);
        if (on) next.add(id);
        else next.delete(id);
        return next;
    });
    if (on) setUnseen(id, undefined);
}

/** The frames of this session's tab, to `fn` (one pane at a time shows a session). Returns how to stop. */
export function onBrowserFrame(id: string, fn: (frame: BrowserFrame) => void): () => void {
    frameListeners.set(id, fn);
    return () => {
        if (frameListeners.get(id) === fn) frameListeners.delete(id);
    };
}

/** What a reply says of where the session's browser stands (the events keep it current after that). */
export function adoptBrowserState(id: string, state: BrowserState) {
    setStates(id, reconcile(state));
}

/** Reads where the session's browser stands. */
export async function loadBrowserState(id: string): Promise<void> {
    adoptBrowserState(id, await rpc.call("browser.state", { id }));
}

/** Shows the Browser pane: the panel open, on its tab. */
export function showBrowser() {
    setPrefs("panel", true);
    setInspectorPane("browser");
}

function changed(id: string, state: BrowserState) {
    const before = states[id];
    setStates(id, reconcile(state));
    if (!agentOpened(before, state) || shown().has(id)) return;
    setUnseen(id, true);
    // Told of where it happens, only in the session on screen: not pulled to it.
    if (app.activeId === id) toast("The agent opened a page in the browser.", "info", { label: "Show", run: showBrowser });
}

rpc.onEvent((e) => {
    if (e.type === "browser.state") changed(e.sessionId, e.state);
    else if (e.type === "browser.frame") frameListeners.get(e.sessionId)?.(e);
});

