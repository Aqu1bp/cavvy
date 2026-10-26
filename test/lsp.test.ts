import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { encodeMessage, MessageReader } = await import("../src/lsp/protocol");
const { compare, buildReport, formatForModel, summaryLine, fileHeadline, redactedReport, MAX_PER_FILE, MAX_PER_REPORT, MAX_MESSAGE } = await import("../src/lsp/diagnostics");
const { BUILTIN_SERVERS, lspEnabled, lspServers, resolveCommand, serverFor } = await import("../src/lsp/config");
const { LspManager, LspPool } = await import("../src/lsp/manager");
const { loadSettings } = await import("../src/config/settings");
const { renderDiagnostics } = await import("../src/ui/components");
const { stripAnsi } = await import("../src/ui/ansi");

const FIXTURE = join(import.meta.dir, "fixtures", "fake-lsp.ts");
const dirs: string[] = [];
const managers: InstanceType<typeof LspManager>[] = [];
afterAll(async () => {
    await Promise.all(managers.map((m) => m.dispose()));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    iso.cleanup();
});

function project(): string {
    const d = realpathSync(tempDir("cavvy-lsp-"));
    dirs.push(d);
    return d;
}

const NO_BUILTINS = Object.fromEntries(Object.keys(BUILTIN_SERVERS).map((n) => [n, { disabled: true }]));

function fakeServer(env: Record<string, string> = {}, exts: Record<string, string> = { ".ts": "typescript" }, extra: Record<string, unknown> = {}) {
    return { command: process.execPath, args: [FIXTURE], env, extensionToLanguage: exts, ...extra };
}

function manager(root: string, servers: Record<string, unknown>, o: { notices?: string[]; timing?: Record<string, number>; settings?: Record<string, unknown> } = {}) {
    const settings = { lsp: { servers: { ...NO_BUILTINS, ...servers } }, ...o.settings } as any;
    const m = new LspManager({
        root,
        settings: () => settings,
        notice: (_l, msg) => o.notices?.push(msg),
        warmTimeoutMs: 1500,
        coldTimeoutMs: 6000,
        settleMs: 60,
        ...o.timing,
    });
    managers.push(m);
    return m;
}

const diag = (line: number, message: string, severity = 1, code?: string) => ({ range: { start: { line, character: 2 }, end: { line, character: 5 } }, severity, message, ...(code ? { code, source: "ts" } : {}) });

// ---------------------------------------------------------------------------

describe("wire format", () => {
    test("messages split across chunks, byte by byte, with multi-byte text", () => {
        const got: unknown[] = [];
        const r = new MessageReader((m) => got.push(m));
        const a = encodeMessage({ jsonrpc: "2.0", method: "x", params: { s: "héllo ✓ 日本" } });
        const b = encodeMessage({ jsonrpc: "2.0", id: 2, result: null });
        const all = new Uint8Array([...a, ...b]);
        for (const byte of all) r.push(new Uint8Array([byte]));
        expect(got).toEqual([
            { jsonrpc: "2.0", method: "x", params: { s: "héllo ✓ 日本" } },
            { jsonrpc: "2.0", id: 2, result: null },
        ]);
    });

    test("a body that isn't JSON, or a header with no length, is skipped and reading goes on", () => {
        const got: unknown[] = [];
        const r = new MessageReader((m) => got.push(m));
        const enc = new TextEncoder();
        r.push(enc.encode("Content-Length: 3\r\n\r\nnopX-Junk: 1\r\n\r\n"));
        r.push(encodeMessage({ jsonrpc: "2.0", id: 1, result: 7 }));
        expect(got).toEqual([{ jsonrpc: "2.0", id: 1, result: 7 }]);
    });
});

