// One Cavvy session's use of Xcode's simulators: which device it uses, and what the agent and the person watching
// do on it. The agent's tools work through it, and so does the GUI's Simulator pane, which watches the screen as a
// stream of pictures and sends a person's touches and keys back. It needs no GUI: the TUI and headless runs use it
// as the tools do. A device is shared: sessions that use the same one share its helper, which runs while any does.

import { simulatorEnabled, type Settings } from "../config/settings";
import type { SimulatorDevice, SimulatorInput, SimulatorState } from "../server/protocol";
import { FrameFeed } from "../browser/feed";
import { helperBinary, SimHelper, type ScreenSize } from "./helper";
import { strokesForPress, strokesForText, usageOfCode, type KeyStroke } from "./keys";
import { outline, type AxNode, type RefTarget } from "./outline";
import * as simctl from "./simctl";
import { SimulatorError } from "./simctl";

export { SimulatorError };

/** A picture of the screen: a JPEG, at the screen's size in device pixels. */
export interface ScreenFrame {
    data: Uint8Array;
    width: number;
    height: number;
}

const TURNED_OFF = "The simulator is turned off: simulator.enabled is false in the settings.";

/**
 * The stream's pictures: at most this many a second, at this JPEG quality, and as long on their longer side as the
 * largest pane showing them draws the screen (in device pixels), within these bounds. Pictures go only when the
 * screen changes, so a still screen costs nothing.
 */
const STREAM = { fps: 60, quality: 0.72 };
const SIDE = { min: 320, max: 2000, unknown: 1400 };

/** How long a helper nothing uses (no pane showing its device, no agent call) keeps running. */
const IDLE_MS = 60_000;

// ---------------------------------------------------------------------------
// The devices, and a helper for each one in use (shared by the sessions on it)

interface Attached {
    udid: string;
    helper?: SimHelper;
    starting?: Promise<SimHelper>;
    error?: string;
    sessions: Set<SimulatorSession>;
    /** The last stream settings sent, so the same aren't sent again. */
    streamed?: string;
    idle?: ReturnType<typeof setTimeout>;
}

const attached = new Map<string, Attached>();
let devices: SimulatorDevice[] = [];
let listing: Promise<SimulatorDevice[]> | undefined;
let listedAt = 0;
/** Devices being started by Cavvy, and those it's shutting down: their state is known before simctl says so. */
const booting = new Set<string>();
const stopping = new Set<string>();
const everySession = new Set<SimulatorSession>();
/** When each device's bridge was last restarted to get its accessibility service answering (describe). */
const bridgeRestarted = new Map<string, number>();

function announceAll() {
    for (const s of everySession) s.announce();
}

/** The devices, looked up again unless that was under a second ago. */
async function refreshDevices(force = false): Promise<SimulatorDevice[]> {
    if (!force && Date.now() - listedAt < 1000) return devices;
    listing ??= simctl
        .listDevices()
        .then((list) => {
            const before = JSON.stringify(devices);
            devices = list;
            listedAt = Date.now();
            if (JSON.stringify(list) !== before) announceAll();
            return list;
        })
        .finally(() => (listing = undefined));
    return listing;
}

function stateOf(udid: string): SimulatorDevice["state"] | undefined {
    if (stopping.has(udid)) return "shutting_down";
    if (booting.has(udid)) return "booting";
    return devices.find((d) => d.udid === udid)?.state;
}

/** The helper on a booted device, started for it when there's none. */
async function helperFor(udid: string, session: SimulatorSession): Promise<SimHelper> {
    let a = attached.get(udid);
    if (!a) attached.set(udid, (a = { udid, sessions: new Set() }));
    a.sessions.add(session);
    if (a.helper?.running) {
        idleCheck(a);
        return a.helper;
    }
    if (!a.starting) {
        const entry = a;
        entry.error = undefined;
        entry.starting = (async () => {
            const available = await simctl.simulatorsAvailable();
            if (!available.ok) throw new SimulatorError(available.error);
            const bin = await helperBinary(available.developerDir);
            const helper = SimHelper.start(bin, available.developerDir, udid, {
                frame: (data, size) => {
                    for (const s of entry.sessions) s.frame({ data, width: size.width, height: size.height });
                },
                size: () => announceAll(),
                exit: (error) => {
                    if (entry.helper === helper) entry.helper = undefined;
                    if (error) entry.error = error;
                    // It ends with its device (shut down elsewhere, say): what the device does now is looked up.
                    void refreshDevices(true).catch(() => undefined);
                    announceAll();
                },
            });
            await helper.ready;
            entry.helper = helper;
            entry.streamed = undefined;
            updateStream(entry);
            announceAll();
            return helper;
        })();
        entry.starting
            .catch((e) => {
                entry.error = (e as Error).message;
                announceAll();
            })
            .finally(() => (entry.starting = undefined));
    }
    return a.starting!;
}

