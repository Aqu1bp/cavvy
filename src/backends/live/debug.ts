// CAVVY_DEBUG=1: what the live CLI layer sends and hears, and why it starts,
// adopts or wakes turns, one JSON line per event in ~/.cavvy/logs/live-cli.log
// (or the file CAVVY_DEBUG_FILE names). For checking live runs against the
// real CLIs. Methods, ids and statuses only: no prompts, outputs or tokens.

import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { paths } from "../../config/paths";

/** The file for the settings it was worked out for (CAVVY_DEBUG, CAVVY_DEBUG_FILE): again when they change. */
let cached: { env: string; file: string | undefined } | undefined;

function target(): string | undefined {
    const on = process.env.CAVVY_DEBUG;
    const env = `${on ?? ""}\0${process.env.CAVVY_DEBUG_FILE ?? ""}`;
    if (cached?.env === env) return cached.file;
    let file: string | undefined = on ? process.env.CAVVY_DEBUG_FILE || join(paths.logs(), "live-cli.log") : undefined;
    if (file) {
        try {
            mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        } catch {
            file = undefined;
        }
    }
    cached = { env, file };
    return file;
}

/** Whether CAVVY_DEBUG is on. */
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
