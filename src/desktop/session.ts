// A session's use of the person's Mac (src/tools/desktop-tools.ts): the apps they said it may use, the refs of its
// last look, and whether they've used the Mac since. One helper (helper.swift) serves every session on the machine:
// it starts on first use and stops a minute after the last call ends.
//
// What may be touched is decided here (the pids of the session's approved apps, never one that's never offered) and
// checked by the helper right before each event goes out, against what's on the screen then.

import { neverOffered, neverOfferedMessage } from "./apps";
import { DesktopGrants, type GrantedApp } from "./grants";
import { DesktopError, DesktopHelper, HELPER_NAME, helperBinary, noteTrusted, trustedBefore, type DesktopHelperLike, type Reply } from "./helper";
import { outlineApp, refStill, type DesktopNode, type DesktopRef } from "./outline";

export { DesktopError };

const IDLE_MS = 60_000;

const PANE = "System Settings → Privacy & Security";
export const ACCESSIBILITY_LINE = `Turn on ${HELPER_NAME} in ${PANE} → Accessibility, then try again.`;
export const ACCESSIBILITY_STALE_LINE = `${HELPER_NAME} was updated, and macOS no longer counts its switch: in ${PANE} → Accessibility, remove it with −, then try again.`;
export const SCREEN_LINE = `Turn on ${HELPER_NAME} in ${PANE} → Screen & System Audio Recording, then try again.`;
export const USED_NOTE = "The user used the Mac since you last looked: the screen may not be where you left it.";
const STOPPED = "Stopped: the user used the Mac (the mouse or keyboard) during this action, so it's unfinished. Take a new snapshot before going on.";

// ---------------------------------------------------------------------------
// The helper, shared.

let shared: DesktopHelperLike | undefined;
let starting: Promise<DesktopHelperLike> | undefined;
let busy = 0;
let idle: ReturnType<typeof setTimeout> | undefined;
/** macOS has been asked to show the person its Accessibility prompt, by this helper. */
let promptedAccessibility = false;
let starter: () => Promise<DesktopHelperLike> = async () => DesktopHelper.start(await helperBinary());

/** Tests: start a fake helper instead. */
export function setDesktopHelperStarter(fn: (() => Promise<DesktopHelperLike>) | undefined) {
    starter = fn ?? (async () => DesktopHelper.start(await helperBinary()));
}

/** Tests: stop the helper and forget it. */
export function resetDesktop() {
    if (idle) clearTimeout(idle);
    idle = undefined;
    shared?.stop();
    shared = undefined;
    starting = undefined;
    busy = 0;
    promptedAccessibility = false;
}

async function helper(): Promise<DesktopHelperLike> {
    if (shared?.running) return shared;
    starting ??= (async () => {
        const h = await starter();
        await h.ready;
        h.onExit(() => {
            if (shared === h) shared = undefined;
        });
        shared = h;
        promptedAccessibility = false;
        return h;
    })().finally(() => (starting = undefined));
    return starting;
}

function stopShared() {
    shared?.stop();
    shared = undefined;
}

/** Runs `fn` with the helper; it stops a minute after nothing uses it. */
async function withHelper<T>(fn: (h: DesktopHelperLike) => Promise<T>): Promise<T> {
    if (idle) clearTimeout(idle);
    idle = undefined;
    busy++;
    try {
        return await fn(await helper());
    } finally {
        busy--;
        if (!busy) {
            idle = setTimeout(() => {
                idle = undefined;
                stopShared();
            }, IDLE_MS);
            idle.unref?.();
        }
    }
}

/** A command, with what a missing grant needs said in one line (and macOS's own prompt shown once). */
async function call(h: DesktopHelperLike, command: Record<string, unknown>, timeoutMs?: number): Promise<Reply> {
    try {
        const r = await h.call(command, timeoutMs);
        if (command.op === "look" || command.op === "open") noteTrusted();
        return r;
    } catch (e) {
        if (!(e instanceof DesktopError)) throw e;
        if (e.code === "accessibility") {
            if (!promptedAccessibility) {
                promptedAccessibility = true;
                await h.call({ op: "status", ask: "accessibility" }).catch(() => undefined);
            }
            throw new DesktopError(trustedBefore() ? ACCESSIBILITY_STALE_LINE : ACCESSIBILITY_LINE, e.code);
        }
        if (e.code === "screen") {
            await h.call({ op: "status", ask: "screen" }).catch(() => undefined);
            // A process sees a new Screen Recording grant only once it starts again.
            if (h === shared) stopShared();
            throw new DesktopError(SCREEN_LINE, e.code);
        }
        throw e;
    }
}

