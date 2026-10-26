// Times the GUI's everyday interactions in WebKit: probe.js run in a bare WKWebView window
// (webkit-host.swift, the engine Tauri uses on macOS). Seed the server first (scripts/perf-seed.ts).
//
//   bun design/glass/tools/webkit-perf.ts <url with #token=…> [interactions] [--json out.json]
//
// interactions: a comma list (see probe.js; default: all). Env: RUNS (default 5), W, H (default
// 1512x982), LONG / SHORT (the sessions' titles; default "Long session" / "Short session"),
// INJECT_CSS (a style sheet to try, say without blur), SETTLE_MS (default 2000).
// The window shows for the run, above other windows, without taking focus.
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const url = args[0];
if (!url) throw new Error("usage: webkit-perf.ts <url> [interactions] [--json out.json]");
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
const only = args[1] && !args[1].startsWith("--") ? args[1].split(",") : undefined;

const dir = import.meta.dir;
const host = "/tmp/cavvy-webkit-host";
const source = join(dir, "webkit-host.swift");
if (!existsSync(host) || statSync(host).mtimeMs < statSync(source).mtimeMs) {
    const built = Bun.spawnSync(["swiftc", "-O", source, "-o", host], { stderr: "inherit" });
    if (built.exitCode !== 0) throw new Error("couldn't build webkit-host.swift");
}
const config = {
    runs: Number(process.env.RUNS ?? 5),
    only,
    long: process.env.LONG ?? "Long session",
    short: process.env.SHORT ?? "Short session",
    css: process.env.INJECT_CSS,
    settleMs: Number(process.env.SETTLE_MS ?? 2000),
};
const script = (await Bun.file(join(dir, "probe.js")).text()).replace("const CONFIG = __CONFIG__;", `const CONFIG = ${JSON.stringify(config)};`);
const file = join(mkdtempSync("/tmp/webkit-perf-"), "probe.js");
writeFileSync(file, script);
const proc = Bun.spawnSync([host, url, file, process.env.W ?? "1512", process.env.H ?? "982"], { stderr: "inherit" });
const out = proc.stdout.toString().trim();
if (proc.exitCode !== 0) throw new Error(`webkit-host exited ${proc.exitCode}: ${out}`);
const res = JSON.parse(out);
console.log(`${res.engine}\n${res.nodes} elements with the long session open`);
for (const [name, r] of Object.entries<any>(res.results)) {
    const parts = Object.entries(r).filter(([k]) => k !== "runs").map(([k, v]) => `${k} ${v}`).join(", ");
    console.log(`${name.padEnd(15)} ${parts} | runs ${r.runs.join("/")}`);
}
if (jsonOut) await Bun.write(jsonOut, JSON.stringify(res, null, 2));
