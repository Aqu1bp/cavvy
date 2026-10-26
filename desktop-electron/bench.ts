// The Electron app's numbers, the same way every time: startup, memory and CPU by process role, and UI frame times,
// through a run against the demo (mock model, demo site) with a fresh profile. Writes bench-<label>.json.
//
//   bun desktop-electron/bench.ts --label before                       the development build (electron .)
//   bun desktop-electron/bench.ts --label after --app <path>/Harness   a packaged app's executable
//
// Memory: the working set Electron reports for each of its processes (app.getAppMetrics, via metrics.ts) and the
// server's RSS, the median of 10 one-second samples; CPU: their mean. macOS's own footprint figure (top's MEM) is
// taken once per phase as a check. Phases: idle on the home screen; after the agent browsed the demo site; the Browser
// pane open and idle; frame times while the side panel is dragged; three agent sessions working at once while the
// person types (frame times, key-to-paint); and four busy pages open in tabs nobody shows.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const label = arg("--label") ?? "run";
const repo = resolve(import.meta.dir, "..");
const out = arg("--out") ?? join(repo, "desktop-electron");
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "harness-bench-"));
const metricsFile = join(dir, "metrics.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report: Record<string, unknown> = { label, at: new Date().toISOString() };

// Busy pages, as real sites are: an animation, a carousel's timer, a canvas.
const busy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(`<!doctype html><title>Busy</title><style>@keyframes s{to{transform:rotate(360deg)}}.s{width:80px;height:80px;background:#36c;animation:s 1s linear infinite}</style>
<div class="s"></div><canvas id="c" width="600" height="300"></canvas><ul id="l"></ul>
<script>const l=document.getElementById('l');for(let i=0;i<200;i++)l.appendChild(document.createElement('li'));
setInterval(()=>{for(const li of l.children)li.textContent=Math.random().toString(36)},100);
const c=document.getElementById('c').getContext('2d');(function f(t){c.clearRect(0,0,600,300);for(let i=0;i<50;i++){c.fillStyle='hsl('+(t/10+i*7)%360+',70%,50%)';c.fillRect((t/5+i*13)%600,(i*37)%300,20,20)}requestAnimationFrame(f)})(0)</script>`, { headers: { "content-type": "text/html" } }),
});

const demo = Bun.spawn(["bun", "--no-env-file", "scripts/gui-demo.ts", "--port", "4632", "--token", "electron-bench-token-1234567", "--dir", dir], { cwd: repo, stdout: Bun.file(join(dir, "demo.log")), stderr: Bun.file(join(dir, "demo.err.log")) });
let app: ReturnType<typeof Bun.spawn> | undefined;

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
type Proc = { pid: number; role: string; kb: number; cpu: number };
type Metrics = { at: number; marks: Record<string, number>; server: { pid?: number; port?: number; token?: string }; procs: Proc[]; extra?: unknown };
const metrics = async (): Promise<Metrics | undefined> => Bun.file(metricsFile).json().catch(() => undefined);
const group = (role: string) => (role.startsWith("utility") ? (role.includes("network") ? "network" : "utility") : role);

