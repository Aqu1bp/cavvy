// What the terminal panel links in its output (gui/src/lib/terminal-links.ts): web addresses, and paths with a line
// and column that may be files (the server says which are, on hover).
import { describe, expect, test } from "bun:test";
import { isLocalUrl, MAX_LINE_LINKS, terminalLinks } from "../gui/src/lib/terminal-links";
import { linkProvider } from "../gui/src/lib/terminal-link-provider";

const shown = (text: string) => terminalLinks(text).map((l) => ({ text: text.slice(l.start, l.end), ...(l.kind === "url" ? { url: l.url } : { path: l.path, line: l.line, col: l.col }) }));

describe("urls", () => {
    test("a dev server's address", () => {
        expect(shown("  ➜  Local:   http://localhost:5173/")).toEqual([{ text: "http://localhost:5173/", url: "http://localhost:5173/" }]);
    });
    test("punctuation after it isn't part of it", () => {
        expect(shown("See https://example.com/docs.")).toEqual([{ text: "https://example.com/docs", url: "https://example.com/docs" }]);
        expect(shown("(https://example.com/a_(b)), then")).toEqual([{ text: "https://example.com/a_(b)", url: "https://example.com/a_(b)" }]);
        expect(shown("at <https://example.com/x>")).toEqual([{ text: "https://example.com/x", url: "https://example.com/x" }]);
        expect(shown("'http://127.0.0.1:8080/?q=1&b=2'")[0]?.url).toBe("http://127.0.0.1:8080/?q=1&b=2");
    });
    test("a scheme alone, or another scheme, isn't one", () => {
        expect(shown("https:// nothing")).toEqual([]);
        expect(shown("ftp://example.com javascript:alert(1)")).toEqual([]);
    });
    test("a path inside a url isn't linked again", () => {
        expect(shown("https://github.com/org/repo/blob/main/src/a.ts")).toHaveLength(1);
    });
});

describe("paths", () => {
    test("with a line and a column", () => {
        expect(shown("src/server/engine.ts:780:12: error")).toEqual([{ text: "src/server/engine.ts:780:12", path: "src/server/engine.ts", line: 780, col: 12 }]);
        expect(shown("  --> src/main.rs:3:5")).toEqual([{ text: "src/main.rs:3:5", path: "src/main.rs", line: 3, col: 5 }]);
    });
    test("as a compiler writes the position", () => {
        expect(shown("src/a.ts(12,5): error TS2322")).toEqual([{ text: "src/a.ts(12,5)", path: "src/a.ts", line: 12, col: 5 }]);
    });
    test("in a stack trace, inside parentheses", () => {
        expect(shown("    at run (/Users/me/app/src/index.js:10:3)")).toEqual([{ text: "/Users/me/app/src/index.js:10:3", path: "/Users/me/app/src/index.js", line: 10, col: 3 }]);
    });
    test("plain names with an extension, relative and home paths", () => {
        expect(shown("modified:   README.md")).toEqual([{ text: "README.md", path: "README.md", line: undefined, col: undefined }]);
        expect(shown("./scripts/build.sh and ~/notes/todo.txt")).toEqual([
            { text: "./scripts/build.sh", path: "./scripts/build.sh", line: undefined, col: undefined },
            { text: "~/notes/todo.txt", path: "~/notes/todo.txt", line: undefined, col: undefined },
        ]);
    });
    test("an option's value", () => {
        expect(shown("--config=tsconfig.json")[0]?.path).toBe("tsconfig.json");
    });
    test("what isn't a path", () => {
        expect(shown("version 1.2.3 on 127.0.0.1:3000, localhost:8080, done.")).toEqual([]);
        expect(shown("git@github.com:org/repo.git")).toEqual([]);
        expect(shown("-rw-r--r-- 1 me staff")).toEqual([]);
    });
    test("positions are the line's, with wide characters before", () => {
        const text = "错误 src/a.ts:1";
        const [link] = terminalLinks(text);
        expect(text.slice(link!.start, link!.end)).toBe("src/a.ts:1");
    });
    test("a line with very many is cut short", () => {
        expect(terminalLinks(Array.from({ length: 100 }, (_, i) => `f${i}.ts`).join(" "))).toHaveLength(MAX_LINE_LINKS);
    });
});

