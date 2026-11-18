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
     * Where the page's replies come (ipcMain): "quit_reply" with the question's id and "asked" (it has the question, sent
     * at once, before anything is loaded or drawn), then "quit" or "cancel", or "unable" (it couldn't put it up).
     */
    ipc: { on(channel: string, fn: (e: E, ...args: unknown[]) => void): unknown; removeListener(channel: string, fn: (e: E, ...args: unknown[]) => void): unknown };
    /** Whether a reply is the window's page's own. */
    fromPage(e: E): boolean;
    /** How long the page has to say it has the question before it's taken not to answer (stuck). */
    ackMs: number;
    id: number;
}

export interface PageAsk {
    /** true: quit; false: don't. Undefined: the page couldn't ask (see askInPage). */
    answer: Promise<boolean | undefined>;
    /** Asked to quit again while it's up: the page says again it has it, or it's taken not to answer. */
    recheck(): void;
}

/**
 * Asks in the window's page, the window shown first. The page says at once that it has the question, before loading or
 * drawing anything; from then on the answer is waited for however long the page takes to draw it (a busy computer, the
 * dialog's code loaded on first use): only a page that can't ask falls back. The answer is undefined when the page is
 * gone or loading, doesn't say it has the question within ackMs (stuck), says it couldn't put it up, or stopped while
 * the question was up (crashed, loaded another page, hung, the window closed), or didn't say it still has it when asked
 * to quit again. The page is then told to take it down (in case it comes to), and the caller asks in the system's box.
 */
export function askInPage<E>(w: AskWindow, q: QuitQuestion, o: AskOptions<E>): PageAsk {
    const page = w.webContents;
    if (page.isDestroyed() || page.isCrashed() || page.isLoading()) return { answer: Promise.resolve(undefined), recheck: () => {} };
    if (w.isMinimized()) w.restore();
    if (!w.isVisible()) w.show();
    w.focus();
    const { id } = o;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let resolve!: (quit: boolean | undefined) => void;
    const answer = new Promise<boolean | undefined>((r) => (resolve = r));
    /** Sends the question (again: the page that has it up says so again) and waits for the page to say it has it. */
    const ask = () => {
        if (finished) return;
        clearTimeout(timer);
        timer = setTimeout(gone, o.ackMs);
        page.send("quit_ask", { id, ...q });
    };
    const done = (quit: boolean | undefined) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        o.ipc.removeListener("quit_reply", reply);
        page.removeListener("did-start-navigation", navigated);
        page.removeListener("render-process-gone", gone);
        w.removeListener("unresponsive", gone);
        w.removeListener("closed", gone);
        if (quit === undefined && !page.isDestroyed()) page.send("quit_ask", { id, end: true });
        resolve(quit);
    };
    const gone = () => done(undefined);
    const navigated = (e: { isMainFrame?: boolean; isSameDocument?: boolean }) => e.isMainFrame && !e.isSameDocument && gone();
    const reply = (e: E, of: unknown, a: unknown) => {
        if (!o.fromPage(e) || of !== id) return;
        if (a === "asked") clearTimeout(timer);
        else if (a === "quit" || a === "cancel") done(a === "quit");
        else if (a === "unable") gone();
    };
    o.ipc.on("quit_reply", reply);
    page.on("did-start-navigation", navigated);
    page.on("render-process-gone", gone);
    w.on("unresponsive", gone);
    w.on("closed", gone);
    ask();
    return { answer, recheck: ask };
}
