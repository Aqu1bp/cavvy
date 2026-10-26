// Project and user instructions ("memory") loaded into the system prompt, in this order:
//
//   ~/.claude/CLAUDE.md, ~/.claude/rules/**/*.md    Claude Code's (CLAUDE_CONFIG_DIR), so they work with every model
//   ~/.codex/AGENTS.override.md or AGENTS.md         Codex's (CODEX_HOME), the first that isn't empty
//   ~/.cavvy/CAVVY.md                            personal, all projects
//   <dir>/CAVVY.md, AGENTS.md, CLAUDE.md from the repo root down to cwd
//   <dir>/CAVVY.local.md                           personal, per project (git-ignored)
//
// `@path` in any of them imports a file, as in Claude Code's CLAUDE.md: relative
// to the importing file, `~/` for home, four hops deep at most, and not inside
// code spans, code blocks or HTML blocks and comments (as Bun's CommonMark
// parser reads them); the path as written. An imported file comes before the one importing it.
// A project's files import only from inside the project unless the user trusted
// the folder themselves (Claude Code asks before it loads such "external imports").
// All of them together are capped (MAX_FILES, MAX_TOTAL_BYTES), with a notice.

import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, opendirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { homedir } from "os";
import { paths, ensureDir, cavvyHome } from "../config/paths";
import { gitRoot } from "../util/git";
import { canonical, isInside, spellings } from "../util/files";
import { redact } from "../util/redact";
import { isTrusted, trustedByUser } from "../config/trust";
import { LEGACY } from "../config/legacy";

export interface MemoryFile {
    path: string;
    scope: "user" | "project" | "local";
    content: string;
    /** The memory file whose `@path` brought this one in. */
    importedBy?: string;
}

/** What loadMemory found. `budget`: what the shared limits left out or cut short, when they did. */
export type Memory = MemoryFile[] & { budget?: { omitted: string[]; more: boolean; cut?: string; crowded?: string } };

// Harness's names last, for a project that still has them (legacy.ts).
const PROJECT_NAMES = ["CAVVY.md", "AGENTS.md", "CLAUDE.md", ".cavvy/CAVVY.md", LEGACY.memory, `${LEGACY.dir}/${LEGACY.memory}`];
const LOCAL_NAMES = ["CAVVY.local.md", "CLAUDE.local.md", LEGACY.localMemory];
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
 * .env files and Cavvy's own credential stores out; nothing under these
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

/** Run just before and just after a memory file is opened: for tests, to change the path in those windows. */
export const readHooks: { beforeOpen?: (real: string) => void; afterOpen?: (real: string) => void } = {};

/**
 * Where an open file is, as the system names it (macOS, Linux): the file
 * itself, whatever folders or links the path that opened it went through.
 * Undefined where the system can't say.
 */
export function openedPath(fd: number): string | undefined {
    const link = process.platform === "linux" ? `/proc/self/fd/${fd}` : process.platform === "darwin" ? `/dev/fd/${fd}` : undefined;
    if (!link) return undefined;
    try {
        const p = realpathSync(link);
        return p === link ? undefined : p;
    } catch {
        return undefined;
    }
}

/**
 * Read at most `limit` bytes of a memory file, following symlinks only to
 * markdown files (inside `within`, when given) and never into a credential
 * folder. A repo's `CAVVY.md -> ~/.cavvy/credentials.json` (or -> .env,
 * or an `@~/.ssh/id_ed25519`) would otherwise be pasted into the system
 * prompt and sent to the provider. `cut`: there was more.
 *
 * The path is checked, then the file is opened without following a link at
 * its end, and checked again once open: where the system says the open file
 * is (openedPath) must pass the same checks, and the path, resolved again,
 * must name the same file (device and inode). So a folder on the way swapped
 * for a link (and back) between the checks and the open isn't read, on macOS
 * and Linux. What this doesn't guard: elsewhere, where only the path can be
 * checked again, a process that keeps swapping a folder on the way in step
 * with these checks; and a hard link inside the project to a file elsewhere,
 * which is the same file under an allowed name. Either needs a process that
 * writes into the project as the user while Cavvy reads it, and so could
 * read those files itself.
 */

