// The Electron desktop app's browser tabs, as <webview>s: real Chromium pages, which the agent drives through the app
// (desktop-electron/src/browser-host.ts) and the person uses directly. A webview lives as long as its tab and is never
// moved in the page (moving one reloads it), so they all sit in this layer: the one a Browser pane shows over the
// pane's page box, under the window's menus and dialogs (or the one the floating view shows, scaled into its box); the
// rest clipped to a pixel in the corner, behind everything, at the size the agent works at. Inside the window, so they go on rendering: Electron stops a page that's entirely
// outside it, and the agent's clicks and screenshots then fail.

import { createEffect, For, onCleanup, onMount } from "solid-js";
import { electron } from "../lib/platform";
import { hostedTabs, hostedTargets, setHostedTabs, setHostedTargets, shownBrowser, type HostedTab } from "../state/browser-host";

/** The size of a tab no pane shows (or the floating view shows, scaled): the agent's, as a headless browser's would be. */
export const AGENT_SIZE = { width: 1280, height: 800 };

export function BrowserHostLayer() {
    onMount(() => {
        const off = electron!.onBrowser((e) => {
            if (e.type === "create") setHostedTabs((tabs) => [...tabs, { key: e.key, partition: e.partition }]);
            else if (e.type === "ready") setHostedTargets((ids) => ({ ...ids, [e.key]: e.targetId }));
            else if (e.type === "sleep") {
                // Asleep (the app froze it: nobody sees it or has used it a while): hidden, so Chromium stops drawing it.
                const view = document.querySelector<HTMLElement>(`webview[data-key="${e.key}"]`);
                if (view) view.style.visibility = e.asleep ? "hidden" : "";
            } else if (e.type === "destroy") {
                setHostedTabs((tabs) => tabs.filter((t) => t.key !== e.key));
                setHostedTargets(({ [e.key]: _, ...ids }) => ids);
            }
        });
        onCleanup(off);
    });
    // Which tabs are on screen, for the app: it freezes tabs nobody sees and nobody has used for a while.
    createEffect(() => {
        const s = shownBrowser();
        const ids = hostedTargets();
        electron!.browserShown(s ? hostedTabs().filter((t) => ids[t.key] === s.targetId).map((t) => t.key) : []);
    });
    return (
        <div class="br-host" aria-hidden="true">
            <For each={hostedTabs()}>{(t) => <HostedWebview tab={t} />}</For>
        </div>
    );
}

function HostedWebview(p: { tab: HostedTab }) {
    let wrap!: HTMLDivElement;
    let reported = "";
    onMount(() => {
        // Made by hand, so the partition is set before it loads anything (it can't change after).
        const view = document.createElement("webview");
        view.setAttribute("partition", p.tab.partition);
        // Its page may ask for popups; the app says what becomes of each (desktop-electron/src/browser-host.ts).
        view.setAttribute("allowpopups", "");
        view.setAttribute("src", `about:blank#${p.tab.key}`);
        view.className = "br-host-view";
        view.dataset.key = p.tab.key;
        wrap.appendChild(view);
        createEffect(() => {
            const s = shownBrowser();
            const targetId = hostedTargets()[p.tab.key];
            const shown = s && targetId && s.targetId === targetId ? s : undefined;
            const box = shown?.box;
            // In the pane the page is the box's size; watched in the floating view, or not shown, it's the agent's.
            const size = box && !shown.fit ? { width: box.width, height: box.height } : AGENT_SIZE;
            const scale = box && shown.fit ? Math.min(box.width / size.width, box.height / size.height) : 1;
            wrap.classList.toggle("shown", box !== undefined);
            wrap.classList.toggle("fit", shown?.fit === true);
            wrap.classList.toggle("entering", shown?.motion === "enter");
            wrap.classList.toggle("leaving", shown?.motion === "leave");
            wrap.style.transformOrigin = shown?.origin ? `${shown.origin.x}px ${shown.origin.y}px` : "";
            Object.assign(wrap.style, box ? { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` } : { left: "0px", top: "0px", width: "1px", height: "1px" });
            Object.assign(view.style, { width: `${size.width}px`, height: `${size.height}px`, transform: scale === 1 ? "" : `scale(${scale})` });
            const key = `${size.width}x${size.height}`;
            if (key !== reported) {
                reported = key;
                electron!.browserSized(p.tab.key, { ...size, scale: window.devicePixelRatio || 1 });
            }
        });
    });
    return <div ref={wrap} class="br-host-tab" />;
}
