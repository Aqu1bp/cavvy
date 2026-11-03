// A heavy user's day, compressed, on a packaged app with real models (bench-heavy.ts does heavy use on the mock model): N sessions started together, each in a scratch
// clone of its own, working the way people do (searching and reading code, running a test file, editing, looking at
// the diff, undoing it), the next prompt sent whenever a session is idle, for --minutes. Through it: CPU and memory by
// process every 2 s; how long the server takes to answer the window every 10 s; every 30 s a frame trace, and another
// session put on screen (the others go on hidden). At the end: what each session did, every turn that didn't finish,
// every question asked (denied), notices about limits. The app runs on its own: a fresh CAVVY_HOME and Electron
// profile, its own server, quit by its own PID at the end. The real HOME stays, so the CLIs use the login they have.
// Writes bench-results/bench-heavy-real-<label>.json.
//
//   bun desktop-electron/bench-heavy-real.ts --app <…>/Cavvy.app --repo <scratch clone> --label new --models <ref>[,<ref>…] [--sessions 10] [--minutes 15] [--mode auto]
//
// Every change a session makes is to its own clone, under a temporary folder; nothing else is written.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const label = arg("--label") ?? "run";
const appPath = arg("--app");
const repo = arg("--repo");
if (!appPath || !repo) throw new Error("usage: bench-heavy-real.ts --app <Cavvy.app> --repo <scratch repository> --models ref[,ref…] [--sessions 10] [--minutes 15] [--label x] [--mode auto]");
const N = Number(arg("--sessions") ?? 10);
const RUN_MS = Number(arg("--minutes") ?? 15) * 60_000;
const CAP_MS = RUN_MS + 6 * 60_000;
const PORT = 9348;
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cavvy-heavy-"));
const metricsFile = join(dir, "metrics.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report: Record<string, any> = { label, app: appPath, at: new Date().toISOString(), sessionsAsked: N, samples: [], checkpoints: [], lagMs: [] };

/** What a session asks for, in turn (then again from the start): its own clone's code, its tests, an edit and its undoing. */
const TOPICS = ["how secrets are redacted", "how a session's timeline ops are applied", "how turn snapshots are captured", "how the sidebar lists sessions", "how permissions are decided for a tool call", "how a CLI's output becomes session events", "how search reads session files", "how the composer sends a message"];
const TESTS = ["test/secret-redaction.test.ts", "test/gui-palette-order.test.ts"];
const FILES = ["src/util/redact.ts", "src/server/timeline.ts", "src/server/coalesce.ts", "src/util/pace.ts"];
const chain = (i: number) => {
    const topic = TOPICS[i % TOPICS.length]!, test = TESTS[i % TESTS.length]!, file = FILES[i % FILES.length]!;
    return [
        `Find where ${topic} is implemented in this repository (search for it), read the main file, and explain how it works in a few paragraphs.`,
        `Run \`bun test ./${test}\` and tell me in two sentences what it checks and whether it passed.`,
        `Add a one-line comment at the top of ${file} saying what the file is for, then show me \`git diff --stat\`.`,
        `Undo that change with \`git checkout -- ${file}\` and confirm \`git status --short\` shows nothing.`,
        "Search this repository for TODO and FIXME comments and list the five that matter most, with file and line.",
    ];
};

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

async function rpcTo(port: number, token: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["cavvy.v1", `auth.${token}`]);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0;
    const pending = new Map<number, (v: any) => void>();
    ws.onmessage = (e) => { const x = JSON.parse(String(e.data)); if (x.id) { pending.get(x.id)?.(x); pending.delete(x.id); } };
    const call = (method: string, params: unknown, ms = 60_000) => new Promise<any>((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.delete(id)) r({ error: "timeout" }); }, ms); });
    return { ws, call };
}

function cpuTimes(pids: number[]): Map<number, number> {
    const out = new Map<number, number>();
    for (const line of Bun.spawnSync(["ps", "-o", "pid=,time=", "-p", pids.join(",")]).stdout.toString().trim().split("\n")) {
        const [pid, t] = line.trim().split(/\s+/);
        if (pid && t) out.set(Number(pid), t.split(":").map(Number).reduce((a, x) => a * 60 + x, 0));
    }
    return out;
}

function rss(roles: [number, string][]): Record<string, number> {
    const kb = new Map(Bun.spawnSync(["ps", "-o", "pid=,rss=", "-p", roles.map(([p]) => p).join(",")]).stdout.toString().trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number) as [number, number]));
    const out: Record<string, number> = {};
    for (const [pid, role] of roles) if (role !== "WindowServer") out[role] = (out[role] ?? 0) + Math.round((kb.get(pid) ?? 0) / 1024);
    return out;
}

