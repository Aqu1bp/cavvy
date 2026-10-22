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
// code spans or code blocks. An imported file comes just before the one importing it.
// A project's files import only from inside the project unless the user trusted
// the folder themselves (Claude Code asks before it loads such "external imports").
// All of them together are capped (MAX_FILES, MAX_TOTAL_BYTES), with a notice.

import { appendFileSync, closeSync, constants, existsSync, fstatSync, opendirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { homedir } from "os";
import { paths, ensureDir, harnessHome } from "../config/paths";
import { gitRoot } from "../util/git";
import { canonical, isInside, spellings } from "../util/files";
import { redact } from "../util/redact";
import { isTrusted, trustedByUser } from "../config/trust";

export interface MemoryFile {
    path: string;
    scope: "user" | "project" | "local";
    content: string;
    /** The memory file whose `@path` brought this one in. */
    importedBy?: string;
}

/** What loadMemory found. `budget`: what the shared limits left out or cut short, when they did. */
export type Memory = MemoryFile[] & { budget?: { omitted: string[]; more: boolean; cut?: string } };

const PROJECT_NAMES = ["HARNESS.md", "AGENTS.md", "CLAUDE.md", ".harness/HARNESS.md"];
const LOCAL_NAMES = ["HARNESS.local.md", "CLAUDE.local.md"];
/** One file's cap, in UTF-8 bytes. */
const MAX_BYTES = 40_000;
/** Claude Code's limit: an imported file can import others, four hops from the file that started it. */
const MAX_IMPORT_DEPTH = 4;
/** All memory files together (the user's, their rules, the project's and what they import): how many, and how much text. */
export const MAX_FILES = 200;
export const MAX_TOTAL_BYTES = 200_000;
/** Files over the budget named in its notice (each is opened to tell, so not all of them). */
const MAX_OMITTED_NAMED = 10;
/** The walk of a rules folder: folders visited, entries read (all folders together), and how deep. */
const RULES_WALK = { dirs: 100, entries: 2_000, depth: 8 };
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

/** The path as written and with symlinks resolved, in every spelling the volume opens as the same file (see CASE_FOLDS). */
const pathForms = (p: string) => [...new Set([p, canonical(p)].flatMap(spellings))];

/**
 * The credential folders, as written and where they lead (`~/.ssh` may be a
 * link to /vault/ssh), in every spelling (`~/.SSH` is `~/.ssh` on macOS).
 */
function credentialRoots(): string[] {
    const homes = new Set([userHome(), homedir()]);
    return [...new Set([...homes].flatMap((h) => CREDENTIAL_DIRS.map((d) => join(h, d))).flatMap(pathForms))];
}

const isCredential = (p: string, roots: string[]) => pathForms(p).some((f) => roots.some((r) => isInside(f, r)));

/** Markdown (by its real name), inside `within` when given, and outside every credential folder. */
function readable(file: string, real: string, within: string | undefined, roots: string[]): boolean {
    return /\.md$/i.test(real) && (!within || isInside(real, canonical(within))) && !isCredential(file, roots);
}

/**
 * Read at most `limit` bytes of a memory file, following symlinks only to
 * markdown files (inside `within`, when given) and never into a credential
 * folder. A repo's `HARNESS.md -> ~/.harness/credentials.json` (or -> .env,
 * or an `@~/.ssh/id_ed25519`) would otherwise be pasted into the system
 * prompt and sent to the provider. `cut`: there was more.
 *
 * The checks are made on the path, then again once the file is open: what was
 * opened must be what the path, checked again, names (by device and inode),
 * so a path swapped for a link to something else in between isn't read.
 */
/** Runs between a memory file's checks and its open: for tests, to change the path in that window. */
export const readHooks: { beforeOpen?: (real: string) => void } = {};

function readCapped(file: string, within: string | undefined, limit: number, roots: string[]): { text: string; cut: boolean } | undefined {
    let fd: number | undefined;
    try {
        const real = canonical(file);
        if (!readable(file, real, within, roots)) return undefined;
        readHooks.beforeOpen?.(real);
        // No link at the end (it was resolved), and a FIFO named *.md doesn't block the open.
        fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        const opened = fstatSync(fd);
        if (!opened.isFile()) return undefined;
        const again = canonical(file);
        if (!readable(file, again, within, roots)) return undefined;
        const named = statSync(again);
        if (named.dev !== opened.dev || named.ino !== opened.ino) return undefined;
        const buf = Buffer.alloc(Math.max(0, limit) + 1);
        let n = 0;
        for (let r; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, n)) > 0; ) n += r;
        const cut = n > limit;
        let end = Math.min(n, limit);
        // Not in the middle of a character: back to the start of the one that doesn't fit.
        if (cut) while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
        return { text: buf.toString("utf-8", 0, end), cut };
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

const FENCE = /^(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^([-+*]|\d{1,9}[.)])( {1,4}(?=\S)| *$)/;

/**
 * `text`'s paragraphs without its code: fenced and indented code blocks, in
 * block quotes and list items too, and code spans. A small CommonMark
 * scanner: it tracks block quote depth and the current list item's content
 * column, which is what decides whether a fence or an indent is code. Where
 * it can't tell, it leans to code (an import missed, not one made).
 */
function proseOf(text: string): string[] {
    const paragraphs: string[] = [];
    let para: string[] | undefined;
    const end = () => {
        if (para?.length) paragraphs.push(para.join("\n"));
        para = undefined;
    };
    let fence: { char: string; len: number; quote: number; column: number } | undefined;
    let list = { column: 0, quote: 0 };
    for (const raw of text.split(/\r?\n/)) {
        // Tabs in the indent to four-column stops, so indents compare as CommonMark counts them.
        let line = raw.replace(/^[ \t>]*\t[ \t]*/, (ws) => {
            let col = 0;
            let out = "";
            for (const c of ws) {
                const w = c === "\t" ? 4 - (col % 4) : 1;
                out += c === "\t" ? " ".repeat(w) : c;
                col += w;
            }
            return out;
        });
        let quote = 0;
        for (let m; (m = /^ {0,3}> ?/.exec(line)); quote++) line = line.slice(m[0].length);
        let indent = line.length - line.trimStart().length;
        let body = line.trimStart();
        if (list.column && quote !== list.quote) list = { column: 0, quote };
        if (fence) {
            // A fence ends with its own closing line, or with the block quote or list item it was opened in.
            const left = quote < fence.quote || (body && indent < fence.column);
            if (!left) {
                const close = FENCE.exec(body);
                if (close && indent - fence.column < 4 && close[1]![0] === fence.char && close[1]!.length >= fence.len && !close[2]!.trim()) fence = undefined;
                continue;
            }
            fence = undefined;
        }
        if (!body) {
            end();
            continue;
        }
        // A list item's first line: what follows the marker is a block of its own.
        const item = LIST_ITEM.exec(body);
        if (item && indent < list.column + 4 && !(para && /^\d/.test(item[1]!) && !/^1[.)]$/.test(item[1]!))) {
            end();
            list = { column: indent + item[1]!.length + Math.max(1, item[2]!.length), quote };
            body = body.slice(item[0].length);
            indent = list.column;
            if (!body) continue;
        } else if (list.column && indent < list.column && !para) list = { column: 0, quote };
        const column = indent >= list.column ? list.column : 0;
        // Indented code can't interrupt a paragraph: there, an indented line goes on with it.
        if (indent - column >= 4 && !para) continue;
        const open = FENCE.exec(body);
        if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
            end();
            fence = { char: open[1]![0]!, len: open[1]!.length, quote, column };
            continue;
        }
        if (/^#{1,6}(\s|$)/.test(body)) {
            end();
            paragraphs.push(body);
            continue;
        }
        (para ??= []).push(body);
    }
    end();
    // A code span runs from a run of backticks to the next run just as long, within a paragraph.
    return paragraphs.map((p) => p.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, " "));
}