// ---------------------------------------------------------------------------

export interface AppInfo {
    name: string;
    bundleId: string;
    pid?: number;
    path?: string;
    front?: boolean;
    hidden?: boolean;
    running?: boolean;
}

interface Running {
    /** The session's approved apps that are running. */
    apps: AppInfo[];
    pids: number[];
    /** The app with keyboard focus. */
    front?: number;
    /** Every app running, approved or not (names only go to the agent). */
    all: AppInfo[];
    /** Cavvy, and the terminal it may run in. */
    ancestors: number[];
}

export interface DesktopSessionOptions {
    /** Tests: how long to wait for an app's tree to be still after an action. */
    settleMs?: number;
}

export interface Target {
    ref?: string;
    x?: number;
    y?: number;
}

const appList = (apps: AppInfo[], front?: number) => apps.map((a) => `${a.name}${a.pid === front ? " (in front)" : ""}`).join(", ");

export class DesktopSession {
    /** Apps the person said this session may use. Kept until the session ends. */
    readonly grants = new DesktopGrants();
    private refs = new Map<string, DesktopRef>();
    private lastRef = 0;
    /** Where the person's input stood when the agent last looked: the helper it was counted by, and the count. */
    private seen?: { helper: number; human: number };
    /** Names the agent asked for, found (validate, then the prompt and the run, look them up once). */
    private found = new Map<string, { app?: AppInfo; error?: string; at: number }>();

    constructor(private o: DesktopSessionOptions = {}) {}

    /** The apps this session may use. */
    approved(): GrantedApp[] {
        return this.grants.list();
    }

    isApproved(bundleId: string): boolean {
        return this.grants.has(bundleId);
    }

    private async running(h: DesktopHelperLike): Promise<Running> {
        const r = await call(h, { op: "apps" });
        const ancestors = Array.isArray(r.ancestors) ? (r.ancestors as number[]) : [];
        const all = (Array.isArray(r.apps) ? (r.apps as AppInfo[]) : []).filter((a) => !neverOffered({ name: a.name, bundleId: a.bundleId, own: a.pid !== undefined && ancestors.includes(a.pid) }));
        const apps = all.filter((a) => a.bundleId && this.grants.has(a.bundleId));
        const front = all.find((a) => a.front)?.pid ?? (r.apps as AppInfo[] | undefined)?.find((a) => a.front)?.pid;
        return { apps, pids: apps.map((a) => a.pid!).filter((p) => typeof p === "number"), front, all, ancestors };
    }

    /**
     * An app by the name the agent gave, as it's installed: undefined and why not, when it isn't there or is never
     * offered. Looked up once a minute at most for the same name (validating a call, then asking, then running it).
     */
    async find(name: string): Promise<{ app?: AppInfo; error?: string }> {
        const key = name.trim().toLowerCase();
        const known = this.found.get(key);
        if (known && Date.now() - known.at < 60_000) return known;
        const byName = neverOffered({ name });
        if (byName) return this.remember(key, { error: neverOfferedMessage(name, byName) });
        const r = await withHelper((h) => call(h, { op: "find", name }));
        if (r.found !== true) return this.remember(key, { error: `There's no app called ${name} on this Mac.` });
        const app = r.app as AppInfo;
        const ancestors = Array.isArray(r.ancestors) ? (r.ancestors as number[]) : [];
        const why = neverOffered({ name: app.name, bundleId: app.bundleId, own: app.pid !== undefined && ancestors.includes(app.pid) });
        return this.remember(key, why ? { error: neverOfferedMessage(app.name, why) } : { app });
    }

    private remember(key: string, v: { app?: AppInfo; error?: string }) {
        this.found.set(key, { ...v, at: Date.now() });
        return v;
    }

    /** The person said yes: the app may be used until the session ends. Says what's missing for it to work, if anything. */
    async grant(name: string): Promise<string> {
        const { app, error } = await this.find(name);
        if (!app) throw new DesktopError(error!);
        this.grants.add({ name: app.name, bundleId: app.bundleId });
        const ready = `You can use ${app.name} until this session ends.`;
        // Seeing it takes Accessibility: said now, while the person is here, rather than on the first snapshot.
        const status = await withHelper((h) => h.call({ op: "status" })).catch(() => undefined);
        if (status && status.accessibility !== true) {
            await withHelper((h) => call(h, { op: "look", pids: [] })).catch(() => undefined);
            return `${ready} ${trustedBefore() ? ACCESSIBILITY_STALE_LINE : ACCESSIBILITY_LINE}`;
        }
        return `${ready}${app.running ? "" : " It isn't running: DesktopControl action=open starts it."}`;
    }