/** The app's processes by role (from its metrics file), its server, WindowServer, and the CLIs and their tools under the server. */
async function roleMap(serverPid: number): Promise<Map<number, string>> {
    const m = (await Bun.file(metricsFile).json().catch(() => undefined)) as { procs: { pid: number; role: string }[] } | undefined;
    const roles = new Map<number, string>((m?.procs ?? []).map((p) => [p.pid, p.role]));
    if (serverPid) roles.set(serverPid, "server");
    const ws = Bun.spawnSync(["pgrep", "-x", "WindowServer"]).stdout.toString().trim();
    if (ws) roles.set(Number(ws), "WindowServer");
    // Everything under the server: the agent CLIs ("cli"), what they run ("tools"), the server's own git ("helpers").
    const table = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,comm="]).stdout.toString().trim().split("\n").map((l) => { const [pid, ppid, ...c] = l.trim().split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), comm: c.join(" ") }; });
    const kids = new Map<number, typeof table>();
    for (const p of table) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)!).push(p);
    const walk = (pid: number, role: string) => { for (const k of kids.get(pid) ?? []) { const r = role === "server" ? (/claude|codex/.test(k.comm) ? "cli" : "helpers") : "tools"; roles.set(k.pid, r); walk(k.pid, r); } };
    if (serverPid) walk(serverPid, "server");
    return roles;
}

