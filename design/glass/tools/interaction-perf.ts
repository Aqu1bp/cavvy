// Measures the GUI's everyday interactions in headless Chrome over CDP (a proxy for WebKit, which
// it under-reports blur for): leaving and opening Settings, switching sessions, opening and closing
// the side panel and the terminal, scrolling a long transcript, and typing in the composer.
//
//   bun design/glass/tools/interaction-perf.ts <url with #token=…> [interactions] [--json out.json]
//
// Seed the server first (scripts/perf-seed.ts): it opens the rail's session whose title starts with
// LONG (default "Long session") and switches to the one starting with SHORT (default "Short session").
// For each interaction, real input (CDP Input.*) and, around it, a Chrome trace:
//   inp      input to next paint, from the Event Timing API (Chrome rounds it to 8ms)
//   settled  input to the end of the last main-thread task over 10ms in the WAIT_MS after it
//   main     the renderer main thread's self time in that window, by kind (script, style, layout, paint)
// Each interaction runs RUNS times (default 5) and the median run is reported.
// Env: W, H (viewport, default 1512x982), RUNS, WAIT_MS (default 1500), CHROME, INJECT_CSS, TRACE_DIR.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const args = process.argv.slice(2);
const url = args[0];
if (!url) throw new Error("usage: interaction-perf.ts <url> [interactions] [--json out.json]");
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
const ALL = ["settings-open", "settings-back", "switch-short", "switch-long", "panel-open", "panel-close", "terminal-open", "terminal-close", "scroll", "typing"];
const wanted = args[1] && !args[1].startsWith("--") ? args[1].split(",") : ALL;
const RUNS = Number(process.env.RUNS ?? 5);
const WAIT_MS = Number(process.env.WAIT_MS ?? 1500);
const W = Number(process.env.W ?? 1512);
const H = Number(process.env.H ?? 982);
const LONG = process.env.LONG ?? "Long session";
const SHORT = process.env.SHORT ?? "Short session";

const port = 9333 + Math.floor(Math.random() * 500);
const profile = mkdtempSync("/tmp/cdp-");
const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "--no-first-run", `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });
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

await cdp("Runtime.enable");
await cdp("Page.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await cdp("Page.navigate", { url });
await Bun.sleep(3000);
if (process.env.INJECT_CSS) await js(`document.head.appendChild(Object.assign(document.createElement("style"), { textContent: ${JSON.stringify(process.env.INJECT_CSS)} })) && true`);
// Event Timing: every interaction's input-to-next-paint.
await js(`window.__ev = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) window.__ev.push({ name: e.name, start: e.startTime, dur: e.duration, id: e.interactionId }); }).observe({ type: "event", durationThreshold: 16 }); true`);

/** The centre of the first element matching `selector` (and, if given, whose text starts with `text`), or null. */
const centre = (selector: string, text?: string) => js(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text ? `(e.getAttribute("aria-label") ?? e.textContent).trim().startsWith(${JSON.stringify(text)})` : "true"});
    const r = el?.getBoundingClientRect();
    return r && r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
})()`);
async function click(selector: string, text?: string) {
    const p = await centre(selector, text);
    if (!p) throw new Error(`nothing to click: ${selector} ${text ?? ""}`);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...p });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...p, button: "left", buttons: 1, clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...p, button: "left", buttons: 0, clickCount: 1 });
}
const railCard = (title: string) => [".win-rail .card-hit", title] as const;
const exists = (selector: string) => js(`Boolean(document.querySelector(${JSON.stringify(selector)})?.offsetHeight)`);
async function key(k: string, code: string, vk: number, text?: string) {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
}

