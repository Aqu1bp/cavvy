// The question before quitting (main.ts before-quit), asked in the window's page, in Cavvy's own dialog
// (gui/src/components/QuitDialog.tsx), rather than in the system's message box.

export interface QuitQuestion {
    title: string;
    detail: string;
}

/** What of the window's page this needs (Electron's WebContents). */
export interface AskPage {
    isDestroyed(): boolean;
    isCrashed(): boolean;
    isLoading(): boolean;
    send(channel: string, ...args: unknown[]): void;
    on(event: string, fn: (...args: never[]) => void): unknown;
    removeListener(event: string, fn: (...args: never[]) => void): unknown;
}

/** What of the window this needs (Electron's BrowserWindow). */
export interface AskWindow {
    webContents: AskPage;
    isMinimized(): boolean;
    isVisible(): boolean;
    restore(): void;
    show(): void;
    focus(): void;
    on(event: string, fn: (...args: never[]) => void): unknown;
    removeListener(event: string, fn: (...args: never[]) => void): unknown;
}

export interface AskOptions<E> {
    /**
     * Where the page's replies come (ipcMain): "quit_reply" with the question's id and "asked" (it has the question, said
     * at once, before anything is loaded or drawn), then, once told to show it, "quit" or "cancel", or "unable" (it
     * couldn't put it up).
     */
    ipc: { on(channel: string, fn: (e: E, ...args: unknown[]) => void): unknown; removeListener(channel: string, fn: (e: E, ...args: unknown[]) => void): unknown };
    /** Whether a reply is the window's page's own. */
    fromPage(e: E): boolean;
    /** How long the page has to say it has the question before it's taken not to answer (stuck). */
    ackMs: number;
    /** Asked to quit again this long after the question while the page still hasn't said it has it: the box asks now. */
    againMs: number;
    id: number;
    now?: () => number;
}

export interface PageAsk {
    /** true: quit; false: don't. Undefined: the page couldn't ask (see askInPage). */
    answer: Promise<boolean | undefined>;
    /** Asked to quit again while it's being asked. */
    recheck(): void;
}

/**
 * Asks in the window's page, the window shown first. One question, one owner: the page puts its dialog up only when told
 * to here (`show`), and that's only once it has said it has the question and only while nothing else asks. So once the
 * caller asks in the system's box instead, a page that comes to late is told to drop it, never to show it, and one
 * answer is taken.
 *
 * The page says at once that it has the question, before loading or drawing anything; it's then told to show it, and
 * the answer is waited for however long drawing it takes. The answer is undefined, and the caller asks in the system's
 * box, when the page is gone or loading; doesn't say it has the question within ackMs (stuck; a busy computer delays it
 * only by the page's current task), or before the person asks to quit again againMs on; Chromium finds it unresponsive
 * before it has said so; it says it couldn't put the dialog up; or it went away (crashed, loaded another page, the
 * window closed). A page whose dialog is up isn't timed: it's asked again only as Chromium finds it unresponsive.
 */
export function askInPage<E>(w: AskWindow, q: QuitQuestion, o: AskOptions<E>): PageAsk {
    const page = w.webContents;
    if (page.isDestroyed() || page.isCrashed() || page.isLoading()) return { answer: Promise.resolve(undefined), recheck: () => {} };
    if (w.isMinimized()) w.restore();
    if (!w.isVisible()) w.show();
    w.focus();
    const now = o.now ?? Date.now;
    const { id } = o;
    const askedAt = now();
    /** "waiting": asked, the page hasn't said it has it; "shown": told to show it, its answer is waited for. */
    let phase: "waiting" | "shown" | "over" = "waiting";
    let resolve!: (quit: boolean | undefined) => void;
    const answer = new Promise<boolean | undefined>((r) => (resolve = r));
    const done = (quit: boolean | undefined) => {
        if (phase === "over") return;
        phase = "over";
        clearTimeout(timer);
        o.ipc.removeListener("quit_reply", reply);
        page.removeListener("did-start-navigation", navigated);
        page.removeListener("render-process-gone", gone);
        w.removeListener("unresponsive", gone);
        w.removeListener("closed", gone);
        // Whatever it has of this question, it drops: shown, coming, or not yet read.
        if (quit === undefined && !page.isDestroyed()) page.send("quit_ask", { id, end: true });
        resolve(quit);
    };
    const gone = () => done(undefined);
    const navigated = (e: { isMainFrame?: boolean; isSameDocument?: boolean }) => e.isMainFrame && !e.isSameDocument && gone();
    const reply = (e: E, of: unknown, a: unknown) => {
        if (!o.fromPage(e) || of !== id || phase === "over") return;
        if (a === "asked") {
            if (phase !== "waiting") return;
            phase = "shown";
            clearTimeout(timer);
            page.send("quit_ask", { id, ...q, show: true });
        } else if ((a === "quit" || a === "cancel") && phase === "shown") done(a === "quit");
        else if (a === "unable") gone();
    };
    o.ipc.on("quit_reply", reply);
    page.on("did-start-navigation", navigated);
    page.on("render-process-gone", gone);
    w.on("unresponsive", gone);
    w.on("closed", gone);
    const timer = setTimeout(gone, o.ackMs);
    page.send("quit_ask", { id, ...q });
    return {
        answer,
        recheck: () => {
            // Still no word, and they've waited: the box asks now. Sooner, the question is put to it again.
            if (phase === "waiting" && now() - askedAt >= o.againMs) gone();
            else if (phase === "waiting") page.send("quit_ask", { id, ...q });
        },
    };
}
