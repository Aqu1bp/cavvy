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
 * What the new page shows when it's ready: the conversation of the session it was sent to, else the new-session
 * screen; or that the machine can't be reached. (It shows other things on its way there: the screen for a new
 * session before the session opens, a cover while it connects. Those aren't it.)
 */
const READY = { session: ".turn, .server-over", home: ".home, .server-over" };
/** How long the picture stays when nothing of those comes. */
const HELD_MS = 1500;

function showHeld() {
    let picture: string | null = null;
    let ready = READY.home;
    try {
        if (!sessionStorage.getItem(HELD)) return;
        sessionStorage.removeItem(HELD);
        // Where the window was sent (gui/src/lib/machines.ts switchMachine).
        if (/"activeId"/.test(sessionStorage.getItem("cavvy.navigation") ?? "")) ready = READY.session;
        picture = ipcRenderer.sendSync("held_frame");
    } catch {
        return;
    }
    if (!picture) return;
    const img = document.createElement("img");
    img.decoding = "sync";
    img.src = picture;
    img.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647";
    // The page under it isn't drawn meanwhile: where the window is glass, it would show through the picture.
    const hide = (on: boolean) => document.getElementById("root")?.style.setProperty("visibility", on ? "hidden" : "");
    let over = false;
    const end = () => {
        if (over) return;
        over = true;
        watch.disconnect();
        clearTimeout(timer);
        hide(false);
        img.remove();
    };
    const watch = new MutationObserver(() => {
        if (!img.isConnected && document.documentElement) document.documentElement.appendChild(img);
        hide(true);
        // Two frames on: what was just put in the page is laid out and drawn under the picture first.
        if (document.querySelector(ready)) requestAnimationFrame(() => requestAnimationFrame(end));
    });
    watch.observe(document, { childList: true, subtree: true });
    const timer = setTimeout(end, HELD_MS);
}
showHeld();

contextBridge.exposeInMainWorld("cavvyDesktop", {
    /** Loads the window again, keeping its picture on screen until the new page is ready (showHeld). */
    reloadHeld: () => {
        const go = () => {
            try {
                sessionStorage.setItem(HELD, "1");
            } catch {}
            location.reload();
        };
        // Not held up by a picture that's slow to take.
        void Promise.race([ipcRenderer.invoke("hold_frame"), new Promise((r) => setTimeout(r, 250))]).then(go, go);
    },
    sidecarInfo: () => ipcRenderer.invoke("sidecar_info"),
    windowReady: () => ipcRenderer.send("window_ready"),
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
