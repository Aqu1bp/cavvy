import { homedir } from "os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { lstatSync, readlinkSync, realpathSync } from "fs";

export function expandPath(p: string, cwd: string): string {
    let s = p.trim();
    if (s === "~") s = homedir();
    else if (s.startsWith("~/")) s = join(homedir(), s.slice(2));
    return isAbsolute(s) ? resolve(s) : resolve(cwd, s);
}

/**
 * Resolve symlinks when the path exists; otherwise resolve the nearest
 * existing parent. A dangling symlink resolves to its target: writing
 * through it creates the target, so that's where the write lands.
 */
export function canonical(p: string, hops = 0): string {
    try {
        return realpathSync(p);
    } catch {
        if (hops < 40) {
            try {
                if (lstatSync(p).isSymbolicLink()) return canonical(resolve(dirname(p), readlinkSync(p)), hops + 1);
            } catch {
                // not there at all
            }
        }
        const parent = resolve(p, "..");
        if (parent === p) return p;
        return join(canonical(parent, hops), p.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    }
}

/** macOS and Windows volumes ignore case by default: `.HARNESS` is `.harness` there. */
export const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * Text folded so that names a case-insensitive volume opens as the same file
 * come out alike. APFS compares names by Unicode case folding, not by
 * lower-casing: `.harneſſ` (long s) and `.harneẞ` are `.harness` there, and
 * toLowerCase changes neither. This is Unicode's compatibility caseless
 * match: full case folding (taken here as lower(upper(lower)), which turns
 * ß and ẞ into "ss", ſ into "s", ﬅ into "st", the Kelvin sign into "k"),
 * NFKC (fullwidth ｈ is h), and invisible characters dropped. That is wider
 * than any one volume (APFS keeps fullwidth letters apart): right for
 * finding protected names, wrong for exempting a name. Folding never adds a
 * `/` (fullwidth ／ becomes ∕), so a name stays one path segment.
 */
export function caselessFold(s: string): string {
    return s.split("/").map(foldName).join("/");
}

function foldName(s: string): string {
    let out = s.replace(INVISIBLE, "");
    // Twice: case mapping can leave text that normalizes further, and back.
    for (let i = 0; i < 2; i++) out = out.normalize("NFKC").toLowerCase().toUpperCase().toLowerCase();
    // Lower-casing picks σ or ς by position in the word; folding has only σ.
    return out.normalize("NFKC").replace(INVISIBLE, "").replace(/ς/g, "σ").replace(/\//g, "∕");
}

/**
 * The ways to spell a path when matching it against protected names. On a
 * case-insensitive volume: lower-cased, which is never wider than what the
 * volume equates (so exemptions like `.env.example` can be judged on it),
 * and caselessFold'ed, which is wider (so nothing the volume would open as
 * a protected name gets past). Elsewhere just as given. A check protects
 * the path if any spelling matches, and exempts it only if every one does.
 */
export const CASE_FOLDS: readonly ((s: string) => string)[] = CASE_INSENSITIVE_FS ? [(s) => s.toLowerCase(), caselessFold] : [(s) => s];

export function spellings(s: string): string[] {
    return [...new Set(CASE_FOLDS.map((f) => f(s)))];
}

export function isInside(child: string, parent: string): boolean {
    const rel = relative(parent, child);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Pretty path for display: relative to cwd when inside it, ~ for home. */
export function displayPath(p: string, cwd: string): string {
    if (isInside(p, cwd)) return relative(cwd, p) || ".";
    const home = homedir();
    if (isInside(p, home)) return "~/" + relative(home, p);
    return p;
}

const IMAGE_TYPES: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
};

export function imageMediaType(path: string): string | undefined {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return IMAGE_TYPES[ext];
}

export function looksBinary(buf: Uint8Array): boolean {
    const n = Math.min(buf.length, 8000);
    let suspicious = 0;
    for (let i = 0; i < n; i++) {
        const c = buf[i]!;
        if (c === 0) return true;
        if (c < 7 || (c > 13 && c < 32)) suspicious++;
    }
    return n > 0 && suspicious / n > 0.1;
}

/** Number lines like `cat -n`, truncating very long lines. */
export function numberLines(lines: string[], startLine: number, maxLineLen = 2000): string {
    return lines
        .map((l, i) => {
            const text = l.length > maxLineLen ? l.slice(0, maxLineLen) + "… [line truncated]" : l;
            return `${String(startLine + i).padStart(6)}\t${text}`;
        })
        .join("\n");
}

export function truncateMiddle(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const head = Math.floor(maxChars * 0.4);
    const tail = maxChars - head;
    const omitted = text.length - head - tail;
    const omittedLines = text.slice(head, text.length - tail).split("\n").length - 1;
    return `${text.slice(0, head)}\n\n… [${omitted} characters / ~${omittedLines} lines omitted] …\n\n${text.slice(text.length - tail)}`;
}

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
