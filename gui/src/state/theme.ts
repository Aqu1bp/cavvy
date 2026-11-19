// The theme showing: which one (prefs.themeId), its palette on <html>, and the one scheme it's made for, which the
// window follows while it shows. The scene behind the window is ThemeBackdrop's. Built-in themes load when they're
// first shown; the user's own come from the server (~/.cavvy/themes), and a save to one shows at once. A theme file
// that stops checking out while it's being written keeps its last good look on screen.

import { batch, createEffect, createMemo, createRoot, createSignal, untrack } from "solid-js";
import type { ThemeEntry } from "@shared/protocol";
import { builtin, BUILTINS } from "../../../src/themes/builtin";
import { lookFor, onlyScheme, type Look, type Scheme, type Theme } from "../../../src/themes/format";
import { palette, type Palette } from "../../../src/themes/palette";
import { chosenScheme, prefs, setForcedScheme, setHeldScheme, setPrefs } from "./prefs";
import { setThemeTraits } from "./theme-traits";
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

/** The user's themes as the server last listed them; undefined until it has. */
const [entries, setEntries] = createSignal<ThemeEntry[] | undefined>(undefined);
/** Whether the server's whole list has come: one theme added ahead of it (addThemeEntry) isn't the list. */
let listed = false;

/** Whether the server's list has come (a user theme can't be shown before it has). */
export const listKnown = () => listed;
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
    // `listed` is set with the list (setThemeEntries), so this runs again when it comes.
    return listed ? { state: "none" } : { state: "loading", id };
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

/**
 * What's on the screen: the palette on <html> and the scene behind it. It follows `shown`, but a new scene is drawn
 * (ThemeBackdrop) before it's put up, so the colours and the scene change together, in one crossfade (swap).
 */
const [up, setUp] = createSignal<Shown | undefined | null>(null);
/** null until the first is put up: till then, what theme-boot.js painted from the cache stays. */
export const onScreen = () => up() ?? undefined;

/** The scene being drawn to go up next, and how long it may take before the colours go up without it. */
let drawing: string | undefined;
let fallback: ReturnType<typeof setTimeout> | undefined;
const PENDING_MS = 3000;
/** Theme switches under way: the crossfade's CSS holds while any is. */
let swapping = 0;
/** The last crossfade, done when it's over. */
let fading: Promise<unknown> = Promise.resolve();

/** Once the crossfade under way is over: work on the main thread meanwhile (a picture for an agent) holds it up. */
export const afterFade = () => fading;

/** Runs `apply` as one crossfade of the whole window (a view transition), or at once where motion's not wanted. */
function swap(apply: () => void, animate: boolean) {
    const motion = animate && prefs.motion !== "instant" && !document.hidden && typeof document.startViewTransition === "function" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!motion) return apply();
    const root = document.documentElement;
    swapping++;
    root.dataset.themeSwitch = "";
    const t = document.startViewTransition(apply);
    // Skipped by the next switch, these reject; that's expected.
    t.ready.catch(() => undefined);
    t.updateCallbackDone.catch(() => undefined);
    fading = t.finished.catch(() => undefined);
    // While it fades, the page under it takes no clicks (they land on <html>): a press ends the fade, and its click
    // goes where it was pressed.
    const press = () => {
        t.skipTransition();
        addEventListener("click", retarget, { capture: true, once: true });
    };
    addEventListener("pointerdown", press, { capture: true });
    void fading.finally(() => {
        removeEventListener("pointerdown", press, { capture: true });
        if (--swapping === 0) delete root.dataset.themeSwitch;
    });
}

/** The click of a press that ended a crossfade: it landed on <html>, and goes to what's under the pointer now. */
function retarget(e: MouseEvent) {
    if (e.target !== document.documentElement) return;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    if (!under || under === document.documentElement) return;
    e.stopImmediatePropagation();
    under.dispatchEvent(new MouseEvent("click", e));
}

function putUp(s: Shown | undefined) {
    clearTimeout(fallback);
    drawing = undefined;
    const before = untrack(up);
    if (before === s) return;
    // The same look again (its contrast or glass changed): no crossfade for that. Nothing there before and nothing
    // drawn now (a start with a theme without a scene): its colours are on <html> already (theme-boot.js).
    const same = before && s && sceneKey(before) === sceneKey(s);
    swap(() => setUp(s), !same && Boolean(before || s?.look.layers?.length));
}

/** ThemeBackdrop: the scene for `key` is drawn, and can go up. */
export function sceneReady(key: string) {
    if (drawing !== key) return;
    const s = untrack(shown);
    if (s && sceneKey(s) === key) putUp(s);
}

createRoot(() =>
    createEffect(() => {
        const c = current();
        // A built-in still loading: what's up stays.
        if (c.state === "loading") return;
        const s = shown();
        if (!s?.look.layers?.length) return putUp(s);
        const key = sceneKey(s);
        const now = untrack(onScreen);
        if (now && sceneKey(now) === key) return putUp(s);
        // Drawn first (ThemeBackdrop calls sceneReady); the colours go up without it if it's slow to draw.
        drawing = key;
        clearTimeout(fallback);
        fallback = setTimeout(() => sceneReady(key), PENDING_MS);
    }),
);

/** Shows a theme (or none). */
export function applyTheme(id: string | undefined) {
    setPrefs("themeId", id);
}

/** The server's list, now or after a change: what the gallery shows, and what a user theme's look comes from. */
export function setThemeEntries(list: ThemeEntry[]) {
    const id = prefs.themeId;
    const before = entries()?.find((e) => e.id === id);
    const after = list.find((e) => e.id === id);
    listed = true;
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
        if (up() === null) return;
        const s = onScreen();
        const vars = s?.palette.vars ?? {};
        for (const name of applied) if (!(name in vars)) root.style.removeProperty(name);
        for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
        applied = Object.keys(vars);
        if (s) root.dataset.themed = s.look.layers?.length ? "scene" : "colors";
        else delete root.dataset.themed;
        setThemeTraits(s ? { name: s.theme.name, scened: Boolean(s.look.layers?.length), accent: Boolean(s.look.colors.accent) } : undefined);
        const only = s ? onlyScheme(s.theme) : undefined;
        if (only) root.dataset.themeOnly = only;
        else delete root.dataset.themeOnly;
        setForcedScheme(only);
        setHeldScheme(s?.scheme);
        // For the next start's first paint (theme-boot.js): the palette for each scheme the theme has.
        try {
            if (!s) {
                localStorage.removeItem(CACHE);
                if (!machine) localStorage.removeItem(MINE);
            } else {
                // Kept whole for a window on a server; written only when it's another theme or a new version of it.
                if (!machine && !builtin(s.id)) {
                    const mine = JSON.stringify({ id: s.id, theme: s.theme });
                    if (localStorage.getItem(MINE) !== mine) localStorage.setItem(MINE, mine);
                } else if (!machine) localStorage.removeItem(MINE);
                const o = { high: prefs.contrast === "high", glass: prefs.glass };
                const forScheme = (sch: Scheme) => (s.theme[sch] ? palette(s.theme[sch]!, sch, o).vars : undefined);
                localStorage.setItem(CACHE, JSON.stringify({ id: s.id, only, scened: Boolean(s.look.layers?.length), vars: { light: forScheme("light"), dark: forScheme("dark") } }));
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
