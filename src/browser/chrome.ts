// Finding an installed Chromium-based browser, and starting it headless with a DevTools endpoint.
//
// The endpoint is `--remote-debugging-port=0`: the browser picks a free port and writes it, with the path of its
// WebSocket, to DevToolsActivePort in the profile folder, so there is no port to race for. (`--remote-debugging-pipe`
// would keep the endpoint private to this process, but Bun can't hand a child the two extra file descriptors it takes.)
// The endpoint listens on 127.0.0.1 only; the browser checks the Host header of what connects to it.

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync } from "fs";
import { homedir, hostname, platform as osPlatform } from "os";
import { posix, win32 } from "path";
import { childEnv } from "../util/env";
import { expandPath } from "../util/files";
import { disarmGuard, parentGuard } from "../util/parent-guard";
import { redact } from "../util/redact";

export interface ChromeEnvironment {
    platform: NodeJS.Platform;
    env: Record<string, string | undefined>;
    home: string;
    exists(path: string): boolean;
    /** The path of a program on PATH. */
    which(name: string): string | null;
}

export function hostEnvironment(): ChromeEnvironment {
    return { platform: osPlatform(), env: process.env, home: homedir(), exists: existsSync, which: (name) => Bun.which(name) };
}

export type ChromeLookup = { ok: true; path: string; source: "HARNESS_BROWSER" | "browser.executable" | "installed" } | { ok: false; error: string };

export const BROWSER_ENV = "HARNESS_BROWSER";

const MAC_APPS = ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser", "Google Chrome Canary"];
const LINUX_PROGRAMS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser", "brave"];
const LINUX_PATHS = ["/opt/google/chrome/chrome", "/snap/bin/chromium", "/opt/brave.com/brave/brave", "/opt/microsoft/msedge/msedge"];
/** Windows: [folder under a Program Files or AppData root, program]. */
const WINDOWS_BROWSERS = [
    ["Google\\Chrome\\Application", "chrome.exe"],
    ["Chromium\\Application", "chrome.exe"],
    ["Microsoft\\Edge\\Application", "msedge.exe"],
    ["BraveSoftware\\Brave-Browser\\Application", "brave.exe"],
] as const;

/** Where a browser is usually installed, most wanted first. Programs on PATH are looked up separately (installedNames). */
export function installedPaths(e: Pick<ChromeEnvironment, "platform" | "env" | "home">): string[] {
    if (e.platform === "darwin") return MAC_APPS.flatMap((app) => [`/Applications/${app}.app/Contents/MacOS/${app}`, posix.join(e.home, "Applications", `${app}.app`, "Contents", "MacOS", app)]);
    if (e.platform === "win32") {
        const roots = [e.env.PROGRAMFILES, e.env["PROGRAMFILES(X86)"], e.env.LOCALAPPDATA].filter((r): r is string => Boolean(r));
        return WINDOWS_BROWSERS.flatMap(([dir, exe]) => roots.map((r) => win32.join(r, dir, exe)));
    }
    return LINUX_PATHS;
}

/** Programs to find on PATH. */
export function installedNames(e: Pick<ChromeEnvironment, "platform">): string[] {
    return e.platform === "linux" ? LINUX_PROGRAMS : e.platform === "win32" ? [] : ["google-chrome", "chromium", "brave-browser"];
}

/**
 * The browser to run: HARNESS_BROWSER, else the `browser.executable` setting, else the first installed one.
 * Something configured that isn't there is an error, not a reason to fall back: the user asked for that one.
 */
export function findChrome(configured: string | undefined, e: ChromeEnvironment = hostEnvironment()): ChromeLookup {
    const cwd = e.home;
    const asked: [string | undefined, "HARNESS_BROWSER" | "browser.executable"][] = [
        [e.env[BROWSER_ENV], "HARNESS_BROWSER"],
        [configured, "browser.executable"],
    ];
    for (const [value, source] of asked) {
        const want = value?.trim();
        if (!want) continue;
        const path = /[\\/]/.test(want) || want.startsWith("~") ? expandPath(want, cwd) : e.which(want);
        if (path && e.exists(path)) return { ok: true, path, source };
        return { ok: false, error: `${source === "HARNESS_BROWSER" ? `The ${BROWSER_ENV} environment variable` : "The browser.executable setting"} names "${want}", which isn't an installed browser. Fix or remove it.` };
    }
    for (const path of installedPaths(e)) if (e.exists(path)) return { ok: true, path, source: "installed" };
    for (const name of installedNames(e)) {
        const path = e.which(name);
        if (path) return { ok: true, path, source: "installed" };
    }
    return { ok: false, error: `No Chrome, Chromium, Edge or Brave was found. Install Google Chrome, or name a browser in the browser.executable setting or the ${BROWSER_ENV} environment variable.` };
}

