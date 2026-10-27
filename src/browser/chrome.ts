// Finding an installed Chromium-based browser, and starting it headless with a DevTools endpoint.
//
// The endpoint is `--remote-debugging-pipe`: the browser reads commands on its file descriptor 3 and answers on 4, so
// only this process can drive it. A port, which anything on the machine can connect to without a password (and from
// there read the profile's cookies or run script in its pages), is only for Windows, where the pipe is untried: there
// it's `--remote-debugging-port=0`, the browser picking a free port and writing it, with the path of its WebSocket, to
// DevToolsActivePort in the profile folder. That port listens on 127.0.0.1 only, and checks the Host header.

import type { Subprocess } from "bun";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync } from "fs";
import { homedir, hostname, platform as osPlatform } from "os";
import { posix, win32 } from "path";
import { CdpClient, type CdpTransport } from "./cdp";
import { childEnv } from "../util/env";
import { expandPath } from "../util/files";
import { disarmGuard, parentGuard } from "../util/parent-guard";
import { redact, lineRedactor } from "../util/redact";

export interface ChromeEnvironment {
    platform: NodeJS.Platform;
    env: Record<string, string | undefined>;
    home: string;
    exists(path: string): boolean;
    /** The path of a program on PATH. */
    which(name: string): string | null;
}

export function hostEnvironment(): ChromeEnvironment {
    return { platform: osPlatform(), env: process.env, home: homedir(), exists: existsSync, which: (name) => Bun.which(name, { PATH: process.env.PATH }) };
}

export type ChromeLookup = { ok: true; path: string; source: "CAVVY_BROWSER" | "browser.executable" | "installed" } | { ok: false; error: string };

export const BROWSER_ENV = "CAVVY_BROWSER";

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
 * The browser to run: CAVVY_BROWSER, else the `browser.executable` setting, else the first installed one.
 * Something configured that isn't there is an error, not a reason to fall back: the user asked for that one.
 */
