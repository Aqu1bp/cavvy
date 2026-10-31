// Startup, launch after launch with one profile: the first has no code cache, later ones do. For each, from the moment
// it's spawned: the server ready, the window shown, and the composer there to type in. Writes bench-results/bench-startup-<label>.json.
//
//   bun desktop-electron/bench-startup.ts --label dev
//   bun desktop-electron/bench-startup.ts --label packaged --app <…>/Cavvy.app/Contents/MacOS/Cavvy

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const label = arg("--label") ?? "run";
const launches = Number(arg("--launches") ?? 6);
const repo = resolve(import.meta.dir, "..");
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cavvy-startup-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report: Record<string, unknown> = { label, launches: [] as unknown[] };
const demo = Bun.spawn(["bun", "--no-env-file", "scripts/gui-demo.ts", "--port", "4635", "--token", "startup-bench-token-1234567", "--dir", dir], { cwd: repo, stdout: "ignore", stderr: "ignore" });
try {
    for (let i = 0; ; i++) { if (await fetch("http://127.0.0.1:4635/healthz").then((r) => r.ok, () => false)) break; if (i > 120) throw new Error("demo"); await sleep(500); }
    const exe = arg("--app");
    for (let n = 0; n < launches; n++) {
        const metricsFile = join(dir, `metrics-${n}.json`);
        const spawnedAt = performance.now();
        const app = Bun.spawn(exe ? [exe] : [join(repo, "desktop-electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), join(repo, "desktop-electron")], {
            cwd: repo,
            env: { ...process.env, CAVVY_HOME: join(dir, "home"), CAVVY_NO_KEYCHAIN: "1", CAVVY_ELECTRON_TEST_PORT: "9343", CAVVY_ELECTRON_USER_DATA: join(dir, "electron-data"), CAVVY_ELECTRON_CWD: join(dir, "acme-platform"), CAVVY_ELECTRON_METRICS: metricsFile },
            stdout: "ignore",
            stderr: "ignore",
        });
        let ws: WebSocket | undefined;
        for (let i = 0; !ws; i++) {
            const t = ((await fetch("http://127.0.0.1:9343/json/list").then((r) => r.json(), () => [])) as { url: string; webSocketDebuggerUrl: string }[]).find((x) => x.url.startsWith("cavvy://app"));
            if (t) ws = new WebSocket(t.webSocketDebuggerUrl);
            else { if (i > 3000) throw new Error("no window"); await sleep(5); }
        }
        await new Promise((r, j) => { ws!.onopen = r; ws!.onerror = j; });
        let seq = 0;
        const pending = new Map<number, (v: any) => void>();
        ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); pending.get(m.id)?.(m); pending.delete(m.id); };
        const js = (expression: string) => new Promise<any>((r) => { const id = ++seq; pending.set(id, (m) => r(m.result?.result?.value)); ws!.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } })); });
        for (let i = 0; !(await js(`!!document.querySelector('textarea[aria-label="Message"]')`)); i++) { if (i > 3000) throw new Error("no composer"); await sleep(5); }
        const interactive = Math.round(performance.now() - spawnedAt);
        await sleep(1500);
        const marks = ((await Bun.file(metricsFile).json().catch(() => ({}))) as { marks?: Record<string, number> }).marks ?? {};
        (report.launches as unknown[]).push({ n, interactive, ...marks });
        ws.close();
        app.kill("SIGTERM");
        await app.exited;
        await sleep(2500);
    }
    const all = report.launches as { interactive: number; shown?: number }[];
    const warm = all.slice(1).map((l) => l.interactive).sort((a, b) => a - b);
    report.summary = { firstLaunchInteractiveMs: all[0]?.interactive, warmInteractiveMedianMs: warm[Math.floor(warm.length / 2)], firstShownMs: all[0]?.shown, warmShownMedianMs: all.slice(1).map((l) => l.shown ?? 0).sort((a, b) => a - b)[Math.floor(warm.length / 2)] };
} catch (e) {
    report.error = String((e as Error)?.stack ?? e);
} finally {
    demo.kill();
    await Bun.write(join(import.meta.dir, "bench-results", `bench-startup-${label}.json`), JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report));
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
}
