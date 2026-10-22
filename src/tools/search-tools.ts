import { readdir, stat, readFile } from "fs/promises";
import { statSync } from "fs";
import { isAbsolute, join, relative } from "path";
import type { Tool, ToolContext } from "./types";
import { displayPath, expandPath, formatBytes, looksBinary, truncateMiddle } from "../util/files";
import { redact, redactPrefix } from "../util/redact";
import { childEnv } from "../util/env";
import { gitListFiles } from "../util/git";
import { MAX_SECRET_BYTES } from "../agent/secrets";

const DEFAULT_IGNORES = ["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv", "target", ".cache", ".DS_Store"];

let rgPath: { path: string | null; for?: string } | undefined;
function ripgrep(): string | null {
    // Looked up again if PATH changes; Bun.which's default PATH is the one at startup.
    if (!rgPath || rgPath.for !== process.env.PATH) rgPath = { path: Bun.which("rg", { PATH: process.env.PATH ?? "" }), for: process.env.PATH };
    return rgPath.path;
}

// ---------------------------------------------------------------------------

export const GlobTool: Tool<{ pattern: string; path?: string }> = {
    name: "Glob",
    category: "read",
    readOnly: true,
    description: `Fast file pattern matching. Supports glob patterns like "**/*.ts" or "src/**/*.{js,jsx}". Returns matching file paths sorted by modification time (newest first).

- Use this to find files by name. Use Grep to search file contents.
- node_modules, .git and common build directories are skipped unless the pattern names them.
- Run several Globs in parallel when exploring.`,
    parameters: {
        type: "object",
        properties: {
            pattern: { type: "string", description: "Glob pattern to match" },
            path: { type: "string", description: "Directory to search in (defaults to the working directory)" },
        },
        required: ["pattern"],
    },
    title: (i) => `Glob(${i.pattern ?? ""}${i.path ? ` in ${i.path}` : ""})`,
    async run(input, ctx) {
        const root = expandPath(input.path ?? ".", ctx.state.cwd);
        const st = await stat(root).catch(() => undefined);
        if (!st?.isDirectory()) return { content: `Directory not found: ${root}`, isError: true };
        const glob = new Bun.Glob(input.pattern);
        const hide = searchFilter(ctx, "Glob", root);
        const explicit = DEFAULT_IGNORES.filter((d) => input.pattern.includes(d));
        const SHOW = 200;
        // Bun.Glob can't prune directories, so every match it yields counts (ignored ones too), and time is bounded as well.
        const SCAN_CAP = 100_000;
        const deadline = Date.now() + 10_000;
        // Newest SHOW files so far, newest first; the scan keeps going so a large tree can't hide them.
        const newest: { path: string; mtime: number }[] = [];
        let total = 0;
        let scanned = 0;
        let capped = false;
        for await (const file of glob.scan({ cwd: root, onlyFiles: true, dot: input.pattern.includes("/.") || input.pattern.startsWith("."), followSymlinks: false })) {
            if (ctx.signal.aborted) break;
            if (++scanned > SCAN_CAP || (scanned % 256 === 0 && Date.now() > deadline)) {
                capped = true;
                break;
            }
            const parts = file.split("/");
            if (parts.some((p) => DEFAULT_IGNORES.includes(p) && !explicit.includes(p))) continue;
            const abs = join(root, file);
            if (hide?.("Glob", abs)) continue;
            total++;
            const s = await stat(abs).catch(() => undefined);
            const mtime = s?.mtimeMs ?? 0;
            if (newest.length >= SHOW && mtime <= newest[SHOW - 1]!.mtime) continue;
            let i = newest.length;
            while (i > 0 && newest[i - 1]!.mtime < mtime) i--;
            newest.splice(i, 0, { path: abs, mtime });
            if (newest.length > SHOW) newest.pop();
        }
        const count = capped ? `${total}+` : `${total}`;
        if (!newest.length) return { content: "No files found", display: { summary: "No files found" } };
        let content = newest.map((r) => r.path).join("\n");
        if (total > newest.length) content += `\n(Results truncated: showing ${newest.length} of ${count}. Use a more specific pattern.)`;
        return { content, display: { summary: `Found ${count} file${total === 1 ? "" : "s"}` } };
    },
};

// ---------------------------------------------------------------------------

