// Spike: the Harness desktop app on Electron. The same GUI (gui/dist) and the same server (the Bun program, started
// as in the Tauri shell with `serve --handshake`), in an Electron window, so the Browser pane can be a real Chromium
// view that the person and the agent both use (browser-host.ts). Development only: the server runs from the repo's
// TypeScript with `bun`, as `tauri dev` does.

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserHost } from "./browser-host";
import { mark, startMetrics } from "./metrics";

// The app's folder (desktop-electron, or the packaged app's archive), not __dirname: the bundler fixes that to the
// source folder. Packaged (pack.ts), the GUI and the server binary are its resources; in development, the repo's.
const APP = app.getAppPath();
const REPO = resolve(APP, "..");
const GUI = app.isPackaged ? join(process.resourcesPath, "gui") : join(REPO, "gui/dist");
const SCHEME = "harness";
const ORIGIN = `${SCHEME}://app`;
/** How long the window may stay hidden waiting for the page (a page that failed to load). */
const SHOW_ANYWAY_MS = 3000;

// The Tauri shell's policy (desktop/src-tauri/tauri.conf.json), for the GUI served from harness://app.
const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws://127.0.0.1:*",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'",
].join("; ");

// Checks only (scripts drive the window over DevTools, in a data folder of their own so they run beside the app):
// never set in normal use.
if (process.env.HARNESS_ELECTRON_TEST_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.HARNESS_ELECTRON_TEST_PORT);
if (process.env.HARNESS_ELECTRON_USER_DATA) app.setPath("userData", process.env.HARNESS_ELECTRON_USER_DATA);

// codeCache: V8 keeps the UI's compiled scripts between launches (with v8CacheOptions below), as for http(s) pages.
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }]);

// ---------------------------------------------------------------------------
// The server

interface SidecarInfo {
    port: number;
    token: string;
}

let server: ChildProcessWithoutNullStreams | undefined;
let info: SidecarInfo | undefined;
let infoWaiters: ((i: SidecarInfo) => void)[] = [];
let quitting = false;

function startServer() {
    const cwd = process.env.HARNESS_ELECTRON_CWD ?? homedir();
    server = app.isPackaged
        ? spawn(join(process.resourcesPath, "harness"), ["serve", "--handshake", "--login-env"], { cwd, stdio: "pipe" })
        : spawn(process.env.HARNESS_BUN ?? "bun", ["--no-env-file", `--config=${REPO}/bunfig.toml`, `${REPO}/src/index.ts`, "serve", "--handshake", "--login-env"], { cwd, stdio: "pipe" });
    let pending = "";
    server.stdout.on("data", (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        let i: number;
        while ((i = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, i).trim();
            pending = pending.slice(i + 1);
            try {
                const h = JSON.parse(line) as { type?: string; port?: number; token?: string };
                if (h.type === "ready" && h.port && h.token) {
                    mark("serverReady");
                    console.error(`[harness] server ready on port ${h.port}`);
                    info = { port: h.port, token: h.token };
                    for (const w of infoWaiters.splice(0)) w(info);
                    host.connect(info);
                }
            } catch {
                // not the handshake
            }
        }
    });
    server.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    server.on("exit", (code) => {
        info = undefined;
        server = undefined;
        if (quitting) return;
        console.error(`[harness] server exited (${code}); restarting`);
        setTimeout(startServer, 600);
    });
}

function sidecarInfo(): Promise<SidecarInfo> {
    if (info) return Promise.resolve(info);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the harness server didn't start in time")), 25_000);
        infoWaiters.push((i) => {
            clearTimeout(timer);
            resolve(i);
        });
    });
}

async function stopServer() {
    const child = server;
    if (!child) return;
    // Asked to stop, it closes its sessions first; killed only if it hasn't exited in 9 seconds.
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.stdin.write("quit\n");
    const timer = setTimeout(() => child.kill("SIGKILL"), 9000);
    await exited;
    clearTimeout(timer);
}

