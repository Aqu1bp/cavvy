import type { TerminalInfo, TerminalLogin } from "@shared/protocol";
import { machine } from "./platform";
import type { Rpc } from "./rpc";

/** RPC-sized pieces without splitting a Unicode surrogate pair during UTF-8 encoding. */
export function* terminalInputChunks(data: string): Generator<string> {
    for (let start = 0; start < data.length;) {
        let end = Math.min(start + 16_384, data.length);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--;
        yield data.slice(start, end);
        start = end;
    }
}

/**
 * What's typed while a shell is still being opened (a project script's
 * opening waits on the folder and git first). Held, all of it, then sent in
 * order (in RPC-sized chunks) as soon as the shell is open, so a Ctrl+C or a
 * paste meanwhile still reaches it and stops the script being typed; dropped
 * if it doesn't open.
 */
export class EarlyInput {
    private held: string[] | undefined;

    /** The shell is being opened: hold what's typed. */
    begin() {
        this.held = [];
    }

    /** True when `data` was held. */
    hold(data: string): boolean {
        if (!this.held) return false;
        this.held.push(data);
        return true;
    }

    /** What was held, in order; nothing is held from now on. */
    take(): string {
        const all = this.held?.join("") ?? "";
        this.held = undefined;
        return all;
    }
}

/** A terminal tab, as a window keeps it across reloads. `terminal`: its shell's id (a restart gives a new one). */
export interface SavedTab {
    id: string;
    cwd: string;
    number: number;
    /** Setup display metadata only; its single-use ticket is never saved. */
    script?: { id: string; name: string; setup?: { label: string; command: string } };
    login?: TerminalLogin;
    terminal: string;
}

export interface SavedTabs {
    tabs: SavedTab[];
    /** The next tab's number. */
    next: number;
    /** The panel was showing. */
    open: boolean;
    selected?: string;
    /** Explicit tab closes still to send after a disconnect (also survive a reload). */
    closed?: string[];
}

const TABS_KEY = "cavvy.terminals";
/**
 * Where a window's tabs are kept. Shells are a machine's own: a window that goes to a server and comes back finds
 * the tabs it had on each (kept under one name, the other machine's list would drop them as unknown).
 */
export const tabsKey = (at: string | undefined = machine) => (at ? `${TABS_KEY}.${at}` : TABS_KEY);
/** The machines this window keeps terminal tabs (or closes still to send) for, by tabsKey's names ("" this computer). */
export function tabMachines(): string[] {
    const out: string[] = [];
    try {
        for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i) ?? "";
            const on = key === TABS_KEY ? "" : key.startsWith(`${TABS_KEY}.`) ? key.slice(TABS_KEY.length + 1) : undefined;
            if (on === undefined) continue;
            const saved = parseTabs(sessionStorage.getItem(key));
            if (saved.tabs.length || saved.closed?.length) out.push(on);
        }
    } catch {}
    return out;
}
const EMPTY: SavedTabs = { tabs: [], next: 1, open: false };

/**
 * sessionStorage: this window's own, kept across a reload (localStorage, like the GUI's prefs, is every window's).
 * `at`: the machine the shells run on (tabsKey), the window's own unless said.
 */
export function loadTabs(at: string | undefined = machine): SavedTabs {
    try {
        return parseTabs(sessionStorage.getItem(tabsKey(at)));
    } catch {
        return EMPTY;
    }
}

export function saveTabs(saved: SavedTabs, at: string | undefined = machine) {
    try {
        sessionStorage.setItem(tabsKey(at), JSON.stringify(saved));
    } catch {}
}

