// Project and user instructions ("memory") loaded into the system prompt, in this order:
//
//   ~/.claude/CLAUDE.md, ~/.claude/rules/**/*.md    Claude Code's (CLAUDE_CONFIG_DIR), so they work with every model
//   ~/.codex/AGENTS.override.md or AGENTS.md         Codex's (CODEX_HOME), the first that isn't empty
//   ~/.harness/HARNESS.md                            personal, all projects
//   <dir>/HARNESS.md, AGENTS.md, CLAUDE.md from the repo root down to cwd
//   <dir>/HARNESS.local.md                           personal, per project (git-ignored)
//
// `@path` in any of them imports a file, as in Claude Code's CLAUDE.md: relative
// to the importing file, `~/` for home, four hops deep at most, and not inside
// code spans or blocks. An imported file comes just before the one importing it.

import { existsSync, readdirSync, readFileSync, statSync, appendFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { homedir } from "os";
import { paths, ensureDir, harnessHome } from "../config/paths";
import { gitRoot } from "../util/git";
import { canonical, isInside } from "../util/files";
import { redact } from "../util/redact";
import { isTrusted } from "../config/trust";

export interface MemoryFile {
    path: string;
    scope: "user" | "project" | "local";
    content: string;
    /** The memory file whose `@path` brought this one in. */
    importedBy?: string;
}

const PROJECT_NAMES = ["HARNESS.md", "AGENTS.md", "CLAUDE.md", ".harness/HARNESS.md"];
const LOCAL_NAMES = ["HARNESS.local.md", "CLAUDE.local.md"];
const MAX_BYTES = 40_000;
/** Claude Code's limit: an imported file can import others, four hops from the file that started it. */
const MAX_IMPORT_DEPTH = 4;
const MAX_RULE_FILES = 200;
/**
 * Credential folders under home. Only markdown is read, which keeps keys,
 * .env files and Harness's own credential stores out; nothing under these
 * is read even so, whatever a memory file imports or links to.
 */
const CREDENTIAL_DIRS = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store", join(".config", "gcloud")];

/** $HOME as it is now (os.homedir() keeps the one the process started with). */
const userHome = () => process.env.HOME || homedir();
const claudeHome = () => (process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(userHome(), ".claude"));
const codexHome = () => (process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(userHome(), ".codex"));

/**
 * Read a memory file, following symlinks only to markdown files (inside
 * `within`, when given) and never into a credential folder. A repo's
 * `HARNESS.md -> ~/.harness/credentials.json` (or -> .env, or an
 * `@~/.ssh/id_ed25519`) would otherwise be pasted into the system prompt and
 * sent to the provider.
 */
function readCapped(file: string, within?: string): string | undefined {
    try {
        const real = canonical(file);
        if (!/\.md$/i.test(real) || (within && !isInside(real, canonical(within)))) return undefined;
        const home = canonical(userHome());
        if (CREDENTIAL_DIRS.some((d) => isInside(real, join(home, d)))) return undefined;
        if (!statSync(real).isFile()) return undefined;
        let text = readFileSync(real, "utf-8");
        if (text.length > MAX_BYTES) text = text.slice(0, MAX_BYTES) + "\n…(truncated)";
        return text.trim() ? text : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The files `text` (in `base`) imports: each `@path` outside code spans and
 * fenced blocks, after the start of a line or a space. `\ ` is a space in the
 * path, and a quoted path isn't an import.
 */
function importPaths(text: string, base: string): string[] {
    const prose: string[] = [];
    let fence: string | undefined;
    for (const line of text.split(/\r?\n/)) {
        const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
            if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && !m[2]!.trim()) fence = undefined;
        } else if (m) fence = m[1];
        else prose.push(line);
    }
    const out: string[] = [];
    for (const m of prose.join("\n").replace(/(`+)[\s\S]*?\1/g, " ").matchAll(/(?:^|\s)@((?:\\ |[^\s])+)/g)) {
        const raw = m[1]!.replace(/\\ /g, " ");
        if (/^["']/.test(raw)) continue;
        const at = (p: string) => (p === "~" || p.startsWith("~/") ? join(userHome(), p.slice(1)) : isAbsolute(p) ? p : resolve(base, p));
        // "See @docs/style.md." means docs/style.md.
        let file = at(raw);
        const bare = raw.replace(/[.,;:!?)\]]+$/, "");
        if (!existsSync(file) && bare && bare !== raw) file = at(bare);
        if (!out.includes(file)) out.push(file);
    }
    return out;
}

/** Markdown files under `dir`, folders included, sorted by name. */
function ruleFiles(dir: string): string[] {
    const out: string[] = [];
    const dirs = new Set<string>();
    const walk = (d: string) => {
        const real = canonical(d);
        if (dirs.has(real)) return; // a symlink loop
        dirs.add(real);
        let names: string[];
        try {
            names = readdirSync(d).sort();
        } catch {
            return;
        }
        for (const name of names) {
            if (out.length >= MAX_RULE_FILES) return;
            const p = join(d, name);
            try {
                const st = statSync(p);
                if (st.isDirectory()) walk(p);
                else if (st.isFile() && /\.md$/i.test(name)) out.push(p);
            } catch {
                // a dangling link
            }
        }
    };
    walk(dir);
    return out;
}

/** A rule with `paths:` frontmatter: Claude Code loads it only for files that match, so it isn't for every session. */
const pathScoped = (text: string) => /^paths\s*:/m.test(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "");

/**
 * `trusted`: the run's own decision about the folder, when it made one. False
 * keeps to the user's files even in a folder the user trusted; true reads the
 * project's files (a run that trusted a folder with nothing to protect, or
 * was told to). Left out, the folder's saved or session trust decides.
 */
export function loadMemory(cwd: string, trusted?: boolean): MemoryFile[] {
    const out: MemoryFile[] = [];
    // By real path: a file linked or imported twice loads once, and an import cycle stops.
    const seen = new Set<string>();
    /** Adds `file` after what it imports. False if it's missing, empty or refused. */
    const add = (file: string, scope: MemoryFile["scope"], o: { within?: string; skip?: (text: string) => boolean; importedBy?: string; depth?: number } = {}): boolean => {
        const real = canonical(file);
        if (seen.has(real)) return true;
        const content = readCapped(file, o.within);
        if (!content || o.skip?.(content)) return false;
        seen.add(real);
        const depth = o.depth ?? 0;
        // Imports go anywhere the user can read markdown, as Claude Code's do (it asks first for a project's; trusting the folder is that here).
        if (depth < MAX_IMPORT_DEPTH) for (const f of importPaths(content, dirname(file))) add(f, scope, { importedBy: file, depth: depth + 1 });
        out.push({ path: file, scope, content, ...(o.importedBy ? { importedBy: o.importedBy } : {}) });
        return true;
    };

    add(join(claudeHome(), "CLAUDE.md"), "user");
    for (const f of ruleFiles(join(claudeHome(), "rules"))) add(f, "user", { skip: pathScoped });
    add(join(codexHome(), "AGENTS.override.md"), "user") || add(join(codexHome(), "AGENTS.md"), "user");
    add(paths.userMemory(), "user", { within: harnessHome() });
    // The repository's files are presented as the user's instructions, so they
    // wait for trust like its settings do. (A folder with no project config is
    // trusted for the session without asking.)
    if (!(trusted ?? isTrusted(cwd))) return out;

    // Directories from the repo root (or home, or cwd) down to cwd.
    const top = gitRoot(cwd) ?? cwd;
    const dirs: string[] = [];
    let d = cwd;
    for (let i = 0; i < 40; i++) {
        dirs.unshift(d);
        if (d === top || d === homedir()) break;
        const parent = dirname(d);
        if (parent === d) break;
        d = parent;
    }
    for (const dir of dirs) {
        for (const name of PROJECT_NAMES) add(join(dir, name), "project", { within: top });
        for (const name of LOCAL_NAMES) add(join(dir, name), "local", { within: top });
    }
    return out;
}

export function formatMemory(files: MemoryFile[], cwd: string): string {
    if (!files.length) return "";
    const shown = (p: string) => (p.startsWith(cwd) ? relative(cwd, p) : p.replace(homedir(), "~"));
    const parts = files.map((f) => {
        const label = f.scope === "user" ? "user's personal instructions (all projects)" : f.scope === "local" ? "user's private project instructions" : "project instructions, checked into the codebase";
        return `Contents of ${shown(f.path)} (${label}${f.importedBy ? `; imported by ${shown(f.importedBy)}` : ""}):\n\n${redact(f.content.trim())}`;
    });
    return `# Instructions from memory files\nThese instructions come from the user and the project. Follow them; they override default behavior where they conflict.\n\n${parts.join("\n\n---\n\n")}`;
}

/** Append a note from "#" memory mode. Returns the file written. */
export function addMemoryNote(scope: "user" | "project" | "local", cwd: string, note: string): string {
    const file = scope === "user" ? paths.userMemory() : scope === "local" ? join(gitRoot(cwd) ?? cwd, "HARNESS.local.md") : join(gitRoot(cwd) ?? cwd, "HARNESS.md");
    ensureDir(dirname(file));
    const line = `- ${note.trim()}\n`;
    if (!existsSync(file)) writeFileSync(file, scope === "user" ? `# Personal instructions\n\n${line}` : `# Project instructions\n\n${line}`);
    else {
        const cur = readFileSync(file, "utf-8");
        appendFileSync(file, (cur.endsWith("\n") ? "" : "\n") + line);
    }
    if (scope === "local") ensureGitignored(cwd, "HARNESS.local.md");
    return file;
}

function ensureGitignored(cwd: string, name: string) {
    const root = gitRoot(cwd);
    if (!root) return;
    const gi = join(root, ".gitignore");
    try {
        const cur = existsSync(gi) ? readFileSync(gi, "utf-8") : "";
        if (cur.split(/\r?\n/).some((l) => l.trim() === name)) return;
        appendFileSync(gi, (cur && !cur.endsWith("\n") ? "\n" : "") + name + "\n");
    } catch {
        // ignore
    }
}
