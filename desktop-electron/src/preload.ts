// The GUI's bridge to the Electron shell: window.cavvyDesktop (gui/src/lib/platform.ts, ElectronBridge).

import { contextBridge, ipcRenderer } from "electron";

/**
 * The window loads again to show another machine (gui/src/lib/machines.ts). Left to itself that's a window gone
 * black, then filled in piece by piece (measured: about 90 ms black and 270 ms half there). So the picture of the
 * window as it was is kept on screen over the new page until that has something to show, or a moment has passed:
 * the window changes once, to the other machine's view.
 */
const HELD = "cavvy.held";
/**
 * The new page is ready when it says its first screen is drawn (windowReady: the machine's sessions, projects and
 * settings are in, and the session it was sent to is open, or couldn't be). Before that, only a machine that can't
 * be reached, or has a question first, ends the wait (gui/src/components/Servers.tsx MachineCover): the page shows
 * other things on its way (a cover while it connects, the new-session screen before the session opens), and those
 * aren't it.
 */
const ASKS = ".server-asks";
/**
 * How long the picture stays when neither comes. (The page says it's ready after a second whatever it has, so that
 * a window always comes up: gui/src/state/app.ts SHOW_WINDOW_MS. This is that second, counted from here.)
 */
const HELD_MS = 1000;
/** The page said its first screen is drawn (a picture is up meanwhile). */
let shown: (() => void) | undefined;

function showHeld() {
    let picture: string | null = null;
    try {
        if (!sessionStorage.getItem(HELD)) return;
        sessionStorage.removeItem(HELD);
        picture = ipcRenderer.sendSync("held_frame");
    } catch {
        return;
    }
    if (!picture) return;
    const img = document.createElement("img");
    img.decoding = "sync";
    img.src = picture;
    img.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647";
    // The page under it isn't drawn meanwhile: where the window is glass, it would show through the picture. (Not
    // drawn, but there: the message box takes the keyboard as it does on any load, which a hidden one couldn't.)
    const hide = (on: boolean) => document.getElementById("root")?.style.setProperty("opacity", on ? "0" : "");
    let over = false;
    const end = () => {
        if (over) return;
        over = true;
        shown = undefined;
        watch.disconnect();
        clearTimeout(timer);
        hide(false);
        img.remove();
    };
    // Two frames on: what was just put in the page is laid out and drawn under the picture first.
    const soon = () => requestAnimationFrame(() => requestAnimationFrame(end));
    shown = soon;
    const watch = new MutationObserver(() => {
        if (!img.isConnected && document.documentElement) document.documentElement.appendChild(img);
        hide(true);
        if (document.querySelector(ASKS)) soon();
    });
    watch.observe(document, { childList: true, subtree: true });
    const timer = setTimeout(end, HELD_MS);
}
showHeld();

/** Counts the switches asked for: the last one is the one that loads the window. */
let leaving = 0;

contextBridge.exposeInMainWorld("cavvyDesktop", {
    /** Loads the window again, keeping its picture on screen until the new page is ready (showHeld). */
    reloadHeld: () => {
        // Where the window opens there, as it's written now: the page goes on living while the picture is taken, and
        // what it does meanwhile (another session opened) isn't where the window was sent.
        const NAVIGATION = "cavvy.navigation";
        const mine = ++leaving;
        let sent: string | null | undefined;
        try {
            sent = sessionStorage.getItem(NAVIGATION);
        } catch {}
        const go = () => {
            // Another switch was asked for meanwhile: that one loads the window, to where it was sent.
            if (mine !== leaving) return;
            try {
                sessionStorage.setItem(HELD, "1");
                if (sent === null) sessionStorage.removeItem(NAVIGATION);
                else if (sent !== undefined) sessionStorage.setItem(NAVIGATION, sent);
            } catch {}
            location.reload();
        };
        // Not held up by a picture that's slow to take.
        void Promise.race([ipcRenderer.invoke("hold_frame"), new Promise((r) => setTimeout(r, 250))]).then(go, go);
    },
    sidecarInfo: () => ipcRenderer.invoke("sidecar_info"),
    windowReady: () => {
        ipcRenderer.send("window_ready");
        shown?.();
    },
    focusWindow: () => ipcRenderer.send("focus_window"),
    pickFolder: (o: { defaultPath?: string; title: string }) => ipcRenderer.invoke("pick_folder", o),
    openExternal: (url: string) => ipcRenderer.invoke("open_external", url),
    revealPath: (path: string) => ipcRenderer.invoke("reveal_path", path),
    setTheme: (scheme: string) => ipcRenderer.send("set_theme", scheme),
    onBrowser: (fn: (msg: unknown) => void) => {
        const listener = (_e: unknown, msg: unknown) => fn(msg);
        ipcRenderer.on("browser", listener);
        return () => void ipcRenderer.removeListener("browser", listener);
    },
    browserShown: (keys: string[]) => ipcRenderer.send("browser_shown", keys),
    browserBack: (seen: number) => ipcRenderer.send("browser_back", seen),
    browserSized: (key: string, size: { width: number; height: number; scale: number }) => ipcRenderer.send("browser_sized", key, size),
});
