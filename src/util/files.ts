import { homedir } from "os";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { realpathSync } from "fs";

export function expandPath(p: string, cwd: string): string {
    let s = p.trim();
    if (s === "~") s = homedir();
    else if (s.startsWith("~/")) s = join(homedir(), s.slice(2));
    return isAbsolute(s) ? resolve(s) : resolve(cwd, s);
}

/** Resolve symlinks when the path exists; otherwise resolve the nearest existing parent. */
export function canonical(p: string): string {
    try {
        return realpathSync(p);
    } catch {
        const parent = resolve(p, "..");
        if (parent === p) return p;
        return join(canonical(parent), p.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    }
}

export function isInside(child: string, parent: string): boolean {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