/**
 * The files `text` (in `base`) imports: each `@path` outside code, after the
 * start of a line or a space. `\ ` is a space in the path, and a quoted path
 * isn't an import.
 */
function importPaths(text: string, base: string): string[] {
    const out: string[] = [];
    const at = (p: string) => (p === "~" || p.startsWith("~/") ? join(userHome(), p.slice(1)) : isAbsolute(p) ? p : resolve(base, p));
    for (const prose of proseOf(text)) {
        for (const m of prose.matchAll(/(?:^|\s)@((?:\\ |[^\s])+)/g)) {
            const raw = m[1]!.replace(/\\ /g, " ");
            if (/^["']/.test(raw)) continue;
            // "See @docs/style.md." means docs/style.md.
            let file = at(raw);
            const bare = raw.replace(/[.,;:!?)\]]+$/, "");
            if (!existsSync(file) && bare && bare !== raw) file = at(bare);
            if (!out.includes(file)) out.push(file);
        }
    }
    return out;
}

/**
 * Markdown files under `dir`, folders included, sorted by name, `max` at
 * most. The walk is bounded (RULES_WALK): a folder of ten thousand empty
 * folders is a hundred reads, not ten thousand. A folder with more entries
 * than the walk reads is cut where the system lists it, before sorting.
 */
