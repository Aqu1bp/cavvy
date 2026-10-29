// Xcode's simulators through `xcrun simctl`: which there are, starting and stopping them, and installing and
// launching apps. What runs on a booted one (touches, keys, its screen) goes through the helper (helper.ts).

import { spawn } from "child_process";
import { existsSync } from "fs";
import type { SimulatorDevice } from "../server/protocol";

export class SimulatorError extends Error {}

/** How long a simctl call may take: booting waits for the device to finish starting, which can take a minute or two. */
const CALL_MS = 60_000;
const BOOT_MS = 180_000;

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

export type Runner = (args: string[], o?: { timeoutMs?: number; signal?: AbortSignal; input?: string; env?: Record<string, string> }) => Promise<RunResult>;

/** Runs a program and collects what it prints (with a deadline, and Esc). */
export const run: Runner = (args, o = {}) =>
    new Promise((resolve, reject) => {
        const child = spawn(args[0]!, args.slice(1), { stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: o.env ? { ...process.env, ...o.env } : process.env });
        let stdout = "";
        let stderr = "";
        child.stdout!.on("data", (d) => (stdout += d));
        child.stderr!.on("data", (d) => (stderr += d));
        const stop = () => child.kill("SIGTERM");
        const timer = setTimeout(stop, o.timeoutMs ?? CALL_MS);
        o.signal?.addEventListener("abort", stop, { once: true });
        child.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            o.signal?.removeEventListener("abort", stop);
            if (o.signal?.aborted) reject(new SimulatorError("Interrupted by user."));
            else resolve({ code: code ?? -1, stdout, stderr });
        });
        if (o.input !== undefined) child.stdin!.end(o.input);
    });

let runner: Runner = run;

let forced: Availability | undefined;

/** Tests: whether there are simulators here, without looking (undefined: look). */
export function setAvailability(a: Availability | undefined) {
    forced = a;
}

/** Tests: simctl answered by a fake. */
export function setRunner(r: Runner | undefined) {
    runner = r ?? run;
    availability = undefined;
}

async function simctl(args: string[], o?: { timeoutMs?: number; signal?: AbortSignal; input?: string; env?: Record<string, string> }): Promise<string> {
    const r = await runner(["xcrun", "simctl", ...args], o);
    if (r.code !== 0) throw new SimulatorError(simctlError(r.stderr || r.stdout) || `simctl ${args[0]} failed`);
    return r.stdout;
}

/** simctl's complaint without its boilerplate: the line that says what went wrong. */
export function simctlError(text: string): string {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const said = lines.find((l) => /^An error was encountered/.test(l)) ? lines.find((l) => !/^An error was encountered|^Underlying error|^Domain=|^Error Domain=/.test(l)) : lines[0];
    return (said ?? "").replace(/^error:\s*/i, "").slice(0, 300);
}

// ---------------------------------------------------------------------------
// Whether there are simulators here

export type Availability = { ok: true; developerDir: string } | { ok: false; error: string };

let availability: { at: number; value: Availability } | undefined;

/** Whether Xcode's simulators can be used here (macOS with Xcode chosen by xcode-select), looked up at most once a minute. */
export async function simulatorsAvailable(): Promise<Availability> {
    if (forced) return forced;
    if (availability && Date.now() - availability.at < 60_000) return availability.value;
    const value = await lookUp();
    availability = { at: Date.now(), value };
    return value;
}

/**
 * Whether simulators can be used here, without waiting: macOS with CoreSimulator installed, and not found missing by
 * the last lookup (which this starts when it's due). For deciding whether to offer the tools.
 */
export function simulatorsLikely(): boolean {
    if (forced) return forced.ok;
    if (process.env.CAVVY_SIMULATOR === "0") return false;
    if (process.platform !== "darwin" || !existsSync("/Library/Developer/PrivateFrameworks/CoreSimulator.framework")) return false;
    if (!availability || Date.now() - availability.at >= 60_000) void simulatorsAvailable().catch(() => undefined);
    return availability?.value.ok !== false;
}

/** What the last lookup found, without looking (undefined: not looked yet). */
export function knownAvailability(): Availability | undefined {
    return forced ?? availability?.value;
}

async function lookUp(): Promise<Availability> {
    if (process.env.CAVVY_SIMULATOR === "0") return { ok: false, error: "Simulators are turned off: CAVVY_SIMULATOR is 0." };
    if (process.platform !== "darwin") return { ok: false, error: "Simulators need macOS." };
    try {
        const dir = await runner(["xcode-select", "-p"], { timeoutMs: 10_000 });
        const developerDir = dir.stdout.trim();
        if (dir.code !== 0 || !developerDir.endsWith("/Contents/Developer")) return { ok: false, error: "Simulators need Xcode." };
        const help = await runner(["xcrun", "simctl", "help"], { timeoutMs: 20_000 });
        if (help.code !== 0) return { ok: false, error: "Simulators need Xcode." };
        return { ok: true, developerDir };
    } catch {
        return { ok: false, error: "Simulators need Xcode." };
    }
}

// ---------------------------------------------------------------------------
// Devices

interface ListedDevice {
    udid: string;
    name: string;
    state: string;
    isAvailable?: boolean;
    deviceTypeIdentifier?: string;
}

