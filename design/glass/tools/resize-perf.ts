// Measures dragging the GUI's resize handles in headless Chrome over CDP (a proxy for WebKit):
// for each handle, a Chrome trace and Performance.getMetrics around ~120 pointer moves, then the
// frame times seen by requestAnimationFrame and the renderer main thread's time by kind.
//
//   bun design/glass/tools/resize-perf.ts <url with #token=…> [handles] [--json out.json]
//
// handles: a comma list of sidebar, inspector, review, terminal (default: all). The page opens the
// first session in the sidebar, so start the demo (`bun run gui:demo`) and send it a few prompts first.
// Env: W, H (viewport, default 1512x982), MOVES (default 120), STEP_MS (default 8: a 120Hz pointer),
// RUNS (default 3: the median run is reported), CHROME (the binary), INJECT_CSS (extra CSS to try), TRACE_DIR (keeps each handle's
// last trace there, for DevTools' Performance panel).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const args = process.argv.slice(2);
const url = args[0];
if (!url) throw new Error("usage: resize-perf.ts <url> [handles] [--json out.json]");
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
const wanted = (args[1] && !args[1].startsWith("--") ? args[1] : "sidebar,inspector,review,terminal").split(",");
const MOVES = Number(process.env.MOVES ?? 120);
const STEP_MS = Number(process.env.STEP_MS ?? 8);
const RUNS = Number(process.env.RUNS ?? 3);
const W = Number(process.env.W ?? 1512);
const H = Number(process.env.H ?? 982);

const port = 9333 + Math.floor(Math.random() * 500);
const profile = mkdtempSync("/tmp/cdp-");
const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "--no-first-run", `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });
// Chrome and its profile go however this ends.
process.on("exit", () => {
    proc.kill();
    rmSync(profile, { recursive: true, force: true });
});
let tab: any;
for (let i = 0; i < 50 && !tab; i++) {
    await Bun.sleep(200);
    try { tab = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t: any) => t.type === "page"); } catch {}
}
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const wait = new Map<number, (v: any) => void>();
const errors: string[] = [];
let traceEvents: any[] = [];
let traceDone: (() => void) | undefined;
ws.onmessage = (m) => {
    const d = JSON.parse(m.data as string);
    if (d.id && wait.has(d.id)) { wait.get(d.id)!(d); wait.delete(d.id); }
    if (d.method === "Tracing.dataCollected") traceEvents.push(...d.params.value);
    if (d.method === "Tracing.tracingComplete") traceDone?.();
    if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
};
const cdp = (method: string, params: any = {}) => new Promise<any>((r) => { const id = ++n; wait.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expression: string) => {
    const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${r.result.exceptionDetails.exception?.description}`);
    return r.result?.result?.value;
};
const click = (label: string) => js(`(() => { const b = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent.trim()).startsWith(${JSON.stringify(label)})); b?.click(); return Boolean(b); })()`);

await cdp("Runtime.enable");
await cdp("Page.enable");
await cdp("Performance.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await cdp("Page.navigate", { url });
await Bun.sleep(2500);
// INJECT_CSS: a style sheet to try (say, no blur while resizing) without rebuilding.
if (process.env.INJECT_CSS) await js(`document.head.appendChild(Object.assign(document.createElement("style"), { textContent: ${JSON.stringify(process.env.INJECT_CSS)} })) && true`);
// The first session in the rail, scrolled to its end.
await js(`document.querySelector(".win-rail .card-hit")?.click()`);
await Bun.sleep(1500);

/** What each handle needs open, and which way it drags. */
const HANDLES: Record<string, { open: () => Promise<unknown>; close: () => Promise<unknown>; selector: string; axis: "x" | "y"; span: number; width?: number }> = {
    sidebar: { open: async () => {}, close: async () => {}, selector: ".win-rail .resize-handle", axis: "x", span: 150 },
    inspector: {
        open: async () => { if (!(await js(`Boolean(document.querySelector(".insp-resizer"))`))) await click("Toggle panel"); },
        close: async () => { if (await js(`Boolean(document.querySelector(".insp-resizer"))`)) await click("Toggle panel"); },
        selector: ".insp-resizer:not(.rv-resizer)", axis: "x", span: 200,
    },
    review: {
        // Wide enough that the reader has room to grow (it's at least 55% of the sheet, and leaves the conversation 480px).
        width: 1900,
        open: async () => { await click("Changes"); },
        close: async () => { await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); },
        selector: ".rv-resizer", axis: "x", span: 200,
    },
    terminal: {
        open: async () => { if (!(await js(`Boolean(document.querySelector(".terminal-panel")?.offsetHeight)`))) await click("Toggle terminal"); },
        close: async () => { if (await js(`Boolean(document.querySelector(".terminal-panel")?.offsetHeight)`)) await click("Hide terminal"); },
        selector: ".terminal-resize", axis: "y", span: 200,
    },
};

