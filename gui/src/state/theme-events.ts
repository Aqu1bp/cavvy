// What the server says about themes, handled once one comes: the window's first load carries none of it (state/app.ts
// only hands these on).

import { createEffect, createRoot, createSignal } from "solid-js";
import type { ServerEvent, ThemeEntry, ThemeReplaced, ThemeReport } from "@shared/protocol";
import { machine } from "../lib/platform";
import type { Rpc } from "../lib/rpc";
import { app, reportError, rpc, toast } from "./app";
import { activeTheme, prefs } from "./prefs";
import { addThemeEntry, afterFade, applyTheme, listKnown, localThemes, setThemeEntries, shown, themeName, whenDrawn } from "./theme";
import { setSettingsTab } from "./ui";

/** The scene behind the window, loaded with these (App.tsx's lazy): one fetch for a theme's code, not two. */
export { ThemeBackdrop as default } from "../components/ThemeBackdrop";

/**
 * This computer's Cavvy, which keeps its themes and its agents' theme tools: the window's own connection, or in a
 * window on a server its other one, to here (lib/machines.ts home). Themes are per device, whatever server the
 * window's on.
 */
export async function themeRpc(): Promise<Rpc> {
    return machine ? (await import("../lib/machines")).home! : rpc;
}

/** Whether that connection is up; in a window on a server, followed once this loads. */
const [homeUp, setHomeUp] = createSignal(false);
if (machine)
    void import("../lib/machines").then(({ home }) => {
        setHomeUp(home!.state === "open");
        home!.onState((s) => setHomeUp(s === "open"));
    });
const up = () => (machine ? homeUp() : app.conn === "open");

createRoot(() => {
    // Which theme the window shows, so an agent asked to change "this theme" knows which (ThemeList): from when a
    // theme's first chosen or a window starts with one (both load this). Until then the server takes it as none.
    createEffect(() => {
        const id = prefs.themeId ?? null;
        const scheme = activeTheme();
        if (up()) void themeRpc().then((r) => r.call("themes.showing", { id, scheme })).catch(() => undefined);
    });
    // A window on a server lists this computer's themes when it reaches it, and again after it's been away (state/app.ts
    // does it for a window's own connection).
    if (machine)
        createEffect(() => {
            if (homeUp()) void refreshThemes().catch(() => undefined);
        });
});

/** The user's themes, from this computer's Cavvy: read when a window connects, kept up to date by themes.changed. */
export async function refreshThemes() {
    // A window on a server not connected here yet: the theme it last showed, so it can show it meanwhile.
    if (machine && !homeUp()) return void (listKnown() || setThemeEntries(localThemes()));
    setThemeEntries(await (await themeRpc()).call("themes.list", {}));
}

/** One of this computer's events about themes (state/app.ts and lib/machines.ts hand them on). */
export function onThemeEvent(ev: ServerEvent) {
    if (ev.type === "themes.changed") return void themesChanged(ev.themes);
    if (ev.type === "theme.apply") void themeApplied(ev.id, ev.entry, ev.request, ev.replaced);
}

/** The list changed: what's wrong with the theme showing is on its tile in Settings → Appearance, and the window keeps its last good look meanwhile. */
export function themesChanged(themes: ThemeEntry[]) {
    const { problem, id } = setThemeEntries(themes);
    if (problem && id) toast(`${themeName(id)} has an error`, "warn", { label: "Show", run: () => showThemeTile(id) });
}

/** An agent showed a theme (or none): shown here, and how it came out told back to it. */
export async function themeApplied(id: string | null, entry: ThemeEntry | undefined, request: string, replaced?: ThemeReplaced) {
    // An agent saved over one of the user's themes: the old one comes back with Undo.
    if (id && replaced)
        toast(`Replaced ${replaced.name}`, "info", {
            label: "Undo",
            run: () =>
                void themeRpc()
                    .then((r) => r.call("themes.restore", { id, text: replaced.text, replace: true }))
                    .then(() => refreshThemes())
                    .catch(reportError),
        });
    if (entry) addThemeEntry(entry);
    // One of the user's own, shown by id in a window that hasn't had the list yet: the list first, or it can't show.
    else if (id && !listKnown()) await refreshThemes().catch(() => undefined);
    applyTheme(id ?? undefined);
    const still = !prefs.themeMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;
    const drawn = id ? await whenDrawn(id) : undefined;
    // Made after the crossfade: it draws on the main thread, and during it would hold the fade up (measured: 244 ms).
    if (drawn) await afterFade();
    // A picture of it for the agent, made only now that one has asked.
    const s = shown();
    const picture = drawn && s ? await import("../lib/theme-picture").then((p) => p.themePicture(s.look, s.palette.vars, drawn.map)).catch(() => undefined) : undefined;
    const report: ThemeReport = id ? (drawn ? { request, shown: true, scheme: drawn.scheme, ...(drawn.veil !== undefined ? { veil: drawn.veil } : {}), ...(drawn.veilMost !== undefined ? { veilMost: drawn.veilMost } : {}), failed: drawn.failed, still, ...(picture ? { picture } : {}) } : { request, shown: false }) : { request, shown: true };
    await themeRpc()
        .then((r) => r.call("themes.report", report))
        .catch(() => undefined);
}

/** Settings → Appearance, scrolled to a theme's tile: the gallery mounts a moment after the tab opens. */
function showThemeTile(id: string) {
    setSettingsTab("appearance");
    let tries = 0;
    const find = () => {
        const tile = document.querySelector<HTMLElement>(`.tile[data-id="${CSS.escape(id)}"]`);
        if (tile) tile.scrollIntoView({ block: "center" });
        else if (++tries < 60) requestAnimationFrame(find);
    };
    requestAnimationFrame(find);
}
