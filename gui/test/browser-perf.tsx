// Mounts the real pane on the real stream and records, for a driver outside the page (scripts/browser-perf.ts):
// when each frame arrives, decodes and is drawn, and what the remote page's code blocks say in each drawn picture.
import { render } from "solid-js/web";
import { BrowserPane } from "../src/components/BrowserPane";
import { rpc, setApp, type SessionHandle } from "../src/state/app";
import { adoptBrowserState } from "../src/state/browser";
import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/styles/shell.css";
import "../src/styles/panel.css";
import "../src/styles/browser.css";

const params = new URLSearchParams(location.search);
const id = params.get("session")!;
const [paneWidth, paneHeight] = (params.get("pane") ?? "720x900").split("x");
Object.assign(document.getElementById("root")!.style, { width: `${paneWidth}px`, height: `${paneHeight}px` });
type Log = { frames: [number, number, boolean][]; draws: [number, number[]][]; decodes: number[]; inputs: [number, string][] };
const log: Log = { frames: [], draws: [], decodes: [], inputs: [] };
(window as any).__perf = log;

const probe = new OffscreenCanvas(1, 1);
const pctx = probe.getContext("2d", { willReadFrequently: true })!;
// Three rows of six 12px blocks at the page's top-left: each row a 6-bit number (black = 1).
function codes(img: CanvasImageSource & { width: number; height: number }, cssWidth: number): number[] {
    const s = img.width / cssWidth;
    const out: number[] = [];
    for (let row = 0; row < 3; row++) {
        let n = 0;
        for (let b = 0; b < 6; b++) {
            pctx.drawImage(img, Math.round((b * 12 + 6) * s), Math.round((row * 12 + 6) * s), 1, 1, 0, 0, 1, 1);
            const d = pctx.getImageData(0, 0, 1, 1).data;
            if (d[0]! + d[1]! + d[2]! < 384) n |= 1 << b;
        }
        out.push(n);
    }
    return out;
}

const decode = window.createImageBitmap.bind(window);
window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
    const t = performance.now();
    const image = (await (decode as any)(...args)) as ImageBitmap;
    log.decodes.push(performance.now() - t);
    return image;
}) as typeof createImageBitmap;

const make = rpc.browserStream.bind(rpc);
rpc.browserStream = () => {
    const stream = make();
    stream.onFrame((f) => log.frames.push([performance.now(), f.data.byteLength, f.data[0] === 137]));
    return stream;
};
const drawImage = CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: any[]) {
    (drawImage as any).apply(this, args);
    const img = args[0] as ImageBitmap;
    if (this.canvas.classList.contains("br-canvas") && args.length === 5) log.draws.push([performance.now(), codes(img, args[3] as number)]);
} as any;
for (const t of ["wheel", "keydown", "mousemove", "mousedown"]) window.addEventListener(t, () => log.inputs.push([performance.now(), t]), true);

async function run() {
    rpc.onState((s) => setApp("conn", s));
    await rpc.connect();
    for (let i = 0; rpc.state !== "open"; i++) { if (i > 500) throw new Error("main connection failed"); await new Promise((r) => setTimeout(r, 10)); }
    adoptBrowserState(id, await rpc.call("browser.state", { id }));
    render(() => <div class="insp-body br-body" style="width:100%"><div class="pane"><BrowserPane handle={{ id } as SessionHandle} /></div></div>, document.getElementById("root")!);
    document.getElementById("result")!.dataset.status = "mounted";
}
run().catch((e) => { document.getElementById("result")!.textContent = String(e?.stack ?? e); document.getElementById("result")!.dataset.status = "failed"; });
