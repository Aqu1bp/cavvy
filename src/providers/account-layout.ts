// A Cavvy-made (managed) account's CLI home shares Default's configuration and
// history through symlinks, so accounts differ only in sign-in. Only links are made in
// the account folder, plus Cavvy's own marker file naming the Default they point to;
// an entry already there that isn't Cavvy's link stays as it is and is reported. In
// Default, at most an empty history folder is made.
//
// Files are opened only twice: Cavvy's marker, and Default's Claude Code settings.json,
// which is read for the names of its sign-in settings (never their values, which are
// neither kept nor reported) so that a shared one can't sign every account in as Default.
import { spawnSync } from "child_process";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeSync, type Stats } from "fs";
import { join } from "path";
import { stripJsonComments } from "../util/jsonc";

/**
 * Claude Code: an explicit allowlist (https://code.claude.com/docs/en/claude-directory).
 * Configuration the user writes, and the history resume, rewind, plans, task lists and
 * prompt recall read. Everything else is the account's: `.claude.json` (account and
 * app state, user MCP servers), `.credentials.json`, `backups/` (copies of
 * `.claude.json`), caches, server-managed and policy files fetched for the signed-in
 * organization, usage stats, and per-process state (sessions, session-env,
 * shell-snapshots, jobs, daemon, ide, debug, telemetry, uploads).
 * `settings.json` is shared only while it carries no sign-in (claudeSignInSettings).
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
 * Settings that supply or select the credential Claude Code signs in with, ahead of an
 * account's own login (https://code.claude.com/docs/en/authentication#authentication-precedence,
 * settings-reference and env-vars): helper commands, and `env` variables for API keys,
 * tokens, profiles and federation, and cloud providers and their credentials.
 */
const CLAUDE_SIGN_IN_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh"];
const CLAUDE_SIGN_IN_ENV = new Set([
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_AWS_API_KEY", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_WORKSPACE_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE",
    "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY", "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
]);
const SIGN_IN_ENV_LIKE = /^(ANTHROPIC|CLAUDE)_.*(API_KEY|AUTH_TOKEN|OAUTH_TOKEN|BEARER_TOKEN)$/;

/**
 * Codex: every entry of Default's home is linked except these (t3code's shadow home,
 * plus what carries an identity here). `auth.json` is the sign-in (the keyring entry
 * is named for the home's own path); `secrets/` holds sign-ins encrypted with a key
 * named for the home's own path (codex-rs secrets/src/local.rs); `models_cache.json`
 * lists the account's models; `.env` is loaded into Codex's environment and can hold an
 * API key. The app-server daemon and its control socket run with the sign-in they
 * started with, so a client that found Default's would work as Default; `ipc` is the
 * socket of the app that made it.
 */
export const CODEX_PRIVATE: ReadonlySet<string> = new Set([
    "auth.json", "secrets", "models_cache.json", ".env",
    "app-server-control", "app-server-daemon", "ipc",
    "log", "memories", "tmp", ".DS_Store",
    // A home kept in git: the account folder must not look like a project (accounts.ts refuses those).
    ".git",
]);
/** Private entries an earlier layout linked. */
const CODEX_ONCE_SHARED = ["secrets"];
/**
 * `thread-writer-locks/` lets one writer at a time append to a rollout in the shared
 * sessions (codex-rs rollout/src/writer_lock.rs), so it must be shared with them.
 */
const CODEX_HISTORY = ["sessions", "archived_sessions", "thread-writer-locks"];
/** Codex makes these locks itself when it starts before Default has them; they guard shared state. */
const CODEX_REPLACEABLE = new Set(["mcp-oauth-locks", ".sqlite-maintenance.lock"]);

/** Cavvy's own file in an account folder: the Default folder its links point to. */
export const LAYOUT_MARKER = ".cavvy-shared-from";

export interface SharedLayout {
    /** Entries the account already has of its own, so Default's isn't linked. */
    conflicts: string[];
    /** Default's entries that are deliberately not shared, with why. */
    withheld: string[];
}

interface Layout extends SharedLayout {
    folder: string;
    from: string;
    /** The Default folder the existing links were made for, when it's another. */
    previous?: string;
}

