// What heavy use costs in a packaged app on the demo's mock model: a very large session (long history, big tool output)
// opened cold, several sessions streaming at once, git in a large repository, and hours of all of it. Results are
// written after each part, so a crash loses only the part it stopped. Writes bench-results/bench-heavy-<label>.json.
//
//   bun desktop-electron/bench-heavy.ts --label new --app <…>/Cavvy.app [--only open,many,git,soak] [--sessions 5]
//       [--turns 400] [--kb 200] [--files 100000] [--hours 3]
//
// For the same with real models, bench-real.ts with five --models.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createDemoProject } from "../scripts/demo-project";

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const label = arg("--label") ?? "run";
const appPath = arg("--app");
if (!appPath) throw new Error("usage: bench-heavy.ts --label x --app <Cavvy.app> [--only open,many,git,soak]");
const parts = (arg("--only") ?? "open,many,git,soak").split(",");
const SESSIONS = Number(arg("--sessions") ?? 5);
const LARGE_TURNS = Number(arg("--turns") ?? 400), LARGE_KB = Number(arg("--kb") ?? 200);
const FILES = Number(arg("--files") ?? 100_000);
const HOURS = Number(arg("--hours") ?? 3);
const repo = resolve(import.meta.dir, "..");
const results = join(import.meta.dir, "bench-results");
const out = join(results, `bench-heavy-${label}.json`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
const report: Record<string, any> = { label, app: appPath, at: new Date().toISOString(), sessions: SESSIONS, largeTurns: LARGE_TURNS, largeKB: LARGE_KB, files: FILES, hours: HOURS };
const save = () => { mkdirSync(results, { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 1)); };

// What a process has spent: see bench-reply.ts.
const libproc = dlopen("/usr/lib/libproc.dylib", { proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
function spent(pid: number) {
    const buf = new BigUint64Array(80);
    if (libproc.symbols.proc_pid_rusage(pid, 6, ptr(buf)) !== 0) return { instructions: NaN, energy: NaN };
    return { instructions: Number(buf[31]), energy: Number(buf[42]) };
}

async function connect(url: string, subprotocols?: string[]) {
    const ws = new WebSocket(url, subprotocols);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0;
    const pending = new Map<number, (v: any) => void>();
    const listeners = new Map<string, (params: any) => void>();
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.method) listeners.get(m.method)?.(m.params); else if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
    const call = (method: string, params: unknown = {}, ms = 120_000) => new Promise<any>((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.delete(id)) r({ error: "timeout" }); }, ms); });
    return { ws, call, listeners };
}

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cavvy-heavy-"));
const metricsFile = join(dir, "metrics.json");
// Every git the server starts goes through this, which writes down what it was and how long it took; a stand-in for the
// login shell puts it first on PATH. The app's own reads ignore git's trace settings on purpose, so those wouldn't do.
const shim = join(dir, "shim"), gitLog = join(dir, "git.log"), loginShell = join(dir, "login-shell");
mkdirSync(shim, { recursive: true });
writeFileSync(join(shim, "git"), `#!/bin/zsh -f\nzmodload zsh/datetime\ns=$EPOCHREALTIME\n${Bun.which("git")} "$@"\nrc=$?\nprint -r -- "$(( EPOCHREALTIME - s )) $*" >> ${gitLog}\nexit $rc\n`);
writeFileSync(loginShell, `#!/bin/sh\nPATH="${shim}:$PATH" exec /bin/sh -c "$2"\n`);
chmodSync(join(shim, "git"), 0o755);
chmodSync(loginShell, 0o755);
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CAVVY|ANTHROPIC|ELECTRON_RUN_AS_NODE)/.test(k)));
const TOKEN = "heavy-bench-token-1234567890";
const demo = Bun.spawn(["bun", "--no-env-file", "scripts/gui-demo.ts", "--port", "4649", "--token", TOKEN, "--dir", dir], { cwd: repo, env: clean, stdout: "ignore", stderr: "ignore" });
const project = join(dir, "acme-platform");

let running: ReturnType<typeof Bun.spawn> | undefined;

