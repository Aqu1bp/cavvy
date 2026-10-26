// Run: bun desktop-electron/check-input.ts (needs Chrome-capable macOS session; opens a window).
// The person types in the composer while text and Enter go to a browser tab: they must land in the tab's page, never in
// the composer (and never send it). A tab's reload must reload the tab, not the UI.
import { mkdirSync } from "node:fs";
const repo = (await import("node:path")).resolve(import.meta.dir, "..");
const out = process.env.TMPDIR ?? "/tmp";
const dir = `${out}/inject-${Date.now()}`;
mkdirSync(dir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report: Record<string, unknown> = {};
const metricsFile = `${dir}/metrics.json`;
const demo = Bun.spawn(["bun", "--no-env-file", "scripts/gui-demo.ts", "--port", "4633", "--token", "inject-check-token-1234567", "--dir", dir], { cwd: repo, stdout: Bun.file(`${dir}/demo.log`), stderr: "ignore" });
var app: ReturnType<typeof Bun.spawn> | undefined;
const deadline = setTimeout(() => { report.error = "timed out"; console.log(JSON.stringify(report, null, 1)); app?.kill("SIGKILL"); demo.kill(); process.exit(1); }, 150_000);
try {
    for (let i = 0; ; i++) { if (await fetch("http://127.0.0.1:4633/healthz").then((r) => r.ok, () => false)) break; if (i > 120) throw new Error("demo"); await sleep(500); }
    app = Bun.spawn([`${repo}/desktop-electron/node_modules/.bin/electron`, `${repo}/desktop-electron`], { cwd: repo, env: { ...process.env, HARNESS_HOME: `${dir}/home`, HARNESS_NO_KEYCHAIN: "1", HARNESS_ELECTRON_TEST_PORT: "9341", HARNESS_ELECTRON_USER_DATA: `${dir}/electron-data`, HARNESS_ELECTRON_CWD: `${dir}/acme-platform`, HARNESS_ELECTRON_METRICS: metricsFile }, stdout: "ignore", stderr: Bun.file(`${dir}/app.log`) });
    const targets = async () => (await fetch("http://127.0.0.1:9341/json/list").then((r) => r.json(), () => [])) as { url: string; type: string; webSocketDebuggerUrl: string }[];
    let gui: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; !gui; i++) { gui = (await targets()).find((t) => t.url.startsWith("harness://app")); if (i > 200) throw new Error("no window"); if (!gui) await sleep(100); }
    const connect = async (url: string) => {
        const ws = new WebSocket(url); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        let seq = 0; const pending = new Map<number, (v: any) => void>();
        ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); pending.get(m.id)?.(m); pending.delete(m.id); };
        const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.delete(id)) r({}); }, 8000); });
        const js = async (expression: string) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
        return { ws, send, js };
    };
    const g = await connect(gui.webSocketDebuggerUrl);
    for (let i = 0; !(await g.js(`!!document.querySelector('textarea[aria-label="Message"]')`)); i++) { if (i > 300) throw new Error("no composer"); await sleep(100); }
    // The agent opens the demo site.
    await g.js(`(() => { const box = document.querySelector('textarea[aria-label="Message"]'); box.value = 'check the app in the browser'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await g.js(`document.querySelector('button[aria-label="Send"]').click()`);
    for (let i = 0; i < 200 && !(await g.js(`!!document.querySelector('button[title="Allow once"]')`)); i++) await sleep(50);
    await g.js(`document.querySelector('button[title="Allow once"]')?.click()`);
    for (let i = 0; i < 300 && !(await g.js(`/Subscribed \\(1\\)/.test(document.querySelector('.transcript')?.innerText ?? '')`)); i++) await sleep(50);
    const tabTarget = (await targets()).find((t) => t.type === "webview");
    if (!tabTarget) throw new Error("no tab");
    const t = await connect(tabTarget.webSocketDebuggerUrl);
    const m = await Bun.file(metricsFile).json();
    const rpc = new WebSocket(`ws://127.0.0.1:${m.server.port}/ws`, ["harness.v1", `auth.${m.server.token}`]);
    await new Promise((r, j) => { rpc.onopen = r; rpc.onerror = j; });
    let rseq = 0; const rp = new Map<number, (v: any) => void>();
    rpc.onmessage = (e) => { const x = JSON.parse(String(e.data)); if (x.id) { rp.get(x.id)?.(x); rp.delete(x.id); } };
    const call = (method: string, params: unknown) => new Promise<any>((r) => { const id = ++rseq; rp.set(id, r); rpc.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (rp.delete(id)) r({}); }, 15_000); });
    const sid = ((await call("sessions.list", {})).result as { id: string }[])[0]!.id;
    const messagesBefore = await g.js(`document.querySelectorAll('.transcript [data-role="user"], .transcript .user-msg, .transcript .msg-user').length`);
    // The page's search box takes focus in the page (as the agent's type action clicks it first).
    const box = await t.js(`(() => { const r = document.getElementById('q').getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
    await call("browser.input", { id: sid, input: { kind: "mouse", type: "down", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 } });
    await call("browser.input", { id: sid, input: { kind: "mouse", type: "up", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 } });
    // The person goes back to the composer and starts a draft.
    await g.js(`(() => { const c = document.querySelector('textarea[aria-label="Message"]'); c.focus(); c.value = 'my draft'; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    report.focusBefore = await g.js(`document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName`);
    // Text and Enter for the tab, by the same path as the agent's type action.
    await call("browser.input", { id: sid, input: { kind: "text", text: "Stress test" } });
    await call("browser.input", { id: sid, input: { kind: "key", type: "down", key: "Enter", code: "Enter" } });
    await call("browser.input", { id: sid, input: { kind: "key", type: "up", key: "Enter", code: "Enter" } });
    await sleep(1500);
    report.composer = await g.js(`document.querySelector('textarea[aria-label="Message"]')?.value`);
    report.transcriptHasStressTest = await g.js(`(document.querySelector('.transcript')?.innerText ?? '').includes('Stress test')`);
    report.pageBox = await t.js(`document.getElementById('q').value`);
    report.pageSearched = await t.js(`document.getElementById('found').textContent`);
    report.focusAfter = await g.js(`document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName`);
    // A reload of the tab reloads the tab only.
    await g.js(`window.__notReloaded = true`);
    await t.js(`window.__tabMark = true`);
    await call("browser.command", { id: sid, command: "reload" });
    await sleep(2500);
    report.uiSurvivedReload = await g.js(`window.__notReloaded === true`);
    const t2 = (await targets()).find((x) => x.type === "webview");
    const tt = t2 ? await connect(t2.webSocketDebuggerUrl) : undefined;
    report.tabReloaded = tt ? await tt.js(`window.__tabMark !== true`) : "no tab";
    report.verdict = report.composer === "my draft" && report.transcriptHasStressTest === false && report.pageBox === "Stress test" && report.uiSurvivedReload === true && report.tabReloaded === true ? "PASS" : "FAIL";
    rpc.close();
} catch (e) {
    report.error = String((e as Error)?.stack ?? e);
} finally {
    clearTimeout(deadline);
    app?.kill("SIGTERM"); await sleep(2000); app?.kill("SIGKILL"); demo.kill();
    report.appLog = (await Bun.file(`${dir}/app.log`).text().catch(() => "")).split("\n").filter((l) => /error|harness\]/i.test(l)).slice(-8).join("\n");
    console.log(JSON.stringify(report, null, 1));
    process.exit(0);
}
