// What one long reply costs the page in a packaged app, through the real server and socket: main-thread work, heap, DOM
// changes, how long after the last delivery the text is all on screen, and the same stretch with nothing delivered. A
// session with 20 earlier turns, a fresh app for each run. The shape of the test and its measures follow the published
// comparison in PandaCode's bench/t3-compare (50 KB in 25-byte deltas, 16 ms apart), so the numbers can be set beside
// T3 Code's; the reply is this repo's own (scripts/mock-llm.ts). Writes bench-results/bench-reply-<label>.json.
//
//   bun desktop-electron/bench-reply.ts --label new --app <…>/Cavvy.app [--runs 3] [--bytes 50000]

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPLY_END } from "../scripts/mock-llm";

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const label = arg("--label") ?? "run";
const appPath = arg("--app");
if (!appPath) throw new Error("usage: bench-reply.ts --label x --app <Cavvy.app> [--runs 3] [--bytes 50000]");
const RUNS = Number(arg("--runs") ?? 3);
const BYTES = Number(arg("--bytes") ?? 50_000);
const DELTA_BYTES = 25, DELTA_MS = 16;
const SPAN_MS = (BYTES / DELTA_BYTES) * DELTA_MS;
const repo = resolve(import.meta.dir, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;

async function connect(url: string, subprotocols?: string[]) {
    const ws = new WebSocket(url, subprotocols);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0;
    const pending = new Map<number, (v: any) => void>();
    const listeners = new Map<string, (params: any) => void>();
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.method) listeners.get(m.method)?.(m.params); else if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
    const call = (method: string, params: unknown = {}, ms = 60_000) => new Promise<any>((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.delete(id)) r({ error: "timeout" }); }, ms); });
    return { ws, call, listeners };
}

