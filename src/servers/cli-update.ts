// Bringing a server's agent CLIs up to date, when its Cavvy is updated.
//
// A server's CLIs are installed once, as it's set up (keys.ts), and nothing
// run there afterwards asks them to update: a server kept the Claude Code and
// Codex of the day it was made. The server's own Cavvy updates the ones it
// runs (`host update-clis`), each its own way, and only where that needs no
// password. Best effort: what couldn't be updated is said, and stops nothing.

import { accessSync, constants, realpathSync } from "fs";
import { sep } from "path";
import { findCli } from "../backends/cli";
import { agentCli } from "../backends/defs";
import { childEnv } from "../util/env";
import type { SetupProgress } from "./install";
import { REMOTE_DIR } from "./remote";
import { remoteSh, ssh } from "./ssh";
import type { ServerEntry } from "./store";

/** A CLI's update may download all of it (Claude Code is 400 MB). */
export const cliUpdateTiming = { eachMs: 6 * 60_000 };

const CODEX_PACKAGE = "@openai/codex";

async function run(argv: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
    try {
        const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: childEnv() });
        const timer = setTimeout(() => proc.kill(), timeoutMs);
        const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        clearTimeout(timer);
        return { code, stdout };
    } catch {
        return { code: null, stdout: "" };
    }
}

/**
 * Claude Code's own updater: the new version goes beside the one that runs, which sessions keep until they start
 * again. Undefined when it isn't installed.
 */
async function updateClaude(): Promise<boolean | undefined> {
    const def = agentCli("claude-code");
    const bin = def && findCli(def.id, def.cli);
    if (!bin) return undefined;
    return (await run([bin, "update"], cliUpdateTiming.eachMs)).code === 0;
}

/**
 * Codex, where npm installed it for everyone (as a server's start-up script does): by npm again, with sudo only
 * when that asks for nothing. Undefined when it isn't installed, or is some other way (its own installer's keeps
 * itself).
 */
async function updateCodex(): Promise<boolean | undefined> {
    const def = agentCli("codex");
    const bin = def && findCli(def.id, def.cli);
    const npm = Bun.which("npm", { PATH: process.env.PATH ?? "" });
    if (!bin || !npm) return undefined;
    const root = (await run([npm, "root", "-g"], 30_000)).stdout.trim();
    let real: string;
    let from: string;
    try {
        real = realpathSync(bin);
        from = realpathSync(root);
    } catch {
        return undefined;
    }
    if (!root || !real.startsWith(`${from}${sep}${CODEX_PACKAGE.replace("/", sep)}${sep}`)) return undefined;
    const install = [npm, "install", "-g", `${CODEX_PACKAGE}@latest`];
    let writable = true;
    try {
        accessSync(from, constants.W_OK);
    } catch {
        writable = false;
    }
    const sudo = Bun.which("sudo", { PATH: process.env.PATH ?? "" });
    if (!writable && !sudo) return false;
    return (await run(writable ? install : [sudo!, "-n", ...install], cliUpdateTiming.eachMs)).code === 0;
}

/** On the server (`host update-clis`): updates the CLIs this Cavvy runs, and says which it couldn't. */
export async function hostUpdateClis(): Promise<{ failed: string[] }> {
    const done = await Promise.all([updateClaude().then((ok) => ({ ok, product: "Claude Code" })), updateCodex().then((ok) => ({ ok, product: "Codex" }))]);
    return { failed: done.filter((d) => d.ok === false).map((d) => d.product) };
}

const UPDATE = `
bin="${REMOTE_DIR}/current/cavvy"
[ -x "$bin" ] || exit 46
exec "$bin" host update-clis
`;

/**
 * Has a server's Cavvy update its agent CLIs. Returns the products it couldn't; none when the server can't be
 * asked (unreachable, or a Cavvy from before it could): never throws.
 */
export async function updateAgentClis(e: ServerEntry, o: { progress?: SetupProgress; signal?: AbortSignal } = {}): Promise<string[]> {
    o.progress?.step(`Updating agent CLIs on ${e.name}…`);
    try {
        const r = await ssh(e, remoteSh(UPDATE), { timeoutMs: cliUpdateTiming.eachMs + 60_000, signal: o.signal });
        const said = JSON.parse(r.stdout.trim().split("\n").pop() || "null") as { failed?: unknown } | null;
        return Array.isArray(said?.failed) ? said.failed.filter((p): p is string => typeof p === "string").slice(0, 5).map((p) => p.slice(0, 40)) : [];
    } catch {
        return [];
    }
}

/** What's said of CLIs that weren't updated, or undefined. */
export function notUpdatedNote(name: string, failed: string[]): string | undefined {
    if (!failed.length) return undefined;
    return `${failed.join(" and ")} on ${name} ${failed.length === 1 ? "wasn't" : "weren't"} updated.`;
}
