// What the app costs while a session streams: CPU by process (UI page, GPU, main, server, and macOS's WindowServer
// for what drawing costs the system) over a stretch, with the UI page's and the main process's JS profiles and the
// bytes the page received. On the demo's mock model ("perfstream" in scripts/mock-llm.ts). Writes
// bench-results/bench-stream-<label>.json.
//
//   bun desktop-electron/bench-stream.ts --label before [--history 200] [--seconds 15] [--only idle,textLong]
//
// Phases: idle with a long session on screen; a long reply streaming in a short session, then in the long one; a
// command's output streaming in the long one; the long one streaming while a short one is on screen; and a 40 KB reply
// streaming fast, sampled each second (does the cost grow with the reply?).

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const label = arg("--label") ?? "run";
const HISTORY = Number(arg("--history") ?? 200);
const SECONDS = Number(arg("--seconds") ?? 15);
const only = arg("--only")?.split(",");
const repo = resolve(import.meta.dir, "..");
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cavvy-stream-"));
const metricsFile = join(dir, "metrics.json");
const project = join(dir, "acme-platform");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report: Record<string, any> = { label, at: new Date().toISOString(), history: HISTORY, seconds: SECONDS, phases: {} };
const TOKEN = "stream-bench-token-123456789";
const DEMO_PORT = 4637;

const demo = Bun.spawn(["bun", "--no-env-file", "scripts/gui-demo.ts", "--port", String(DEMO_PORT), "--token", TOKEN, "--dir", dir], { cwd: repo, stdout: "ignore", stderr: Bun.file(join(dir, "demo.err.log")) });
let app: ReturnType<typeof Bun.spawn> | undefined;

/** A CDP connection. */
async function connect(url: string) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0;
    const pending = new Map<number, (v: any) => void>();
    const listeners = new Map<string, (params: any) => void>();
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.method) listeners.get(m.method)?.(m.params); else { pending.get(m.id)?.(m); pending.delete(m.id); } };
    const cdp = (method: string, params: Record<string, unknown> = {}, ms = 60_000) => new Promise<any>((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.delete(id)) r({}); }, ms); });
    return { ws, cdp, listeners };
}

/** A JSON-RPC client on a cavvy server's /ws. */
async function rpcTo(port: number, token: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["cavvy.v1", `auth.${token}`]);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0;
    const pending = new Map<number, (v: any) => void>();
    ws.onmessage = (e) => { const x = JSON.parse(String(e.data)); if (x.id) { pending.get(x.id)?.(x); pending.delete(x.id); } };
    const call = (method: string, params: unknown, ms = 30_000) => new Promise<any>((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.delete(id)) r({ error: "timeout" }); }, ms); });
    return { ws, call };
}

/** Cumulative CPU seconds of each pid (ps's TIME: user + system). */
function cpuTimes(pids: number[]): Map<number, number> {
    const out = new Map<number, number>();
    const r = Bun.spawnSync(["ps", "-o", "pid=,time=", "-p", pids.join(",")]);
    for (const line of r.stdout.toString().trim().split("\n")) {
        const [pid, t] = line.trim().split(/\s+/);
        if (!pid || !t) continue;
        const parts = t.split(":").map(Number);
        const s = parts.reduce((a, x) => a * 60 + x, 0);
        out.set(Number(pid), s);
    }
    return out;
}

/** Resident memory (MB) by role. */
function rss(roles: [number, string][]): Record<string, number> {
    const r = Bun.spawnSync(["ps", "-o", "pid=,rss=", "-p", roles.map(([p]) => p).join(",")]);
    const kb = new Map(r.stdout.toString().trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number) as [number, number]));
    const out: Record<string, number> = {};
    for (const [pid, role] of roles) if (role !== "WindowServer") out[role] = (out[role] ?? 0) + Math.round((kb.get(pid) ?? 0) / 1024);
    return out;
}

/** macOS's footprint (MB, Activity Monitor's Memory) by role: dirty and compressed memory, not shared or purgeable pages. */
function footprint(roles: [number, string][]): Record<string, number> {
    const want = roles.filter(([, role]) => role !== "WindowServer" && !role.startsWith("utility:tracing"));
    const r = Bun.spawnSync(["footprint", "-f", "bytes", ...want.flatMap(([p]) => ["-p", String(p)])]);
    const bytes = new Map<number, number>();
    for (const m of r.stdout.toString().matchAll(/\[(\d+)\]:.*?Footprint: (\d+) B/g)) bytes.set(Number(m[1]), Number(m[2]));
    const out: Record<string, number> = {};
    for (const [pid, role] of want) out[role] = (out[role] ?? 0) + Math.round((bytes.get(pid) ?? 0) / 1048576);
    return out;
}