describe("what gets reported", () => {
    test("first report lists everything; later ones only what's new, matched by message not line", () => {
        const first = compare("a.ts", undefined, [diag(3, "Type 'string' is not assignable", 1, "2322"), diag(9, "unused", 2)]);
        expect(first.first).toBe(true);
        expect(first.items.map((i) => [i.line, i.col, i.severity])).toEqual([
            [4, 3, "error"],
            [10, 3, "warning"],
        ]);
        expect(fileHeadline(first)).toBe("1 error, 1 warning");
        // Both moved down two lines and one more error came: only that one is new.
        const later = compare("a.ts", [diag(3, "Type 'string' is not assignable", 1, "2322"), diag(9, "unused", 2)], [diag(5, "Type 'string' is not assignable", 1, "2322"), diag(11, "unused", 2), diag(1, "Cannot find name 'x'", 1)]);
        expect(later.items.map((i) => i.message)).toEqual(["Cannot find name 'x'"]);
        expect(later.fixed).toBe(0);
        expect(fileHeadline(later)).toBe("1 new error");
    });

    test("a second copy of a known error is new; ones that went away count as fixed", () => {
        const r = compare("a.ts", [diag(1, "dup"), diag(2, "gone"), diag(3, "gone too", 2)], [diag(1, "dup"), diag(4, "dup")]);
        expect(r.items.map((i) => i.line)).toEqual([5]);
        expect(r.fixed).toBe(2);
        expect(fileHeadline(r)).toBe("1 new error, 2 fixed");
    });

    test("hints and information are left out; a missing severity counts as an error", () => {
        const r = compare("a.ts", undefined, [diag(1, "info", 3), diag(2, "hint", 4), { range: diag(3, "").range, message: "no severity" }]);
        expect(r.items.map((i) => [i.message, i.severity])).toEqual([["no severity", "error"]]);
    });

    test("errors come before warnings, so the cap keeps them", () => {
        const list = [...Array.from({ length: 30 }, (_, i) => diag(i, `warn ${i}`, 2)), ...Array.from({ length: 5 }, (_, i) => diag(100 + i, `err ${i}`, 1))];
        const r = compare("a.ts", undefined, list);
        expect(r.items).toHaveLength(MAX_PER_FILE);
        expect(r.items.slice(0, 5).every((i) => i.severity === "error")).toBe(true);
        expect(r.total).toBe(35);
        expect([r.newErrors, r.newWarnings]).toEqual([5, 30]);
    });

    test("a huge list is capped per file and per report, with long messages cut to one line", () => {
        const many = (n: number, tag: string) => Array.from({ length: n }, (_, i) => diag(i, `${tag} ${i}\n  second line ${"x".repeat(MAX_MESSAGE)}`));
        const files = ["a.ts", "b.ts", "c.ts"].map((p) => compare(p, undefined, many(500, p)));
        const report = buildReport(files)!;
        const shown = report.files.reduce((a, f) => a + f.items.length, 0);
        expect(shown).toBe(MAX_PER_REPORT);
        expect(report.omitted).toBe(1500 - MAX_PER_REPORT);
        const msg = report.files[0]!.items[0]!.message;
        expect(msg.includes("\n")).toBe(false);
        expect(msg.length).toBeLessThanOrEqual(MAX_MESSAGE);
        const text = formatForModel(report);
        expect(text).toContain("a.ts: 500 errors");
        expect(text).toContain("… and 480 more");
        expect(text.length).toBeLessThan(20_000);
    });

    test("nothing new and nothing fixed is no report; only fixes says so", () => {
        expect(buildReport([compare("a.ts", [diag(1, "x")], [diag(2, "x")])])).toBeUndefined();
        const fixed = buildReport([compare("a.ts", [diag(1, "x")], [])])!;
        expect(summaryLine(fixed)).toBe("1 fixed");
        expect(formatForModel(fixed)).toContain("problems resolved by this change");
    });

    test("the model's text names place, severity, source and code", () => {
        const r = buildReport([compare("src/a.ts", undefined, [diag(11, "Type 'string' is not assignable to type 'number'.", 1, "2322")])])!;
        expect(formatForModel(r)).toBe(
            [
                "<new-diagnostics>",
                "The language server reports these problems after this change. Fix the errors you caused before moving on; ignore ones unrelated to your task.",
                "src/a.ts: 1 error",
                "  12:3 error [ts 2322]: Type 'string' is not assignable to type 'number'.",
                "</new-diagnostics>",
            ].join("\n"),
        );
        expect(summaryLine(r)).toBe("1 error");
    });

    test("secrets in messages are redacted for windows", () => {
        const key = "sk-ant-api03-" + "q".repeat(40);
        const r = buildReport([compare("a.ts", undefined, [diag(0, `Type '"${key}"' is not assignable`)])])!;
        expect(JSON.stringify(redactedReport(r))).not.toContain(key);
    });
});

