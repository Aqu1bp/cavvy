import type { TerminalInfo, TerminalLogin } from "@shared/protocol";
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
const EMPTY: SavedTabs = { tabs: [], next: 1, open: false };

/** sessionStorage: this window's own, kept across a reload (localStorage, like the GUI's prefs, is every window's). */
export function loadTabs(): SavedTabs {
    try {
        return parseTabs(sessionStorage.getItem(TABS_KEY));
    } catch {
        return EMPTY;
    }
}

export function saveTabs(saved: SavedTabs) {
    try {
        sessionStorage.setItem(TABS_KEY, JSON.stringify(saved));
    } catch {}
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