function readCapped(file: string, within: string | undefined, limit: number, roots: string[]): { text: string; cut: boolean } | undefined {
    let fd: number | undefined;
    try {
        const real = canonical(file);
        if (!readable(file, real, within, roots)) return undefined;
        readHooks.beforeOpen?.(real);
        // No link at the end (it was resolved), and a FIFO named *.md doesn't block the open.
        fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        readHooks.afterOpen?.(real);
        const opened = fstatSync(fd);
        if (!opened.isFile()) return undefined;
        const own = openedPath(fd);
        if (own !== undefined && !readable(own, own, within, roots)) return undefined;
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

/** A block's text ends with a line break, so two blocks' text never runs together. */
const block = (children: string) => `${children}\n`;
const cell = (children: string) => ` ${children} `;
/** What Bun's Markdown renderer keeps of a document: its text, without code or HTML blocks (where proseImports looks for its markers). */
const PROSE: Bun.markdown.RenderCallbacks = {
    code: () => "\n",
    codespan: () => " ",
    html: () => "\n",
    text: (t) => t,
    hr: () => "\n",
    ...Object.fromEntries(["paragraph", "heading", "blockquote", "list", "listItem", "table", "thead", "tbody", "tr"].map((k) => [k, block])),
    th: cell,
    td: cell,
};

/** A document's shape: its elements, nested, without their text (code and HTML as a mark each). */
const SHAPE = Object.fromEntries(
    ["heading", "paragraph", "blockquote", "list", "listItem", "hr", "table", "thead", "tbody", "tr", "th", "td", "strong", "emphasis", "link", "image", "strikethrough", "code", "codespan", "html", "text"].map((k) => [
        k,
        k === "text" ? () => "" : ["code", "codespan", "html"].includes(k) ? () => `<${k}/>` : (children: string) => `<${k}>${children}</${k}>`,
    ]),
) as Bun.markdown.RenderCallbacks;
const PARSE: Bun.markdown.Options = { strikethrough: false, autolinks: false };

/** `@path` after the start of a line or a space; `\ ` is a space in the path. */
const IMPORT = /(?<=^|\s)@((?:\\ |[^\s])+)/g;

/**
 * The `@path`s in `text` that are prose, each as written in the source. Bun's
 * CommonMark parser (md4c) decides what's code (fenced and indented code
 * blocks, code spans, HTML blocks, wherever they are), but the path is never
 * taken from what it renders: its emphasis, entities and links would turn
 * `@docs/_draft_.md` into docs/draft.md. Instead each `@` in the source gets
 * a marker of letters and digits just before it (after the space or line
 * start the `@` needs, so it changes no Markdown around it), and a path
 * counts if its marker comes out in the rendered prose. Where a marker does
 * change how the file parses (a reference definition's label at its length
 * limit), the file's shape tells, and none count. Without the parser
 * (an older Bun), none: an import missed, not one made.
 */
function proseImports(text: string): string[] {
    const found = [...text.matchAll(IMPORT)];
    if (!found.length || typeof Bun === "undefined" || typeof Bun.markdown?.render !== "function") return [];
    let tag: string;
    do tag = `hx${Math.random().toString(36).slice(2, 10)}q`;
    while (text.includes(tag));
    const mark = (i: number) => `${tag}${i}z`;
    let marked = "";
    let from = 0;
    found.forEach((m, i) => {
        marked += text.slice(from, m.index) + mark(i);
        from = m.index;
    });
    marked += text.slice(from);
    // The markers mustn't change how the file parses (they can: a reference definition's label at
    // its length limit becomes a paragraph). If they did, no imports: an import missed, not one made.
    if (Bun.markdown.render(marked, SHAPE, PARSE) !== Bun.markdown.render(text, SHAPE, PARSE)) return [];
    // No strikethrough: GFM reads `@~/a.md and @~/b.md` as struck-through text. Inline HTML stays
    // in a paragraph's text; a comment there hides what's in it.
    const prose = Bun.markdown.render(marked, PROSE, PARSE).replace(/<!--[\s\S]*?-->/g, " ");
    return found.filter((_, i) => prose.includes(mark(i))).map((m) => m[1]!);
}

/**
 * What `text` (in `base`) imports: each `@path` in its prose (proseImports),
 * as written. `\ ` is a space in the path, and a quoted path isn't an import.
 * Each comes as written, then without the punctuation or emphasis marks after
 * it when it has some ("See @docs/style.md." is docs/style.md unless
 * "docs/style.md." is there).
 */
function importCandidates(text: string, base: string): string[][] {
    const out: string[][] = [];
    const keys = new Set<string>();
    const at = (p: string) => (p === "~" || p.startsWith("~/") ? join(userHome(), p.slice(1)) : isAbsolute(p) ? p : resolve(base, p));
    for (const token of proseImports(text)) {
        const raw = token.replace(/\\ /g, " ");
        if (/^["']/.test(raw)) continue;
        const bare = raw.replace(/[.,;:!?)\]*_]+$/, "");
        const spellings = bare && bare !== raw ? [at(raw), at(bare)] : [at(raw)];
        const key = spellings.join("\0");
        if (!keys.has(key)) out.push(spellings);
        keys.add(key);
    }
    return out;
}

/** The files `text` (in `base`) imports, each spelled as it is on disk. */
function importPaths(text: string, base: string): string[] {
    const out: string[] = [];
    for (const [raw, bare] of importCandidates(text, base)) {
        const file = bare !== undefined && !existsSync(raw!) ? bare : raw!;
        if (!out.includes(file)) out.push(file);
    }
    return out;
}

/**
 * Markdown files under `dir`, folders included, sorted by name, `max` at
 * most. The walk is bounded (RULES_WALK): a folder of ten thousand empty
 * folders is a hundred reads, not ten thousand. A folder with more entries
 * than the walk has left isn't cut where the system happens to list them
 * (which would pick different files on different machines): it's left out
 * whole, and the walk stops there. `crowded`: that folder.
 */
function ruleFiles(dir: string, max: number): { files: string[]; crowded?: string } {
    const files: string[] = [];
    const visited = new Set<string>();
    let entries = 0;
    let crowded: string | undefined;
    const walk = (d: string, depth: number) => {
        if (crowded || depth > RULES_WALK.depth || visited.size >= RULES_WALK.dirs) return;
        const real = canonical(d);
        if (visited.has(real)) return; // a symlink loop
        visited.add(real);
        const names: string[] = [];
        try {
            const handle = opendirSync(d);
            try {
                // One more than is left: enough to tell the folder doesn't fit.
                for (let e; names.length <= RULES_WALK.entries - entries && (e = handle.readSync()); ) names.push(e.name);
            } finally {
                handle.closeSync();
            }
        } catch {
            return;
        }
        entries += names.length;
        if (entries > RULES_WALK.entries) {
            crowded = d;
            return;
        }
        for (const name of names.sort()) {
            if (crowded || files.length >= max) return;
            const p = join(d, name);
            try {
                const st = statSync(p);
                if (st.isDirectory()) walk(p, depth + 1);
                else if (st.isFile() && /\.md$/i.test(name)) files.push(p);
            } catch {
                // a dangling link
            }
        }
    };
    walk(dir, 0);
    return crowded ? { files, crowded } : { files };
}

/** A rule with `paths:` frontmatter: Claude Code loads it only for files that match, so it isn't for every session. */
const pathScoped = (text: string) => /^paths\s*:/m.test(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "");

interface Loaded extends MemoryFile {
    /** The shallowest import depth it was reached at: its imports were followed from there. */
    depth: number;
    /** Where what it imports must be (a project's files, before the user trusted the folder). */
    importsWithin?: string;
    /** What it imports that loaded, in the order written, once its imports were followed. */
    imports?: Loaded[];
}

interface AddOptions {
    /** Where the file itself must be. */
    within?: string;
    importsWithin?: string;
    skip?: (text: string) => boolean;
    importedBy?: string;
}

/**
 * The memory files (the user's, and the project's with `project`); and, when
 * a project's imports are kept inside it (no `external`), those that weren't.
 *
 * Two passes. Reading: each file named at the top level (the user's CLAUDE.md,
 * each rule, ..., the project's from the root down), then what it imports,
 * breadth first, so each file's imports are followed from the shortest route
 * to it, and each file counts against the budget as it's read. Then the
 * order: each top-level file after what it imports, depth first, so every
 * imported file comes before the files importing it, once.
 */
function collect(cwd: string, o: { user: boolean; project: boolean; external: boolean }): { files: Memory; outside: { path: string; importedBy: string }[] } {
    const files: Memory = [];
    const outside: { path: string; importedBy: string }[] = [];
    const roots = credentialRoots();
    // By real path: a file linked or imported twice loads once, and an import cycle stops.
    const seen = new Map<string, Loaded>();
    const tops: Loaded[] = [];
    let bytes = 0;
    let count = 0;
    const budget = () => (files.budget ??= { omitted: [], more: false });
    const omit = (file: string) => {
        const b = budget();
        if (b.more || b.omitted.includes(file)) return;
        if (b.omitted.length < MAX_OMITTED_NAMED) b.omitted.push(file);
        else b.more = true;
    };

    /** Reads `file` (not what it imports) at `depth`: the one already read, if it was. Undefined if it's missing, empty or refused. */
    const read = (file: string, scope: MemoryFile["scope"], a: AddOptions, depth: number): { e: Loaded; fresh: boolean } | undefined => {
        const real = canonical(file);
        const known = seen.get(real);
        if (known) return { e: known, fresh: false };
        if (a.importedBy && a.within && !isInside(real, canonical(a.within))) {
            if (readCapped(file, undefined, 0, roots)?.cut) outside.push({ path: file, importedBy: a.importedBy });
            return undefined;
        }
        const left = MAX_TOTAL_BYTES - bytes;
        if (count >= MAX_FILES || left <= 0) {
            if (readCapped(file, a.within, 0, roots)?.cut) omit(file);
            return undefined;
        }
        const got = readCapped(file, a.within, Math.min(MAX_BYTES, left), roots);
        if (!got?.text.trim() || a.skip?.(got.text)) return undefined;
        let content = got.text;
        bytes += Buffer.byteLength(content);
        count++;
        if (got.cut) {
            content += "\n…(truncated)";
            // Cut by what was left of the whole, not by its own cap.
            if (left < MAX_BYTES) budget().cut = file;
        }
        const e: Loaded = { path: file, scope, content, depth, ...(a.importedBy ? { importedBy: a.importedBy } : {}), ...(a.importsWithin ? { importsWithin: a.importsWithin } : {}) };
        seen.set(real, e);
        return { e, fresh: true };
    };

    /** Follows what `start` imports, breadth first; a file reached by a shorter route than before is followed again from there. */
    const expand = (start: Loaded) => {
        const queue = [start];
        for (let e; (e = queue.shift()); ) {
            if (e.depth >= MAX_IMPORT_DEPTH) continue;
            const imports: Loaded[] = [];
            for (const f of importPaths(e.content, dirname(e.path))) {
                const r = read(f, e.scope, { importedBy: e.path, within: e.importsWithin, importsWithin: e.importsWithin }, e.depth + 1);
                if (!r) continue;
                imports.push(r.e);
                if (r.fresh) queue.push(r.e);
                else if (e.depth + 1 < r.e.depth) {
                    r.e.depth = e.depth + 1;
                    queue.push(r.e);
                }
            }
            e.imports = imports;
        }
    };
    /** A top-level file. False if it's missing, empty or refused. */
    const add = (file: string, scope: MemoryFile["scope"], a: AddOptions = {}): boolean => {
        const r = read(file, scope, a, 0);
        if (!r) return false;
        if (!r.fresh && r.e.depth === 0) return true;
        r.e.depth = 0;
        tops.push(r.e);
        expand(r.e);
        return true;
    };
    /** In order: each file after what it imports. */
    const finish = () => {
        const placed = new Set<Loaded>();
        const place = (e: Loaded) => {
            if (placed.has(e)) return;
            placed.add(e);
            for (const i of e.imports ?? []) place(i);
            files.push({ path: e.path, scope: e.scope, content: e.content, ...(e.importedBy ? { importedBy: e.importedBy } : {}) });
        };
        for (const e of tops) place(e);
        return { files, outside };
    };

    if (o.user) {
        add(join(claudeHome(), "CLAUDE.md"), "user");
        const rules = ruleFiles(join(claudeHome(), "rules"), MAX_FILES);
        if (rules.crowded) budget().crowded = rules.crowded;
        for (const f of rules.files) add(f, "user", { skip: pathScoped });
        add(join(codexHome(), "AGENTS.override.md"), "user") || add(join(codexHome(), "AGENTS.md"), "user");
        add(paths.userMemory(), "user", { within: cavvyHome() });
    }
    if (!o.project) return finish();

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
    // A repository can't make Cavvy read the user's other files: its imports stay
    // inside it until the user trusts the folder (Claude Code asks first, too).
    const importsWithin = o.external ? undefined : top;
    for (const dir of dirs) {
        for (const name of PROJECT_NAMES) add(join(dir, name), "project", { within: top, importsWithin });
        for (const name of LOCAL_NAMES) add(join(dir, name), "local", { within: top, importsWithin });
    }
    return finish();
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

/** How the trust question names a file: inside the project from its root, else from home (`~/`), else in full; by real path (a link in the project is named by where it leads). */
function importName(top: string, o: { tree?: boolean } = {}): (p: string) => string {
    const homes = [...new Set([userHome(), canonical(userHome())])];
    return (p) => {
        // A path in a commit's tree is already where it leads, in a checkout that isn't made yet (not on disk).
        if (o.tree && isInside(p, top)) return relative(top, p);
        const real = canonical(p);
        if (isInside(real, top)) return relative(top, real);
        const h = homes.find((h) => isInside(real, h));
        return h ? `~/${relative(h, real)}` : real;
    };
}

/**
 * What a folder's memory files import from outside the project, for the
 * trust question ("CLAUDE.md imports ~/notes.md"): trusting the folder adds them.
 */
export function externalImports(cwd: string): string[] {
    const name = importName(canonical(gitRoot(cwd) ?? cwd));
    return [...new Set(collect(cwd, { user: false, project: true, external: false }).outside.map((o) => `${name(o.importedBy)} imports ${name(o.path)}`))];
}

/** A path in a commit's tree, as a checkout would have it: where it leads (links followed), and for a file in the tree, how to read its start. */
export interface TreeFile {
    real: string;
    /** Its first `max` bytes, no more fetched (a file in the tree). */
    head?: (max: number) => Promise<string>;
}

/**
 * externalImports for a checkout of a commit that isn't made yet (a run's
 * worktrees): what the memory files at its root, as committed, import from
 * outside it. `read` opens a path inside `top` in the commit's tree; only
 * markdown inside it is fetched, and only within loadMemory's budget
 * (MAX_FILES files fetched, MAX_BYTES each, MAX_TOTAL_BYTES in all). An
 * import outside counts as loadMemory would count it: markdown that's there.
 * One in a worktree that isn't there yet (`../<name>/x.md` from a worktree:
 * this run may make it) counts if it's markdown, since it can't be checked.
 */
export async function committedExternalImports(top: string, read: (path: string) => Promise<TreeFile | undefined>): Promise<string[]> {
    const roots = credentialRoots();
    const name = importName(top, { tree: true });
    const worktrees = dirname(top);
    const found = new Set<string>();
    const seen = new Set<string>();
    let bytes = 0;
    const unmade = (p: string) => {
        const rel = relative(worktrees, p).split(sep);
        return isInside(p, worktrees) && rel.length > 1 && /\.md$/i.test(p) && !lexists(join(worktrees, rel[0]!));
    };
    const full = () => seen.size >= MAX_FILES || bytes >= MAX_TOTAL_BYTES;
    // Breadth first, so each file's imports are followed from its shortest route, as collect() does.
    const queue: { path: string; real: string; text: string; depth: number }[] = [];
    const visit = async (path: string, f: TreeFile | undefined, depth: number) => {
        if (!f?.head || !isInside(f.real, top) || !/\.md$/i.test(f.real) || seen.has(f.real)) return;
        if (full()) return;
        const left = MAX_TOTAL_BYTES - bytes;
        seen.add(f.real);
        const text = await f.head(Math.min(MAX_BYTES, left));
        if (!text.trim()) return;
        bytes += Buffer.byteLength(text);
        queue.push({ path, real: f.real, text, depth });
    };
    for (const n of [...PROJECT_NAMES, ...LOCAL_NAMES]) await visit(join(top, n), await read(join(top, n)), 0);
    for (let e; (e = queue.shift()); ) {
        if (e.depth >= MAX_IMPORT_DEPTH) continue;
        for (const forms of importCandidates(e.text, dirname(e.path))) {
            // The first spelling that's there: in the tree inside the checkout, on disk outside it.
            let hit: { path: string; f: TreeFile } | undefined;
            for (const p of forms) {
                // Inside, once the budget is spent, nothing more is read: loadMemory wouldn't load it, and each read lists folders.
                const f = isInside(p, top) ? (full() ? undefined : await read(p)) : existsSync(p) || unmade(p) ? { real: p } : undefined;
                if (f) {
                    hit = { path: p, f };
                    break;
                }
            }
            if (!hit) continue;
            if (isInside(hit.f.real, top)) await visit(hit.path, hit.f, e.depth + 1);
            else if (unmade(hit.f.real) || readCapped(hit.f.real, undefined, 0, roots)?.cut) found.add(`${name(e.real)} imports ${name(hit.f.real)}`);
        }
    }
    return [...found];
}

const lexists = (p: string) => {
    try {
        lstatSync(p);
        return true;
    } catch {
        return false;
    }
};

export function formatMemory(files: Memory, cwd: string): string {
    const notice = budgetNotice(files, (p) => p.replace(homedir(), "~"));
    // Nothing loaded, but something was left out (a crowded rules folder): the notice still says so.
    if (!files.length) return notice ? `# Instructions from memory files\n${notice}` : "";
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
    return `# Instructions from memory files\nThese instructions come from the user and the project. Follow them; they override default behavior where they conflict.\n\n${parts.join("\n\n---\n\n")}${notice ? `\n\n---\n\n${notice}` : ""}`;
}

/** What the shared limits (and the rules walk's) left out or cut short, in a sentence or two; empty when they didn't. */
export function budgetNotice(files: Memory, show: (path: string) => string): string {
    const b = files.budget;
    if (!b) return "";
    const out: string[] = [];
    if (b.omitted.length || b.more || b.cut) {
        const omitted = b.omitted.length ? ` Left out: ${b.omitted.map(show).join(", ")}${b.more ? ", and more" : ""}.` : b.more ? " Some files were left out." : "";
        const cut = b.cut ? ` Cut short: ${show(b.cut)}.` : "";
        out.push(`Memory files are limited to ${MAX_FILES} files and ${MAX_TOTAL_BYTES / 1000} KB together, so not all of them were loaded.${omitted}${cut}`);
    }
    if (b.crowded) out.push(`${show(b.crowded)} has more entries than a rules folder's walk reads (${RULES_WALK.entries.toLocaleString("en-US")} in all), so its rules, and those after it, weren't loaded.`);
    return out.join(" ");
}

/** Append a note from "#" memory mode. Returns the file written. */
export function addMemoryNote(scope: "user" | "project" | "local", cwd: string, note: string): string {
    const file = scope === "user" ? paths.userMemory() : scope === "local" ? join(gitRoot(cwd) ?? cwd, "CAVVY.local.md") : join(gitRoot(cwd) ?? cwd, "CAVVY.md");
    ensureDir(dirname(file));
    const line = `- ${note.trim()}\n`;
    if (!existsSync(file)) writeFileSync(file, scope === "user" ? `# Personal instructions\n\n${line}` : `# Project instructions\n\n${line}`);
    else {
        const cur = readFileSync(file, "utf-8");
        appendFileSync(file, (cur.endsWith("\n") ? "" : "\n") + line);
    }
    if (scope === "local") ensureGitignored(cwd, "CAVVY.local.md");
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