// ---------------------------------------------------------------------------
// The window

let win: BrowserWindow | undefined;
let shown = false;
const host = new BrowserHost(() => win);

function createWindow() {
    const glass = liquidGlass();
    win = new BrowserWindow({
        width: 1360,
        height: 880,
        minWidth: 720,
        minHeight: 480,
        center: true,
        show: false,
        title: "Harness",
        titleBarStyle: "hidden",
        // The lights' centre on the GUI's --top-line (34px), as the Tauri shell puts them.
        trafficLightPosition: { x: 18, y: 27 },
        transparent: true,
        backgroundColor: "#00000000",
        // Liquid Glass where macOS has it (added below; Electron's vibrancy would cover it), else the sidebar
        // material, as the Tauri shell does.
        ...(glass ? {} : { vibrancy: "sidebar" as const, visualEffectState: "followWindow" as const }),
        webPreferences: {
            preload: join(APP, "dist/preload.cjs"),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            spellcheck: false,
            // Cache every script on its first run, not only ones run often: the next launch skips compiling them.
            v8CacheOptions: "bypassHeatCheck",
            // The browser tabs (browser-host.ts): <webview>s only it may make, locked down as they attach.
            webviewTag: true,
        },
    });
    host.watch(win.webContents);
    if (glass) {
        const w = win;
        w.webContents.once("did-finish-load", () => glass.addView(w.getNativeWindowHandle()));
    }
    console.error(`[harness] window material: ${glass ? "Liquid Glass" : "sidebar vibrancy"}`);
    win.webContents.on("preload-error", (_e, path, error) => console.error(`[harness] preload ${path} failed: ${error.stack ?? error}`));
    win.webContents.on("console-message", (e) => {
        if (e.level === "error" || e.level === "warning") console.error(`[gui ${e.level}] ${e.message}`);
    });
    // The GUI never navigates away from itself, nor opens windows: links go to the system browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
        return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
        if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault();
    });
    win.on("closed", () => {
        win = undefined;
        host.windowGone();
    });
    win.webContents.once("did-finish-load", () => mark("loaded"));
    // Checks only: kept on top, so macOS doesn't stop drawing a test window that other windows cover.
    if (process.env.HARNESS_ELECTRON_TEST_PORT) {
        win.setAlwaysOnTop(true, "floating");
        win.once("show", () => app.focus({ steal: true }));
    }
    void win.loadURL(`${ORIGIN}/index.html`);
    setTimeout(showWindow, SHOW_ANYWAY_MS);
}

function showWindow() {
    if (shown || !win) return;
    shown = true;
    mark("shown");
    win.show();
    win.focus();
}

interface LiquidGlass {
    isGlassSupported(): boolean;
    addView(handle: Buffer, options?: { cornerRadius?: number; tintColor?: string }): number;
}