    /** What's running, and which of it this session may use. */
    async list(): Promise<string> {
        return withHelper(async (h) => {
            const r = await this.running(h);
            const others = r.all.filter((a) => !r.apps.includes(a));
            const lines: string[] = [];
            lines.push(this.grants.size ? `Apps you may use: ${this.approved().map((g) => `${g.name}${r.apps.some((a) => a.bundleId.toLowerCase() === g.bundleId.toLowerCase()) ? (r.apps.some((a) => a.bundleId.toLowerCase() === g.bundleId.toLowerCase() && a.pid === r.front) ? " (running, in front)" : " (running)") : " (not running)"}`).join(", ")}.` : "No app is yours to use yet.");
            if (others.length) lines.push(`Other apps running: ${others.map((a) => a.name).join(", ")}.`);
            lines.push("Ask for one with DesktopControl action=request_access app=<name>.");
            return lines.join("\n");
        });
    }

    /** Brings an approved app to the front, starting it if it isn't running. */
    async open(name: string, signal?: AbortSignal): Promise<string> {
        const { app, error } = await this.find(name);
        if (!app) throw new DesktopError(error!);
        if (!this.isApproved(app.bundleId)) throw new DesktopError(`${app.name} isn't an app you may use: ask with DesktopControl action=request_access app=${app.name}.`);
        return withHelper(async (h) => {
            const r = await call(h, { op: "open", bundleId: app.bundleId }, 30_000);
            stopped(signal);
            return r.front === true ? `${app.name} is in front.` : `${app.name} is open, but not in front yet.`;
        });
    }

    /** Whether the person has used the Mac since the agent last looked (as the helper counts, which `h.human` has from its last answer). */
    private touched(h: DesktopHelperLike): boolean {
        return this.seen !== undefined && this.seen.helper === h.pid && this.seen.human !== h.human;
    }

    /** The app to read: the one named, else the approved app in front, else the first running. */
    private pick(r: Running, name?: string): AppInfo {
        if (!this.grants.size) throw new DesktopError("No app is yours to use yet: ask with DesktopControl action=request_access app=<name>.");
        if (name) {
            const want = name.trim().replace(/\.app\/?$/i, "").toLowerCase();
            const app = r.apps.find((a) => a.name.toLowerCase() === want || a.bundleId.toLowerCase() === want);
            if (app) return app;
            const known = this.approved().find((g) => g.name.toLowerCase() === want || g.bundleId.toLowerCase() === want);
            throw new DesktopError(known ? `${known.name} isn't running: DesktopControl action=open starts it.` : `${name} isn't an app you may use: ask with DesktopControl action=request_access app=${name}.`);
        }
        const app = r.apps.find((a) => a.pid === r.front) ?? r.apps[0];
        if (!app) throw new DesktopError(`None of the apps you may use is running (${this.approved().map((g) => g.name).join(", ")}). DesktopControl action=open starts one.`);
        return app;
    }

    /** An approved app as an outline, with refs for DesktopAct, and a note when the person used the Mac since the agent last looked. */
    async snapshot(name?: string): Promise<string> {
        return withHelper((h) => this.look(h, name));
    }

    private async look(h: DesktopHelperLike, name?: string): Promise<string> {
        const r = await this.running(h);
        const app = this.pick(r, name);
        const reply = await call(h, { op: "look", pid: app.pid, pids: r.pids });
        const tree = (reply.tree ?? {}) as DesktopNode & { truncated?: boolean };
        const o = outlineApp(tree, app.pid!, this.lastRef);
        const note = this.touched(h) ? `\n${USED_NOTE}` : "";
        this.refs = o.refs;
        this.lastRef = o.lastRef;
        this.seen = { helper: h.pid, human: h.human };
        const front = typeof reply.front === "number" ? reply.front : r.front;
        const head = `Apps you may use: ${appList(r.apps, front)}${r.apps.length < this.grants.size ? `; not running: ${this.approved().filter((g) => !r.apps.some((a) => a.bundleId.toLowerCase() === g.bundleId.toLowerCase())).map((g) => g.name).join(", ")}` : ""}.`;
        const away = r.pids.includes(front ?? -1) ? "" : "\nAnother app is in front: keys reach only an app you may use, so bring one to the front first (DesktopControl action=open), and clicks reach only what isn't covered.";
        const big = tree.truncated ? "\n(The app has more than the outline could read: a screenshot shows the rest.)" : "";
        return `${head}${note}${away}${big}\n${o.text}`;
    }

