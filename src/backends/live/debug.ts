// HARNESS_DEBUG=1: what the live CLI layer sends and hears, and why it starts,
// adopts or wakes turns, one JSON line per event in ~/.harness/logs/live-cli.log
// (or the file HARNESS_DEBUG_FILE names). For checking live runs against the
// real CLIs. Methods, ids and statuses only: no prompts, outputs or tokens.

import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { paths } from "../../config/paths";

let file: string | undefined | null = null;

function target(): string | undefined {
    if (file !== null) return file;
    if (!process.env.HARNESS_DEBUG) return (file = undefined);
    file = process.env.HARNESS_DEBUG_FILE || join(paths.logs(), "live-cli.log");
    try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    } catch {
        file = undefined;
    }
    return file;
}

/** Whether HARNESS_DEBUG is on (read once). */
export function liveDebugOn(): boolean {
    return target() !== undefined;
}

/** One line: what happened (`what`), for which CLI session, and its details. */
export function liveDebug(scope: string, what: string, details: Record<string, unknown> = {}): void {
    const f = target();
    if (!f) return;
    try {
        appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, scope, what, ...details }) + "\n", { mode: 0o600 });
    } catch {
        // Logging must never break a turn.
    }
}
