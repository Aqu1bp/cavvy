// The keyboard stays where the person has it while the agent works in a Browser page (the desktop app).
//
// The page is a real one (BrowserHostLayer's <webview>), and a real page takes the window's keyboard when something
// in it is pressed or focused, whoever did it: the agent clicking a button took the keys from the message box or the
// terminal, and what the person went on typing went to the page (and pressed its buttons). On macOS nothing in the
// window even shows it: the message box keeps its caret.
//
// So the app says when a tab's page holds the keyboard after something the agent did to it (`focused`), and when the
// person puts it in a page themselves, by a press in it or Tab into it (`person`): desktop-electron/src/browser-host.ts.
// Unless the person put the keyboard in that page themselves, it's taken back to where it was. The page keeps its own focus (the server keeps it as a
// focused page: src/browser/page.ts), so the agent's next keys still reach the field it clicked.
//
// Part of the pages' layer (BrowserHostLayer.tsx), which only the desktop app loads.

import type { ElectronBridge } from "./platform";

/** An element that lost focus to nothing else in the window this long ago is still where the person was. */
export const LEFT_MS = 2000;
/**
 * For this long after the app said a page held the keyboard for the agent, the page taking the window's focus again
 * is the same thing happening again (the page answers a press in several steps, each of which can take it).
 */
export const AGAIN_MS = 500;
/** The second step of taking the keyboard back comes at least this long after the first (below). */
export const STEP_MS = 30;
/** A press or a key of the person's this recently is what moved the window's focus, not the page. */
export const OWN_MS = 150;
/** After the first of two steps, the second is taken here if the app's word hasn't brought it by now (its last look is at 320ms). */
export const ENTERED_MS = 400;

/** What taking the keyboard back does next, for where the window's focus is now. */
export type Step<E> =
    /** The window's focus is in the page's element: move it to `to` (or just out of the page), and the keys follow. */
    | { do: "back"; to: E | undefined }
    /** The page has the keys though the window's focus isn't in it: put it there first, and remember where it was. */
    | { do: "enter"; from: E | undefined }
    /** Entered a moment ago: the page is still taking it. Wait for the app's next word. */
    | { do: "wait" };

/**
 * Taking the keyboard back from a page is one step where the window's focus went to the page with the keys (move it
 * back), and two where it didn't (macOS; or a page answering late, after it was taken back once): the window's focus
 * is still in the message box, focusing that again changes nothing, and the keys stay in the page. So first the
 * window's focus goes to the page too, and from there back. Not both at once: the page takes what it's given a
 * moment later, after the window has it back, and keeps the keys with the window showing otherwise.
 * `entered`: the first step taken for this page, with where the focus was and when; `left`: what lost focus to
 * nothing in the window just before.
 */
export function nextStep<E>(o: { active: E | null | undefined; page: E; body: E; left: E | undefined; entered: { from: E | undefined; at: number } | undefined; now: number }): Step<E> {
    if (o.active === o.page) {
        if (o.entered && o.now - o.entered.at < STEP_MS) return { do: "wait" };
        return { do: "back", to: o.entered?.from ?? o.left };
    }
    return { do: "enter", from: o.active && o.active !== o.body ? o.active : undefined };
}

