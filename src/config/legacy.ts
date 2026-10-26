// Cavvy was called Harness. What a Harness install left behind is moved once
// (the home folder, the account markers in it, the paths its files store) or
// still read where it can't be moved: a project's .harness/ and HARNESS.md,
// worktree markers, keychain items (moved when first read), rules and hooks
// written with the old names. Everything that knows the old name is here or
// names this module.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "fs";
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
    /** What happened, for the user; empty when there was nothing to move. */
    notes: string[];
}

/**
 * Moves Harness's home folder (`legacy`) to Cavvy's (`home`) when only the old one
 * exists, and leaves a link at the old place, so the absolute paths an older
 * session, plugin or account stored keep leading to the files. The paths in the
 * files that check them exactly (accounts, plugins) are rewritten, and the account
 * folders' markers renamed. Safe to call from several processes at once: one
 * rename wins, and the others find the new folder.
 */
export function moveLegacyHome(home: string, legacy: string): HomeMove {
    if (exists(home) || !exists(legacy)) return { home, notes: [] };
    let from: string;
    try {
        from = realpathSync(legacy);
    } catch {
        return { home, notes: [] }; // a link to nowhere: nothing to move
    }
    try {
        renameSync(legacy, home);
    } catch (e: any) {
        if (exists(home)) return { home, notes: [] }; // another process moved it
        return { home: legacy, notes: [`Couldn't move ${legacy} to ${home} (${e?.code ?? e?.message ?? e}); using ${legacy} for now.`] };
    }
    const notes = [`Harness is now Cavvy: moved ${legacy} to ${home}.`];
    try {
        symlinkSync(home, legacy);
    } catch (e: any) {
        notes.push(`Couldn't leave a link at ${legacy} (${e?.code ?? e}): files that name it won't be found there.`);
    }
    const to = realpathSync(home);
    for (const file of PATH_FILES) {
        try {
            rewritePaths(join(home, file), [from, legacy], to);
        } catch (e: any) {
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
    const renamed = renameAccountMarkers(join(home, "accounts"));
    if (renamed) notes.push(`Named Claude Code accounts need one sign-in again: their sign-in is kept under their folder's path, which moved.`);
    return { home, notes };
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

/** accounts/<provider>/<id>/.harness-shared-from → .cavvy-shared-from. Returns whether a Claude Code account was there. */
function renameAccountMarkers(accounts: string): boolean {
    let claude = false;
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
                    // The layout is checked again before each use; a missing marker only stops sharing.
                }
            }
        }
    }
    return claude;
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

/**
 * HARNESS_* variables set in this environment that Cavvy reads as CAVVY_* now.
 * HARNESS_HOME is still honored (see cavvyHome); the rest are only reported.
 */
export function legacyEnvNotes(env: NodeJS.ProcessEnv = process.env): string[] {
    const names = Object.keys(env).filter((k) => k.startsWith(LEGACY.envPrefix) && env[k] !== undefined && !HOOK_ENV.has(k));
    if (!names.length) return [];
    return [`Harness is now Cavvy: set ${names.map((n) => "CAVVY_" + n.slice(LEGACY.envPrefix.length)).join(", ")} instead of ${names.join(", ")}${names.includes("HARNESS_HOME") ? " (HARNESS_HOME is still used while CAVVY_HOME isn't set)" : ""}.`];
}

/** What Cavvy sets for hooks and plugins, also under the old names so ones written for Harness still run. */
export const HOOK_ENV = new Set(["HARNESS_HOOK_EVENT", "HARNESS_PROJECT_DIR", "HARNESS_PLUGIN_ROOT"]);

/** `dir`/`name`, or `dir`/`legacyName` when only that one exists. */
export function fileIn(dir: string, name: string, legacyName: string): string {
    const now = join(dir, name);
    const old = join(dir, legacyName);
    return !exists(now) && exists(old) ? old : now;
}

/** A project's own folder for Cavvy's files: .cavvy/, or .harness/ in a project that has only that. */
export function projectDirIn(cwd: string): string {
    return fileIn(cwd, ".cavvy", LEGACY.dir);
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

/**
 * Other names for `home`: the link moveLegacyHome left at ~/.harness, while it
 * still leads there. A path through it is a path into the home folder, so
 * whatever protects the home's files protects them by this name too.
 */
export function homeAliases(home: string, userHome = homedir()): string[] {
    const link = join(userHome, LEGACY.dir);
    try {
        if (!lstatSync(link).isSymbolicLink()) return [];
        return realpathSync(link) === realpathSync(home) ? [link] : [];
    } catch {
        return [];
    }
}
