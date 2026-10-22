// Where the GUI runs: the desktop app (Tauri) or a browser tab opened by
// `harness gui`. Everything that differs between the two lives here.

import type { Credentials } from "./rpc";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type Os = "macos" | "windows" | "linux" | "other";
export const os: Os = (() => {
    const p = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
    if (p.includes("mac")) return "macos";
    if (p.includes("win")) return "windows";
    if (p.includes("linux") || p.includes("x11")) return "linux";
    return "other";
})();

export const mod = os === "macos" ? "⌘" : "Ctrl";
export const isMod = (e: KeyboardEvent | MouseEvent) => (os === "macos" ? e.metaKey : e.ctrlKey);

const TOKEN_KEY = "harness.token";
const WINDOW_KEY = "harness.window";

let memoryWindow: string | undefined;
/**
 * This window's secret key (128 random bits): its terminals belong to it.
 * Kept in sessionStorage, like the token, so a reload keeps it and a new
 * window gets its own (a duplicated tab gets a copy, which the server handles).
 */
export function windowKey(): string {
    if (memoryWindow) return memoryWindow;
    let key: string | null | undefined;
    try {
        key = sessionStorage.getItem(WINDOW_KEY);
    } catch {
        key = memoryWindow;
    }
    if (key && /^[0-9a-f]{32}$/.test(key)) return memoryWindow = key;
    key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    try {
        sessionStorage.setItem(WINDOW_KEY, key);
    } catch {
        memoryWindow = key;
    }
    return memoryWindow = key;
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
}

let windowShown = !isTauri;
/**
 * The desktop window is created hidden, so its glass never shows only the desktop behind it:
 * the app shows it once the first screen is drawn (or after a while, whatever there is).
 */
export function showWindow() {
    if (windowShown) return;
    windowShown = true;
    void tauriInvoke("window_ready").catch(() => undefined);
}

/** Whether the window is on screen yet (in a browser, it always is). */
export const isWindowShown = () => windowShown;

/** How to reach the server: ask the desktop app, use the dev server's settings, or trade the link's code. */
export async function credentials(): Promise<Credentials | undefined> {
    if (isTauri) {
        const info = await tauriInvoke<{ port: number; token: string }>("sidecar_info");
        return { url: `ws://127.0.0.1:${info.port}/ws`, token: info.token };
    }
    const devUrl = import.meta.env.VITE_HARNESS_URL as string | undefined;
    const devToken = import.meta.env.VITE_HARNESS_TOKEN as string | undefined;
    if (devUrl && devToken) return { url: devUrl, token: devToken };

    const hash = new URLSearchParams(location.hash.slice(1));
    const code = hash.get("code");
    const direct = hash.get("token");
    if (code || direct) history.replaceState(null, "", location.pathname + location.search);
    if (direct) storeToken(direct);
    if (code) {
        const res = await fetch("./auth/exchange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
        const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
        if (body.token) storeToken(body.token);
        else throw new Error(body.error ?? "This link has expired.");
    }
    const token = readToken();
    if (!token) return undefined;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return { url: `${proto}//${location.host}/ws`, token };
}

function storeToken(t: string) {
    try {
        sessionStorage.setItem(TOKEN_KEY, t);
    } catch {
        memoryToken = t;
    }
}

let memoryToken: string | undefined;
function readToken(): string | undefined {
    try {
        return sessionStorage.getItem(TOKEN_KEY) ?? memoryToken;
    } catch {
        return memoryToken;
    }
}

export function forgetToken() {
    try {
        sessionStorage.removeItem(TOKEN_KEY);
    } catch {
        memoryToken = undefined;
    }
}

/** A native folder picker; undefined when there's none (the browser), so the GUI shows its own. */
export async function pickFolder(defaultPath?: string, title = "Open a project folder"): Promise<string | null | undefined> {
    if (!isTauri) return undefined;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ directory: true, multiple: false, defaultPath, title });
    return typeof r === "string" ? r : null;
}

export async function openExternal(url: string) {
    if (!/^(https?:|mailto:)/i.test(url)) return;
    if (isTauri) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
    } else window.open(url, "_blank", "noopener,noreferrer");
}

export async function revealPath(path: string) {
    if (!isTauri) return;
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
}

export const canReveal = isTauri;

export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
    }
}

let notifyAllowed: boolean | undefined;

/** A system notification, if the user allows them. */
/**
 * A desktop notification. `tag` names what it's about: a browser replaces an earlier one with the same tag
 * rather than adding another. The desktop app passes it on as the notification's id and thread, which only
 * Linux uses (tauri-plugin-notification 2.7 ignores both on macOS and Windows): callers gather bursts instead.
 */
export async function notify(title: string, body: string, onClick?: () => void, opts: { tag?: string } = {}) {
    if (isTauri) {
        try {
            const n = await import("@tauri-apps/plugin-notification");
            if (notifyAllowed === undefined) notifyAllowed = (await n.isPermissionGranted()) || (await n.requestPermission()) === "granted";
            if (notifyAllowed) n.sendNotification({ title, body, ...(opts.tag ? { id: tagId(opts.tag), group: opts.tag } : {}) });
        } catch {
            // notifications unavailable
        }
        return;
    }
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") await Notification.requestPermission().catch(() => undefined);
    if (Notification.permission !== "granted") return;
    const note = new Notification(title, { body, silent: false, ...(opts.tag ? { tag: opts.tag } : {}) });
    note.onclick = () => {
        window.focus();
        onClick?.();
        note.close();
    };
}

/** A tag as a notification id (a 32-bit integer). */
export function tagId(tag: string): number {
    let h = 0;
    for (let i = 0; i < tag.length; i++) h = (Math.imul(h, 31) + tag.charCodeAt(i)) | 0;
    return h;
}

/** Match the native window chrome (title bar, traffic lights) to the app's light or dark theme. */
export async function setNativeTheme(scheme: "light" | "dark") {
    if (!isTauri) return;
    try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setTheme(scheme);
    } catch {
        // older webviews or a missing permission: the chrome keeps the system theme
    }
}

/** The app window has focus (for deciding whether to notify). */
export function focused(): boolean {
    return document.visibilityState === "visible" && document.hasFocus();
}
