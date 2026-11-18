// This machine's skills and commands, kept on the user's servers as they are here: a skill added on the Mac is in
// a server session's / menu moments later, one deleted goes there too. The one-time copy (copy.ts) carries them
// when a server is added; this keeps them level after that, over the connection this machine keeps to each server
// (watch.ts), each time it connects and whenever one changes here.
//
// What a server has of its own is left alone: a file there is replaced or removed only if this machine put it there
// and it hasn't changed since (the server keeps a record of what it was given: SYNCED_FILE). The same files stay
// here as the copy leaves here: one named like a key, or with a key of a known format in it.

import { createHash, randomUUID } from "crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { cavvyHome, paths } from "../config/paths";
import { matchesSecretPattern } from "../util/secret-patterns";
import { CLI_SYNCED, MAX_FILE, MAX_FILES, MAX_TOTAL, SECRET_NAME, SKIP_DIR } from "./copy";

/** Where each kind is kept, here and (as a path under the home) on a server. */
function syncedRoots(): { from: string; to: string }[] {
    const claude = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    return [
        { from: join(cavvyHome(), "skills"), to: ".cavvy/skills" },
        { from: join(claude, "skills"), to: ".claude/skills" },
        { from: paths.userCommands(), to: ".cavvy/commands" },
    ];
}

/** A path a server takes: under one of the synced folders, in plain parts. */
const SYNCED_PATH = /^\.(cavvy|claude)\/skills\/|^\.cavvy\/commands\//;
export function syncablePath(p: unknown): p is string {
    // Nor Claude Code's own folder there (one recorded as sent before it was left out isn't taken away from a server either).
    if (typeof p !== "string" || p.length > 300 || !SYNCED_PATH.test(p) || /[\0-\x1f\\]/.test(p) || p.startsWith(`${CLI_SYNCED}/`)) return false;
    const parts = p.split("/");
    return parts.length <= 9 && parts.every((x) => x !== "" && x !== "." && x !== "..");
}

export const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** One file as this machine has it: where it goes on a server, and what it holds. */
export interface SyncFile {
    path: string;
    data: string;
    sha: string;
    exec?: boolean;
}

/** This machine's skills and commands that a server should have, by their path there. */
export function localSyncFiles(): Map<string, SyncFile> {
    const out = new Map<string, SyncFile>();
    let total = 0;
    const visit = (from: string, to: string, depth: number, top: boolean) => {
        let names: string[];
        try {
            names = readdirSync(from).sort();
        } catch {
            return;
        }
        for (const name of names) {
            const dest = `${to}/${name}`;
            if (SKIP_DIR.has(name) || dest === CLI_SYNCED || out.size >= MAX_FILES) continue;
            const path = join(from, name);
            try {
                const l = lstatSync(path);
                // A link is followed only at the top (a skill kept elsewhere), as the copy does.
                if (l.isSymbolicLink() && !top) continue;
                const st = statSync(path);
                if (st.isDirectory()) {
                    if (depth > 0) visit(path, dest, depth - 1, false);
                    continue;
                }
                if (!st.isFile() || st.size > MAX_FILE || total + st.size > MAX_TOTAL || SECRET_NAME.test(name) || !syncablePath(dest)) continue;
                const body = readFileSync(path);
                if (!body.includes(0) && matchesSecretPattern(body.toString("utf-8"))) continue;
                total += st.size;
                out.set(dest, { path: dest, data: body.toString("base64"), sha: sha(body), ...(st.mode & 0o111 ? { exec: true } : {}) });
            } catch {
                continue;
            }
        }
    };
    for (const r of syncedRoots()) visit(r.from, r.to, 6, true);
    return out;
}

/** Where a server's `path` (a synced one) is kept here. */
function localPath(path: string): string | undefined {
    const r = syncedRoots().find((r) => path.startsWith(`${r.to}/`));
    return r && join(r.from, path.slice(r.to.length + 1));
}

/** Not there: looked for and missing, not just out of reach. */
function gone(path: string | undefined): boolean {
    if (!path) return false;
    try {
        lstatSync(path);
        return false;
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        return code === "ENOENT" || code === "ENOTDIR";
    }
}

/** Written in full under a name no one else uses, then put in place: never through what's at `dest` meanwhile. */
function writeNew(dest: string, body: Buffer | string, mode: number) {
    // Short, beside it: a long name plus a suffix could pass what the file system takes.
    const tmp = join(dirname(dest), `.${randomUUID()}.tmp`);
    writeFileSync(tmp, body, { mode, flag: "wx" });
    try {
        renameSync(tmp, dest);
    } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
    }
}

/** The folders whose changes are kept level, as they're named here. */
export function syncedFolders(): string[] {
    return syncedRoots().map((r) => r.from);
}

// ---------------------------------------------------------------------------
// On a server

/** What a server was given, by path under its home, with what each file held then. */
const SYNCED_FILE = () => join(cavvyHome(), "synced-files.json");

