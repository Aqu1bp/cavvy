// Mount the production pane: real layout, canvas decoding, subscriptions and DOM input events.
import { render } from "solid-js/web";
import { BrowserPane } from "../src/components/BrowserPane";
import { rpc, setApp, type SessionHandle } from "../src/state/app";
import { adoptBrowserState, browserState } from "../src/state/browser";
import type { BrowserState, ServerEvent } from "@shared/protocol";
import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/styles/shell.css";
import "../src/styles/sidebar.css";
import "../src/styles/header.css";
import "../src/styles/stage.css";
import "../src/styles/panel.css";
import "../src/styles/browser.css";
import "../src/styles/review.css";
import "../src/styles/agent-view.css";
import "../src/styles/home.css";
import "../src/styles/toasts.css";
import "../src/styles/settings.css";
import "../src/styles/project-scripts.css";
import "../src/styles/usage.css";
import "../src/styles/runs.css";
import "../src/styles/transcript.css";
import "../src/styles/composer.css";
import "../src/styles/plan.css";
import "../src/styles/overlays.css";
import "../src/styles/markdown.css";

const root = document.getElementById("root")!;
const result = document.getElementById("result")!;
const calls: { method: string; params: any }[] = [];
const id = "pane-fixture";
const handle = { id } as SessionHandle;
const state = (active: number): BrowserState => ({ status: "ready", active, tabs: [1, 2].map(id => ({ id, title: `Page ${id}`, url: "http://localhost/", loading: false, owner: "agent", canGoBack: false, canGoForward: false, crashed: false })) });
rpc.call = (async (method: string, params: any) => { calls.push({ method, params }); return browserState(id); }) as typeof rpc.call;
rpc.browserStream = () => rpc;
rpc.state = "open";
rpc.connect = async () => {};
rpc.close = () => {};
rpc.notify = (method, params) => { void rpc.call(method, params as never); };
setApp("conn", "open");
const emit = (event: ServerEvent) => { for (const listener of (rpc as any).listeners) listener(event); };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 20));
function check(ok: unknown, why: string): asserts ok { if (!ok) throw new Error(why); }
const inputs = () => calls.filter(c => c.method === "browser.input");
const data = (() => {
    const c = document.createElement("canvas"); c.width = 480; c.height = 500;
    const ctx = c.getContext("2d")!; ctx.fillStyle = "red"; ctx.fillRect(0, 0, 480, 500);
    return c.toDataURL("image/jpeg").split(",")[1];
})();
const frame = (tab: number, frameId: string) => emit({ type: "browser.frame", sessionId: id, tab, frameId, data, width: 480, height: 500 });
const mount = () => render(() => <div class="insp-body br-body" style="width:100%"><div class="pane"><BrowserPane handle={handle}/></div></div>, root);

async function run() {
    adoptBrowserState(id, { status: "idle", tabs: [] });
    let dispose = mount();
    try {
        await tick();
        const view = root.querySelector<HTMLElement>(".br-view")!;
        check(view.clientWidth >= 400 && view.clientHeight > 400, `pane collapsed to ${view.clientWidth}x${view.clientHeight}`);
        check(root.textContent?.includes("No page open"), "empty state missing");
        check(calls.some(c => c.method === "browser.watch" && c.params.height > 400), "pane never subscribes at its rendered size");
        adoptBrowserState(id, state(1));
        frame(1, "red");
        await tick();
        const canvas = root.querySelector("canvas")!;
        const pixel = canvas.getContext("2d")!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
        check(pixel[0] > 240 && pixel[1] < 20, `frame was not drawn: ${pixel}`);
        check(calls.some(c => c.method === "browser.ack" && c.params.frameId === "red"), "matching acknowledgement missing");

        // Pause decoding across a tab change and then across unmount.
        const decode = window.createImageBitmap.bind(window);
        let resolve!: (b: ImageBitmap) => void;
        let closed = 0;
        const delayed = async () => {
            const blob = await (await fetch(`data:image/jpeg;base64,${data}`)).blob();
            const bitmap = await decode(blob);
            const close = bitmap.close.bind(bitmap);
            bitmap.close = () => { closed++; close(); };
            window.createImageBitmap = (() => new Promise<ImageBitmap>(r => { resolve = r; })) as typeof createImageBitmap;
            return bitmap;
        };
        const late = await delayed();
        frame(1, "late-tab");
        adoptBrowserState(id, state(2));
        resolve(late);
        await tick();
        check(closed === 1, "late bitmap leaked after tab switch");
        check(canvas.getContext("2d")!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[3] === 0, "departed tab redrawn");
        window.createImageBitmap = decode;
        frame(2, "new-tab"); await tick();

        const keyboard = root.querySelector("textarea")!;
        keyboard.focus();
        keyboard.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        keyboard.dispatchEvent(new KeyboardEvent("keydown", { key: "Process", isComposing: true, bubbles: true }));
        keyboard.value = "日本語";
        keyboard.dispatchEvent(new InputEvent("input", { data: "日本語", isComposing: true, bubbles: true }));
        keyboard.dispatchEvent(new CompositionEvent("compositionend", { data: "日本語", bubbles: true }));
        keyboard.dispatchEvent(new InputEvent("input", { data: "日本語", inputType: "insertFromComposition", bubbles: true }));
        check(inputs().filter(c => c.params.input.kind === "text" && c.params.input.text === "日本語").length === 1, "IME text missing or duplicated");
        check(!inputs().some(c => c.params.input.key === "Process"), "composition keys leaked");
        keyboard.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        keyboard.dispatchEvent(new FocusEvent("blur"));
        keyboard.dispatchEvent(new CompositionEvent("compositionend", { data: "cancelled", bubbles: true }));
        check(!inputs().some(c => c.params.input.text === "cancelled"), "cancelled composition reached the page");


        const rect = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new MouseEvent("mousedown", { clientX: rect.left + 100, clientY: rect.top + 100, button: 0, buttons: 1, bubbles: true }));
        keyboard.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", bubbles: true }));
        const afterUnmount = await delayed(); frame(2, "late-unmount");
        dispose();
        const count = inputs().length;
        check(inputs().some(c => c.params.tab === 2 && c.params.input.kind === "mouse" && c.params.input.type === "up"), "held mouse not released");
        check(inputs().some(c => c.params.tab === 2 && c.params.input.key === "Shift" && c.params.input.type === "up"), "held key not released");
        window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        check(inputs().length === count, "disposed pane still receives mouseup");
        resolve(afterUnmount); await tick();
        check(Number(closed) === 2, "late bitmap leaked after unmount");
        window.createImageBitmap = decode;
        result.dataset.status = "passed";
        result.textContent = "Mounted pane: layout, frames, stale decode, drag/key cleanup and IME passed.";
    } finally { dispose(); }
}
run().catch(e => { result.dataset.status = "failed"; result.textContent = e.stack ?? String(e); });
