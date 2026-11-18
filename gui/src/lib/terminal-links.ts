// What in a terminal's line is a link: web addresses, and file paths (with a line and column) that may be files. Pure:
// the terminal (TerminalScreen.tsx, terminal-link-provider.ts) asks it about one line at a time, the line under the
// pointer, never about output as it arrives.

interface Span {
    /** Where it is in the line's text: from `start` up to (not including) `end`. */
    start: number;
    end: number;
}
export type TerminalLink = Span & ({ kind: "url"; url: string } | { kind: "path"; path: string; line?: number; col?: number });

/** Links in one line, at most: a wall of paths shouldn't mean a wall of lookups. */
export const MAX_LINE_LINKS = 40;

const URL = /\bhttps?:\/\/[^\s"'`<>\u0000-\u001f\u007f]+/gi;
/** A run of what may be a path: up to whitespace, quotes and what separates words in output (a comma after one is trimmed). */
const TOKEN = /[^\s"'`<>|;=\u0000-\u001f\u007f]+/g;
const LEAD = /^[(\[{]+/;
/** Sentence punctuation after a link, which is not part of it. */
const TRAIL = /[.,:;!?]+$/;
/** `file.ts(12,5)`, as compilers write a position. */
const PAREN_POS = /\((\d{1,8})(?:,(\d{1,6}))?\)$/;

/** A path, as replies' paths are read (lib/markdown.ts parsePathRef), with an optional :line[:col]. */
const PATH = /^((?:~\/|\.{1,2}\/|\/)?(?:[\p{L}\p{N}_@+.\-]+\/)*[\p{L}\p{N}_@+.\-]+)(?::(\d{1,8})(?::(\d{1,6}))?)?$/u;

/** A path and where in it, or undefined: it needs a slash or a file extension, and a letter. */
function pathRef(s: string): { path: string; line?: number; col?: number } | undefined {
    const m = PATH.exec(s);
    const path = m?.[1];
    if (!path || path.startsWith("-") || path.endsWith(".") || !/\p{L}/u.test(path)) return undefined;
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!name || (!path.includes("/") && (path.length < 4 || !/[^.]\.\p{L}[\p{L}\p{N}]{0,9}$/u.test(name)))) return undefined;
    const line = Number(m[2]) || undefined;
    return { path, line, col: line ? Number(m[3]) || undefined : undefined };
}

/** Drops closing brackets that close nothing in the text before them (a link in parentheses). */
function unclosed(s: string): string {
    for (;;) {
        const last = s.at(-1);
        const open = last === ")" ? "(" : last === "]" ? "[" : last === "}" ? "{" : undefined;
        if (!open || s.split(open).length > s.split(last!).length - 1) return s;
        s = s.slice(0, -1);
    }
}

/** Trailing punctuation and unbalanced brackets, off the end (as often as they alternate). */
function trimEnd(s: string): string {
    for (;;) {
        const t = unclosed(s.replace(TRAIL, ""));
        if (t === s) return s;
        s = t;
    }
}

/** A `localhost`, loopback or any-address URL: a server on the machine that runs the shell. */
export function isLocalUrl(url: string): boolean {
    try {
        const host = new globalThis.URL(url).hostname.toLowerCase();
        return host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
    } catch {
        return false;
    }
}

/** The links in a line of terminal output, in order. Paths are candidates: whether each is a file is for the caller to ask. */
export function terminalLinks(text: string): TerminalLink[] {
    const out: TerminalLink[] = [];
    const taken: Span[] = [];
    for (const m of text.matchAll(URL)) {
        const url = trimEnd(m[0]);
        // "https://" alone, or with nothing past the scheme but punctuation.
        if (url.length <= m[0].indexOf("//") + 2) continue;
        const span = { start: m.index, end: m.index + url.length };
        taken.push(span);
        out.push({ ...span, kind: "url", url });
    }
    for (const m of text.matchAll(TOKEN)) {
        if (out.length >= MAX_LINE_LINKS) break;
        const at = m.index;
        if (taken.some((s) => at < s.end && at + m[0].length > s.start)) continue;
        const lead = LEAD.exec(m[0])?.[0].length ?? 0;
        const token = m[0].slice(lead).replace(TRAIL, "");
        // file.ts(12,5): its position, as file.ts:12:5 would give it.
        const pos = PAREN_POS.exec(token);
        const named = pos ? token.slice(0, pos.index) : trimEnd(token);
        // An address of another kind (git@host:path, a scheme) isn't a file here.
        if (!named || /^[a-z][a-z0-9+.-]*:\/\//i.test(named)) continue;
        const ref = pathRef(named);
        if (!ref) continue;
        const line = pos ? Number(pos[1]) || undefined : ref.line;
        const col = pos ? (line ? Number(pos[2]) || undefined : undefined) : ref.col;
        const length = pos ? named.length + pos[0].length : named.length;
        out.push({ start: at + lead, end: at + lead + length, kind: "path", path: ref.path, ...(line ? { line } : {}), ...(col ? { col } : {}) });
    }
    return out.sort((a, b) => a.start - b.start).slice(0, MAX_LINE_LINKS);
}