function ruleFiles(dir: string, max: number): string[] {
    const out: string[] = [];
    const visited = new Set<string>();
    let entries = 0;
    const walk = (d: string, depth: number) => {
        if (depth > RULES_WALK.depth || visited.size >= RULES_WALK.dirs) return;
        const real = canonical(d);
        if (visited.has(real)) return; // a symlink loop
        visited.add(real);
        const names: string[] = [];
        try {
            const handle = opendirSync(d);
            try {
                for (let e; entries < RULES_WALK.entries && (e = handle.readSync()); entries++) names.push(e.name);
            } finally {
                handle.closeSync();
            }
        } catch {
            return;
        }
        for (const name of names.sort()) {
            if (out.length >= max) return;
            const p = join(d, name);
            try {
                const st = statSync(p);
                if (st.isDirectory()) walk(p, depth + 1);
                else if (st.isFile() && /\.md$/i.test(name)) out.push(p);
            } catch {
                // a dangling link
            }
        }
    };
    walk(dir, 0);
    return out;
}

/** A rule with `paths:` frontmatter: Claude Code loads it only for files that match, so it isn't for every session. */
const pathScoped = (text: string) => /^paths\s*:/m.test(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "");

interface Loaded extends MemoryFile {
    /** The shallowest import depth it was reached at: its imports were followed from there. */
    depth: number;
    /** Where what it imports must be (a project's files, before the user trusted the folder). */
    importsWithin?: string;
}

interface AddOptions {
    /** Where the file itself must be. */
    within?: string;
    importsWithin?: string;
    skip?: (text: string) => boolean;
    importedBy?: string;
    depth?: number;
}

/**
 * The memory files (the user's, and the project's with `project`); and, when
 * a project's imports are kept inside it (no `external`), those that weren't.
 */
function collect(cwd: string, o: { user: boolean; project: boolean; external: boolean }): { files: Memory; outside: { path: string; importedBy: string }[] } {
    const files: Memory = [];
    const outside: { path: string; importedBy: string }[] = [];
    const roots = credentialRoots();
    // By real path: a file linked or imported twice loads once, and an import cycle stops.
    const seen = new Map<string, Loaded>();
    let bytes = 0;
    const budget = () => (files.budget ??= { omitted: [], more: false });

    /** Follows what `e` imports, reached at `depth`. */
    const expand = (e: Loaded, depth: number) => {
        if (depth >= MAX_IMPORT_DEPTH) return;
        for (const f of importPaths(e.content, dirname(e.path))) add(f, e.scope, { importedBy: e.path, depth: depth + 1, within: e.importsWithin, importsWithin: e.importsWithin });
    };
    /** Adds `file` after what it imports. False if it's missing, empty or refused. */
    const add = (file: string, scope: MemoryFile["scope"], a: AddOptions = {}): boolean => {
        const real = canonical(file);
        const depth = a.depth ?? 0;
        const known = seen.get(real);
        if (known) {
            // Reached again by a shorter route: more of what it imports may be in reach now.
            if (depth < known.depth) {
                known.depth = depth;
                expand(known, depth);
            }
            return true;
        }
        if (a.importedBy && a.within && !isInside(real, canonical(a.within))) {
            if (readCapped(file, undefined, 0, roots)?.cut) outside.push({ path: file, importedBy: a.importedBy });
            return false;
        }
        const left = MAX_TOTAL_BYTES - bytes;
        if (files.length >= MAX_FILES || left <= 0) {
            const b = budget();
            if (b.more) return false;
            if (readCapped(file, a.within, 0, roots)?.cut) {
                if (b.omitted.length < MAX_OMITTED_NAMED) b.omitted.push(file);
                else b.more = true;
            }
            return false;
        }
        const read = readCapped(file, a.within, Math.min(MAX_BYTES, left), roots);
        if (!read?.text.trim() || a.skip?.(read.text)) return false;
        let content = read.text;
        bytes += Buffer.byteLength(content);
        if (read.cut) {
            content += "\n…(truncated)";
            // Cut by what was left of the whole, not by its own cap.
            if (left < MAX_BYTES) budget().cut = file;
        }
        const importedBy = a.importedBy ? { importedBy: a.importedBy } : {};
        const e: Loaded = { path: file, scope, content, depth, ...importedBy, ...(a.importsWithin ? { importsWithin: a.importsWithin } : {}) };
        seen.set(real, e);
        expand(e, depth);
        files.push({ path: file, scope, content, ...importedBy });
        return true;
    };

    if (o.user) {
        add(join(claudeHome(), "CLAUDE.md"), "user");
        for (const f of ruleFiles(join(claudeHome(), "rules"), MAX_FILES)) add(f, "user", { skip: pathScoped });
        add(join(codexHome(), "AGENTS.override.md"), "user") || add(join(codexHome(), "AGENTS.md"), "user");
        add(paths.userMemory(), "user", { within: harnessHome() });
    }
    if (!o.project) return { files, outside };

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
    // A repository can't make Harness read the user's other files: its imports stay
    // inside it until the user trusts the folder (Claude Code asks first, too).
    const importsWithin = o.external ? undefined : top;
    for (const dir of dirs) {
        for (const name of PROJECT_NAMES) add(join(dir, name), "project", { within: top, importsWithin });
        for (const name of LOCAL_NAMES) add(join(dir, name), "local", { within: top, importsWithin });
    }
    return { files, outside };
}