const CATEGORIES = ["-*", "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "toplevel", "v8.execute", "blink.user_timing", "cc", "gpu", "viz"].join(",");

const KIND: [RegExp, string][] = [
    [/^(FunctionCall|EventDispatch|TimerFire|FireAnimationFrame|FireIdleCallback|EvaluateScript|RunMicrotasks|v8\.|V8\.|MinorGC|MajorGC|BlinkGC|GCEvent|ResizeObserver)/, "scripting"],
    [/^(UpdateLayoutTree|RecalculateStyles|ParseAuthorStyleSheet|ScheduleStyleRecalculation)/, "style"],
    [/^(Layout|ComputeIntersections|IntersectionObserverController)/, "layout"],
    [/^(PrePaint|Paint|Layerize|UpdateLayer|UpdateLayerTree|PaintImage|CompositeLayers|Commit|Decode)/, "paint"],
];
const kindOf = (name: string) => KIND.find(([re]) => re.test(name))?.[1] ?? "other";

/** Self time by kind on the renderer main thread, and raster/GPU time on the others. */
function breakdown(events: any[]) {
    const threads = new Map<string, string>();
    for (const e of events) if (e.ph === "M" && e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, e.args.name);
    const mains = [...threads].filter(([, name]) => name === "CrRendererMain").map(([k]) => k);
    // The page's renderer: the main thread with the most events.
    const count = new Map<string, number>();
    for (const e of events) { const k = `${e.pid}:${e.tid}`; if (mains.includes(k)) count.set(k, (count.get(k) ?? 0) + 1); }
    const main = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
    const spans = events.filter((e) => e.ph === "X" && typeof e.dur === "number" && `${e.pid}:${e.tid}` === main).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const out: Record<string, number> = { scripting: 0, style: 0, layout: 0, paint: 0, other: 0 };
    const counts: Record<string, number> = {};
    const stack: { end: number; kind: string; self: number }[] = [];
    const close = (until: number) => { while (stack.length && stack.at(-1)!.end <= until) { const s = stack.pop()!; out[s.kind] += s.self; } };
    for (const e of spans) {
        close(e.ts);
        if (stack.length) stack.at(-1)!.self -= e.dur;
        stack.push({ end: e.ts + e.dur, kind: kindOf(e.name), self: e.dur });
        counts[e.name] = (counts[e.name] ?? 0) + 1;
    }
    close(Infinity);
    let raster = 0;
    for (const e of events) if (e.ph === "X" && `${e.pid}:${e.tid}` !== main && /^(RasterTask|GPUTask|Rasterize)/.test(e.name)) raster += e.dur;
    const ms = (v: number) => Math.round(v / 10) / 100;
    return {
        mainThreadMs: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, ms(v)])),
        rasterMs: ms(raster),
        counts: { Layout: counts.Layout ?? 0, UpdateLayoutTree: counts.UpdateLayoutTree ?? 0, Paint: counts.Paint ?? 0, EventDispatch: counts.EventDispatch ?? 0 },
    };
}

async function metrics() {
    const r = await cdp("Performance.getMetrics");
    return Object.fromEntries(r.result.metrics.map((m: any) => [m.name, m.value])) as Record<string, number>;
}