const CATEGORIES = ["-*", "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "toplevel", "v8.execute", "blink.user_timing", "cc", "gpu", "viz"].join(",");
const KIND: [RegExp, string][] = [
    [/^(FunctionCall|EventDispatch|TimerFire|FireAnimationFrame|FireIdleCallback|EvaluateScript|RunMicrotasks|v8\.|V8\.|MinorGC|MajorGC|BlinkGC|GCEvent|ResizeObserver|XHRReadyStateChange|ParseHTML)/, "script"],
    [/^(UpdateLayoutTree|RecalculateStyles|ParseAuthorStyleSheet|ScheduleStyleRecalculation)/, "style"],
    [/^(Layout|ComputeIntersections|IntersectionObserverController)/, "layout"],
    [/^(PrePaint|Paint|Layerize|UpdateLayer|UpdateLayerTree|PaintImage|CompositeLayers|Commit|Decode)/, "paint"],
];
const kindOf = (name: string) => KIND.find(([re]) => re.test(name))?.[1] ?? "other";

/** From the trace: main-thread self time by kind from the input on, when it settled, and raster time elsewhere. */
function breakdown(events: any[], inputType: string) {
    const threads = new Map<string, string>();
    for (const e of events) if (e.ph === "M" && e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, e.args.name);
    const mains = [...threads].filter(([, name]) => name === "CrRendererMain").map(([k]) => k);
    const count = new Map<string, number>();
    for (const e of events) { const k = `${e.pid}:${e.tid}`; if (mains.includes(k)) count.set(k, (count.get(k) ?? 0) + 1); }
    const main = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
    const onMain = (e: any) => `${e.pid}:${e.tid}` === main;
    const input = events.find((e) => onMain(e) && e.name === "EventDispatch" && e.args?.data?.type === inputType);
    const t0 = input?.ts ?? Math.min(...events.filter((e) => onMain(e) && e.ph === "X").map((e) => e.ts));
    const spans = events.filter((e) => e.ph === "X" && typeof e.dur === "number" && onMain(e) && e.ts >= t0 - 1000).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const out: Record<string, number> = { script: 0, style: 0, layout: 0, paint: 0, other: 0 };
    const stack: { end: number; kind: string; self: number }[] = [];
    const close = (until: number) => { while (stack.length && stack.at(-1)!.end <= until) { const s = stack.pop()!; out[s.kind] += s.self; } };
    for (const e of spans) {
        close(e.ts);
        if (stack.length) stack.at(-1)!.self -= e.dur;
        stack.push({ end: e.ts + e.dur, kind: kindOf(e.name), self: e.dur });
    }
    close(Infinity);
    // Top-level tasks: when the main thread last did a sizeable piece of work.
    const tasks = spans.filter((e) => e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask");
    const settled = Math.max(0, ...tasks.filter((e) => e.dur > 10_000).map((e) => e.ts + e.dur - t0));
    const longest = Math.max(0, ...tasks.map((e) => e.dur));
    let raster = 0;
    for (const e of events) if (e.ph === "X" && !onMain(e) && e.ts >= t0 && /^(RasterTask|GPUTask|Rasterize)/.test(e.name)) raster += e.dur;
    const ms = (v: number) => Math.round(v / 100) / 10;
    return { main: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, ms(v)])), settled: ms(settled), longestTask: ms(longest), raster: ms(raster) };
}

async function traced(inputType: string, act: () => Promise<void>, settleMs = WAIT_MS) {
    await js(`window.__ev = []; true`);
    traceEvents = [];
    await cdp("Tracing.start", { categories: CATEGORIES, transferMode: "ReportEvents" });
    await act();
    await Bun.sleep(settleMs);
    const done = new Promise<void>((r) => (traceDone = r));
    await cdp("Tracing.end");
    await done;
    const ev: { name: string; dur: number; id: number }[] = await js(`window.__ev`);
    const b = breakdown(traceEvents, inputType);
    return { ...b, inp: Math.max(0, ...ev.map((e) => e.dur)), events: ev };
}

const INTERACTIONS: Record<string, { before: () => Promise<unknown>; input: string; act: () => Promise<void>; after?: () => Promise<unknown> }> = {
    "settings-open": {
        before: async () => { if (await exists(".set-back")) await click(".set-back"); },
        input: "click",
        act: () => click('button[aria-label="Settings"]'),
    },
    "settings-back": {
        before: async () => { if (!(await exists(".set-back"))) await click('button[aria-label="Settings"]'); },
        input: "click",
        act: () => click(".set-back"),
    },
    "switch-short": { before: () => click(...railCard(LONG)), input: "click", act: () => click(...railCard(SHORT)) },
    "switch-long": { before: () => click(...railCard(SHORT)), input: "click", act: () => click(...railCard(LONG)) },
    "panel-open": {
        before: async () => { if (await exists(".insp .right-panel, .insp-resizer")) await click('button[aria-label="Toggle panel"]'); },
        input: "click",
        act: () => click('button[aria-label="Toggle panel"]'),
    },
    "panel-close": {
        before: async () => { if (!(await exists(".insp-resizer"))) await click('button[aria-label="Toggle panel"]'); },
        input: "click",
        act: () => click('button[aria-label="Toggle panel"]'),
        after: () => Promise.resolve(),
    },
    "terminal-open": {
        before: async () => { if (await exists(".terminal-panel")) await click('button[aria-label="Hide terminal"]'); },
        input: "click",
        act: () => click('button[aria-label="Toggle terminal"]'),
    },
    "terminal-close": {
        before: async () => { if (!(await exists(".terminal-panel"))) await click('button[aria-label="Toggle terminal"]'); },
        input: "click",
        act: () => click('button[aria-label="Hide terminal"]'),
    },
};

