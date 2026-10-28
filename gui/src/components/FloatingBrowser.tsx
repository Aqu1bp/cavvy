// The agent's browser, watched over the chat (the Electron desktop app): while the agent works in a page and the
// Browser pane isn't open, a small live view of its tab floats at the conversation's top right, so the person sees
// what it does without opening anything. The page is the real one, at the agent's size, drawn scaled into the box
// (BrowserHostLayer); it's for watching: a click on it, or Expand, opens the Browser pane, where it's theirs to use.
// Its free edges (left, bottom, and the corner between) resize it, keeping the page's shape (lib/browser-float.ts).

import { batch, createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { Maximize2, X } from "lucide-solid";
import type { SessionHandle } from "../state/app";
import { browserActivityAt, browserPaneShown, browserState, showBrowser } from "../state/browser";
import { setShownBrowser, unshowBrowser } from "../state/browser-host";
import { followBox } from "../lib/follow-box";
import { frameDrag } from "../lib/drag";
import { dockHeight, settingsTab } from "../state/ui";
import { currentTab, tabLabel } from "../lib/browser";
import { clampFloat, dragWidth, floatHost, floatMax, keyWidth, FLOAT_DEFAULT, type FloatEdge, type FloatRoom } from "../lib/browser-float";
import { electron } from "../lib/platform";

/** It stays this long after the agent's turn ends, so its last page can be seen. */
const LINGER_MS = 4000;

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
    let linger: ReturnType<typeof setTimeout> | undefined;
    createEffect(
        on(busy, (now, before) => {
            clearTimeout(linger);
            if (now && !before) {
                setTurnStart(Date.now());
                setDismissed(false);
                setLingering(false);
            } else if (!now && before) {
                setLingering(true);
                linger = setTimeout(() => setLingering(false), LINGER_MS);
            }
        }),
    );
    onCleanup(() => clearTimeout(linger));

    const visible = () => {
        const t = tab();
        return !!t?.targetId && t.owner === "agent" && !dismissed() && !settingsTab() && !browserPaneShown(id()) && (busy() || lingering()) && browserActivityAt(id()) >= turnStart();
    };

    return (
        <Show when={visible()}>
            <Floating title={tabLabel(tab()!)} host={floatHost(tab()!.url, tabLabel(tab()!))} live={busy()} targetId={tab()!.targetId!} onHide={() => setDismissed(true)} />
        </Show>
    );
}

function Floating(p: { title: string; host?: string; live: boolean; targetId: string; onHide: () => void }) {
    let float!: HTMLDivElement;
    let page!: HTMLDivElement;
    let placed = "";
    // Not rounded: the page has to sit exactly in its frame.
    const place = () => {
        const r = page.getBoundingClientRect();
        const box = { x: r.left, y: r.top, width: r.width, height: r.height };
        const key = `${p.targetId} ${box.x} ${box.y} ${box.width} ${box.height}`;
        if (key !== placed && box.width > 0 && box.height > 0) {
            placed = key;
            setShownBrowser({ targetId: p.targetId, box, by: "float", fit: true });
        }
    };
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
        <div ref={float} class="br-float" style={room() ? { width: `${width()}px` } : undefined}>
            <div class="br-float-card glass" role="region" aria-label="The agent's browser">
                <div class="br-float-bar">
                    <span class={`br-live ${p.live ? "on" : ""}`} title={p.live ? "The agent is using this page" : undefined} />
                    <span class="br-float-title truncate" title={p.title}>{p.title}</span>
                    <Show when={p.host}>{(host) => <span class="br-float-host truncate">{host()}</span>}</Show>
                    <span class="grow" />
                    <button class="hb sm" aria-label="Open in the side panel" title="Open in the side panel" onClick={showBrowser}>
                        <Maximize2 size={13} />
                    </button>
                    <button class="hb sm" aria-label="Hide" title="Hide until the agent's next turn" onClick={p.onHide}>
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
