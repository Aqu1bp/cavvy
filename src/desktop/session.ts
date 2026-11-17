// A session's use of the person's Mac (src/tools/desktop-tools.ts): the apps they said it may use, the refs of its
// last look, and whether they've used the Mac since. One helper (helper.swift) serves every session on the machine:
// it starts on first use and stops a minute after the last call ends.
//
// What may be touched is decided here (the pids of the session's approved apps, never one that's never offered) and
// checked by the helper right before each event goes out, against what's on the screen then.

import { randomBytes } from "crypto";
import { neverOffered, neverOfferedMessage } from "./apps";
import { DesktopGrants, type GrantedApp } from "./grants";
import { homedir } from "os";
import { DesktopError, DesktopHelper, HELPER_NAME, helperBinary, helperDir, noteTrusted, trustedBefore, type DesktopHelperLike, type Reply } from "./helper";
import { outlineApp, refStill, type DesktopNode, type DesktopRef } from "./outline";

export { DesktopError };

const IDLE_MS = 60_000;

const PANE = "System Settings → Privacy & Security";
// Newer macOS lists the apps that may control the Mac under "Device Control and Data Access" (seen on 27.0, which
// version first did isn't known here); earlier ones, under "Accessibility".
const CONTROL = `${PANE} → Accessibility (on newer macOS, Device Control and Data Access)`;
const SCREEN = `${PANE} → Screen & System Audio Recording`;
export const ACCESSIBILITY_LINE = `Turn on ${HELPER_NAME} in ${CONTROL}, then try again.`;
export const SCREEN_LINE = `Turn on ${HELPER_NAME} in ${SCREEN}, then try again.`;

/**
 * A new build of the helper, where an earlier one had the grant: macOS shows the switch on but no longer counts it,
 * and asks nothing (seen on macOS 27.0). Taking it out and adding it again is what works.
 */
export function staleLine(g: "accessibility" | "screen"): string {
    const dir = helperDir();
    const where = dir.startsWith(`${homedir()}/`) ? `~${dir.slice(homedir().length)}` : dir;
    return `${HELPER_NAME} was updated, and macOS no longer counts its switch: in ${g === "screen" ? SCREEN : CONTROL}, remove it with −, add it again with + (it's in ${where}) and turn it on, then try again.`;
}
const NO_APPS = "No app is yours to use yet: ask with DesktopControl action=request_access app=<name>.";
export const WATCH_LINE = `In ${PANE}, check that ${HELPER_NAME} is on under Accessibility (on newer macOS, Device Control and Data Access) and Input Monitoring, then try again.`;
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

/**
 * A tree as text with each node's keys in one order, to tell whether the app changed: the helper's JSON lists them in
 * any order, read to read (Swift's dictionaries have none), so the same app can come back as different text.
 */
function sameKeys(v: unknown): string {
    return JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
}

/** Has macOS show its Accessibility prompt (once for each helper), and says in one line what to turn on. */
async function askAccessibility(h: DesktopHelperLike): Promise<string> {
    if (!promptedAccessibility) {
        promptedAccessibility = true;
        await h.call({ op: "status", ask: "accessibility" }).catch(() => undefined);
    }
    return trustedBefore("accessibility") ? staleLine("accessibility") : ACCESSIBILITY_LINE;
}