// A window's shells on a server outlive it for a while (the server's grace: src/server/terminals.ts), but its tabs and
// the key they're its under are the window's own (sessionStorage), gone with it. So a window that goes says what it
// had there, where the next one finds it (localStorage); the next window to open that server's sessions takes it,
// once, and its connection there goes by the old window's key: the shells are still that window's to the server.
const LEFT_KEY = "cavvy.terminals.left";
const KEY_FOR = "cavvy.terminals.key";
/** As long as a server keeps a shell nobody is attached to. */
const LEFT_MS = 10 * 60_000;
/** By server, then by the key of the window that went: each window's own, so one leaving doesn't cover another's. */
type Left = Record<string, Record<string, { saved: SavedTabs; at: number }>>;
const isKey = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
function readLeft(now: number): Left {
    // No names of its own: a server can be called "constructor".
    const out: Left = Object.create(null);
    try {
        const v = JSON.parse(localStorage.getItem(LEFT_KEY) ?? "{}");
        if (!v || typeof v !== "object" || Array.isArray(v)) return out;
        // Only what's of the shape written, and recent enough for its shells to be there still.
        for (const [on, by] of Object.entries(v)) {
            if (!by || typeof by !== "object" || Array.isArray(by)) continue;
            for (const [key, e] of Object.entries(by as Record<string, { saved?: unknown; at?: unknown }>)) {
                if (!isKey(key) || !e || typeof e.at !== "number" || now - e.at > LEFT_MS || now < e.at) continue;
                const saved = parseTabs(JSON.stringify(e.saved ?? null));
                if (saved.tabs.length) (out[on] ??= {})[key] = { saved, at: e.at };
            }
        }
    } catch {}
    return out;
}
function writeLeft(left: Left) {
    try {
        for (const on of Object.keys(left)) if (!Object.keys(left[on]!).length) delete left[on];
        if (Object.keys(left).length) localStorage.setItem(LEFT_KEY, JSON.stringify(left));
        else localStorage.removeItem(LEFT_KEY);
    } catch {}
}

/** The key this window's connection to server `on` goes by: its own, or the one of the window whose tabs it took. */
export function keyOn(on: string, own: () => string): string {
    try {
        const taken = sessionStorage.getItem(`${KEY_FOR}.${on}`);
        if (isKey(taken)) return taken;
    } catch {}
    return own();
}

/**
 * As this window loads: what it left itself as it went isn't for another to take (a reload: it's back, with its
 * tabs and its keys).
 */
export function keepOwnTabs(own: () => string, now = Date.now()) {
    const left = readLeft(now);
    let mine = false;
    for (const on of Object.keys(left)) {
        const key = keyOn(on, own);
        if (left[on]![key]) (delete left[on]![key], (mine = true));
    }
    if (mine) writeLeft(left);
}

/**
 * Before this window first reaches server `on`: the tabs a window that went left there (the latest to go), if this
 * one has none of its own there. Taken once: no other window gets them.
 */
export function takeLeftTabs(on: string, own: () => string, now = Date.now()) {
    if (!on || loadTabs(on).tabs.length) return;
    const left = readLeft(now);
    const mine = keyOn(on, own);
    const [key, entry] = Object.entries(left[on] ?? {}).filter(([k]) => k !== mine).sort((a, b) => b[1].at - a[1].at)[0] ?? [];
    if (!key || !entry) return;
    try {
        sessionStorage.setItem(`${KEY_FOR}.${on}`, key);
    } catch {
        return;
    }
    saveTabs(entry.saved, on);
    delete left[on]![key];
    writeLeft(left);
}

/** As this window goes: its tabs on each server, with the key they're its under there. */
export function leaveTabs(own: () => string, now = Date.now()) {
    const left = readLeft(now);
    for (const on of tabMachines()) {
        // This computer's own shells go with its Cavvy; a window's own server keeps them by the window's own key (a reload).
        if (!on || on === machine) continue;
        const saved = loadTabs(on);
        if (saved.tabs.length) (left[on] ??= {})[keyOn(on, own)] = { saved, at: now };
    }
    writeLeft(left);
}

const isId = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(v);