/** 10 one-second samples: memory (MB, median) and CPU (%, mean) by role, the server included, and a footprint check. */
async function sample(phase: string) {
    const mem: Record<string, number[]> = {};
    const cpu: Record<string, number[]> = {};
    let last = 0;
    let pids: number[] = [];
    for (let i = 0; i < 10; i++) {
        await sleep(1000);
        const m = await metrics();
        if (!m || m.at === last) continue;
        last = m.at;
        const byRole: Record<string, { kb: number; cpu: number }> = {};
        for (const p of m.procs) {
            const g = group(p.role);
            byRole[g] ??= { kb: 0, cpu: 0 };
            byRole[g].kb += p.kb;
            byRole[g].cpu += p.cpu;
        }
        if (m.server.pid) {
            const ps = Bun.spawnSync(["ps", "-o", "rss=,%cpu=", "-p", String(m.server.pid)]).stdout.toString().trim().split(/\s+/);
            byRole.server = { kb: Number(ps[0]) || 0, cpu: Number(ps[1]) || 0 };
        }
        for (const [g, v] of Object.entries(byRole)) {
            (mem[g] ??= []).push(v.kb / 1024);
            (cpu[g] ??= []).push(v.cpu);
        }
        pids = [...m.procs.map((p) => p.pid), ...(m.server.pid ? [m.server.pid] : [])];
    }
    const memory = Object.fromEntries(Object.entries(mem).map(([g, xs]) => [g, Math.round(median(xs))]));
    const cpuUse = Object.fromEntries(Object.entries(cpu).map(([g, xs]) => [g, Math.round(mean(xs) * 10) / 10]));
    // macOS's footprint (Activity Monitor's Memory), once, as a check on the working sets.
    const top = Bun.spawnSync(["top", "-l", "1", "-stats", "pid,mem", ...pids.flatMap((p) => ["-pid", String(p)])]).stdout.toString();
    const footprint = top.split("\n").map((l) => l.trim().match(/^(\d+)\s+([\d.]+)([KMG])/)).filter(Boolean).reduce((a, m) => a + Number(m![2]) * (m![3] === "G" ? 1024 : m![3] === "K" ? 1 / 1024 : 1), 0);
    const extra = (await metrics())?.extra;
    report[phase] = { ...(extra ? { app: extra } : {}), memoryMB: { ...memory, total: Object.values(memory).reduce((a, b) => a + b, 0) }, cpuPercent: { ...cpuUse, total: Math.round(Object.values(cpuUse).reduce((a, b) => a + b, 0) * 10) / 10 }, footprintMB: Math.round(footprint) };
}