export function findChrome(configured: string | undefined, e: ChromeEnvironment = hostEnvironment()): ChromeLookup {
    const cwd = e.home;
    const asked: [string | undefined, "CAVVY_BROWSER" | "browser.executable"][] = [
        [e.env[BROWSER_ENV], "CAVVY_BROWSER"],
        [configured, "browser.executable"],
    ];
    for (const [value, source] of asked) {
        const want = value?.trim();
        if (!want) continue;
        const path = /[\\/]/.test(want) || want.startsWith("~") ? expandPath(want, cwd) : e.which(want);
        if (path && e.exists(path)) return { ok: true, path, source };
        return { ok: false, error: `${source === "CAVVY_BROWSER" ? `The ${BROWSER_ENV} environment variable` : "The browser.executable setting"} names "${want}", which isn't an installed browser. Fix or remove it.` };
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
    /** Spoken to over its pipe rather than a port: by default, everywhere but Windows (see the top of this file). */
    pipe?: boolean;
}

/** Whether a browser on this platform is spoken to over its pipe, unless told. */
export function usesPipe(o: { platform: NodeJS.Platform; pipe?: boolean }): boolean {
    return o.pipe ?? o.platform !== "win32";
}

/** The command line. Chrome's sandbox needs user namespaces and a non-root user; where it can't have them it is off. */
export function chromeArgs(o: ChromeArgsOptions): string[] {
    const noSandbox = o.uid === 0 || o.ci === true;
    return [
        // Headless Chrome otherwise captures a 1x compositor surface even when emulated DPR is 2.
        // A Retina surface preserves text detail; each viewer caps output to its backing-store size.
        // No scrollbars: on Linux they'd take 15px of the viewport, so a page (and its screenshots and frames) would be
        // narrower there than on macOS, whose scrollbars sit over the page.
        ...(o.headless ? ["--headless=new", "--force-device-scale-factor=2", "--hide-scrollbars"] : []),
        // navigator.webdriver stays false: sites (Google's search, YouTube) answer an automated browser with a robot check.
        "--disable-blink-features=AutomationControlled",
        usesPipe(o) ? "--remote-debugging-pipe" : "--remote-debugging-port=0",
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

export interface ChromeIdentity {
    userAgent: string;
    userAgentMetadata: {
        brands: { brand: string; version: string }[];
        fullVersionList: { brand: string; version: string }[];
        platform: string;
        platformVersion: string;
        architecture: string;
        bitness: string;
        model: string;
        mobile: boolean;
        wow64: boolean;
    };
}

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

/**
 * What a headless browser tells sites it is, as the same browser with a window: its user agent says HeadlessChrome,
 * which sites answer with a robot check. The client hints (Sec-CH-UA) change with it, since a user agent that
 * disagrees with them is itself a sign. Undefined for a browser that already reads as itself.
 */
export function chromeIdentity(userAgent: string, host: { platform: NodeJS.Platform; arch: string; release: string }): ChromeIdentity | undefined {
    const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(userAgent);
    if (!version) return undefined;
    const [found, full, major] = version as unknown as [string, string, string];
    const brands = (of: (v: string) => string) => [
        { brand: "Chromium", version: of(major) },
        { brand: "Google Chrome", version: of(major) },
        { brand: "Not A(Brand", version: of("99") },
    ];
    return {
        userAgent: userAgent.replace(found, `Chrome/${major}.0.0.0`),
        userAgentMetadata: {
            brands: brands((v) => v),
            fullVersionList: brands((v) => (v === major ? full : `${v}.0.0.0`)),
            platform: UA_PLATFORMS[host.platform] ?? "Unknown",
            platformVersion: host.platform === "linux" ? host.release : "",
            architecture: host.arch.startsWith("arm") ? "arm" : "x86",
            bitness: host.arch.endsWith("64") ? "64" : "32",
            model: "",
            mobile: false,
            wow64: false,
        },
    };
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
    /** Spoken to over its pipe rather than a port (usesPipe). */
    pipe?: boolean;
}

export interface ChromeProcess {
    pid: number;
    /** The connection to the browser: its pipe, or its port's WebSocket. */
    cdp: CdpClient;
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

/** Cavvy exiting, however it does (not SIGKILL: the guard covers that), takes the browsers with it. */
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
 * Starts the browser and connects to it, over its pipe or its endpoint. The browser leads a process group of its own,
 * so its helper processes end with it, and a watcher (parentGuard) stops the group if this process is killed outright.
 */
export async function launchChrome(o: LaunchOptions): Promise<ChromeProcess> {
    const busy = profileInUse(o.profile);
    const profile = busy ? `${o.profile}-${process.pid}` : o.profile;
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    // A leftover from an earlier browser would name a port nothing listens on, or another browser's.
    rmSync(`${profile}/DevToolsActivePort`, { force: true });
    const pipe = usesPipe({ platform: process.platform, pipe: o.pipe });
    const args = chromeArgs({ profile, headless: o.headless !== false, platform: process.platform, uid: process.getuid?.(), ci: Boolean(process.env.CI), pipe });
    // Its pipe is the two descriptors after stderr: 3 it reads commands from, 4 it answers on.
    const proc = Bun.spawn([o.executable, ...args], { env: childEnv(), stdio: ["ignore", "ignore", "pipe", ...(pipe ? (["pipe", "pipe"] as const) : [])], detached: process.platform !== "win32" });
    proc.unref();
    killAtExit(proc);
    let guard: ReturnType<typeof parentGuard> | undefined;
    // Windows has no process groups to signal and no shell to watch from: a Cavvy ended from Task Manager leaves its browser
    // running (a normal exit stops it). A job object that kills its processes when its handle closes would fix that, and needs native calls.
    if (process.platform !== "win32") {
        try {
            guard = parentGuard(proc.pid, "browser-parent-guard");
            // It must not keep Cavvy from exiting: its pipe closes with Cavvy, and that is what it waits for.
            guard.unref();
        } catch {
            // Restricted sandboxes may not allow a second process; the exit hook still covers a normal exit.
        }
    }
    // What it says on stderr, for the error when it doesn't start. Read as it comes: a full pipe would stall it.
    let tail = "";
    void (async () => {
        const decoder = new TextDecoder();
        const safe = lineRedactor();
        try {
            for await (const chunk of proc.stderr) tail = (tail + safe(decoder.decode(chunk, { stream: true }))).slice(-4000);
            tail = (tail + safe(decoder.decode() + "\n")).slice(-4000);
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
        cdp: undefined as unknown as CdpClient,
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
    const startupMs = o.startupMs ?? 60_000;
    try {
        if (pipe) handle.cdp = await answered(CdpClient.over(pipeTransport(proc)), proc, exited, startupMs, o.signal);
        else handle.cdp = await CdpClient.connect(await openEndpoint(proc, profile, startupMs, o.signal), { signal: o.signal });
    } catch (e) {
        killGroup(proc.pid, "SIGKILL");
        await exited;
        const log = redact(tail.trim().split("\n").slice(-6).join("\n"));
        throw new Error(`${(e as Error).message}${log ? `\nThe browser said:\n${log}` : ""}`, { cause: e });
    }
    return handle;
}

/**
 * Browsers whose pipe is in use. Bun closes a process's pipe descriptors when it collects the process, so nothing here
 * closes them (a second close would hit whatever has the number by then: another browser's guard, which takes that for
 * Cavvy ending), and the process is held until its pipe is done with.
 */
const piped = new Set<Subprocess>();

/**
 * The browser's pipe as a connection: commands go to its descriptor 3, and answers and events come from 4, each
 * message ending in a NUL. It lasts as long as the browser: closing it only stops it being used, and the browser is
 * stopped to end it.
 */
function pipeTransport(proc: Subprocess): CdpTransport {
    const [, , , write, read] = proc.stdio as unknown as number[];
    const sink = Bun.file(write!).writer();
    piped.add(proc);
    let open = true;
    const transport: CdpTransport = {
        onmessage: null,
        onclose: null,
        onerror: null,
        send(text) {
            if (!open) throw new Error("the pipe to the browser is closed");
            sink.write(`${text}\0`);
            void Promise.resolve()
                .then(() => sink.flush())
                .catch(() => undefined);
        },
        close() {
            open = false;
        },
    };
    void (async () => {
        const decoder = new TextDecoder();
        let parts: string[] = [];
        try {
            for await (const chunk of Bun.file(read!).stream()) {
                let text = decoder.decode(chunk, { stream: true });
                // Only what just came is searched for a message's end: an answer can be megabytes (a screenshot).
                for (let end = text.indexOf("\0"); end >= 0; end = text.indexOf("\0")) {
                    parts.push(text.slice(0, end));
                    text = text.slice(end + 1);
                    const message = parts.join("");
                    parts = [];
                    if (open) transport.onmessage?.({ data: message });
                }
                if (text) parts.push(text);
            }
        } catch {
            // the browser went away
        }
        open = false;
        transport.onclose?.();
        // What is still being written fails once the browser has gone; after that Bun may close the descriptors.
        await proc.exited;
        await Promise.resolve()
            .then(() => sink.end())
            .catch(() => undefined);
        piped.delete(proc);
    })();
    return transport;
}

/**
 * What there is to wait for on a pipe in place of an endpoint: the browser answering. Rejects when it exits first, or
 * doesn't answer within `startupMs`, or `outer` aborts.
 */
async function answered(cdp: CdpClient, proc: { exitCode: number | null; signalCode: NodeJS.Signals | number | null }, exited: Promise<void>, startupMs: number, outer?: AbortSignal): Promise<CdpClient> {
    const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(startupMs)]) : AbortSignal.timeout(startupMs);
    let stop: (() => void) | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            stop = () => reject(new Error(outer?.aborted ? "Starting the browser was cancelled" : `The browser didn't open its DevTools endpoint within ${startupMs} ms`));
            if (signal.aborted) return stop();
            signal.addEventListener("abort", stop, { once: true });
            // Its pipe closes as it ends: how it ended, once it has.
            cdp.onClose(() => void Promise.race([exited, Bun.sleep(1000)]).then(() => reject(new Error(`The browser exited before opening its DevTools endpoint (${proc.exitCode ?? proc.signalCode ?? "its pipe closed"})`))));
            cdp.send("Browser.getVersion", {}, undefined, startupMs).then(
                () => resolve(),
                () => undefined,
            );
        });
    } catch (e) {
        cdp.close();
        throw e;
    } finally {
        if (stop) signal.removeEventListener("abort", stop);
    }
    return cdp;
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
