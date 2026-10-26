// Overhead of Monitor: quiet monitors, a steady trickle, and a firehose that gets stopped.
//   bun scripts/monitor-perf.ts
import { realpathSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WakeQueue } from "../src/agent/wakes";
import { startMonitor } from "../src/tools/monitor";
import { killAllShells } from "../src/tools/bash";
import type { ToolState } from "../src/tools/types";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "monitor-perf-")));
const wakes = new WakeQueue();
let pushed = 0;
const push = wakes.push.bind(wakes);
wakes.push = (w) => (pushed++, push(w));
// An agent that takes every wake at once.
wakes.onReady(() => void wakes.takeForTurn());
const state: ToolState = { cwd: dir, projectRoot: dir, fileState: new Map(), todos: [], shells: new Map(), wakes, watchers: new Map() };
const start = (command: string) => startMonitor({ command, description: "perf", timeoutMs: 600_000, ctx: { state, wakes }, env: { PATH: process.env.PATH ?? "" } });

async function measure(name: string, ms: number, setup: () => void) {
    Bun.gc(true);
    const rss0 = process.memoryUsage().rss;
    const cpu0 = process.cpuUsage();
    pushed = 0;
    const t0 = performance.now();
    setup();
    await Bun.sleep(ms);
    const wall = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const events = [...state.shells.values()].reduce((n, s) => n + (s.monitor?.events ?? 0), 0);
    const ended = [...state.shells.values()].filter((s) => s.exitCode !== null).length;
    Bun.gc(true);
    const rss = process.memoryUsage().rss;
    console.log(`${name}: cavvy CPU ${((cpu.user + cpu.system) / 1000).toFixed(0)}ms over ${(wall / 1000).toFixed(1)}s (${(((cpu.user + cpu.system) / 1000 / wall) * 100).toFixed(2)}%), ${events} events, ${pushed} wakes, ${ended} ended, RSS ${(rss0 / 1e6).toFixed(0)}→${(rss / 1e6).toFixed(0)} MB`);
    await killAllShells({ state });
}

await measure("baseline (no monitors)", 5000, () => {});
await measure("8 quiet monitors (tail -f /dev/null)", 5000, () => {
    for (let i = 0; i < 8; i++) start("tail -f /dev/null");
});
await measure("1 monitor, 4 lines/s", 5000, () => start("while true; do echo tick; sleep 0.25; done"));
await measure("8 monitors, 2 lines/s each", 5000, () => {
    for (let i = 0; i < 8; i++) start("while true; do echo tick; sleep 0.5; done");
});
const t = performance.now();
let stoppedAt = 0;
await measure("firehose (yes)", 3000, () => {
    const m = start("yes spam");
    const iv = setInterval(() => {
        if (m.shell.exitCode !== null) {
            stoppedAt = performance.now() - t;
            clearInterval(iv);
        }
    }, 5);
});
console.log(`firehose stopped after ${stoppedAt.toFixed(0)}ms`);
process.exit(0);