const LOOKUP_TTL_MS = 30_000;
let looked: { key: string; at: number; result: ChromeLookup } | undefined;

/** findChrome for the real machine, remembered briefly: tools ask on every request whether they're offered. */
export function cachedChrome(configured: string | undefined): ChromeLookup {
    const key = `${process.env[BROWSER_ENV] ?? ""}\0${configured ?? ""}`;
    if (!looked || looked.key !== key || Date.now() - looked.at > LOOKUP_TTL_MS) looked = { key, at: Date.now(), result: findChrome(configured) };
    return looked.result;
}

/** For tests. */
export function forgetChromeLookup() {
    looked = undefined;
}

// ---------------------------------------------------------------------------

export interface ChromeArgsOptions {
    profile: string;
    headless: boolean;
    platform: NodeJS.Platform;
    /** The user id, when the platform has them: Chrome refuses its sandbox as root. */
    uid?: number;
    ci?: boolean;
}

/** The command line. Chrome's sandbox needs user namespaces and a non-root user; where it can't have them it is off. */
export function chromeArgs(o: ChromeArgsOptions): string[] {
    const noSandbox = o.uid === 0 || o.ci === true;
    return [
        ...(o.headless ? ["--headless=new"] : []),
        "--remote-debugging-port=0",
        `--user-data-dir=${o.profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-component-update",
        "--mute-audio",
        // No keychain or wallet prompts for the profile's cookies.
        ...(o.platform === "darwin" ? ["--use-mock-keychain"] : o.platform === "linux" ? ["--password-store=basic"] : []),
        ...(noSandbox ? ["--no-sandbox", ...(o.platform === "linux" ? ["--disable-dev-shm-usage"] : [])] : []),
        "about:blank",
    ];
}

/** A profile folder another running browser holds (Chrome's SingletonLock names `host-pid`): not one to start a second browser on. */
export function profileInUse(profile: string): boolean {
    try {
        if (!lstatSync(`${profile}/SingletonLock`).isSymbolicLink()) return false;
        const [, host, pid] = readlinkSync(`${profile}/SingletonLock`).match(/^(.*)-(\d+)$/) ?? [];
        if (!pid || host !== hostname()) return false;
        process.kill(Number(pid), 0);
        return true;
    } catch (e) {
        // No lock, or its process is gone; a process we may not signal is still there.
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
}

export interface LaunchOptions {
    executable: string;
    profile: string;
    headless?: boolean;
    /** How long the browser has to open its DevTools endpoint. */
    startupMs?: number;
    signal?: AbortSignal;
}

export interface ChromeProcess {
    pid: number;
    /** The browser's WebSocket endpoint. */
    wsUrl: string;
    /** The profile folder in use: a throwaway copy when the asked-for one was held by another browser. */
    profile: string;
    exitCode: number | null;
    /** Resolves when the browser process has ended, however it did. */
    exited: Promise<void>;
    /** Asks it to end (SIGTERM to its whole process group), SIGKILL after `graceMs`. Resolves once it has. */
    stop(graceMs?: number): Promise<void>;
}

const live = new Set<{ pid: number }>();
let exitHook = false;

function killGroup(pid: number, signal: NodeJS.Signals) {
    try {
        process.kill(process.platform === "win32" ? pid : -pid, signal);
    } catch {
        // already gone
    }
}

/** The harness exiting, however it does (not SIGKILL: the guard covers that), takes the browsers with it. */
function killAtExit(p: { pid: number }) {
    live.add(p);
    if (exitHook) return;
    exitHook = true;
    process.on("exit", () => {
        for (const c of live) killGroup(c.pid, "SIGKILL");
    });
}

const ENDPOINT = /^(\d+)\n(\/devtools\/browser\/[^\s]+)/;

/**
 * Starts the browser and waits for its DevTools endpoint. The browser leads a process group of its own, so its
 * helper processes end with it, and a watcher (parentGuard) stops the group if this process is killed outright.
 */
export async function launchChrome(o: LaunchOptions): Promise<ChromeProcess> {
    const busy = profileInUse(o.profile);
    const profile = busy ? `${o.profile}-${process.pid}` : o.profile;
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    // A leftover from an earlier browser would name a port nothing listens on, or another browser's.
    rmSync(`${profile}/DevToolsActivePort`, { force: true });
    const args = chromeArgs({ profile, headless: o.headless !== false, platform: process.platform, uid: process.getuid?.(), ci: Boolean(process.env.CI) });
    const proc = Bun.spawn([o.executable, ...args], { env: childEnv(), stdin: "ignore", stdout: "ignore", stderr: "pipe", detached: process.platform !== "win32" });
    proc.unref();
    killAtExit(proc);
    let guard: ReturnType<typeof parentGuard> | undefined;
    if (process.platform !== "win32") {
        try {
            guard = parentGuard(proc.pid, "browser-parent-guard");
            // It must not keep the harness from exiting: its pipe closes with the harness, and that is what it waits for.
            guard.unref();
        } catch {
            // Restricted sandboxes may not allow a second process; the exit hook still covers a normal exit.
        }
    }
    // What it says on stderr, for the error when it doesn't start. Read as it comes: a full pipe would stall it.
    let tail = "";
    void (async () => {
        const decoder = new TextDecoder();
        try {
            for await (const chunk of proc.stderr) tail = (tail + decoder.decode(chunk, { stream: true })).slice(-4000);
        } catch {
            // the process went away
        }
    })();
    const exited = proc.exited.then(
        () => {
            live.delete(proc);
            if (guard) void disarmGuard(guard);
            if (busy) rmSync(profile, { recursive: true, force: true });
        },
        () => undefined,
    );
    const handle: ChromeProcess = {
        pid: proc.pid,
        wsUrl: "",
        profile,
        get exitCode() {
            return proc.exitCode;
        },
        exited,
        async stop(graceMs = 3000) {
            if (proc.exitCode !== null || proc.signalCode) return exited;
            killGroup(proc.pid, "SIGTERM");
            const timer = setTimeout(() => killGroup(proc.pid, "SIGKILL"), graceMs);
            try {
                await exited;
            } finally {
                clearTimeout(timer);
            }
        },
    };
    try {
        handle.wsUrl = await openEndpoint(proc, profile, o.startupMs ?? 60_000, o.signal);
    } catch (e) {
        killGroup(proc.pid, "SIGKILL");
        await exited;
        const log = redact(tail.trim().split("\n").slice(-6).join("\n"));
        throw new Error(`${(e as Error).message}${log ? `\nThe browser said:\n${log}` : ""}`, { cause: e });
    }
    return handle;
}

async function openEndpoint(proc: { exitCode: number | null; signalCode: NodeJS.Signals | number | null }, profile: string, startupMs: number, outer?: AbortSignal): Promise<string> {
    const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(startupMs)]) : AbortSignal.timeout(startupMs);
    const waited = () => (outer?.aborted ? "Starting the browser was cancelled" : `The browser didn't open its DevTools endpoint within ${startupMs} ms`);
    let found: RegExpMatchArray | null = null;
    while (!found) {
        if (signal.aborted) throw new Error(waited());
        // A browser killed by a signal has no exit code, only its signal.
        if (proc.exitCode !== null || proc.signalCode) throw new Error(`The browser exited before opening its DevTools endpoint (${proc.exitCode ?? proc.signalCode})`);
        try {
            found = readFileSync(`${profile}/DevToolsActivePort`, "utf8").match(ENDPOINT);
        } catch {
            // not written yet
        }
        if (!found) await Bun.sleep(25);
    }
    const address = `127.0.0.1:${found[1]}`;
    const expected = `ws://${address}${found[2]}`;
    // The endpoint is this browser's: the file is ours alone, but the port is shared with everything on the machine.
    let version: { webSocketDebuggerUrl?: string };
    try {
        version = (await (await fetch(`http://${address}/json/version`, { signal })).json()) as { webSocketDebuggerUrl?: string };
    } catch (e) {
        if (signal.aborted) throw new Error(waited());
        throw new Error(`The browser's DevTools endpoint didn't answer: ${(e as Error).message}`);
    }
    if (version.webSocketDebuggerUrl !== expected || proc.exitCode !== null || proc.signalCode) throw new Error("The DevTools endpoint isn't the one this browser opened");
    return expected;
}