interface GrepInput {
    pattern: string;
    path?: string;
    glob?: string;
    type?: string;
    output_mode?: "content" | "files_with_matches" | "count";
    ignore_case?: boolean;
    show_line_numbers?: boolean;
    context?: number;
    before?: number;
    after?: number;
    multiline?: boolean;
    head_limit?: number;
}

export const GrepTool: Tool<GrepInput> = {
    name: "Grep",
    category: "read",
    readOnly: true,
    description: `Searches file contents with regular expressions (ripgrep syntax), respecting .gitignore.

- output_mode: "files_with_matches" (default, file paths only), "content" (matching lines), or "count".
- Filter files with glob (e.g. "*.ts", "**/*.{ts,tsx}") or type (e.g. "js", "py", "rust").
- In content mode use show_line_numbers, context / before / after for surrounding lines.
- Literal braces etc. must be escaped (e.g. "interface\\{\\}"). multiline: true lets patterns span lines.
- head_limit caps the number of output lines/files.
- Always use this instead of running grep or rg through Bash.`,
    parameters: {
        type: "object",
        properties: {
            pattern: { type: "string", description: "Regular expression to search for" },
            path: { type: "string", description: "File or directory to search (defaults to the working directory)" },
            glob: { type: "string", description: 'Glob to filter files, e.g. "*.js"' },
            type: { type: "string", description: 'File type, e.g. "js", "py", "go"' },
            output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Output format (default files_with_matches)" },
            ignore_case: { type: "boolean", description: "Case-insensitive search" },
            show_line_numbers: { type: "boolean", description: "Show line numbers (content mode)" },
            context: { type: "number", description: "Lines of context before and after each match (content mode)" },
            before: { type: "number", description: "Lines of context before each match (content mode)" },
            after: { type: "number", description: "Lines of context after each match (content mode)" },
            multiline: { type: "boolean", description: "Allow patterns to span lines" },
            head_limit: { type: "number", description: "Limit output to the first N lines/entries" },
        },
        required: ["pattern"],
    },
    title: (i) => `Grep(${i.pattern ?? ""}${i.path ? ` in ${i.path}` : ""}${i.glob ? ` ${i.glob}` : ""})`,
    async run(input, ctx) {
        const target = expandPath(input.path ?? ".", ctx.state.cwd);
        const mode = input.output_mode ?? "files_with_matches";
        const hide = searchFilter(ctx, "Grep", target);
        const rg = ripgrep();
        let out: string;
        let incomplete = false;
        let skipped: string[] = [];
        if (rg) {
            // --null: a NUL after every printed path, so results can be filtered per file.
            const args = ["--no-config", "--color=never", "--null", "--with-filename"];
            if (mode === "files_with_matches") args.push("-l");
            else if (mode === "count") args.push("-c");
            else {
                // rg counts bytes; a displayed character can take three UTF-8 bytes,
                // and URL encoding can triple a value's byte length.
                args.push("--max-columns", String(3 * (500 + MAX_SECRET_BYTES)), "--max-columns-preview");
                if (input.show_line_numbers !== false) args.push("-n");
                if (input.context) args.push("-C", String(input.context));
                if (input.before) args.push("-B", String(input.before));
                if (input.after) args.push("-A", String(input.after));
            }
            if (input.ignore_case) args.push("-i");
            if (input.multiline) args.push("-U", "--multiline-dotall");
            if (input.glob) args.push("--glob", input.glob);
            if (input.type) args.push("--type", input.type);
            args.push("--", input.pattern, target);
            const proc = Bun.spawn([rg, ...args], { cwd: ctx.state.cwd, stdout: "pipe", stderr: "pipe", env: childEnv() });
            const onAbort = () => proc.kill();
            ctx.signal.addEventListener("abort", onAbort, { once: true });
            const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
            const code = await proc.exited;
            ctx.signal.removeEventListener("abort", onAbort);
            if (code === 2 && !stdout) return { content: `Grep error: ${stderr.trim()}`, isError: true };
            out = filterRgOutput(stdout, mode, (p) => Boolean(hide?.("Grep", isAbsolute(p) ? p : join(ctx.state.cwd, p))), input.show_line_numbers !== false);
        } else {
            ({ out, incomplete, skipped } = await jsGrep(input, target, mode, ctx.signal, hide));
        }
        let lines = out.split("\n").filter((l) => l !== "");
        // Make paths relative for compactness.
        const base = ctx.state.cwd;
        lines = lines.map((l) => (l.startsWith(base + "/") ? l.slice(base.length + 1) : l));
        if (mode === "files_with_matches") {
            // Sort by mtime, newest first.
            const withTimes = await Promise.all(lines.map(async (l) => ({ l, t: (await stat(isAbsolute(l) ? l : join(base, l)).catch(() => undefined))?.mtimeMs ?? 0 })));
            lines = withTimes.sort((a, b) => b.t - a.t).map((x) => x.l);
        }
        const total = lines.length;
        const limit = input.head_limit ?? (mode === "content" ? 400 : 200);
        if (lines.length > limit) lines = lines.slice(0, limit);
        const notices: string[] = [];
        if (incomplete) notices.push("Search incomplete: the fallback scans at most 20,000 eligible files. Narrow path, glob or type, or install ripgrep to search the whole tree.");
        if (skipped.length) {
            const shown = skipped.slice(0, 5).map((f) => (f.startsWith(base + "/") ? f.slice(base.length + 1) : f));
            const more = skipped.length > shown.length ? `, and ${skipped.length - shown.length} more` : "";
            const them = skipped.length === 1 ? "it" : "them";
            notices.push(`Search incomplete: skipped ${skipped.length.toLocaleString("en-US")} file${skipped.length === 1 ? "" : "s"} over 5 MB, which the fallback doesn't search (${shown.join(", ")}${more}). Install ripgrep to search ${them}, or Read ${them} in parts with offset and limit.`);
        }
        const unsure = notices.length > 0;
        if (!total) return { content: unsure ? `No matches in the scanned files. ${notices.join(" ")}` : "No matches found", display: { summary: unsure ? "Search incomplete" : "No matches" } };
        let content = truncateMiddle(redact(lines.join("\n")), 30_000);
        if (total > lines.length) content += `\n(Showing ${lines.length} of ${total}. Narrow the search or raise head_limit.)`;
        for (const notice of notices) content += `\n(${notice})`;
        const noun = mode === "files_with_matches" ? "file" : mode === "count" ? "file" : "line";
        return { content: redact(content), display: { summary: `Found ${total} ${noun}${total === 1 ? "" : "s"}${unsure ? " (search incomplete)" : ""}` } };
    },
};