/** The app, started afresh on the same home: its window, its server, and what it's made of. */
async function launch() {
    rmSync(metricsFile, { force: true });
    // One left running from another run would answer in this one's place.
    if (await fetch("http://127.0.0.1:9358/json/list").then(() => true, () => false)) throw new Error("something is already on port 9358: a test app left running?");
    const app = Bun.spawn([join(appPath!, "Contents/MacOS/cavvy-desktop"), "--disable-backgrounding-occluded-windows"], { cwd: repo, env: { ...clean, SHELL: loginShell, CAVVY_HOME: join(dir, "home"), CAVVY_NO_KEYCHAIN: "1", CAVVY_ELECTRON_TEST_PORT: "9358", CAVVY_ELECTRON_USER_DATA: join(dir, "electron-data"), CAVVY_ELECTRON_CWD: project, CAVVY_ELECTRON_METRICS: metricsFile }, stdout: "ignore", stderr: "ignore" });
    running = app;
    let gui: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; !gui; i++) { gui = ((await fetch("http://127.0.0.1:9358/json/list").then((r) => r.json(), () => [])) as any[]).find((t) => t.url.startsWith("cavvy://app")); if (!gui) { if (i > 2000) throw new Error("no window"); await sleep(10); } }
    const page = await connect(gui.webSocketDebuggerUrl);
    const js = async (expression: string) => (await page.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
    for (let i = 0; !(await js(`!!document.querySelector('textarea[aria-label="Message"]')`)); i++) { if (i > 3000) throw new Error("no composer"); await sleep(10); }
    let server: any = {};
    for (let i = 0; !server.token; i++) { server = ((await Bun.file(metricsFile).json().catch(() => ({}))) as any).server ?? {}; if (i > 200) throw new Error("no server"); if (!server.token) await sleep(100); }
    const rpc = await connect(`ws://127.0.0.1:${server.port}/ws`, ["cavvy.v1", `auth.${server.token}`]);
    // This connection shows nothing: left unsaid, the server would count it as looking at every session.
    void rpc.call("session.shown", {});
    let crashed = false;
    await page.call("Inspector.enable");
    page.listeners.set("Inspector.targetCrashed", () => { crashed = true; });
    // The frames that took too long, for the whole run: 50 ms and up is all Chromium reports.
    await js(`(() => { window.__heavy = { loaf: [] }; new PerformanceObserver((l) => { for (const e of l.getEntries()) { const x = __heavy.loaf; x.push(Math.round(e.duration)); if (x.length > 5000) x.splice(0, 1000); } }).observe({ type: 'long-animation-frame' }); })()`);
    const procs = (((await Bun.file(metricsFile).json().catch(() => ({}))) as any).procs ?? []) as { pid: number; role: string }[];
    const roles = new Map<string, number>(procs.filter((p) => ["ui", "gpu", "main"].includes(p.role)).map((p) => [p.role, p.pid]));
    roles.set("server", server.pid);
    return { app, page, js, rpc, roles, serverPid: server.pid as number, crashed: () => crashed };
}
type App = Awaited<ReturnType<typeof launch>>;

async function quit(a: App) {
    a.rpc.ws.close();
    a.page.ws.close();
    a.app.kill("SIGTERM");
    await Promise.race([a.app.exited, sleep(10_000)]);
    for (let i = 0; i < 50 && await fetch("http://127.0.0.1:9358/json/list").then(() => true, () => false); i++) await sleep(100);
    await sleep(1000);
    running = undefined;
}