describe("which server", () => {
    test("built-ins by extension; settings add, replace or turn them off", () => {
        const all = lspServers({});
        expect(serverFor("/p/a.tsx", all, () => true)?.languageId).toBe("typescriptreact");
        expect(serverFor("/p/a.py", all, () => true)?.server.name).toBe("pyright");
        // pyright not installed: basedpyright is next for .py
        expect(serverFor("/p/a.py", all, (s) => s.name !== "pyright")?.server.name).toBe("basedpyright");
        expect(serverFor("/p/README.md", all, () => true)).toBeUndefined();
        expect(serverFor("/p/Makefile", all, () => true)).toBeUndefined();

        const mine = lspServers({ lsp: { servers: { typescript: { command: "deno", args: ["lsp"], extensionToLanguage: { ".ts": "typescript" } }, gopls: { disabled: true } as any, broken: { command: "" } as any } } });
        const ts = mine.find((s) => s.name === "typescript")!;
        expect([ts.command, ts.builtin]).toEqual(["deno", false]);
        expect(mine.some((s) => s.name === "gopls")).toBe(false);
        expect(mine.some((s) => s.name === "broken")).toBe(false);
        // The replaced built-in's .tsx isn't handled any more.
        expect(serverFor("/p/a.tsx", mine, () => true)).toBeUndefined();
    });

    test("turned off with false or enabled: false", () => {
        expect(lspEnabled({})).toBe(true);
        expect(lspEnabled({ lsp: false })).toBe(false);
        expect(lspEnabled({ lsp: { enabled: false } })).toBe(false);
        expect(lspEnabled({ lsp: { servers: {} } })).toBe(true);
    });

    test("a project's node_modules/.bin runs only in a trusted folder; explicit paths resolve from the project", () => {
        const root = project();
        mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
        const bin = join(root, "node_modules", ".bin", "my-fake-ls");
        writeFileSync(bin, "#!/bin/sh\n");
        chmodSync(bin, 0o755);
        expect(resolveCommand("my-fake-ls", root, true)).toBe(bin);
        expect(resolveCommand("my-fake-ls", root, false)).toBeUndefined();
        expect(resolveCommand("./node_modules/.bin/my-fake-ls", root, false)).toBe(bin);
        expect(resolveCommand("/definitely/not/here", root, true)).toBeUndefined();
        expect(resolveCommand("definitely-not-installed-lsp-xyz", root, true)).toBeUndefined();
    });

    test("settings layers add servers by name; an untrusted project's servers don't count", () => {
        const root = project();
        mkdirSync(join(root, ".cavvy"), { recursive: true });
        writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ lsp: { servers: { deno: fakeServer() } } }));
        writeFileSync(join(root, ".cavvy", "settings.json"), JSON.stringify({ lsp: { servers: { evil: fakeServer({}, { ".rs": "rust" }) } } }));
        const trusted = loadSettings(root, { trusted: true });
        expect(Object.keys((trusted.lsp as any).servers).sort()).toEqual(["deno", "evil"]);
        const untrusted = loadSettings(root, { trusted: false });
        expect(Object.keys((untrusted.lsp as any).servers)).toEqual(["deno"]);
        writeFileSync(join(root, ".cavvy", "settings.json"), JSON.stringify({ lsp: false }));
        expect(lspEnabled(loadSettings(root, { trusted: true }))).toBe(false);
        rmSync(join(iso.home, "settings.json"));
    });

    test("/trust in the terminal: an untrusted project's servers count from then on, without a restart", async () => {
        const { App } = await import("../src/ui/app");
        const { runCommand } = await import("../src/commands/index");
        const root = project();
        mkdirSync(join(root, ".cavvy"), { recursive: true });
        writeFileSync(join(root, ".cavvy", "settings.json"), JSON.stringify({ lsp: { servers: { mine: fakeServer() } } }));
        const notices: string[] = [];
        const app: any = { cwd: root, init: { trusted: false }, settings: loadSettings(root, { trusted: false }), classifier: { clearCache() {} }, applyCliRules() {}, customCommands: [], skills: [], notice: (t: string) => notices.push(t), showDialog: async () => true, print() {}, renderLive() {} };
        app.projectTrusted = App.prototype.projectTrusted.bind(app);
        app.reloadSettings = App.prototype.reloadSettings.bind(app);
        expect((app.settings.lsp as any)?.servers?.mine).toBeUndefined();
        await runCommand(app, "/trust");
        expect(Object.keys((app.settings.lsp as any).servers)).toEqual(["mine"]);
        expect(app.init.trusted).toBe(true);
        expect(notices.at(-1)).toBe(`Trusted ${root}. Its settings, language servers, commands and skills apply now; its MCP servers load when you next start here.`);
    });
});

// ---------------------------------------------------------------------------
// Against a real process: the fake server in test/fixtures.