/** "com.apple.CoreSimulator.SimRuntime.iOS-27-0" -> "iOS 27.0"; undefined for a runtime that isn't iOS's (watchOS, tvOS, visionOS). */
export function runtimeName(id: string): string | undefined {
    const m = /SimRuntime\.iOS-(\d+)(?:-(\d+))?(?:-(\d+))?$/.exec(id);
    if (!m) return undefined;
    return `iOS ${[m[1], m[2] ?? "0", m[3]].filter((p) => p !== undefined).join(".")}`;
}

function versionOf(runtime: string): number[] {
    return runtime.replace(/^\D+/, "").split(".").map(Number);
}

/** The iPhones and iPads that can run: booted first, then the newest iOS, iPhones before iPads, by name. */
export function parseDevices(json: string): SimulatorDevice[] {
    const parsed = JSON.parse(json) as { devices?: Record<string, ListedDevice[]> };
    const out: SimulatorDevice[] = [];
    for (const [runtimeId, list] of Object.entries(parsed.devices ?? {})) {
        const runtime = runtimeName(runtimeId);
        if (!runtime) continue;
        for (const d of list) {
            if (d.isAvailable === false) continue;
            const kind = /iPad/i.test(d.deviceTypeIdentifier ?? d.name) ? "ipad" : "iphone";
            out.push({ udid: d.udid, name: d.name, runtime, state: stateOf(d.state), kind });
        }
    }
    const rank = (s: SimulatorDevice["state"]) => (s === "booted" ? 0 : s === "booting" ? 1 : 2);
    return out.sort((a, b) => {
        if (rank(a.state) !== rank(b.state)) return rank(a.state) - rank(b.state);
        const va = versionOf(a.runtime);
        const vb = versionOf(b.runtime);
        for (let i = 0; i < Math.max(va.length, vb.length); i++) if ((va[i] ?? 0) !== (vb[i] ?? 0)) return (vb[i] ?? 0) - (va[i] ?? 0);
        if (a.kind !== b.kind) return a.kind === "iphone" ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
}

function stateOf(s: string): SimulatorDevice["state"] {
    switch (s) {
        case "Booted":
            return "booted";
        case "Booting":
            return "booting";
        case "Shutting Down":
            return "shutting_down";
        default:
            return "shutdown";
    }
}

export async function listDevices(signal?: AbortSignal): Promise<SimulatorDevice[]> {
    return parseDevices(await simctl(["list", "devices", "-j"], { signal, timeoutMs: 30_000 }));
}

/** Starts a device and waits until it has finished starting (its home screen is up). */
export async function boot(udid: string, signal?: AbortSignal): Promise<void> {
    // bootstatus -b boots it if it isn't, and returns once it's up; a device that's booted already returns at once.
    await simctl(["bootstatus", udid, "-b"], { signal, timeoutMs: BOOT_MS });
}

export async function shutdown(udid: string, signal?: AbortSignal): Promise<void> {
    try {
        await simctl(["shutdown", udid], { signal });
    } catch (e) {
        // Shut down already: what was asked for.
        if (!/current state: Shutdown/i.test((e as Error).message)) throw e;
    }
}

export async function install(udid: string, app: string, signal?: AbortSignal): Promise<void> {
    await simctl(["install", udid, app], { signal, timeoutMs: BOOT_MS });
}

/** Launches an app (ending a running copy first), with arguments for it. Returns its process id. */
export async function launch(udid: string, bundleId: string, args: string[] = [], signal?: AbortSignal): Promise<number | undefined> {
    const said = await simctl(["launch", "--terminate-running-process", udid, bundleId, ...args], { signal });
    const pid = /:\s*(\d+)\s*$/.exec(said.trim());
    return pid ? Number(pid[1]) : undefined;
}

export async function terminate(udid: string, bundleId: string, signal?: AbortSignal): Promise<void> {
    try {
        await simctl(["terminate", udid, bundleId], { signal });
    } catch (e) {
        // Not running: what was asked for.
        if (!/found nothing to terminate|not running/i.test((e as Error).message)) throw e;
    }
}

export async function openUrl(udid: string, url: string, signal?: AbortSignal): Promise<void> {
    await simctl(["openurl", udid, url], { signal });
}

/**
 * Restarts the device's bridge to the Mac (launchd starts it again at once). Its accessibility service can stop
 * answering when asked too soon after the device starts, until the bridge restarts.
 */
export async function restartBridge(udid: string): Promise<void> {
    await simctl(["spawn", udid, "launchctl", "kickstart", "-k", "user/foreground/com.apple.CoreSimulator.bridge"], { timeoutMs: 20_000 });
}

/** Puts text on the device's pasteboard (to paste what the keyboard can't type). */
export async function pasteboard(udid: string, text: string, signal?: AbortSignal): Promise<void> {
    // pbcopy reads its input in the locale's encoding: without a UTF-8 one (an app opened from Finder has no LANG,
    // and an inherited LC_ALL=C overrides LANG), "café" arrives as "caf√©".
    await simctl(["pbcopy", udid], { signal, input: text, env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
}

/** The bundle identifier in a built .app's Info.plist. */
export async function bundleIdOf(app: string): Promise<string | undefined> {
    try {
        const r = await runner(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleIdentifier", `${app.replace(/\/+$/, "")}/Info.plist`], { timeoutMs: 10_000 });
        return r.code === 0 ? r.stdout.trim() || undefined : undefined;
    } catch {
        return undefined;
    }
}
