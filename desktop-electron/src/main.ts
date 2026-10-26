// The Cavvy desktop app: the GUI (gui/dist) and the server (the Bun program, started with `serve --handshake`) in an
// Electron window, so the Browser pane is a real Chromium page that the person and the agent both use
// (browser-host.ts). Packaged (pack.ts), the server is the one executable beside the app's own
// (Contents/MacOS/cavvy, where the Tauri app kept it); run from the repo (`bun run desktop:dev`), it's the TypeScript
// source with `bun`, so server changes need no rebuild.

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, screen, shell, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserHost } from "./browser-host";
import { mark, startMetrics } from "./metrics";
import { MIN_SIZE, restorable, type WindowState } from "./window-state";

// The app's folder (desktop-electron, or the packaged app's archive), not __dirname: the bundler fixes that to the
// source folder. Packaged, the GUI is a resource and the server sits beside the app's executable; in development, the repo's.
const APP = app.getAppPath();
const REPO = resolve(APP, "..");
const GUI = app.isPackaged ? join(process.resourcesPath, "gui") : join(REPO, "gui/dist");
const SERVER = join(dirname(process.execPath), "cavvy");
/** A server that stops this often (within RESTART_WINDOW_MS) isn't started again, as the Tauri shell did. */
const MAX_STARTS = 5;
const RESTART_WINDOW_MS = 60_000;
const SCHEME = "cavvy";
const ORIGIN = `${SCHEME}://app`;
/** From the repo only: the GUI's Vite dev server, with hot reload (scripts/desktop-dev.ts), in place of gui/dist. */
const DEV_URL = app.isPackaged ? undefined : process.env.CAVVY_ELECTRON_DEV_URL;
/** Where the window's page comes from: the only origin that may use the bridge or navigate the window. */
const PAGE_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : ORIGIN;
/** How long the window may stay hidden waiting for the page (a page that failed to load). */
const SHOW_ANYWAY_MS = 3000;

// The Tauri shell's policy (desktop/src-tauri/tauri.conf.json), for the GUI served from cavvy://app.
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
if (process.env.CAVVY_ELECTRON_TEST_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.CAVVY_ELECTRON_TEST_PORT);
if (process.env.CAVVY_ELECTRON_USER_DATA) app.setPath("userData", process.env.CAVVY_ELECTRON_USER_DATA);

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
const starts: number[] = [];

function startServer() {
    const now = Date.now();
    while (starts.length && now - starts[0]! > RESTART_WINDOW_MS) starts.shift();
    if (starts.length >= MAX_STARTS) {
        console.error("[cavvy] the server keeps stopping; not restarting it again");
        return;
    }
    starts.push(now);
    // Started in the home folder: sessions say which project they work in.
    const cwd = process.env.CAVVY_ELECTRON_CWD ?? homedir();
    server = app.isPackaged
        ? spawn(SERVER, ["serve", "--handshake", "--login-env"], { cwd, stdio: "pipe" })
        : spawn(process.env.CAVVY_BUN ?? "bun", ["--no-env-file", `--config=${REPO}/bunfig.toml`, `${REPO}/src/index.ts`, "serve", "--handshake", "--login-env", ...(DEV_URL ? ["--dev-origin", PAGE_ORIGIN] : [])], { cwd, stdio: "pipe" });
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
                    console.error(`[cavvy] server ready on port ${h.port}`);
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
        console.error(`[cavvy] server exited (${code}); restarting`);
        setTimeout(startServer, 600);
    });
}

function sidecarInfo(): Promise<SidecarInfo> {
    if (info) return Promise.resolve(info);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Cavvy server didn't start in time")), 25_000);
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
/** How the window opened (window-state.ts): maximized or full screen once it's shown, as showing it hidden would show it early. */
let opened: WindowState | undefined;
const host = new BrowserHost(() => win);

function createWindow() {
    const glass = liquidGlass();
    const state = restorable(readWindowState(), screen.getAllDisplays().map((d) => d.workArea));
    win = new BrowserWindow({
        width: state.width,
        height: state.height,
        ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : { center: true }),
        minWidth: MIN_SIZE.width,
        minHeight: MIN_SIZE.height,
        show: false,
        title: "Cavvy",
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
    opened = state;
    keepWindowState(win);
    if (glass) {
        const w = win;
        w.webContents.once("did-finish-load", () => glass.addView(w.getNativeWindowHandle()));
    }
    console.error(`[cavvy] window material: ${glass ? "Liquid Glass" : "sidebar vibrancy"}`);
    win.webContents.on("preload-error", (_e, path, error) => console.error(`[cavvy] preload ${path} failed: ${error.stack ?? error}`));
    win.webContents.on("console-message", (e) => {
        if (e.level === "error" || e.level === "warning") console.error(`[gui ${e.level}] ${e.message}`);
    });
    // The GUI never navigates away from itself, nor opens windows: links go to the system browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
        return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
        if (!url.startsWith(`${PAGE_ORIGIN}/`)) e.preventDefault();
    });
    win.on("closed", () => {
        win = undefined;
        host.windowGone();
    });
    win.webContents.once("did-finish-load", () => mark("loaded"));
    // Checks only: kept on top, so macOS doesn't stop drawing a test window that other windows cover.
    if (process.env.CAVVY_ELECTRON_TEST_PORT) {
        win.setAlwaysOnTop(true, "floating");
        win.once("show", () => app.focus({ steal: true }));
    }
    void win.loadURL(DEV_URL ?? `${ORIGIN}/index.html`);
    setTimeout(showWindow, SHOW_ANYWAY_MS);
}

