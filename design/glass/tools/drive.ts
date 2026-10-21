// Drives the mockup in headless Chrome over CDP: runs steps, screenshots, reports page errors.
// Env: W, H (viewport, default 1512x982), DPR (default 1), SHOW=1 prints each step's result.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2];
const steps: [string, string, number][] = JSON.parse(await Bun.file(process.argv[3]).text());
const out = process.argv[4] ?? "/tmp/mock";
const port = 9333 + Math.floor(Math.random() * 500);
const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync("/tmp/cdp-")}`, "--hide-scrollbars", "--no-first-run", "about:blank"], { stdio: "ignore" });
let tab: any;
for (let i = 0; i < 50 && !tab; i++) { await Bun.sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t: any) => t.type === "page"); } catch {} }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const wait = new Map<number, (v: any) => void>(); const errors: string[] = [];
ws.onmessage = (m) => {
    const d = JSON.parse(m.data as string);
    if (d.id && wait.has(d.id)) { wait.get(d.id)!(d); wait.delete(d.id); }
    if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map((a: any) => a.value ?? a.description).join(" "));
};
const cdp = (method: string, params: any = {}) => new Promise<any>((r) => { const id = ++n; wait.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
await cdp("Runtime.enable"); await cdp("Page.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: Number(process.env.W ?? 1512), height: Number(process.env.H ?? 982), deviceScaleFactor: Number(process.env.DPR ?? 1), mobile: false });
await cdp("Page.navigate", { url }); await Bun.sleep(1200);
for (const [name, js, ms] of steps) {
    if (js) { const r = await cdp("Runtime.evaluate", { expression: js, awaitPromise: true }); if (r.result?.exceptionDetails) errors.push(`${name}: ${r.result.exceptionDetails.exception?.description}`); else if (process.env.SHOW) console.log(name, r.result?.result?.value); }
    await Bun.sleep(ms);
    if (name !== "-") { const s = await cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(`${out}-${name}.png`, Buffer.from(s.result.data, "base64")); }
}
console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no page errors");
ws.close(); proc.kill(); process.exit(0);