test("which addresses are this machine's", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:5173/x", "http://0.0.0.0:8000", "http://[::1]:4000/", "http://app.localhost/"]) expect(isLocalUrl(url)).toBe(true);
    for (const url of ["https://example.com", "http://192.168.1.2:3000", "http://localhost.example.com", "not a url"]) expect(isLocalUrl(url)).toBe(false);
});

describe("the provider xterm asks", () => {
    // A screen of `cols` columns: each row's text, wrapped on from the row before where `wrapped`.
    const screen = (cols: number, rows: { text: string; wrapped?: boolean }[]) => {
        const lines = rows.map((r) => {
            const cells: { chars: string; width: number }[] = [];
            for (const ch of r.text) {
                const wide = /\p{Script=Han}/u.test(ch);
                cells.push({ chars: ch, width: wide ? 2 : 1 });
                if (wide) cells.push({ chars: "", width: 0 });
            }
            while (cells.length < cols) cells.push({ chars: "", width: 1 });
            return {
                isWrapped: !!r.wrapped,
                length: cols,
                getCell: (x: number) => ({ getChars: () => cells[x]!.chars, getWidth: () => cells[x]!.width }),
            };
        });
        return { buffer: { active: { getLine: (y: number) => lines[y] } } } as never;
    };
    const ask = (provider: ReturnType<typeof linkProvider>, y: number) => new Promise<{ text: string; range: unknown }[] | undefined>((done) => provider.provideLinks(y, (links) => done(links?.map((l) => ({ text: l.text, range: l.range })))));
    const actions = (files: Record<string, string>, asked: string[][]) => ({
        exists: async (paths: string[]) => (asked.push(paths), paths.map((p) => files[p] ?? null)),
        openUrl() {},
        openFile() {},
        hint() {},
    });

    test("a link opens on a plain click, not a right-click (the menu) or a middle-click", async () => {
        const opened: string[] = [];
        const provider = linkProvider(screen(30, [{ text: "see http://localhost:1/ a/b.ts:3" }]), { ...actions({ "a/b.ts": "/p/a/b.ts" }, []), openUrl: (u: string) => opened.push(u), openFile: (f: string) => opened.push(f) });
        const links = await new Promise<{ activate(e: MouseEvent, text: string): void }[]>((done) => provider.provideLinks(1, (l) => done((l ?? []) as never)));
        expect(links.length).toBe(2);
        for (const button of [2, 1]) for (const l of links) l.activate({ button } as MouseEvent, "");
        expect(opened).toEqual([]);
        for (const l of links) l.activate({ button: 0 } as MouseEvent, "");
        expect(opened).toEqual(["http://localhost:1/", "/p/a/b.ts"]);
    });

    test("a url wrapped onto the next row is one link, on either row", async () => {
        const provider = linkProvider(screen(11, [{ text: "go http://l" }, { text: "ocalhost:1/", wrapped: true }, { text: "next" }]), actions({}, []));
        const want = [{ text: "http://localhost:1/", range: { start: { x: 4, y: 1 }, end: { x: 11, y: 2 } } }];
        expect(await ask(provider, 1)).toEqual(want);
        expect(await ask(provider, 2)).toEqual(want);
        expect(await ask(provider, 3)).toBeUndefined();
    });
    test("columns count wide characters as two", async () => {
        const provider = linkProvider(screen(20, [{ text: "错 a/b.ts:3" }]), actions({ "a/b.ts": "/p/a/b.ts" }, []));
        expect(await ask(provider, 1)).toEqual([{ text: "a/b.ts:3", range: { start: { x: 4, y: 1 }, end: { x: 11, y: 1 } } }]);
    });
    test("a path is a link only if it's a file, asked once for a while", async () => {
        const asked: string[][] = [];
        const provider = linkProvider(screen(40, [{ text: "src/a.ts:1 src/gone.ts:2" }]), actions({ "src/a.ts": "/p/src/a.ts" }, asked));
        expect((await ask(provider, 1))?.map((l) => l.text)).toEqual(["src/a.ts:1"]);
        expect((await ask(provider, 1))?.map((l) => l.text)).toEqual(["src/a.ts:1"]);
        expect(asked).toEqual([["src/a.ts", "src/gone.ts"]]);
    });
    test("unanswered, only its urls are links", async () => {
        const provider = linkProvider(screen(60, [{ text: "src/a.ts http://localhost:3000" }]), { ...actions({}, []), exists: () => Promise.reject(new Error("offline")) });
        expect((await ask(provider, 1))?.map((l) => l.text)).toEqual(["http://localhost:3000"]);
    });
});