function lstat(path: string): Stats | undefined {
    try { return lstatSync(path); } catch (e: any) {
        if (e.code === "ENOENT") return undefined;
        throw e;
    }
}
function isDir(path: string): boolean {
    try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Whether `rel` in the account is Cavvy's link to the same entry of the current or previous Default. */
function cavvyLink(l: Layout, rel: string): "current" | "previous" | false {
    const st = lstat(join(l.folder, rel));
    if (!st?.isSymbolicLink()) return false;
    const target = readlinkSync(join(l.folder, rel));
    if (target === join(l.from, rel)) return "current";
    return l.previous && target === join(l.previous, rel) ? "previous" : false;
}

/** Removes Cavvy's link at `rel`; anything else stays. */
function dropLink(l: Layout, rel: string): void {
    try { if (cavvyLink(l, rel)) unlinkSync(join(l.folder, rel)); } catch {}
}

/** Links `rel` to Default's; reports a conflict when something else is there. */
function link(l: Layout, rel: string, replaceable: (local: string) => boolean = () => false): void {
    const at = join(l.folder, rel);
    const target = join(l.from, rel);
    try {
        const st = lstat(at);
        if (st?.isSymbolicLink()) {
            const own = cavvyLink(l, rel);
            if (own === "current") return;
            if (own !== "previous") { l.conflicts.push(rel); return; }
            // Default moved (its selector changed): only Cavvy's own link is pointed again.
            unlinkSync(at);
        } else if (st) {
            if (!replaceable(at)) { l.conflicts.push(rel); return; }
            // A runtime lock Codex made in the account folder: rm doesn't follow links inside it.
            rmSync(at, { recursive: true, force: true });
        }
        try { symlinkSync(target, at); } catch (e: any) {
            // Another Cavvy process laid it out first.
            if (e.code !== "EEXIST" || cavvyLink(l, rel) !== "current") throw e;
        }
    } catch {
        if (!l.conflicts.includes(rel)) l.conflicts.push(rel);
    }
}

/** Cavvy's links to the previous Default that the current one has nothing for, among names it links. */
function dropPrevious(l: Layout, links: (name: string) => boolean, dir = ""): void {
    if (!l.previous) return;
    let names: string[];
    try { names = readdirSync(join(l.folder, dir)); } catch { return; }
    for (const name of names.filter(links)) {
        const rel = dir ? join(dir, name) : name;
        if (cavvyLink(l, rel) === "previous" && !lstat(join(l.from, rel))) dropLink(l, rel);
    }
}

function makeHistory(from: string, names: readonly string[]): void {
    for (const name of names) {
        try { if (!lstat(join(from, name))) mkdirSync(join(from, name), { mode: 0o700 }); } catch {}
    }
}

/**
 * The names of Default's sign-in settings, or undefined when they can't be checked.
 * Values are never kept: only whether a key is set.
 */
export function claudeSignInSettings(file: string): string[] | undefined {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch (e: any) {
        return e.code === "ENOENT" ? [] : undefined;
    }
    let settings: unknown;
    try { settings = JSON.parse(stripJsonComments(text)); } catch { return undefined; }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;
    const s = settings as Record<string, unknown>;
    const found = CLAUDE_SIGN_IN_KEYS.filter((key) => s[key] !== undefined && s[key] !== null && s[key] !== "");
    const env = s.env;
    if (env && typeof env === "object" && !Array.isArray(env)) {
        for (const [key, value] of Object.entries(env)) {
            if ((CLAUDE_SIGN_IN_ENV.has(key) || SIGN_IN_ENV_LIKE.test(key)) && value !== undefined && value !== null && value !== "") found.push(`env.${key}`);
        }
    }
    return found;
}

function claudeLayout(l: Layout): void {
    makeHistory(l.from, CLAUDE_HISTORY);
    dropPrevious(l, (name) => CLAUDE_SHARED.includes(name));
    const signIn = claudeSignInSettings(join(l.from, "settings.json"));
    const shared = CLAUDE_SHARED.filter((name) => name !== "settings.json" || signIn?.length === 0);
    if (!signIn || signIn.length) {
        // Its sign-in would come before the account's own login.
        dropLink(l, "settings.json");
        l.withheld.push(signIn
            ? `settings.json, because Default's sets ${signIn.join(", ")}, which would sign this account in as Default`
            : "settings.json, because Default's couldn't be read to check it carries no sign-in");
    }
    for (const name of shared) if (lstat(join(l.from, name))) link(l, name);
    for (const [dir, own] of Object.entries(CLAUDE_PER_ENTRY)) {
        const from = join(l.from, dir);
        const local = join(l.folder, dir);
        try {
            const st = lstat(local);
            if (!isDir(from)) continue;
            if (!st) mkdirSync(local, { mode: 0o700 });
            // Never write through a link or into a file.
            else if (st.isSymbolicLink() || !st.isDirectory()) { l.conflicts.push(dir); continue; }
            dropPrevious(l, (name) => !own.includes(name), dir);
            for (const name of readdirSync(from)) if (!own.includes(name)) link(l, join(dir, name));
            // Cavvy's own links to what Default no longer has.
            for (const name of readdirSync(local)) {
                if (cavvyLink(l, join(dir, name)) === "current" && !lstat(join(from, name))) unlinkSync(join(local, name));
            }
        } catch {
            if (!l.conflicts.includes(dir)) l.conflicts.push(dir);
        }
    }
}

/**
 * Whether any process has a file open under `dir`; undefined when that can't be told.
 * A Codex process holds its thread's writer lock open while it writes to the rollout.
 */
export function filesOpenUnder(dir: string): boolean | undefined {
    if (process.platform === "linux") {
        let pids: string[];
        try { pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p)); } catch { return undefined; }
        for (const pid of pids) {
            let fds: string[];
            try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
            for (const fd of fds) {
                try { if (readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith(dir + "/")) return true; } catch {}
            }
        }
        return false;
    }
    const lsof = ["/usr/sbin/lsof", "/usr/bin/lsof"].find((p) => existsSync(p));
    if (!lsof) return undefined;
    const r = spawnSync(lsof, ["-t", "+D", dir], { encoding: "utf8", timeout: 10_000 });
    if (r.error) return undefined;
    if (r.status === 0) return r.stdout.trim().length > 0;
    // 1: no process has a file open there.
    return r.status === 1 && !r.stdout.trim() ? false : undefined;
}

