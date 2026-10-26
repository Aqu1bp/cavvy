// Cavvy was called Harness. What a Harness install left behind is moved once
// (the home folder, the account markers in it, the paths its files store) or
// still read where it can't be moved: a project's .harness/ and HARNESS.md,
// worktree markers, keychain items (moved when first read), rules and hooks
// written with the old names. Everything that knows the old name is here or
// names this module.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, sep } from "path";

export const LEGACY = {
    /** The app's name, as APP_NAME was. */
    name: "harness",
    /** ~/.harness, and a project's .harness/. */
    dir: ".harness",
    memory: "HARNESS.md",
    localMemory: "HARNESS.local.md",
    keychainService: "harness-cli",
    accountMarker: ".harness-shared-from",
    worktreeMarker: "harness-worktree.json",
    worktreePresent: "harness-present",
    /** In the git dir of the worktree desktop:update builds in (scripts/update-desktop.ts). */
    appSourceMarker: "harness-app-source",
    pluginManifestDir: ".harness-plugin",
    /** The MCP server's name, so its tools were mcp__harness__…. */
    mcpServer: "harness",
    /** What Codex recorded as the originator of the threads Harness started. */
    codexClient: "harness_cli",
    envPrefix: "HARNESS_",
} as const;

/** Files in the home folder that store absolute paths into it. */
const PATH_FILES = ["providers.json", join("plugins", "installed_plugins.json"), join("plugins", "known_marketplaces.json")];

export interface HomeMove {
    /** The folder to use: `home`, or `legacy` when it couldn't be moved. */
    home: string;
    /** What happened, for the user; empty when there was nothing to do. */
    notes: string[];
}

/**
 * Written into Harness's home just before it moves, and removed once what follows
 * the move is done: a move that stopped partway (a crash, a file that couldn't be
 * written, another process that moved it first) is finished by the next start.
 */
const MOVING = ".moving-from-harness.json";

/**
 * Moves Harness's home folder (`legacy`) to Cavvy's (`home`) when only the old one
 * exists, and leaves a link at the old place, so the absolute paths an older
 * session, plugin or account stored keep leading to the files. The paths in the
 * files that check them exactly (accounts, plugins) are rewritten, and the account
 * folders' markers renamed. Safe to call from several processes at once: one
 * rename wins, and each finishes what follows it (every step can be done twice).
 */
export function moveLegacyHome(home: string, legacy: string): HomeMove {
    if (!exists(home) && exists(legacy)) {
        let from: string;
        try {
            from = realpathSync(legacy);
        } catch {
            return { home, notes: [] }; // a link to nowhere: nothing to move
        }
        try {
            writeFileSync(join(legacy, MOVING), JSON.stringify({ from }) + "\n");
            renameSync(legacy, home);
        } catch (e: any) {
            if (!exists(home)) {
                rmSync(join(legacy, MOVING), { force: true });
                return { home: legacy, notes: [`Couldn't move ${legacy} to ${home} (${e?.code ?? e?.message ?? e}); using ${legacy} for now.`] };
            }
            // Another process moved it: this one finishes the move too.
        }
    }
    if (exists(join(home, MOVING))) return { home, notes: finishMove(home, legacy) };
    if (exists(legacy) && !sameFolder(legacy, home)) {
        return { home, notes: [`Both ${legacy} (Harness's) and ${home} exist. Cavvy uses ${home}, and protects ${legacy} as it does its own; move what you need from it, then delete it.`] };
    }
    return { home, notes: [] };
}