/** A trace's main-thread work in the UI page, by event (total ms of top-level-ish events), and frames drawn. */
function summarizeTrace(events: any[], uiPid: number, seconds: number) {
    const threads = new Map<string, string>();
    for (const e of events) if (e.ph === "M" && e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, e.args?.name);
    const main = (e: any) => e.pid === uiPid && threads.get(`${e.pid}:${e.tid}`) === "CrRendererMain";
    const names = ["UpdateLayoutTree", "Layout", "PrePaint", "Paint", "Layerize", "Commit", "HitTest", "FunctionCall", "TimerFire", "FireAnimationFrame", "EventDispatch", "RunMicrotasks", "ScrollLayer", "IntersectionObserverController::computeIntersections", "ResizeObserver::BroadcastObservations", "UpdateLayer", "RasterTask", "Decode Image", "MajorGC", "MinorGC", "V8.GC_SCAVENGER", "ProxyMain::BeginMainFrame", "ThreadControllerImpl::RunTask"];
    const by: Record<string, number> = {};
    for (const e of events) if (e.ph === "X" && main(e) && names.includes(e.name)) by[e.name] = (by[e.name] ?? 0) + (e.dur ?? 0) / 1000;
    const counts: Record<string, number> = {};
    for (const e of events) if (/Draw|Swap|Frame/.test(e.name) && (e.ph === "X" || e.ph === "B")) counts[`${e.name}@${threads.get(`${e.pid}:${e.tid}`)}`] = (counts[`${e.name}@${threads.get(`${e.pid}:${e.tid}`)}`] ?? 0) + 1;
    // Style and layout a script asked for (it read a size or a position with something changed): by the call that read it.
    const forced: Record<string, { n: number; ms: number }> = {};
    let layouts = 0, forcedN = 0, forcedMs = 0;
    for (const e of events) {
        if (e.ph !== "X" || !main(e) || (e.name !== "Layout" && e.name !== "UpdateLayoutTree")) continue;
        if (e.name === "Layout") layouts++;
        const stack = e.args?.beginData?.stackTrace as { functionName: string; url: string; lineNumber: number; columnNumber: number }[] | undefined;
        if (!stack?.length) continue;
        const f = stack[0]!;
        const k = `${e.name} ${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
        const ms = (e.dur ?? 0) / 1000;
        forced[k] = { n: (forced[k]?.n ?? 0) + 1, ms: (forced[k]?.ms ?? 0) + ms };
        forcedN++;
        forcedMs += ms;
    }
    return {
        layoutsPerSecond: Math.round(layouts / seconds),
        forcedPerSecond: Math.round(forcedN / seconds),
        forcedMsPerSecond: Math.round((forcedMs / seconds) * 10) / 10,
        forcedBy: Object.fromEntries(Object.entries(forced).sort((a, b) => b[1].n - a[1].n).slice(0, 12).map(([k, v]) => [k, `${Math.round(v.n / seconds)}/s ${Math.round((v.ms / seconds) * 10) / 10}ms/s`])),
        frameEvents: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12)),
        perSecondMs: Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round((v / seconds) * 10) / 10])),
        // Frames the page's main thread ran (style, layout, paint), and frames its compositor drew.
        mainFramesPerSecond: Math.round((counts["LocalFrameView::RunPrePaintLifecyclePhase@CrRendererMain"] ?? 0) / seconds),
        framesPerSecond: Math.round((counts["LayerTreeImpl::UpdateDrawProperties@Compositor"] ?? 0) / seconds),
        // Style and layout brought up to date, a script's reads (getBoundingClientRect, offsetTop...) included.
        styleLayoutPerSecond: Math.round((counts["LocalFrameView::UpdateStyleAndLayout@CrRendererMain"] ?? 0) / seconds),
    };
}

/** Self time by function from a CDP CPU profile, busiest first. */
function topSelf(p: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[] } | undefined, n = 16) {
    if (!p) return null;
    const self = new Map<number, number>();
    p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)));
    const byFn = new Map<string, number>();
    for (const node of p.nodes) {
        const us = self.get(node.id) ?? 0;
        if (!us) continue;
        const f = node.callFrame;
        const key = f.url ? `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}` : f.functionName;
        byFn.set(key, (byFn.get(key) ?? 0) + us);
    }
    const total = [...byFn.values()].reduce((a, b) => a + b, 0);
    const busy = [...byFn].filter(([k]) => k !== "(idle)" && k !== "(program)").reduce((a, [, v]) => a + v, 0);
    const program = byFn.get("(program)") ?? 0;
    // Inclusive time of a few functions worth watching, by name.
    const nodes = new Map(p.nodes.map((x) => [x.id, x as typeof x & { children?: number[] }]));
    const within = (id: number): number => (self.get(id) ?? 0) + (nodes.get(id)?.children ?? []).reduce((a, c) => a + within(c), 0);
    const inclusive: Record<string, number> = {};
    for (const name of ["segments", "flush", "applyOp", "render", "highlight", "parse", "lex"]) {
        const roots = p.nodes.filter((x) => x.callFrame.functionName === name);
        if (roots.length) inclusive[name] = Math.round(roots.reduce((a, x) => a + within(x.id), 0) / 1000);
    }
    return {
        wallMs: Math.round(total / 1000),
        jsMs: Math.round(busy / 1000),
        programMs: Math.round(program / 1000),
        inclusiveMs: inclusive,
        top: [...byFn].filter(([k]) => k !== "(idle)").sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${(Math.round(v / 100) / 10).toFixed(1)}ms ${(Math.round((v / total) * 1000) / 10).toFixed(1)}% ${k}`),
    };
}