    /** Waits for the app's tree to stop changing (an animation, a page loading), at most `ms`. */
    private async settle(h: DesktopHelperLike, ms = this.o.settleMs ?? 1500, signal?: AbortSignal): Promise<void> {
        const end = Date.now() + ms;
        let before: string | undefined;
        await pause(Math.min(250, ms), signal);
        while (Date.now() < end) {
            const r = await this.running(h).catch(() => undefined);
            const app = r?.apps.find((a) => a.pid === r.front) ?? r?.apps[0];
            if (!app) return;
            const tree = JSON.stringify((await call(h, { op: "look", pid: app.pid, pids: r!.pids }).catch(() => ({ tree: undefined }))).tree ?? null);
            if (tree === before) return;
            before = tree;
            await pause(200, signal);
        }
    }

    /**
     * Runs an action: the helper is told to stop if the turn is (Esc), and what it says when the person took over
     * becomes the result. Returns what was done and the app's outline after it.
     */
    private act(signal: AbortSignal | undefined, fn: (h: DesktopHelperLike, r: Running) => Promise<string>): Promise<string> {
        return withHelper(async (h) => {
            stopped(signal);
            const r = await this.running(h);
            if (!this.grants.size) throw new DesktopError("No app is yours to use yet: ask with DesktopControl action=request_access app=<name>.");
            if (!r.pids.length) throw new DesktopError(`None of the apps you may use is running (${this.approved().map((g) => g.name).join(", ")}). DesktopControl action=open starts one.`);
            const cancel = () => h.cancel();
            signal?.addEventListener("abort", cancel, { once: true });
            let done: string;
            try {
                done = await fn(h, r);
            } catch (e) {
                if (signal?.aborted || (e instanceof DesktopError && e.code === "cancelled")) throw new DesktopError("Interrupted by user.", "cancelled");
                if (e instanceof DesktopError && e.code?.startsWith("human")) {
                    // What it saw, so the agent knows where things are; the refs are new, the person's use is said.
                    const screen = await this.look(h).catch(() => "");
                    throw new DesktopError(`${STOPPED}${e.code.includes(":") ? ` (${e.code.split(":")[1]} characters were typed.)` : ""}${screen ? `\n\n${screen}` : ""}`, "human");
                }
                throw e;
            } finally {
                signal?.removeEventListener("abort", cancel);
            }
            await this.settle(h, undefined, signal).catch(() => undefined);
            const screen = await this.look(h).catch((e) => `The app couldn't be read: ${(e as Error).message}`);
            return `${done}\n\n${screen}`;
        });
    }

    /**
     * Where a ref or a point is. A ref is used up by its use; it's refused, with the app as it is now, when the
     * person used the Mac since the agent looked, or what it stood for isn't there any more.
     */
    private async at(h: DesktopHelperLike, r: Running, target: Target): Promise<{ x: number; y: number; name: string; ref?: DesktopRef }> {
        if (target.ref === undefined) {
            if (typeof target.x !== "number" || typeof target.y !== "number") throw new DesktopError("Give a ref, or both x and y.");
            return { x: target.x, y: target.y, name: `${Math.round(target.x)},${Math.round(target.y)}` };
        }
        const key = target.ref.replace(/^\[|\]$/g, "");
        const ref = this.refs.get(key);
        if (!ref) throw new DesktopError(`There's no ref ${target.ref} in the last snapshot. Take a new one with DesktopSnapshot.`);
        this.refs = new Map();
        // Read again now: what's there, and the person's use since.
        const now = await call(h, { op: "look", pid: ref.pid, pids: r.pids }).catch(() => undefined);
        if (!this.seen || this.seen.helper !== h.pid || this.touched(h)) throw new DesktopError(`Not done: ${target.ref} may not be what it was.\n\n${await this.look(h)}`);
        const still = now?.tree ? refStill(ref, now.tree as DesktopNode) : undefined;
        if (still === undefined) throw new DesktopError(`Not done: ${target.ref} isn't there any more: the app has changed.\n\n${await this.look(h)}`);
        return { x: ref.x, y: ref.y, name: `${JSON.stringify(still)} [${target.ref}]`, ref };
    }