let mainPid = 0;
let serverPid = 0;
try {
    // ---- A clone for each session, with what its tests need.
    const clones: string[] = [];
    for (let i = 0; i < N; i++) {
        const c = join(dir, `s${i}`);
        const r = Bun.spawnSync(["git", "clone", "--quiet", "--local", repo, c]);
        if (r.exitCode) throw new Error(`clone ${i}: ${r.stderr.toString().slice(0, 200)}`);
        clones.push(c);
    }
    await Promise.all(clones.map((c) => Bun.spawn(["bun", "install", "--silent"], { cwd: c, stdout: "ignore", stderr: "ignore" }).exited));
    report.clonesAt = dir;

    // ---- The app, on its own (directly, not with `open`).
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CAVVY|ANTHROPIC|ELECTRON_RUN_AS_NODE)/.test(k)));
    mainPid = Bun.spawn([join(appPath, "Contents/MacOS/cavvy-desktop"), "--disable-backgrounding-occluded-windows"], { cwd: clones[0], env: { ...clean, CAVVY_HOME: join(dir, "home"), CAVVY_ELECTRON_USER_DATA: join(dir, "electron-data"), CAVVY_NO_KEYCHAIN: "1", CAVVY_ELECTRON_TEST_PORT: String(PORT), CAVVY_ELECTRON_METRICS: metricsFile, CAVVY_ELECTRON_CWD: clones[0] }, stdout: "ignore", stderr: "ignore" }).pid;
    let server: { pid?: number; port?: number; token?: string } = {};
    for (let i = 0; !server.token; i++) {
        const m = (await Bun.file(metricsFile).json().catch(() => ({}))) as { server?: typeof server };
        server = m.server ?? {};
        if (i > 600) throw new Error("the app's server didn't start");
        if (!server.token) await sleep(100);
    }
    serverPid = server.pid ?? 0;
    let gui: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; !gui; i++) {
        gui = ((await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json(), () => [])) as { url: string; webSocketDebuggerUrl: string }[]).find((t) => t.url.startsWith("cavvy://app"));
        if (!gui) { if (i > 3000) throw new Error("no window"); await sleep(10); }
    }
    const page = await connect(gui.webSocketDebuggerUrl);
    const js = async (expression: string) => (await page.cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 30_000)).result?.result?.value;
    const rpc = await rpcTo(server.port!, server.token!);

    const connected = await rpc.call("providers.connectCli", { provider: "claude-code" }, 120_000);
    report.connectCli = connected.error ? String(connected.error?.message ?? connected.error) : "ok";
    const models = ((await rpc.call("models.list", { refresh: true }, 120_000)).result ?? []) as { provider: string; models: { ref: string }[] }[];
    const refs = (arg("--models") ?? "").split(",").filter(Boolean);
    const offered = (ref: string) => models.some((p) => p.models.some((m) => m.ref === ref));
    if (!refs.length || !refs.every(offered)) throw new Error(`models ${refs.join(",")} aren't all offered: ${JSON.stringify(models.map((p) => p.models.map((m) => m.ref)))}`);
    const mode = arg("--mode") ?? "auto";

    // ---- The sessions, each in its clone, models in turn.
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
        await rpc.call("projects.trust", { path: clones[i], trust: true });
        const created = await rpc.call("session.create", { cwd: clones[i], model: refs[i % refs.length], mode });
        if (created.error) throw new Error(`session ${i}: ${JSON.stringify(created.error)}`);
        ids.push(created.result.state.id);
    }
    Object.assign(report, { models: refs, mode, sessions: ids.length });
    const summary = async () => (((await rpc.call("sessions.list", { limit: 200 })).result ?? []) as { id: string; status: string }[]).filter((s) => ids.includes(s.id));

    // ---- Putting a session on screen, as a click on its row.
    const show = async (id: string) => {
        const row = `document.querySelector('[data-session-row="${id}"] .slim-hit, [data-session-row="${id}"] .card-hit, [data-session-id="${id}"] .slim-hit, [data-session-id="${id}"] .card-hit')`;
        for (let i = 0; i < 50 && !(await js(`!!${row}`)); i++) await sleep(100);
        await js(`${row}?.scrollIntoView({ block: "center" })`);
        const at = await js(`(() => { const el = ${row}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 14) }; })()`);
        if (at) for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await page.cdp("Input.dispatchMouseEvent", { type, ...at, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        return !!at;
    };

    // ---- All of them at once, the first on screen.
    const chains = ids.map((_, i) => chain(i));
    const sent = ids.map(() => 0);
    const send = async (i: number) => {
        const text = chains[i]![sent[i]! % chains[i]!.length]!;
        sent[i]!++;
        const r = await rpc.call("session.send", { id: ids[i], text });
        if (r.error) (report.sendErrors ??= []).push(`${i}: ${JSON.stringify(r.error).slice(0, 200)}`);
    };
    await Promise.all(ids.map((_, i) => send(i)));
    await show(ids[0]!);
    let onScreen = 0;

    const t0 = performance.now();
    let roles = await roleMap(serverPid);
    const c0 = cpuTimes([...roles.keys()]);
    let last = c0, lastT = t0, lastCheckpoint = t0, lastLag = t0;
    const denied: string[] = [];
    const errored = new Set<string>();
    for (;;) {
        await sleep(2000);
        roles = await roleMap(serverPid);
        const now = performance.now();
        const c = cpuTimes([...roles.keys()]);
        const by: Record<string, number> = {};
        for (const [pid, role] of roles) by[role] = (by[role] ?? 0) + Math.max(0, (c.get(pid) ?? 0) - (last.get(pid) ?? 0));
        const w = (now - lastT) / 1000;
        const sessions = await summary();
        for (const s of sessions) if (s.status === "error") errored.add(s.id);
        report.samples.push({ t: Math.round((now - t0) / 1000), cpu: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Math.round((v / w) * 1000) / 10])), rss: rss([...roles]), running: sessions.filter((s) => s.status === "running" || s.status === "waiting").length });
        last = c;
        lastT = now;
        // A question no one's there to answer: no (a heavy user wouldn't be watching every session).
        for (const s of sessions.filter((x) => x.status === "waiting")) {
            const st = (await rpc.call("session.open", { id: s.id })).result?.state;
            for (const ask of st?.interactions ?? []) {
                denied.push(`${ask.kind}:${ask.toolName ?? ask.title ?? ""}`.slice(0, 120));
                const response = ask.kind === "permission" ? { kind: "permission", choice: ask.options.find((o: { id: string }) => o.id === "no")?.id ?? "no" } : ask.kind === "plan" ? { kind: "plan", approved: false } : ask.kind === "question" ? { kind: "question" } : { kind: "secret" };
                await rpc.call("session.respond", { id: s.id, interactionId: ask.id, response }).catch(() => {});
            }
        }
        // How long the window's requests wait behind everything else the server does.
        if (now - lastLag >= 10_000) {
            lastLag = now;
            const t = performance.now();
            await rpc.call("terminal.list", {}, 30_000);
            report.lagMs.push(Math.round(performance.now() - t));
        }
        if (now - lastCheckpoint >= 30_000) {
            lastCheckpoint = now;
            // Another session on screen: the one before goes on hidden.
            onScreen = (onScreen + 1) % ids.length;
            const shown = await show(ids[onScreen]!);
            const events: any[] = [];
            page.listeners.set("Tracing.dataCollected", (p) => events.push(...p.value));
            const ended = new Promise((r) => page.listeners.set("Tracing.tracingComplete", r));
            await page.cdp("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink", "cc", "viz", "__metadata"] } });
            await sleep(3000);
            await page.cdp("Tracing.end");
            await Promise.race([ended, sleep(15000)]);
            const threads = new Map<string, string>();
            for (const e of events) if (e.ph === "M" && e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, e.args?.name);
            const count = (name: string, thread: string) => events.filter((e) => e.name === name && (e.ph === "X" || e.ph === "B") && threads.get(`${e.pid}:${e.tid}`) === thread).length;
            // Main-thread tasks over 50 ms in the 3 s: what a reader would feel as a stall.
            const long = events.filter((e) => e.ph === "X" && e.name === "RunTask" && threads.get(`${e.pid}:${e.tid}`) === "CrRendererMain" && e.dur > 50_000).map((e) => Math.round(e.dur / 1000));
            report.checkpoints.push({
                t: Math.round((now - t0) / 1000),
                shown: shown ? onScreen : null,
                mainFramesPerSecond: Math.round(count("LocalFrameView::RunPrePaintLifecyclePhase", "CrRendererMain") / 3),
                framesPerSecond: Math.round(count("LayerTreeImpl::UpdateDrawProperties", "Compositor") / 3),
                longTasksMs: long,
                animations: await js(`document.getAnimations().length`),
                nodes: await js(`document.getElementsByTagName('*').length`),
                running: sessions.filter((x) => x.status === "running" || x.status === "waiting").length,
            });
        }
        let followedUp = false;
        if (now - t0 < RUN_MS) for (const s of sessions) {
            const i = ids.indexOf(s.id);
            if (s.status === "running" || s.status === "waiting") continue;
            await send(i);
            followedUp = true;
        }
        const done = !followedUp && sessions.length === ids.length && sessions.every((s) => s.status !== "running" && s.status !== "waiting") && now - t0 >= RUN_MS;
        if (done || now - t0 > CAP_MS) {
            if (!done) {
                report.capped = true;
                for (const id of ids) await rpc.call("session.interrupt", { id }).catch(() => {});
            }
            break;
        }
    }
    const wall = (performance.now() - t0) / 1000;
    const c1 = cpuTimes([...roles.keys()]);
    const cpuSeconds: Record<string, number> = {};
    for (const [pid, role] of roles) cpuSeconds[role] = Math.round(((cpuSeconds[role] ?? 0) + Math.max(0, (c1.get(pid) ?? 0) - (c0.get(pid) ?? 0))) * 10) / 10;
    report.wallSeconds = Math.round(wall);
    report.cpuSeconds = cpuSeconds;
    report.cpuPercentMean = Object.fromEntries(Object.entries(cpuSeconds).map(([k, v]) => [k, Math.round((v / wall) * 1000) / 10]));
    report.denied = denied;
    report.prompts = sent;
    report.erroredSessions = [...errored];
    const lags = [...report.lagMs].sort((a: number, b: number) => a - b);
    report.lagMsMedianP90Max = [lags[Math.floor(lags.length / 2)], lags[Math.floor(lags.length * 0.9)], lags.at(-1)];
    // What each did: turns, tools, what didn't finish, notices about limits, and whether every prompt is there.
    report.turns = [];
    for (const [i, id] of ids.entries()) {
        const snap = (await rpc.call("session.open", { id })).result;
        const turns: any[] = snap?.turns ?? [];
        const blocks = turns.flatMap((t: any) => t.blocks ?? []);
        report.turns.push({
            i, id, model: snap?.state?.model, status: snap?.state?.status, sent: sent[i], turns: turns.length,
            prompts: turns.filter((t: any) => t.prompt).length,
            unfinished: turns.filter((t: any) => t.status !== "done").map((t: any) => t.status),
            tools: blocks.filter((b: any) => b.t === "tool").length,
            toolErrors: blocks.filter((b: any) => b.t === "tool" && b.status === "error").length,
            toolsDenied: blocks.filter((b: any) => b.t === "tool" && b.status === "denied").length,
            limitNotices: blocks.filter((b: any) => (b.t === "notice" || b.t === "error") && /limit|rate|overload|429|529/i.test(String(b.text ?? b.message ?? ""))).map((b: any) => String(b.text ?? b.message).slice(0, 120)),
            textChars: blocks.filter((b: any) => b.t === "text").reduce((a: number, b: any) => a + (b.text?.length ?? 0), 0),
        });
        await rpc.call("session.close", { id }).catch(() => {});
    }
    await sleep(5000);
    report.rssEndMB = rss([...(await roleMap(serverPid))]);
    rpc.ws.close();
    page.ws.close();
} catch (e) {
    report.error = String((e as Error)?.message ?? e);
} finally {
    // Only this instance: its main process, then its server if it outlived it.
    if (mainPid) { try { process.kill(mainPid, "SIGTERM"); } catch {} }
    await sleep(4000);
    for (const pid of [mainPid, serverPid]) {
        if (!pid) continue;
        try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
    }
    mkdirSync(join(import.meta.dir, "bench-results"), { recursive: true });
    await Bun.write(join(import.meta.dir, "bench-results", `bench-heavy-real-${label}.json`), JSON.stringify(report, null, 1));
    const { samples: _s, ...brief } = report;
    console.log(JSON.stringify(brief, null, 1));
    process.exit(0);
}
