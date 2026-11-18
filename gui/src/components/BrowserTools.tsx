// The Browser pane's menu and the bars it opens: find in page, the page's size (the pane's own, a device's, or one typed
// in) and zoom, and in the desktop app the page's DevTools. Nothing here runs, and nothing is asked of the page, until
// one of them is used: a pane that fills and isn't searched asks the page for what it always did.
//
// Two kinds of page (docs/browser.md): in the desktop app, the tab's own Chromium page (a <webview>, BrowserHostLayer),
// which finds and zooms itself and has DevTools; otherwise a headless Chrome's, drawn from frames, where a script finds
// (src/browser/find.ts) and the size and zoom are the page's emulated metrics (lib/browser-view.ts). Its DevTools
// aren't offered there: Chrome is driven over a pipe and opens no DevTools port for a frontend to reach.

import { createEffect, createSignal, For, on, onCleanup, onMount, Show, type Accessor, type JSX, type Setter } from "solid-js";
import { Check, ChevronDown, ChevronUp, Ellipsis, Laptop, Maximize, Minus, Plus, RotateCwSquare, Ruler, Scan, Search, Smartphone, SquareTerminal, Tablet, X, ZoomIn, ZoomOut } from "lucide-solid";
import type { BrowserTabInfo } from "@shared/protocol";
import { reportError, rpc } from "../state/app";
import { hostedTargets } from "../state/browser-host";
import { electron, isMod, mod } from "../lib/platform";
import { DEVICES, side, viewLabel, zoomStep, MAX_SIDE, MIN_SIDE, type PageView } from "../lib/browser-view";
import type { PaneStatus } from "../lib/browser";
import { Menu } from "./ui/Menu";

/** Each session's size and zoom while the window is open: the pane shows it again when it comes back. */
const views = new Map<string, PageView>();
export const savedView = (id: string) => views.get(id);

const DEVICE_ICONS = { Phone: Smartphone, Tablet, Laptop } as Record<string, typeof Smartphone>;
/** A search typed is run once typing pauses this long. */
const TYPED_MS = 120;

interface Webview extends HTMLElement {
    findInPage(text: string, o?: { forward?: boolean; findNext?: boolean }): number;
    stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
    setZoomFactor(factor: number): void;
}

export interface PaneToolsOptions {
    id: Accessor<string>;
    /** The desktop app's own page, not frames from a headless Chrome. */
    native: boolean;
    tab: Accessor<BrowserTabInfo | undefined>;
    status: Accessor<PaneStatus>;
    view: Accessor<PageView | undefined>;
    setView: Setter<PageView | undefined>;
    root: () => HTMLElement | undefined;
    address: () => HTMLInputElement | undefined;
    keyboard: () => HTMLElement | undefined;
}

