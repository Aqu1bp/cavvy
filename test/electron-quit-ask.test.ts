// The desktop app asks before quitting in its own dialog, in the window (desktop-electron/src/quit-ask.ts), and falls
// back to the system's box whenever the page can't ask, so quitting never gets stuck.
import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import { readFileSync } from "fs";
import { join } from "path";
import { askInPage, type AskPage, type AskWindow } from "../desktop-electron/src/quit-ask";

const Q = { title: "Quit while a session is working?", detail: "It stops where it is." };

function fakes(page: Partial<{ loading: boolean; crashed: boolean }> = {}) {
    const sent: unknown[] = [];
    const contents = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        isCrashed: () => page.crashed ?? false,
        isLoading: () => page.loading ?? false,
        send: (_channel: string, msg: unknown) => void sent.push(msg),
    });
    const state = { minimized: false, visible: true, focused: false };
    const win = Object.assign(new EventEmitter(), {
        webContents: contents as unknown as AskPage,
        isMinimized: () => state.minimized,
        isVisible: () => state.visible,
        restore: () => void (state.minimized = false),
        show: () => void (state.visible = true),
        focus: () => void (state.focused = true),
    });
    const ipc = new EventEmitter();
    const reply = (id: number, answer: string, from = "page") => ipc.emit("quit_reply", { from }, id, answer);
    const ask = (ackMs = 40) => askInPage(win as unknown as AskWindow, Q, { ipc, fromPage: (e: { from: string }) => e.from === "page", ackMs, id: 7 });
    return { sent, contents, win, state, ipc, reply, ask };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the page says it has the question, and its answer decides however long drawing it takes", async () => {
    const f = fakes();
    const a = f.ask();
    expect(f.sent).toEqual([{ id: 7, ...Q }]);
    f.reply(7, "asked");
    // Acknowledged: no deadline for drawing it or for the answer (a busy computer, the dialog's code loading).
    await sleep(200);
    f.reply(7, "quit");
    expect(await a.answer).toBe(true);
    expect(f.ipc.listenerCount("quit_reply")).toBe(0);

    const g = fakes();
    const b = g.ask();
    g.reply(7, "asked");
    g.reply(7, "cancel");
    expect(await b.answer).toBe(false);
});

test("a page that doesn't say it has the question in time is told to take it down, and the system's box asks", async () => {
    const f = fakes();
    const a = f.ask();
    expect(await a.answer).toBeUndefined();
    expect(f.sent.at(-1)).toEqual({ id: 7, end: true });
    // A late answer changes nothing.
    f.reply(7, "quit");
    expect(f.ipc.listenerCount("quit_reply")).toBe(0);
});

test("a page that couldn't put it up falls back at once", async () => {
    const f = fakes();
    const a = f.ask(5000);
    f.reply(7, "asked");
    f.reply(7, "unable");
    expect(await a.answer).toBeUndefined();
    expect(f.sent.at(-1)).toEqual({ id: 7, end: true });
});

test("only the window's page, and this question, answer", async () => {
    const f = fakes();
    const a = f.ask(200);
    f.reply(7, "quit", "elsewhere");
    f.reply(6, "quit");
    f.reply(7, "cancel");
    expect(await a.answer).toBe(false);
});

test("a page that can't ask isn't asked", async () => {
    for (const page of [{ loading: true }, { crashed: true }]) {
        const f = fakes(page);
        expect(await f.ask().answer).toBeUndefined();
        expect(f.sent).toEqual([]);
    }
});

test("a hidden or minimized window comes back first", async () => {
    const f = fakes();
    f.state.minimized = true;
    f.state.visible = false;
    const a = f.ask();
    expect(f.state).toEqual({ minimized: false, visible: true, focused: true });
    f.reply(7, "cancel");
    expect(await a.answer).toBe(false);
});

test("the page going away while it's up falls back", async () => {
    for (const end of ["crash", "load", "hang", "close"] as const) {
        const f = fakes();
        const a = f.ask(1000);
        f.reply(7, "asked");
        if (end === "crash") f.contents.emit("render-process-gone", {}, { reason: "crashed" });
        if (end === "load") {
            // Moving within the page doesn't count.
            f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
            f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
        }
        if (end === "hang") f.win.emit("unresponsive");
        if (end === "close") f.win.emit("closed");
        expect(await a.answer).toBeUndefined();
    }
});

test("asked to quit again while it's up: it stays if the page still answers, else the system's box asks", async () => {
    const f = fakes();
    const a = f.ask();
    f.reply(7, "asked");
    a.recheck();
    expect(f.sent).toEqual([{ id: 7, ...Q }, { id: 7, ...Q }]);
    f.reply(7, "asked");
    await sleep(80);
    a.recheck();
    // No word from the page this time (stuck since).
    expect(await a.answer).toBeUndefined();
});

test("the app asks through it, closing the window asks too, and the bridge carries it", () => {
    const main = readFileSync(join(import.meta.dir, "../desktop-electron/src/main.ts"), "utf8");
    const preload = readFileSync(join(import.meta.dir, "../desktop-electron/src/preload.ts"), "utf8");
    const ask = main.slice(main.indexOf("async function askToQuit"), main.indexOf("async function stopServer"));
    expect(ask).toContain("askInPage(win, q");
    // The system's box, Cancel the default, where the page can't ask.
    expect(ask).toContain("dialog.showMessageBox");
    expect(ask).toContain('buttons: ["Quit", "Cancel"], defaultId: 1, cancelId: 1');
    expect(main).toMatch(/win\.on\("close", \(e\) => \{\s*if \(quitting\) return;\s*e\.preventDefault\(\);\s*app\.quit\(\);/);
    expect(preload).toContain('ipcRenderer.on("quit_ask"');
    expect(preload).toContain('ipcRenderer.send("quit_reply"');
});

test("the page says it has the question before loading or drawing the dialog", () => {
    const appSrc = readFileSync(join(import.meta.dir, "../gui/src/App.tsx"), "utf8");
    const listener = appSrc.slice(appSrc.indexOf("electron?.onQuitAsk?.("), appSrc.indexOf("if (off) onCleanup(off);"));
    const ack = listener.indexOf('electron?.quitReply?.(q.id, "asked")');
    expect(ack).toBeGreaterThan(0);
    expect(ack).toBeLessThan(listener.indexOf("QuitDialog.preload()"));
    expect(listener).toContain('quitReply?.(q.id, "unable")');
});
