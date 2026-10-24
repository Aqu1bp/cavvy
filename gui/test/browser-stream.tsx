// Real pane, authenticated binary transport, server-owned Chrome and real remote input.
import { render } from "solid-js/web";
import { BrowserPane } from "../src/components/BrowserPane";
import { rpc, setApp, type SessionHandle } from "../src/state/app";
import { adoptBrowserState } from "../src/state/browser";
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
const result = document.getElementById("result")!;
const options = new URLSearchParams(location.search);
const id = options.get("session")!;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
function check(ok: unknown, why: string): asserts ok { if (!ok) throw new Error(why); }
async function until(fn: () => boolean, why: string, limit = 8000) {
    const end = performance.now() + limit;
    while (!fn()) { if (performance.now() > end) throw new Error(why); await sleep(8); }
}
const sockets: WebSocket[] = [];
const NativeSocket = window.WebSocket;
window.WebSocket = class extends NativeSocket {
    constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); }
};
const decode = window.createImageBitmap.bind(window);
let decoded = 0;
let lossless = 0;
const makeStream = rpc.browserStream.bind(rpc);
rpc.browserStream = () => {
    const stream = makeStream();
    stream.onFrame(f => { if (f.data[0] === 137 && f.data[1] === 80) lossless++; });
    return stream;
};
let largest = { width: 0, height: 0 };
window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
    const image = await (decode as any)(...args) as ImageBitmap;
    decoded++;
    largest = { width: image.width, height: image.height };
    return image;
}) as typeof createImageBitmap;

async function run() {
    rpc.onState(s => setApp("conn", s));
    await rpc.connect();
    await until(() => rpc.state === "open", "main connection failed");
    adoptBrowserState(id, await rpc.call("browser.state", { id }));
    const root = document.getElementById("root")!;
    const dispose = render(() => <div class="insp-body br-body" style="width:100%"><div class="pane"><BrowserPane handle={{ id } as SessionHandle}/></div></div>, root);
    try {
        await until(() => decoded > 1, "no decoded pictures from the real stream");
        const canvas = root.querySelector("canvas")!;
        const pixel = () => Array.from(canvas.getContext("2d")!.getImageData(10 * devicePixelRatio, 10 * devicePixelRatio, 1, 1).data);
        await until(() => pixel()[0]! > 240 && pixel()[2]! < 20, "initial remote page was not painted");
        check(largest.width === canvas.clientWidth * 2 && largest.height === canvas.clientHeight * 2,
            `stream is not Retina: ${JSON.stringify(largest)} for ${canvas.clientWidth}x${canvas.clientHeight}`);
        const click = (x: number, y: number) => {
            const rect = canvas.getBoundingClientRect();
            canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: rect.x+x, clientY: rect.y+y, button: 0, buttons: 1, detail: 1 }));
            window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: rect.x+x, clientY: rect.y+y, button: 0, buttons: 0, detail: 1 }));
        };
        const latencies: number[] = [];
        for (let i=0; i<20; i++) {
            const start = performance.now();
            click(100, 70);
            const blue = i % 2 === 0;
            await until(() => blue ? pixel()[2]! > 240 && pixel()[0]! < 20 : pixel()[0]! > 240 && pixel()[2]! < 20, "click did not reach the remote page and return as a painted frame");
            latencies.push(performance.now()-start);
        }
        click(350, 70);
        const motionStart = performance.now();
        const motionFrames = decoded;
        await sleep(2000);
        const motionFps = Math.round((decoded-motionFrames) * 1000 / (performance.now()-motionStart));
        check(decoded-motionFrames >= 10, "animation stream stalled");
        const motionLatencies: number[] = [];
        for (let i=0; i<20; i++) {
            const start = performance.now(); click(100, 70);
            const blue = i % 2 === 0;
            await until(() => blue ? pixel()[2]! > 240 && pixel()[0]! < 20 : pixel()[0]! > 240 && pixel()[2]! < 20, "input stalled during animation");
            motionLatencies.push(performance.now()-start);
        }
        click(350, 70);
        await until(() => lossless > 0, "settled page never received a lossless picture");
        // Input bridge into the remote form; the remote input handler turns the marker green.
        click(120, 140);
        const keyboard = root.querySelector("textarea")!;
        keyboard.value = "日本語";
        keyboard.dispatchEvent(new InputEvent("input", { bubbles: true, data: "日本語", inputType: "insertFromPaste" }));
        await until(() => pixel()[1]! > 240 && pixel()[0]! < 20 && pixel()[2]! < 20, "text never reached remote input");
        const rect = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: rect.x+350, clientY: rect.y+300, deltaY: 700 }));
        await until(() => pixel()[0]! > 240 && pixel()[1]! > 240 && pixel()[2]! < 20, "wheel did not scroll the remote page");
        // Reconnection must restore the stream without dropping the chat/RPC connection.
        const live = sockets.find(s => s.url.includes("/browser-stream") && s.readyState === WebSocket.OPEN)!;
        const count = decoded;
        keyboard.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Shift", code: "ShiftLeft", shiftKey: true }));
        await sleep(50);
        live.close();
        await until(() => decoded > count + 1, "stream did not recover after disconnect");
        check(rpc.state === "open", "stream disconnect interrupted chat");
        await until(() => pixel()[0]! > 240 && pixel()[2]! > 240 && pixel()[1]! < 20, "disconnect left a remote modifier held");
        // A real resize must update both the page and encoded pixel dimensions.
        root.style.width = "600px";
        await until(() => largest.width === 1200, "resized stream retained old dimensions");
        latencies.sort((a,b) => a-b);
        motionLatencies.sort((a,b) => a-b);
        return { dpr: devicePixelRatio, clickToPaintMs: { p50: Math.round(latencies[10]!), p95: Math.round(latencies[18]!), max: Math.round(latencies[19]!) }, samples: latencies.length, motion: { fps: motionFps, p50: Math.round(motionLatencies[10]!), p95: Math.round(motionLatencies[18]!) }, lossless, decoded, resized: largest };
    } finally { dispose(); rpc.close(); }
}
run().then(metrics => { result.textContent = JSON.stringify(metrics); result.dataset.status = "passed"; }, error => { result.textContent = error.stack ?? String(error); result.dataset.status = "failed"; });