describe("diagnostics after an edit", () => {
    test("errors come back with the edit, then only news: fixed, unchanged, new", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer() });
        const file = join(root, "src", "a.ts");
        const r1 = await m.afterEdit(file, "const a = 1;\nERROR: Type 'string' is not assignable\nWARN: unused b\n");
        expect(r1?.files.map((f) => [f.path, f.newErrors, f.newWarnings])).toEqual([[join("src", "a.ts"), 1, 1]]);
        expect(r1!.files[0]!.items[0]).toMatchObject({ line: 2, col: 1, severity: "error", source: "fake", code: "error" });
        // Same problems, moved: nothing to say.
        expect(await m.afterEdit(file, "\n\nconst a = 1;\nERROR: Type 'string' is not assignable\nWARN: unused b\n")).toBeUndefined();
        const r3 = await m.afterEdit(file, "const a = 1;\n");
        expect(summaryLine(r3!)).toBe("2 fixed");
        expect(m.status()).toHaveLength(1);
    });

    test("a file no server handles, outside the project or too big, starts nothing", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer() });
        expect(m.handles(join(root, "notes.md"))).toBe(false);
        expect(await m.afterEdit(join(root, "notes.md"), "ERROR: x")).toBeUndefined();
        expect(await m.afterEdit("/tmp/elsewhere/a.ts", "ERROR: x")).toBeUndefined();
        expect(await m.afterEdit(join(root, "big.ts"), "ERROR: x\n" + "x".repeat(3 * 1024 * 1024))).toBeUndefined();
        expect(m.status()).toEqual([]);
    });

    test("a server set up differently since it started (settings edited, a plugin updated) is restarted, not reused", async () => {
        const root = project();
        const [one, two] = [join(root, "one.log"), join(root, "two.log")];
        const settings: any = { lsp: { servers: { ...NO_BUILTINS, fake: fakeServer({ FAKE_LSP_LOG: one }) } } };
        const m = new LspManager({ root, settings: () => settings, warmTimeoutMs: 1500, coldTimeoutMs: 6000, settleMs: 60 });
        managers.push(m);
        const file = join(root, "a.ts");
        expect((await m.afterEdit(file, "ERROR: one\n"))?.files[0]?.newErrors).toBe(1);
        const methods = (log: string) => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l).method) : []);
        // Unchanged: the same process answers.
        await m.afterEdit(file, "ERROR: one\nERROR: again\n");
        expect(methods(one).filter((x) => x === "initialize")).toHaveLength(1);
        settings.lsp.servers.fake = fakeServer({ FAKE_LSP_LOG: two });
        expect((await m.afterEdit(file, "ERROR: two\n"))?.files[0]?.newErrors).toBe(1);
        expect(methods(two)).toContain("initialize");
        expect(methods(two)).toContain("textDocument/didOpen");
        await Bun.sleep(300);
        expect(methods(one)).toContain("shutdown");
        expect(m.status()).toHaveLength(1);
    });

    test("turned off in settings: nothing runs", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer() }, { settings: { lsp: false } });
        expect(await m.afterEdit(join(root, "a.ts"), "ERROR: x")).toBeUndefined();
        expect(m.status()).toEqual([]);
    });

    test("no language server installed: built-ins say nothing; one from settings warns once", async () => {
        const root = project();
        const pool = new LspPool(root);
        const notices: string[] = [];
        const builtin = { name: "typescript", command: "definitely-not-installed-lsp-xyz", extensionToLanguage: { ".ts": "typescript" }, builtin: true };
        expect(pool.available(builtin, true)).toBe("missing");

        const m = manager(root, { mine: { command: "definitely-not-installed-lsp-xyz", extensionToLanguage: { ".ts": "typescript" } } }, { notices });
        expect(await m.afterEdit(join(root, "a.ts"), "ERROR: x")).toBeUndefined();
        expect(await m.afterEdit(join(root, "b.ts"), "ERROR: x")).toBeUndefined();
        expect(notices).toEqual(['Language server "mine" can\'t start: definitely-not-installed-lsp-xyz isn\'t installed or isn\'t on PATH.']);
    });

    test("a slow server: the edit stops waiting at the timeout and the diagnostics come later", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_DELAY: "900" }) }, { timing: { coldTimeoutMs: 400 } });
        const file = join(root, "a.ts");
        const t = Date.now();
        expect(await m.afterEdit(file, "ERROR: slow one")).toBeUndefined();
        expect(Date.now() - t).toBeLessThan(800);
        expect(m.takeLate()).toBeUndefined();
        await Bun.sleep(1300);
        const late = m.takeLate();
        expect(late?.files[0]?.items.map((i) => i.message)).toEqual(["slow one"]);
        // Reported once.
        expect(m.takeLate()).toBeUndefined();
    });

    test("late diagnostics for an older version of a file aren't reported once a newer version was sent", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_DELAY: "600", FAKE_LSP_VERSION: "1" }) }, { timing: { warmTimeoutMs: 400 } });
        const file = join(root, "a.ts");
        // Started and warm, so the timings below are the server's delay alone.
        await m.afterEdit(join(root, "b.ts"), "");
        expect(await m.afterEdit(file, "ERROR: already fixed in version 2")).toBeUndefined();
        // Version 2 goes out before version 1's diagnostics arrive; they come in while it waits.
        expect(await m.afterEdit(file, "clean")).toBeUndefined();
        expect(m.takeLate()).toBeUndefined();
        // Version 2's own (clean) diagnostics: nothing was reported, so nothing to say.
        await Bun.sleep(900);
        expect(m.takeLate()).toBeUndefined();
    });

    for (const [what, env] of [
        ["say", { FAKE_LSP_VERSION: "1" }],
        ["don't say", {}],
    ] as const) {
        test(`late diagnostics that came in before a newer version was sent aren't reported (servers that ${what} the version)`, async () => {
            const root = project();
            const m = manager(root, { fake: fakeServer({ FAKE_LSP_DELAY: "400", ...env }) }, { timing: { warmTimeoutMs: 200 } });
            const file = join(root, "a.ts");
            await m.afterEdit(join(root, "b.ts"), "");
            await Bun.sleep(500);
            expect(await m.afterEdit(file, "ERROR: already fixed in version 2")).toBeUndefined();
            // Version 1's diagnostics come in and wait to be reported...
            await Bun.sleep(400);
            // ...but version 2 replaced that text before they were.
            expect(await m.afterEdit(file, "clean")).toBeUndefined();
            expect(m.takeLate()).toBeUndefined();
            // Nor a "fixed" for an error never reported, once version 2's come in.
            await Bun.sleep(600);
            expect(m.takeLate()).toBeUndefined();
        });
    }

    test("a server that answers on request and starts after the edit stopped waiting: its diagnostics still come, later", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_PULL: "1", FAKE_LSP_INIT_DELAY: "600" }) }, { timing: { coldTimeoutMs: 300 } });
        expect(await m.afterEdit(join(root, "a.ts"), "ERROR: found once it started")).toBeUndefined();
        await Bun.sleep(1200);
        expect(m.takeLate()?.files[0]?.items.map((i) => i.message)).toEqual(["found once it started"]);
    });

    test("after a server restarts, files edited before are checked again (they're opened in the new one)", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_PULL: "1", FAKE_LSP_CROSS: "1" }) }, { timing: { idleMs: 200 } });
        writeFileSync(join(root, "a.ts"), "clean a");
        expect(await m.afterEdit(join(root, "a.ts"), "clean a")).toBeUndefined();
        await Bun.sleep(1000);
        expect(m.status()).toEqual([]);
        writeFileSync(join(root, "b.ts"), "BREAKS: a.ts");
        const r = await m.afterEdit(join(root, "b.ts"), "BREAKS: a.ts");
        expect(r?.files.map((f) => [f.path, f.items.map((i) => i.message)])).toEqual([["a.ts", ["broken by b.ts"]]]);
    });

    test("a server that crashes after a newer version was sent: its diagnostics about the older one aren't reported", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_DELAY: "400", FAKE_LSP_VERSION: "1" }) }, { timing: { warmTimeoutMs: 200 } });
        const file = join(root, "a.ts");
        await m.afterEdit(join(root, "b.ts"), "");
        await Bun.sleep(500);
        expect(await m.afterEdit(file, "ERROR: fixed before it was reported")).toBeUndefined();
        await Bun.sleep(400);
        expect(await m.afterEdit(file, "clean")).toBeUndefined();
        expect(await m.afterEdit(join(root, "c.ts"), "CRASH")).toBeUndefined();
        await Bun.sleep(200);
        expect(m.status()).toEqual([]);
        expect(m.takeLate()).toBeUndefined();
    });

    test("a file reached through a symlink to outside the project starts nothing", async () => {
        const root = project();
        const outside = project();
        symlinkSync(outside, join(root, "ext"));
        writeFileSync(join(outside, "x.ts"), "ERROR: not this project's");
        const m = manager(root, { fake: fakeServer() });
        expect(m.handles(join(root, "ext", "x.ts"))).toBe(false);
        expect(await m.afterEdit(join(root, "ext", "x.ts"), "ERROR: not this project's")).toBeUndefined();
        expect(m.status()).toEqual([]);
    });

    test("a file edited before and replaced by a symlink out of the project since: closed, not sent", async () => {
        const root = project();
        const outside = project();
        writeFileSync(join(outside, "x.ts"), "ERROR: not this project's");
        const m = manager(root, { fake: fakeServer() });
        writeFileSync(join(root, "a.ts"), "clean");
        await m.afterEdit(join(root, "a.ts"), "clean");
        rmSync(join(root, "a.ts"));
        symlinkSync(join(outside, "x.ts"), join(root, "a.ts"));
        expect(await m.afterEdit(join(root, "b.ts"), "")).toBeUndefined();
        expect(m.status()[0]!.files).toBe(1);
        expect(m.takeLate()).toBeUndefined();
    });

    test("a slow restart: the files edited before are asked about too, once it's up", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_PULL: "1", FAKE_LSP_CROSS: "1", FAKE_LSP_INIT_DELAY: "600" }) }, { timing: { coldTimeoutMs: 300, idleMs: 1500 } });
        writeFileSync(join(root, "a.ts"), "clean a");
        expect(await m.afterEdit(join(root, "a.ts"), "clean a")).toBeUndefined();
        await Bun.sleep(2300);
        expect(m.status()).toEqual([]);
        expect(m.takeLate()).toBeUndefined();
        writeFileSync(join(root, "b.ts"), "BREAKS: a.ts");
        expect(await m.afterEdit(join(root, "b.ts"), "BREAKS: a.ts")).toBeUndefined();
        await Bun.sleep(1200);
        expect(m.takeLate()?.files.map((f) => [f.path, f.items.map((i) => i.message)])).toEqual([["a.ts", ["broken by b.ts"]]]);
    });

    test("a file deleted before its late diagnostics were reported: they aren't", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_DELAY: "400", FAKE_LSP_VERSION: "1" }) }, { timing: { warmTimeoutMs: 200 } });
        await m.afterEdit(join(root, "c.ts"), "");
        await Bun.sleep(500);
        writeFileSync(join(root, "a.ts"), "ERROR: in a file that's gone");
        expect(await m.afterEdit(join(root, "a.ts"), "ERROR: in a file that's gone")).toBeUndefined();
        await Bun.sleep(400);
        unlinkSync(join(root, "a.ts"));
        await m.afterEdit(join(root, "b.ts"), "");
        expect(m.takeLate()).toBeUndefined();
    });

    test("binary content in a file named like code isn't sent", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer() });
        expect(await m.afterEdit(join(root, "a.ts"), "ERROR: x\0\0\u0001")).toBeUndefined();
        expect(m.status()).toEqual([]);
    });

    test("a server that stays silent when nothing changed doesn't hold every clean edit for the whole timeout", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_SILENT_CLEAN: "1", FAKE_LSP_DELAY: "50" }) }, { timing: { warmTimeoutMs: 5000 } });
        const file = join(root, "a.ts");
        await m.afterEdit(file, "const a = 1;\n");
        await m.afterEdit(file, "const a = 2;\n");
        const t = Date.now();
        expect(await m.afterEdit(file, "const a = 3;\n")).toBeUndefined();
        expect(Date.now() - t).toBeLessThan(1500);
    });

    test("diagnostics published in stages are taken together", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_STAGES: "1", FAKE_LSP_VERSION: "1" }) });
        const r = await m.afterEdit(join(root, "a.ts"), "ERROR: one\nERROR: two\n");
        expect(r?.files[0]?.items.map((i) => i.message)).toEqual(["one", "two"]);
    });

    test("a crash ends the wait at once, restarts on the next edit, and after three it stays off", async () => {
        const root = project();
        const notices: string[] = [];
        const m = manager(root, { fake: fakeServer() }, { notices, timing: { coldTimeoutMs: 8000 } });
        const file = join(root, "a.ts");
        let t = Date.now();
        expect(await m.afterEdit(file, "CRASH")).toBeUndefined();
        expect(Date.now() - t).toBeLessThan(4000);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain("exited with code 3");
        expect(notices[0]).toContain("restarts on the next edit");
        // Restarted:
        expect((await m.afterEdit(file, "ERROR: back"))?.files[0]?.items[0]?.message).toBe("back");
        await m.afterEdit(file, "CRASH");
        await m.afterEdit(file, "CRASH");
        expect(notices).toHaveLength(2);
        expect(notices[1]).toContain("stopped 3 times");
        t = Date.now();
        expect(await m.afterEdit(file, "ERROR: never")).toBeUndefined();
        expect(Date.now() - t).toBeLessThan(200);
        expect(m.status()).toEqual([]);
    });

    test("a server that never initializes counts as failing to start", async () => {
        const root = project();
        const notices: string[] = [];
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_NO_INIT: "1" }, { ".ts": "typescript" }, { startupTimeout: 300 }) }, { notices });
        const t = Date.now();
        expect(await m.afterEdit(join(root, "a.ts"), "ERROR: x")).toBeUndefined();
        expect(Date.now() - t).toBeLessThan(2000);
        expect(notices[0]).toContain("failed to start");
        expect(notices[0]).toContain("didn't answer initialize");
    });

    test("an interrupt stops the wait at once", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_DELAY: "3000" }) });
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 100);
        const t = Date.now();
        expect(await m.afterEdit(join(root, "a.ts"), "ERROR: x", ac.signal)).toBeUndefined();
        expect(Date.now() - t).toBeLessThan(600);
    });

    test("several languages: each file goes to its own server", async () => {
        const root = project();
        const m = manager(root, { tsfake: fakeServer(), pyfake: fakeServer({}, { ".py": "python" }) });
        const a = await m.afterEdit(join(root, "a.ts"), "ERROR: ts problem");
        const b = await m.afterEdit(join(root, "b.py"), "ERROR: py problem");
        expect(a?.files.map((f) => f.path)).toEqual(["a.ts"]);
        expect(b?.files.map((f) => f.path)).toEqual(["b.py"]);
        expect(m.status().map((s) => s.name).sort()).toEqual(["pyfake", "tsfake"]);
    });

    test("an edit that breaks another file edited earlier reports that file too; untouched files stay out", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_CROSS: "1" }) });
        await m.afterEdit(join(root, "a.ts"), "export const a = 1;\n");
        const r = await m.afterEdit(join(root, "b.ts"), "BREAKS: a.ts\nBREAKS: never-edited.ts\n");
        expect(r?.files.map((f) => [f.path, f.items[0]?.message])).toEqual([["a.ts", "broken by b.ts"]]);
    });

    test("sessions in one project share a server; it stops when the last lets go", async () => {
        const root = project();
        const log = join(root, "log.jsonl");
        const one = manager(root, { fake: fakeServer({ FAKE_LSP_LOG: log }) });
        const two = manager(root, { fake: fakeServer({ FAKE_LSP_LOG: log }) });
        await one.afterEdit(join(root, "a.ts"), "ERROR: x");
        // The other session hasn't been told about it: everything is news to it.
        const r = await two.afterEdit(join(root, "a.ts"), "ERROR: x\n");
        expect(r?.files[0]?.first).toBe(true);
        expect(one.status()[0]?.pid).toBe(two.status()[0]?.pid!);
        const pid = one.status()[0]!.pid!;
        await one.dispose();
        expect(alive(pid)).toBe(true);
        await two.dispose();
        expect(alive(pid)).toBe(false);
        const methods = readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l).method);
        expect(methods.filter((x) => x === "initialize")).toHaveLength(1);
        expect(methods).toContain("textDocument/didSave");
        expect(methods.slice(-2)).toEqual(["shutdown", "exit"]);
    });

    test("another session on the same manager starts its reports over", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer() });
        m.attach("s1", undefined);
        await m.afterEdit(join(root, "a.ts"), "ERROR: x");
        expect(await m.afterEdit(join(root, "a.ts"), "ERROR: x\n")).toBeUndefined();
        m.attach("s2", undefined);
        expect((await m.afterEdit(join(root, "a.ts"), "ERROR: x\n\n"))?.files[0]?.items).toHaveLength(1);
    });

    test("a server nobody edits for a while is stopped, and starts again on the next edit", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer() }, { timing: { idleMs: 200 } });
        await m.afterEdit(join(root, "a.ts"), "ERROR: x");
        const pid = m.status()[0]!.pid!;
        await Bun.sleep(1200);
        expect(m.status()).toEqual([]);
        expect(alive(pid)).toBe(false);
        expect((await m.afterEdit(join(root, "a.ts"), "ERROR: y"))?.files[0]?.items[0]?.message).toBe("y");
    });

    test("the idle time counts from when an edit's check ends, so a slow start isn't cut off", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_DELAY: "500" }) }, { timing: { idleMs: 200 } });
        expect((await m.afterEdit(join(root, "a.ts"), "ERROR: x"))?.files[0]?.items[0]?.message).toBe("x");
        expect(m.status()).toHaveLength(1);
        await Bun.sleep(1200);
        expect(m.status()).toEqual([]);
    });

    test("a server that writes a lot to stderr doesn't stall", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_STDERR: String(1024 * 1024) }) });
        expect((await m.afterEdit(join(root, "a.ts"), "ERROR: x"))?.files).toHaveLength(1);
    });
});