function showWindow() {
    if (shown || !win) return;
    shown = true;
    mark("shown");
    win.show();
    if (opened?.maximized) win.maximize();
    if (opened?.fullscreen) win.setFullScreen(true);
    win.focus();
}

/** Shows and focuses the window, wherever it is (a second launch, a notification clicked). */
function raiseWindow() {
    if (!win) return;
    if (!shown) return showWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    app.focus({ steal: true });
}

const stateFile = () => join(app.getPath("userData"), "window-state.json");

function readWindowState(): unknown {
    try {
        return JSON.parse(readFileSync(stateFile(), "utf8"));
    } catch {
        return undefined;
    }
}

/** Saves where the window is as it moves (a moment after it stops) and as it closes; maximized and full screen as they are. */
function keepWindowState(w: BrowserWindow) {
    let timer: NodeJS.Timeout | undefined;
    const save = () => {
        clearTimeout(timer);
        // Not before it's shown: hidden, it's at the size it opened at, not the one being kept.
        if (w.isDestroyed() || !shown) return;
        // The size it has when it's neither: what it goes back to.
        const b = w.getNormalBounds();
        const state: WindowState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: w.isMaximized(), fullscreen: w.isFullScreen() };
        try {
            mkdirSync(dirname(stateFile()), { recursive: true });
            const tmp = `${stateFile()}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(state));
            renameSync(tmp, stateFile());
        } catch {
            // Not kept this time: it opens where it did.
        }
    };
    const later = () => {
        clearTimeout(timer);
        timer = setTimeout(save, 500);
    };
    for (const e of ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const) w.on(e as "resize", later);
    w.on("close", save);
}

/** The menu bar: the app's, editing (so ⌘C and the rest work in the page), and the window's. Developer tools only from the repo. */
function appMenu() {
    const template: MenuItemConstructorOptions[] = [
        { role: "appMenu" },
        { role: "editMenu" },
        { label: "View", submenu: [{ role: "togglefullscreen" }, ...(app.isPackaged ? [] : [{ type: "separator" as const }, { role: "reload" as const }, { role: "toggleDevTools" as const }])] },
        { role: "windowMenu" },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

interface LiquidGlass {
    isGlassSupported(): boolean;
    addView(handle: Buffer, options?: { cornerRadius?: number; tintColor?: string }): number;
}

/** macOS 26's Liquid Glass (Apple's NSGlassEffectView, through electron-liquid-glass), where there is one. */
function liquidGlass(): LiquidGlass | undefined {
    if (process.platform !== "darwin" || process.env.CAVVY_ELECTRON_GLASS === "0") return undefined;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const glass = require("electron-liquid-glass") as LiquidGlass;
        return glass.isGlassSupported() ? glass : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Checks only (with CAVVY_ELECTRON_METRICS): a line written to <metrics file>.cmd does to the window what a person's
 * use of their desktop does: minimize/restore, hide/show, cover/uncover (another window over it).
 */
function testWindowCommands() {
    const file = process.env.CAVVY_ELECTRON_METRICS;
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

const fromGui = (e: IpcMainEvent | IpcMainInvokeEvent) => win !== undefined && e.sender === win.webContents && e.senderFrame?.url.startsWith(`${PAGE_ORIGIN}/`) === true;

function bridge() {
    ipcMain.handle("sidecar_info", (e) => (fromGui(e) ? sidecarInfo() : Promise.reject(new Error("refused"))));
    ipcMain.on("window_ready", (e) => fromGui(e) && showWindow());
    ipcMain.on("focus_window", (e) => fromGui(e) && raiseWindow());
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
    // A second launch focuses the window that's already open, even before the page has asked (it may never).
    app.on("second-instance", () => raiseWindow());
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
        app.setAboutPanelOptions({ applicationName: "Cavvy", applicationVersion: app.getVersion(), copyright: "MIT License", website: "https://cavvy.dev" });
        appMenu();
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
