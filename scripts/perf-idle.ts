// What the home screen costs while nothing happens: the memory and CPU of every process behind it (the server, the
// demo's mock model, and Chrome's: browser, GPU, network, the page), on Linux, in the default theme.
//
//   bun scripts/perf-idle.ts            measure once, against test/perf-budgets.json (idleHomeMemoryMB, idleHomeCpuPercent)
//   bun scripts/perf-idle.ts --runs 5   measure five times and print each, without checking
//
// The built GUI (gui/dist: `bun run gui:build` first), the demo server (scripts/gui-demo.ts), and installed Chrome
// (or CAVVY_TEST_CHROME). Memory is the processes' proportional set size once settled; CPU is their time over 30 s, as
// a share of one core. Both vary from run to run and machine to machine, so a budget has room above what a runner
// measures (docs/performance-targets-v2.md, CI budgets): it catches a regression, not noise. A Mac's figures are
// desktop-electron/bench-mac.ts's.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const TOKEN = "perf-idle-token-0123456789";
const SETTLE_MS = 15_000;
const CPU_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, ms: number, check: () => Promise<T | undefined> | T | undefined): Promise<T> {
    const end = performance.now() + ms;
    for (;;) {
        const got = await check();
        if (got) return got;
        if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
    }
}

/** Each process under `roots` (them included), from /proc. */
function tree(roots: number[]): number[] {
    const parent = new Map<number, number>();
    for (const d of readdirSync("/proc")) {
        if (!/^\d+$/.test(d)) continue;
        const stat = safeRead(`/proc/${d}/stat`);
        if (!stat) continue;
        const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        parent.set(Number(d), Number(after[1]));
    }
    const out = new Set(roots);
    for (let grew = true; grew; ) {
        grew = false;
        for (const [pid, pp] of parent) if (out.has(pp) && !out.has(pid)) (out.add(pid), (grew = true));
    }
    return [...out];
}

function safeRead(path: string): string {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
}

/** Proportional set size, MB: what each process's memory is, its shared pages split between those sharing them. */
const pssMB = (pids: number[]) => pids.reduce((sum, pid) => sum + Number(/^Pss:\s+(\d+) kB/m.exec(safeRead(`/proc/${pid}/smaps_rollup`))?.[1] ?? 0), 0) / 1024;
/** CPU time, in clock ticks (100 a second). */
const ticks = (pids: number[]) => pids.reduce((sum, pid) => {
    const s = safeRead(`/proc/${pid}/stat`);
    if (!s) return sum;
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    return sum + Number(f[11]) + Number(f[12]);
}, 0);

async function devtools(profile: string, browser: { exitCode: number | null }) {
    const port = await until("Chrome's DevTools", 90_000, async () => {
        if (browser.exitCode !== null) throw new Error(`Chrome exited (${browser.exitCode})`);
        return /^(\d+)\n/.exec(await Bun.file(join(profile, "DevToolsActivePort")).text().catch(() => ""))?.[1];
    });
    const version = (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("DevTools connection failed")); });
    let seq = 0;
    const pending = new Map<number, (m: any) => void>();
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
    const call = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((r, j) => {
        const id = ++seq;
        pending.set(id, (m) => (m.error ? j(new Error(`${method}: ${m.error.message}`)) : r(m.result)));
        ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    const page = (method: string, params: object = {}) => call(method, params, sessionId);
    const js = async (expression: string) => {
        const r = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
    };
    return { page, js, close: () => ws.close() };
}

/** One measurement: the home screen opened, left alone, then its memory and its CPU over 30 s. */
export async function measureIdleHome(chrome: string): Promise<{ memoryMB: number; cpuPercent: number; processes: number }> {
    const scratch = mkdtempSync(join(tmpdir(), "cavvy-perf-idle-"));
    let demo: ReturnType<typeof Bun.spawn> | undefined;
    let browser: ReturnType<typeof Bun.spawn> | undefined;
    let tools: Awaited<ReturnType<typeof devtools>> | undefined;
    try {
        const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
        const port = free.port;
        free.stop(true);
        demo = Bun.spawn([process.execPath, "--no-env-file", `--config=${join(repo, "bunfig.toml")}`, join(repo, "scripts/gui-demo.ts"), "--dir", join(scratch, "demo"), "--port", String(port), "--token", TOKEN], {
            cwd: repo, env: { ...process.env, CAVVY_GUI_DIST: join(repo, "gui/dist") } as Record<string, string>, stdout: "ignore", stderr: "ignore",
        });
        await until("the demo server", 60_000, () => fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false));
        const profile = join(scratch, "chrome");
        browser = Bun.spawn([
            chrome, "--headless", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
            ...(process.getuid?.() === 0 || process.env.CI ? ["--no-sandbox"] : []),
            "--window-size=1200,800", `--user-data-dir=${profile}`, "--remote-debugging-port=0",
        ], { stdout: "ignore", stderr: "ignore" });
        tools = await devtools(profile, browser);
        const { page, js } = tools;
        await page("Page.enable");
        await page("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
        await page("Page.navigate", { url: `http://127.0.0.1:${port}/#token=${TOKEN}` });
        await until("the home screen", 30_000, () => js(`!!document.querySelector("textarea:not([data-parked] *)")`));
        await sleep(SETTLE_MS);
        // DevTools' own connection is Chrome's browser process: measured with the rest, the same each run.
        const pids = tree([demo.pid, browser.pid]);
        const memoryMB = pssMB(pids);
        const t0 = ticks(pids);
        const start = performance.now();
        await sleep(CPU_MS);
        const used = ticks(tree([demo.pid, browser.pid])) - t0;
        const cpuPercent = (used * 10) / (performance.now() - start) * 100;
        return { memoryMB: Math.round(memoryMB), cpuPercent: Math.round(cpuPercent * 100) / 100, processes: pids.length };
    } finally {
        tools?.close();
        browser?.kill();
        demo?.kill();
        await Promise.all([browser?.exited, demo?.exited]);
        rmSync(scratch, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    if (process.platform !== "linux") {
        console.error("perf-idle.ts reads /proc: Linux only (a Mac's figures are desktop-electron/bench-mac.ts's).");
        process.exit(2);
    }
    const chrome = [process.env.CAVVY_TEST_CHROME, "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => p && existsSync(p));
    if (!chrome) {
        console.error("No Chrome: install it, or set CAVVY_TEST_CHROME.");
        process.exit(2);
    }
    if (!existsSync(join(repo, "gui/dist/index.html"))) {
        console.error("No built GUI: run `bun run gui:build` first.");
        process.exit(2);
    }
    const runs = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 0;
    if (runs) {
        for (let i = 0; i < runs; i++) console.log(JSON.stringify(await measureIdleHome(chrome)));
        process.exit(0);
    }
    const budgets = JSON.parse(readFileSync(join(repo, "test/perf-budgets.json"), "utf8")) as Record<string, number>;
    const m = await measureIdleHome(chrome);
    const failures: string[] = [];
    for (const [name, measured] of [["idleHomeMemoryMB", m.memoryMB], ["idleHomeCpuPercent", m.cpuPercent]] as const) {
        console.log(`${name}: ${measured} (budget ${budgets[name]})`);
        // Over fails; under doesn't: these move with the machine, and being under says nothing about the code.
        if (measured > budgets[name]!) failures.push(`${name}: ${measured}, over its budget of ${budgets[name]}`);
    }
    if (failures.length) {
        console.error(failures.join("\n"));
        process.exit(1);
    }
}
