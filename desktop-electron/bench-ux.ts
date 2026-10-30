// How the app feels in use, measured: each interaction a person makes, timed from their click or key to the frame that
// shows the result, with the frames dropped meanwhile and what ran in any slow one. On realistic data made by the
// demo's mock model: a long session (60 turns of reading, editing, running commands and long markdown replies), one
// long turn (30 prompts sent while it ran: the demo's steps, commands, replies), 40 short sessions, and a 4000-line
// change for the diff reader. Writes bench-ux-<label>.json.
//
//   bun desktop-electron/bench-ux.ts --label dev
//   bun desktop-electron/bench-ux.ts --label packaged --app <…>/Cavvy.app/Contents/MacOS/Cavvy
//   bun desktop-electron/bench-ux.ts --label traced --trace <dir>    # also a Chromium trace of each session opened
//
// Interactions: opening a long session; flicking through it and back; jumping to its start; unfolding a turn's work;
// switching between sessions (open in the window and not); opening the side panel and its tabs; opening a big diff and
// scrolling it; the command palette and typing in it; Settings and its sections; a new session; typing in the composer
// of a long session. A frame counts as dropped over 25 ms (this display draws every 8 ms); slow is over 50 ms.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const label = arg("--label") ?? "run";
const repo = resolve(import.meta.dir, "..");
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cavvy-ux-"));
const metricsFile = join(dir, "metrics.json");
const project = join(dir, "acme-platform");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report: Record<string, any> = { label, at: new Date().toISOString(), interactions: {} };
const TOKEN = "ux-bench-token-12345678901";

const demo = Bun.spawn(["bun", "--no-env-file", "scripts/gui-demo.ts", "--port", "4636", "--token", TOKEN, "--dir", dir], { cwd: repo, stdout: "ignore", stderr: Bun.file(join(dir, "demo.err.log")) });
let app: ReturnType<typeof Bun.spawn> | undefined;

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