/** What follows the move. Each step leaves what's done as it is; the marker goes only once all are. */
function finishMove(home: string, legacy: string): string[] {
    const moving = join(home, MOVING);
    let from: string | undefined;
    try {
        from = JSON.parse(readFileSync(moving, "utf8")).from;
    } catch {
        // Only the old place, then.
    }
    const notes: string[] = [];
    let done = true;
    if (!exists(legacy)) {
        try {
            symlinkSync(home, legacy);
        } catch (e: any) {
            if (!exists(legacy)) notes.push(`Couldn't leave a link at ${legacy} (${e?.code ?? e}): files that name it won't be found there.`);
        }
    }
    const olds = [...new Set([legacy, ...(typeof from === "string" ? [from] : [])])];
    for (const file of PATH_FILES) {
        try {
            rewritePaths(join(home, file), olds, home);
        } catch (e: any) {
            done = false;
            notes.push(`Couldn't update the paths in ${join(home, file)} (${e?.message ?? e}).`);
        }
    }
    const memory = join(home, LEGACY.memory);
    if (exists(memory) && !exists(join(home, "CAVVY.md"))) {
        try {
            renameSync(memory, join(home, "CAVVY.md"));
        } catch {
            // Still read by its old name (paths.userMemory).
        }
    }
    const accounts = renameAccountMarkers(join(home, "accounts"));
    if (!accounts.renamed) done = false;
    if (!done) return [...notes, `Moving ${legacy} to ${home} isn't finished; Cavvy tries again when it next starts.`];
    rmSync(moving, { force: true });
    return [`Harness is now Cavvy: moved ${legacy} to ${home}.`, ...notes, ...(accounts.claude ? [`Named Claude Code accounts need one sign-in again: their sign-in is kept under their folder's path, which moved.`] : [])];
}

function sameFolder(a: string, b: string): boolean {
    try {
        return realpathSync(a) === realpathSync(b);
    } catch {
        return false;
    }
}

function exists(p: string): boolean {
    try {
        lstatSync(p);
        return true;
    } catch {
        return false;
    }
}