/** Wheels up through the transcript, 60 notches at 120Hz-ish; frame gaps from requestAnimationFrame. */
async function scroll() {
    const p = await centre(".transcript");
    await js(`(() => { const s = document.querySelector(".transcript"); s.scrollTop = s.scrollHeight; })()`);
    await Bun.sleep(400);
    await js(`window.__stop = false; window.__frames = []; (function tick(t) { window.__frames.push(t); if (!window.__stop) requestAnimationFrame(tick); })(performance.now()); true`);
    const r = await traced("wheel", async () => {
        for (let i = 0; i < 60; i++) {
            const sent = performance.now();
            await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...p, deltaX: 0, deltaY: -100 });
            const left = 16 - (performance.now() - sent);
            if (left > 0) await Bun.sleep(left);
        }
    }, 300);
    const frames: number[] = await js(`window.__stop = true; window.__frames`);
    const gaps = frames.slice(1).map((t, i) => t - frames[i]!).sort((a, b) => a - b);
    return { ...r, inp: 0, frames: gaps.length, frameP95: Math.round((gaps[Math.floor(gaps.length * 0.95)] ?? 0) * 10) / 10, frameMax: Math.round((gaps.at(-1) ?? 0) * 10) / 10, moved: await js(`document.querySelector(".transcript").scrollHeight - document.querySelector(".transcript").scrollTop`) };
}

/** Types 30 characters into the composer, 60ms apart; per keystroke input-to-paint from Event Timing. */
async function typing() {
    await click(".composer-box textarea");
    await Bun.sleep(200);
    const text = "please refactor the auth module";
    const r = await traced("keydown", async () => {
        for (const ch of text) {
            const code = ch === " " ? "Space" : `Key${ch.toUpperCase()}`;
            await key(ch, code, ch === " " ? 32 : ch.toUpperCase().charCodeAt(0), ch);
            await Bun.sleep(60);
        }
    }, 300);
    // Clear the draft for the next run.
    await key("a", "KeyA", 65);
    await js(`(() => { const t = document.querySelector(".composer-box textarea"); if (t) { t.select(); document.execCommand("delete"); } return true; })()`);
    const per = new Map<number, number>();
    for (const e of r.events) per.set(e.id, Math.max(per.get(e.id) ?? 0, e.dur));
    const durs = [...per.values()].sort((a, b) => a - b);
    const keys = text.length;
    return { ...r, inp: durs[Math.floor(durs.length / 2)] ?? 0, inpP95: durs[Math.floor(durs.length * 0.95)] ?? 0, slowKeys: durs.length, perKeyMain: Math.round((Object.values(r.main).reduce((s, v) => s + v, 0) / keys) * 100) / 100 };
}

// The long session, at its end.
await click(...railCard(LONG));
await Bun.sleep(3000);

const median = <T,>(runs: T[], by: (r: T) => number) => [...runs].sort((a, b) => by(a) - by(b))[Math.floor(runs.length / 2)]!;
const results: Record<string, any> = {};
for (const name of wanted) {
    const runs: any[] = [];
    for (let i = 0; i < RUNS; i++) {
        let r: any;
        if (name === "scroll") r = await scroll();
        else if (name === "typing") r = await typing();
        else {
            const it = INTERACTIONS[name];
            if (!it) throw new Error(`unknown interaction ${name}`);
            await it.before();
            await Bun.sleep(1200);
            r = await traced(it.input, it.act);
        }
        delete r.events;
        runs.push(r);
    }
    const m = median(runs, (r) => (name === "scroll" ? r.frameP95 : r.inp || r.settled));
    results[name] = { median: m, inps: runs.map((r) => r.inp), settled: runs.map((r) => r.settled) };
    const main = Object.entries(m.main).map(([k, v]) => `${k} ${v}`).join(", ");
    const extra = name === "scroll" ? ` | frames ${m.frames} p95 ${m.frameP95}ms max ${m.frameMax}ms` : name === "typing" ? ` | per key: inp p50 ${m.inp} p95 ${m.inpP95}, main ${m.perKeyMain}ms` : "";
    console.log(`${name.padEnd(15)} inp ${String(m.inp).padStart(4)}ms (runs ${runs.map((r) => r.inp).join("/")}) | settled ${m.settled}ms | longest task ${m.longestTask}ms | main: ${main} | raster ${m.raster}${extra}`);
}
// Back to the session for whoever looks next.
if (await exists(".set-back")) await click(".set-back");
if (jsonOut) await Bun.write(jsonOut, JSON.stringify(results, null, 2));
console.log(errors.length ? `PAGE ERRORS:\n${errors.join("\n")}` : "no page errors");
ws.close();
process.exit(0);
