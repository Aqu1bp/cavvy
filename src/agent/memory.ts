// Project and user instructions ("memory") loaded into the system prompt.
//
//   ~/.harness/HARNESS.md                 personal, all projects
//   <dir>/HARNESS.md, AGENTS.md, CLAUDE.md from the repo root down to cwd
//   <dir>/HARNESS.local.md                 personal, per project (git-ignored)

import { existsSync, readFileSync, statSync, appendFileSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";
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
}

const PROJECT_NAMES = ["HARNESS.md", "AGENTS.md", "CLAUDE.md", ".harness/HARNESS.md"];
const LOCAL_NAMES = ["HARNESS.local.md", "CLAUDE.local.md"];
const MAX_BYTES = 40_000;

/**
 * Read a memory file, following symlinks only to markdown files inside
 * `within`. A repo's `HARNESS.md -> ~/.harness/credentials.json` (or -> .env)
 * would otherwise be pasted into the system prompt and sent to the provider.
 */
function readCapped(file: string, within: string): string | undefined {
    try {
        const real = canonical(file);
        if (!/\.md$/i.test(real) || !isInside(real, canonical(within))) return undefined;
        if (!statSync(real).isFile()) return undefined;
        let text = readFileSync(real, "utf-8");
        if (text.length > MAX_BYTES) text = text.slice(0, MAX_BYTES) + "\n…(truncated)";
        return text.trim() ? text : undefined;
    } catch {
        return undefined;
    }
}

/**
 * `trusted`: the run's own decision about the folder, when it made one. False
 * keeps to the user's file even in a folder the user trusted; true reads the
 * project's files (a run that trusted a folder with nothing to protect, or
 * was told to). Left out, the folder's saved or session trust decides.
 */
export function loadMemory(cwd: string, trusted?: boolean): MemoryFile[] {
    const out: MemoryFile[] = [];
    const user = readCapped(paths.userMemory(), harnessHome());
    if (user) out.push({ path: paths.userMemory(), scope: "user", content: user });
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
    const seen = new Set<string>();
    for (const dir of dirs) {
        for (const name of PROJECT_NAMES) {
            const f = join(dir, name);
            if (seen.has(f) || !existsSync(f)) continue;
            seen.add(f);
            const c = readCapped(f, top);
            if (c) out.push({ path: f, scope: "project", content: c });
        }
        for (const name of LOCAL_NAMES) {
            const f = join(dir, name);
            if (seen.has(f) || !existsSync(f)) continue;
            seen.add(f);
            const c = readCapped(f, top);
            if (c) out.push({ path: f, scope: "local", content: c });
        }
    }
    return out;
}

export function formatMemory(files: MemoryFile[], cwd: string): string {
    if (!files.length) return "";
    const parts = files.map((f) => {
        const label = f.scope === "user" ? "user's personal instructions (all projects)" : f.scope === "local" ? "user's private project instructions" : "project instructions, checked into the codebase";
        const shown = f.path.startsWith(cwd) ? relative(cwd, f.path) : f.path.replace(homedir(), "~");
        return `Contents of ${shown} (${label}):\n\n${redact(f.content.trim())}`;
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
