// The theme showing: which one (prefs.themeId), its palette on <html>, and the one scheme it's made for, which the
// window follows while it shows. The scene behind the window is ThemeBackdrop's. Built-in themes load when they're
// first shown; the user's own come from the server (~/.cavvy/themes), and a save to one shows at once. A theme file
// that stops checking out while it's being written keeps its last good look on screen.

import { batch, createEffect, createMemo, createRoot, createSignal } from "solid-js";
import type { ThemeEntry } from "@shared/protocol";
import { builtin, BUILTINS } from "../../../src/themes/builtin";
import { lookFor, onlyScheme, type Look, type Scheme, type Theme } from "../../../src/themes/format";
import { palette, type Palette } from "../../../src/themes/palette";
import { chosenScheme, prefs, setForcedScheme, setPrefs, setThemeTraits } from "./prefs";
import { machine } from "../lib/platform";

const CACHE = "cavvy.theme";
/**
 * The user's own theme showing, whole: a window on a server is the same page with the same preferences, but asks
 * that server for its lists, which doesn't have this device's themes. It shows this copy instead (themes are per
 * device). Read only there, so a start here doesn't pay for parsing it.
 */
const MINE = "cavvy.theme.mine";

/** In a window on a server: this device's own theme as the window here last showed it. */
export function localThemes(): ThemeEntry[] {
    try {
        const v = JSON.parse(localStorage.getItem(MINE) ?? "null") as ThemeEntry | null;
        return v?.id && v.theme ? [v] : [];
    } catch {
        return [];
    }
}

/** Whether the server's list has come (a user theme can't be shown before it has). */
export const listKnown = () => entries() !== undefined;

/** The user's themes as the server last listed them; undefined until it has. */
const [entries, setEntries] = createSignal<ThemeEntry[] | undefined>(undefined);
/** Built-ins loaded so far, by id. */
const [loaded, setLoaded] = createSignal<Readonly<Record<string, Theme>>>({});
const pending = new Map<string, Promise<Theme>>();
/** Each user theme's last version that checked out: shown while its file is being rewritten. */
const lastGood = new Map<string, Theme>();

export const userThemes = () => entries() ?? [];

export function loadBuiltin(id: string): Promise<Theme | undefined> {
    const b = builtin(id);
    if (!b) return Promise.resolve(undefined);
    const have = loaded()[id];
    if (have) return Promise.resolve(have);
    let p = pending.get(id);
    if (!p) {
        p = b.load().then((t) => {
            setLoaded((m) => ({ ...m, [id]: t }));
            return t;
        });
        pending.set(id, p);
        p.catch(() => pending.delete(id));
    }
    return p;
}

/** Every built-in, for the gallery: loaded together when it first shows. */
export function loadAllBuiltins(): Promise<unknown> {
    return Promise.all(BUILTINS.map((b) => loadBuiltin(b.id).catch(() => undefined)));
}

export const builtinTheme = (id: string) => loaded()[id];

type Current = { state: "none" } | { state: "loading"; id: string } | { state: "ready"; id: string; theme: Theme };

/** The theme for an id, as far as the window knows it now. */
function resolve(id: string | undefined): Current {
    if (!id) return { state: "none" };
    if (builtin(id)) {
        const t = loaded()[id];
        if (t) return { state: "ready", id, theme: t };
        void loadBuiltin(id);
        return { state: "loading", id };
    }
    const list = entries();
    const entry = list?.find((e) => e.id === id);
    if (entry?.theme) {
        lastGood.set(id, entry.theme);
        return { state: "ready", id, theme: entry.theme };
    }
    const kept = lastGood.get(id);
    if (kept) return { state: "ready", id, theme: kept };
    return list ? { state: "none" } : { state: "loading", id };
}

/** What's showing: the theme and the look the window's scheme picks from it, with its palette. */
export interface Shown {
    id: string;
    theme: Theme;
    look: Look;
    scheme: Scheme;
    palette: Palette;
}

const current = createRoot(() => createMemo(() => resolve(prefs.themeId)));

export const shown = createRoot(() =>
    createMemo<Shown | undefined>(() => {
        const c = current();
        if (c.state !== "ready") return undefined;
        const { look, scheme } = lookFor(c.theme, chosenScheme());
        return { id: c.id, theme: c.theme, look, scheme, palette: palette(look, scheme, { high: prefs.contrast === "high", glass: prefs.glass }) };
    }),
);

export const themeLoading = () => current().state === "loading";

/** Shows a theme (or none). */
export function applyTheme(id: string | undefined) {
    setPrefs("themeId", id);
}

/** The server's list, now or after a change: what the gallery shows, and what a user theme's look comes from. */
export function setThemeEntries(list: ThemeEntry[]) {
    const id = prefs.themeId;
    const before = entries()?.find((e) => e.id === id);
    const after = list.find((e) => e.id === id);
    batch(() => {
        setEntries(list);
        // Deleted (here, in another window, by hand or by an agent): nothing to show. One that's there but doesn't
        // check out keeps its last good look (resolve).
        if (id && !builtin(id) && !after) {
            lastGood.delete(id);
            setPrefs("themeId", undefined);
        }
    });
    return { problem: after?.problems && JSON.stringify(after.problems) !== JSON.stringify(before?.problems) ? after.problems[0] : undefined, id };
}

