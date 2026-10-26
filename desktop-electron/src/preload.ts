// The GUI's bridge to the Electron shell: window.cavvyDesktop (gui/src/lib/platform.ts, ElectronBridge).

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cavvyDesktop", {
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
    browserSized: (key: string, size: { width: number; height: number; scale: number }) => ipcRenderer.send("browser_sized", key, size),
});