/** SQLite's files beside a database, which only that database may use. */
const SQLITE_SIDECAR = /^(.+)-(wal|shm|journal)$/;

function codexLayout(l: Layout): void {
    makeHistory(l.from, CODEX_HISTORY);
    dropPrevious(l, (name) => !CODEX_PRIVATE.has(name) && name !== LAYOUT_MARKER);
    // What Cavvy linked before it became private. Other links (auth.json) are never Cavvy's:
    // they stay, and the account's identity check refuses them.
    for (const name of CODEX_ONCE_SHARED) dropLink(l, name);
    const names = readdirSync(l.from).filter((name) => !CODEX_PRIVATE.has(name) && name !== LAYOUT_MARKER);
    const database = (name: string) => SQLITE_SIDECAR.exec(name)?.[1];
    const sidecars = names.filter((name) => database(name) !== undefined);
    const replaceable = (name: string) => (local: string) => CODEX_REPLACEABLE.has(name)
        // The account's own writer locks: only while none is held, or two writers could append to one rollout.
        || (name === "thread-writer-locks" && filesOpenUnder(local) === false);
    for (const name of names.filter((n) => !sidecars.includes(n))) link(l, name, replaceable(name));
    // Default's write-ahead log beside the account's own database would be applied to it. SQLite
    // finds these beside the database's real path, so they're linked only with a linked database.
    for (const name of sidecars) if (cavvyLink(l, database(name)!) === "current") link(l, name);
}

function readMarker(folder: string): string | undefined {
    const file = join(folder, LAYOUT_MARKER);
    try {
        if (!lstatSync(file).isFile()) return undefined;
        const from = JSON.parse(readFileSync(file, "utf8"))?.from;
        return typeof from === "string" && from.startsWith("/") ? from : undefined;
    } catch { return undefined; }
}

function writeMarker(l: Layout): void {
    const file = join(l.folder, LAYOUT_MARKER);
    const st = lstat(file);
    if (st && !st.isFile()) { l.conflicts.push(LAYOUT_MARKER); return; }
    // Never through a link put in its place.
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, JSON.stringify({ from: l.from }) + "\n"); } finally { closeSync(fd); }
}

/**
 * Lays out a managed account's `folder` (its real path) to share `from`, Default's folder.
 * Idempotent; never fails: what couldn't be shared is returned.
 */
export function ensureSharedLayout(provider: string, folder: string, from: string): SharedLayout {
    const l: Layout = { folder, from, conflicts: [], withheld: [] };
    // Directory symlinks need extra rights on Windows; accounts there start blank as before.
    if (process.platform === "win32" || !isDir(folder) || !isDir(from)) return l;
    const previous = readMarker(folder);
    if (previous && previous !== from) l.previous = previous;
    try {
        if (provider === "claude-code") claudeLayout(l);
        else if (provider === "codex") codexLayout(l);
        writeMarker(l);
    } catch {
        l.conflicts.push(from);
    }
    return { conflicts: l.conflicts, withheld: l.withheld };
}

/** Whether `file` is the link Cavvy makes to Default's entry of the same name. */
export function isSharedLink(file: string, defaultFolder: string, name: string): boolean {
    try { return lstatSync(file).isSymbolicLink() && readlinkSync(file) === join(defaultFolder, name); } catch { return false; }
}