/**
 * The per-file filter for a search rooted at `root`. Deny rules and the
 * credential store always apply. When the user approved searching a root
 * that was itself ask-gated or sensitive, files gated for that same reason
 * are fair game; nothing else is.
 */
export function searchFilter(ctx: Pick<ToolContext, "hidden">, toolName: string, root: string): ((toolName: string, abs: string) => boolean) | undefined {
    const hidden = ctx.hidden;
    if (!hidden) return undefined;
    const approved = hidden(toolName, root);
    return (tool, abs) => {
        const why = hidden(tool, abs);
        return why !== undefined && why !== approved;
    };
}

/**
 * Drop records for hidden files from `rg --null --with-filename` output and
 * restore the usual `path:` form. Every record is `path NUL rest NEWLINE`
 * (or a `--` separator), so the path is read up to its NUL: splitting on
 * newlines first would let a filename containing one hide its real path.
 */
export function filterRgOutput(stdout: string, mode: string, hidden: (path: string) => boolean, showLineNumbers = true): string {
    if (mode === "files_with_matches") return stdout.split("\0").filter((p) => p && !hidden(p)).join("\n");
    // A path with a newline in it is checked whole and from every line start, in case it isn't one.
    const hide = (p: string) => hidden(p) || (p.includes("\n") && p.split("\n").some((_, i, parts) => hidden(parts.slice(i).join("\n"))));
    const out: string[] = [];
    let i = 0;
    while (i < stdout.length) {
        if (stdout.startsWith("--\n", i) || (stdout.startsWith("--", i) && i + 2 === stdout.length)) {
            if (out.length && out[out.length - 1] !== "--") out.push("--");
            i += 3;
            continue;
        }
        const nul = stdout.indexOf("\0", i);
        if (nul < 0) {
            const rest = stdout.slice(i).replace(/\n$/, "");
            if (rest) out.push(rest);
            break;
        }
        const nl = stdout.indexOf("\n", nul);
        const end = nl < 0 ? stdout.length : nl;
        const path = stdout.slice(i, nul);
        let rest = stdout.slice(nul + 1, end);
        if (mode === "content") {
            // Match against the extra preview, but choose what to show by original
            // positions: earlier redactions can shrink an unfinished tail into view.
            const prefix = showLineNumbers ? rest.match(/^\d+[:-]/)?.[0] ?? "" : "";
            rest = redactPrefix(rest, prefix.length + 500).slice(0, prefix.length + 500);
        }
        i = end + 1;
        if (hide(path)) continue;
        out.push(path + (showLineNumbers && /^\d+-/.test(rest) ? "-" : ":") + rest);
    }
    while (out[out.length - 1] === "--") out.pop();
    return out.join("\n");
}