try {
    for (let i = 0; ; i++) { if (await fetch("http://127.0.0.1:4636/healthz").then((r) => r.ok, () => false)) break; if (i > 120) throw new Error("demo didn't start"); await sleep(500); }

    // ---- The app.
    const exe = arg("--app");
    const spawnedAt = performance.now();
    // Drawn even when another window covers it: otherwise a covered window measures nothing.
    app = Bun.spawn(exe ? [exe, "--disable-backgrounding-occluded-windows"] : [join(repo, "desktop-electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), "--disable-backgrounding-occluded-windows", join(repo, "desktop-electron")], {
        cwd: repo,
        env: { ...process.env, CAVVY_HOME: join(dir, "home"), CAVVY_NO_KEYCHAIN: "1", CAVVY_ELECTRON_TEST_PORT: "9344", CAVVY_ELECTRON_USER_DATA: join(dir, "electron-data"), CAVVY_ELECTRON_CWD: project, CAVVY_ELECTRON_METRICS: metricsFile },
        stdout: "ignore",
        stderr: Bun.file(join(dir, "app.log")),
    });
    let gui: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; !gui; i++) {
        gui = ((await fetch("http://127.0.0.1:9344/json/list").then((r) => r.json(), () => [])) as { url: string; webSocketDebuggerUrl: string }[]).find((t) => t.url.startsWith("cavvy://app"));
        if (!gui) { if (i > 2000) throw new Error("no window"); await sleep(10); }
    }
    const ws = new WebSocket(gui.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0;
    const pending = new Map<number, (v: any) => void>();
    const listeners = new Map<string, (params: any) => void>();
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.method) listeners.get(m.method)?.(m.params); else { pending.get(m.id)?.(m); pending.delete(m.id); } };
    const cdp = (method: string, params: Record<string, unknown> = {}, ms = 20_000) => new Promise<any>((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.delete(id)) r({}); }, ms); });
    const js = async (expression: string) => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 30_000)).result?.result?.value;

    // In the page: every frame's time, the slow ones' scripts (long-animation-frame), and each input's own timing (event timing).
    const instrument = `(() => {
        if (window.__ux) return;
        window.__ux = { frames: [], loaf: [], events: [] };
        (function f(t) { __ux.frames.push(t); requestAnimationFrame(f); })(performance.now());
        try { new PerformanceObserver((l) => { for (const e of l.getEntries()) __ux.loaf.push({ start: e.startTime, ms: Math.round(e.duration), blocking: Math.round(e.blockingDuration), styleLayoutMs: e.styleAndLayoutStart ? Math.round(e.startTime + e.duration - e.styleAndLayoutStart) : 0, scripts: (e.scripts || []).map((x) => ({ ms: Math.round(x.duration), invoker: x.invoker, fn: x.sourceFunctionName, at: (x.sourceURL || '').split('/').pop() + ':' + x.sourceCharPosition })).sort((a, b) => b.ms - a.ms).slice(0, 3) }); }).observe({ type: 'long-animation-frame', buffered: true }); } catch (e) { __ux.loafError = String(e); }
        try { new PerformanceObserver((l) => { for (const e of l.getEntries()) __ux.events.push({ name: e.name, start: e.startTime, ms: Math.round(e.duration), inputDelay: Math.round(e.processingStart - e.startTime), processing: Math.round(e.processingEnd - e.processingStart) }); }).observe({ type: 'event', durationThreshold: 16, buffered: true }); } catch (e) { __ux.eventError = String(e); }
        // Resolves at the first painted frame where cond() holds.
        window.__uxWait = (cond, timeout) => new Promise((res) => { const t0 = performance.now(); (function check() { let ok = false; try { ok = !!cond(); } catch {} if (ok) requestAnimationFrame(() => res(performance.now())); else if (performance.now() - t0 > (timeout || 15000)) res(-1); else requestAnimationFrame(check); })(); });
    })()`;
    for (let i = 0; !(await js(`!!document.querySelector('textarea[aria-label="Message"]')`)); i++) { if (i > 1500) throw new Error("no composer"); await sleep(10); }
    report.startupInteractiveMs = Math.round(performance.now() - spawnedAt);
    // ---- Data, through the app's own server, as a person's sessions are made (one made through another server stays
    // open there, locked, and this app couldn't open it).
    const seedAt = performance.now();
    let server: { port?: number; token?: string } = {};
    for (let i = 0; !server.token; i++) { server = ((await Bun.file(metricsFile).json().catch(() => ({}))) as { server?: typeof server }).server ?? {}; if (i > 200) throw new Error("no server in metrics"); if (!server.token) await sleep(100); }
    const seed = await rpcTo(server.port!, server.token!);
    const summary = async (id: string) => (((await seed.call("sessions.list", { limit: 200 })).result ?? []) as { id: string; status: string; turnStartedAt?: number; title: string }[]).find((s) => s.id === id);
    const turnsRun = new Map<string, number>();
    // One turn per prompt: a prompt sent while a turn runs would join it. A turn ran when its start time moves on.
    const turns = async (id: string, prompts: string[]) => {
        for (const prompt of prompts) {
            const before = (await summary(id))?.turnStartedAt;
            await seed.call("session.send", { id, text: prompt });
            for (let i = 0; i < 100; i++) { const s = await summary(id); if (s?.turnStartedAt !== before) break; await sleep(50); }
            for (let i = 0; i < 600; i++) { const s = await summary(id); if (s?.status !== "running") break; await sleep(100); }
            turnsRun.set(id, (turnsRun.get(id) ?? 0) + 1);
        }
    };
    const create = async () => (await seed.call("session.create", { cwd: project, mode: "bypassPermissions" })).result.state.id as string;
    const long1 = await create();
    const long2 = await create();
    const shorts: string[] = [];
    for (let i = 0; i < 40; i++) shorts.push(await create());
    await Promise.all([
        turns(long1, Array.from({ length: 60 }, (_, i) => `fastdemo 20000 (part ${i + 1})`)),
        turns(long2, Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? "demo" : i % 3 === 1 ? "cmdrows" : `fastdemo 20000 (step ${i + 1})`))),
        (async () => { for (let b = 0; b < shorts.length; b += 10) await Promise.all(shorts.slice(b, b + 10).map((id, k) => turns(id, [`hello ${b + k}`]))); })(),
    ]);
    // Pinned, so the sidebar lists them whatever else it shows; and how many messages each really has.
    for (const id of [long1, long2, shorts[5]!]) await seed.call("session.pin", { id, pinned: true });
    const titles = Object.fromEntries(await Promise.all([long1, long2, shorts[5]!].map(async (id) => [id, (await summary(id))?.title ?? ""] as const)));
    report.seedTurns = { long1: turnsRun.get(long1), long2: turnsRun.get(long2), short: turnsRun.get(shorts[5]!) };
    report.seedTitles = titles;
    // A 4000-line file, committed, then changed on every third line: a big diff.
    mkdirSync(join(project, "src/generated"), { recursive: true });
    const big = (v: number) => Array.from({ length: 4000 }, (_, i) => (v === 1 && i % 3 === 0 ? `export const value${i} = ${i * 7}; // changed` : `export const value${i} = ${i};`)).join("\n") + "\n";
    writeFileSync(join(project, "src/generated/big.ts"), big(0));
    Bun.spawnSync(["git", "add", "-A"], { cwd: project });
    Bun.spawnSync(["git", "-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "-qm", "big file"], { cwd: project });
    writeFileSync(join(project, "src/generated/big.ts"), big(1));
    seed.ws.close();
    report.seed = { seconds: Math.round((performance.now() - seedAt) / 1000), long1, long2, shorts: shorts.length };

    await js(instrument);
    // The sidebar listing the sessions.
    const listed = await js(`__uxWait(() => document.querySelectorAll('[data-session-row]').length >= 30, 20000)`);
    report.sidebarRows = await js(`document.querySelectorAll('[data-session-row]').length`);
    void listed;
    await sleep(1500);

    // ---- Input, as a person makes it (trusted events through Chromium's input pipeline).
    const centre = (sel: string) => js(`(() => { const el = ${sel}; if (!el) return null; const r0 = el.getBoundingClientRect(); if (r0.bottom < 0 || r0.top > innerHeight) el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 14) }; })()`);
    const click = async (sel: string) => {
        const at = await centre(sel);
        if (!at) throw new Error(`nothing to click: ${sel}`);
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
        await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", buttons: 1, clickCount: 1 });
        await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", buttons: 0, clickCount: 1 });
    };
    const key = async (k: string, code: string, modifiers = 0, keyCode = 0) => {
        await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, modifiers, windowsVirtualKeyCode: keyCode });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, modifiers, windowsVirtualKeyCode: keyCode });
    };
    const flick = async (sel: string, dy: number, events: number) => {
        const at = await js(`(() => { const r = ${sel}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        for (let i = 0; i < events; i++) { void cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...at, deltaX: 0, deltaY: dy }); await sleep(8); }
    };

    /** One interaction: from the input to the first painted frame where `done` holds, then 700 ms for what follows. */
    const measure = async (name: string, act: () => Promise<void>, done: string, settle = 700) => {
        const t0 = await js(`performance.now()`);
        let error: string | undefined;
        try { await act(); } catch (e) { error = String(e); }
        const waited = error ? -1 : await js(`__uxWait(() => (${done}), 20000)`);
        // -1: the result never showed within 20s; undefined: no answer at all (the window drew no frames).
        const ready = typeof waited === "number" ? waited : -1;
        if (!error && waited === -1) error = "never showed within 20s";
        if (!error && waited === undefined) error = "no frames drawn while waiting";
        await sleep(settle);
        const s = await js(`(() => {
            const t0 = ${t0}, t1 = ${ready < 0 ? "performance.now()" : `${ready} + ${settle}`};
            const fr = __ux.frames.filter((x) => x >= t0 && x <= t1);
            const gaps = fr.slice(1).map((x, i) => x - fr[i]);
            const loaf = __ux.loaf.filter((l) => l.start + l.ms >= t0 && l.start <= t1).sort((a, b) => b.ms - a.ms).slice(0, 3);
            const ev = __ux.events.filter((e) => e.start >= t0 - 5 && e.start <= t1).sort((a, b) => b.ms - a.ms)[0];
            return { maxFrameMs: Math.round(Math.max(0, ...gaps)), droppedFrames: gaps.filter((g) => g > 25).length, slowFrames: gaps.filter((g) => g > 50).length, frames: gaps.length, slowestInput: ev || null, longAnimationFrames: loaf };
        })()`);
        report.interactions[name] = { ms: ready < 0 ? null : Math.round(ready - t0), ...(error ? { error } : {}), ...s, t0 };
    };
    // The session's own button in the sidebar (a row's title, or a card), never its Pin or More.
    const row = (id: string) => `document.querySelector('[data-session-row="${id}"] .slim-hit, [data-session-row="${id}"] .card-hit, [data-session-id="${id}"] .slim-hit')`;
    const turnCount = `document.querySelectorAll('.transcript [data-turn]').length`;
    const scroller = `document.querySelector('.transcript')`;

    // A session is seen when its title heads the window and its last turn is on screen; complete when all its turns are in.
    const titled = (id: string) => `document.querySelector('.ttl-h')?.textContent?.trim() === ${JSON.stringify(titles[id] ?? "")}`;
    const seen = (id: string) => `${titled(id)} && (() => { const t = [...document.querySelectorAll('.transcript [data-turn]')].at(-1); if (!t) return false; const r = t.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })()`;
    // The transcript shows its last 40 turns (TURN_PAGE) until the reader scrolls up for more.
    const complete = (id: string) => `${titled(id)} && ${turnCount} >= ${Math.min(40, turnsRun.get(id) ?? 1)}`;
    /** Where the UI's main thread spent a stretch: self time by function (a CPU profile, sampled every 0.1 ms). */
    const profiled = async (run: () => Promise<void>) => {
        await cdp("Profiler.enable");
        await cdp("Profiler.setSamplingInterval", { interval: 100 });
        await cdp("Profiler.start");
        await run();
        const { result } = await cdp("Profiler.stop");
        const p = result?.profile as { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }[]; samples: number[]; timeDeltas: number[] } | undefined;
        if (!p) return null;
        const self = new Map<number, number>();
        p.samples.forEach((n, i) => self.set(n, (self.get(n) ?? 0) + (p.timeDeltas[i] ?? 0)));
        const byFn = new Map<string, number>();
        for (const n of p.nodes) {
            const us = self.get(n.id) ?? 0;
            if (!us) continue;
            const f = n.callFrame;
            const key = f.url ? `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.lineNumber}` : f.functionName;
            byFn.set(key, (byFn.get(key) ?? 0) + us);
        }
        const total = [...byFn.values()].reduce((a, b) => a + b, 0);
        const busy = [...byFn].filter(([k]) => k !== "(idle)").reduce((a, [, v]) => a + v, 0);
        // Rendering markdown (MarkdownRenderer.segments, a method's name survives minifying), with all it calls.
        const nodes = new Map(p.nodes.map((n) => [n.id, n as typeof n & { children?: number[] }]));
        const within = (id: number): number => (self.get(id) ?? 0) + (nodes.get(id)?.children ?? []).reduce((a, c) => a + within(c), 0);
        const markdown = p.nodes.filter((n) => n.callFrame.functionName === "segments").reduce((a, n) => a + within(n.id), 0);
        return { busyMs: Math.round(busy / 1000), totalMs: Math.round(total / 1000), markdownMs: Math.round(markdown / 100) / 10, top: [...byFn].filter(([k]) => k !== "(idle)").sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${Math.round(v / 100) / 10}ms ${k}`) };
    };
    /** With --trace <dir>: a Chromium trace of a stretch (the session opens, the big diff's), every process, written to <dir>/trace-<label>-<name>.json. */
    const traceDir = arg("--trace");
    const traced = async (name: string, run: () => Promise<void>) => {
        if (!traceDir) return run();
        const events: unknown[] = [];
        listeners.set("Tracing.dataCollected", (p) => events.push(...p.value));
        const ended = new Promise((r) => listeners.set("Tracing.tracingComplete", r));
        await cdp("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "toplevel", "blink", "cc", "gpu", "viz", "v8", "v8.execute", "disabled-by-default-v8.gc", "latencyInfo", "benchmark", "loading", "disabled-by-default-v8.cpu_profiler"] } });
        await run();
        await cdp("Tracing.end");
        await Promise.race([ended, sleep(15000)]);
        await Bun.write(join(traceDir, `trace-${label}-${name}.json`), JSON.stringify({ traceEvents: events }));
    };
    const open = async (name: string, id: string) => {
        // Watched in the page from the click: when every turn of this session is in.
        await js(`(window.__done = null, __uxWait(() => (${complete(id)}), 25000).then((t) => (window.__done = t)), 0)`);
        const profile = await profiled(() => traced(name, () => measure(name, () => click(row(id)), seen(id), 300)));
        report.interactions[name].profile = profile;
        for (let i = 0; i < 100 && (await js(`window.__done`)) === null; i++) await sleep(200);
        const done = await js(`window.__done`);
        report.interactions[name].allTurnsInMs = typeof done === "number" && done > 0 ? Math.round(done - report.interactions[name].t0) : null;
        report.interactions[name].turnsShown = await js(turnCount);
    };
    // Opening the long session, and moving around it.
    await open("openLongSession", long1);
    await measure("flickUpThroughLongSession", () => flick(scroller, -400, 90), `${scroller}.scrollTop < ${scroller}.scrollHeight * 0.5`, 900);
    await measure("flickDownThroughLongSession", () => flick(scroller, 400, 90), `${scroller}.scrollTop > 0`, 900);
    await measure("jumpToStart", () => js(`(${scroller}.scrollTop = 0, 0)`), `${scroller}.scrollTop === 0`, 900);
    await measure("jumpToEnd", () => js(`(${scroller}.scrollTop = ${scroller}.scrollHeight, 0)`), `${scroller}.scrollTop > 0`, 900);
    // The last folded turn's "Worked for", brought to the middle of the conversation (clear of the title bar and the
    // composer floating over its end), clicked where nothing covers it.
    const foldTurn = (await js(`(() => { const b = [...document.querySelectorAll('.transcript .fold.worked[aria-expanded="false"]')].at(-1); b?.scrollIntoView({ block: 'center' }); return b?.closest('[data-turn]')?.dataset.turn ?? null; })()`)) as string | null;
    await sleep(400);
    const foldBtn = `document.querySelector('[data-turn="${foldTurn}"] .fold.worked')`;
    report.unfoldTarget = await js(`(() => { const b = ${foldBtn}; if (!b) return null; const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height / 2, 14)); return { top: Math.round(r.top), covered: !b.contains(hit), hit: hit?.className?.toString().slice(0, 60) ?? null }; })()`);
    await measure("unfoldTurnWork", () => click(foldBtn), `${foldBtn}?.getAttribute('aria-expanded') === 'true'`);
    // Typing into its composer.
    await js(`document.querySelector('textarea[aria-label="Message"]').focus()`);
    const typedAt = await js(`performance.now()`);
    for (const ch of "how does the session store work") { await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch }); await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch }); await sleep(40); }
    report.interactions.typeInLongSession = await js(`(() => { const ev = __ux.events.filter((e) => e.start >= ${typedAt} && (e.name === 'keydown' || e.name === 'keypress' || e.name === 'input' || e.name === 'keyup')); const fr = __ux.frames.filter((x) => x >= ${typedAt}); const gaps = fr.slice(1).map((x, i) => x - fr[i]); return { slowKeys: ev.length, worstKeyMs: Math.max(0, ...ev.map((e) => e.ms)), maxFrameMs: Math.round(Math.max(0, ...gaps)), droppedFrames: gaps.filter((g) => g > 25).length }; })()`);
    await js(`(() => { const t = document.querySelector('textarea[aria-label="Message"]'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); t.blur(); })()`);

    // Switching sessions: to one not open in the window yet, back to one that is, to a short one.
    await open("switchToOtherLongSession", long2);
    await open("switchBackToFirstLongSession", long1);
    await open("switchToShortSession", shorts[5]!);
    await open("switchBackToLongSession", long2);

    // The side panel, its tabs, the diff reader.
    await measure("openSidePanel", () => click(`document.querySelector('button[aria-label="Toggle panel"]')`), `document.querySelector('.insp .seg-l')`);
    const tab = (name: string) => `[...document.querySelectorAll('.insp button')].find((b) => b.querySelector('.seg-l')?.textContent === '${name}')`;
    await measure("panelTabAgents", () => click(tab("Agents")), `${tab("Agents")}?.getAttribute('aria-selected') === 'true' || ${tab("Agents")}?.classList.contains('on')`);
    await measure("panelTabCommands", () => click(tab("Commands")), `${tab("Commands")}?.getAttribute('aria-selected') === 'true' || ${tab("Commands")}?.classList.contains('on')`);
    await measure("panelTabChanges", () => click(tab("Changes")), `document.querySelector('.insp button.file')`, 1200);
    await traced("openBigDiff", () => measure("openBigDiff", () => click(`[...document.querySelectorAll('.insp button.file')].find((b) => b.textContent.includes('big.ts'))`), `document.querySelectorAll('.diff-rows .ln').length > 20`, 1200));
    await measure("scrollBigDiff", () => flick(`(document.querySelector('.diff-rows')?.closest('[class*="scroll"]') || document.querySelector('.diff-rows').parentElement)`, 600, 80), `true`, 900);
    await key("Escape", "Escape", 0, 27);
    await sleep(800);
    await measure("closeSidePanel", () => click(`document.querySelector('button[aria-label="Toggle panel"]')`), `!document.querySelector('.insp .seg-l')?.getClientRects().length || document.querySelector('.app')?.dataset.insp === 'off'`);

    // The command palette.
    await measure("openCommandPalette", () => key("k", "KeyK", 4, 75), `document.querySelector('.palette input')`);
    const paletteAt = await js(`performance.now()`);
    for (const ch of "settings") { await cdp("Input.insertText", { text: ch }); await sleep(60); }
    await sleep(400);
    report.interactions.typeInPalette = await js(`(() => { const fr = __ux.frames.filter((x) => x >= ${paletteAt}); const gaps = fr.slice(1).map((x, i) => x - fr[i]); const ev = __ux.events.filter((e) => e.start >= ${paletteAt}); return { maxFrameMs: Math.round(Math.max(0, ...gaps)), droppedFrames: gaps.filter((g) => g > 25).length, slowInputs: ev.length, worstInputMs: Math.max(0, ...ev.map((e) => e.ms)) }; })()`);
    await measure("closeCommandPalette", () => key("Escape", "Escape", 0, 27), `!document.querySelector('.palette input')`);

    // Settings.
    await measure("openSettings", () => click(`document.querySelector('button[aria-label="Settings"]')`), `document.querySelector('[aria-label="Settings sections"]')`);
    const sections = (await js(`[...document.querySelectorAll('[aria-label="Settings sections"] button, [aria-label="Settings sections"] a')].map((b) => b.textContent.trim()).slice(0, 6)`)) as string[];
    for (const sec of sections.slice(1, 4)) await measure(`settingsSection:${sec}`, () => click(`[...document.querySelectorAll('[aria-label="Settings sections"] button, [aria-label="Settings sections"] a')].find((b) => b.textContent.trim() === ${JSON.stringify(sec)})`), `true`);
    await measure("closeSettings", () => click(`document.querySelector('button[aria-label="Close settings"]')`), `!document.querySelector('[aria-label="Settings sections"]')`);

    // The terminal.
    await measure("openTerminal", () => click(`document.querySelector('button[aria-label="Toggle terminal"]')`), `document.querySelector('.xterm-screen, .xterm canvas, .xterm-rows')`, 1000);
    await measure("closeTerminal", () => click(`document.querySelector('button[aria-label="Toggle terminal"]')`), `!document.querySelector('.xterm')?.getClientRects().length || document.querySelector('.app')?.dataset.term === 'off'`);

    // A new session.
    await measure("newSession", () => click(`document.querySelector('button[aria-label="New session"]')`), `${turnCount} === 0 && document.querySelector('textarea[aria-label="Message"]')`);

    report.loafSupported = !(await js(`__ux.loafError || null`));
    report.eventTimingSupported = !(await js(`__ux.eventError || null`));
    // Memory after all that (the UI page holds the sessions it has shown).
    const m = await Bun.file(metricsFile).json().catch(() => undefined);
    if (m) report.memoryMB = Object.fromEntries(Object.entries((m.procs as { role: string; kb: number }[]).reduce((a: Record<string, number>, p) => ((a[p.role] = (a[p.role] ?? 0) + p.kb / 1024), a), {})).map(([k, v]) => [k, Math.round(v)]));
    ws.close();
} catch (e) {
    report.error = String((e as Error)?.stack ?? e);
    report.appLog = (await Bun.file(join(dir, "app.log")).text().catch(() => "")).split("\n").slice(-15).join("\n");
} finally {
    app?.kill("SIGTERM");
    await sleep(3000);
    app?.kill("SIGKILL");
    demo.kill();
    await Bun.write(join(import.meta.dir, "bench-results", `bench-ux-${label}.json`), JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report, null, 1));
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
}
