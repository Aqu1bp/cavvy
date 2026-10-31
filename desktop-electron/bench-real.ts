// What a packaged app costs with real models: three sessions started together on a read-and-explain task (in --mode,
// the default one unless set; any permission question denied) in a scratch copy of a repository, CPU and memory by process sampled through the whole
// run, with the page's frames and animations now and then, and how much text streamed. The app runs on its own: a
// fresh CAVVY_HOME and Electron profile, its own server, quit by its own PID at the end. The real HOME stays, so the
// CLIs use the login they already have. Writes bench-results/bench-real-<label>.json.
//
//   bun desktop-electron/bench-real.ts --app <…>/Cavvy.app --repo <scratch clone> --label main --models <ref>,<ref>,<ref> [--mode auto] [--effort medium]
//   bun desktop-electron/bench-real.ts --app <…>/Cavvy.app --repo <scratch clone> --probe     the models it offers, then quits

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const label = arg("--label") ?? "run";
const appPath = arg("--app");
const repo = arg("--repo");
if (!appPath || !repo) throw new Error("usage: bench-real.ts --app <Cavvy.app> --repo <scratch repository> [--label x] --models ref,ref,ref [--mode auto] [--probe]");
/** Follow-ups are sent for this long; then the turns running finish (up to CAP_MS in all). */
const RUN_MS = Number(arg("--minutes") ?? 6) * 60_000;
const CAP_MS = RUN_MS + 4 * 60_000;
const PORT = 9347;
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cavvy-real-"));
const metricsFile = join(dir, "metrics.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report: Record<string, any> = { label, app: appPath, at: new Date().toISOString(), samples: [], checkpoints: [] };

const ONLY = " Only read and explain: don't change, create or run anything.";
/** Each session's tasks, in order: the next is sent whenever it's idle, until the run's time is up. */
const CHAINS = [
    [
        "Read src/server/engine.ts, src/server/runtime.ts and src/server/timeline.ts. Explain in detail how a session's events become ops and how those ops reach the GUI over the WebSocket, quoting the relevant functions at length.",
        "Now read src/server/server.ts and gui/src/state/app.ts. Explain in detail how the GUI receives, batches and applies those ops, quoting the relevant functions at length.",
        "Read src/server/history.ts. Explain in detail how a reopened session's timeline is rebuilt from its files, quoting the relevant functions at length.",
        "Read src/agent/session.ts. Explain in detail how messages are stored, saved and compacted, quoting the relevant functions at length.",
    ],
    [
        "Read gui/src/components/Transcript.tsx, gui/src/lib/reveal.ts and gui/src/lib/stream-dom.ts. Explain in detail how streamed text is let out on screen and how the transcript follows the end while a turn runs, quoting the relevant code at length.",
        "Read gui/src/lib/markdown.ts. Explain in detail how Markdown is rendered incrementally while a reply streams, quoting the relevant code at length.",
        "Read gui/src/lib/work-rendering.ts and gui/src/lib/live-line.ts. Explain in detail what each does and why, quoting the relevant code at length.",
        "Read gui/src/components/Sidebar.tsx. Explain in detail how session rows update, reorder and animate, quoting the relevant code at length.",
    ],
    [
        "Read src/tools/bash.ts and src/server/history.ts. Explain in detail how a command's output is read while it runs and how a session's history is written and replayed, quoting the relevant functions at length.",
        "Read src/providers/sse.ts and src/util/redact.ts. Explain in detail how a provider's stream is parsed and how secrets are redacted from it, quoting the relevant functions at length.",
        "Read the first 600 lines of src/backends/claude-code.ts. Explain in detail how a CLI's output becomes a session's events, quoting the relevant code at length.",
        "Read the files in src/permissions. Explain in detail how a permission decision is made for a tool call, quoting the relevant code at length.",
    ],
];

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

function footprint(roles: [number, string][]): Record<string, number> {
    const want = roles.filter(([, role]) => role !== "WindowServer" && !role.startsWith("utility:tracing"));
    const bytes = new Map<number, number>();
    for (const m of Bun.spawnSync(["footprint", "-f", "bytes", ...want.flatMap(([p]) => ["-p", String(p)])]).stdout.toString().matchAll(/\[(\d+)\]:.*?Footprint: (\d+) B/g)) bytes.set(Number(m[1]), Number(m[2]));
    const out: Record<string, number> = {};
    for (const [pid, role] of want) out[role] = (out[role] ?? 0) + Math.round((bytes.get(pid) ?? 0) / 1048576);
    return out;
}

let mainPid = 0;
let serverPid = 0;
try {
    // ---- The app, on its own.
    // Directly, not with `open`: macOS then counts it as part of whoever started it, and asks nothing new. An `open`ed test
    // build is its own app under the same bundle id as the installed one, and each one's Allow undoes the other's.
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CAVVY|ANTHROPIC|ELECTRON_RUN_AS_NODE)/.test(k)));
    Bun.spawn([join(appPath, "Contents/MacOS/cavvy-desktop"), "--disable-backgrounding-occluded-windows"], { cwd: repo, env: { ...clean, CAVVY_HOME: join(dir, "home"), CAVVY_ELECTRON_USER_DATA: join(dir, "electron-data"), CAVVY_NO_KEYCHAIN: "1", CAVVY_ELECTRON_TEST_PORT: String(PORT), CAVVY_ELECTRON_METRICS: metricsFile, CAVVY_ELECTRON_CWD: repo }, stdout: "ignore", stderr: "ignore" });
    let server: { pid?: number; port?: number; token?: string } = {};
    for (let i = 0; !server.token; i++) {
        const m = (await Bun.file(metricsFile).json().catch(() => ({}))) as { server?: typeof server; procs?: { pid: number; role: string }[] };
        server = m.server ?? {};
        mainPid = m.procs?.find((p) => p.role === "main")?.pid ?? mainPid;
        if (i > 600) throw new Error("the app's server didn't start");
        if (!server.token) await sleep(100);
    }
    serverPid = server.pid ?? 0;
    report.pids = { main: mainPid, server: serverPid };
    let gui: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; !gui; i++) {
        gui = ((await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json(), () => [])) as { url: string; webSocketDebuggerUrl: string }[]).find((t) => t.url.startsWith("cavvy://app"));
        if (!gui) { if (i > 3000) throw new Error("no window"); await sleep(10); }
    }
    const page = await connect(gui.webSocketDebuggerUrl);
    const js = async (expression: string) => (await page.cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 30_000)).result?.result?.value;
    const rpc = await rpcTo(server.port!, server.token!);

    // ---- What it offers: Claude Code turned on in this fresh home (its own sign-in, as the CLI has it).
    report.connectCli = {};
    for (const provider of ["claude-code", "codex"]) {
        const connected = await rpc.call("providers.connectCli", { provider }, 120_000);
        report.connectCli[provider] = connected.error ? String(connected.error?.message ?? connected.error) : "ok";
    }
    const models = ((await rpc.call("models.list", { refresh: true }, 120_000)).result ?? []) as { provider: string; providerName: string; status: string; models: { ref: string; id: string }[] }[];
    report.providers = models.map((p) => ({ provider: p.provider, status: p.status, models: p.models.map((m) => m.ref) }));
    report.aliases = models.flatMap((p) => p.models).filter((m) => /:(sonnet|haiku|default)$/.test(m.ref));
    if (args.includes("--probe")) throw new Error("probe only");
    // One model per session (the last repeats).
    const refs = (arg("--models") ?? "").split(",").filter(Boolean);
    const offered = (ref: string) => models.some((p) => p.models.some((m) => m.ref === ref));
    if (!refs.length || !refs.every(offered)) throw new Error(`models ${refs.join(",")} aren't all offered: ${JSON.stringify(report.providers)}`);
    const mode = arg("--mode") ?? "default";

    // ---- Three sessions in the scratch copy.
    await rpc.call("projects.trust", { path: repo, trust: true });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await rpc.call("session.create", { cwd: repo, model: refs[Math.min(i, refs.length - 1)], mode })).result.state.id);
    if (arg("--effort")) for (const id of ids) await rpc.call("session.setEffort", { id, effort: arg("--effort") });
    report.models = refs;
    report.mode = mode;
    report.effort = arg("--effort");
    report.sessions = ids;
    const summary = async () => (((await rpc.call("sessions.list", { limit: 50 })).result ?? []) as { id: string; status: string; waitingKind?: string }[]).filter((s) => ids.includes(s.id));

    // Bytes and streamed characters the page receives, by session.
    await page.cdp("Network.enable");
    const streamed: Record<string, number> = {};
    let wsBytes = 0;
    page.listeners.set("Network.webSocketFrameReceived", (p) => {
        const data: string = p.response?.payloadData ?? "";
        wsBytes += data.length;
        if (!data.includes('"session.ops"')) return;
        try {
            const m = JSON.parse(data);
            const ev = m.event ?? m;
            for (const op of ev.ops ?? []) if (op.op === "append" || op.op === "agent.append") streamed[ev.sessionId] = (streamed[ev.sessionId] ?? 0) + String(op.text ?? "").length;
        } catch {}
    });

    // ---- Start them together, the first on screen.
    const pids = async () => {
        const m = (await Bun.file(metricsFile).json().catch(() => undefined)) as { procs: { pid: number; role: string }[] } | undefined;
        const roles = new Map<number, string>((m?.procs ?? []).map((p) => [p.pid, p.role]));
        if (serverPid) roles.set(serverPid, "server");
        const ws = Bun.spawnSync(["pgrep", "-x", "WindowServer"]).stdout.toString().trim();
        if (ws) roles.set(Number(ws), "WindowServer");
        return roles;
    };
    const sent = ids.map(() => 1);
    await Promise.all(ids.map((id, i) => rpc.call("session.send", { id, text: CHAINS[i]![0]! + ONLY })));
    const row = `document.querySelector('[data-session-row="${ids[0]}"] .slim-hit, [data-session-row="${ids[0]}"] .card-hit, [data-session-id="${ids[0]}"] .slim-hit')`;
    for (let i = 0; i < 100 && !(await js(`!!${row}`)); i++) await sleep(100);
    const at = await js(`(() => { const el = ${row}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 14) }; })()`);
    if (at) for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await page.cdp("Input.dispatchMouseEvent", { type, ...at, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    await js(`(() => { window.__hidden = 0; document.addEventListener('visibilitychange', () => document.visibilityState !== 'visible' && __hidden++); })()`);

    // ---- Through the run: CPU and memory every 2 s; a 3 s trace, the animations and the footprint every 60 s;
    // permission questions denied (the prompts ask for nothing that needs one).
    const t0 = performance.now();
    let roles = await pids();
    const c0 = cpuTimes([...roles.keys()]);
    let last = c0, lastT = t0, lastCheckpoint = t0;
    const denied: string[] = [];
    for (;;) {
        await sleep(2000);
        roles = await pids();
        const now = performance.now();
        const c = cpuTimes([...roles.keys()]);
        const by: Record<string, number> = {};
        for (const [pid, role] of roles) by[role] = (by[role] ?? 0) + ((c.get(pid) ?? 0) - (last.get(pid) ?? 0));
        const w = (now - lastT) / 1000;
        const sessions = await summary();
        report.samples.push({ t: Math.round((now - t0) / 1000), cpu: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Math.round((v / w) * 1000) / 10])), rss: rss([...roles]), streamed: Object.values(streamed).reduce((a, b) => a + b, 0), running: sessions.filter((s) => s.status === "running" || s.status === "waiting").length });
        last = c;
        lastT = now;
        for (const s of sessions.filter((x) => x.status === "waiting")) {
            const st = (await rpc.call("session.open", { id: s.id })).result?.state;
            for (const ask of st?.interactions ?? []) {
                denied.push(`${ask.kind}:${ask.toolName ?? ask.title ?? ""}`.slice(0, 120));
                const response = ask.kind === "permission" ? { kind: "permission", choice: ask.options.find((o: { id: string }) => o.id === "no")?.id ?? "no" } : ask.kind === "plan" ? { kind: "plan", approved: false } : ask.kind === "question" ? { kind: "question" } : { kind: "secret" };
                await rpc.call("session.respond", { id: s.id, interactionId: ask.id, response }).catch(() => {});
            }
            await rpc.call("session.close", { id: s.id }).catch(() => {});
        }
        if (now - lastCheckpoint >= 30_000) {
            lastCheckpoint = now;
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
            report.checkpoints.push({
                t: Math.round((now - t0) / 1000),
                mainFramesPerSecond: Math.round(count("LocalFrameView::RunPrePaintLifecyclePhase", "CrRendererMain") / 3),
                framesPerSecond: Math.round(count("LayerTreeImpl::UpdateDrawProperties", "Compositor") / 3),
                styleLayoutPerSecond: Math.round(count("LocalFrameView::UpdateStyleAndLayout", "CrRendererMain") / 3),
                animations: await js(`document.getAnimations().length`),
                nodes: await js(`document.getElementsByTagName('*').length`),
                footprint: footprint([...roles]),
                visible: await js(`document.visibilityState`),
                running: sessions.filter((x) => x.status === "running" || x.status === "waiting").length,
            });
        }
        if (now - t0 < RUN_MS) for (const s of sessions) {
            const i = ids.indexOf(s.id);
            if (s.status === "running" || s.status === "waiting" || sent[i]! >= CHAINS[i]!.length) continue;
            await rpc.call("session.send", { id: s.id, text: CHAINS[i]![sent[i]!]! + ONLY });
            sent[i]!++;
        }
        const done = sessions.length === 3 && sessions.every((s) => s.status !== "running" && s.status !== "waiting") && (now - t0 >= RUN_MS || sent.every((n, i) => n >= CHAINS[i]!.length));
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
    for (const [pid, role] of roles) cpuSeconds[role] = Math.round(((cpuSeconds[role] ?? 0) + ((c1.get(pid) ?? 0) - (c0.get(pid) ?? 0))) * 10) / 10;
    // What all three produced, from their snapshots (the page hears only the sessions it has open): replies,
    // thinking and tool output.
    const produced: Record<string, number> = {};
    for (const id of ids) {
        const snap = (await rpc.call("session.open", { id })).result;
        const blocks = (snap?.turns ?? []).flatMap((t: any) => t.blocks ?? []);
        produced[id] = blocks.reduce((a: number, b: any) => a + String(b.text ?? "").length + String(b.output ?? "").length, 0);
        await rpc.call("session.close", { id }).catch(() => {});
    }
    report.producedChars = produced;
    const chars = Object.values(produced).reduce((a, b) => a + b, 0);
    report.wallSeconds = Math.round(wall);
    report.cpuSeconds = cpuSeconds;
    report.cpuPercentMean = Object.fromEntries(Object.entries(cpuSeconds).map(([k, v]) => [k, Math.round((v / wall) * 1000) / 10]));
    report.streamedChars = streamed;
    report.wsMB = Math.round(wsBytes / 1048576 * 10) / 10;
    const app = ["ui", "gpu", "main", "server"].reduce((a, k) => a + (cpuSeconds[k] ?? 0), 0);
    report.cpuSecondsPer1000Chars = Object.fromEntries([...["ui", "gpu", "main", "server"].map((k) => [k, Math.round(((cpuSeconds[k] ?? 0) / chars) * 1000 * 1000) / 1000]), ["app", Math.round((app / chars) * 1000 * 1000) / 1000]]);
    report.denied = denied;
    report.prompts = sent;
    report.hiddenTimes = await js(`window.__hidden`);
    // What each session did.
    report.turns = [];
    for (const id of ids) {
        const snap = (await rpc.call("session.open", { id })).result;
        const blocks = (snap?.turns ?? []).flatMap((t: any) => t.blocks ?? []);
        report.turns.push({ id, turns: snap?.turns?.length, tools: blocks.filter((b: any) => b.t === "tool").length, textChars: blocks.filter((b: any) => b.t === "text").reduce((a: number, b: any) => a + (b.text?.length ?? 0), 0), status: snap?.state?.status, model: snap?.state?.model });
        await rpc.call("session.close", { id }).catch(() => {});
    }
    await sleep(5000);
    report.footprintEndMB = footprint([...(await pids())]);
    report.rssEndMB = rss([...(await pids())]);
    rpc.ws.close();
    page.ws.close();
} catch (e) {
    report.error = String((e as Error)?.message ?? e);
} finally {
    // Only this instance: its main process, then its server if it outlived it.
    if (mainPid) process.kill(mainPid, "SIGTERM");
    await sleep(4000);
    for (const pid of [mainPid, serverPid]) {
        if (!pid) continue;
        try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
    }
    mkdirSync(join(import.meta.dir, "bench-results"), { recursive: true });
    await Bun.write(join(import.meta.dir, "bench-results", `bench-real-${label}.json`), JSON.stringify(report, null, 1));
    const { samples: _s, ...brief } = report;
    console.log(JSON.stringify(brief, null, 1));
    process.exit(0);
}