/** Watches the pages' hold on the keyboard in `win`. Returns how to stop. */
export function keepFocus(bridge: Pick<ElectronBridge, "onBrowser">, win: Window = window, later: (fn: () => void, ms: number) => unknown = setTimeout): () => void {
    const doc = win.document;
    let stopped = false;
    /** The tab whose page the person put the keyboard in themselves (the app says so: a press in it, or Tab into it), until they're back in the window. */
    let theirs: string | undefined;
    /** What last lost focus to nothing else in the window, and when. */
    let left: { el: HTMLElement; at: number } | undefined;
    /** Where the person last put the window's focus themselves: where the keyboard goes back to when nothing says otherwise. */
    let home: HTMLElement | undefined;
    /** Taking the keyboard back moves the window's focus itself: not the person's doing. */
    let taking = false;
    /** The first of two steps taken for a tab's page. */
    let entered: { key: string; from: HTMLElement | undefined; at: number } | undefined;
    /** When the app last said each tab's page held the keyboard for the agent. */
    const said = new Map<string, number>();
    /** When the person last pressed in the window, and last pressed Tab or Escape in it. */
    let pressedAt = -Infinity;
    let movedAt = -Infinity;
    const isPage = (el: unknown) => el instanceof HTMLElement && el.tagName === "WEBVIEW";
    const view = (key: string) => [...doc.querySelectorAll<HTMLElement>("webview")].find((v) => v.dataset.key === key);
    const agentAtWork = (now: number, key?: string) => (key === undefined ? [...said.values()] : [said.get(key) ?? -Infinity]).some((at) => now - at <= AGAIN_MS);
    const takeBack = (key: string) => {
        const page = view(key);
        if (!page) return;
        const now = performance.now();
        const was = left && left.el.isConnected && now - left.at <= LEFT_MS ? left.el : home?.isConnected ? home : undefined;
        const step = nextStep<HTMLElement>({ active: doc.activeElement as HTMLElement | null, page, body: doc.body, now, left: was, entered: entered?.key === key ? entered : undefined });
        if (step.do === "wait") return;
        taking = true;
        if (step.do === "enter") {
            const first = (entered = { key, from: step.from ?? was, at: now });
            page.focus();
            // The app's next word brings the second step. If this was its last look, none comes, and the window
            // would be left showing the page focused, with the keys in it.
            later(() => {
                if (!stopped && entered === first && theirs !== key && doc.activeElement === page) takeBack(key);
            }, ENTERED_MS);
        } else {
            entered = undefined;
            if (step.to?.isConnected) step.to.focus();
            else page.blur();
        }
        taking = false;
    };
    const off = bridge.onBrowser((e) => {
        if (e.type === "destroy") {
            said.delete(e.key);
            if (theirs === e.key) theirs = undefined;
        } else if (e.type === "person" && e.press) theirs = e.key;
        else if (e.type === "focused" && theirs !== e.key) {
            said.set(e.key, performance.now());
            takeBack(e.key);
        }
    });
    // Where the window hears of a page taking its focus (it loses its own, with the page's element active): at once,
    // while the agent is at it, rather than at the app's next word.
    const blurred = (e: Event) => {
        const page = doc.activeElement as HTMLElement | null;
        const key = e.target === win && page && isPage(page) ? page.dataset.key : undefined;
        if (key && theirs !== key && agentAtWork(performance.now(), key)) takeBack(key);
    };
    const focusOut = (e: FocusEvent) => {
        const el = e.target;
        if (taking || e.relatedTarget || !(el instanceof HTMLElement) || isPage(el)) return;
        const now = performance.now();
        left = { el, at: now };
        // While the agent is at a page, where the person is can lose the window's focus to nothing with no press or
        // key of theirs (seen on macOS: their next keys then landed on nothing until the agent's next click). Once
        // this has settled, if nothing has it, it's theirs again.
        if (el !== home || !agentAtWork(now) || now - Math.max(pressedAt, movedAt) <= OWN_MS) return;
        later(() => {
            if (stopped || doc.activeElement !== doc.body || home !== el || !el.isConnected) return;
            taking = true;
            el.focus();
            taking = false;
        }, 0);
    };
    const focusIn = (e: FocusEvent) => {
        if (taking) return;
        left = undefined;
        const el = e.target;
        if (!(el instanceof HTMLElement) || isPage(el)) return;
        // Back in the window, by a key as much as by a press: no page is theirs any more.
        home = el;
        theirs = undefined;
    };
    // Back in the window by a press of theirs; where that puts the window's focus (nowhere, on a bare part of it) is home.
    const pressed = () => {
        theirs = undefined;
        entered = undefined;
        pressedAt = performance.now();
        later(() => {
            const at = doc.activeElement;
            home = at instanceof HTMLElement && at !== doc.body && !isPage(at) ? at : undefined;
        }, 0);
    };
    const keyed = (e: KeyboardEvent) => {
        if (e.key === "Tab" || e.key === "Escape") movedAt = performance.now();
    };
    // A key that reaches the window while its focus is in a page isn't the window's. The page has the keyboard
    // then, so the person's own keys go to it; this is one the app kept for the window, which never took the
    // keyboard back (browser-host.ts, sendStray). Let go of here: passed on, it would be answered by whatever takes
    // keys with nothing focused, a shortcut or a waiting approval.
    const strayed = (e: KeyboardEvent) => {
        if (!isPage(doc.activeElement)) return;
        e.stopImmediatePropagation();
        e.preventDefault();
    };
    const KEYS = ["keydown", "keypress", "keyup"] as const;
    for (const type of KEYS) win.addEventListener(type, strayed, true);
    doc.addEventListener("focusout", focusOut, true);
    doc.addEventListener("focusin", focusIn, true);
    doc.addEventListener("pointerdown", pressed, true);
    doc.addEventListener("keydown", keyed, true);
    win.addEventListener("blur", blurred, true);
    return () => {
        stopped = true;
        off();
        win.removeEventListener("blur", blurred, true);
        for (const type of KEYS) win.removeEventListener(type, strayed, true);
        doc.removeEventListener("focusout", focusOut, true);
        doc.removeEventListener("focusin", focusIn, true);
        doc.removeEventListener("pointerdown", pressed, true);
        doc.removeEventListener("keydown", keyed, true);
    };
}
