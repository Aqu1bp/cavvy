// The agent's browser, watched over the chat (the Electron desktop app): while the agent works in a page and the
// Browser pane isn't open, a small live view of its tab floats at the conversation's top right, so the person sees
// what it does without opening anything. The page is the real one, at the agent's size, drawn scaled into the box
// (BrowserHostLayer); it's for watching: a click on it, or Expand, opens the Browser pane, where it's theirs to use.

import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { Maximize2, X } from "lucide-solid";
import type { SessionHandle } from "../state/app";
import { browserActivityAt, browserPaneShown, browserState, showBrowser } from "../state/browser";
import { setShownBrowser, unshowBrowser } from "../state/browser-host";
import { followBox } from "../lib/follow-box";
import { settingsTab } from "../state/ui";
import { currentTab, tabLabel } from "../lib/browser";
import { electron } from "../lib/platform";

/** It stays this long after the agent's turn ends, so its last page can be seen. */
const LINGER_MS = 4000;

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
            <Floating title={tabLabel(tab()!)} targetId={tab()!.targetId!} onHide={() => setDismissed(true)} />
        </Show>
    );
}

function Floating(p: { title: string; targetId: string; onHide: () => void }) {
    let page!: HTMLDivElement;
    let placed = "";
    const place = () => {
        const r = page.getBoundingClientRect();
        const box = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
        const key = `${p.targetId} ${box.x} ${box.y} ${box.width} ${box.height}`;
        if (key !== placed && box.width > 0 && box.height > 0) {
            placed = key;
            setShownBrowser({ targetId: p.targetId, box, by: "float", fit: true });
        }
    };
    onMount(() => {
        // The page box moves with the conversation's layout (panels opening, the window resizing).
        const follow = followBox(page, place);
        onCleanup(() => {
            follow.stop();
            unshowBrowser("float");
        });
    });
    return (
        <div class="br-float glass" role="region" aria-label="The agent's browser">
            <div class="br-float-bar">
                <span class="br-dot" />
                <span class="br-float-title truncate" title={p.title}>{p.title}</span>
                <button class="hb sm" aria-label="Open in the side panel" title="Open in the side panel" onClick={showBrowser}>
                    <Maximize2 size={13} />
                </button>
                <button class="hb sm" aria-label="Hide" title="Hide until the agent's next turn" onClick={p.onHide}>
                    <X size={13} />
                </button>
            </div>
            <div ref={page} class="br-float-page" title="Open in the side panel" onClick={showBrowser} />
        </div>
    );
}
