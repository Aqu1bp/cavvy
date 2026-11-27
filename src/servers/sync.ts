// This machine's skills, commands, custom agents, memory, themes and keybindings, kept on the user's servers as they
// are here: a skill, memory note, theme or setting changed on this machine reaches every connected server moments
// later, and any offline server catches up when it reconnects.
//
// What a server has of its own is left alone: a file there is replaced or removed only if this machine put it there
// and it hasn't changed since (the server keeps a record of what it was given: SYNCED_FILE). Files named like a key,
// or holding a key of a known format, stay here. CLI subscription credentials are never read, copied or synced.
//
// Several of the user's computers can sync one server: it keeps what both send. The record says what each one last
// sent, so a computer sends only what changed on it, and the newest change to a file is the one the server has. One
// that starts syncing adds what the server lacks without replacing what another sent, and a file goes from the server
// only once no computer still has it.

import { createHash, randomUUID } from "crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { cavvyHome, paths } from "../config/paths";
import { matchesSecretPattern } from "../util/secret-patterns";
import { cliOwned, isProtectedCredentialPath, MAX_FILE, MAX_FILES, MAX_TOTAL, SECRET_NAME, SKIP_DIR } from "./copy";

interface SyncRoot {
    from: string;
    to: string;
}

interface SyncSingle {
    from: string;
    to: string;
}