export function readSynced(): Record<string, string> {
    try {
        const v = JSON.parse(readFileSync(SYNCED_FILE(), "utf-8"));
        const out: Record<string, string> = {};
        if (v && typeof v === "object") for (const [k, h] of Object.entries(v)) if (syncablePath(k) && typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) out[k] = h;
        return out;
    } catch {
        return {};
    }
}

function writeSynced(record: Record<string, string>) {
    mkdirSync(dirname(SYNCED_FILE()), { recursive: true });
    writeNew(SYNCED_FILE(), JSON.stringify(record), 0o600);
}

/** What's at `path` under `home` now, if it's a plain file reached through plain folders (no link below the synced folder). */
function current(home: string, path: string): { sha?: string; blocked: boolean } {
    const parts = path.split("/");
    // The synced folder itself may be a link (a dotfiles checkout); nothing below it may be.
    const base = parts[0] === ".cavvy" && parts[1] === "commands" ? 2 : 3;
    for (let i = base; i <= parts.length; i++) {
        const at = join(home, ...parts.slice(0, i));
        try {
            const l = lstatSync(at);
            if (l.isSymbolicLink()) return { blocked: true };
            if (i === parts.length) return l.isFile() ? { sha: sha(readFileSync(at)), blocked: false } : { blocked: true };
            if (!l.isDirectory()) return { blocked: true };
        } catch (e) {
            // Not there: written. Anything else (no permission, an I/O error): left alone.
            return { blocked: (e as NodeJS.ErrnoException).code !== "ENOENT" };
        }
    }
    return { blocked: false };
}

/**
 * Takes what another machine of the user's sends: each file written unless the server has one of its own there, or
 * one it was given that has changed since; each removal done only for a file it was given and that's as it was.
 * Returns how many files changed.
 */
export function applySync(files: unknown, remove: unknown, home = homedir()): { written: number; removed: number } {
    const record = readSynced();
    let written = 0;
    let removed = 0;
    try {
        take();
    } finally {
        // What was done before a failure is recorded, or the next sync takes it for the server's own.
        writeSynced(record);
    }
    return { written, removed };

    function take() {
        for (const f of Array.isArray(files) ? files : []) {
            if (!f || typeof f !== "object" || !syncablePath(f.path) || typeof f.data !== "string") continue;
            const body = Buffer.from(f.data, "base64");
            if (body.length > MAX_FILE) continue;
            const now = current(home, f.path);
            if (now.blocked) continue;
            const h = sha(body);
            // As this machine has it already (the one-time copy put it there): taken as given.
            if (now.sha === h) {
                record[f.path] = h;
                continue;
            }
            // Its own (never given), or given and changed there since: left as it is.
            if (now.sha !== undefined && now.sha !== record[f.path]) continue;
            const dest = join(home, f.path);
            mkdirSync(dirname(dest), { recursive: true });
            writeNew(dest, body, f.exec === true ? 0o755 : 0o644);
            record[f.path] = h;
            written++;
        }
        for (const path of Array.isArray(remove) ? remove : []) {
            if (!syncablePath(path) || !(path in record)) continue;
            const now = current(home, path);
            if (now.blocked) continue;
            if (now.sha !== undefined && now.sha !== record[path]) {
                // Changed there since: it's the server's now.
                delete record[path];
                continue;
            }
            if (now.sha !== undefined) {
                rmSync(join(home, path), { force: true });
                removed++;
                // A skill's folder left empty goes with it, up to the synced folder.
                let dir = dirname(join(home, path));
                const stop = new Set([".cavvy/skills", ".claude/skills", ".cavvy/commands"].map((r) => join(home, r)));
                while (!stop.has(dir) && dir.startsWith(home)) {
                    try {
                        rmdirSync(dir);
                    } catch {
                        break;
                    }
                    dir = dirname(dir);
                }
            }
            delete record[path];
        }
    }
}

/** Under this much a message: a server takes 48 MB, and a few MB at a time keeps one call short. */
const BATCH_BYTES = 4 * 1024 * 1024;

/**
 * Brings a server level with this machine: asks it what it was given, then sends what's new or changed and what's
 * gone. `ask` is a call over the connection to it.
 */
export async function syncTo(ask: (method: string, params: Record<string, unknown>) => Promise<unknown>): Promise<void> {
    const mine = localSyncFiles();
    const theirs = await ask("sync.files", {});
    const given = theirs && typeof theirs === "object" ? (theirs as Record<string, unknown>) : {};
    const send = [...mine.values()].filter((f) => given[f.path] !== f.sha);
    // Gone here, not just left out of this scan (too many or too big, unreadable a moment): gone there.
    const remove = Object.keys(given).filter((p) => syncablePath(p) && !mine.has(p) && gone(localPath(p)));
    if (!send.length && !remove.length) return;
    let batch: SyncFile[] = [];
    let size = 0;
    for (const f of send) {
        if (batch.length && size + f.data.length > BATCH_BYTES) {
            await ask("sync.apply", { files: batch, remove: [] });
            batch = [];
            size = 0;
        }
        batch.push(f);
        size += f.data.length;
    }
    await ask("sync.apply", { files: batch, remove });
}

