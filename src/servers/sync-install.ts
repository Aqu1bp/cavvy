// On a server whose sync is on: an agent CLI the user's computer uses and this server lacks is installed here, with
// the CLI's own installer (CliInfo.installCommand), in the background. Signing it in stays the user's: sync never
// carries a sign-in. One try per installer and server start: a failure is said (Settings → Providers offers Install,
// which runs it in a terminal the user watches) and not retried behind their back.

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { agentCli } from "../backends/defs";
import { findCli } from "../backends/cli";
import { childEnv } from "../util/env";
import { cavvyHome } from "../config/paths";

/** Long enough for a slow machine's download; an installer that waits on a question never gets an answer here. */
const INSTALL_MS = 10 * 60_000;

const running = new Map<string, Promise<boolean>>();
/** Its installer failed: what it ran (a changed installer is tried again) and the last thing it said. */
const failed = new Map<string, { command: string; error: string }>();

export interface InstallState {
    installing?: boolean;
    installError?: string;
}

/** How installing `id` here stands, for Settings → Providers. */
export function installState(id: string): InstallState {
    if (running.has(id)) return { installing: true };
    const f = failed.get(id);
    return f ? { installError: f.error } : {};
}

/** The ones being installed now. */
export function installing(): string[] {
    return [...running.keys()].sort();
}

/**
 * Starts installing `id` unless it's there, being installed, can't be installed from here, or this installer already
 * failed. Says whether it started. `done` runs when it ends, either way.
 */
export function startInstall(id: string, done: (ok: boolean) => void = () => {}): boolean {
    const def = agentCli(id);
    const command = def?.cli.installCommand;
    if (!def || !command || running.has(id) || findCli(def.id, def.cli)) return false;
    if (failed.get(id)?.command === command) return false;
    const run = (async () => {
        let out = "";
        let errors = "";
        let code: number | null = null;
        try {
            const proc = Bun.spawn(["/bin/sh", "-c", command], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnv(), cwd: process.env.HOME });
            const timer = setTimeout(() => proc.kill(), INSTALL_MS);
            const [a, b] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
            code = await proc.exited;
            clearTimeout(timer);
            out = `${a}\n${b}`;
            errors = b;
        } catch (e) {
            out = (e as Error)?.message ?? String(e);
        }
        try {
            const logs = join(cavvyHome(), "logs");
            mkdirSync(logs, { recursive: true });
            writeFileSync(join(logs, `install-${def.id}.log`), out, { mode: 0o600 });
        } catch {
            // Only the log.
        }
        const found = Boolean(findCli(def.id, def.cli));
        const ok = code === 0 && found;
        if (!ok) {
            // `curl … | sh` ends as the shell does: a download that failed still exits 0, and says why on stderr.
            const error = lastLine(errors) || (code === 0 ? `Installed, but ${def.cli.command} isn't in ~/.local/bin or on the PATH.` : lastLine(out) || (code === null ? "Its installer didn't run." : `Its installer stopped (${code}).`));
            failed.set(def.id, { command, error });
        }
        return ok;
    })();
    running.set(def.id, run);
    void run.then((ok) => {
        running.delete(def.id);
        done(ok);
    });
    return true;
}

/** The last line an installer printed, without its terminal colours: what usually says why it stopped. */
function lastLine(out: string): string {
    const lines = out
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    return (lines.at(-1) ?? "").slice(0, 200);
}