describe("servers that answer on request", () => {
    test("LSP pull diagnostics: the answer, with no waiting for pushes, even when nothing changed", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_PULL: "1" }) }, { timing: { warmTimeoutMs: 5000 } });
        const file = join(root, "a.ts");
        expect((await m.afterEdit(file, "ERROR: pulled"))?.files[0]?.items[0]?.message).toBe("pulled");
        expect(summaryLine((await m.afterEdit(file, "fine"))!)).toBe("1 fixed");
        const t = Date.now();
        expect(await m.afterEdit(file, "still fine")).toBeUndefined();
        expect(Date.now() - t).toBeLessThan(300);
    });

    test("typescript-language-server's own checks: tsserver's positions and categories become LSP's", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_TSSERVER: "1" }) });
        const r = await m.afterEdit(join(root, "a.ts"), "ok\n  ERROR: semantic one\nWARN: syntax two\nHINT: a suggestion\n");
        expect(r?.files[0]?.items.map((i) => [i.line, i.col, i.severity, i.message, i.source, i.code])).toEqual([
            [2, 3, "error", "semantic one", "typescript", "2322"],
            [3, 1, "warning", "syntax two", "typescript", "2322"],
        ]);
    });

    test("a server that refuses the requests is waited on for pushes instead", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_PULL: "fail" }) });
        const file = join(root, "a.ts");
        expect((await m.afterEdit(file, "ERROR: pushed"))?.files[0]?.items[0]?.message).toBe("pushed");
        expect((await m.afterEdit(file, "ERROR: pushed again"))?.files[0]?.items[0]?.message).toBe("pushed again");
    });

    test("an answer that comes after the edit stopped waiting is reported later", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_PULL: "1", FAKE_LSP_DELAY: "800" }) }, { timing: { coldTimeoutMs: 300 } });
        expect(await m.afterEdit(join(root, "a.ts"), "ERROR: slow pull")).toBeUndefined();
        await Bun.sleep(1200);
        expect(m.takeLate()?.files[0]?.items[0]?.message).toBe("slow pull");
    });

    test("files edited earlier are asked about again, so an edit that breaks one says so at once", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_PULL: "1", FAKE_LSP_CROSS: "1" }) });
        await m.afterEdit(join(root, "a.ts"), "export const a = 1;\n");
        const r = await m.afterEdit(join(root, "b.ts"), "BREAKS: a.ts\n");
        expect(r?.files.map((f) => [f.path, f.items[0]?.message])).toEqual([["a.ts", "broken by b.ts"]]);
    });
});