/** The session no longer uses the device: its helper stops when no session does. */
function detach(udid: string, session: SimulatorSession) {
    const a = attached.get(udid);
    if (!a) return;
    a.sessions.delete(session);
    if (a.sessions.size) {
        updateStream(a);
        return;
    }
    if (a.idle) clearTimeout(a.idle);
    a.helper?.stop();
    attached.delete(udid);
}

/** The helper streams pictures while some window watches the device; `fresh`: one that's just come needs a picture now. */
function updateStream(a: Attached, fresh = false) {
    if (!a.helper?.running) return;
    const watchers = [...a.sessions].filter((s) => s.watched);
    const on = watchers.length > 0;
    const wanted = Math.max(0, ...watchers.map((s) => s.side));
    const maxSide = Math.round(Math.min(Math.max(wanted || SIDE.unknown, SIDE.min), SIDE.max));
    const settings = JSON.stringify({ on, maxSide });
    if (settings !== a.streamed || (fresh && on)) {
        a.streamed = settings;
        a.helper.send({ op: "stream", on, maxSide, ...STREAM });
    }
    idleCheck(a);
}

/** A helper nobody watches stops a while after its last use; the next use starts it again. */
function idleCheck(a: Attached) {
    if (a.idle) clearTimeout(a.idle);
    a.idle = undefined;
    if ([...a.sessions].some((s) => s.watched)) return;
    a.idle = setTimeout(() => {
        a.idle = undefined;
        if ([...a.sessions].some((s) => s.watched) || a.starting) return;
        a.helper?.stop();
        a.helper = undefined;
        a.streamed = undefined;
    }, IDLE_MS);
    a.idle.unref?.();
}

function stopHelper(udid: string) {
    const a = attached.get(udid);
    if (!a) return;
    a.helper?.stop();
    a.helper = undefined;
}

// ---------------------------------------------------------------------------

export interface SimulatorSessionOptions {
    settings: () => Settings;
}

export class SimulatorSession {
    /** The device this session uses. */
    private udid?: string;
    private feed = new FrameFeed<ScreenFrame>();
    private sides = new Map<object, number>();
    private listeners = new Set<() => void>();
    private announcing?: ReturnType<typeof setTimeout>;
    private polling?: ReturnType<typeof setInterval>;
    /** What the last snapshot's refs stand for (points on the screen). */
    private refs = new Map<string, RefTarget>();
    /** The person used the device since the agent last looked. */
    private touched = false;
    /** Where the person's finger is down, and the keys they hold: let go when their window goes. */
    private finger?: { x: number; y: number };
    private keysHeld = new Set<number>();
    private agentAt?: number;
    disposed = false;

    constructor(private o: SimulatorSessionOptions) {
        everySession.add(this);
    }

    get watched(): boolean {
        return this.feed.size > 0;
    }

    private get enabled(): boolean {
        return simulatorEnabled(this.o.settings());
    }

    // -----------------------------------------------------------------------
    // What the window shows

    state(): SimulatorState {
        if (!this.enabled) return { status: "unavailable", error: TURNED_OFF, devices: [] };
        const available = simctl.knownAvailability();
        if (available && !available.ok) return { status: "unavailable", error: available.error, devices: [] };
        const device = this.device();
        const base = { devices, ...(device ? { device } : {}), ...(this.agentAt ? { agentAt: this.agentAt } : {}) };
        if (!device) return { status: "off", ...base };
        if (device.state === "booting") return { status: "booting", ...base };
        if (device.state !== "booted") return { status: "off", ...base };
        const a = attached.get(device.udid);
        if (a?.error && !a.helper?.running && !a.starting) return { status: "error", error: a.error, ...base };
        // Running: its screen's size comes once Cavvy is attached to it (a moment after it's watched or used).
        return { status: "ready", ...(a?.helper?.running && a.helper.size ? { screen: a.helper.size } : {}), ...base };
    }

