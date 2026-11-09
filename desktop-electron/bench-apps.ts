// What an app costs the Mac over a stretch, measured the same way for any app: Cavvy, the Claude app, T3 Code, a
// terminal. Every process of the app's bundle and everything they started (the agent CLIs included), and
// WindowServer: instructions retired (the gauge for work: CPU% moves with which cores macOS picks), CPU time, and
// memory as `footprint` counts it. Nothing is driven: a person (or a script of theirs) sets the app up, starts what's
// to be measured, and this measures it. Appends a JSON line per stretch to bench-results/apps.jsonl.
//
//   bun desktop-electron/bench-apps.ts --app <path to the .app> --label <what's on screen> [--seconds 60] [--after 5]
//     --after: seconds to wait before measuring (start the reply, then step away from the keyboard and mouse)
//
// For a fair comparison (docs/benchmark-apps.md): the same Mac, quiet (`top` first), the same window
// size, the same model and prompt, each app alone, and runs alternated between apps. Compare totals, the CLIs
// included: where an agent's work happens (its CLI, or the app) differs between apps.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const appPath = arg("--app")?.replace(/\/$/, "");
const label = arg("--label");
const seconds = Number(arg("--seconds") ?? 60);
const after = Number(arg("--after") ?? 5);
if (!appPath || !label) throw new Error("usage: bench-apps.ts --app <path to the .app> --label <what's on screen> [--seconds 60] [--after 5]");

const libproc = dlopen("/usr/lib/libproc.dylib", { proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
/** Instructions retired and CPU time (ns) of a process (proc_pid_rusage, RUSAGE_INFO_V4, after a 16-byte uuid). */
function usage(pid: number): { instructions: number; cpuNs: number } | undefined {
    const buf = new BigUint64Array(64);
    if (libproc.symbols.proc_pid_rusage(pid, 4, ptr(buf)) !== 0) return undefined;
    return { instructions: Number(buf[2 + 29]), cpuNs: Number(buf[2]) + Number(buf[3]) };
}

type Proc = { pid: number; ppid: number; command: string };
const table = (): Proc[] => Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="]).stdout.toString().trim().split("\n").flatMap((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }] : [];
});
/** The app's processes (its bundle's executables) and everything under them, by role. */
function roles(): Map<number, string> {
    const procs = table();
    const out = new Map<number, string>();
    const app = procs.filter((p) => p.command.startsWith(`${appPath}/Contents/`));
    for (const p of app) out.set(p.pid, /Helper \(GPU\)|--type=gpu-process/.test(p.command) ? "app:gpu" : /Helper \(Renderer\)|--type=renderer/.test(p.command) ? "app:renderer" : / Helper/.test(p.command) ? "app:helper" : "app:main");
    const under = (pid: number) => { for (const c of procs) if (c.ppid === pid && !out.has(c.pid)) { out.set(c.pid, /claude|codex/i.test(c.command) ? "cli" : "children"); under(c.pid); } };
    for (const p of app) under(p.pid);
    const ws = procs.find((p) => /\/WindowServer( |$)/.test(p.command));
    if (ws) out.set(ws.pid, "WindowServer");
    return out;
}
function footprintMB(pids: number[]): Record<number, number> {
    if (!pids.length) return {};
    const text = Bun.spawnSync(["footprint", "-f", "bytes", ...pids.flatMap((p) => ["-p", String(p)])]).stdout.toString();
    return Object.fromEntries([...text.matchAll(/\[(\d+)\]:.*?Footprint: (\d+) B/g)].map((m) => [Number(m[1]), Math.round(Number(m[2]) / 1048576)]));
}

console.error(`measuring ${appPath} in ${after}s, for ${seconds}s: set it up and leave it`);
await Bun.sleep(after * 1000);
const top = Bun.spawnSync(["top", "-l", "2", "-o", "cpu", "-n", "6", "-stats", "command,cpu"]).stdout.toString().trim().split("\n").slice(-6).map((l) => l.trim().replace(/\s+/g, " "));
let map = roles();
const start = new Map([...map.keys()].map((pid) => [pid, usage(pid)]));
const t0 = performance.now();
await Bun.sleep(seconds * 1000);
// Processes that came and went count for what they did while measured (one that was there at the start and is gone
// by the end can't be read again: counted as nothing, and noted).
map = new Map([...map, ...roles()]);
const wall = (performance.now() - t0) / 1000;
const mips: Record<string, number> = {}, cpu: Record<string, number> = {};
let gone = 0;
for (const [pid, role] of map) {
    const end = usage(pid);
    if (!end) { gone++; continue; }
    const from = start.get(pid) ?? { instructions: 0, cpuNs: 0 };
    if (!from) continue;
    mips[role] = (mips[role] ?? 0) + (end.instructions - from.instructions) / wall / 1e6;
    cpu[role] = (cpu[role] ?? 0) + ((end.cpuNs - from.cpuNs) / 1e9 / wall) * 100;
}
const memory = footprintMB([...map].filter(([, r]) => r !== "WindowServer").map(([p]) => p));
const memoryByRole: Record<string, number> = {};
for (const [pid, role] of map) if (memory[pid] !== undefined) memoryByRole[role] = (memoryByRole[role] ?? 0) + memory[pid]!;
const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 10) / 10]));
const total = (o: Record<string, number>) => Math.round(Object.entries(o).filter(([k]) => k !== "WindowServer").reduce((s, [, v]) => s + v, 0));
const report = {
    app: appPath.split("/").at(-1), label, at: new Date().toISOString(), seconds: Math.round(wall),
    mips: round(mips), totalMips: total(mips), cpuPercent: round(cpu), totalCpuPercent: total(cpu),
    memoryMB: memoryByRole, totalMemoryMB: total(memoryByRole), processes: map.size, goneBeforeTheEnd: gone, topBefore: top,
};
const dir = join(import.meta.dir, "bench-results");
mkdirSync(dir, { recursive: true });
appendFileSync(join(dir, "apps.jsonl"), JSON.stringify(report) + "\n");
console.log(JSON.stringify(report, null, 2));
