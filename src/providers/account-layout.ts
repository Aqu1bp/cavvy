// A Harness-made (managed) account's CLI home shares Default's configuration and
// history through symlinks, so accounts differ only in sign-in. Only links are made in
// the account folder; an entry already there that isn't Harness's link stays as it is
// and is reported. In Default, at most an empty history folder is made. Nothing here
// opens a file: links are made from names and metadata only.
import { lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, type Stats } from "fs";
import { join } from "path";

/**
 * Claude Code: an explicit allowlist (https://code.claude.com/docs/en/claude-directory).
 * Configuration the user writes, and the history resume, rewind, plans, task lists and
 * prompt recall read. Everything else is the account's: `.claude.json` (account and
 * app state, user MCP servers), `.credentials.json`, `backups/` (copies of
 * `.claude.json`), caches, server-managed and policy files fetched for the signed-in
 * organization, usage stats, and per-process state (sessions, session-env,
 * shell-snapshots, jobs, daemon, ide, debug, telemetry, uploads).
 */
export const CLAUDE_SHARED: readonly string[] = [
    "settings.json", "CLAUDE.md", "rules", "agents", "commands", "output-styles", "workflows", "agent-memory", "keybindings.json", "themes",
    "projects", "file-history", "plans", "tasks", "history.jsonl", "paste-cache",
];
/**
 * Made in Default when it's missing, so the first run of either shares it: otherwise
 * the account's CLI would make its own and keep its history apart from then on.
 */
const CLAUDE_HISTORY = ["projects", "file-history", "plans", "tasks", "paste-cache"];
/**
 * The account's own folders, with Default's entries linked one by one: the claude.ai
 * sync keeps the signed-in account's skills and plugins in `synced/` (in a folder per
 * organization and account) and moves what it drops to `.trash/`; a marketplace hosted
 * on claude.ai is recorded in `known_marketplaces_claudeai.json`.
 */
export const CLAUDE_PER_ENTRY: Readonly<Record<string, readonly string[]>> = {
    skills: ["synced", ".trash"],
    plugins: ["synced", ".trash", "known_marketplaces_claudeai.json"],
};

/**
 * Codex: every entry of Default's home is linked except these (t3code's shadow home,
 * plus what carries an identity here). `auth.json` is the sign-in (the keyring entry
 * is named for the home's own path); `models_cache.json` lists the account's models;
 * `.env` is loaded into Codex's environment and can hold an API key. The app-server
 * daemon and its control socket run with the sign-in they started with, so a client
 * that found Default's would work as Default; `ipc` is the socket of the app that made it.
 */
export const CODEX_PRIVATE: ReadonlySet<string> = new Set([
    "auth.json", "models_cache.json", ".env",
    "app-server-control", "app-server-daemon", "ipc",
    "log", "memories", "tmp", ".DS_Store",
    // A home kept in git: the account folder must not look like a project (accounts.ts refuses those).
    ".git",
]);
const CODEX_HISTORY = ["sessions", "archived_sessions"];
/** Codex makes these locks itself when it starts before Default has them; they guard shared state. */
const CODEX_REPLACEABLE = new Set(["mcp-oauth-locks", ".sqlite-maintenance.lock"]);

function lstat(path: string): Stats | undefined {
    try { return lstatSync(path); } catch (e: any) {
        if (e.code === "ENOENT") return undefined;
        throw e;
    }
}
function isDir(path: string): boolean {
    try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Links `link` to `target`; false when something else is already there. */
function ensureLink(link: string, target: string, replaceable = false): boolean {
    const st = lstat(link);
    if (!st) {
        try { symlinkSync(target, link); } catch (e: any) {
            // Another Harness process laid it out first.
            if (e.code !== "EEXIST") throw e;
            return ensureLink(link, target);
        }
        return true;
    }
    if (st.isSymbolicLink()) return readlinkSync(link) === target;
    if (!replaceable) return false;
    // A runtime lock Codex made in the account folder: rm doesn't follow links inside it.
    rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link);
    return true;
}