try {
    for (let i = 0; ; i++) { if (await fetch("http://127.0.0.1:4632/healthz").then((r) => r.ok, () => false)) break; if (i > 120) throw new Error("demo didn't start"); await sleep(500); }
    const exe = arg("--app");
    const spawnedAt = performance.now();
    app = Bun.spawn(exe ? [exe] : [join(repo, "desktop-electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), join(repo, "desktop-electron")], {
        cwd: repo,
        env: { ...process.env, HARNESS_HOME: join(dir, "home"), HARNESS_NO_KEYCHAIN: "1", HARNESS_ELECTRON_TEST_PORT: "9340", HARNESS_ELECTRON_USER_DATA: join(dir, "electron-data"), HARNESS_ELECTRON_CWD: join(dir, "acme-platform"), HARNESS_ELECTRON_METRICS: metricsFile },
        stdout: Bun.file(join(dir, "app.out.log")), stderr: Bun.file(join(dir, "app.log")),
    });

    // The UI over DevTools (the test port).
    let gui: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; !gui; i++) {
        gui = ((await fetch("http://127.0.0.1:9340/json/list").then((r) => r.json(), () => [])) as { url: string; webSocketDebuggerUrl: string }[]).find((t) => t.url.startsWith("harness://app"));
        if (!gui) { if (i > 2400) throw new Error("no window"); await sleep(25); }
    }
    const ws = new WebSocket(gui.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0;
    const pending = new Map<number, (v: any) => void>();
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); pending.get(m.id)?.(m); pending.delete(m.id); };
    const cdp = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.delete(id)) r({}); }, 10_000); });
    const js = async (expression: string) => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

    // 1. Startup: the window up, and the composer there to type in.
    for (let i = 0; !(await js(`!!document.querySelector('textarea[aria-label="Message"]')`)); i++) { if (i > 1500) throw new Error("no composer"); await sleep(20); }
    const interactive = Math.round(performance.now() - spawnedAt);
    await sleep(1500);
    report.startup = { ...(await metrics())?.marks, interactiveFromSpawn: interactive };

    // 2. Idle on the home screen.
    await sleep(4000);
    await sample("idleHome");

    // 3. The agent browses the demo site (the floating view shows it).
    const turnAt = performance.now();
    for (let attempt = 0; attempt < 10 && !(await js(`(document.querySelector('.transcript')?.innerText ?? '').includes('check the app in the browser')`)); attempt++) {
        await js(`(() => { const box = document.querySelector('textarea[aria-label="Message"]'); box.value = 'check the app in the browser'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await sleep(300);
        await js(`document.querySelector('button[aria-label="Send"]')?.click()`);
        await sleep(1000);
    }
    for (let i = 0; i < 200 && !(await js(`!!document.querySelector('button[title="Allow once"]')`)); i++) await sleep(50);
    await js(`document.querySelector('button[title="Allow once"]')?.click()`);
    for (let i = 0; i < 400 && !(await js(`/Subscribed \\(1\\)/.test(document.querySelector('.transcript')?.innerText ?? '')`)); i++) await sleep(50);
    report.agentTurnMs = Math.round(performance.now() - turnAt);
    await sleep(6000);
    await sample("afterAgentBrowsed");

    // 4. The Browser pane open, nobody doing anything.
    await js(`(() => { if (!document.querySelector('.br-view')?.getClientRects().length) document.querySelector('button[aria-label="Toggle panel"]')?.click(); })()`);
    await sleep(400);
    await js(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Browser') || b.textContent?.trim() === 'Browser')?.click()`);
    await sleep(3000);
    await sample("paneOpenIdle");

    // 5. Smoothness: frame times in the UI while the side panel's edge is dragged across (the page resizes with it).
    await js(`(() => { window.__frames = []; window.__long = []; let last = performance.now(); (function f(t) { window.__frames.push(t - last); last = t; if (window.__frames.length < 400) requestAnimationFrame(f); })(last);
        try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch {} })()`);
    const handle = await js(`(() => { const b = document.querySelector('.insp-resizer')?.getBoundingClientRect(); return b && { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (handle) {
        await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", buttons: 1, clickCount: 1 });
        for (let i = 1; i <= 60; i++) { await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x - (i % 30 < 15 ? i % 15 : 15 - (i % 15)) * 16, y: handle.y, button: "left", buttons: 1 }); await sleep(16); }
        await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle.x, y: handle.y, button: "left", buttons: 0, clickCount: 1 });
    }
    await sleep(500);
    const frames: number[] = (await js(`window.__frames.slice(2, 120)`)) ?? [];
    const long: number[] = (await js(`window.__long`)) ?? [];
    const sorted = [...frames].sort((a, b) => a - b);
    report.resizeSmoothness = { frames: frames.length, p50ms: Math.round(sorted[Math.floor(sorted.length * 0.5)] ?? 0), p95ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0), maxms: Math.round(sorted.at(-1) ?? 0), over20ms: frames.filter((f) => f > 20).length, longTasks: long.length, longTaskMs: Math.round(long.reduce((a, b) => a + b, 0)) };

    const m = (await metrics())!;
    const rpc = new WebSocket(`ws://127.0.0.1:${m.server.port}/ws`, ["harness.v1", `auth.${m.server.token}`]);
    await new Promise((r, j) => { rpc.onopen = r; rpc.onerror = j; });
    let rseq = 0;
    const rpending = new Map<number, (v: any) => void>();
    rpc.onmessage = (e) => { const x = JSON.parse(String(e.data)); if (x.id) { rpending.get(x.id)?.(x); rpending.delete(x.id); } };
    const call = (method: string, params: unknown) => new Promise<any>((r) => { const id = ++rseq; rpending.set(id, r); rpc.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (rpending.delete(id)) r({}); }, 20_000); });
    const sessions = (await call("sessions.list", {})).result as { id: string }[];
    const sid = sessions[0]!.id;

    // 6. Real use: three agent sessions at once, each starting another turn as soon as one ends, for 25s. The one on
    // screen streams long replies; one in the background edits files and runs tests; another browses. Meanwhile the
    // person types in the composer: how long each key takes to show, and the UI's frame times.
    const project = join(dir, "acme-platform");
    const work = [
        { id: sid, prompt: "fastdemo 60" },
        { id: (await call("session.create", { cwd: project, mode: "bypassPermissions" })).result?.state?.id as string, prompt: "demo" },
        { id: (await call("session.create", { cwd: project, mode: "bypassPermissions" })).result?.state?.id as string, prompt: "check the app in the browser" },
    ];
    await call("session.setMode", { id: sid, mode: "bypassPermissions" });
    let turns = 0;
    const until = performance.now() + 25_000;
    const loop = (async () => {
        const running = new Set<string>();
        while (performance.now() < until) {
            const list = ((await call("sessions.list", {})).result ?? []) as { id: string; status?: string }[];
            for (const w of work) {
                const st = list.find((x) => x.id === w.id)?.status;
                if (st === "running") { running.add(w.id); continue; }
                if (running.has(w.id) || turns < work.length) { running.delete(w.id); turns++; void call("session.send", { id: w.id, text: w.prompt }); }
            }
            await sleep(500);
        }
    })();
    await js(`(() => { window.__frames = []; window.__long = []; window.__keys = []; let last = performance.now(); (function f(t) { if (window.__stop) return; window.__frames.push(t - last); last = t; requestAnimationFrame(f); })(last);
        try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch {}
        // What ran during each slow frame (Chromium's long-animation-frame entries, with the scripts in them).
        window.__loaf = [];
        try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__loaf.push({ ms: Math.round(e.duration), blocking: Math.round(e.blockingDuration), render: Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0), style: Math.round(e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0), scripts: (e.scripts || []).map((x) => ({ ms: Math.round(x.duration), invoker: x.invoker, fn: x.sourceFunctionName, src: (x.sourceURL || '').split('/').pop() + ':' + x.sourceCharPosition })).sort((a, b) => b.ms - a.ms).slice(0, 4) }); }).observe({ type: 'long-animation-frame', buffered: false }); } catch {}
        document.addEventListener('input', (e) => { const at = e.timeStamp; requestAnimationFrame(() => window.__keys.push(performance.now() - at)); }, true);
        // When each slow frame ended, and when tabs' webviews came and went: is a slow frame a new tab being embedded?
        window.__slow = []; window.__views = [];
        { let prev = performance.now(); (function g(t) { if (window.__stop) return; if (t - prev > 50) window.__slow.push({ at: Math.round(t), ms: Math.round(t - prev) }); prev = t; requestAnimationFrame(g); })(prev); }
        new MutationObserver((ms) => { for (const m of ms) for (const n of [...m.addedNodes]) if (n.nodeName === 'WEBVIEW' || n.querySelector?.('webview')) window.__views.push(Math.round(performance.now())); }).observe(document.body, { childList: true, subtree: true }); })()`);
    await sleep(3000);
    const sampled = sample("multiSession");
    for (let i = 0; i < 30; i++) {
        await js(`document.querySelector('textarea[aria-label="Message"]')?.focus()`);
        await cdp("Input.insertText", { text: "x" });
        await sleep(250);
    }
    await sampled;
    await loop;
    const mf: number[] = (await js(`(window.__stop = true, window.__frames.slice(5))`)) ?? [];
    const ml: number[] = (await js(`window.__long`)) ?? [];
    const keys: number[] = (await js(`window.__keys`)) ?? [];
    const ms = [...mf].sort((a, b) => a - b);
    const ks = [...keys].sort((a, b) => a - b);
    report.slowFrames = (((await js(`window.__loaf`)) ?? []) as { ms: number }[]).sort((a, b) => b.ms - a.ms).slice(0, 6);
    const views: number[] = (await js(`window.__views`)) ?? [];
    report.slowFrameCauses = (((await js(`window.__slow`)) ?? []) as { at: number; ms: number }[]).map((f) => {
        const near = views.map((v) => f.at - v).filter((d) => d >= -50 && d <= f.ms + 500).sort((a, b) => a - b)[0];
        return { ...f, webviewAddedMsBefore: near ?? null };
    });
    report.webviewsAdded = views.length;
    report.multiSessionSmoothness = { turnsStarted: turns, frames: mf.length, p50ms: Math.round(ms[Math.floor(ms.length * 0.5)] ?? 0), p95ms: Math.round(ms[Math.floor(ms.length * 0.95)] ?? 0), maxms: Math.round(ms.at(-1) ?? 0), over20ms: mf.filter((f) => f > 20).length, longTasks: ml.length, longTaskMs: Math.round(ml.reduce((a, b) => a + b, 0)), keyToPaintP50ms: Math.round(ks[Math.floor(ks.length * 0.5)] ?? 0), keyToPaintP95ms: Math.round(ks[Math.floor(ks.length * 0.95)] ?? 0), keys: ks.length };
    await js(`(() => { const t = document.querySelector('textarea[aria-label="Message"]'); if (t) { t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
    for (let i = 0; i < 60; i++) {
        const list = ((await call("sessions.list", {})).result ?? []) as { id: string; status?: string }[];
        if (!work.some((w) => list.find((x) => x.id === w.id)?.status === "running")) break;
        await sleep(500);
    }

    // 7. Four busy pages in tabs nobody shows (the panel closed), a while later.
    await js(`document.querySelector('button[aria-label="Toggle panel"]')?.click()`);
    for (let i = 0; i < 4; i++) await call("browser.command", { id: sid, command: "new_tab", url: `http://127.0.0.1:${busy.port}/?tab=${i}` });
    report.tabs = (await call("browser.state", { id: sid })).result?.tabs?.length;
    await sleep(45_000);
    await sample("busyTabsBackground");
    // What the UI did with the tabs' webviews: hidden (asleep) or not, and whether one counts as shown.
    // Each tab's own view, through DevTools (which doesn't wake it): does its page think it's visible?
    report.tabVisibility = await Promise.all(((await fetch("http://127.0.0.1:9340/json/list").then((r) => r.json(), () => [])) as { type: string; url: string; webSocketDebuggerUrl: string }[]).filter((t) => t.type === "webview").map(async (t) => {
        const w = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r) => { w.onopen = r; w.onerror = r; });
        const v = await new Promise<unknown>((r) => { w.onmessage = (e) => r(JSON.parse(String(e.data)).result?.result?.value); w.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "document.visibilityState", returnByValue: true } })); setTimeout(() => r("no answer"), 3000); });
        w.close();
        return `${t.url.slice(-8)}: ${v}`;
    }));
    report.webviews = await js(`[...document.querySelectorAll('webview')].map((v) => ({ key: v.dataset.key, visibility: v.style.visibility || 'visible', computed: getComputedStyle(v).visibility, wrapper: v.parentElement?.className, src: (v.getAttribute('src') || '').slice(0, 40) }))`);
    rpc.close();
    ws.close();
} catch (e) {
    report.error = String((e as Error)?.stack ?? e);
    report.appLog = (await Bun.file(join(dir, "app.log")).text().catch(() => "")).split("\n").slice(-25).join("\n");
    report.demoLog = (await Bun.file(join(dir, "demo.err.log")).text().catch(() => "")).split("\n").slice(-10).join("\n");
} finally {
    app?.kill("SIGTERM");
    await sleep(3000);
    app?.kill("SIGKILL");
    demo.kill();
    busy.stop(true);
    mkdirSync(out, { recursive: true });
    await Bun.write(join(out, `bench-${label}.json`), JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report, null, 1));
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
}