/** The fallback doesn't search files bigger than this; it reports the ones it skips. */
const JS_GREP_MAX_BYTES = 5_000_000;

async function jsGrep(input: GrepInput, target: string, mode: string, signal: AbortSignal, hide?: (toolName: string, abs: string) => boolean): Promise<{ out: string; incomplete: boolean; skipped: string[] }> {
    const flags = (input.ignore_case ? "i" : "") + (input.multiline ? "ms" : "");
    let re: RegExp;
    try {
        re = new RegExp(input.pattern, flags);
    } catch (e) {
        return { out: `Invalid regex: ${(e as Error).message}`, incomplete: false, skipped: [] };
    }
    const fileGlob = input.glob ? new Bun.Glob(input.glob.includes("/") ? input.glob : `**/${input.glob}`) : undefined;
    const exts = input.type ? TYPE_EXTS[input.type.toLowerCase()] : undefined;
    if (input.type && !exts) return { out: `Grep error: unrecognized file type: ${input.type}`, incomplete: false, skipped: [] };
    const out: string[] = [];
    const st = await stat(target).catch(() => undefined);
    const files: string[] = [];
    let incomplete = false;
    if (st?.isFile()) files.push(target);
    else if (st?.isDirectory()) {
        const wanted = (f: string) => (!fileGlob || fileGlob.match(f)) && (!exts || exts.includes(f.slice(f.lastIndexOf(".") + 1).toLowerCase())) && !hide?.("Grep", join(target, f));
        const candidates = await candidateFiles(target, wanted);
        incomplete = candidates.incomplete;
        for (const f of candidates.files) files.push(join(target, f));
    }
    const before = Math.max(0, input.before ?? input.context ?? 0);
    const after = Math.max(0, input.after ?? input.context ?? 0);
    const num = input.show_line_numbers !== false;
    const skipped: string[] = [];
    for (const f of files) {
        if (signal.aborted) break;
        // Check the size first, so a huge file is never loaded.
        let size: number;
        try {
            size = statSync(f).size;
        } catch {
            continue;
        }
        if (size > JS_GREP_MAX_BYTES) {
            skipped.push(f);
            continue;
        }
        const buf = await readFile(f).catch(() => undefined);
        if (!buf || looksBinary(buf)) continue;
        const text = buf.toString("utf-8");
        if (mode === "files_with_matches") {
            if (re.test(text)) out.push(f);
            continue;
        }
        const lines = text.split("\n");
        const { hits, matches, spanning } = matchingLines(text, lines, re, Boolean(input.multiline));
        if (mode === "count") {
            // Like ripgrep: lines, except when a multiline match crosses a newline, then matches.
            const n = spanning ? matches : hits.length;
            if (n) out.push(`${f}:${n}`);
            continue;
        }
        // Matches with ":" and context lines with "-", groups split by "--", like ripgrep.
        const hitSet = new Set(hits);
        let last = -2;
        for (const h of hits) {
            const from = Math.max(0, h - before, last + 1);
            const to = Math.min(lines.length - 1, h + after);
            if (last >= 0 && from > last + 1) out.push("--");
            for (let i = from; i <= to; i++) {
                const sep = hitSet.has(i) ? ":" : "-";
                out.push(`${f}${sep}${num ? `${i + 1}${sep}` : ""}${redactPrefix(lines[i]!, 500).slice(0, 500)}`);
            }
            last = Math.max(last, to);
        }
    }
    return { out: out.join("\n"), incomplete, skipped };
}

/** Line indexes (sorted) that a match touches (with multiline, a match can span several), the match count, and whether any match contains a newline. */
function matchingLines(text: string, lines: string[], re: RegExp, multiline: boolean): { hits: number[]; matches: number; spanning: boolean } {
    if (!multiline) {
        const hits = lines.flatMap((line, i) => (re.test(line) ? [i] : []));
        return { hits, matches: hits.length, spanning: false };
    }
    const starts: number[] = [];
    for (let i = 0, off = 0; i < lines.length; off += lines[i]!.length + 1, i++) starts.push(off);
    const lineAt = (offset: number) => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid]! <= offset) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    };
    const hit = new Set<number>();
    let n = 0;
    let spanning = false;
    for (const m of text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) {
        const a = lineAt(m.index);
        const b = lineAt(m.index + Math.max(0, m[0].length - 1));
        for (let i = a; i <= b; i++) hit.add(i);
        if (m[0].includes("\n")) spanning = true;
        if (++n > 100_000) break;
    }
    return { hits: [...hit].sort((x, y) => x - y), matches: n, spanning };
}