    /** The session's device: the one it chose, else a booted one, else the first that can start (the pane offers it). */
    private device(): SimulatorDevice | undefined {
        const chosen = this.udid && devices.find((d) => d.udid === this.udid);
        const d = chosen || devices.find((x) => x.state === "booted") || devices.find((x) => x.kind === "iphone") || devices[0];
        if (!d) return undefined;
        const state = stateOf(d.udid) ?? d.state;
        return state === d.state ? d : { ...d, state };
    }

    /** Looks the devices up again, and attaches to the session's device if it runs. */
    async refresh(): Promise<SimulatorState> {
        if (!this.enabled) return this.state();
        const available = await simctl.simulatorsAvailable();
        if (!available.ok) return this.state();
        await refreshDevices(true).catch(() => undefined);
        const d = this.device();
        if (d?.state === "booted" && this.watched) void this.adopt(d.udid).catch(() => undefined);
        return this.state();
    }

    /** Calls `fn` after the state changes (soon, and once for a burst). Returns how to stop. */
    onChange(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    announce() {
        if (this.announcing || this.disposed) return;
        this.announcing = setTimeout(() => {
            this.announcing = undefined;
            for (const fn of [...this.listeners]) {
                try {
                    fn();
                } catch (e) {
                    console.error(e);
                }
            }
        }, 40);
        this.announcing.unref?.();
    }

    /** A window starts watching the screen: `send` gets its pictures, one at a time as it acks them. */
    /** The longest side, in device pixels, any of its panes draws the screen at (0: not said). */
    get side(): number {
        return Math.max(0, ...this.sides.values());
    }

    /** A window starts watching the screen (or says its size again): `send` gets its pictures, one at a time as it acks them. */
    async watch(key: object, send: (frame: ScreenFrame, frameId: string) => void, side?: number): Promise<SimulatorState> {
        this.feed.add(key, send);
        if (side !== undefined && Number.isFinite(side)) this.sides.set(key, side);
        // A device started elsewhere (Xcode, a script) shows while the pane is open; one that's running reports its own end.
        this.polling ??= setInterval(() => {
            if (this.state().status !== "ready") void refreshDevices(true).catch(() => undefined);
        }, 5000);
        this.polling.unref?.();
        const state = await this.refresh();
        const a = this.udid && attached.get(this.udid);
        if (a) updateStream(a, true);
        return state;
    }

    unwatch(key: object) {
        this.feed.remove(key);
        this.sides.delete(key);
        this.letGo();
        if (!this.watched && this.polling) {
            clearInterval(this.polling);
            this.polling = undefined;
        }
        const a = this.udid && attached.get(this.udid);
        if (a) updateStream(a);
    }

    /** Lifts a finger and releases keys the person left down (their window closed mid-touch). */
    private letGo() {
        if (this.watched || (!this.finger && !this.keysHeld.size)) return;
        const helper = this.udid ? attached.get(this.udid)?.helper : undefined;
        if (helper?.running) {
            if (this.finger) helper.send({ op: "touch", phase: "up", ...this.finger });
            if (this.keysHeld.size) helper.send({ op: "keys", keys: [...this.keysHeld].map((u) => [u, false]) });
        }
        this.finger = undefined;
        this.keysHeld.clear();
    }

    ack(key: object, frameId: string) {
        this.feed.ack(key, frameId);
    }

    /** A picture from the device's helper. */
    frame(f: ScreenFrame) {
        if (this.watched) this.feed.push(f);
    }

    /** What the person did in the pane. */
    async input(input: SimulatorInput): Promise<void> {
        const helper = await this.running();
        this.touched = true;
        switch (input.kind) {
            case "touch":
                this.finger = input.phase === "up" ? undefined : { x: input.x, y: input.y };
                // A move goes unanswered so the next follows at once; a touch going down or up is waited for, in order.
                if (input.phase === "move") helper.send({ op: "touch", phase: "move", x: input.x, y: input.y });
                else await helper.call({ op: "touch", phase: input.phase, x: input.x, y: input.y });
                break;
            case "key": {
                const usage = usageOfCode(input.code);
                if (usage === undefined) break;
                if (input.down) this.keysHeld.add(usage);
                else this.keysHeld.delete(usage);
                await helper.call({ op: "keys", keys: [[usage, input.down]] });
                break;
            }
            case "button":
                await helper.call({ op: "button", name: input.name });
                break;
            case "text":
                await this.typeText(helper, input.text);
                break;
        }
    }

    /** The device menu: use a device, start the session's, or shut it down. */
    async command(command: "select" | "boot" | "shutdown", udid?: string): Promise<SimulatorState> {
        if (!this.enabled) throw new SimulatorError(TURNED_OFF);
        await refreshDevices(true);
        if (udid !== undefined) this.select(udid);
        const d = this.device();
        if (command === "boot") {
            if (!d) throw new SimulatorError("There's no simulator to start. Add one in Xcode.");
            this.select(d.udid);
            await this.bootDevice(d);
        } else if (command === "shutdown" && d) await this.shutdownDevice(d);
        else if (command === "select" && d?.state === "booted" && this.watched) void this.adopt(d.udid).catch(() => undefined);
        return this.state();
    }

    private select(udid: string) {
        if (!devices.some((d) => d.udid === udid)) throw new SimulatorError("There's no such simulator.");
        if (this.udid === udid) return;
        if (this.udid) detach(this.udid, this);
        this.udid = udid;
        this.refs.clear();
        this.announce();
    }

    /** Starts the device (if it isn't running) and attaches to it. */
    private async bootDevice(d: SimulatorDevice, signal?: AbortSignal): Promise<void> {
        if (d.state !== "booted") {
            booting.add(d.udid);
            announceAll();
            try {
                await simctl.boot(d.udid, signal);
            } finally {
                booting.delete(d.udid);
                await refreshDevices(true).catch(() => undefined);
                announceAll();
            }
        }
        await this.adopt(d.udid);
    }

    private async shutdownDevice(d: SimulatorDevice, signal?: AbortSignal): Promise<void> {
        stopping.add(d.udid);
        announceAll();
        try {
            stopHelper(d.udid);
            await simctl.shutdown(d.udid, signal);
        } finally {
            stopping.delete(d.udid);
            await refreshDevices(true).catch(() => undefined);
            announceAll();
        }
    }

    /** Uses a booted device: its helper runs for this session. */
    private async adopt(udid: string): Promise<SimHelper> {
        this.udid = udid;
        const helper = await helperFor(udid, this);
        this.announce();
        return helper;
    }

    /** The helper of the session's device, which must be running. */
    private async running(): Promise<SimHelper> {
        if (!this.enabled) throw new SimulatorError(TURNED_OFF);
        const available = await simctl.simulatorsAvailable();
        if (!available.ok) throw new SimulatorError(available.error);
        await refreshDevices();
        const d = this.device();
        if (!d || d.state !== "booted") throw new SimulatorError(`No simulator is running. Start one with SimulatorControl action=boot${d ? ` (${d.name} is ${d.state === "shutdown" ? "shut down" : d.state.replace("_", " ")})` : ""}.`);
        return this.adopt(d.udid);
    }

    // -----------------------------------------------------------------------
    // The agent

    /** The agent did something: the window is told (a dot on the pane's tab), and the person's use since is forgotten. */
    private agentActs() {
        this.agentAt = Date.now();
        this.announce();
    }

    /** The devices as the agent reads them. */
    async devicesText(): Promise<string> {
        await refreshDevices(true);
        const mine = this.device();
        if (!devices.length) return "There are no iOS simulators. Add one in Xcode (Window > Devices and Simulators).";
        const lines = devices.slice(0, 40).map((d) => `- ${d.name} (${d.runtime}) ${d.state === "booted" ? "booted" : d.state.replace("_", " ")}${d.udid === mine?.udid ? ", this session's" : ""} [${d.udid}]`);
        return `Simulators:\n${lines.join("\n")}${devices.length > 40 ? `\n… and ${devices.length - 40} more` : ""}`;
    }

    /** A device by name ("iPhone 17", "iPhone 17 iOS 27.0") or UDID; the session's when none is named. */
    private async find(name: string | undefined): Promise<SimulatorDevice> {
        await refreshDevices(true);
        if (!name) {
            const d = this.device();
            if (!d) throw new SimulatorError("There are no iOS simulators. Add one in Xcode.");
            return d;
        }
        const n = name.trim().toLowerCase();
        const match = devices.find((d) => d.udid.toLowerCase() === n) ?? devices.find((d) => `${d.name} ${d.runtime}`.toLowerCase() === n) ?? devices.find((d) => d.name.toLowerCase() === n);
        if (!match) throw new SimulatorError(`There's no simulator named "${name}". SimulatorControl action=list shows them.`);
        return match;
    }

    /** Starts a device and uses it. `started`: it was off, so its screen is still filling in (steadySnapshot). */
    async boot(name: string | undefined, signal?: AbortSignal): Promise<{ device: SimulatorDevice; started: boolean }> {
        const d = await this.find(name);
        this.select(d.udid);
        this.agentActs();
        const started = d.state !== "booted";
        await this.bootDevice(d, signal);
        return { device: this.device()!, started };
    }

    /**
     * The screen once it has filled in: a device that has just started shows its home screen before its icons are
     * there to read. Read each second until two reads agree, at most `timeoutMs`.
     */
    async steadySnapshot(timeoutMs = 15_000, signal?: AbortSignal): Promise<string> {
        const end = Date.now() + timeoutMs;
        let last = await this.snapshot();
        while (Date.now() < end) {
            if (signal?.aborted) throw new SimulatorError("Interrupted by user.");
            await sleep(1000);
            const next = await this.snapshot();
            const body = (s: string) => s.split("\n").slice(2).join("\n");
            if (body(next) === body(last) && body(next).split("\n").length > 3) return next;
            last = next;
        }
        return last;
    }

    async shutdown(name: string | undefined, signal?: AbortSignal): Promise<SimulatorDevice> {
        const d = await this.find(name);
        this.agentActs();
        if (d.state !== "shutdown") await this.shutdownDevice(d, signal);
        return d;
    }

    async install(app: string, signal?: AbortSignal): Promise<string | undefined> {
        await this.running();
        this.agentActs();
        await simctl.install(this.udid!, app, signal);
        return simctl.bundleIdOf(app);
    }

    async launch(bundleId: string, args: string[], signal?: AbortSignal): Promise<number | undefined> {
        await this.running();
        this.agentActs();
        return simctl.launch(this.udid!, bundleId, args, signal);
    }

    async terminate(bundleId: string, signal?: AbortSignal): Promise<void> {
        await this.running();
        this.agentActs();
        await simctl.terminate(this.udid!, bundleId, signal);
    }

    async openUrl(url: string, signal?: AbortSignal): Promise<void> {
        await this.running();
        this.agentActs();
        await simctl.openUrl(this.udid!, url, signal);
    }

    /** The screen's size in points, which the agent's coordinates are in. */
    private points(helper: SimHelper): { width: number; height: number } {
        const s = helper.size!;
        return { width: Math.round(s.width / s.scale), height: Math.round(s.height / s.scale) };
    }

    /** Waits for the screen to be still (an animation over), at most `timeoutMs`. */
    async settle(timeoutMs = 3000, signal?: AbortSignal): Promise<boolean> {
        const helper = await this.running();
        if (signal?.aborted) throw new SimulatorError("Interrupted by user.");
        const r = await helper.call({ op: "settle", quietMs: 300, timeoutMs }, timeoutMs + 5000);
        return r.settled === true;
    }

    /** The screen as an outline, and a note when the person used it since the agent last looked. */
    async snapshot(): Promise<string> {
        const helper = await this.running();
        const screen = this.points(helper);
        const r = await this.describe(helper);
        const o = outline((r.tree ?? {}) as AxNode, screen);
        this.refs = o.refs;
        const d = this.device();
        const head = `${d?.name ?? "Simulator"} (${d?.runtime ?? "iOS"}), ${screen.width}×${screen.height} points.`;
        const note = this.touched ? "\nThe user used the simulator since you last looked: the screen may not be where you left it." : "";
        this.touched = false;
        return `${head}${note}\n${o.text}`;
    }

    /**
     * The screen's accessibility tree. A device that has just started has nothing to read for a while, and its
     * accessibility service may not answer until its bridge restarts: after a few tries, it's restarted (at most every
     * half minute) and asked again, for up to about 20 seconds.
     */
    private async describe(helper: SimHelper): Promise<Record<string, unknown>> {
        const end = Date.now() + 25_000;
        for (let i = 0; ; i++) {
            try {
                return await helper.call({ op: "describe" });
            } catch (e) {
                if (!/Nothing on the screen/.test((e as Error).message) || Date.now() > end) throw e;
                const udid = this.udid!;
                if (i === 3 && Date.now() - (bridgeRestarted.get(udid) ?? 0) > 30_000) {
                    bridgeRestarted.set(udid, Date.now());
                    await simctl.restartBridge(udid).catch(() => undefined);
                }
                await sleep(500);
            }
        }
    }

    async screenshot(): Promise<{ png: Uint8Array; width: number; height: number; points: { width: number; height: number } }> {
        const helper = await this.running();
        const r = await helper.call({ op: "screenshot", points: true });
        if (!r.png) throw new SimulatorError("Can't read the screen.");
        return { png: r.png, width: Number(r.width), height: Number(r.height), points: this.points(helper) };
    }

    /** Where a ref or a point is, as a fraction of the screen. */
    private async at(helper: SimHelper, target: { ref?: string; x?: number; y?: number }): Promise<{ x: number; y: number; name: string }> {
        const screen = this.points(helper);
        let x: number;
        let y: number;
        let name: string;
        if (target.ref !== undefined) {
            const r = this.refs.get(target.ref.replace(/^\[|\]$/g, ""));
            if (!r) throw new SimulatorError(`There's no ref ${target.ref} in the last snapshot. Take a new one with SimulatorSnapshot.`);
            ({ x, y, name } = r);
            name = `${JSON.stringify(name)} [${target.ref}]`;
        } else {
            x = target.x!;
            y = target.y!;
            name = `${Math.round(x)},${Math.round(y)}`;
        }
        if (x < 0 || y < 0 || x > screen.width || y > screen.height) throw new SimulatorError(`${Math.round(x)},${Math.round(y)} is off the screen, which is ${screen.width}×${screen.height} points.`);
        return { x: x / screen.width, y: y / screen.height, name };
    }

    async tap(target: { ref?: string; x?: number; y?: number }, o: { count?: number; holdMs?: number } = {}): Promise<string> {
        const helper = await this.running();
        const p = await this.at(helper, target);
        this.agentActs();
        for (let i = 0; i < (o.count ?? 1); i++) {
            await helper.call({ op: "touch", phase: "down", x: p.x, y: p.y });
            await sleep(o.holdMs ?? 60);
            await helper.call({ op: "touch", phase: "up", x: p.x, y: p.y });
            if (i + 1 < (o.count ?? 1)) await sleep(90);
        }
        return `${o.holdMs ? "Long-pressed" : o.count === 2 ? "Double-tapped" : "Tapped"} ${p.name}.`;
    }

    /**
     * A finger drawn across the screen: from a ref or point to another point, or by `direction` (the way the finger
     * moves: "up" scrolls content down the page) across most of the screen or of the element at `from`.
     */
    async swipe(o: { from?: { ref?: string; x?: number; y?: number }; to?: { x: number; y: number }; direction?: "up" | "down" | "left" | "right"; durationMs?: number }): Promise<string> {
        const helper = await this.running();
        const screen = this.points(helper);
        let start = o.from ? await this.at(helper, o.from) : { x: 0.5, y: 0.5, name: "the middle of the screen" };
        let end: { x: number; y: number };
        if (o.to) end = await this.at(helper, o.to);
        else {
            const r = o.from?.ref ? this.refs.get(o.from.ref.replace(/^\[|\]$/g, "")) : undefined;
            // Across most of the element (or the screen), centered on where it starts.
            const spanX = r ? (r.frame[2] * 0.7) / screen.width : 0.6;
            const spanY = r ? (r.frame[3] * 0.7) / screen.height : 0.5;
            const dir = o.direction ?? "up";
            const dx = dir === "left" ? -spanX : dir === "right" ? spanX : 0;
            const dy = dir === "up" ? -spanY : dir === "down" ? spanY : 0;
            start = { ...start, x: clamp(start.x - dx / 2), y: clamp(start.y - dy / 2) };
            end = { x: clamp(start.x + dx), y: clamp(start.y + dy) };
        }
        this.agentActs();
        const duration = Math.min(Math.max(o.durationMs ?? 300, 50), 5000);
        const steps = Math.max(2, Math.round(duration / 16));
        await helper.call({ op: "touch", phase: "down", x: start.x, y: start.y });
        for (let i = 1; i <= steps; i++) {
            await sleep(duration / steps);
            const t = i / steps;
            await helper.call({ op: "touch", phase: "move", x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
        }
        await helper.call({ op: "touch", phase: "up", x: end.x, y: end.y });
        const pt = (p: { x: number; y: number }) => `${Math.round(p.x * screen.width)},${Math.round(p.y * screen.height)}`;
        return `Swiped from ${pt(start)} to ${pt(end)}.`;
    }

    async type(text: string, o: { ref?: string; submit?: boolean } = {}): Promise<string> {
        const helper = await this.running();
        if (o.ref) {
            await this.tap({ ref: o.ref });
            await sleep(350);
        }
        this.agentActs();
        const pasted = await this.typeText(helper, text);
        if (o.submit) await helper.call({ op: "keys", keys: strokesForPress("Enter") });
        return `${pasted ? "Pasted" : "Typed"} ${JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text)}${o.submit ? " and pressed Enter" : ""}.`;
    }

    /** Types text key by key, or pastes it when a US keyboard can't type it. Returns whether it was pasted. */
    private async typeText(helper: SimHelper, text: string): Promise<boolean> {
        const strokes = strokesForText(text);
        if (strokes) {
            // In batches, so a long text doesn't hold the helper's queue for its whole length.
            for (let i = 0; i < strokes.length; i += 64) await helper.call({ op: "keys", keys: strokes.slice(i, i + 64) });
            return false;
        }
        await simctl.pasteboard(this.udid!, text);
        await helper.call({ op: "keys", keys: strokesForPress("Meta+V") });
        return true;
    }

    async press(key: string, modifiers: string[] = []): Promise<string> {
        const helper = await this.running();
        let strokes: KeyStroke[];
        try {
            strokes = strokesForPress(key, modifiers);
        } catch (e) {
            throw new SimulatorError((e as Error).message);
        }
        this.agentActs();
        await helper.call({ op: "keys", keys: strokes });
        return `Pressed ${[...modifiers, key].join("+")}.`;
    }

    async button(name: "home" | "lock" | "siri"): Promise<string> {
        const helper = await this.running();
        this.agentActs();
        await helper.call({ op: "button", name });
        return `Pressed the ${name === "home" ? "Home" : name === "lock" ? "side (lock)" : "Siri"} button.`;
    }

    /** Waits until text shows in the outline (a label or value containing it), or for the screen to be still. */
    async waitFor(text: string | undefined, timeoutMs = 10_000, signal?: AbortSignal): Promise<string> {
        const end = Date.now() + Math.min(Math.max(timeoutMs, 100), 60_000);
        if (!text) {
            const still = await this.settle(end - Date.now(), signal);
            return still ? "The screen is still." : `The screen was still changing after ${Math.round(timeoutMs / 1000)} seconds.`;
        }
        const helper = await this.running();
        const want = text.replace(/\s+/g, " ").trim().toLowerCase();
        while (true) {
            if (signal?.aborted) throw new SimulatorError("Interrupted by user.");
            const r = await this.describe(helper);
            if (outline((r.tree ?? {}) as AxNode, this.points(helper)).texts.some((t) => t.toLowerCase().includes(want))) return `${JSON.stringify(text)} is on the screen.`;
            if (Date.now() >= end) throw new SimulatorError(`${JSON.stringify(text)} didn't show within ${Math.round(timeoutMs / 1000)} seconds.`);
            await sleep(400);
        }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        everySession.delete(this);
        if (this.polling) clearInterval(this.polling);
        if (this.announcing) clearTimeout(this.announcing);
        if (this.udid) detach(this.udid, this);
        this.listeners.clear();
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: number) => Math.min(Math.max(v, 0.02), 0.98);

/** Tests: forget the devices and helpers. */
export function resetSimulators() {
    for (const a of attached.values()) a.helper?.stop();
    attached.clear();
    devices = [];
    listedAt = 0;
    booting.clear();
    stopping.clear();
}
