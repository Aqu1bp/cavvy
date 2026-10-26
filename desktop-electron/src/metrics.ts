// Measurements for the benchmark (bench.ts): with CAVVY_ELECTRON_METRICS naming a file, the app writes to it once
// a second when startup steps happened (ms since the process started) and each of its processes' memory and CPU, by
// role: the main process, the UI's page, each browser tab's page, the GPU and network helpers, and the server. Never
// set in normal use.

import { app } from "electron";
import { writeFileSync } from "node:fs";

/** When the process started, in ms since the epoch. */
const started = Date.now() - process.uptime() * 1000;
const marks: Record<string, number> = {};

/** A startup step: the first time only. */
export function mark(name: string) {
    if (!(name in marks)) marks[name] = Math.round(Date.now() - started);
}

export function startMetrics(o: { ui(): number | undefined; tabs(): number[]; server(): { pid?: number; port?: number; token?: string }; extra?(): unknown }) {
    const file = process.env.CAVVY_ELECTRON_METRICS;
    if (!file) return;
    const write = () => {
        const ui = o.ui();
        const tabs = new Set(o.tabs());
        const procs = app.getAppMetrics().map((m) => ({
            pid: m.pid,
            role: m.pid === process.pid ? "main" : m.pid === ui ? "ui" : tabs.has(m.pid) ? "tab" : m.type === "GPU" ? "gpu" : m.type === "Utility" ? `utility:${m.serviceName ?? m.name ?? ""}` : m.type.toLowerCase(),
            kb: m.memory.workingSetSize,
            privateKb: m.memory.privateBytes,
            // Since the last write: a second's worth.
            cpu: m.cpu.percentCPUUsage,
        }));
        writeFileSync(file, JSON.stringify({ at: Math.round(Date.now() - started), marks, server: o.server(), procs, extra: o.extra?.() }));
    };
    setInterval(write, 1000).unref();
}