const sessionsOf = async (a: App) => ((await a.rpc.call("sessions.list", { limit: 200 })).result ?? []) as { id: string; status: string; messages: number }[];
const create = async (a: App) => {
    const id = (await a.rpc.call("session.create", { cwd: project, mode: "bypassPermissions" })).result.state.id as string;
    await a.rpc.call("session.pin", { id, pinned: true });
    return id;
};
/** One whole turn. A prompt sent while a turn runs would join it. A short one can be over before the next look: its messages say it ran. */
async function turn(a: App, id: string, prompt: string) {
    const now = async () => (await lookEvery500ms(a)).find((s) => s.id === id);
    const before = (await sessionsOf(a)).find((s) => s.id === id)?.messages;
    await a.rpc.call("session.send", { id, text: prompt });
    for (let i = 0; ; i++) {
        const s = await now();
        if (s?.status === "running" || s?.messages !== before) break;
        if (i > 60) throw new Error(`a turn didn't start: ${prompt}`);
    }
    for (let i = 0; ; i++) {
        const status = (await now())?.status;
        if (status === "waiting") throw new Error(`a turn stopped to ask: ${prompt}`);
        if (status !== "running") return;
        if (i > 1200) throw new Error(`a turn didn't finish: ${prompt}`);
    }
}
/** One look at the sessions shared by all who wait, so that what's measured isn't the bench asking. */
let look: Promise<Awaited<ReturnType<typeof sessionsOf>>> | undefined;
const lookEvery500ms = (a: App) => (look ??= sleep(500).then(() => { look = undefined; return sessionsOf(a); }));
const row = (id: string) => `document.querySelector('[data-session-row="${id}"] :is(.slim-hit, .card-hit), [data-session-id="${id}"] :is(.slim-hit, .card-hit)')`;
async function click(a: App, id: string) {
    for (let i = 0; i < 100 && !(await a.js(`!!${row(id)}`)); i++) await sleep(100);
    const at = await a.js(`(() => { const el = ${row(id)}; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 14) }; })()`);
    if (!at) throw new Error("no row to click");
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await a.page.call("Input.dispatchMouseEvent", { type, ...at, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    await a.page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 500, button: "none", buttons: 0 });
}
/** Opens a session from the sidebar: how long from the click to the frame showing it, or -1 past a minute. */
async function open(a: App, id: string) {
    const shown = `!!document.querySelector('[data-session-row="${id}"].cur, [data-session-id="${id}"].cur, [data-session-row="${id}"] .cur') && document.querySelectorAll('.transcript [data-turn]').length > 0`;
    const t0 = await a.js(`performance.now()`);
    await click(a, id);
    const t1 = await a.js(`new Promise((res) => { const t0 = performance.now(); (function check() { let ok = false; try { ok = ${shown}; } catch {} if (ok) requestAnimationFrame(() => res(performance.now())); else if (performance.now() - t0 > 60000) res(-1); else requestAnimationFrame(check); })(); })`);
    return t1 < 0 ? -1 : Math.round(t1 - t0);
}
/** Each of the app's processes, the server's children included, by what `footprint` says it holds (MB). */
function footprint() {
    const rows = Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString().split("\n");
    const pids = rows.flatMap((r) => { const m = /^\s*(\d+)\s+(.*)$/.exec(r); return m && m[2]!.includes(`${appPath}/Contents`) ? [{ pid: Number(m[1]), command: m[2]! }] : []; });
    const text = Bun.spawnSync(["footprint", "-f", "bytes", ...pids.flatMap((p) => ["-p", String(p.pid)])]).stdout.toString();
    const held = new Map([...text.matchAll(/\[(\d+)\]:.*?Footprint: (\d+) B/g)].map((m) => [Number(m[1]), Number(m[2]) / 1048576]));
    const byKind: Record<string, number> = {};
    for (const p of pids) {
        const kind = /--utility-sub-type=(\S+)/.exec(p.command)?.[1] ?? /--type=(\S+)/.exec(p.command)?.[1] ?? (p.command.includes("cavvy-desktop") ? "main" : "server");
        byKind[kind] = Math.round((byKind[kind] ?? 0) + (held.get(p.pid) ?? 0));
    }
    return { total: Object.values(byKind).reduce((x, y) => x + y, 0), byKind };
}
const heapMB = async (a: App) => { await a.page.call("HeapProfiler.collectGarbage"); await sleep(200); return Math.round(((await a.page.call("Runtime.getHeapUsage")).result?.usedSize ?? 0) / 104857.6) / 10; };
const domNodes = async (a: App) => (await a.page.call("Memory.getDOMCounters")).result?.nodes as number;
const openFiles = (pid: number) => Bun.spawnSync(["lsof", "-p", String(pid)]).stdout.toString().split("\n").length - 2;
/** What the app spends over a stretch, in millions of instructions a second by process, and joules. */
async function stretch(a: App, ms: number) {
    const from = new Map([...a.roles].map(([role, pid]) => [role, spent(pid)]));
    const t0 = performance.now();
    await sleep(ms);
    const seconds = (performance.now() - t0) / 1000;
    const mips: Record<string, number> = {};
    let joules = 0;
    for (const [role, pid] of a.roles) {
        const x = from.get(role)!, y = spent(pid);
        mips[role] = Math.round((y.instructions - x.instructions) / 1e6 / seconds);
        joules += (y.energy - x.energy) / 1e9;
    }
    return { mips, total: Object.values(mips).reduce((x, y) => x + y, 0), joules: Math.round(joules * 10) / 10 };
}
/** Long frames since the last time this was asked. */
const longFrames = async (a: App) => {
    const xs = (await a.js(`__heavy.loaf.splice(0)`)) as number[];
    return { over50: xs.length, longest: xs.length ? Math.max(...xs) : 0 };
};

/** The gits the app has run since `from`: how many, how long in all, and which took longest. */
function gits(from: number) {
    const text = existsSync(gitLog) ? readFileSync(gitLog, "utf8") : "";
    let spawns = 0, ms = 0;
    const top: Record<string, number> = {};
    for (const line of text.slice(from).split("\n")) {
        const m = /^([\d.]+) (.*)$/.exec(line);
        if (!m) continue;
        spawns++;
        const took = Number(m[1]) * 1000;
        ms += took;
        // What it was, without `-c name=value`.
        const name = m[2]!.replace(/-c \S+ /g, "").split(" ").filter((x) => !x.startsWith("-")).slice(0, 2).join(" ");
        top[name] = Math.round((top[name] ?? 0) + took);
    }
    return { to: text.length, spawns, ms: Math.round(ms), top: Object.fromEntries(Object.entries(top).sort((x, y) => y[1] - x[1]).slice(0, 6)) };
}