try {
    for (let i = 0; ; i++) { if (await fetch(`http://127.0.0.1:${DEMO_PORT}/healthz`).then((r) => r.ok, () => false)) break; if (i > 120) throw new Error("demo didn't start"); await sleep(500); }

    // ---- The app (development build), its main process's Node inspector on 9345.
    app = Bun.spawn([join(repo, "desktop-electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), "--inspect=9345", "--disable-backgrounding-occluded-windows", join(repo, "desktop-electron")], {
        cwd: repo,
        env: { ...process.env, CAVVY_HOME: join(dir, "home"), CAVVY_NO_KEYCHAIN: "1", CAVVY_ELECTRON_TEST_PORT: "9346", CAVVY_ELECTRON_USER_DATA: join(dir, "electron-data"), CAVVY_ELECTRON_CWD: project, CAVVY_ELECTRON_METRICS: metricsFile },
        stdout: "ignore",
        stderr: Bun.file(join(dir, "app.log")),
    });
    let gui: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; !gui; i++) {
        gui = ((await fetch("http://127.0.0.1:9346/json/list").then((r) => r.json(), () => [])) as { url: string; webSocketDebuggerUrl: string }[]).find((t) => t.url.startsWith("cavvy://app"));
        if (!gui) { if (i > 2000) throw new Error("no window"); await sleep(10); }
    }
    const page = await connect(gui.webSocketDebuggerUrl);
    const js = async (expression: string) => (await page.cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 30_000)).result?.result?.value;
    const mainTarget = ((await fetch("http://127.0.0.1:9345/json/list").then((r) => r.json(), () => [])) as { webSocketDebuggerUrl: string }[])[0];
    const main = mainTarget ? await connect(mainTarget.webSocketDebuggerUrl) : undefined;
    for (let i = 0; !(await js(`!!document.querySelector('textarea[aria-label="Message"]')`)); i++) { if (i > 1500) throw new Error("no composer"); await sleep(10); }
    // Experiments: --css <rules> added to the page; --reduced-motion as macOS's Reduce motion setting.
    if (arg("--css")) await js(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(arg("--css"))}; document.head.append(s); })()`);
    if (args.includes("--reduced-motion")) await page.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    report.experiment = { css: arg("--css"), reducedMotion: args.includes("--reduced-motion") };

    // ---- Sessions, through the app's own server.
    let server: { pid?: number; port?: number; token?: string } = {};
    for (let i = 0; !server.token; i++) { server = ((await Bun.file(metricsFile).json().catch(() => ({}))) as { server?: typeof server }).server ?? {}; if (i > 200) throw new Error("no server in metrics"); if (!server.token) await sleep(100); }
    const seed = await rpcTo(server.port!, server.token!);
    const summary = async (id: string) => (((await seed.call("sessions.list", { limit: 200 })).result ?? []) as { id: string; status: string; turnStartedAt?: number; title: string }[]).find((s) => s.id === id);
    const start = async (id: string, prompt: string) => {
        const before = (await summary(id))?.turnStartedAt;
        const sent = await seed.call("session.send", { id, text: prompt });
        for (let i = 0; i < 200; i++) { const s = await summary(id); if (s?.turnStartedAt !== before && s?.status === "running") return; await sleep(25); }
        if (process.env.BENCH_DEBUG) console.error(`start ${id} ${prompt}: ${JSON.stringify(sent)} status ${JSON.stringify(await summary(id))}`);
    };
    /** Until the turn is over (the approver answers its questions). */
    const finish = async (id: string, ms = 600_000) => { for (let i = 0; i < ms / 100; i++) { const st = (await summary(id))?.status; if (st !== "running" && st !== "waiting") return; await sleep(100); } };
    const turns = async (id: string, prompts: string[]) => { for (const p of prompts) { await start(id, p); await finish(id); } };
    const create = async () => (await seed.call("session.create", { cwd: project, mode: "bypassPermissions" })).result.state.id as string;
    const seedAt = performance.now();
    await seed.call("projects.trust", { path: project, trust: true });
    // Sessions start in the default mode here: every permission question is answered, as "always" where offered.
    let approving = false;
    /** Not while a phase measures: its polling would count as the server's. */
    let measuring = false;
    const approver = setInterval(async () => {
        if (approving || measuring) return;
        approving = true;
        try {
            for (const s of ((await seed.call("sessions.list", { limit: 200 })).result ?? []) as { id: string; status: string }[]) {
                if (s.status !== "waiting") continue;
                const st = (await seed.call("session.open", { id: s.id })).result?.state;
                for (const ask of st?.interactions ?? []) if (ask.kind === "permission") {
                    report.permissionAsks = (report.permissionAsks ?? 0) + 1;
                    await seed.call("session.respond", { id: s.id, interactionId: ask.id, response: { kind: "permission", choice: ["always", "session", "yes"].find((c) => ask.options.some((o: { id: string }) => o.id === c)) } }).catch(() => {});
                }
                // Not left subscribed: the app's window is the only one following it.
                await seed.call("session.close", { id: s.id }).catch(() => {});
            }
        } finally { approving = false; }
    }, 300);
    const pids = async () => {
        const m = (await Bun.file(metricsFile).json().catch(() => undefined)) as { procs: { pid: number; role: string }[] } | undefined;
        const roles = new Map<number, string>((m?.procs ?? []).map((p) => [p.pid, p.role]));
        if (server.pid) roles.set(server.pid, "server");
        roles.set(405, "WindowServer");
        const ws = Bun.spawnSync(["pgrep", "-x", "WindowServer"]).stdout.toString().trim();
        if (ws) { roles.delete(405); roles.set(Number(ws), "WindowServer"); }
        return roles;
    };
    const history = (n: number) => Array.from({ length: n }, (_, i) => (i % 4 === 1 ? "cmdrows" : `fastdemo 20000 (part ${i + 1})`));
    const long = await create();
    const short = await create();
    const others = [await create(), await create(), await create()];
    await Promise.all([turns(long, history(HISTORY)), turns(short, ["hello"]), ...others.map((id) => turns(id, history(Math.ceil(HISTORY / 3))))]);
    // The history's background commands (cmdrows starts one) stopped: idle is idle.
    for (const id of [long, short, ...others]) await seed.call("session.stopBackground", { id });
    for (const id of [long, short, ...others]) await seed.call("session.pin", { id, pinned: true });
    report.memoryAfterSeedMB = rss([...(await pids())]);
    report.footprintAfterSeedMB = footprint([...(await pids())]);
    report.seedSeconds = Math.round((performance.now() - seedAt) / 1000);

    const row = (id: string) => `document.querySelector('[data-session-row="${id}"] .slim-hit, [data-session-row="${id}"] .card-hit, [data-session-id="${id}"] .slim-hit')`;
    const show = async (id: string) => {
        for (let i = 0; i < 100 && !(await js(`!!${row(id)}`)); i++) await sleep(100);
        const at = await js(`(() => { const el = ${row(id)}; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 14) }; })()`);
        await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
        await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", buttons: 1, clickCount: 1 });
        await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", buttons: 0, clickCount: 1 });
        await sleep(2500);
    };

    // Bytes the page receives over its WebSockets.
    await page.cdp("Network.enable");
    let wsBytes = 0, wsFrames = 0;
    page.listeners.set("Network.webSocketFrameReceived", (p) => { wsBytes += p.response?.payloadData?.length ?? 0; wsFrames++; });


    /**
     * One stretch: CPU by role over `seconds` (nothing of ours attached meanwhile), memory at its end, then 3 s of both
     * JS profiles and a trace for where the time goes. `perSecond` also samples each second.
     */
    const phase = async (name: string, seconds: number, opts: { perSecond?: string } = {}) => {
        if (only && !only.includes(name)) return;
        const roles = await pids();
        await js(`(() => { window.__hiddenAt = []; window.__onVis = () => document.visibilityState !== 'visible' && __hiddenAt.push(performance.now()); document.addEventListener('visibilitychange', __onVis); })()`);
        const visibleAtStart = await js(`document.visibilityState`);
        measuring = true;
        const t0 = performance.now();
        const c0 = cpuTimes([...roles.keys()]);
        const b0 = wsBytes, f0 = wsFrames;
        const series: Record<string, unknown>[] = [];
        let last = c0, lastT = t0;
        for (let s = 1; s <= seconds; s++) {
            await sleep(1000);
            if (!opts.perSecond) continue;
            const now = performance.now();
            const c = cpuTimes([...roles.keys()]);
            const by: Record<string, number> = {};
            for (const [pid, role] of roles) by[role] = (by[role] ?? 0) + ((c.get(pid) ?? 0) - (last.get(pid) ?? 0));
            const w = (now - lastT) / 1000;
            series.push({ s, ui: Math.round((by.ui! / w) * 100), gpu: Math.round((by.gpu! / w) * 100), main: Math.round((by.main! / w) * 100), server: Math.round((by.server! / w) * 100), mem: rss([...roles]), extra: await js(opts.perSecond) });
            last = c;
            lastT = now;
        }
        const wall = (performance.now() - t0) / 1000;
        const c1 = cpuTimes([...roles.keys()]);
        const cpu: Record<string, number> = {};
        for (const [pid, role] of roles) cpu[role] = (cpu[role] ?? 0) + ((c1.get(pid) ?? 0) - (c0.get(pid) ?? 0));
        for (const k of Object.keys(cpu)) cpu[k] = Math.round((cpu[k]! / wall) * 1000) / 10;
        const memoryMB = rss([...roles]);
        const footprintMB = footprint([...roles]);
        measuring = false;
        const heap = await js(`(() => { const m = performance.memory; return m ? { usedMB: Math.round(m.usedJSHeapSize / 1048576), totalMB: Math.round(m.totalJSHeapSize / 1048576) } : null; })()`);
        // What's animating: by animation (CSS name, or a script's), its element and its state.
        const dom = await js(`(() => { const by = {}; for (const a of document.getAnimations()) { const t = a.effect && a.effect.target; const k = (a.animationName || a.constructor.name) + ' ' + (t ? t.tagName.toLowerCase() + '.' + String(t.getAttribute('class') || '').trim().split(/\\s+/).slice(0, 2).join('.') : '') + ' ' + a.playState; by[k] = (by[k] || 0) + 1; } return { nodes: document.getElementsByTagName('*').length, animations: document.getAnimations().length, fresh: document.querySelectorAll('.md-fresh').length, turns: document.querySelectorAll('.transcript [data-turn]').length, farTurns: document.querySelectorAll('.transcript [data-far]').length, rows: document.querySelectorAll('[data-work-row]').length, farRows: document.querySelectorAll('[data-work-far]').length, busyTurns: document.querySelectorAll('.turn[aria-busy="true"]').length, layered: [...document.querySelectorAll('.transcript .turn')].filter((t) => getComputedStyle(t).willChange === 'transform').length, byAnimation: Object.fromEntries(Object.entries(by).sort((x, y) => y[1] - x[1]).slice(0, 12)) }; })()`);
        const wsKB = Math.round((wsBytes - b0) / 1024 / wall), wsN = Math.round((wsFrames - f0) / wall);
        // With --shot <dir>: what the window showed, to check a change looks the same.
        if (arg("--shot")) {
            const shot = await page.cdp("Page.captureScreenshot", { format: "png" });
            if (shot.result?.data) await Bun.write(join(arg("--shot")!, `${label}-${name}.png`), Buffer.from(shot.result.data, "base64"));
            // And close up where the reply is being written, with the marks there at that moment.
            const at = await js(`(() => { const c = document.querySelector('.md-caret'); if (!c) return null; const r = c.getBoundingClientRect(); const col = c.closest('.md').getBoundingClientRect(); return { x: col.x - 8, y: Math.max(0, r.y - 70), width: col.width + 16, height: 100, scale: 2, marks: [...document.querySelectorAll('.md .md-fresh')].map((m) => m.className.replace('md-fresh', '').trim() || 'none') }; })()`);
            if (at) {
                const { marks, ...clip } = at;
                const close = await page.cdp("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false });
                if (close.result?.data) await Bun.write(join(arg("--shot")!, `${label}-${name}-caret.png`), Buffer.from(close.result.data, "base64"));
                await Bun.write(join(arg("--shot")!, `${label}-${name}-marks.json`), JSON.stringify(marks));
            }
        }
        // Where the time goes.
        await page.cdp("Profiler.enable");
        await page.cdp("Profiler.setSamplingInterval", { interval: 250 });
        await page.cdp("Profiler.start");
        if (main) { await main.cdp("Profiler.enable"); await main.cdp("Profiler.setSamplingInterval", { interval: 250 }); await main.cdp("Profiler.start"); }
        const events: any[] = [];
        page.listeners.set("Tracing.dataCollected", (p) => events.push(...p.value));
        const ended = new Promise((r) => page.listeners.set("Tracing.tracingComplete", r));
        await page.cdp("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "disabled-by-default-devtools.timeline.stack", "toplevel", "blink", "cc", "viz", "benchmark", "__metadata"] } });
        await sleep(3000);
        await page.cdp("Tracing.end");
        await Promise.race([ended, sleep(15000)]);
        const uiProfile = (await page.cdp("Profiler.stop")).result?.profile;
        // With --profiles <dir>: the page's profile, to open in DevTools or read for what a function costs with its calls.
        if (arg("--profiles") && uiProfile) await Bun.write(join(arg("--profiles")!, `${label}-${name}.cpuprofile`), JSON.stringify(uiProfile));
        const mainProfile = main ? (await main.cdp("Profiler.stop")).result?.profile : undefined;
        const uiPid = [...roles].find(([, r]) => r === "ui")?.[0] ?? 0;
        const hidden = await js(`(() => { document.removeEventListener('visibilitychange', __onVis); return __hiddenAt.length; })()`);
        report.phases[name] = {
            cpuPercent: cpu,
            appTotal: Math.round(((cpu.ui ?? 0) + (cpu.gpu ?? 0) + (cpu.main ?? 0) + (cpu.server ?? 0)) * 10) / 10,
            memoryMB,
            footprintMB,
            heap,
            dom,
            wsKBPerSecond: wsKB,
            ...(visibleAtStart !== "visible" || hidden ? { invalid: `window not visible (${visibleAtStart}, hidden ${hidden}x)` } : {}),
            wsFramesPerSecond: wsN,
            trace: summarizeTrace(events, uiPid, 3),
            ...(series.length ? { series } : {}),
            ui: topSelf(uiProfile),
            main: topSelf(mainProfile, 8),
        };
        const r = report.phases[name];
        console.error(`${name}${r.invalid ? " [INVALID: " + r.invalid + "]" : ""}: app ${r.appTotal}% ${JSON.stringify(cpu)} footprint ${JSON.stringify(footprintMB)} frames/s ${r.trace.framesPerSecond} main frames/s ${r.trace.mainFramesPerSecond} ws ${wsKB} KB/s ${wsN}/s`);
    };

    /** A turn started in each session, running through `run`, then stopped. */
    const streamWhile = async (starts: [string, string][], run: () => Promise<void>) => {
        await Promise.all(starts.map(([id, prompt]) => start(id, prompt)));
        await sleep(1500);
        await run();
        await Promise.all(starts.map(([id]) => seed.call("session.interrupt", { id }).catch(() => undefined)));
        await Promise.all(starts.map(([id]) => finish(id, 30_000)));
        await sleep(1500);
    };
    const want = (n: string) => !only || only.includes(n);

    // Idle, the long session on screen.
    await show(long);
    await sleep(3000);
    await phase("idleLongOnScreen", SECONDS, { perSecond: "0" });
    // A long reply (about 80 tokens a second, as a fast model) streaming on screen: a short session, then the long one.
    const text = "perfstream text 8 80";
    await show(short);
    if (want("textShortOnScreen")) await streamWhile([[short, text]], () => phase("textShortOnScreen", SECONDS));
    await show(long);
    if (want("textLongOnScreen")) await streamWhile([[long, text]], () => phase("textLongOnScreen", SECONDS));
    if (want("cmdLongOnScreen")) await streamWhile([[long, "perfstream cmd 2000"]], () => phase("cmdLongOnScreen", SECONDS));
    // The long session streaming while the short one is on screen (only the sidebar shows it).
    await show(short);
    if (want("textLongOffScreen")) await streamWhile([[long, text]], () => phase("textLongOffScreen", SECONDS));
    await sleep(2000);
    await phase("idleShortOnScreen", SECONDS);
    // Nothing streaming, but a command left running in the background (its spinner, its output).
    if (want("idleBackgroundCommand")) {
        await start(short, "perfstream bg 600");
        await sleep(5000);
        await phase("idleBackgroundCommand", SECONDS);
        await seed.call("session.stopBackground", { id: short });
        await sleep(1500);
    }
    // Four sessions at once: the long one on screen, two others open in the window (shown before), one never opened.
    if (want("fourAtOnce")) {
        await show(others[0]!);
        await show(others[1]!);
        await show(long);
        await streamWhile([[long, text], [others[0]!, "perfstream cmd 2000"], [others[1]!, text], [others[2]!, text]], () => phase("fourAtOnce", SECONDS, { perSecond: "0" }));
    }
    // A 40 KB reply at about 400 tokens a second, on screen: each second's cost, with the reply's length so far.
    await show(long);
    if (want("growth")) await streamWhile([[long, "perfstream text 30 400"]], () => phase("growth", 24, { perSecond: `[...document.querySelectorAll('.transcript [data-turn]')].at(-1)?.textContent?.length ?? 0` }));
    // With --mounted 40,200,480: a reply streaming in the long session with that many of its turns drawn ("Show
    // earlier" clicked until they are), followed at the end ("Latest").
    for (const n of (arg("--mounted") ?? "").split(",").filter(Boolean).map(Number)) {
        await show(long);
        for (let i = 0; i < 40 && (await js(`document.querySelectorAll('.transcript [data-turn]').length`)) < n; i++) {
            if (!(await js(`(() => { const b = document.querySelector('.transcript .earlier'); b?.click(); return !!b; })()`))) break;
            await sleep(1000);
        }
        await js(`document.querySelector('.jump')?.click()`);
        await sleep(3000);
        await streamWhile([[long, text]], () => phase(`textLong@${n}`, SECONDS));
    }
    // Memory once it's all over and settled.
    await sleep(5000);
    report.memoryAfterMB = rss([...(await pids())]);
    report.footprintAfterMB = footprint([...(await pids())]);
    // And once the page has collected its garbage.
    await page.cdp("HeapProfiler.collectGarbage");
    await sleep(3000);
    report.footprintAfterGcMB = footprint([...(await pids())]);
    clearInterval(approver);
    seed.ws.close();
} catch (e) {
    report.error = String((e as Error)?.stack ?? e);
    report.appLog = (await Bun.file(join(dir, "app.log")).text().catch(() => "")).split("\n").slice(-15).join("\n");
} finally {
    app?.kill("SIGTERM");
    await sleep(3000);
    app?.kill("SIGKILL");
    demo.kill();
    mkdirSync(join(import.meta.dir, "bench-results"), { recursive: true });
    await Bun.write(join(import.meta.dir, "bench-results", `bench-stream-${label}.json`), JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report, null, 1));
    if (!args.includes("--keep")) rmSync(dir, { recursive: true, force: true });
    process.exit(0);
}
