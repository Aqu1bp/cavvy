// Where a named account's Claude Code keeps its auto memory. Claude Code puts it under its config folder
// (<CLAUDE_CONFIG_DIR>/projects/<repository>/memory), which for a named account is inside the account folders
// Cavvy denies (#375): the session couldn't open or save a memory. A Cavvy-made account's projects/ links to
// Default's, so the same files are reachable by their real path, outside those folders. Its documented
// autoMemoryDirectory setting points Claude Code there, and nothing denied is opened up.
import { existsSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, resolve, sep } from "path";
import { accountProtectionFolders } from "./account-permissions";
import { accountRealPath, historyFolder } from "../providers/accounts";
import { claudePathSlug } from "./claude-live";

const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);

/**
 * The folder Claude Code names a session's memory after: the repository's main working tree (its worktrees and
 * subfolders share one), else the folder itself, by real path. Undefined for a layout whose name isn't known for
 * sure (a submodule, a bare repository's worktree, an unreadable .git file).
 */
export function claudeMemoryRoot(cwd: string): string | undefined {
    let real: string;
    try { real = accountRealPath(resolve(cwd)); } catch { return undefined; }
    for (let d = real; ; d = dirname(d)) {
        const git = join(d, ".git");
        let st;
        try { st = statSync(git); } catch { st = undefined; }
        if (st?.isDirectory()) return d;
        if (st?.isFile()) {
            try {
                const at = readFileSync(git, "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
                if (!at) return undefined;
                const gitdir = resolve(d, at);
                const common = join(gitdir, "commondir");
                if (!existsSync(common)) return undefined;
                const main = resolve(gitdir, readFileSync(common, "utf8").trim());
                return basename(main) === ".git" ? accountRealPath(dirname(main)) : undefined;
            } catch {
                return undefined;
            }
        }
        if (dirname(d) === d) return real;
    }
}

/** Whether a settings file sets autoMemoryDirectory itself (then it's the user's choice, left alone). */
function setsMemory(file: string): boolean {
    try {
        const v = JSON.parse(readFileSync(file, "utf8"))?.autoMemoryDirectory;
        return typeof v === "string" && v.length > 0;
    } catch {
        return false;
    }
}

/**
 * The autoMemoryDirectory to give Claude Code for a session whose config folder is `configDir`: its memory by real
 * path, when Cavvy denies the path Claude Code would use and the real one isn't denied. Undefined otherwise (Default,
 * no named accounts, an account with history of its own, a setting of the user's own, an unsure repository layout).
 */
export function claudeMemoryDirectory(configDir: string | undefined, cwd: string, trusted: boolean): string | undefined {
    if (!configDir) return undefined;
    const denied = accountProtectionFolders();
    if (!denied.length) return undefined;
    const given = resolve(configDir, "projects");
    if (!denied.some((f) => inside(given, f))) return undefined;
    const history = historyFolder("claude-code", configDir);
    if (!history || denied.some((f) => inside(history, f))) return undefined;
    const root = claudeMemoryRoot(cwd);
    // A worktree's or subfolder's local settings can be the main checkout's.
    const projects = trusted ? [...new Set([cwd, ...(root ? [root] : [])])] : [];
    const settings = [join(configDir, "settings.json"), ...projects.flatMap((d) => [join(d, ".claude", "settings.json"), join(d, ".claude", "settings.local.json")])];
    if (settings.some(setsMemory)) return undefined;
    const pinned = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    if (pinned && /^[A-Za-z0-9_-]{1,64}$/.test(pinned)) return join(history, pinned, "memory");
    return root ? join(history, claudePathSlug(root), "memory") : undefined;
}
