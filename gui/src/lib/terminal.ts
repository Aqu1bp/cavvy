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
    script?: { id: string; name: string };
    terminal: string;
}

export interface SavedTabs {
    tabs: SavedTab[];
    /** The next tab's number. */
    next: number;
    /** The panel was showing. */
    open: boolean;
    selected?: string;
}

const TABS_KEY = "harness.terminals";
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
    const tabs: SavedTab[] = v.tabs.filter((t: any) => t && isId(t.id) && isId(t.terminal) && typeof t.cwd === "string" && Number.isSafeInteger(t.number)
        && (t.script === undefined || (t.script && typeof t.script.id === "string" && typeof t.script.name === "string")))
        .map((t: any) => ({ id: t.id, cwd: t.cwd, number: t.number, terminal: t.terminal, ...(t.script ? { script: { id: t.script.id, name: t.script.name } } : {}) }));
    const next = Math.max(Number.isSafeInteger(v.next) ? v.next : 1, ...tabs.map((t) => t.number + 1));
    return { tabs, next, open: v.open === true, ...(isId(v.selected) ? { selected: v.selected } : {}) };
}

/**
 * The tabs a window had, against the terminals the server still keeps for it:
 * a tab whose terminal has gone (stopped while the window was away, or the
 * server restarted) is dropped, and a terminal no tab knows (opened for the
 * window by the server) gets a tab, named after its script if it has one.
 */
export function restoreTabs(saved: SavedTabs, listed: { id: string; cwd: string; script?: { id: string; name: string } }[]): SavedTabs {
    const live = new Set(listed.map((t) => t.id));
    const tabs = saved.tabs.filter((t) => live.has(t.terminal));
    let next = saved.next;
    const known = new Set(tabs.map((t) => t.terminal));
    for (const t of listed) if (!known.has(t.id)) tabs.push({ id: t.id, cwd: t.cwd, number: next++, terminal: t.id, ...(t.script ? { script: t.script } : {}) });
    return { ...saved, tabs, next };
}