describe("review fixes", () => {
    test("a file changed outside the edit tools is sent again before the next check; a deleted one is closed", async () => {
        const root = project();
        const log = join(root, "log.jsonl");
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_LOG: log }) });
        const a = join(root, "a.ts");
        writeFileSync(a, "ERROR: one\n");
        await m.afterEdit(a, "ERROR: one\n");
        await Bun.sleep(20);
        // A shell command (or the user's editor) changes it.
        writeFileSync(a, "ERROR: one\nERROR: two\n");
        const r = await m.afterEdit(join(root, "b.ts"), "fine\n");
        expect(r?.files.map((f) => [f.path, f.items.map((i) => i.message)])).toEqual([["a.ts", ["two"]]]);
        rmSync(a);
        await m.afterEdit(join(root, "b.ts"), "fine again\n");
        const methods = readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l).method);
        expect(methods).toContain("textDocument/didClose");
    });

    test("a cancelled request (a change overtook it) doesn't stop asking", async () => {
        const root = project();
        const m = manager(root, { fake: fakeServer({ FAKE_LSP_PULL: "cancel-first" }) });
        const file = join(root, "a.ts");
        expect(await m.afterEdit(file, "ERROR: first")).toBeUndefined();
        // Still asked (this server pushes nothing while it answers requests).
        expect((await m.afterEdit(file, "ERROR: second"))?.files[0]?.items.map((i) => i.message)).toEqual(["second"]);
    });

    test("a sub-agent's view: its own edits and reports, the same server", async () => {
        const root = project();
        const parent = manager(root, { fake: fakeServer({ FAKE_LSP_DELAY: "600" }) }, { timing: { coldTimeoutMs: 200, warmTimeoutMs: 200 } });
        const child = parent.fork();
        managers.push(child);
        expect(await parent.afterEdit(join(root, "a.ts"), "ERROR: parent's")).toBeUndefined();
        expect(await child.afterEdit(join(root, "b.ts"), "ERROR: child's")).toBeUndefined();
        await Bun.sleep(1000);
        // Each hears only about its own file, late.
        expect(child.takeLate()?.files.map((f) => f.path)).toEqual(["b.ts"]);
        expect(parent.takeLate()?.files.map((f) => f.path)).toEqual(["a.ts"]);
        expect(child.status()[0]?.pid).toBe(parent.status()[0]?.pid!);
        // The child letting go leaves the server running.
        await child.dispose();
        expect(parent.status()).toHaveLength(1);
    });

    test("not trusted by the user: no server runs, and it says so once", async () => {
        const root = project();
        const notices: string[] = [];
        const settings = { lsp: { servers: { ...NO_BUILTINS, fake: fakeServer() } } } as any;
        const m = new LspManager({ root, settings: () => settings, trusted: () => false, notice: (_l, msg) => notices.push(msg) });
        managers.push(m);
        expect(await m.afterEdit(join(root, "a.ts"), "ERROR: x")).toBeUndefined();
        expect(await m.afterEdit(join(root, "b.ts"), "ERROR: x")).toBeUndefined();
        expect(m.status()).toEqual([]);
        expect(notices).toEqual(["Diagnostics after edits are off in this folder until you trust it (/trust): language servers run the project's own code."]);
    });

    test("each session sharing a pool is told about a missing server", async () => {
        const root = project();
        const missing = { mine: { command: "definitely-not-installed-lsp-xyz", extensionToLanguage: { ".ts": "typescript" } } };
        const a: string[] = [];
        const b: string[] = [];
        await manager(root, missing, { notices: a }).afterEdit(join(root, "a.ts"), "x");
        await manager(root, missing, { notices: b }).afterEdit(join(root, "a.ts"), "x");
        expect([a.length, b.length]).toEqual([1, 1]);
    });

    test("escape sequences and carriage returns in a message don't reach the terminal", () => {
        const r = compare("a.ts", undefined, [diag(0, "bad \x1b[2J\x1b]0;title\x07thing\r\nnext")]);
        expect(r.items[0]!.message).toBe("bad thing next");
    });

    test("how many more: counted once", () => {
        const many = (p: string) => compare(p, undefined, Array.from({ length: 30 }, (_, i) => diag(i, `${p} ${i}`)));
        const r = buildReport([many("a.ts"), many("b.ts")])!;
        expect(r.omitted).toBe(60 - MAX_PER_REPORT);
        const last = stripAnsi(renderDiagnostics(r, 100, 3).at(-1)!);
        expect(last).toBe(`       … +${60 - 3} more (ctrl+o to expand)`);
    });
});

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

describe("in the terminal", () => {
    test("a headline, then a few problems, and how many more", () => {
        const r = buildReport([compare("src/a.ts", undefined, Array.from({ length: 6 }, (_, i) => diag(i, `problem ${i}`)))])!;
        const lines = renderDiagnostics(r, 80, 3).map(stripAnsi);
        expect(lines[0]).toBe("     ✗ 6 errors in src/a.ts");
        expect(lines[1]).toBe("       1:3 problem 0");
        expect(lines).toHaveLength(5);
        expect(lines[4]).toBe("       … +3 more (ctrl+o to expand)");
    });

    test("fits a narrow window", () => {
        const r = buildReport([compare("src/a.ts", undefined, [diag(0, "x".repeat(200), 1, "2322")])])!;
        for (const l of renderDiagnostics(r, 40, 3)) expect(stripAnsi(l).length).toBeLessThanOrEqual(40);
    });

    test("only fixes: a check mark", () => {
        const r = buildReport([compare("a.ts", [diag(0, "x")], [])])!;
        expect(renderDiagnostics(r, 80, 3).map(stripAnsi)).toEqual(["     ✓ 1 fixed in a.ts"]);
    });
});