export function paneTools(o: PaneToolsOptions): { menu: () => JSX.Element; bars: () => JSX.Element } {
    const [menuOpen, setMenuOpen] = createSignal(false);
    const [finding, setFinding] = createSignal(false);
    const [query, setQuery] = createSignal("");
    const [found, setFound] = createSignal<{ matches: number; active: number }>();
    let menuButton: HTMLButtonElement | undefined;
    let findInput: HTMLInputElement | undefined;
    let widthInput: HTMLInputElement | undefined;

    // The view is the session's: kept for it, and another session's shown when the pane moves to it.
    createEffect(on(o.id, (id) => o.setView(views.get(id)), { defer: true }));
    const setView = (v: PageView | undefined) => {
        const kept = v && (v.device || v.zoom !== 1) ? v : undefined;
        if (kept) views.set(o.id(), kept);
        else views.delete(o.id());
        o.setView(kept);
    };
    const zoom = () => o.view()?.zoom ?? 1;

    /** The desktop app's page for the current tab, when it has one. */
    const webview = (): Webview | undefined => {
        const target = o.tab()?.targetId;
        if (!o.native || !target) return undefined;
        const key = Object.entries(hostedTargets()).find(([, t]) => t === target)?.[0];
        return (key ? document.querySelector<Webview>(`webview[data-key="${key}"]`) : null) ?? undefined;
    };
    const keyOf = (target: string | undefined) => Object.entries(hostedTargets()).find(([, t]) => t === target)?.[0];

    // -----------------------------------------------------------------------
    // Find in page

    /** Each search, so an answer to one before it isn't shown. */
    let asked = 0;
    let typed: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => clearTimeout(typed));
    /** The desktop app's page answers its finds as events: the last request's is shown. */
    let nativeRequest = -1;
    const onFound = (e: Event) => {
        const r = (e as Event & { result: { requestId: number; matches: number; activeMatchOrdinal: number } }).result;
        if (r.requestId === nativeRequest) setFound({ matches: r.matches, active: r.activeMatchOrdinal });
    };
    let listening: Webview | undefined;
    const listen = (view: Webview | undefined) => {
        if (listening === view) return;
        listening?.removeEventListener("found-in-page", onFound);
        listening = view;
        view?.addEventListener("found-in-page", onFound);
    };
    onCleanup(() => listen(undefined));

    /** `step` 0: a new search (or the same one again); 1 and -1: the next and previous match. */
    const search = async (step: number) => {
        const text = query();
        const mine = ++asked;
        if (!text) {
            setFound(undefined);
            return clearFound();
        }
        if (o.native) {
            const view = webview();
            if (!view) return;
            listen(view);
            nativeRequest = view.findInPage(text, { forward: step >= 0, findNext: step === 0 });
            return;
        }
        const tab = o.tab()?.id;
        if (tab === undefined) return;
        try {
            const r = await rpc.call("browser.find", { id: o.id(), tab, query: text, step });
            if (mine === asked) setFound(r);
        } catch (e) {
            if (mine === asked) setFound(undefined);
            reportError(e);
        }
    };
    /** What a search marked in the page, gone. */
    const clearFound = () => {
        if (o.native) return webview()?.stopFindInPage("clearSelection");
        const tab = o.tab()?.id;
        if (tab !== undefined) void rpc.call("browser.find", { id: o.id(), tab, query: "" }).catch(() => undefined);
    };
    const openFind = () => {
        setMenuOpen(false);
        setFinding(true);
        requestAnimationFrame(() => (findInput?.focus(), findInput?.select()));
        // Opened again on what it last looked for: found again, in the page as it is now.
        if (query() && !found()) void search(0);
    };
    const closeFind = () => {
        clearTimeout(typed);
        asked++;
        setFinding(false);
        setFound(undefined);
        if (query()) clearFound();
        // Back to the page, as a browser's find bar does.
        if (o.native) webview()?.focus();
        else o.keyboard()?.focus({ preventScroll: true });
    };
    // Another tab: what was found was the one before's.
    createEffect(on(() => o.tab()?.id, () => {
        asked++;
        setFound(undefined);
    }, { defer: true }));

    // Ctrl+F (⌘F) with the keyboard in the pane: the page's find, not the conversation's. Taken before the page's own
    // keyboard field sends it to the page.
    onMount(() => {
        const root = o.root();
        const key = (e: KeyboardEvent) => {
            if (e.key.toLowerCase() !== "f" || !isMod(e) || e.altKey || e.shiftKey || o.status() === "unavailable") return;
            e.preventDefault();
            e.stopPropagation();
            openFind();
        };
        root?.addEventListener("keydown", key, true);
        // In the desktop app the page has the keyboard itself: the app tells which page was asked (browser-host.ts).
        const off = o.native ? electron?.onBrowser((e) => {
            if (e.type === "find" && e.key === keyOf(o.tab()?.targetId)) openFind();
        }) : undefined;
        onCleanup(() => {
            root?.removeEventListener("keydown", key, true);
            off?.();
        });
    });

    // -----------------------------------------------------------------------
    // Size and zoom

    const pick = (device: PageView["device"]) => {
        setMenuOpen(false);
        setView({ device, zoom: zoom() });
    };
    const rotate = () => {
        const d = o.view()?.device;
        if (d) setView({ device: { width: d.height, height: d.width }, zoom: zoom() });
    };
    const zoomBy = (dir: 1 | -1 | 0) => setView({ device: o.view()?.device, zoom: dir ? zoomStep(zoom(), dir) : 1 });
    const custom = () => {
        setMenuOpen(false);
        const box = o.root()?.querySelector(".br-view")?.getBoundingClientRect();
        const clamp = (n: number) => Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(n)));
        setView({ device: o.view()?.device ?? { width: clamp(box?.width ?? 800), height: clamp(box?.height ?? 600) }, zoom: zoom() });
        requestAnimationFrame(() => (widthInput?.focus(), widthInput?.select()));
    };
    const typeSide = (which: "width" | "height", text: string) => {
        const d = o.view()?.device;
        const n = side(text);
        if (d && n !== undefined && n !== d[which]) setView({ device: { ...d, [which]: n }, zoom: zoom() });
    };
    // The desktop app's page zooms itself (as its browser would); the headless one is asked for a zoomed size.
    createEffect(() => {
        if (!o.native) return;
        const view = webview();
        const z = zoom();
        try {
            view?.setZoomFactor(z);
        } catch {
            // Not attached yet: the next change sets it.
        }
    });
    onCleanup(() => {
        // Left at 100% for the agent, as a headless page is once the pane stops watching it.
        try {
            if (zoom() !== 1) webview()?.setZoomFactor(1);
        } catch { /* gone */ }
    });

    const devTools = () => {
        setMenuOpen(false);
        const key = keyOf(o.tab()?.targetId);
        if (key) electron?.browserDevTools?.(key);
    };

    /** A row of the menu; `extra` is read as things change (zooming keeps the menu open). */
    const item = (Icon: typeof Search, label: () => string, run: () => void, extra: () => { disabled?: boolean; kbd?: string; checked?: boolean } = () => ({})) => (
        <button role={extra().checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={extra().checked} class="menu-item compact" disabled={extra().disabled} onClick={run}>
            <Icon size={14} />
            <span class="menu-label grow">{label()}</span>
            <Show when={extra().kbd}><kbd class="menu-kbd">{extra().kbd}</kbd></Show>
            <Show when={extra().checked}><Check size={14} /></Show>
        </button>
    );

    const menu = () => (
        <>
            <button ref={menuButton} class="hb sm" aria-label="Page tools" title="Find, size, zoom" aria-haspopup="menu" aria-expanded={menuOpen()} onClick={() => setMenuOpen(!menuOpen())}>
                <Ellipsis size={14} />
            </button>
            <Menu label="Page tools" open={menuOpen()} anchor={() => menuButton} onClose={() => setMenuOpen(false)} align="end" width={244}>
                {item(Search, () => "Find in page", openFind, () => ({ disabled: !o.tab(), kbd: mod === "⌘" ? "⌘F" : "Ctrl+F" }))}
                <Show when={o.native && electron?.browserDevTools}>{item(SquareTerminal, () => "Open DevTools", devTools, () => ({ disabled: !o.tab() }))}</Show>
                <div class="menu-sep" />
                {item(Maximize, () => "Fill pane", () => pick(undefined), () => ({ checked: !o.view()?.device }))}
                <For each={DEVICES}>
                    {(d) => item(DEVICE_ICONS[d.name] ?? Smartphone, () => `${d.name} · ${d.size.width} × ${d.size.height}`, () => pick(d.size), () => ({ checked: o.view()?.device?.width === d.size.width && o.view()?.device?.height === d.size.height }))}
                </For>
                {item(Ruler, () => "Custom size…", custom, () => ({ checked: !!o.view()?.device && !DEVICES.some((d) => d.size.width === o.view()!.device!.width && d.size.height === o.view()!.device!.height) }))}
                {item(RotateCwSquare, () => "Rotate", rotate, () => ({ disabled: !o.view()?.device }))}
                <div class="menu-sep" />
                {item(ZoomIn, () => "Zoom in", () => zoomBy(1), () => ({ disabled: zoom() >= 2 }))}
                {item(ZoomOut, () => "Zoom out", () => zoomBy(-1), () => ({ disabled: zoom() <= 0.5 }))}
                {item(Scan, () => `Actual size${zoom() !== 1 ? ` (now ${Math.round(zoom() * 100)}%)` : ""}`, () => zoomBy(0), () => ({ disabled: zoom() === 1 }))}
            </Menu>
        </>
    );

    const bars = () => (
        <>
            <Show when={finding()}>
                <div class="br-strip" role="search" aria-label="Find in page">
                    <Search size={13} class="br-strip-ic" />
                    <input
                        ref={findInput}
                        class="br-find-input"
                        type="text"
                        aria-label="Find in page"
                        placeholder="Find in page"
                        spellcheck={false}
                        autocomplete="off"
                        value={query()}
                        onInput={(e) => {
                            setQuery(e.currentTarget.value);
                            clearTimeout(typed);
                            typed = setTimeout(() => void search(0), TYPED_MS);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") {
                                e.preventDefault();
                                e.stopPropagation();
                                closeFind();
                            } else if (e.key === "Enter") {
                                e.preventDefault();
                                clearTimeout(typed);
                                // The first Enter after typing searches; the next ones move along.
                                void search(found() ? (e.shiftKey ? -1 : 1) : 0);
                            }
                        }}
                    />
                    <span class="br-strip-count" aria-live="polite">{found() ? (found()!.matches ? `${found()!.active} of ${found()!.matches}` : "No matches") : ""}</span>
                    <button class="hb sm" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={!found()?.matches} onClick={() => void search(-1)}><ChevronUp size={14} /></button>
                    <button class="hb sm" aria-label="Next match" title="Next (Enter)" disabled={!found()?.matches} onClick={() => void search(1)}><ChevronDown size={14} /></button>
                    <button class="hb sm" aria-label="Close find" title="Close (Esc)" onClick={closeFind}><X size={14} /></button>
                </div>
            </Show>
            <Show when={o.view()}>
                {(v) => (
                    <div class="br-strip" aria-label="Page size">
                        <Show when={v().device} fallback={<span class="br-strip-label">Fill pane</span>}>
                            {(d) => (
                                <>
                                    <input ref={widthInput} class="br-side" type="text" inputMode="numeric" aria-label="Width" value={d().width} onChange={(e) => typeSide("width", e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && typeSide("width", e.currentTarget.value)} />
                                    <span class="br-strip-x">×</span>
                                    <input class="br-side" type="text" inputMode="numeric" aria-label="Height" value={d().height} onChange={(e) => typeSide("height", e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && typeSide("height", e.currentTarget.value)} />
                                    <button class="hb sm" aria-label="Rotate" title="Rotate" onClick={rotate}><RotateCwSquare size={14} /></button>
                                </>
                            )}
                        </Show>
                        <span class="grow" />
                        <button class="hb sm" aria-label="Zoom out" title="Zoom out" disabled={zoom() <= 0.5} onClick={() => zoomBy(-1)}><Minus size={14} /></button>
                        <button class="br-strip-zoom" title="Actual size" aria-label={`Zoom ${Math.round(zoom() * 100)}%: actual size`} onClick={() => zoomBy(0)}>{Math.round(zoom() * 100)}%</button>
                        <button class="hb sm" aria-label="Zoom in" title="Zoom in" disabled={zoom() >= 2} onClick={() => zoomBy(1)}><Plus size={14} /></button>
                        <button class="hb sm" aria-label="Fill pane at 100%" title={`${viewLabel(v())}: back to filling the pane at 100%`} onClick={() => setView(undefined)}><X size={14} /></button>
                    </div>
                )}
            </Show>
        </>
    );
    return { menu, bars };
}