function linkEach(folder: string, from: string, names: Iterable<string>, conflicts: string[], prefix = "", replaceable: ReadonlySet<string> = new Set()): void {
    for (const name of names) {
        try {
            if (!ensureLink(join(folder, name), join(from, name), replaceable.has(name))) conflicts.push(prefix + name);
        } catch {
            conflicts.push(prefix + name);
        }
    }
}

function makeHistory(defaultFolder: string, names: readonly string[]): void {
    for (const name of names) {
        try { if (!lstat(join(defaultFolder, name))) mkdirSync(join(defaultFolder, name), { mode: 0o700 }); } catch {}
    }
}

function claudeLayout(folder: string, defaultFolder: string, conflicts: string[]): void {
    makeHistory(defaultFolder, CLAUDE_HISTORY);
    linkEach(folder, defaultFolder, CLAUDE_SHARED.filter((name) => lstat(join(defaultFolder, name))), conflicts);
    for (const [dir, own] of Object.entries(CLAUDE_PER_ENTRY)) {
        const from = join(defaultFolder, dir);
        if (!isDir(from)) continue;
        const local = join(folder, dir);
        try {
            const st = lstat(local);
            if (!st) mkdirSync(local, { mode: 0o700 });
            // Never write through a link or into a file.
            else if (st.isSymbolicLink() || !st.isDirectory()) { conflicts.push(dir); continue; }
            linkEach(local, from, readdirSync(from).filter((name) => !own.includes(name)), conflicts, `${dir}/`);
            // Harness's own links to what Default no longer has.
            for (const name of readdirSync(local)) {
                const link = join(local, name);
                if (lstat(link)?.isSymbolicLink() && readlinkSync(link) === join(from, name) && !lstat(join(from, name))) unlinkSync(link);
            }
        } catch {
            conflicts.push(dir);
        }
    }
}

/** SQLite's files beside a database, which only that database may use. */
const SQLITE_SIDECAR = /^(.+)-(wal|shm|journal)$/;

function codexLayout(folder: string, defaultFolder: string, conflicts: string[]): void {
    makeHistory(defaultFolder, CODEX_HISTORY);
    const names = readdirSync(defaultFolder).filter((name) => !CODEX_PRIVATE.has(name));
    const database = (name: string) => SQLITE_SIDECAR.exec(name)?.[1];
    const sidecars = names.filter((name) => database(name) !== undefined);
    linkEach(folder, defaultFolder, names.filter((name) => !sidecars.includes(name)), conflicts, "", CODEX_REPLACEABLE);
    // Default's write-ahead log beside the account's own database would be applied to it. SQLite
    // finds these beside the database's real path, so they're linked only with a linked database.
    linkEach(folder, defaultFolder, sidecars.filter((name) => isSharedLink(join(folder, database(name)!), defaultFolder, database(name)!)), conflicts);
}

/**
 * Lays out a managed account's `folder` (its real path) to share `defaultFolder`.
 * Idempotent; never fails: what couldn't be shared is returned, by name.
 */
export function ensureSharedLayout(provider: string, folder: string, defaultFolder: string): string[] {
    // Directory symlinks need extra rights on Windows; accounts there start blank as before.
    if (process.platform === "win32" || !isDir(folder) || !isDir(defaultFolder)) return [];
    const conflicts: string[] = [];
    try {
        if (provider === "claude-code") claudeLayout(folder, defaultFolder, conflicts);
        else if (provider === "codex") codexLayout(folder, defaultFolder, conflicts);
    } catch {
        conflicts.push(defaultFolder);
    }
    return conflicts;
}

/** Whether `file` is the link Harness makes to Default's entry of the same name. */
export function isSharedLink(file: string, defaultFolder: string, name: string): boolean {
    try { return lstatSync(file).isSymbolicLink() && readlinkSync(file) === join(defaultFolder, name); } catch { return false; }
}
