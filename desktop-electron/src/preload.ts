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
/**
 * The side panel is slower than the rest: it fetches what it shows once the session is open (measured: 25 to 60 ms
 * on this computer, 165 ms on a small server 40 ms away). The conversation isn't kept waiting for it, and it isn't
 * shown as a spinner either: where the panel stands where it stood before the switch, the picture stays over the
 * panel alone until its content is in, or a moment has passed.
 */
const PANEL = "aside.panel";
const PANEL_BUSY = `${PANEL} [aria-busy="true"]`;
const PANEL_MS = 300;
/** Where an element is in the window, to compare across the switch. */
const place = (el: Element | null) => {
    if (!el) return "";
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height].map(Math.round).join(",");
};
/**
 * Nothing slides or fades into place under the picture: the window's columns open to their widths at once, where
 * a panel that was open would otherwise be seen sliding in again after every switch.
 */
const STILL = "*,*::before,*::after{transition:none!important}";
/** The page said its first screen is drawn (a picture is up meanwhile). */
let shown: (() => void) | undefined;

function showHeld() {
    let picture: string | null = null;
    /** Where the side panel stood in the window that left (reloadHeld), if it had one. */
    let panelWas = "";
    try {
        const held = sessionStorage.getItem(HELD);
        if (!held) return;
        sessionStorage.removeItem(HELD);
        panelWas = held === "1" ? "" : held;
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
    const still = document.createElement("style");
    still.textContent = STILL;
    /** all: the whole window's picture is up. panel: only the part over the side panel. */
    let up: "all" | "panel" | "none" = "all";
    const end = () => {
        if (up === "none") return;
        up = "none";
        shown = undefined;
        watch.disconnect();
        clearTimeout(timer);
        hide(false);
        img.remove();
        // A frame after the picture: what changes from here on moves as it always does.
        requestAnimationFrame(() => still.remove());
    };
    /** The page is ready: it's shown, all but a side panel still fetching, which keeps its part of the picture. */
    const reveal = () => {
        if (up !== "all") return;
        // What was fading or sliding in under the picture (a row joining the list) is where it was going. Not what
        // runs for ever, nor what follows scrolling and not the clock (finished, it would never follow it again).
        for (const a of document.getAnimations()) {
            try {
                if (a.timeline === document.timeline && a.effect?.getComputedTiming().endTime !== Infinity) a.finish();
            } catch {}
        }
        const panel = document.querySelector(PANEL);
        if (!panel || !panelWas || place(panel) !== panelWas || !document.querySelector(PANEL_BUSY)) return end();
        up = "panel";
        const r = panel.getBoundingClientRect();
        img.style.clipPath = `inset(${r.top}px ${innerWidth - r.right}px ${innerHeight - r.bottom}px ${r.left}px)`;
        img.style.pointerEvents = "none";
        hide(false);
        clearTimeout(timer);
        timer = setTimeout(end, PANEL_MS);
        // A window that changes size takes the panel from under it.
        addEventListener("resize", end, { once: true });
    };
    // Two frames on: what was just put in the page is laid out and drawn under the picture first.
    const soon = (then: () => void) => requestAnimationFrame(() => requestAnimationFrame(then));
    let ready = false;
    let revealing = false;
    const settled = () => {
        // Over the panel alone: until its content is in, or the panel is no longer where the picture has it.
        if (up === "panel") return void ((document.querySelector(PANEL_BUSY) && place(document.querySelector(PANEL)) === panelWas) || soon(end));
        if (revealing || !(ready || document.querySelector(ASKS))) return;
        revealing = true;
        soon(reveal);
    };
    shown = () => {
        ready = true;
        settled();
    };
    const watch = new MutationObserver(() => {
        if (document.documentElement) {
            if (!img.isConnected) document.documentElement.appendChild(img);
            if (!still.isConnected) document.documentElement.appendChild(still);
        }
        if (up === "all") hide(true);
        settled();
    });
    watch.observe(document, { childList: true, subtree: true });
    let timer = setTimeout(end, HELD_MS);
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
                sessionStorage.setItem(HELD, place(document.querySelector(PANEL)) || "1");
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