const claudeDir = (home?: string) => (home !== undefined ? join(home, ".claude") : process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
const codexDir = (home?: string) => (home !== undefined ? join(home, ".codex") : process.env.CODEX_HOME || join(homedir(), ".codex"));
const cavvyDir = (home?: string) => (home !== undefined ? join(home, ".cavvy") : cavvyHome());
const agentsDir = (home?: string) => (home !== undefined ? join(home, ".agents") : process.env.CAVVY_AGENTS_HOME || join(homedir(), ".agents"));

/** Folder trees kept level, here and (as a path under home) on a server. */
function syncedRoots(): SyncRoot[] {
    const claude = claudeDir();
    const codex = codexDir();
    return [
        { from: join(cavvyHome(), "skills"), to: ".cavvy/skills" },
        { from: join(claude, "skills"), to: ".claude/skills" },
        { from: join(codex, "skills"), to: ".codex/skills" },
        { from: join(agentsDir(), "skills"), to: ".agents/skills" },
        { from: paths.userCommands(), to: ".cavvy/commands" },
        { from: join(claude, "commands"), to: ".claude/commands" },
        { from: paths.userAgents(), to: ".cavvy/agents" },
        { from: join(claude, "agents"), to: ".claude/agents" },
        { from: join(cavvyHome(), "agent-memory"), to: ".cavvy/agent-memory" },
        { from: join(cavvyHome(), "themes"), to: ".cavvy/themes" },
        { from: join(claude, "rules"), to: ".claude/rules" },
    ];
}

/** Individual files kept level, here and (as a path under home) on a server. */
function syncedSingleFiles(): SyncSingle[] {
    const claude = claudeDir();
    const codex = codexDir();
    return [
        { from: paths.userMemory(), to: ".cavvy/CAVVY.md" },
        { from: join(claude, "CLAUDE.md"), to: ".claude/CLAUDE.md" },
        { from: join(codex, "AGENTS.md"), to: ".codex/AGENTS.md" },
        { from: join(codex, "AGENTS.override.md"), to: ".codex/AGENTS.override.md" },
        { from: join(cavvyHome(), "keybindings.json"), to: ".cavvy/keybindings.json" },
    ];
}

/** What a server gets before its sync is turned on (ServerEntry.sync): skills and commands. */
const BASIC_PATH = /^\.(cavvy|claude)\/skills\/|^\.cavvy\/commands\//;

const SYNCED_DIR_PATH = /^(\.(cavvy|claude|codex|agents)\/skills\/|\.(cavvy|claude)\/(commands|agents)\/|\.cavvy\/(themes|agent-memory)\/|\.claude\/rules\/)/;
const SYNCED_SINGLE_PATHS = new Set([
    ".cavvy/CAVVY.md",
    ".claude/CLAUDE.md",
    ".codex/AGENTS.md",
    ".codex/AGENTS.override.md",
    ".cavvy/keybindings.json",
]);

/** A path a server takes: under one of the synced folders or one of the synced single files, in plain parts. */
export function syncablePath(p: unknown): p is string {
    if (typeof p !== "string" || p.length > 300 || /[\0-\x1f\\]/.test(p) || cliOwned(p)) return false;
    if (!SYNCED_SINGLE_PATHS.has(p) && !SYNCED_DIR_PATH.test(p)) return false;
    const parts = p.split("/");
    if (parts.length > 9 || !parts.every((x) => x !== "" && x !== "." && x !== "..")) return false;
    // Never accept secret-named files on the server side either.
    if (SECRET_NAME.test(parts.at(-1)!)) return false;
    return true;
}

export const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** One file as this machine has it: where it goes on a server, and what it holds. */
export interface SyncFile {
    path: string;
    data: string;
    sha: string;
    exec?: boolean;
}

/** This machine's skills, commands, agents, memory, themes and keybindings that a server should have, by their path there. */
export function localSyncFiles(): Map<string, SyncFile> {
    const out = new Map<string, SyncFile>();
    let total = 0;
    const takeFile = (path: string, dest: string) => {
        if (out.size >= MAX_FILES || !syncablePath(dest)) return;
        try {
            const st = statSync(path);
            if (!st.isFile() || st.size > MAX_FILE || total + st.size > MAX_TOTAL || SECRET_NAME.test(basename(path))) return;
            // Check resolved symlink target BEFORE opening so a linked file can never read CLI credentials or secret dirs.
            if (isProtectedCredentialPath(path)) return;
            const body = readFileSync(path);
            if (!body.includes(0) && matchesSecretPattern(body.toString("utf-8"))) return;
            total += st.size;
            out.set(dest, { path: dest, data: body.toString("base64"), sha: sha(body), ...(st.mode & 0o111 ? { exec: true } : {}) });
        } catch {
            // unreadable or gone
        }
    };
    const visit = (from: string, to: string, depth: number, top: boolean) => {
        let names: string[];
        try {
            names = readdirSync(from).sort();
        } catch {
            return;
        }
        for (const name of names) {
            const dest = `${to}/${name}`;
            if (SKIP_DIR.has(name) || cliOwned(dest) || out.size >= MAX_FILES) continue;
            const path = join(from, name);
            try {
                const l = lstatSync(path);
                // A link is followed only at the top (a skill or agent kept elsewhere), as the copy does.
                if (l.isSymbolicLink() && !top) continue;
                const st = statSync(path);
                if (st.isDirectory()) {
                    if (isProtectedCredentialPath(path)) continue;
                    if (depth > 0) visit(path, dest, depth - 1, false);
                    continue;
                }
                if (st.isFile()) takeFile(path, dest);
            } catch {
                continue;
            }
        }
    };
    for (const r of syncedRoots()) visit(r.from, r.to, 6, true);
    for (const f of syncedSingleFiles()) takeFile(f.from, f.to);
    return out;
}

/** Where a server's `path` (a synced one) is kept here. */
function localPath(path: string): string | undefined {
    const single = syncedSingleFiles().find((f) => f.to === path);
    if (single) return single.from;
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

/**
 * Watch targets on this machine: recursive trees (the synced folders plus the real target of any top-level
 * symlinked directory inside them, so dotfiles-managed skills live-sync too) and shallow parent directories
 * with the exact filenames whose changes trigger a sync.
 */
export function syncedWatchTargets(): { recursive: string[]; shallow: { dir: string; names: Set<string> }[] } {
    const recursive = new Set<string>();
    for (const r of syncedRoots()) {
        recursive.add(r.from);
        try {
            for (const name of readdirSync(r.from)) {
                if (SKIP_DIR.has(name) || cliOwned(`${r.to}/${name}`)) continue;
                const entry = join(r.from, name);
                try {
                    if (lstatSync(entry).isSymbolicLink() && statSync(entry).isDirectory() && !isProtectedCredentialPath(entry)) {
                        recursive.add(realpathSync(entry));
                    }
                } catch {
                    // broken link
                }
            }
        } catch {
            // root doesn't exist yet
        }
    }
    const byDir = new Map<string, Set<string>>();
    const watchFile = (file: string) => {
        const dir = dirname(file);
        let set = byDir.get(dir);
        if (!set) byDir.set(dir, (set = new Set()));
        set.add(basename(file));
    };
    for (const f of syncedSingleFiles()) watchFile(f.from);
    // Settings, providers, credentials and plugin manifests live-sync via sync-state.ts.
    watchFile(paths.userSettings());
    watchFile(paths.providers());
    watchFile(paths.credentialsFile());
    watchFile(join(paths.plugins(), "known_marketplaces.json"));
    watchFile(join(paths.plugins(), "installed_plugins.json"));
    return {
        recursive: [...recursive],
        shallow: [...byDir.entries()].map(([dir, names]) => ({ dir, names })),
    };
}

// ---------------------------------------------------------------------------
// On a server

/**
 * What a server was given, by path under its home, with what each file held then (`given`); and what each computer
 * that syncs it last sent (`by`, by the id it signed in with). A record from before `by` says nobody's: which computer
 * it was isn't known, and the one syncing first now may be another. Each sends all it has once, and has as its own
 * what the server has as it does, so nothing is taken off for a computer that never had it.
 */
const SYNCED_FILE = () => join(cavvyHome(), "synced-files.json");

interface SyncedFiles {
    given: Record<string, string>;
    by: Record<string, Record<string, string>>;
}

const hashes = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (v && typeof v === "object") for (const [k, h] of Object.entries(v)) if (syncablePath(k) && typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) out[k] = h;
    return out;
};

function readRecord(): SyncedFiles {
    try {
        const v = JSON.parse(readFileSync(SYNCED_FILE(), "utf-8"));
        if (v?.v !== 2) return { given: hashes(v), by: {} };
        const by: SyncedFiles["by"] = {};
        if (v.by && typeof v.by === "object") for (const [m, r] of Object.entries(v.by)) if (typeof m === "string") by[m] = hashes(r);
        return { given: hashes(v.given), by };
    } catch {
        return { given: {}, by: {} };
    }
}

function writeRecord(r: SyncedFiles) {
    mkdirSync(dirname(SYNCED_FILE()), { recursive: true });
    writeNew(SYNCED_FILE(), JSON.stringify({ v: 2, ...r }), 0o600);
}

/** What this server was given, whoever sent it. */
export function readSynced(): Record<string, string> {
    return readRecord().given;
}

/** What computer `from` last sent, which it compares with what it has. */
export function syncedFor(from = ""): Record<string, string> {
    return readRecord().by[from] ?? {};
}

/** A computer signed out of this server for good: what it sent no longer keeps a file here. */
export function forgetSyncedFiles(from: string) {
    const r = readRecord();
    if (!(from in r.by)) return;
    delete r.by[from];
    writeRecord(r);
}

/**
 * Resolves a synced path to its location on the server, respecting CAVVY_HOME, CLAUDE_CONFIG_DIR and CODEX_HOME
 * when `home` isn't explicitly pinned (tests pass an isolated `home`).
 */
function resolveTarget(path: string, home?: string): { root: string; relParts: string[]; isSingle: boolean } {
    const parts = path.split("/");
    const top = parts[0]!;
    const baseDir =
        top === ".cavvy" ? cavvyDir(home)
        : top === ".claude" ? claudeDir(home)
        : top === ".codex" ? codexDir(home)
        : agentsDir(home);
    if (SYNCED_SINGLE_PATHS.has(path)) {
        return { root: baseDir, relParts: parts.slice(1), isSingle: true };
    }
    // Directory roots are always two segments under home (e.g. `.cavvy/skills`, `.claude/rules`).
    return { root: join(baseDir, parts[1]!), relParts: parts.slice(2), isSingle: false };
}

/** What's at `path` on the server now, if it's a plain file reached through plain folders (no link below the synced root). */
function current(path: string, home?: string): { sha?: string; blocked: boolean; dest: string; root: string; isSingle: boolean } {
    const { root, relParts, isSingle } = resolveTarget(path, home);
    const dest = join(root, ...relParts);
    // The synced root itself may be a link (a dotfiles checkout); nothing below it may be.
    for (let i = 1; i <= relParts.length; i++) {
        const at = join(root, ...relParts.slice(0, i));
        try {
            const l = lstatSync(at);
            if (l.isSymbolicLink()) return { blocked: true, dest, root, isSingle };
            if (i === relParts.length) return l.isFile() ? { sha: sha(readFileSync(at)), blocked: false, dest, root, isSingle } : { blocked: true, dest, root, isSingle };
            if (!l.isDirectory()) return { blocked: true, dest, root, isSingle };
        } catch (e) {
            // Not there: written. Anything else (no permission, an I/O error): left alone.
            return { blocked: (e as NodeJS.ErrnoException).code !== "ENOENT", dest, root, isSingle };
        }
    }
    return { blocked: false, dest, root, isSingle };
}

export interface ApplySyncResult {
    written: number;
    removed: number;
    /** Files that changed on the server, as synced paths (used by engine.ts to reload commands, themes and keybindings). */
    changed: string[];
}

/**
 * Takes what computer `from` sends: each file written unless the server has one of its own there, or one it was given
 * that has changed since, or one another computer sent that `from` never changed; each removal done only for a file
 * it was given, that's as it was, and that no other computer still has. Returns how many files changed and which.
 */
export function applySync(files: unknown, remove: unknown, home?: string, from = ""): ApplySyncResult {
    const record = readRecord();
    const given = record.given;
    const mine = (record.by[from] ??= {});
    const others = () => Object.entries(record.by).filter(([m]) => m !== from).map(([, r]) => r);
    let written = 0;
    let removed = 0;
    const changed: string[] = [];
    try {
        take();
    } finally {
        // What was done before a failure is recorded, or the next sync takes it for the server's own.
        writeRecord(record);
    }
    return { written, removed, changed };

    function take() {
        for (const f of Array.isArray(files) ? files : []) {
            if (!f || typeof f !== "object" || !syncablePath(f.path) || typeof f.data !== "string") continue;
            const body = Buffer.from(f.data, "base64");
            if (body.length > MAX_FILE) continue;
            const now = current(f.path, home);
            if (now.blocked) continue;
            const h = sha(body);
            // As this computer has it already (the one-time copy put it there): taken as given.
            if (now.sha === h) {
                given[f.path] = h;
                mine[f.path] = h;
                continue;
            }
            // Its own (never given), or given and changed there since: left as it is.
            if (now.sha !== undefined && now.sha !== given[f.path]) continue;
            // Another computer's, and this one has had it as it is since it started syncing: the other's stays.
            if (now.sha !== undefined && !(f.path in mine) && others().some((r) => f.path in r)) {
                mine[f.path] = h;
                continue;
            }
            mkdirSync(dirname(now.dest), { recursive: true });
            writeNew(now.dest, body, f.exec === true ? 0o755 : 0o644);
            given[f.path] = h;
            mine[f.path] = h;
            written++;
            changed.push(f.path);
        }
        for (const path of Array.isArray(remove) ? remove : []) {
            if (!syncablePath(path)) continue;
            delete mine[path];
            // Another computer still has it: it stays. One that has it otherwise than the server does sends its own next.
            if (!(path in given)) continue;
            const still = others().filter((r) => path in r);
            if (still.length) {
                for (const r of still) if (r[path] !== given[path]) delete r[path];
                continue;
            }
            const now = current(path, home);
            if (now.blocked) continue;
            if (now.sha !== undefined && now.sha !== given[path]) {
                // Changed there since: it's the server's now.
                delete given[path];
                continue;
            }
            if (now.sha !== undefined) {
                rmSync(now.dest, { force: true });
                removed++;
                changed.push(path);
                // A skill's folder left empty goes with it, up to the synced root folder (never for single files).
                if (!now.isSingle) {
                    let dir = dirname(now.dest);
                    while (dir !== now.root && dir.startsWith(now.root)) {
                        try {
                            rmdirSync(dir);
                        } catch {
                            break;
                        }
                        dir = dirname(dir);
                    }
                }
            }
            delete given[path];
        }
    }
}

/** Under this much a message: a server takes 48 MB, and a few MB at a time keeps one call short. */
const BATCH_BYTES = 4 * 1024 * 1024;

export interface SyncFilesResult {
    written: number;
    removed: number;
}

/**
 * Brings a server level with this machine's synced files: asks it what it was given, then sends what's new or
 * changed and what's gone. `ask` is a call over the connection to it.
 */
export async function syncTo(ask: (method: string, params: Record<string, unknown>) => Promise<unknown>, o: { basic?: boolean } = {}): Promise<SyncFilesResult> {
    const all = localSyncFiles();
    // A server whose sync hasn't been turned on gets only what every server always had: skills and commands.
    const mine = o.basic ? new Map([...all].filter(([p]) => BASIC_PATH.test(p))) : all;
    const theirs = await ask("sync.files", {});
    const given = theirs && typeof theirs === "object" ? (theirs as Record<string, unknown>) : {};
    const send = [...mine.values()].filter((f) => given[f.path] !== f.sha);
    // Gone here, not just left out of this scan (too many or too big, unreadable a moment): gone there.
    const remove = Object.keys(given).filter((p) => syncablePath(p) && !mine.has(p) && gone(localPath(p)));
    if (!send.length && !remove.length) return { written: 0, removed: 0 };
    let written = 0;
    let removed = 0;
    let batch: SyncFile[] = [];
    let size = 0;
    const apply = async (files: SyncFile[], rem: string[]) => {
        const res = (await ask("sync.apply", { files, remove: rem })) as { written?: number; removed?: number } | null;
        written += typeof res?.written === "number" ? res.written : 0;
        removed += typeof res?.removed === "number" ? res.removed : 0;
    };
    for (const f of send) {
        if (batch.length && size + f.data.length > BATCH_BYTES) {
            await apply(batch, []);
            batch = [];
            size = 0;
        }
        batch.push(f);
        size += f.data.length;
    }
    await apply(batch, remove);
    return { written, removed };
}