async function drag(name: string) {
    const h = HANDLES[name]!;
    // A point on the handle that's hit by the pointer (part of a handle can be clipped or covered).
    const box = await js(`(() => {
        const el = document.querySelector(${JSON.stringify(h.selector)});
        const r = el?.getBoundingClientRect();
        if (!r || !(r.width + r.height)) return null;
        for (let f = 0.5; f > 0; f -= 0.1) for (const g of [f, 1 - f]) {
            const p = { x: r.x + r.width * (${JSON.stringify(h.axis)} === "x" ? g : 0.5), y: r.y + r.height * (${JSON.stringify(h.axis)} === "y" ? g : 0.5) };
            if (document.elementFromPoint(p.x, p.y) === el) return p;
        }
        return null;
    })()`);
    if (!box) throw new Error(`${name}: no handle (${h.selector})`);
    const at = (i: number) => {
        // Out and back: a triangle wave over the span, so the size ends where it started.
        const half = MOVES / 2;
        const d = (i <= half ? i / half : (MOVES - i) / half) * h.span * (h.axis === "x" ? (name === "sidebar" ? 1 : -1) : -1);
        return h.axis === "x" ? { x: box.x + d, y: box.y } : { x: box.x, y: box.y + d };
    };
    await js(`window.__stop = false; window.__frames = []; (function tick(t) { window.__frames.push(t); if (window.__frames.length < 100000 && !window.__stop) requestAnimationFrame(tick); })(performance.now()); true`);
    traceEvents = [];
    await cdp("Tracing.start", { categories: CATEGORIES, transferMode: "ReportEvents" });
    const before = await metrics();
    const t0 = performance.now();
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= MOVES; i++) {
        const p = at(i);
        const sent = performance.now();
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...p, button: "left", buttons: 1 });
        const left = STEP_MS - (performance.now() - sent);
        if (left > 0) await Bun.sleep(left);
    }
    const end = at(MOVES);
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...end, button: "left", buttons: 0, clickCount: 1 });
    const wall = performance.now() - t0;
    await Bun.sleep(300);
    const after = await metrics();
    const done = new Promise<void>((r) => (traceDone = r));
    await cdp("Tracing.end");
    await done;
    const frames: number[] = await js(`window.__stop = true; window.__frames`);
    // Frames during the drag only: from the press to the release (plus the frame after).
    const span = frames.filter((t, i) => i > 0 && t - frames[0]! <= wall + 20);
    const gaps = span.map((t, i) => t - (i ? span[i - 1]! : frames[0]!)).filter((g) => g > 0).sort((a, b) => a - b);
    const d = (k: string) => Math.round((after[k]! - before[k]!) * 100000) / 100;
    const b = breakdown(traceEvents);
    if (process.env.TRACE_DIR) await Bun.write(`${process.env.TRACE_DIR}/${name}.json`, JSON.stringify({ traceEvents }));
    const frameCount = gaps.length || 1;
    return {
        wallMs: Math.round(wall),
        frames: gaps.length,
        frameMs: { mean: Math.round((gaps.reduce((s, g) => s + g, 0) / frameCount) * 10) / 10, p95: Math.round((gaps[Math.floor(gaps.length * 0.95)] ?? 0) * 10) / 10, max: Math.round((gaps.at(-1) ?? 0) * 10) / 10 },
        metrics: { script: d("ScriptDuration"), style: d("RecalcStyleDuration"), layout: d("LayoutDuration"), task: d("TaskDuration"), styleRecalcs: (after.RecalcStyleCount! - before.RecalcStyleCount!), layouts: (after.LayoutCount! - before.LayoutCount!) },
        trace: b,
        perFrameMainMs: Math.round((Object.values(b.mainThreadMs).reduce((s, v) => s + v, 0) / frameCount) * 100) / 100,
    };
}

const results: Record<string, any> = {};
for (const name of wanted) {
    const h = HANDLES[name];
    if (!h) throw new Error(`unknown handle ${name}`);
    if (h.width) await cdp("Emulation.setDeviceMetricsOverride", { width: h.width, height: H, deviceScaleFactor: 2, mobile: false });
    await h.open();
    await Bun.sleep(800);
    const runs = [];
    for (let i = 0; i < RUNS; i++) { runs.push(await drag(name)); await Bun.sleep(300); }
    runs.sort((a, b) => a.perFrameMainMs - b.perFrameMainMs);
    results[name] = runs[Math.floor(runs.length / 2)];
    const r = results[name];
    console.log(`${name.padEnd(9)} frames ${String(r.frames).padStart(3)} in ${r.wallMs}ms | frame mean ${r.frameMs.mean} p95 ${r.frameMs.p95} max ${r.frameMs.max} | main/frame ${r.perFrameMainMs}ms | ${Object.entries(r.trace.mainThreadMs).map(([k, v]) => `${k} ${v}`).join(", ")} | raster ${r.trace.rasterMs} | recalcs ${r.metrics.styleRecalcs} layouts ${r.metrics.layouts}`);
    await h.close();
    if (h.width) await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
    await Bun.sleep(500);
}
if (jsonOut) await Bun.write(jsonOut, JSON.stringify(results, null, 2));
console.log(errors.length ? `PAGE ERRORS:\n${errors.join("\n")}` : "no page errors");
ws.close();
process.exit(0);