/** The demo's small project, with enough added to be a large repository: each a small file, all committed. */
function largeRepo() {
    const t0 = performance.now();
    if (!existsSync(join(project, ".git"))) createDemoProject(project, { git: true });
    for (let i = 0; i < FILES; i++) {
        const f = join(project, `packages/p${i % 200}/src/m${i % 50}/f${i}.ts`);
        if (i < 10_000) mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, `export const value${i} = ${i};\n`);
    }
    Bun.spawnSync(["git", "add", "-A"], { cwd: project });
    Bun.spawnSync(["git", "-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "-qm", "a large repository"], { cwd: project });
    report.repoSeconds = Math.round((performance.now() - t0) / 1000);
    save();
}

try {
    for (let i = 0; ; i++) { if (await fetch("http://127.0.0.1:4649/healthz").then((r) => r.ok, () => false)) break; if (i > 120) throw new Error("demo"); await sleep(500); }
    // Nothing stops to ask: a session waiting on a person isn't heavy use. The mock's commands only print.
    const settings = join(dir, "home", "settings.json");
    writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), permissions: { allow: ["Bash", "Edit", "Write"] } }, null, 2));
    let a = await launch();

    if (parts.includes("git")) {
        // Before the repository grows: the same turns in the small one, to set beside the large.
        const per = async () => {
            const id = await create(a);
            const one = async () => {
                const from = spent(a.serverPid).instructions, t0 = performance.now();
                await turn(a, id, "fastdemo burst short");
                const turnMs = performance.now() - t0;
                await sleep(2000);
                return { turnMs: Math.round(turnMs), serverG: Math.round((spent(a.serverPid).instructions - from) / 1e7) / 100 };
            };
            // What a new session pays once, then what each turn costs: the first few can still be catching up.
            const first = await one();
            let at = gits(0).to;
            const each = [];
            for (let i = 0; i < 8; i++) { const w = await one(); const g = gits(at); at = g.to; each.push({ ...g, ...w }); }
            const settled = each.slice(-5);
            return { first, turns: each.map((x) => ({ turnMs: x.turnMs, serverG: x.serverG })), turnMs: median(settled.map((g) => g.turnMs)), serverG: median(settled.map((g) => g.serverG)), spawnsPerTurn: median(settled.map((g) => g.spawns)), msPerTurn: median(settled.map((g) => g.ms)), top: settled.at(-1)!.top };
        };
        const small = await per();
        await quit(a);
        largeRepo();
        a = await launch();
        const large = await per();
        report.git = { small, large };
        save();
    } else if (parts.includes("soak") || parts.includes("many")) largeRepo();

    if (parts.includes("open")) {
        const large = await create(a);
        const other = await create(a);
        const t0 = performance.now();
        // A long history with big tool output, as a long day's session has.
        for (let i = 0; i < LARGE_TURNS; i++) await turn(a, large, `perfbig ${LARGE_KB} (part ${i + 1})`);
        for (let i = 0; i < 5; i++) await turn(a, other, "fastdemo burst short");
        const stored = Bun.spawnSync(["du", "-sk", join(dir, "home", "projects")]).stdout.toString();
        report.open = { seedSeconds: Math.round((performance.now() - t0) / 1000), storedMB: Math.round(Number(stored.split("\t")[0]) / 1024) };
        save();
        await quit(a);

        // Cold, the way it's opened the morning after.
        a = await launch();
        await sleep(3000);
        const before = footprint();
        const firstMs = await open(a, large);
        await sleep(3000);
        const after = footprint();
        const switches: number[] = [];
        for (let i = 0; i < 5; i++) {
            await open(a, other);
            await sleep(1500);
            switches.push(await open(a, large));
            await sleep(1500);
        }
        await sleep(3000);
        Object.assign(report.open, { firstMs, switchBackMs: median(switches), switches, before, after, heapMB: await heapMB(a), nodes: await domNodes(a), frames: await longFrames(a), crashed: a.crashed() });
        save();
    }

    if (parts.includes("many")) {
        const ids: string[] = [];
        for (let i = 0; i < SESSIONS + 1; i++) { const id = await create(a); await turn(a, id, "fastdemo burst short"); ids.push(id); }
        const quiet = ids.pop()!;
        // A reply at a real model's pace, long enough to outlast the stretch measured.
        const stream = "perfreply 40000 10 33";
        const measure = async (sending: string[], shown: string) => {
            await open(a, shown);
            await sleep(5000);
            await Promise.all(sending.map((id) => a.rpc.call("session.send", { id, text: stream })));
            await sleep(5000);
            await longFrames(a);
            const s = await stretch(a, 40_000);
            const frames = await longFrames(a);
            const memory = footprint();
            await Promise.all(sending.map((id) => a.rpc.call("session.interrupt", { id })));
            await sleep(3000);
            return { ...s, frames, memory };
        };
        const waiting = async (shown: string) => {
            await open(a, shown);
            await Promise.all(ids.map((id) => a.rpc.call("session.send", { id, text: "hangforever" })));
            await sleep(8000);
            const s = await stretch(a, 30_000);
            await Promise.all(ids.map((id) => a.rpc.call("session.interrupt", { id })));
            await sleep(3000);
            return s;
        };
        report.many = {
            // One on screen, with nothing else running; the same with the rest running out of sight; and only those.
            one: await measure([ids[0]!], ids[0]!),
            all: await measure(ids, ids[0]!),
            hiddenOnly: await measure(ids, quiet),
            allWaiting: await waiting(ids[0]!),
            crashed: a.crashed(),
        };
        save();
    }

    if (parts.includes("soak")) {
        const ids: string[] = [];
        for (let i = 0; i < SESSIONS; i++) ids.push(await create(a));
        const mix = ["fastdemo 20000 (part)", "demo", "cmdrows", "perfreply 8000 20 33", `perfbig ${LARGE_KB}`, "fastdemo burst short"];
        const until = Date.now() + HOURS * 3_600_000;
        let turns = 0, failed = 0;
        // Each works on as a person's sessions do: one turn after another, a moment between.
        const worker = async (id: string, n: number) => {
            for (let i = n; Date.now() < until; i++) {
                try { await turn(a, id, mix[i % mix.length]!); turns++; } catch { failed++; }
                await sleep(2000);
            }
        };
        const workers = ids.map((id, n) => worker(id, n));
        const checkpoints: any[] = [];
        report.soak = { checkpoints };
        const started = Date.now();
        // Every session has a turn to show by now.
        await sleep(60_000);
        for (let k = 0; Date.now() < until && !a.crashed(); k++) {
            // A person looks from one to another.
            const openMs = await open(a, ids[k % ids.length]!);
            const s = await stretch(a, 30_000);
            checkpoints.push({ minutes: Math.round((Date.now() - started) / 60_000), turns, failed, openMs, ...s, frames: await longFrames(a), memory: footprint(), heapMB: await heapMB(a), nodes: await domNodes(a), serverFiles: openFiles(a.serverPid) });
            report.soak.crashed = a.crashed();
            save();
            await sleep(Math.max(0, Math.min(270_000, until - Date.now())));
        }
        if (a.crashed()) report.soak.crashed = true;
        else await Promise.all(workers);
        report.soak.turns = turns;
        report.soak.failed = failed;
        const first = checkpoints[0], last = checkpoints.at(-1);
        if (first && last) report.soak.growthMBPerHour = Math.round((last.memory.total - first.memory.total) / Math.max(0.01, (last.minutes - first.minutes) / 60));
        save();
        // History kept, or a leak? With its sessions closed, what's left is what doesn't go.
        if (!a.crashed()) {
            // Second by second as it goes quiet: does anything come back?
            report.soak.quiet = [];
            for (let k = 0; k < 9; k++) { await sleep(10_000); report.soak.quiet.push(footprint().byKind.server); }
            report.soak.settled = { memory: footprint(), heapMB: await heapMB(a) };
            for (const id of ids) await a.rpc.call("session.close", { id });
            await a.js(`(() => { sessionStorage.removeItem('cavvy.navigation'); location.reload(); })()`);
            await sleep(120_000);
            report.soak.closed = { memory: footprint(), heapMB: await heapMB(a), serverFiles: openFiles(a.serverPid) };
            save();
        }
    }
    await quit(a);
} catch (e) {
    report.error = String((e as Error)?.stack ?? e);
    save();
    console.error(report.error);
} finally {
    // Before its folder goes: an app left running keeps writing there.
    if (running) { running.kill("SIGTERM"); await Promise.race([running.exited, sleep(10_000)]); running.kill("SIGKILL"); }
    demo.kill();
    await sleep(500);
    rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 1));
process.exit(report.error ? 1 : 0);
