// Search in project (the GUI's ⌘⇧F): a text search over the session's folder, with ripgrep when it's installed, else
// `git grep`, else a bounded scan here. Each runs off the server's thread or in small steps (child processes read as
// they write; the scan awaits each file), stops at a cap or a deadline, and is stopped (its process killed) when the
// window asks again or goes away. Only the folder is searched: nothing is followed out of it (no symlinks).

import { opendir } from "fs/promises";
import { join } from "path";
import { gitArgv, untrustedGitEnv } from "../util/git";
import { childEnv } from "../util/env";
import { looksBinary } from "../util/files";
import { readRegular } from "./git-changes";
import type { ProjectSearchResult, SearchFileHits, SearchHit } from "./protocol";

export interface SearchOptions {
    query: string;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    regex?: boolean;
}

export type SearchBackend = "rg" | "git" | "js";

export interface SearchLimits {
    /** Matches in all (the search stops there, and says it was cut short). */
    matches: number;
    /** Matches in one file. */
    perFile: number;
    /** How long it may take, in ms. */
    timeMs: number;
    /** The scan's: most files it reads, and the biggest. */
    scanFiles: number;
    scanBytes: number;
}

export const SEARCH_LIMITS: SearchLimits = { matches: 1000, perFile: 100, timeMs: 10_000, scanFiles: 20_000, scanBytes: 1024 * 1024 };
/** The most of a line sent: the part around its first match. */
export const PREVIEW_CHARS = 240;
/** How long reading a search's output works before the server's other work gets a turn. */
const YIELD_MS = 8;
/** Files over this aren't searched by ripgrep (a minified bundle's one line would be all of it). */
const RG_MAX_FILESIZE = "4M";
/** Folders the scan never goes into (as @-mentions' listing skips them outside a repository). */
const SCAN_SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv", ".cache", "coverage", ".turbo", ".idea"]);

