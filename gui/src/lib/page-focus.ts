// The keyboard stays where the person has it while the agent works in a Browser page (the desktop app).
//
// The page is a real one (BrowserHostLayer's <webview>), and a real page takes the window's focus when something in it
// is pressed or focused, whoever did it: the agent clicking a button took the keyboard from the message box or the
// terminal, and what the person went on typing went to the page (and pressed its buttons). So when a page takes focus
// just after the agent acted on it, and the person hasn't used the page since, focus goes back to where it was. The
// page still has its own focus (the server keeps it as a focused page: src/browser/page.ts), so the agent's next keys
// reach the field it clicked.
//
// The app says when the agent acts on a tab and when the person uses one (desktop-electron/src/browser-host.ts).
// Loaded only where there are such pages (BrowserHostLayer.tsx).

import type { ElectronBridge } from "./platform";

/** A page taking focus this long after the agent last acted on it is the agent's doing. */
export const AGENT_FOCUS_MS = 500;
/** Sent back, and then the app says the person pressed in the page after all: it's theirs, if that comes this soon. */
export const PERSON_AFTER_MS = 250;

/** The page of a tab took focus at `now`: was that the agent's doing (it acted last, and just now)? */
export function agentTookFocus(now: number, agentAt: number | undefined, personAt: number | undefined): boolean {
    return agentAt !== undefined && now - agentAt <= AGENT_FOCUS_MS && !(personAt !== undefined && personAt >= agentAt);
}

/**
 * Watches for a page taking the window's focus. The window hears of it as a `blur` of its own, with the page's
 * <webview> its active element by then; the element the person was in has just lost focus to nothing in the document.
 * Returns how to stop.
 */
export function keepFocus(bridge: Pick<ElectronBridge, "onBrowser">, win: Window = window): () => void {
    const doc = win.document;
    const tabs = new Map<string, { agent?: number; person?: number }>();
    let sentBack: { key: string; view: HTMLElement; at: number } | undefined;
    /** What last lost focus to nothing else in the document: where the person was, if a page took it. */
    let left: HTMLElement | undefined;
    const off = bridge.onBrowser((e) => {
        if (e.type === "destroy") tabs.delete(e.key);
        if (e.type !== "agent" && e.type !== "person") return;
        const now = performance.now();
        const tab = tabs.get(e.key) ?? {};
        tabs.set(e.key, tab);
        if (e.type === "agent") return void (tab.agent = now);
        tab.person = now;
        // Their press and the agent's came together, and the page's focus was heard of before their press was.
        if (sentBack?.key === e.key && now - sentBack.at <= PERSON_AFTER_MS && sentBack.view.isConnected) sentBack.view.focus();
        sentBack = undefined;
    });
    const focusOut = (e: FocusEvent) => {
        left = !e.relatedTarget && e.target instanceof HTMLElement ? e.target : undefined;
    };
    const focusIn = () => {
        left = undefined;
    };
    const blurred = (e: Event) => {
        const view = doc.activeElement;
        if (e.target !== win || !(view instanceof HTMLElement) || view.tagName !== "WEBVIEW" || !view.dataset.key) return;
        const tab = tabs.get(view.dataset.key);
        const now = performance.now();
        if (!agentTookFocus(now, tab?.agent, tab?.person)) return;
        sentBack = { key: view.dataset.key, view, at: now };
        if (left?.isConnected) left.focus();
        else view.blur();
    };
    doc.addEventListener("focusout", focusOut, true);
    doc.addEventListener("focusin", focusIn, true);
    win.addEventListener("blur", blurred, true);
    return () => {
        off();
        doc.removeEventListener("focusout", focusOut, true);
        doc.removeEventListener("focusin", focusIn, true);
        win.removeEventListener("blur", blurred, true);
    };
}