/** One theme the server just saved, ahead of its list (theme.apply carries it): applied before the folder's watch tells. */
export function addThemeEntry(entry: ThemeEntry) {
    const list = entries() ?? [];
    setEntries([...list.filter((e) => e.id !== entry.id), entry].sort((a, b) => a.id.localeCompare(b.id)));
}

/** A user theme's last version that checked out, while its file doesn't: what its tile shows. */
export const keptTheme = (id: string) => lastGood.get(id);

/** The name a theme goes by, for what the window says. */
export function themeName(id: string): string {
    return loaded()[id]?.name ?? builtin(id)?.name ?? entries()?.find((e) => e.id === id)?.theme?.name ?? lastGood.get(id)?.name ?? id;
}

createRoot(() => {
    // The palette on <html>: written once per change, and the names no longer set taken away. At first, the names
    // theme-boot.js set from the cache: a theme gone since the last start takes its colours with it.
    let applied: string[] = (() => {
        try {
            const v = JSON.parse(localStorage.getItem(CACHE) ?? "null") as { vars?: Record<string, Record<string, string> | undefined> } | null;
            return [...new Set([...Object.keys(v?.vars?.light ?? {}), ...Object.keys(v?.vars?.dark ?? {})])];
        } catch {
            return [];
        }
    })();
    const root = document.documentElement;
    createEffect(() => {
        const c = current();
        if (c.state === "loading") return;
        const s = shown();
        const vars = s?.palette.vars ?? {};
        for (const name of applied) if (!(name in vars)) root.style.removeProperty(name);
        for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
        applied = Object.keys(vars);
        if (s) root.dataset.themed = s.look.layers?.length ? "scene" : "colors";
        else delete root.dataset.themed;
        setThemeTraits(s ? { name: s.theme.name, scened: Boolean(s.look.layers?.length), accent: Boolean(s.look.colors.accent) } : undefined);
        const only = c.state === "ready" ? onlyScheme(c.theme) : undefined;
        if (only) root.dataset.themeOnly = only;
        else delete root.dataset.themeOnly;
        setForcedScheme(only);
        // For the next start's first paint (theme-boot.js): the palette for each scheme the theme has.
        try {
            if (c.state !== "ready") {
                localStorage.removeItem(CACHE);
                if (!machine) localStorage.removeItem(MINE);
            } else {
                // Kept whole for a window on a server; written only when it's another theme or a new version of it.
                if (!machine && !builtin(c.id)) {
                    const mine = JSON.stringify({ id: c.id, theme: c.theme });
                    if (localStorage.getItem(MINE) !== mine) localStorage.setItem(MINE, mine);
                } else if (!machine) localStorage.removeItem(MINE);
                const o = { high: prefs.contrast === "high", glass: prefs.glass };
                const forScheme = (sch: Scheme) => (c.theme[sch] ? palette(c.theme[sch]!, sch, o).vars : undefined);
                localStorage.setItem(CACHE, JSON.stringify({ id: c.id, only, scened: Boolean(s?.look.layers?.length), vars: { light: forScheme("light"), dark: forScheme("dark") } }));
            }
        } catch {
            // private mode: the next start paints the theme a moment late
        }
    });
});

/** A look's identity: a change to any of it is a new scene to draw. */
export function sceneKey(s: Shown): string {
    let h = 0;
    const text = JSON.stringify(s.look) + s.scheme;
    for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
    return `${s.id}:${s.scheme}:${(h >>> 0).toString(36)}`;
}

/** How a theme came out once drawn: the veil laid over its scene, and the layers that couldn't be drawn. */
export interface Drawn {
    key: string;
    id: string;
    scheme: Scheme;
    /** The share of the background over the scene: on average, and where it's most. */
    veil?: number;
    veilMost?: number;
    /** The veil as a small image to stretch over the stage (ThemeBackdrop). */
    map?: string;
    failed: number[];
}

let lastDrawn: Drawn | undefined;
const waiting = new Set<(d: Drawn) => void>();

/** ThemeBackdrop: a look is on screen. */
export function drawnTheme(d: Drawn) {
    lastDrawn = d;
    for (const w of [...waiting]) w(d);
}

/**
 * How the theme `id` comes out, once it's on screen (for an agent that asked for it: theme.apply), or undefined if it
 * isn't within `ms`. A look already on screen answers at once.
 */
export function whenDrawn(id: string, ms = 6000): Promise<Drawn | undefined> {
    return new Promise((done) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (d: Drawn | undefined) => {
            clearTimeout(timer);
            waiting.delete(take);
            done(d);
        };
        const take = (d: Drawn) => {
            const s = shown();
            if (d.id === id && s && d.key === sceneKey(s)) finish(d);
        };
        waiting.add(take);
        timer = setTimeout(() => finish(undefined), ms);
        // After this change has reached the screen: what's drawn may already be it.
        requestAnimationFrame(() => {
            if (lastDrawn) take(lastDrawn);
        });
    });
}
