// Measures the Browser pane as a person uses it: a real viewer Chrome at 2x drives the real pane (gui/test/browser-perf.tsx)
// with trusted wheel, key and mouse events, over the real stream, against a heavy page in the server's Chrome. The page
// paints its scroll position, typed length and pointer position into corner blocks; each drawn picture is read back, so
// a latency is input → the picture on the canvas that shows its effect.
//
//   bun scripts/browser-perf.ts [--json]          PERF_URL=https://… for a real site; PERF_PANE=1100x900 for the pane's CSS size
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "harness-browser-perf-")));
process.env.HARNESS_HOME = join(scratch, "home");
process.env.HARNESS_NO_KEYCHAIN = "1";
mkdirSync(process.env.HARNESS_HOME);
const { startServer } = await import("../src/server/server");
const { findChrome } = await import("../src/browser/chrome");
const found = findChrome(undefined);
if (!found.ok) throw new Error(found.error);
const chrome = found.path;
process.env.HARNESS_BROWSER = chrome;

const sections = Array.from({ length: 120 }, (_, i) => `<section><h2>Section ${i + 1}: the quick brown fox</h2>
<p>${"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(4)}</p>
<div class="fig" style="--h:${(i * 37) % 360}"></div>
<div class="cards">${Array.from({ length: 6 }, (_, j) => `<div class="card"><b>Card ${j + 1}</b><span>Some detail text for card ${j + 1}</span></div>`).join("")}</div>
<p>${"Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. ".repeat(3)}</p></section>`).join("");
const page = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:15px/1.55 -apple-system,system-ui,sans-serif;color:#1f2937;background:#f8fafc}
header{position:sticky;top:0;height:64px;background:rgba(255,255,255,.72);backdrop-filter:blur(14px) saturate(1.6);box-shadow:0 1px 0 #e5e7eb,0 8px 24px rgba(0,0,0,.06);z-index:5;display:flex;align-items:center;padding-left:110px}
header input{width:260px;height:34px;border-radius:8px;border:1px solid #cbd5e1;padding:0 10px;font-size:15px}
main{max-width:860px;margin:0 auto;padding:24px}
section{background:#fff;border-radius:14px;box-shadow:0 2px 6px rgba(0,0,0,.05),0 18px 40px rgba(15,23,42,.08);padding:20px 24px;margin:0 0 28px}
.fig{height:220px;border-radius:12px;background:radial-gradient(circle at 30% 30%,hsl(var(--h) 90% 70%),transparent 60%),repeating-conic-gradient(from 10deg,hsl(var(--h) 70% 55%) 0 8deg,hsl(calc(var(--h) + 40) 70% 45%) 8deg 16deg);box-shadow:inset 0 0 40px rgba(0,0,0,.25)}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
.card{border-radius:10px;padding:12px;background:linear-gradient(180deg,#fff,#f1f5f9);box-shadow:0 4px 14px rgba(0,0,0,.08);transition:transform .15s,box-shadow .15s;display:flex;flex-direction:column}
.card:hover{transform:translateY(-3px) scale(1.02);box-shadow:0 12px 28px rgba(0,0,0,.16)}
#code{position:fixed;left:0;top:0;z-index:10;display:grid;grid-template-columns:repeat(6,12px);grid-auto-rows:12px}
#code i{background:#fff}#code i.on{background:#000}
</style></head><body><div id="code">${"<i></i>".repeat(30)}</div>
<header><input id="q" placeholder="Type here"></header><main>${sections}</main>
<script>
const cells=[...document.querySelectorAll('#code i')];
const show=(row,n)=>{for(let b=0;b<6;b++)cells[row*6+b].classList.toggle('on',!!(n>>b&1))};
addEventListener('scroll',()=>{show(0,Math.floor(scrollY/40)%64);const f=Math.round(scrollY/4);show(3,f%64);show(4,Math.floor(f/64)%64)},{passive:true});
q.addEventListener('input',()=>show(1,q.value.length%64));
addEventListener('mousemove',e=>show(2,Math.floor(e.clientX/8)%64));
</script></body></html>`;
const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }) });

const out = join(scratch, "dist");
const vite = resolve(import.meta.dir, "../gui/node_modules/vite/dist/node/index.js");
const config = { root: resolve(import.meta.dir, "../gui"), configFile: resolve(import.meta.dir, "../gui/vite.config.ts"), envFile: false, logLevel: "error", build: { outDir: out, rollupOptions: { input: resolve(import.meta.dir, "../gui/test/browser-perf.html") } } };
const built = Bun.spawnSync([process.execPath, "--no-env-file", "-e", `import { build } from ${JSON.stringify(vite)}; await build(${JSON.stringify(config)});`], { stdout: "pipe", stderr: "pipe" });
if (built.exitCode !== 0) throw new Error(built.stderr.toString());
await Bun.write(join(out, "index.html"), "<!doctype html>");

const server = await startServer({ token: "browser-perf-fixture-token", staticDir: out });
const client = { subs: new Set<string>(), send: () => {} };
server.engine.clients.add(client);
const project = join(scratch, "project");
mkdirSync(project);
const id = (await server.engine.handle(client, "session.create", { cwd: project })).state.id;
// PERF_URL: a real site instead (only rates, gaps and sizes then: it has no code blocks to read latency from).
await server.engine.handle(client, "browser.command", { id, command: "goto", url: process.env.PERF_URL ?? `http://127.0.0.1:${site.port}` });

// Frames Chrome produced, on the server: against the frames the pane drew, where any cap comes from.
const produced: number[] = [];
const remote = await (server.engine as any).runtimes.get(id).browser.page();
const epoch = () => performance.timeOrigin + performance.now();
// Wall-clock stages on the server: Chrome's own frame time, and when the frame reached the server.
const serverFrames: [number, number][] = [];
const serverWheels: [number, number][] = [];
remote.cdp.on("Page.screencastFrame", (p: { metadata: { timestamp?: number } }, sessionId: string) => {
    if (sessionId !== remote.sessionId) return;
    produced.push(performance.now());
    serverFrames.push([(p.metadata.timestamp ?? 0) * 1000, epoch()]);
});
// How long Chrome takes to answer each wheel dispatch, and how many are in flight at once.
const wheelMs: number[] = [];
let inFlight = 0;
let maxInFlight = 0;
const input = remote.input.bind(remote);
remote.input = async (method: string, params: Record<string, unknown>) => {
    if (params.type !== "mouseWheel") return input(method, params);
    const t = performance.now();
    const at = epoch();
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    try { return await input(method, params); } finally { inFlight--; wheelMs.push(performance.now() - t); serverWheels.push([at, epoch()]); }
};
const profile = join(scratch, "viewer");
const viewer = Bun.spawn([process.env.PERF_VIEWER ?? chrome, "--headless=new", "--no-first-run", "--no-default-browser-check", `--force-device-scale-factor=${process.env.PERF_DPR ?? 2}`, "--window-size=1200,1000", `--user-data-dir=${profile}`, "--remote-debugging-port=0"], { stdout: "ignore", stderr: "ignore" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let port = "";
while (!port) { port = (await Bun.file(join(profile, "DevToolsActivePort")).text().catch(() => "")).split("\n")[0]!; if (!port) await sleep(50); }
const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()) as { webSocketDebuggerUrl: string };
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); pending.get(m.id)?.(m.result ?? m); pending.delete(m.id); };
const cdp = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((r) => { const i = ++seq; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression: string) => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;

const results: Record<string, unknown> = {};
try {
    await cdp("Page.enable");
    await cdp("Page.navigate", { url: `${server.url}/test/browser-perf.html?session=${encodeURIComponent(id)}&pane=${process.env.PERF_PANE ?? "720x900"}#token=browser-perf-fixture-token` });
    for (let i = 0; (await evaluate("document.getElementById('result')?.dataset.status")) !== "mounted"; i++) { if (i > 200) throw new Error(await evaluate("document.body.innerText")); await sleep(50); }
    for (let i = 0; !((await evaluate("__perf.draws.length")) > 0); i++) { if (i > 200) throw new Error("no frames drawn"); await sleep(50); }
    await sleep(1500);
    const box = await evaluate("(() => { const r = document.querySelector('.br-canvas').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()");
    const at = (x: number, y: number) => ({ x: box.x + x, y: box.y + y });
    const mark = async () => ({ ...(await evaluate("({ frames: __perf.frames.length, draws: __perf.draws.length, decodes: __perf.decodes.length, inputs: __perf.inputs.length })")), produced: produced.length, at: performance.now() });
    const slice = async (m: any) => ({ ...(await evaluate(`({ frames: __perf.frames.slice(${m.frames}), draws: __perf.draws.slice(${m.draws}), decodes: __perf.decodes.slice(${m.decodes}), inputs: __perf.inputs.slice(${m.inputs}) })`)), produced: produced.slice(m.produced), since: m.at });
    const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]!) : NaN; };

    // For inputs whose effect is a code that steps by one per input: input i (0-based) is visible when a drawn code
    // reaches base+i+1 (mod 64, unwrapped against the number of inputs so far).
    const latencies = (log: any, kind: string, row: number, base: number) => {
        const times: number[] = log.inputs.filter((x: [number, string]) => x[1] === kind).map((x: [number, string]) => x[0]);
        let reached = 0;
        const seen: number[] = [];
        for (const [t, codes] of log.draws as [number, number[]][]) {
            const sent = times.filter((x) => x <= t).length;
            let j = reached;
            for (let k = sent; k >= reached; k--) if ((base + k) % 64 === codes[row]) { j = k; break; }
            for (let k = reached; k < j; k++) seen[k] = t - times[k]!;
            reached = Math.max(reached, j);
        }
        const done = seen.filter((x) => x !== undefined);
        return { inputs: times.length, shown: done.length, p50: pct(done, 0.5), p95: pct(done, 0.95), max: pct(done, 1) };
    };
    const cadence = (log: any) => {
        const t = log.draws.map((d: [number]) => d[0]).filter((x: number) => !log.inputs.length || (x >= log.inputs[0][0] && x <= log.inputs.at(-1)[0] + 100));
        const span = log.inputs.length ? log.inputs.at(-1)[0] - log.inputs[0][0] : 0;
        const gaps = t.slice(1).map((x: number, i: number) => x - t[i]);
        const bytes = log.frames.map((f: [number, number]) => f[1]);
        return { chromeFps: span > 0 ? Math.round((log.produced.filter((x: number) => x - log.since <= span + 50).length * 1000) / span) : 0, drawsPerSec: span > 0 ? Math.round((t.filter((x: number) => x <= log.inputs.at(-1)[0]).length * 1000) / span) : 0, maxGap: pct(gaps, 1), p95Gap: pct(gaps, 0.95), frameKB: Math.round(pct(bytes, 0.5) / 1024), pngs: log.frames.filter((f: any) => f[2]).length, decodeP50: pct(log.decodes, 0.5), decodeMax: pct(log.decodes, 1) };
    };
    const code = async (row: number) => evaluate(`__perf.draws.at(-1)[1][${row}]`);

    // A. Continuous scroll, 40px per 16ms (a trackpad flick).
    await remote.evaluate("window.__raf = 0; (function f() { __raf++; requestAnimationFrame(f); })(); 0");
    const raf0 = await remote.evaluate("__raf");
    const t0 = performance.now();
    let m = await mark();
    let base = await code(0);
    const center = at(box.width / 2, box.height / 2);
    for (let i = 0; i < 90; i++) { await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...center, deltaX: 0, deltaY: 40 }); await sleep(16); }
    await sleep(1200);
    let log = await slice(m);
    results.scroll = { ...latencies(log, "wheel", 0, base), ...cadence(log), pageRafFps: Math.round(((Number(await remote.evaluate("__raf")) - Number(raf0)) * 1000) / (performance.now() - t0)) };

    // B. Bursty scroll: short flicks with pauses, as when reading.
    m = await mark();
    base = await code(0);
    for (let b = 0; b < 8; b++) { for (let i = 0; i < 6; i++) { await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...center, deltaX: 0, deltaY: 40 }); await sleep(16); } await sleep(320); }
    await sleep(1200);
    log = await slice(m);
    results.burstScroll = { ...latencies(log, "wheel", 0, base), ...cadence(log) };

    // C. Typing into the page's sticky search box.
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...at(240, 32), button: "left", buttons: 1, clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...at(240, 32), button: "left", buttons: 0, clickCount: 1 });
    await sleep(600);
    m = await mark();
    base = await code(1);
    for (let i = 0; i < 40; i++) {
        const ch = "abcdefghij"[i % 10]!;
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code: `Key${ch.toUpperCase()}`, text: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
        await sleep(i % 8 === 7 ? 400 : 70);
    }
    await sleep(1200);
    log = await slice(m);
    results.typing = { ...latencies(log, "keydown", 1, base), ...cadence(log) };

    // D. Pointer sweep over hover cards, 8px per 16ms.
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...at(0, 300) });
    await sleep(500);
    m = await mark();
    base = await code(2);
    for (let i = 1; i <= 80; i++) { await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...at(i * 8, 300) }); await sleep(16); }
    await sleep(1200);
    log = await slice(m);
    results.hover = { ...latencies(log, "mousemove", 2, base), ...cadence(log) };
    // E. Trackpad flicks: 125 Hz deltas ramping up, then momentum decaying, three times with pauses.
    // Per drawn picture: where the page is (4 px steps) against where the hand had taken it, and when.
    const fine = (c: number[]) => ((c[3] ?? 0) + (c[4] ?? 0) * 64) * 4;
    const sw0 = serverWheels.length, sf0 = serverFrames.length;
    m = await mark();
    const startY = fine(await evaluate("__perf.draws.at(-1)[1]"));
    for (let g = 0; g < 3; g++) {
        const t0 = performance.now();
        const deltas: number[] = [];
        for (let t = 0; t < 300; t += 8) deltas.push(Math.min(22, 2 + t / 5));
        for (let t = 0; t < 1200; t += 8) deltas.push(Math.max(1, Math.round(22 * Math.exp(-t / 350))));
        // Not awaited: a trackpad doesn't wait for the page, and the viewer's own answer to each would slow the trace.
        for (let i = 0; i < deltas.length; i++) {
            void cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...center, deltaX: 0, deltaY: deltas[i] });
            const wait = t0 + (i + 1) * 8 - performance.now();
            if (wait > 0) await sleep(wait);
        }
        await sleep(400);
    }
    await sleep(800);
    log = await slice(m);
    {
        const wheels = (log.inputs as [number, string, number][]).filter((x) => x[1] === "wheel");
        const expected = (t: number) => wheels.filter((w) => w[0] <= t).reduce((a, w) => a + w[2], 0);
        const when = (y: number) => wheels.reduce((acc: { sum: number; t?: number }, w) => (acc.t === undefined && (acc.sum += w[2]) >= y ? { ...acc, t: w[0] } : acc), { sum: 0 }).t;
        const draws = (log.draws as [number, number[], number][]).filter((d) => d[0] >= wheels[0]![0] && d[0] <= wheels.at(-1)![0] + 300);
        const pos = draws.map((d) => fine(d[1]) - startY);
        const gaps = draws.slice(1).map((d, i) => d[0] - draws[i]![0]);
        const lagPx = draws.map((d, i) => expected(d[0]) - pos[i]!);
        const age = draws.map((d, i) => { const t = when(pos[i]!); return t === undefined ? NaN : d[0] - t; }).filter((x) => Number.isFinite(x) && x >= 0);
        let back = 0, still = 0, switches = 0, maxJump = 0;
        for (let i = 1; i < draws.length; i++) {
            if (pos[i]! < pos[i - 1]! - 4) back++;
            if (pos[i] === pos[i - 1] && expected(draws[i]![0]) > pos[i]! + 8) still++;
            if (draws[i]![2] !== draws[i - 1]![2]) switches++;
            maxJump = Math.max(maxJump, pos[i]! - pos[i - 1]!);
        }
        const span = wheels.at(-1)![0] - wheels[0]![0];
        // Stages, on one wall clock (ms): averages over the gestures.
        const extra = await evaluate("({ sends: __perf.sends, origin: __perf.origin })");
        const o = extra.origin as number;
        const sends = (extra.sends as number[]).map((t) => t + o).filter((t) => t >= wheels[0]![0] + o - 50);
        const sw = serverWheels.slice(sw0);
        const sf = serverFrames.slice(sf0);
        const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : NaN);
        const toServer = sends.map((t) => { const s = sw.find((w) => w[0] >= t); return s ? s[0] - t : NaN; }).filter((x) => x >= 0 && x < 500);
        const dispatch = sw.map((w) => w[1] - w[0]);
        // A wheel's first frame: Chrome's timestamp of the first frame after the wheel reached Chrome.
        const render = sw.map((w) => { const f = sf.find((x) => x[0] >= w[0]); return f ? f[0] - w[0] : NaN; }).filter((x) => x >= 0 && x < 500);
        const capture = sf.map((f) => f[1] - f[0]).filter((x) => x >= 0 && x < 1000);
        const received = (log.frames as [number][]).map((f) => f[0] + o);
        const toPane = received.map((t) => { const prior = sf.filter((x) => x[1] <= t).at(-1); return prior ? t - prior[1] : NaN; }).filter((x) => x >= 0 && x < 500);
        const wheelToSend = (log.inputs as [number, string][]).filter((x) => x[1] === "wheel").map((x) => { const s = sends.find((t) => t >= x[0] + o); return s ? s - (x[0] + o) : NaN; }).filter((x) => x >= 0 && x < 100);
        results.stages = { paneWheelToSend: avg(wheelToSend), sendToServer: avg(toServer), wheelDispatch: avg(dispatch), wheelToChromeFrame: avg(render), chromeFrameToServer: avg(capture), serverToPane: avg(toPane), decode: avg(log.decodes) };
        results.trackpad = {
            wheelEvents: wheels.length, handPx: expected(Infinity), pagePx: pos.at(-1), draws: draws.length, drawsPerSec: Math.round((draws.length * 1000) / span),
            gapP50: pct(gaps, 0.5), gapP95: pct(gaps, 0.95), gapMax: pct(gaps, 1),
            pictureAgeP50: pct(age, 0.5), pictureAgeP95: pct(age, 0.95), lagPxP50: pct(lagPx, 0.5), lagPxP95: pct(lagPx, 0.95),
            backwards: back, repeatedWhileBehind: still, resolutionSwitches: switches, maxJumpPx: maxJump,
            widths: Object.fromEntries([...new Set(draws.map((d) => String(d[2])))].map((w) => [w, draws.filter((d) => String(d[2]) === w).length])),
            gestureMs: span,
        };
    }
    results.wheelDispatch = { count: wheelMs.length, p50: pct(wheelMs, 0.5), p95: pct(wheelMs, 0.95), maxInFlight };
    results.viewport = { css: box, dpr: await evaluate("devicePixelRatio") };
    results.renderer = await remote.evaluate("(() => { const g = document.createElement('canvas').getContext('webgl'); const i = g && g.getExtension('WEBGL_debug_renderer_info'); return i ? g.getParameter(i.UNMASKED_RENDERER_WEBGL) : String(g); })()");
    results.args = process.env.PERF_LABEL ?? "";
    console.log(process.argv.includes("--json") ? JSON.stringify(results) : results);
} finally {
    ws.close();
    viewer.kill();
    await viewer.exited;
    await server.stop();
    site.stop(true);
    rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