/** macOS 26's Liquid Glass (Apple's NSGlassEffectView, through electron-liquid-glass), where there is one. */
function liquidGlass(): LiquidGlass | undefined {
    if (process.platform !== "darwin" || process.env.HARNESS_ELECTRON_GLASS === "0") return undefined;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const glass = require("electron-liquid-glass") as LiquidGlass;
        return glass.isGlassSupported() ? glass : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Checks only (with HARNESS_ELECTRON_METRICS): a line written to <metrics file>.cmd does to the window what a person's
 * use of their desktop does: minimize/restore, hide/show, cover/uncover (another window over it).
 */
function testWindowCommands() {
    const file = process.env.HARNESS_ELECTRON_METRICS;
    if (!file) return;
    let cover: BrowserWindow | undefined;
    setInterval(() => {
        let cmd = "";
        try {
            cmd = readFileSync(`${file}.cmd`, "utf8").trim();
            rmSync(`${file}.cmd`);
        } catch {
            return;
        }
        if (!win) return;
        if (cmd === "minimize") win.minimize();
        else if (cmd === "restore") win.restore();
        else if (cmd === "hide") win.hide();
        else if (cmd === "show") win.show();
        else if (cmd === "cover") {
            cover = new BrowserWindow({ ...win.getBounds(), backgroundColor: "#202020", show: true, focusable: true });
            cover.focus();
        } else if (cmd === "uncover") {
            cover?.close();
            cover = undefined;
            win.focus();
        }
    }, 200).unref();
}

// ---------------------------------------------------------------------------
// The GUI's bridge (preload.ts). Only the main window's page may use it.

const fromGui = (e: IpcMainEvent | IpcMainInvokeEvent) => win !== undefined && e.sender === win.webContents && e.senderFrame?.url.startsWith(`${ORIGIN}/`) === true;

function bridge() {
    ipcMain.handle("sidecar_info", (e) => (fromGui(e) ? sidecarInfo() : Promise.reject(new Error("refused"))));
    ipcMain.on("window_ready", (e) => fromGui(e) && showWindow());
    ipcMain.handle("pick_folder", async (e, o: { defaultPath?: string; title?: string }) => {
        if (!fromGui(e) || !win) return null;
        const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], defaultPath: typeof o?.defaultPath === "string" ? o.defaultPath : undefined, title: typeof o?.title === "string" ? o.title : undefined });
        return r.canceled ? null : (r.filePaths[0] ?? null);
    });
    ipcMain.handle("open_external", (e, url: string) => {
        if (fromGui(e) && typeof url === "string" && /^(https?:|mailto:)/i.test(url)) return shell.openExternal(url);
    });
    ipcMain.handle("reveal_path", (e, path: string) => {
        if (fromGui(e) && typeof path === "string" && existsSync(path)) shell.showItemInFolder(path);
    });
    ipcMain.on("set_theme", (e, scheme: string) => {
        if (fromGui(e) && (scheme === "light" || scheme === "dark")) nativeTheme.themeSource = scheme;
    });
    ipcMain.on("browser_shown", (e, keys: unknown) => {
        if (fromGui(e) && Array.isArray(keys)) host.shown(keys.filter((k): k is string => typeof k === "string"));
    });
    ipcMain.on("browser_sized", (e, key: string, size: { width: number; height: number; scale: number }) => {
        if (fromGui(e) && typeof key === "string" && size && [size.width, size.height, size.scale].every((n) => Number.isFinite(n) && n > 0)) host.sized(key, size);
    });
}

// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on("second-instance", () => {
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    });
    app.whenReady().then(() => {
        mark("ready");
        testWindowCommands();
        startMetrics({ ui: () => (win && !win.webContents.isDestroyed() ? win.webContents.getOSProcessId() : undefined), tabs: () => host.pids(), server: () => ({ pid: server?.pid, port: info?.port, token: info?.token }), extra: () => ({ tabs: host.stats, mainHeapMB: Math.round(process.memoryUsage().heapUsed / 1048576), mainRssMB: Math.round(process.memoryUsage().rss / 1048576) }) });
        protocol.handle(SCHEME, async (req) => {
            const url = new URL(req.url);
            const file = normalize(join(GUI, decodeURIComponent(url.pathname)));
            if (url.host !== "app" || !file.startsWith(GUI + sep) || !existsSync(file)) return new Response("Not found", { status: 404 });
            const res = await net.fetch(pathToFileURL(file).toString());
            const headers = new Headers(res.headers);
            headers.set("Content-Security-Policy", CSP);
            return new Response(res.body, { status: res.status, headers });
        });
        bridge();
        startServer();
        createWindow();
    });
    app.on("window-all-closed", () => app.quit());
    app.on("before-quit", (e) => {
        if (quitting) return;
        quitting = true;
        e.preventDefault();
        host.close();
        void stopServer().finally(() => app.quit());
    });
}
