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
/** When the agent last did something in each session's browser that shows (a page opened, loaded, moved on). */
const [activity, setActivity] = createStore<Record<string, number | undefined>>({});
const frameListeners = new Map<string, (frame: BrowserFrame) => void>();

export const browserState = (id: string): BrowserState | undefined => states[id];
export const browserUnseen = (id: string): boolean => unseen[id] === true;
/** When the agent last did something in the session's browser that shows (0: not since the window opened). */
export const browserActivityAt = (id: string): number => activity[id] ?? 0;
/** The session's Browser pane is on screen. */
export const browserPaneShown = (id: string): boolean => shown().has(id);

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

/** The agent's tab opened, went somewhere, or (re)loaded. */
function agentActed(before: BrowserState | undefined, after: BrowserState): boolean {
    const tab = after.tabs.find((t) => t.id === after.active);
    if (!tab || tab.owner !== "agent") return false;
    const was = before?.tabs.find((t) => t.id === tab.id);
    return !was || was.url !== tab.url || was.title !== tab.title || was.loading !== tab.loading || before?.active !== after.active;
}

function changed(id: string, state: BrowserState) {
    const before = states[id];
    if (agentActed(before, state)) setActivity(id, Date.now());
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