/**
 * `trusted`: the run's own decision about the folder, when it made one. False
 * keeps to the user's files even in a folder the user trusted; true reads the
 * project's files (a run that trusted a folder with nothing to protect, or
 * was told to). Left out, the folder's saved or session trust decides. Either
 * way the project's files import from outside it only where the user trusted
 * the folder themselves (trusting it for having nothing to protect isn't that).
 */
export function loadMemory(cwd: string, trusted?: boolean): Memory {
    const project = trusted ?? isTrusted(cwd);
    let external = false;
    try {
        external = project && trustedByUser(cwd);
    } catch {
        // The trust list couldn't be read: imports stay inside the project.
    }
    return collect(cwd, { user: true, project, external }).files;
}

/**
 * What a folder's memory files import from outside the project, for the
 * trust question ("CLAUDE.md imports ~/notes.md"): trusting the folder adds them.
 */
export function externalImports(cwd: string): string[] {
    const top = canonical(gitRoot(cwd) ?? cwd);
    const homes = [...new Set([userHome(), canonical(userHome())])];
    // By real path: a link in the project is named by where it leads.
    const name = (p: string) => {
        const real = canonical(p);
        if (isInside(real, top)) return relative(top, real);
        const h = homes.find((h) => isInside(real, h));
        return h ? `~/${relative(h, real)}` : real;
    };
    return [...new Set(collect(cwd, { user: false, project: true, external: false }).outside.map((o) => `${name(o.importedBy)} imports ${name(o.path)}`))];
}

export function formatMemory(files: Memory, cwd: string): string {
    if (!files.length) return "";
    // A project's files lie between its repository root and cwd: named from cwd (../AGENTS.md), so that
    // a worktree's prompt doesn't carry its own path and every worktree of the project shares it.
    // An import from outside the project (in a folder the user trusted) is named as the user's files are.
    let top: string | undefined;
    const inProject = (p: string) => isInside(canonical(p), (top ??= canonical(gitRoot(cwd) ?? cwd)));
    const shown = (p: string, scope: MemoryFile["scope"]) => ((scope !== "user" && inProject(p)) || isInside(p, cwd) ? relative(cwd, p) : p.replace(homedir(), "~"));
    const parts = files.map((f) => {
        const label = f.scope === "user" ? "user's personal instructions (all projects)" : f.scope === "local" ? "user's private project instructions" : "project instructions, checked into the codebase";
        return `Contents of ${shown(f.path, f.scope)} (${label}${f.importedBy ? `; imported by ${shown(f.importedBy, f.scope)}` : ""}):\n\n${redact(f.content.trim())}`;
    });
    const notice = budgetNotice(files, (p) => p.replace(homedir(), "~"));
    return `# Instructions from memory files\nThese instructions come from the user and the project. Follow them; they override default behavior where they conflict.\n\n${parts.join("\n\n---\n\n")}${notice ? `\n\n---\n\n${notice}` : ""}`;
}

/** What the shared limits left out or cut short, in a sentence; empty when they didn't. */
export function budgetNotice(files: Memory, show: (path: string) => string): string {
    const b = files.budget;
    if (!b) return "";
    const omitted = b.omitted.length ? ` Left out: ${b.omitted.map(show).join(", ")}${b.more ? ", and more" : ""}.` : b.more ? " Some files were left out." : "";
    const cut = b.cut ? ` Cut short: ${show(b.cut)}.` : "";
    return `Memory files are limited to ${MAX_FILES} files and ${MAX_TOTAL_BYTES / 1000} KB together, so not all of them were loaded.${omitted}${cut}`;
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