/** Each string that is one of `olds` or inside it now says `to` instead. Unchanged files aren't written. */
export function rewritePaths(file: string, olds: string[], to: string): void {
    if (!existsSync(file)) return;
    const text = readFileSync(file, "utf8");
    let changed = false;
    const fix = (v: unknown): unknown => {
        if (typeof v === "string") {
            for (const old of olds) {
                if (v === old || v.startsWith(old + sep)) {
                    changed = true;
                    return to + v.slice(old.length);
                }
            }
            return v;
        }
        if (Array.isArray(v)) return v.map(fix);
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
        return v;
    };
    const data = fix(JSON.parse(text));
    if (!changed) return;
    const tmp = join(dirname(file), `.${Date.now()}-${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: lstatSync(file).mode & 0o777 });
    renameSync(tmp, file);
}

/** accounts/<provider>/<id>/.harness-shared-from → .cavvy-shared-from. Says whether a Claude Code account was there, and whether each marker was renamed. */
function renameAccountMarkers(accounts: string): { claude: boolean; renamed: boolean } {
    let claude = false;
    let renamed = true;
    for (const provider of list(accounts)) {
        for (const id of list(join(accounts, provider))) {
            if (id.startsWith(".")) continue; // .leases
            if (provider === "claude-code") claude = true;
            const old = join(accounts, provider, id, LEGACY.accountMarker);
            const now = join(accounts, provider, id, ".cavvy-shared-from");
            if (exists(old) && !exists(now)) {
                try {
                    renameSync(old, now);
                } catch {
                    renamed = false; // tried again next start; meanwhile the account doesn't share the default folder's files
                }
            }
        }
    }
    return { claude, renamed };
}

function list(dir: string): string[] {
    try {
        return readdirSync(dir).filter((n) => {
            try {
                return lstatSync(join(dir, n)).isDirectory();
            } catch {
                return false;
            }
        });
    } catch {
        return [];
    }
}

/** The HARNESS_* variables still honored: where the state is (cavvyHome), and keeping keys out of the keychain (credentials.ts). */
const HONORED = ["HARNESS_HOME", "HARNESS_NO_KEYCHAIN"];

/**
 * HARNESS_* variables set in this environment that Cavvy reads as CAVVY_* now.
 * The HONORED ones still work; the rest are only reported.
 */
export function legacyEnvNotes(env: NodeJS.ProcessEnv = process.env): string[] {
    const names = Object.keys(env).filter((k) => k.startsWith(LEGACY.envPrefix) && env[k] !== undefined && !HOOK_ENV.has(k));
    if (!names.length) return [];
    const honored = names.filter((n) => HONORED.includes(n));
    return [`Harness is now Cavvy: set ${names.map((n) => "CAVVY_" + n.slice(LEGACY.envPrefix.length)).join(", ")} instead of ${names.join(", ")}${honored.length ? ` (${honored.join(" and ")} still ${honored.length > 1 ? "work" : "works"} meanwhile)` : ""}.`];
}

/** What Cavvy sets for hooks and plugins, also under the old names so ones written for Harness still run. */
export const HOOK_ENV = new Set(["HARNESS_HOOK_EVENT", "HARNESS_PROJECT_DIR", "HARNESS_PLUGIN_ROOT"]);

/** `dir`/`name`, or `dir`/`legacyName` when only that one exists. */
export function fileIn(dir: string, name: string, legacyName: string): string {
    const now = join(dir, name);
    const old = join(dir, legacyName);
    return !exists(now) && exists(old) ? old : now;
}

/**
 * A file or folder in a project's own folder: in .cavvy/, or in .harness/ when only
 * that one has it. File by file, so a .cavvy/ a repository adds (skills, say)
 * doesn't hide the settings, and the rules in them, still in .harness/.
 */
export function inProjectDir(cwd: string, ...rel: string[]): string {
    const now = join(cwd, ".cavvy", ...rel);
    const old = join(cwd, LEGACY.dir, ...rel);
    return !exists(now) && exists(old) ? old : now;
}

/**
 * A rule's tool written for Harness's own MCP server, as Cavvy's: mcp__harness__x
 * → mcp__cavvy__x, and mcp__harness (the whole server) → mcp__cavvy. Matched in
 * addition to the name as written, which may be a server of the user's own.
 */
export function currentMcpName(name: string, server: string): string {
    const old = `mcp__${LEGACY.mcpServer}`;
    if (name === old) return `mcp__${server}`;
    return name.startsWith(old + "__") ? `mcp__${server}__` + name.slice(old.length + 2) : name;
}

/** The name Harness gave a tool of Cavvy's MCP server (mcp__cavvy__x → mcp__harness__x), for hooks written for it; undefined for other tools. */
export function legacyMcpName(name: string, server: string): string | undefined {
    const now = `mcp__${server}__`;
    return name.startsWith(now) ? `mcp__${LEGACY.mcpServer}__` + name.slice(now.length) : undefined;
}

/** A hook matcher (a list of names or a regex) with each mcp__harness__ in it naming Cavvy's server instead. */
export function legacyMcpMatcher(matcher: string, server: string): string {
    return matcher.replace(new RegExp(`\\bmcp__${LEGACY.mcpServer}(?=__)`, "g"), `mcp__${server}`);
}

/** Tool names as written, each mcp__harness… one followed by its name now (an agent's tools and disallowedTools). */
export function withCurrentMcpNames(names: string[], server: string): string[] {
    return [...new Set(names.flatMap((n) => [n, currentMcpName(n, server)]))];
}

/**
 * Other folders protected as `home` is: the link moveLegacyHome left at ~/.harness,
 * while it leads there (a path through it is a path into the home), and, beside the
 * default home, a ~/.harness that wasn't moved: Harness's own, with its credentials
 * and accounts.
 */
export function homeAliases(home: string, userHome = homedir()): string[] {
    const old = join(userHome, LEGACY.dir);
    if (!exists(old)) return [];
    if (sameFolder(old, home)) return lstatSync(old).isSymbolicLink() ? [old] : [];
    return home === join(userHome, ".cavvy") ? [old] : [];
}