/** What was saved, if it's in the shape this version saves. */
export function parseTabs(raw: string | null): SavedTabs {
    let v: any;
    try {
        v = JSON.parse(raw ?? "");
    } catch {
        return EMPTY;
    }
    if (!v || !Array.isArray(v.tabs)) return EMPTY;
    // Login metadata is recovered from terminal.list, never trusted from storage.
    const tabs: SavedTab[] = v.tabs.filter((t: any) => t && isId(t.id) && isId(t.terminal) && typeof t.cwd === "string" && Number.isSafeInteger(t.number)
        && (t.script === undefined || (t.script && typeof t.script.id === "string" && typeof t.script.name === "string")))
        .map((t: any) => ({ id: t.id, cwd: t.cwd, number: t.number, terminal: t.terminal, ...(t.script ? { script: { id: t.script.id, name: t.script.name,
            ...(typeof t.script.setup?.label === "string" && typeof t.script.setup?.command === "string"
                ? { setup: { label: t.script.setup.label, command: t.script.setup.command } } : {}) } } : {}) }));
    const next = Math.max(Number.isSafeInteger(v.next) ? v.next : 1, ...tabs.map((t) => t.number + 1));
    const closed = Array.isArray(v.closed) ? [...new Set<string>(v.closed.filter(isId))] : [];
    return { tabs: tabs.filter((t) => !closed.includes(t.terminal)), next, open: v.open === true, ...(isId(v.selected) ? { selected: v.selected } : {}), ...(closed.length ? { closed } : {}) };
}

/**
 * The tabs a window had, against the terminals the server still keeps for it:
 * a tab whose terminal has gone (stopped while the window was away, or the
 * server restarted) is dropped, and a terminal no tab knows (opened for the
 * window by the server) gets a tab, named after its script if it has one.
 */
export function restoreTabs(saved: SavedTabs, listed: TerminalInfo[]): SavedTabs {
    listed = listed.filter((t) => !saved.closed?.includes(t.id));
    const live = new Map(listed.map((t) => [t.id, t]));
    const tabs = saved.tabs.filter((t) => live.has(t.terminal)).map(({ login: _, ...t }) => {
        const server = live.get(t.terminal)!;
        return { ...t, cwd: server.cwd, ...(server.login ? { login: { ...server.login } } : {}) };
    });
    let next = saved.next;
    const known = new Set(tabs.map((t) => t.terminal));
    for (const t of listed) if (!known.has(t.id)) tabs.push({ id: t.id, cwd: t.cwd, number: next++, terminal: t.id, ...(t.script ? { script: t.script } : {}), ...(t.login ? { login: { ...t.login } } : {}) });
    return { ...saved, tabs, next };
}

/** Only explicit closes wait for reconnection; arbitrary offline RPC mutations never do. */
export class TerminalClosures {
    private pending: Set<string>;
    private flushing?: Promise<void>;
    constructor(ids: string[], private rpc: Pick<Rpc, "call" | "state">, private changed: () => void) {
        this.pending = new Set(ids);
    }
    get ids() { return [...this.pending]; }
    close(id: string) {
        this.pending.add(id);
        this.changed();
        void this.flush();
    }
    flush(): Promise<void> {
        if (this.flushing) return this.flushing;
        if (this.rpc.state !== "open") return Promise.resolve();
        return this.flushing = this.drain().finally(() => { this.flushing = undefined; });
    }
    private async drain() {
        for (const id of this.pending) {
            try {
                // Close first: this also cancels a scripts.run still looking up its command.
                // Attaching first leaves a gap where that lookup can create a shell on the old socket.
                try { await this.rpc.call("terminal.close", { id }); }
                catch (e) {
                    if ((e as { code?: string }).code !== "terminal_not_open") throw e;
                    // The old socket may still own an already-open shell. Claim it before closing.
                    await this.rpc.call("terminal.attach", { id });
                    await this.rpc.call("terminal.close", { id });
                }
                this.pending.delete(id);
            } catch (e) {
                if ((e as { code?: string }).code !== "terminal_not_open") return;
                this.pending.delete(id);
            }
            this.changed();
        }
    }
}
