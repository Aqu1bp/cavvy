// Go to file, Search in project and the file viewer, through the GUI server's requests (fs.files, fs.search,
// fs.read): what each lists, finds and reads, each search backend, and what's refused (outside the session's
// folders, links out of it, traversal), in a git project and a plain folder.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { startMockLlm } = await import("../scripts/mock-llm");
const { searchProject, ripgrepPath, preview, queryRegExp, PREVIEW_CHARS } = await import("../src/server/project-search");
const { MAX_VIEW_TEXT } = await import("../src/server/file-view");
const { FileIndex } = await import("../src/ui/mentions");
import type { FileContent, ProjectSearchResult, SessionSnapshot } from "../src/server/protocol";

const mock = startMockLlm({ delayMs: 0 });
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));

const engine = new Engine({});
const c = { subs: new Set<string>(), send() {} };
engine.clients.add(c);
const call = <T,>(method: string, params: unknown) => engine.handle(c, method as never, params) as Promise<T>;

const outside = realpathSync(tempDir("cavvy-files-out-"));
writeFileSync(join(outside, "secret.txt"), "needle outside\n");

/** A project: source files, an ignored one, a link out, a picture, a binary file and a big one. */
function project(git: boolean): string {
    const dir = realpathSync(tempDir("cavvy-files-proj-"));
    mkdirSync(join(dir, "src/lib"), { recursive: true });
    mkdirSync(join(dir, "logs"));
    writeFileSync(join(dir, "src/engine.ts"), "export const needle = 1;\nconst Needle = 2;\nconst needles = 3;\n");
    writeFileSync(join(dir, "src/lib/util.ts"), "// util\nexport function find(x: string) { return x; }\n");
    writeFileSync(join(dir, "README.md"), "# Demo\n\nThe needle is here.\n");
    writeFileSync(join(dir, ".gitignore"), "logs/\n");
    writeFileSync(join(dir, "logs/run.log"), "needle in an ignored file\n");
    // A 1×1 PNG.
    writeFileSync(join(dir, "dot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 110, 101, 101, 100, 108, 101]));
    writeFileSync(join(dir, "big.txt"), "x".repeat(MAX_VIEW_TEXT + 1));
    symlinkSync(join(outside, "secret.txt"), join(dir, "leak.txt"));
    symlinkSync(outside, join(dir, "out-dir"));
    symlinkSync(join(dir, "README.md"), join(dir, "readme-link.md"));
    if (git) {
        for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.email=me@example.com", "-c", "user.name=me", "commit", "-qm", "init"]]) {
            const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "pipe" });
            if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString()}`);
        }
    }
    return dir;
}

let repo: string;
let plain: string;
let repoId: string;
let plainId: string;

beforeAll(async () => {
    repo = project(true);
    plain = project(false);
    repoId = ((await call<SessionSnapshot>("session.create", { cwd: repo })).state.id);
    plainId = ((await call<SessionSnapshot>("session.create", { cwd: plain })).state.id);
});

afterAll(async () => {
    await engine.stop();
    mock.stop();
    iso.cleanup();
});

async function rejects(p: Promise<unknown>, code: string) {
    const e = (await p.then(() => undefined, (e) => e)) as { code?: string } | undefined;
    expect(e).toBeDefined();
    expect(e!.code).toBe(code);
}

describe("fs.files (Go to file)", () => {
    test("lists the session's files best match first, without folders or ignored files", async () => {
        const r = await call<{ paths: string[] }>("fs.files", { sessionId: repoId, query: "engine" });
        expect(r.paths[0]).toBe("src/engine.ts");
        expect(r.paths.every((p) => !p.endsWith("/"))).toBe(true);
        const all = await call<{ paths: string[] }>("fs.files", { sessionId: repoId, query: "", limit: 200 });
        expect(all.paths).toContain("src/lib/util.ts");
        expect(all.paths).not.toContain("logs/run.log");
    });

    test("a link out of the session's folders isn't listed (the viewer would refuse it); one inside is", async () => {
        for (const id of [repoId, plainId]) {
            const all = await call<{ paths: string[] }>("fs.files", { sessionId: id, query: "", limit: 200 });
            expect(all.paths).not.toContain("leak.txt");
            expect(all.paths).not.toContain("out-dir");
            expect(all.paths).toContain("readme-link.md");
        }
    });

    test("fuzzy: the letters in order", async () => {
        const r = await call<{ paths: string[] }>("fs.files", { sessionId: repoId, query: "slut" });
        expect(r.paths).toContain("src/lib/util.ts");
    });

    test("outside a repository too (the folder read a level at a time)", async () => {
        const r = await call<{ paths: string[] }>("fs.files", { sessionId: plainId, query: "util" });
        expect(r.paths[0]).toBe("src/lib/util.ts");
    });

    test("caps what it sends", async () => {
        const r = await call<{ paths: string[] }>("fs.files", { sessionId: repoId, query: "", limit: 2 });
        expect(r.paths.length).toBe(2);
    });

    test("a folder that isn't open is refused", async () => {
        await rejects(call("fs.files", { cwd: outside, query: "" }), "not_open");
    });
});

describe("the listing's lifetime", () => {
    test("let go of when unused, listed again when next asked", async () => {
        const dir = project(true);
        const index = new FileIndex(dir);
        expect(await index.searchSoon("later", 5)).toEqual([]);
        writeFileSync(join(dir, "later.ts"), "");
        // Still the listing it made (fresh for a while).
        expect(await index.searchSoon("later", 5)).toEqual([]);
        index.release();
        expect(await index.searchSoon("later", 5)).toEqual(["later.ts"]);
        index.dispose();
    });
});

describe("fs.read (the file viewer)", () => {
    test("reads a text file by its relative or absolute path", async () => {
        const r = await call<FileContent>("fs.read", { sessionId: repoId, path: "src/engine.ts" });
        expect(r).toMatchObject({ kind: "text", rel: "src/engine.ts", path: join(repo, "src/engine.ts") });
        expect(r.kind === "text" && r.text.startsWith("export const needle")).toBe(true);
        const abs = await call<FileContent>("fs.read", { sessionId: repoId, path: join(repo, "README.md") });
        expect(abs.rel).toBe("README.md");
    });

    test("an image comes as its bytes; a binary file and a big one as what they are", async () => {
        const img = await call<FileContent>("fs.read", { sessionId: repoId, path: "dot.png" });
        expect(img).toMatchObject({ kind: "image", mediaType: "image/png" });
        expect(await call<FileContent>("fs.read", { sessionId: repoId, path: "blob.bin" })).toMatchObject({ kind: "binary", size: 11 });
        const big = await call<FileContent>("fs.read", { sessionId: repoId, path: "big.txt" });
        expect(big).toMatchObject({ kind: "large" });
        expect("text" in big).toBe(false);
    });

    test("a link inside the folder to a file in it is read", async () => {
        expect(await call<FileContent>("fs.read", { sessionId: repoId, path: "readme-link.md" })).toMatchObject({ kind: "text" });
    });

    test("refuses what's outside the session's folders: traversal, absolute paths and links out", async () => {
        await rejects(call("fs.read", { sessionId: repoId, path: `../${outside.split("/").pop()}/secret.txt` }), "outside");
        await rejects(call("fs.read", { sessionId: repoId, path: join(outside, "secret.txt") }), "outside");
        await rejects(call("fs.read", { sessionId: repoId, path: "leak.txt" }), "outside");
        await rejects(call("fs.read", { sessionId: repoId, path: "out-dir/secret.txt" }), "outside");
        await rejects(call("fs.read", { sessionId: repoId, path: "/etc/passwd" }), "outside");
    });

    test("refuses folders, missing files and odd paths", async () => {
        await rejects(call("fs.read", { sessionId: repoId, path: "src" }), "invalid");
        await rejects(call("fs.read", { sessionId: repoId, path: "nope.ts" }), "not_found");
        await rejects(call("fs.read", { sessionId: repoId, path: "-rf" }), "refused");
        await rejects(call("fs.read", { sessionId: repoId, path: "a\0b" }), "invalid");
    });

    test("a session that isn't there is refused", async () => {
        await rejects(call("fs.read", { sessionId: "nope", path: "README.md" }), "not_open");
    });
});

const files = (r: ProjectSearchResult) => r.files.map((f) => f.path).sort();
const rg = ripgrepPath();
const backends = [
    ["rg", () => repo],
    ["git", () => repo],
    ["js", () => plain],
] as const;

describe.each(backends)("searchProject with %s", (backend, root) => {
    const run = (query: string, o: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } = {}, limits?: object) =>
        searchProject(root(), { query, ...o }, new AbortController().signal, { backend, limits });
    const skip = backend === "rg" && !rg;

    test.skipIf(skip)("finds text by file and line, case-insensitive by default, never outside the folder or in ignored files", async () => {
        const r = await run("needle");
        expect(r.via).toBe(backend);
        // The scan has no .gitignore to go by (a plain folder); ripgrep and git leave logs/ out.
        expect(files(r)).toEqual(backend === "js" ? ["README.md", "logs/run.log", "src/engine.ts"] : ["README.md", "src/engine.ts"]);
        const engine = r.files.find((f) => f.path === "src/engine.ts")!;
        expect(engine.hits.map((h) => h.line)).toEqual([1, 2, 3]);
        expect(engine.hits[0]!.preview).toEqual({ text: "export const needle = 1;", ranges: [[13, 19]] });
        // Not through the links out of it, nor in the binary file.
        expect(files(r)).not.toContain("leak.txt");
        expect(files(r).some((p) => p.startsWith("out-dir"))).toBe(false);
        expect(files(r)).not.toContain("blob.bin");
    });

    test.skipIf(skip)("match case, whole word and regular expressions", async () => {
        const lines = async (q: string, o: object) => (await run(q, o)).files.find((f) => f.path === "src/engine.ts")?.hits.map((h) => h.line) ?? [];
        expect(await lines("Needle", { caseSensitive: true })).toEqual([2]);
        expect(await lines("needle", { wholeWord: true })).toEqual([1, 2]);
        expect(await lines("needles?\\s=\\s[13]", { regex: true })).toEqual([1, 3]);
        // Not a regular expression unless asked: the dot is a dot.
        expect(await lines("needle.", {})).toEqual([]);
    });

    test.skipIf(skip)("an invalid regular expression is an error to show", async () => {
        expect(await run("(", { regex: true }).then(() => "ok", (e: Error) => e.message)).toMatch(/^Not a valid regular expression/);
    });

    test.skipIf(skip)("stops at its cap and says so", async () => {
        const r = await run("e", {}, { matches: 2 });
        expect(r.matches).toBe(2);
        expect(r.truncated).toBe(true);
    });

    test.skipIf(skip)("a query starting with a dash is a query, not an option", async () => {
        const r = await run("--files");
        expect(r.matches).toBe(0);
    });

    test.skipIf(skip)("stopped by its signal", async () => {
        const ctl = new AbortController();
        ctl.abort();
        const r = await searchProject(root(), { query: "needle" }, ctl.signal, { backend });
        expect(r.matches).toBeLessThan(5);
    });
});

describe("fs.search", () => {
    test("searches the session's folder (git or ripgrep in a repository, the scan elsewhere)", async () => {
        const r = await call<ProjectSearchResult>("fs.search", { sessionId: repoId, query: "needle" });
        expect(files(r)).toEqual(["README.md", "src/engine.ts"]);
        expect(r.via).toBe(rg ? "rg" : "git");
        const p = await call<ProjectSearchResult>("fs.search", { sessionId: plainId, query: "find(" });
        expect(p.via).toBe(rg ? "rg" : "js");
        expect(files(p)).toEqual(["src/lib/util.ts"]);
    });

    test("a window's newer search stops its last one", async () => {
        const first = call<ProjectSearchResult>("fs.search", { sessionId: repoId, query: "e" });
        const second = call<ProjectSearchResult>("fs.search", { sessionId: repoId, query: "needle" });
        expect((await first).cancelled).toBe(true);
        expect((await second).cancelled).toBeUndefined();
    });

    test("fs.searchCancel stops it", async () => {
        const first = call<ProjectSearchResult>("fs.search", { sessionId: repoId, query: "e" });
        await call("fs.searchCancel", {});
        expect((await first).cancelled).toBe(true);
    });

    test("refuses an empty or multi-line query, and an invalid expression", async () => {
        await rejects(call("fs.search", { sessionId: repoId, query: "" }), "invalid");
        await rejects(call("fs.search", { sessionId: repoId, query: "a\nb" }), "invalid");
        await rejects(call("fs.search", { sessionId: repoId, query: "(", regex: true }), "invalid");
    });
});

describe("previews", () => {
    test("a long line is cut around its first match", () => {
        const line = "a".repeat(1000) + "needle" + "b".repeat(1000);
        const p = preview(line, [[1000, 1006]]);
        expect(p.text.length).toBe(PREVIEW_CHARS);
        expect(p.text.slice(p.ranges[0]![0], p.ranges[0]![1])).toBe("needle");
        expect(p.from).toBe(960);
    });

    test("queryRegExp: literal, whole word, case", () => {
        expect(queryRegExp({ query: "a.b" })!.test("axb")).toBe(false);
        expect(queryRegExp({ query: "need", wholeWord: true })!.test("needle")).toBe(false);
        expect(queryRegExp({ query: "Need", caseSensitive: true })!.test("need")).toBe(false);
        expect(queryRegExp({ query: "(", regex: true })).toBeUndefined();
    });
});