async function run(n: number) {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cavvy-reply-"));
    const metricsFile = join(dir, "metrics.json");
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CAVVY|ANTHROPIC|ELECTRON_RUN_AS_NODE)/.test(k)));
    const demo = Bun.spawn(["bun", "--no-env-file", "scripts/gui-demo.ts", "--port", "4644", "--token", "reply-bench-token-1234567890", "--dir", dir], { cwd: repo, env: clean, stdout: "ignore", stderr: "ignore" });
    let app: ReturnType<typeof Bun.spawn> | undefined;
    try {
        for (let i = 0; ; i++) { if (await fetch("http://127.0.0.1:4644/healthz").then((r) => r.ok, () => false)) break; if (i > 120) throw new Error("demo"); await sleep(500); }
        const project = join(dir, "acme-platform");
        app = Bun.spawn([join(appPath!, "Contents/MacOS/cavvy-desktop"), "--disable-backgrounding-occluded-windows"], { cwd: repo, env: { ...clean, CAVVY_HOME: join(dir, "home"), CAVVY_NO_KEYCHAIN: "1", CAVVY_ELECTRON_TEST_PORT: "9356", CAVVY_ELECTRON_USER_DATA: join(dir, "electron-data"), CAVVY_ELECTRON_CWD: project, CAVVY_ELECTRON_METRICS: metricsFile }, stdout: "ignore", stderr: "ignore" });
        let gui: { webSocketDebuggerUrl: string } | undefined;
        for (let i = 0; !gui; i++) { gui = ((await fetch("http://127.0.0.1:9356/json/list").then((r) => r.json(), () => [])) as any[]).find((t) => t.url.startsWith("cavvy://app")); if (!gui) { if (i > 2000) throw new Error("no window"); await sleep(10); } }
        const page = await connect(gui.webSocketDebuggerUrl);
        const js = async (expression: string) => (await page.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
        for (let i = 0; !(await js(`!!document.querySelector('textarea[aria-label="Message"]')`)); i++) { if (i > 1500) throw new Error("no composer"); await sleep(10); }
        let server: any = {};
        for (let i = 0; !server.token; i++) { server = ((await Bun.file(metricsFile).json().catch(() => ({}))) as any).server ?? {}; if (i > 200) throw new Error("no server"); if (!server.token) await sleep(100); }
        const rpc = await connect(`ws://127.0.0.1:${server.port}/ws`, ["cavvy.v1", `auth.${server.token}`]);
        const status = async (id: string) => (((await rpc.call("sessions.list", { limit: 50 })).result ?? []) as any[]).find((s) => s.id === id)?.status;
        const finish = async (id: string, ms: number) => { const t0 = Date.now(); await sleep(150); while (Date.now() - t0 < ms) { const s = await status(id); if (s && s !== "running" && s !== "waiting") return; await sleep(100); } throw new Error("the turn didn't finish"); };

        const id = (await rpc.call("session.create", { cwd: project, mode: "bypassPermissions" })).result.state.id as string;
        await rpc.call("session.pin", { id, pinned: true });
        for (let t = 0; t < 20; t++) { await rpc.call("session.send", { id, text: "fastdemo burst short" }); await finish(id, 60_000); }
        const row = `document.querySelector('[data-session-id="${id}"] :is(.slim-hit, .card-hit)')`;
        for (let i = 0; i < 100 && !(await js(`!!${row}`)); i++) await sleep(100);
        const at = await js(`(() => { const r = ${row}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 14) }; })()`);
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await page.call("Input.dispatchMouseEvent", { type, ...at, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 500, button: "none", buttons: 0 });
        await sleep(5000);

        await page.call("Performance.enable", { timeDomain: "timeTicks" });
        await js(`(() => { window.__mutations = 0; new MutationObserver((l) => { window.__mutations += l.length; }).observe(document.body, { childList: true, characterData: true, attributes: true, subtree: true }); })()`);
        const metrics = async () => Object.fromEntries(((await page.call("Performance.getMetrics")).result?.metrics ?? []).map((m: any) => [m.name, m.value])) as Record<string, number>;
        const spend = (a: Record<string, number>, b: Record<string, number>, ms: number) => {
            const d = (k: string) => Math.round((b[k]! - a[k]!) * 1000);
            return { taskMs: d("TaskDuration"), scriptMs: d("ScriptDuration"), layoutMs: d("LayoutDuration"), styleMs: d("RecalcStyleDuration"), layouts: b.LayoutCount! - a.LayoutCount!, styles: b.RecalcStyleCount! - a.RecalcStyleCount!, spanMs: ms };
        };
        const heap = async () => { await page.call("HeapProfiler.collectGarbage"); await sleep(200); await page.call("HeapProfiler.collectGarbage"); return Math.round(((await page.call("Runtime.getHeapUsage")).result?.usedSize ?? 0) / 104857.6) / 10; };

        // ---- Nothing delivered.
        let m0 = await metrics();
        let mut0 = await js(`window.__mutations`);
        await sleep(SPAN_MS);
        const idle = { ...spend(m0, await metrics(), SPAN_MS), mutations: (await js(`window.__mutations`)) - mut0 };

        // ---- The reply.
        const heapBefore = await heap();
        m0 = await metrics();
        mut0 = await js(`window.__mutations`);
        const t0 = Date.now();
        await rpc.call("session.send", { id, text: `perfreply ${BYTES} ${DELTA_BYTES} ${DELTA_MS}` });
        await sleep(SPAN_MS - 3000);
        // The last moments: when the socket hands over the last of it, and the frame after the text is on screen.
        await page.call("Network.enable");
        let delivered = 0;
        page.listeners.set("Network.webSocketFrameReceived", (p: any) => { if (String(p.response?.payloadData ?? "").includes(REPLY_END.slice(-12))) delivered ||= Date.now(); });
        const painted = (await page.call("Runtime.evaluate", { expression: `new Promise((done) => { const tick = () => { const m = [...document.querySelectorAll('.md')].at(-1); if (m && m.textContent.includes(${JSON.stringify(REPLY_END)})) requestAnimationFrame(() => done(Date.now())); else requestAnimationFrame(tick); }; tick(); })`, awaitPromise: true, returnByValue: true }, 120_000)).result?.result?.value as number;
        await finish(id, 60_000);
        await sleep(1000);
        const m1 = await metrics();
        const reply = { ...spend(m0, m1, Date.now() - t0), mutations: (await js(`window.__mutations`)) - mut0, wallToPaintMs: painted - t0, lastDeliveryToPaintMs: delivered ? painted - delivered : null };
        const shown = await js(`[...document.querySelectorAll('.md')].at(-1)?.textContent.length`);
        const heapAfter = await heap();
        return { n, idle, reply, heapBefore, heapAfter, shown };
    } finally {
        app?.kill("SIGTERM");
        await sleep(1500);
        demo.kill();
        await sleep(500);
    }
}

const results = [];
for (let n = 1; n <= RUNS; n++) { const r = await run(n); results.push(r); console.error(JSON.stringify(r)); }
const med = (f: (r: (typeof results)[number]) => number) => median(results.map(f));
const report = {
    label, at: new Date().toISOString(), bytes: BYTES, runs: results,
    median: {
        taskMs: med((r) => r.reply.taskMs), scriptMs: med((r) => r.reply.scriptMs), layoutMs: med((r) => r.reply.layoutMs), styleMs: med((r) => r.reply.styleMs),
        idleTaskMs: med((r) => r.idle.taskMs), idleScriptMs: med((r) => r.idle.scriptMs), idleMutations: med((r) => r.idle.mutations),
        mutations: med((r) => r.reply.mutations), lastDeliveryToPaintMs: med((r) => r.reply.lastDeliveryToPaintMs ?? NaN), heapBeforeMB: med((r) => r.heapBefore), heapAfterMB: med((r) => r.heapAfter),
    },
};
mkdirSync(join(import.meta.dir, "bench-results"), { recursive: true });
await Bun.write(join(import.meta.dir, "bench-results", `bench-reply-${label}.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.median, null, 1));
process.exit(0);