    async click(target: Target, o: { button?: "left" | "right"; count?: number } = {}, signal?: AbortSignal): Promise<string> {
        return this.act(signal, async (h, r) => {
            const p = await this.at(h, r, target);
            await call(h, { op: "click", x: p.x, y: p.y, button: o.button ?? "left", count: o.count ?? 1, pids: r.pids });
            return `${o.button === "right" ? "Right-clicked" : o.count === 2 ? "Double-clicked" : "Clicked"} ${p.name}.`;
        });
    }

    async drag(from: Target, to: { x: number; y: number }, durationMs = 300, signal?: AbortSignal): Promise<string> {
        return this.act(signal, async (h, r) => {
            const p = await this.at(h, r, from);
            await call(h, { op: "drag", x: p.x, y: p.y, toX: to.x, toY: to.y, durationMs, pids: r.pids }, durationMs + 10_000);
            return `Dragged from ${p.name} to ${Math.round(to.x)},${Math.round(to.y)}.`;
        });
    }

    async scroll(target: Target, direction: "up" | "down" | "left" | "right", amount = 5, signal?: AbortSignal): Promise<string> {
        return this.act(signal, async (h, r) => {
            let p: { x: number; y: number; name: string };
            if (target.ref !== undefined || typeof target.x === "number") p = await this.at(h, r, target);
            else {
                // The middle of the approved app's front window.
                const look = await call(h, { op: "look", pids: r.pids });
                const w = (look.windows as { pid: number; frame: number[] }[] | undefined)?.find((x) => x.pid === r.front) ?? (look.windows as { frame: number[] }[] | undefined)?.[0];
                if (!w) throw new DesktopError("No window of an app you may use is on the screen.");
                p = { x: w.frame[0]! + w.frame[2]! / 2, y: w.frame[1]! + w.frame[3]! / 2, name: "the window" };
            }
            const lines = Math.max(1, Math.min(50, Math.round(amount)));
            // Wheel lines: positive moves the content down (shows what's above).
            const dy = direction === "up" ? lines : direction === "down" ? -lines : 0;
            const dx = direction === "left" ? lines : direction === "right" ? -lines : 0;
            await call(h, { op: "scroll", x: p.x, y: p.y, dx, dy, pids: r.pids });
            return `Scrolled ${direction} ${lines} lines at ${p.name}.`;
        });
    }

    async type(text: string, o: { ref?: string; submit?: boolean; clear?: boolean } = {}, signal?: AbortSignal): Promise<string> {
        return this.act(signal, async (h, r) => {
            let into = "";
            let secure = false;
            if (o.ref !== undefined) {
                const p = await this.at(h, r, { ref: o.ref });
                secure = Boolean(p.ref?.secure);
                await call(h, { op: "click", x: p.x, y: p.y, button: "left", count: 1, pids: r.pids });
                await pause(150, signal);
                into = ` into ${p.name}`;
            }
            if (o.clear) {
                await call(h, { op: "press", key: "a", modifiers: ["cmd"], pids: r.pids });
                await call(h, { op: "press", key: "backspace", modifiers: [], pids: r.pids });
            }
            if (text) await call(h, { op: "type", text, pids: r.pids }, 20_000 + text.length * 60);
            if (o.submit) await call(h, { op: "press", key: "enter", modifiers: [], pids: r.pids });
            const what = secure ? `${[...text].length} characters` : JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text);
            return !text && o.clear ? `Cleared${into || " the field"}.` : `Typed ${what}${into}${o.submit ? " and pressed Enter" : ""}.`;
        });
    }

    async press(key: string, modifiers: string[] = [], signal?: AbortSignal): Promise<string> {
        const k = parseKey(key, modifiers);
        if (typeof k === "string") throw new DesktopError(k);
        return this.act(signal, async (h, r) => {
            await call(h, { op: "press", key: k.key, modifiers: k.modifiers, pids: r.pids });
            return `Pressed ${key}${modifiers.length ? ` with ${modifiers.join("+")}` : ""}.`;
        });
    }

    /** Waits for text to show in the approved app in front (or for it to be still), at most `timeoutMs`. */
    async waitFor(text: string | undefined, timeoutMs = 10_000, signal?: AbortSignal): Promise<string> {
        const limit = Math.max(500, Math.min(60_000, timeoutMs));
        return withHelper(async (h) => {
            if (!text) {
                await this.settle(h, limit, signal);
                return `The app is still.\n\n${await this.look(h)}`;
            }
            const want = text.toLowerCase();
            const end = Date.now() + limit;
            while (true) {
                const r = await this.running(h);
                const app = this.pick(r);
                const reply = await call(h, { op: "look", pid: app.pid, pids: r.pids });
                const o = outlineApp((reply.tree ?? {}) as DesktopNode, app.pid!, this.lastRef);
                if (o.texts.some((t) => t.toLowerCase().includes(want))) return `"${text}" is showing.\n\n${await this.look(h)}`;
                if (Date.now() >= end) return `"${text}" didn't show in ${Math.round(limit / 1000)} seconds.\n\n${await this.look(h)}`;
                await pause(400, signal);
            }
        });
    }

    /** The approved apps' windows, and nothing else on the screen. */
    async screenshot(): Promise<{ png: Uint8Array; x: number; y: number; width: number; height: number; apps: string }> {
        return withHelper(async (h) => {
            const r = await this.running(h);
            if (!this.grants.size) throw new DesktopError("No app is yours to use yet: ask with DesktopControl action=request_access app=<name>.");
            if (!r.pids.length) throw new DesktopError("None of the apps you may use is running.");
            const shot = await call(h, { op: "screenshot", pids: r.pids }, 20_000);
            return { png: new Uint8Array(Buffer.from(String(shot.png), "base64")), x: Number(shot.x), y: Number(shot.y), width: Number(shot.width), height: Number(shot.height), apps: appList(r.apps, r.front) };
        });
    }

    dispose() {
        this.refs = new Map();
    }
}

