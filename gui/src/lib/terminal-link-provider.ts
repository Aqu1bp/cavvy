// The terminal's links (lib/terminal-links.ts) for xterm, which asks for them one line at a time as the pointer moves
// onto a line: nothing here runs as output arrives. A path is a link only once the server says it's a file the
// editor may open (fs.exists, asked on that hover and kept for a moment), so a name that isn't one isn't underlined.

import type { IBufferCell, IBufferRange, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { terminalLinks, type TerminalLink } from "./terminal-links";

/** Rows of one wrapped line read at most: a line longer than this is linked in its first rows only. */
const MAX_ROWS = 32;
/** How long an answer about a path is kept: a file a build writes is linked a moment later. */
const KEEP_MS = 5000;
const KEEP_MOST = 500;

export interface LinkActions {
    /** Which of these paths are files the editor may open: each one's absolute path, or null. */
    exists(paths: string[]): Promise<(string | null)[]>;
    openUrl(url: string): void;
    openFile(path: string, line?: number, col?: number): void;
    /** What a press on it does, said as the pointer rests on it. */
    /** `at`: the pointer on the link, where its tooltip shows. */
    hint(link: TerminalLink, on: boolean, at?: MouseEvent): void;
}

/** One logical line (its wrapped rows joined) as text, with the cell each character is in. */
function logicalLine(term: Terminal, row: number): { text: string; cells: { x: number; y: number; w: number }[] } | undefined {
    const buffer = term.buffer.active;
    let top = row;
    while (top > 0 && row - top < MAX_ROWS && buffer.getLine(top)?.isWrapped) top--;
    let text = "";
    const cells: { x: number; y: number; w: number }[] = [];
    let cell: IBufferCell | undefined;
    for (let y = top; y < top + MAX_ROWS; y++) {
        const line = buffer.getLine(y);
        if (!line || (y > top && !line.isWrapped)) break;
        for (let x = 0; x < line.length; x++) {
            cell = line.getCell(x, cell);
            const w = cell?.getWidth() ?? 1;
            // The second half of a wide character.
            if (!cell || w === 0) continue;
            const chars = cell.getChars() || " ";
            for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: y + 1, w });
            text += chars;
        }
    }
    return cells.length ? { text, cells } : undefined;
}

export function linkProvider(term: Terminal, act: LinkActions): ILinkProvider & { forget(): void } {
    const known = new Map<string, { abs: string | null; at: number }>();
    const fresh = (path: string) => {
        const k = known.get(path);
        return k && performance.now() - k.at < KEEP_MS ? k : undefined;
    };
    return {
        forget: () => known.clear(),
        provideLinks(y, done) {
            const line = logicalLine(term, y - 1);
            if (!line) return done(undefined);
            const rangeOf = (l: TerminalLink): IBufferRange => {
                const a = line.cells[l.start]!;
                const b = line.cells[l.end - 1]!;
                return { start: { x: a.x, y: a.y }, end: { x: b.x + b.w - 1, y: b.y } };
            };
            // The links on the row under the pointer (a link wrapped onto it from the row before included).
            const found = terminalLinks(line.text)
                .map((l) => ({ l, range: rangeOf(l) }))
                .filter(({ range }) => range.start.y <= y && range.end.y >= y);
            if (!found.length) return done(undefined);
            const make = (l: TerminalLink, range: IBufferRange, abs?: string): ILink => ({
                range,
                text: line.text.slice(l.start, l.end),
                decorations: { underline: true, pointerCursor: true },
                // A plain (left) click only: a right-click is the terminal's menu, a middle-click its paste.
                activate: (e) => {
                    if (e.button !== 0) return;
                    if (l.kind === "url") act.openUrl(l.url);
                    else act.openFile(abs!, l.line, l.col);
                },
                hover: (e) => act.hint(l, true, e),
                leave: () => act.hint(l, false),
            });
            const asking = [...new Set(found.flatMap(({ l }) => (l.kind === "path" && !fresh(l.path) ? [l.path] : [])))];
            const answer = () =>
                done(found.flatMap(({ l, range }) => {
                    if (l.kind === "url") return [make(l, range)];
                    const abs = fresh(l.path)?.abs;
                    return abs ? [make(l, range, abs)] : [];
                }));
            if (!asking.length) return answer();
            act.exists(asking).then(
                (abs) => {
                    const at = performance.now();
                    asking.forEach((p, i) => known.set(p, { abs: abs[i] ?? null, at }));
                    while (known.size > KEEP_MOST) known.delete(known.keys().next().value!);
                    answer();
                },
                // Not asked (offline, the folder isn't open here): its paths aren't links this time.
                () => done(found.flatMap(({ l, range }) => (l.kind === "url" ? [make(l, range)] : []))),
            );
        },
    };
}