let rgFound: { path: string | null; for?: string } | undefined;
/** ripgrep on PATH, looked up again when PATH changes. */
export function ripgrepPath(): string | null {
    if (!rgFound || rgFound.for !== process.env.PATH) rgFound = { path: Bun.which("rg", { PATH: process.env.PATH ?? "" }), for: process.env.PATH };
    return rgFound.path;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The query as a JS RegExp (for the scan, and to mark matches in git's lines); undefined when JS can't read it. */
export function queryRegExp(o: SearchOptions): RegExp | undefined {
    let source = o.regex ? o.query : escapeRegExp(o.query);
    if (o.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
    try {
        return new RegExp(source, `gu${o.caseSensitive ? "" : "i"}`);
    } catch {
        try {
            // Without the u flag, which refuses some escapes other engines take (\-, \/).
            return new RegExp(o.wholeWord ? `\\b(?:${o.regex ? o.query : escapeRegExp(o.query)})\\b` : source, `g${o.caseSensitive ? "" : "i"}`);
        } catch {
            return undefined;
        }
    }
}

/** Where `re` matches in `text` (UTF-16 offsets), at most 50. */
function rangesIn(text: string, re: RegExp | undefined): [number, number][] {
    if (!re) return [];
    const out: [number, number][] = [];
    re.lastIndex = 0;
    for (let m = re.exec(text); m && out.length < 50; m = re.exec(text)) {
        if (m[0].length === 0) {
            re.lastIndex++;
            continue;
        }
        out.push([m.index, m.index + m[0].length]);
    }
    return out;
}

/** A line cut to PREVIEW_CHARS around its first match, its ranges moved with it; `from`: how much was cut off its start. */
export function preview(text: string, ranges: [number, number][]): SearchHit["preview"] {
    const line = text.replace(/\r$/, "");
    if (line.length <= PREVIEW_CHARS) return { text: line, ranges: ranges.filter(([a]) => a < line.length).map(([a, b]) => [a, Math.min(b, line.length)]) };
    const first = ranges[0]?.[0] ?? 0;
    const from = Math.max(0, Math.min(first - 40, line.length - PREVIEW_CHARS));
    const to = from + PREVIEW_CHARS;
    return {
        text: line.slice(from, to),
        from,
        ranges: ranges.filter(([a, b]) => b > from && a < to).map(([a, b]) => [Math.max(0, a - from), Math.min(PREVIEW_CHARS, b - from)]),
    };
}

/** Collects hits by file, in the order they come, up to the caps. */
class Hits {
    private byPath = new Map<string, SearchFileHits>();
    count = 0;
    truncated = false;
    constructor(private limits: SearchLimits) {}
    /** False once the cap is reached: the search stops. */
    add(path: string, line: number, text: string, ranges: [number, number][]): boolean {
        if (this.count >= this.limits.matches) {
            this.truncated = true;
            return false;
        }
        let f = this.byPath.get(path);
        if (!f) this.byPath.set(path, (f = { path, hits: [] }));
        if (f.hits.length >= this.limits.perFile) {
            f.more = true;
            return true;
        }
        f.hits.push({ line, preview: preview(text, ranges) });
        this.count++;
        return true;
    }
    result(via: SearchBackend, extra: Partial<ProjectSearchResult> = {}): ProjectSearchResult {
        return { files: [...this.byPath.values()], matches: this.count, truncated: this.truncated, via, ...extra };
    }
}

class SearchError extends Error {}

/** What's said of a regular expression the search can't read, and why when known ("unclosed group"). */
const invalidRegex = (why?: string) => `Not a valid regular expression${why ? `: ${why.trim()}` : ""}`;

/**
 * Lines of a child's stdout as they come, each handed to `line` (false stops it: the child is killed). Killed too
 * when `signal` aborts or the deadline passes. Resolves with its exit code and stderr (null code: killed).
 */
async function readLines(proc: Bun.Subprocess<"ignore", "pipe", "pipe">, signal: AbortSignal, deadline: number, line: (s: string) => boolean | void): Promise<{ code: number | null; stderr: string; timedOut: boolean }> {
    let killed = false;
    let timedOut = false;
    const kill = () => {
        if (killed) return;
        killed = true;
        proc.kill();
    };
    signal.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        kill();
    }, Math.max(0, deadline - Date.now()));
    const stderr = new Response(proc.stderr).text().catch(() => "");
    try {
        const decoder = new TextDecoder();
        let rest = "";
        const reader = proc.stdout.getReader();
        // Where a line break may still be in `rest`: a long line comes in many reads, and isn't looked through again for each.
        let scanFrom = 0;
        let worked = performance.now();
        outer: for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            rest += decoder.decode(value, { stream: true });
            let nl = rest.indexOf("\n", scanFrom);
            let at = 0;
            while (nl >= 0) {
                if (line(rest.slice(at, nl)) === false) {
                    kill();
                    break outer;
                }
                at = nl + 1;
                // A lot read at once: the server's other work gets a turn now and then.
                if (performance.now() - worked > YIELD_MS) {
                    await new Promise((r) => setImmediate(r));
                    worked = performance.now();
                    if (killed) break outer;
                }
                nl = rest.indexOf("\n", at);
            }
            rest = rest.slice(at);
            scanFrom = rest.length;
            worked = performance.now();
        }
        if (!killed && rest) line(rest);
        reader.releaseLock();
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", kill);
    }
    const code = await proc.exited;
    return { code: killed ? null : code, stderr: await stderr, timedOut };
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
/** A byte offset into `text`'s UTF-8 as a UTF-16 offset. */
function charOffset(text: string, bytes: Uint8Array, at: number): number {
    return fromUtf8.decode(bytes.subarray(0, at)).length;
}

const textOf = (v: { text?: string; bytes?: string } | undefined) => (v?.text !== undefined ? v.text : v?.bytes !== undefined ? Buffer.from(v.bytes, "base64").toString("utf8") : undefined);

async function withRipgrep(rg: string, root: string, o: SearchOptions, limits: SearchLimits, signal: AbortSignal): Promise<ProjectSearchResult> {
    const args = ["--no-config", "--json", "--hidden", "--glob", "!.git", "--max-filesize", RG_MAX_FILESIZE, "--max-count", String(limits.perFile + 1), o.caseSensitive ? "--case-sensitive" : "--ignore-case"];
    if (o.wholeWord) args.push("--word-regexp");
    if (!o.regex) args.push("--fixed-strings");
    args.push("--regexp", o.query, "--", ".");
    const proc = Bun.spawn([rg, ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnv() });
    const hits = new Hits(limits);
    const r = await readLines(proc, signal, Date.now() + limits.timeMs, (l) => {
        if (!l.startsWith('{"type":"match"')) return;
        let m: { data: { path: { text?: string; bytes?: string }; lines: { text?: string; bytes?: string }; line_number?: number; submatches: { start: number; end: number }[] } };
        try {
            m = JSON.parse(l);
        } catch {
            return;
        }
        const path = textOf(m.data.path)?.replace(/^\.\//, "");
        const text = textOf(m.data.lines)?.replace(/\n$/, "");
        if (path === undefined || text === undefined || m.data.line_number === undefined) return;
        const bytes = utf8.encode(text);
        const ranges = m.data.submatches.slice(0, 50).map((s): [number, number] => [charOffset(text, bytes, s.start), charOffset(text, bytes, s.end)]);
        return hits.add(path, m.data.line_number, text, ranges);
    });
    // 1: nothing found. 2: an error, with or without matches (a file it couldn't read): only an error when nothing came.
    if (r.code === 2 && !hits.count) {
        // "regex parse error:", the pattern, a caret, then "error: unclosed group".
        if (/regex parse error/.test(r.stderr)) throw new SearchError(invalidRegex(r.stderr.match(/^error: (.+)$/m)?.[1]));
        throw new SearchError(r.stderr.split("\n").find((s) => s.trim())?.replace(/^rg: /, "") ?? "The search failed");
    }
    return hits.result("rg", r.timedOut ? { timedOut: true } : {});
}

/** Not a repository (or no git): the scan's turn. */
class NotRepo extends Error {}

async function withGit(root: string, o: SearchOptions, limits: SearchLimits, signal: AbortSignal, pcre = true): Promise<ProjectSearchResult> {
    const args = ["grep", "-z", "-n", "-I", "--no-color", "--no-textconv", "--untracked", "--max-count", String(limits.perFile + 1), o.caseSensitive ? "--no-ignore-case" : "--ignore-case"];
    if (o.wholeWord) args.push("--word-regexp");
    args.push(!o.regex ? "--fixed-strings" : pcre ? "--perl-regexp" : "--extended-regexp");
    args.push("-e", o.query, "--", ".");
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
        proc = Bun.spawn(gitArgv(args), { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: untrustedGitEnv() });
    } catch {
        throw new NotRepo();
    }
    const re = queryRegExp(o);
    const hits = new Hits(limits);
    // Each line: path NUL number NUL text (-z keeps a path as it is, a newline in it too: read up to its NUL).
    let pending = "";
    const r = await readLines(proc, signal, Date.now() + limits.timeMs, (l) => {
        const s = pending + l;
        const a = s.indexOf("\0");
        const b = a < 0 ? -1 : s.indexOf("\0", a + 1);
        if (b < 0) {
            // A newline in the path: the rest of the record is on the next line.
            pending = s + "\n";
            return;
        }
        pending = "";
        const text = s.slice(b + 1);
        return hits.add(s.slice(0, a), Number(s.slice(a + 1, b)), text, rangesIn(text, re));
    });
    if (r.code !== null && r.code > 1 && !hits.count) {
        if (/not a git repository/i.test(r.stderr)) throw new NotRepo();
        // A git built without PCRE: its own extended expressions instead.
        if (pcre && /USE_LIBPCRE/.test(r.stderr)) return withGit(root, o, limits, signal, false);
        const said = r.stderr.split("\n").find((s) => s.trim())?.replace(/^(fatal|error): /, "");
        // "-e option, '(': missing closing parenthesis"
        if (o.regex && said?.startsWith("-e option")) throw new SearchError(invalidRegex(said.replace(/^-e option, '.*': /, "")));
        throw new SearchError(said ?? "The search failed");
    }
    return hits.result("git", r.timedOut ? { timedOut: true } : {});
}

async function withScan(root: string, o: SearchOptions, limits: SearchLimits, signal: AbortSignal): Promise<ProjectSearchResult> {
    const re = queryRegExp(o);
    if (!re) throw new SearchError(invalidRegex());
    const hits = new Hits(limits);
    const deadline = Date.now() + limits.timeMs;
    let files = 0;
    let skipped = 0;
    let stopped: "cap" | "time" | undefined;
    const stack = [""];
    walk: while (stack.length) {
        const rel = stack.pop()!;
        let dir;
        try {
            dir = await opendir(join(root, rel));
        } catch {
            continue;
        }
        const subdirs: string[] = [];
        for await (const e of dir) {
            if (signal.aborted) break walk;
            const path = rel ? `${rel}/${e.name}` : e.name;
            // Links aren't followed: one could lead out of the folder.
            if (e.isDirectory()) {
                if (!SCAN_SKIP.has(e.name)) subdirs.push(path);
                continue;
            }
            if (!e.isFile()) continue;
            if (++files > limits.scanFiles) {
                stopped = "cap";
                break walk;
            }
            if (Date.now() > deadline) {
                stopped = "time";
                break walk;
            }
            const r = await readRegular(join(root, path), limits.scanBytes);
            if (!r?.buf) {
                if (r && !r.buf) skipped++;
                continue;
            }
            if (looksBinary(r.buf)) continue;
            const text = r.buf.toString("utf8");
            // Most files don't have it: one look at the whole file before it's split into lines.
            re.lastIndex = 0;
            if (!re.test(text)) continue;
            const lines = text.split("\n");
            let inFile = 0;
            for (let i = 0; i < lines.length && inFile <= limits.perFile; i++) {
                const ranges = rangesIn(lines[i]!, re);
                if (!ranges.length) continue;
                inFile++;
                if (!hits.add(path, i + 1, lines[i]!, ranges)) break walk;
            }
        }
        // Depth first, in name order.
        stack.push(...subdirs.sort().reverse());
    }
    return hits.result("js", { ...(stopped === "time" ? { timedOut: true } : stopped === "cap" ? { truncated: true } : {}), ...(skipped ? { skippedLarge: skipped } : {}) });
}

/**
 * Search `root` (a real path: the session's folder) for `o.query`. `backend` picks one (tests); otherwise ripgrep if
 * it's installed, else git grep, else the scan (git grep outside a repository falls to the scan too). Throws an
 * Error whose message is for the user when the search itself can't run (a regular expression that isn't one).
 */
export async function searchProject(root: string, o: SearchOptions, signal: AbortSignal, opts: { backend?: SearchBackend; rg?: string; limits?: Partial<SearchLimits> } = {}): Promise<ProjectSearchResult> {
    const limits = { ...SEARCH_LIMITS, ...opts.limits };
    const rg = opts.backend === "rg" ? (opts.rg ?? ripgrepPath()) : opts.backend ? null : ripgrepPath();
    if (opts.backend === "rg" && !rg) throw new Error("ripgrep isn't installed");
    if (rg) return withRipgrep(rg, root, o, limits, signal);
    if (opts.backend !== "js") {
        try {
            return await withGit(root, o, limits, signal);
        } catch (e) {
            if (!(e instanceof NotRepo) || opts.backend === "git") throw e;
        }
    }
    return withScan(root, o, limits, signal);
}
