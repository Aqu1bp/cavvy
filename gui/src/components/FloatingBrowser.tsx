// The agent's browser, watched over the chat (the Electron desktop app): while the agent works in a page and the
// Browser pane isn't open, a small live view of its tab floats at the conversation's top right, so the person sees
// what it does without opening anything. The page is the real one, at the agent's size, drawn scaled into the box
// (BrowserHostLayer); it's for watching: a click on it, or Expand, opens the Browser pane, where it's theirs to use.
// Its free edges (left, bottom, and the corner between) resize it, keeping the page's shape (lib/browser-float.ts).
//
// It goes a moment after the agent's turn ends, unless the pointer is on it (then a moment after it leaves), or the
// person has used it (pressed in it, resized it): then it stays, past the turn, until they close it or open the page
// in the side panel. It fades in, and fades out shrinking toward its corner, the page with it.

import { batch, createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { Maximize2, X } from "lucide-solid";
import type { SessionHandle } from "../state/app";
import { browserActivityAt, browserPaneShown, browserState, showBrowser } from "../state/browser";
import { setShownBrowser, unshowBrowser } from "../state/browser-host";
import { followBox } from "../lib/follow-box";
import { frameDrag } from "../lib/drag";
import { dockHeight, settingsTab } from "../state/ui";
import { currentTab, tabLabel } from "../lib/browser";
import { clampFloat, dragWidth, floatHost, floatMax, floatShown, keyWidth, FLOAT_DEFAULT, type FloatEdge, type FloatRoom } from "../lib/browser-float";
import { electron } from "../lib/platform";

/** It stays this long after the agent's turn ends, so its last page can be seen. */
const LINGER_MS = 4000;
/** And this long after the pointer leaves it, once the turn is over. */
const AFTER_HOVER_MS = 2000;
/** In case its leaving animation never ends (it ends at once with no motion). */
const LEAVE_MOST_MS = 800;

/** Sessions whose floating view the person has used: it stays after the agent's turn, until they close it. */
const [kept, setKept] = createSignal<ReadonlySet<string>>(new Set());
function keep(id: string, on: boolean) {
    setKept((s) => {
        if (s.has(id) === on) return s;
        const next = new Set(s);
        if (on) next.add(id);
        else next.delete(id);
        return next;
    });
}

const WIDTH_KEY = "cavvy.browserFloatWidth";
/** The width it was given (kept across sessions and restarts); drawn within its room. */
const [savedWidth, setSavedWidth] = createSignal(Number(globalThis.localStorage?.getItem(WIDTH_KEY)) || FLOAT_DEFAULT);
/** A width given (dragged, or from the keyboard), or none: the usual one again. */
function saveWidth(w: number | undefined) {
    setSavedWidth(w ?? FLOAT_DEFAULT);
    try {
        if (w === undefined) localStorage.removeItem(WIDTH_KEY);
        else localStorage.setItem(WIDTH_KEY, String(w));
    } catch { /* private mode */ }
}

export function FloatingBrowser(p: { handle: SessionHandle }) {
    if (!electron) return null;
    const id = () => p.handle.id;
    const busy = () => p.handle.view.state.busy;
    const tab = () => currentTab(browserState(id()));
    const [turnStart, setTurnStart] = createSignal(0);
    const [lingering, setLingering] = createSignal(false);
    const [dismissed, setDismissed] = createSignal(false);
    const [hovered, setHovered] = createSignal(false);
    let linger: ReturnType<typeof setTimeout> | undefined;
    const lingerFor = (ms: number) => {
        clearTimeout(linger);
        setLingering(true);
        linger = setTimeout(() => setLingering(false), ms);
    };
    createEffect(
        on(busy, (now, before) => {
            clearTimeout(linger);
            if (now && !before) {
                setTurnStart(Date.now());
                setDismissed(false);
                setLingering(false);
            } else if (!now && before) lingerFor(LINGER_MS);
        }),
    );
    onCleanup(() => clearTimeout(linger));
    const hover = (on: boolean) => {
        setHovered(on);
        if (!on && !busy()) lingerFor(AFTER_HOVER_MS);
    };
    // In the side panel it's theirs to use there: closing the panel doesn't bring it back floating.
    createEffect(on(() => browserPaneShown(id()), (shown) => shown && keep(id(), false), { defer: true }));

    /** Where the page goes instead (the side panel, or Settings over the conversation). */
    const elsewhere = () => browserPaneShown(id()) || Boolean(settingsTab());
    const visible = () =>
        floatShown({
            agentTab: Boolean(tab()?.targetId) && tab()!.owner === "agent",
            closed: dismissed(),
            elsewhere: elsewhere(),
            kept: kept().has(id()),
            busy: Boolean(busy()),
            lingering: lingering(),
            hovered: hovered(),
            usedThisTurn: browserActivityAt(id()) >= turnStart(),
        });
    // Drawn while visible, and while it fades away after; to the side panel, the page goes at once.
    const [drawn, setDrawn] = createSignal(false);
    const [leaving, setLeaving] = createSignal(false);
    createEffect(
        on(visible, (v) => {
            if (v) return batch(() => (setLeaving(false), setDrawn(true)));
            if (!drawn()) return;
            if (elsewhere() || !tab()?.targetId) batch(() => (setLeaving(false), setDrawn(false)));
            else setLeaving(true);
        }),
    );
    const left = () => batch(() => {
        if (!leaving()) return;
        setLeaving(false);
        setDrawn(false);
        setHovered(false);
    });

    return (
        <Show when={drawn() && tab()?.targetId}>
            <Floating
                title={tabLabel(tab()!)}
                host={floatHost(tab()!.url, tabLabel(tab()!))}
                live={busy()}
                targetId={tab()!.targetId!}
                leaving={leaving()}
                onLeft={left}
                onHover={hover}
                onKeep={() => keep(id(), true)}
                onHide={() => batch(() => (keep(id(), false), setDismissed(true)))}
            />
        </Show>
    );
}

function Floating(p: { title: string; host?: string; live: boolean; targetId: string; leaving: boolean; onLeft: () => void; onHover: (on: boolean) => void; onKeep: () => void; onHide: () => void }) {
    let float!: HTMLDivElement;
    let page!: HTMLDivElement;
    let placed = "";
    let entered = false;
    // Not rounded: the page has to sit exactly in its frame. Not while it goes: the page goes as it was, with the card.
    const place = () => {
        if (p.leaving) return;
        const r = page.getBoundingClientRect();
        const box = { x: r.left, y: r.top, width: r.width, height: r.height };
        const key = `${p.targetId} ${box.x} ${box.y} ${box.width} ${box.height}`;
        if (key !== placed && box.width > 0 && box.height > 0) {
            placed = key;
            setShownBrowser({ targetId: p.targetId, box, by: "float", fit: true, motion: entered ? undefined : "enter" });
            entered = true;
        }
    };
    createEffect(
        on(() => p.leaving, (leaving) => {
            if (!leaving) {
                // Back before it was gone: in place again, fading in with its card.
                placed = "";
                entered = false;
                place();
                return;
            }
            const card = float.getBoundingClientRect();
            const r = page.getBoundingClientRect();
            setShownBrowser((s) => (s?.by === "float" ? { ...s, motion: "leave", origin: { x: card.right - r.left, y: card.top - r.top } } : s));
            const most = setTimeout(p.onLeft, LEAVE_MOST_MS);
            onCleanup(() => clearTimeout(most));
        }, { defer: true }),
    );
    const [room, setRoom] = createSignal<FloatRoom>();
    /** The width while an edge is dragged; saved on release. */
    const [dragged, setDragged] = createSignal<number>();
    const max = () => (room() ? floatMax(room()!) : Infinity);
    const width = () => clampFloat(dragged() ?? savedWidth(), max());
    // Its room: the stage less the margin at its right (on both sides), from its top down to the composer's dock less that margin.
    const measure = () => {
        const stage = float.offsetParent as HTMLElement | null;
        if (!stage) return;
        const margin = parseFloat(getComputedStyle(float).right) || 0;
        setRoom({
            w: stage.clientWidth - 2 * margin,
            h: stage.clientHeight - float.offsetTop - dockHeight() - margin,
            chromeW: float.offsetWidth - page.offsetWidth,
            chromeH: float.offsetHeight - page.offsetHeight,
        });
    };
    onMount(() => {
        // The page box moves with the conversation's layout (panels opening, the window resizing).
        const follow = followBox(page, place);
        const stage = new ResizeObserver(measure);
        if (float.offsetParent) stage.observe(float.offsetParent);
        onCleanup(() => {
            stage.disconnect();
            follow.stop();
            unshowBrowser("float");
        });
    });
    createEffect(on(dockHeight, measure, { defer: true }));

    /** Ends the drag under way, if any: on release, and when the view goes away in the middle of one. */
    let stop: (() => void) | undefined;
    onCleanup(() => stop?.());
    const start = (edge: FloatEdge) => (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        stop?.();
        measure();
        const target = e.currentTarget as HTMLElement;
        target.setPointerCapture(e.pointerId);
        const [x, y, from] = [e.clientX, e.clientY, width()];
        document.body.classList.add("resizing");
        document.body.style.setProperty("--drag-cursor", getComputedStyle(target).cursor);
        float.classList.add("resizing");
        // Drawn once a frame, the page moved with it in the same frame; saved on release.
        const drag = frameDrag({
            show: (w) => (setDragged(w), place()),
            commit: (w) => batch(() => {
                if (w !== undefined) saveWidth(w);
                setDragged(undefined);
            }),
        });
        const move = (ev: PointerEvent) => drag.move(clampFloat(dragWidth(from, edge, ev.clientX - x, ev.clientY - y), max()));
        const end = () => {
            stop = undefined;
            drag.end();
            document.body.classList.remove("resizing");
            document.body.style.removeProperty("--drag-cursor");
            float.classList.remove("resizing");
            target.removeEventListener("pointermove", move);
            target.removeEventListener("lostpointercapture", end);
        };
        stop = end;
        target.addEventListener("pointermove", move);
        target.addEventListener("lostpointercapture", end);
    };
    const usual = () => saveWidth(undefined);

    return (
        <div
            ref={float}
            class={`br-float ${p.leaving ? "leaving" : ""}`}
            style={room() ? { width: `${width()}px` } : undefined}
            // Pressed anywhere in it (its bar, an edge, the page): it's been used, and stays.
            onPointerDown={p.onKeep}
            onPointerEnter={() => p.onHover(true)}
            onPointerLeave={() => p.onHover(false)}
            onAnimationEnd={(e) => e.target === float && p.leaving && p.onLeft()}
        >
            <div class="br-float-card glass" role="region" aria-label="The agent's browser">
                <div class="br-float-bar">
                    <span class={`br-live ${p.live ? "on" : ""}`} title={p.live ? "The agent is using this page" : undefined} />
                    <span class="br-float-title truncate" title={p.title}>{p.title}</span>
                    <Show when={p.host}>{(host) => <span class="br-float-host truncate">{host()}</span>}</Show>
                    <span class="grow" />
                    <button class="hb sm" aria-label="Open in the side panel" title="Open in the side panel" onClick={showBrowser}>
                        <Maximize2 size={13} />
                    </button>
                    <button class="hb sm" aria-label="Close" title="Close until the agent's next turn" onClick={p.onHide}>
                        <X size={13} />
                    </button>
                </div>
                <div ref={page} class="br-float-page" title="Open in the side panel" onClick={showBrowser} />
            </div>
            {/* The free edges, and the corner between with its handle (which the keyboard can use too). */}
            <div class="br-float-edge left" aria-hidden="true" onPointerDown={start("left")} onDblClick={usual} />
            <div class="br-float-edge bottom" aria-hidden="true" onPointerDown={start("bottom")} onDblClick={usual} />
            <div
                class="br-float-grip"
                role="separator"
                aria-label="Resize the agent's browser"
                aria-valuenow={width()}
                tabIndex={0}
                title="Drag to resize · double-click for the usual size"
                onPointerDown={start("corner")}
                onDblClick={usual}
                onKeyDown={(e) => {
                    const w = keyWidth(width(), e.key);
                    if (w === undefined) return;
                    e.preventDefault();
                    p.onKeep();
                    saveWidth(clampFloat(w, max()));
                }}
            >
                {/* Around the card's corner, a little outside it (the corner's center is at 17,7 here). */}
                <svg class="br-float-arc" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3.5 3V7A13.5 13.5 0 0 0 17 20.5H21" />
                </svg>
            </div>
        </div>
    );
}