/** A command, with what a missing grant needs said in one line (and macOS's own prompt shown once). */
async function call(h: DesktopHelperLike, command: Record<string, unknown>, timeoutMs?: number): Promise<Reply> {
    try {
        const r = await h.call(command, timeoutMs);
        if (command.op === "look" || command.op === "open") noteTrusted("accessibility");
        if (command.op === "screenshot") noteTrusted("screen");
        return r;
    } catch (e) {
        if (!(e instanceof DesktopError)) throw e;
        if (e.code === "accessibility") throw new DesktopError(await askAccessibility(h), e.code);
        if (e.code === "screen") {
            await h.call({ op: "status", ask: "screen" }).catch(() => undefined);
            // A process sees a new Screen Recording grant only once it starts again.
            if (h === shared) stopShared();
            throw new DesktopError(trustedBefore("screen") ? staleLine("screen") : SCREEN_LINE, e.code);
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

/** An app just read: what's running, which app, and what the helper said. */
interface Read {
    r: Running;
    app: AppInfo;
    reply: Reply;
}

/** An action under way: its commands go through `send`, which checks the signal first and adds the action's token. */
interface Acting {
    h: DesktopHelperLike;
    r: Running;
    send: (command: Record<string, unknown>, timeoutMs?: number) => Promise<Reply>;
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
    /** Where the person's use of the Mac stood when the agent last looked: the helper it was counted by, and the count. */
    private seen?: { helper: number; used: number };
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
    async find(name: string, o: { asked?: boolean } = {}): Promise<{ app?: AppInfo; error?: string }> {
        const key = name.trim().toLowerCase();
        const known = this.found.get(key);
        // `asked`: the app the person was asked about, however long they took (not one found by that name since).
        if (known && (o.asked || Date.now() - known.at < 60_000)) return known;
        const byName = neverOffered({ name });
        if (byName) return this.remember(key, { error: neverOfferedMessage(name, byName) });
        const r = await withHelper((h) => call(h, { op: "find", name }));
        if (r.found !== true) return this.remember(key, { error: `There's no app called ${name} on this Mac.` });
        const app = r.app as AppInfo;
        // Grants are kept by bundle id: an app without one can't be given.
        if (!app.bundleId) return this.remember(key, { error: `${app.name} can't be used.` });
        const ancestors = Array.isArray(r.ancestors) ? (r.ancestors as number[]) : [];
        const own = app.pid !== undefined && ancestors.includes(app.pid);
        const why = neverOffered({ name: app.name, bundleId: app.bundleId, own });
        return this.remember(key, why ? { error: neverOfferedMessage(app.name, why, own) } : { app });
    }

    private remember(key: string, v: { app?: AppInfo; error?: string }) {
        this.found.set(key, { ...v, at: Date.now() });
        return v;
    }

    /** The person said yes: the app may be used until the session ends. Says what's missing for it to work, if anything. */
    async grant(name: string): Promise<string> {
        const { app, error } = await this.find(name, { asked: true });
        if (!app) throw new DesktopError(error!);
        this.grants.add({ name: app.name, bundleId: app.bundleId });
        const ready = `You can use ${app.name} until this session ends.`;
        // Seeing it takes Accessibility: said now, while the person is here, rather than on the first snapshot.
        const missing = await withHelper(async (h) => ((await h.call({ op: "status" })).accessibility === true ? undefined : askAccessibility(h))).catch(() => undefined);
        if (missing) return `${ready} ${missing}`;
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

    /**
     * Whether the person has used the session's apps since the agent last looked: clicked, typed or scrolled in them
     * (input elsewhere, Cavvy's prompts included, doesn't count), as `reply` (a look at them) counts. A helper started
     * since couldn't count: undefined.
     */
    private touched(h: DesktopHelperLike, reply: Reply | undefined): boolean | undefined {
        if (!this.seen || !reply) return false;
        if (this.seen.helper !== h.pid) return undefined;
        return this.seen.used !== Number(reply.used ?? 0);
    }

    /** What a ref stands for, as the person is asked about it ("button \"Bold\""), if the last outline had it. */
    refName(ref: string): string | undefined {
        const r = this.refs.get(ref.replace(/^\[|\]$/g, ""));
        if (!r) return undefined;
        const role = r.role.replace(/^AX/, "").toLowerCase() || "element";
        return r.name && r.name.toLowerCase() !== role ? `${role} ${JSON.stringify(r.name.length > 60 ? `${r.name.slice(0, 60)}…` : r.name)}` : role;
    }

    /** The app to read: the one named, else the approved app in front, else the first running. */
    private pick(r: Running, name?: string): AppInfo {
        if (!this.grants.size) throw new DesktopError(NO_APPS);
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

    /** The app as an outline. `read`: what was just read (settle's last look), used rather than read again. */
    private async look(h: DesktopHelperLike, name?: string, read?: Read): Promise<string> {
        const r = read?.r ?? (await this.running(h));
        const app = read?.app ?? this.pick(r, name);
        const reply = read?.reply ?? (await call(h, { op: "look", pid: app.pid, pids: r.pids }));
        const tree = (reply.tree ?? {}) as DesktopNode & { truncated?: boolean };
        const o = outlineApp(tree, app.pid!, this.lastRef);
        const note = this.touched(h, reply) ? `\n${USED_NOTE}` : "";
        this.refs = o.refs;
        this.lastRef = o.lastRef;
        this.seen = { helper: h.pid, used: Number(reply.used ?? 0) };
        const front = typeof reply.front === "number" ? reply.front : r.front;
        const head = `Apps you may use: ${appList(r.apps, front)}${r.apps.length < this.grants.size ? `; not running: ${this.approved().filter((g) => !r.apps.some((a) => a.bundleId.toLowerCase() === g.bundleId.toLowerCase())).map((g) => g.name).join(", ")}` : ""}.`;
        const away = r.pids.includes(front ?? -1) ? "" : "\nAnother app is in front: keys reach only an app you may use, so bring one to the front first (DesktopControl action=open), and clicks reach only what isn't covered.";
        const big = tree.truncated ? "\n(The app has more than the outline could read: a screenshot shows the rest.)" : "";
        return `${head}${note}${away}${big}\n${o.text}`;
    }

    /**
     * Waits for the app's tree to stop changing (an animation, a page loading), at most `ms`. Returns the last read
     * once it's still, for the outline after an action.
     */
    private async settle(h: DesktopHelperLike, ms = this.o.settleMs ?? 1500, signal?: AbortSignal): Promise<Read | undefined> {
        const end = Date.now() + ms;
        let before: string | undefined;
        await pause(Math.min(250, ms), signal);
        while (Date.now() < end) {
            const r = await this.running(h).catch(() => undefined);
            const app = r?.apps.find((a) => a.pid === r.front) ?? r?.apps[0];
            if (!r || !app) return undefined;
            const reply = await call(h, { op: "look", pid: app.pid, pids: r.pids }).catch(() => undefined);
            if (!reply) return undefined;
            const tree = sameKeys(reply.tree ?? null);
            if (tree === before) return { r, app, reply };
            before = tree;
            await pause(200, signal);
        }
        return undefined;
    }

    /**
     * Runs an action. Every command it sends carries a token of its own, and the signal is checked before each: Esc
     * stops what hasn't gone yet, and the helper stops what's under way with that token (another session's goes on).
     * What the helper says when the person took over becomes the result. Returns what was done and the app after it.
     */
    private act(signal: AbortSignal | undefined, fn: (a: Acting) => Promise<string>): Promise<string> {
        return withHelper(async (h) => {
            const token = randomBytes(8).toString("hex");
            const cancel = () => h.cancel(token);
            signal?.addEventListener("abort", cancel, { once: true });
            let done: string;
            try {
                stopped(signal);
                const r = await this.running(h);
                if (!this.grants.size) throw new DesktopError(NO_APPS);
                if (!r.pids.length) throw new DesktopError(`None of the apps you may use is running (${this.approved().map((g) => g.name).join(", ")}). DesktopControl action=open starts one.`);
                const send = (command: Record<string, unknown>, timeoutMs?: number) => {
                    stopped(signal);
                    return call(h, { ...command, token }, timeoutMs);
                };
                done = await fn({ h, r, send });
            } catch (e) {
                const code = e instanceof DesktopError ? (e.code ?? "") : "";
                const [kind, count] = code.split(":");
                // Gone quiet: whatever it's still doing for this action stops.
                if (kind === "timeout") h.cancel(token);
                if (signal?.aborted || kind === "cancelled") throw new DesktopError("Interrupted by user.", "cancelled");
                const typed = count ? ` (${count} characters were typed.)` : "";
                if (kind === "human") {
                    // What it saw, so the agent knows where things are; the refs are new, the person's use is said.
                    const screen = await this.look(h).catch(() => "");
                    throw new DesktopError(`${STOPPED}${typed}${screen ? `\n\n${screen}` : ""}`, "human");
                }
                if (kind === "watch") throw new DesktopError(`${(e as Error).message} ${WATCH_LINE}`, kind);
                if (typed) throw new DesktopError(`${(e as Error).message}${typed}`, kind);
                throw e;
            } finally {
                signal?.removeEventListener("abort", cancel);
            }
            const read = await this.settle(h, undefined, signal).catch(() => undefined);
            const screen = await this.look(h, undefined, read).catch((e) => `The app couldn't be read: ${(e as Error).message}`);
            return `${done}\n\n${screen}`;
        });
    }

    /**
     * Where a ref or a point is. A ref is used up by its use, and looked for again first: it's refused, with the app as
     * it is now, when what it stood for isn't there any more, or the person clicked, typed or scrolled since the agent
     * looked. (A helper started since couldn't watch: what's there decides alone.)
     */
    private async at(a: Acting, target: Target): Promise<{ x: number; y: number; name: string; ref?: DesktopRef }> {
        if (target.ref === undefined) {
            if (typeof target.x !== "number" || typeof target.y !== "number") throw new DesktopError("Give a ref, or both x and y.");
            return { x: target.x, y: target.y, name: `${Math.round(target.x)},${Math.round(target.y)}` };
        }
        const key = target.ref.replace(/^\[|\]$/g, "");
        const ref = this.refs.get(key);
        if (!ref) throw new DesktopError(`There's no ref ${target.ref} in the last snapshot. Take a new one with DesktopSnapshot.`);
        this.refs = new Map();
        const now = await a.send({ op: "look", pid: ref.pid, pids: a.r.pids }).catch((e: Error) => {
            if (e instanceof DesktopError && e.code === "cancelled") throw e;
            return undefined;
        });
        if (this.touched(a.h, now)) throw new DesktopError(`Not done: ${target.ref} may not be what it was.\n\n${await this.look(a.h)}`);
        const still = now?.tree ? refStill(ref, now.tree as DesktopNode) : undefined;
        if (still === undefined) throw new DesktopError(`Not done: ${target.ref} isn't there any more: the app has changed.\n\n${await this.look(a.h)}`);
        return { x: ref.x, y: ref.y, name: `${JSON.stringify(still)} [${target.ref}]`, ref };
    }

    async click(target: Target, o: { button?: "left" | "right"; count?: number } = {}, signal?: AbortSignal): Promise<string> {
        return this.act(signal, async (a) => {
            const p = await this.at(a, target);
            await a.send({ op: "click", x: p.x, y: p.y, button: o.button ?? "left", count: o.count ?? 1, pids: a.r.pids });
            return `${o.button === "right" ? "Right-clicked" : o.count === 2 ? "Double-clicked" : "Clicked"} ${p.name}.`;
        });
    }

    async drag(from: Target, to: { x: number; y: number }, durationMs = 300, signal?: AbortSignal): Promise<string> {
        return this.act(signal, async (a) => {
            const p = await this.at(a, from);
            await a.send({ op: "drag", x: p.x, y: p.y, toX: to.x, toY: to.y, durationMs, pids: a.r.pids }, durationMs + 10_000);
            return `Dragged from ${p.name} to ${Math.round(to.x)},${Math.round(to.y)}.`;
        });
    }

    async scroll(target: Target, direction: "up" | "down" | "left" | "right", amount = 5, signal?: AbortSignal): Promise<string> {
        return this.act(signal, async (a) => {
            let p: { x: number; y: number; name: string };
            if (target.ref !== undefined || typeof target.x === "number") p = await this.at(a, target);
            else {
                // The middle of the approved app's front window.
                const look = await a.send({ op: "look", pids: a.r.pids });
                const w = (look.windows as { pid: number; frame: number[] }[] | undefined)?.find((x) => x.pid === a.r.front) ?? (look.windows as { frame: number[] }[] | undefined)?.[0];
                if (!w) throw new DesktopError("No window of an app you may use is on the screen.");
                p = { x: w.frame[0]! + w.frame[2]! / 2, y: w.frame[1]! + w.frame[3]! / 2, name: "the window" };
            }
            const lines = Math.max(1, Math.min(50, Math.round(amount)));
            // Wheel lines: positive moves the content down (shows what's above).
            const dy = direction === "up" ? lines : direction === "down" ? -lines : 0;
            const dx = direction === "left" ? lines : direction === "right" ? -lines : 0;
            await a.send({ op: "scroll", x: p.x, y: p.y, dx, dy, pids: a.r.pids });
            return `Scrolled ${direction} ${lines} lines at ${p.name}.`;
        });
    }

    async type(text: string, o: { ref?: string; submit?: boolean; clear?: boolean } = {}, signal?: AbortSignal): Promise<string> {
        return this.act(signal, async (a) => {
            let into = "";
            let secure = false;
            if (o.ref !== undefined) {
                const p = await this.at(a, { ref: o.ref });
                secure = Boolean(p.ref?.secure);
                await a.send({ op: "click", x: p.x, y: p.y, button: "left", count: 1, pids: a.r.pids });
                await pause(150, signal);
                into = ` into ${p.name}`;
            }
            if (o.clear) {
                await a.send({ op: "press", key: "a", modifiers: ["cmd"], pids: a.r.pids });
                await a.send({ op: "press", key: "backspace", modifiers: [], pids: a.r.pids });
            }
            if (text) await a.send({ op: "type", text, pids: a.r.pids }, 20_000 + text.length * 60);
            if (o.submit) await a.send({ op: "press", key: "enter", modifiers: [], pids: a.r.pids });
            const what = secure ? `${[...text].length} characters` : JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text);
            return !text && o.clear ? `Cleared${into || " the field"}.` : `Typed ${what}${into}${o.submit ? " and pressed Enter" : ""}.`;
        });
    }

    async press(key: string, modifiers: string[] = [], signal?: AbortSignal): Promise<string> {
        const k = parseKey(key, modifiers);
        if (typeof k === "string") throw new DesktopError(k);
        return this.act(signal, async (a) => {
            await a.send({ op: "press", key: k.key, modifiers: k.modifiers, pids: a.r.pids });
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
            if (!this.grants.size) throw new DesktopError(NO_APPS);
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
