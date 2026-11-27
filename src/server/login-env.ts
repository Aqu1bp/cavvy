// Apps started from the Dock, Finder or a desktop launcher don't get the PATH
// your shell sets up (Homebrew, nvm, cargo, …), so commands the agent runs
// wouldn't find your tools. The desktop app's server asks your login shell
// for its PATH once at startup and adds what's missing.

import { execFile } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { delimiter } from "path";
import { settlePathAfter } from "../util/env";

const MARK = "__CAVVY_PATH__";

/** Expand `%VAR%` references in Windows Registry REG_EXPAND_SZ Path entries. */
function expandWinEnv(value: string, env: Record<string, string | undefined> = process.env): string {
    const lower = new Map<string, string>();
    for (const [k, v] of Object.entries(env)) if (v !== undefined) lower.set(k.toLowerCase(), v);
    return value.replace(/%([^%]+)%/g, (m, name: string) => lower.get(name.toLowerCase()) ?? m);
}

/** Parse the `Path  REG_*  <value>` line from `reg query`. */
export function parseRegPath(output: string): string | undefined {
    for (const line of output.split(/\r?\n/)) {
        const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line);
        if (m?.[1]?.trim()) return m[1].trim();
    }
    return undefined;
}

/** Machine and user PATH as recorded in the Windows Registry, so a long-running service sees tools installed since boot. */
async function windowsRegistryPath(timeoutMs = 4000): Promise<string | undefined> {
    const regExe = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\reg.exe`;
    const query = (key: string): Promise<string | undefined> =>
        new Promise((resolve) => {
            execFile(regExe, ["query", key, "/v", "Path"], { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (err, stdout) => {
                resolve(err ? undefined : parseRegPath(stdout));
            });
        });
    const [machine, user] = await Promise.all([
        query("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"),
        query("HKCU\\Environment"),
    ]);
    const parts = [user, machine].filter((p): p is string => Boolean(p)).map((p) => expandWinEnv(p));
    return parts.length ? parts.join(";") : undefined;
}

/** PATH as your interactive login shell (or Windows Registry) sets it, or undefined if that couldn't be found out. */
export async function loginShellPath(timeoutMs = 4000): Promise<string | undefined> {
    if (process.platform === "win32") return windowsRegistryPath(timeoutMs);
    const shell = process.env.SHELL && /^\/[\w./-]+$/.test(process.env.SHELL) ? process.env.SHELL : process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
    try {
        const proc = Bun.spawn([shell, "-ilc", `printf '\\n${MARK}%s${MARK}\\n' "$PATH"`], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
            env: { ...process.env, TERM: "dumb", CAVVY_LOGIN_ENV: "1" } as Record<string, string>,
        });
        const timer = setTimeout(() => proc.kill(), timeoutMs);
        const out = await new Response(proc.stdout).text();
        clearTimeout(timer);
        const m = out.match(new RegExp(`${MARK}(.*?)${MARK}`));
        return m?.[1] || undefined;
    } catch {
        return undefined;
    }
}

/** The login shell's PATH entries first, then any of ours it doesn't have. */
export function mergePath(current: string | undefined, login: string | undefined, sep = delimiter, caseInsensitive = process.platform === "win32"): string | undefined {
    if (!login) return current;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of [...login.split(sep), ...(current ?? "").split(sep)]) {
        if (!p) continue;
        const key = caseInsensitive ? p.toLowerCase() : p;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
    }
    return out.join(sep);
}

/**
 * Takes PATH from your login shell. One that takes seconds to start (nvm, oh-my-zsh) shouldn't hold up the app: what it said
 * last time, remembered in `file`, is used at once and its answer takes over when it comes. Only a first launch waits.
 * Bun.which doesn't see this (it reads the PATH the process started with): pass it `{ PATH: process.env.PATH }`.
 */
export async function adoptLoginPath(file: string) {
    const started = process.env.PATH;
    let remembered: string | undefined;
    try {
        remembered = readFileSync(file, "utf8");
    } catch {
        remembered = undefined;
    }
    const answered = loginShellPath().then((login) => {
        if (!login) return;
        process.env.PATH = mergePath(started, login);
        if (login !== remembered) {
            try {
                writeFileSync(file, login, "utf8");
            } catch {
                // best effort
            }
        }
    });
    settlePathAfter(answered);
    if (remembered) process.env.PATH = mergePath(started, remembered);
    else await answered;
    return { answered };
}