/** File extensions per --type for the fallback search (a subset of ripgrep's list). */
const TYPE_EXTS: Record<string, string[]> = {
    js: ["js", "jsx", "mjs", "cjs"],
    ts: ["ts", "tsx", "mts", "cts"],
    py: ["py", "pyi"],
    go: ["go"],
    rust: ["rs"],
    java: ["java"],
    kotlin: ["kt", "kts"],
    c: ["c", "h"],
    cpp: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "h"],
    cs: ["cs"],
    ruby: ["rb"],
    php: ["php"],
    swift: ["swift"],
    sh: ["sh", "bash", "zsh"],
    md: ["md", "markdown"],
    markdown: ["md", "markdown"],
    json: ["json"],
    yaml: ["yaml", "yml"],
    toml: ["toml"],
    html: ["html", "htm"],
    css: ["css", "scss", "sass", "less"],
    sql: ["sql"],
    lua: ["lua"],
    scala: ["scala"],
    dart: ["dart"],
    elixir: ["ex", "exs"],
};

/**
 * Files to search under `dir`, relative to it. In a git work tree that's
 * what git lists (so .gitignore is honored, as ripgrep would); hidden files
 * are skipped either way, also like ripgrep.
 */
async function candidateFiles(dir: string, wanted: (f: string) => boolean): Promise<{ files: string[]; incomplete: boolean }> {
    const tracked = gitListFiles(dir);
    // The cap applies after filtering, so a glob or type still finds files late in a big tree.
    if (tracked) {
        const files = tracked.filter((f) => !f.split("/").some((p) => p.startsWith(".")) && wanted(f));
        return { files: files.slice(0, 20_000), incomplete: files.length > 20_000 };
    }
    const out: string[] = [];
    for await (const f of new Bun.Glob("**/*").scan({ cwd: dir, onlyFiles: true })) {
        if (f.split("/").some((p) => DEFAULT_IGNORES.includes(p)) || !wanted(f)) continue;
        if (out.length >= 20_000) return { files: out, incomplete: true };
        out.push(f);
    }
    return { files: out, incomplete: false };
}

// ---------------------------------------------------------------------------

export const LSTool: Tool<{ path?: string; ignore?: string[] }> = {
    name: "LS",
    category: "read",
    readOnly: true,
    description: "Lists files and directories in a directory (one level), with sizes. Directories end with '/'. Prefer Glob/Grep when you know what you're looking for.",
    parameters: {
        type: "object",
        properties: {
            path: { type: "string", description: "Directory to list (defaults to the working directory)" },
            ignore: { type: "array", items: { type: "string" }, description: "Glob patterns to ignore" },
        },
        required: [],
    },
    title: (i) => `LS(${i.path ?? "."})`,
    async run(input, ctx) {
        const dir = expandPath(input.path ?? ".", ctx.state.cwd);
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch (e) {
            return { content: `Cannot list ${dir}: ${(e as Error).message}`, isError: true };
        }
        const ignores = (input.ignore ?? []).map((g) => new Bun.Glob(g));
        const rows: string[] = [];
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const e of entries) {
            if (ignores.some((g) => g.match(e.name))) continue;
            if (e.isDirectory()) rows.push(`${e.name}/`);
            else {
                const s = await stat(join(dir, e.name)).catch(() => undefined);
                rows.push(`${e.name}${s ? `  (${formatBytes(s.size)})` : ""}`);
            }
            if (rows.length >= 500) {
                rows.push(`… ${entries.length - 500} more`);
                break;
            }
        }
        return {
            content: `${dir}/\n${rows.map((r) => `  ${r}`).join("\n") || "  (empty)"}`,
            display: { summary: `Listed ${entries.length} entr${entries.length === 1 ? "y" : "ies"} in ${displayPath(dir, ctx.state.projectRoot) || relative(ctx.state.cwd, dir) || "."}` },
        };
    },
};