// ---------------------------------------------------------------------------

const MODIFIERS: Record<string, string> = { meta: "cmd", cmd: "cmd", command: "cmd", control: "ctrl", ctrl: "ctrl", alt: "alt", option: "alt", opt: "alt", shift: "shift" };
const KEYS: Record<string, string> = {
    enter: "enter",
    return: "enter",
    tab: "tab",
    space: "space",
    backspace: "backspace",
    delete: "delete",
    escape: "escape",
    esc: "escape",
    arrowup: "arrowup",
    up: "arrowup",
    arrowdown: "arrowdown",
    down: "arrowdown",
    arrowleft: "arrowleft",
    left: "arrowleft",
    arrowright: "arrowright",
    right: "arrowright",
    home: "home",
    end: "end",
    pageup: "pageup",
    pagedown: "pagedown",
};
for (let i = 1; i <= 12; i++) KEYS[`f${i}`] = `f${i}`;

/** A key as the agent names it ("Enter", "Meta+Shift+Z", "a") and the modifiers it lists, as the helper takes them; or why not. */
export function parseKey(key: string, modifiers: string[] = []): { key: string; modifiers: string[] } | string {
    // "+" is a key too: "Meta++".
    const plus = key === "+" || key.endsWith("++");
    const parts = (plus ? key.slice(0, -1) : key).split("+").filter(Boolean);
    const last = plus ? "+" : (parts.pop() ?? "");
    const mods = new Set<string>();
    for (const m of [...parts, ...modifiers]) {
        const v = MODIFIERS[m.trim().toLowerCase()];
        if (!v) return `Unknown modifier "${m}": use Control, Shift, Alt or Meta.`;
        mods.add(v);
    }
    const named = KEYS[last.trim().toLowerCase()];
    if (named) return { key: named, modifiers: [...mods] };
    // A letter is its key, whatever its case: Shift is a modifier ("Meta+S" is Command-S).
    if ([...last].length === 1) return { key: /^[A-Z]$/.test(last) ? last.toLowerCase() : last, modifiers: [...mods] };
    return `Unknown key "${last}": use a character, or Enter, Tab, Space, Backspace, Delete, Escape, the arrows, Home, End, PageUp, PageDown or F1 to F12.`;
}

function stopped(signal?: AbortSignal) {
    if (signal?.aborted) throw new DesktopError("Interrupted by user.", "cancelled");
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
    stopped(signal);
    await new Promise<void>((resolve) => {
        const t = setTimeout(done, ms);
        function done() {
            clearTimeout(t);
            signal?.removeEventListener("abort", done);
            resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
    });
    stopped(signal);
}
