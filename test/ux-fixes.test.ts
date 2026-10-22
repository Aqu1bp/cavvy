// Regression tests for the correctness and usability review: edits saved
// while an approval prompt is open, config files with JSON errors, -p with
// an open stdin, silent retries, sessions that couldn't be listed, shells
// that ignore SIGTERM, compaction of an oversized history, and the TUI's
// input handling (queued messages, ! commands, paste, key changes).

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "fs/promises";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { isolate, tempDir, FAKE } from "./helpers/isolate";
import { secretsSnapshot } from "./helpers/secrets";

const { home: HARNESS_HOME, cleanup } = isolate();
const restoreSecrets = await secretsSnapshot();
const settingsMod = await import("../src/config/settings");
const { paths, projectStateDir } = await import("../src/config/paths");
const { trustFolder, isTrusted } = await import("../src/config/trust");
const { setKey } = await import("../src/auth/credentials");
const { inline } = await import("../src/ui/markdown");
const { ReadTool, WriteTool } = await import("../src/tools/file-tools");
const { Session, listSessions, findSession } = await import("../src/agent/session");
const { stopGroup, KillShellTool } = await import("../src/tools/bash");
const { compactTranscriptText } = await import("../src/agent/compact");
const { Agent } = await import("../src/agent/agent");
const { PermissionChecker } = await import("../src/permissions/checker");
const { AutoClassifier } = await import("../src/permissions/classifier");
const { ProviderError } = await import("../src/providers/types");
const { SelectDialog } = await import("../src/ui/dialogs");
const { Editor } = await import("../src/ui/editor");
const { plainErrorText } = await import("../src/util/html");
const { httpError } = await import("../src/providers/openai-compat");
const { GrepTool } = await import("../src/tools/search-tools");
const { App, splitActionsNote } = await import("../src/ui/app");
const { BULLET } = await import("../src/ui/components");
const { stripAnsi } = await import("../src/ui/ansi");
import type { Message } from "../src/providers/types";
import type { AgentEvent } from "../src/agent/agent";

afterAll(() => {
    restoreSecrets();
    cleanup();
});

const ROOT = resolve(import.meta.dir, "..");
const toolState = (cwd: string) => ({ cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() }) as any;
const toolCtx = (cwd: string) => ({ state: toolState(cwd), settings: {}, signal: new AbortController().signal }) as any;

describe("Read of a text file over 10 MiB", () => {
    // Spying on readFile shows the file is never loaded whole (#261): ranges are streamed.
    async function withoutReadFile<T>(fn: () => Promise<T>): Promise<T> {
        const read = spyOn(fsPromises, "readFile");
        try {
            const result = await fn();
            expect(read).not.toHaveBeenCalled();
            return result;
        } finally {
            read.mockRestore();
        }
    }
    const big = (name: string, body: string | Buffer) => {
        const file_path = join(tempDir(), name);
        writeFileSync(file_path, body);
        return file_path;
    };

    test("whole-file reads and notebooks are refused, pointing at offset/limit", async () => {
        const log = big("large.log", "x\n".repeat(5 * 1024 * 1024 + 1));
        const ctx = toolCtx(dirname(log));
        await withoutReadFile(async () => {
            const result = await ReadTool.run({ file_path: log }, ctx);
            expect(result.isError).toBe(true);
            expect(result.content).toContain("too large to read whole");
            expect(result.content).toContain("max 10485760 bytes");
            expect(result.content).toContain("offset and limit");
            expect(ctx.state.fileState.has(log)).toBe(false);
        });
        const nb = big("large.ipynb", "x\n".repeat(5 * 1024 * 1024 + 1));
        await withoutReadFile(async () => {
            for (const range of [{}, { offset: 1, limit: 1 }]) {
                const result = await ReadTool.run({ file_path: nb, ...range }, ctx);
                expect(result.isError).toBe(true);
                expect(result.content).toContain("Notebook is too large");
            }
        });
    });

    test("an offset/limit read streams the requested lines, however deep", async () => {
        const secret = "sk-ant-api03-" + "Q".repeat(40);
        const file_path = big("big.log", "first\n" + "y\n".repeat(5_300_000) + `token ${secret}\nlast`);
        const ctx = toolCtx(dirname(file_path));
        await withoutReadFile(async () => {
            for (const range of [{ offset: 1, limit: 1 }, { limit: 1 }]) {
                const head = await ReadTool.run({ file_path, ...range }, ctx);
                expect(head.isError).toBeFalsy();
                expect(head.content).toStartWith("     1\tfirst\n\n(Showing lines 1-1. Use offset/limit to read more.)");
                expect(ctx.state.fileState.get(file_path).partial).toBe(true);
            }
            const tail = await ReadTool.run({ file_path, offset: 5_300_001, limit: 10 }, ctx);
            expect(tail.isError).toBeFalsy();
            expect(tail.content).toContain("5300001\ty\n5300002\ttoken [REDACTED");
            expect(tail.content).toContain("5300003\tlast");
            expect(tail.content).not.toContain(secret);
            expect(tail.content).toContain("Some secrets in this file were redacted");
            expect(tail.content).not.toContain("Showing lines");
            const past = await ReadTool.run({ file_path, offset: 5_300_004 }, ctx);
            expect(past.isError).toBe(true);
            expect(past.content).toBe("offset 5300004 is past the end of the file (5300003 lines).");
        });
    }, 30_000);

    test("long lines and the output are capped", async () => {
        const oneLine = big("one-line.json", "z".repeat(11 * 1024 * 1024));
        const ctx = toolCtx(dirname(oneLine));
        await withoutReadFile(async () => {
            const result = await ReadTool.run({ file_path: oneLine, offset: 1, limit: 1 }, ctx);
            expect(result.isError).toBeFalsy();
            expect(result.content).toBe(`     1\t${"z".repeat(2000)}… [line truncated]`);
            expect(ctx.state.fileState.get(oneLine).partial).toBe(false);
        });
        const wide = big("wide.log", ("w".repeat(999) + "\n").repeat(11 * 1024));
        await withoutReadFile(async () => {
            const result = await ReadTool.run({ file_path: wide, offset: 1, limit: 100_000 }, ctx);
            expect(result.isError).toBeFalsy();
            expect(result.content.length).toBeLessThan(300 * 1024);
            expect(result.content).toMatch(/\(Output capped at 256 KB: showing lines 1-\d+\. Use offset \d+ to read on\.\)$/);
        });
    });

    test("binary and non-UTF-8 files are handled as for small ones", async () => {
        const bin = big("big.bin", Buffer.alloc(11 * 1024 * 1024));
        const ctx = toolCtx(dirname(bin));
        await withoutReadFile(async () => {
            const result = await ReadTool.run({ file_path: bin, offset: 1, limit: 1 }, ctx);
            expect(result.isError).toBe(true);
            expect(result.content).toContain("appears to be a binary file");
        });
        const latin1 = big("latin1.log", Buffer.concat([Buffer.from("caf\xe9\n", "latin1"), Buffer.from("x\n".repeat(5 * 1024 * 1024 + 1))]));
        await withoutReadFile(async () => {
            const result = await ReadTool.run({ file_path: latin1, offset: 1, limit: 1 }, ctx);
            expect(result.isError).toBeFalsy();
            expect(result.content).toContain("caf\uFFFD");
            expect(result.content).toContain("is not valid UTF-8");
        });
    });

    // A first line, read from a file over 10 MiB and as a small file shows it.
    async function firstLine(first: string, name: string) {
        const ctx = toolCtx(tempDir());
        const small = join(ctx.state.cwd, `small-${name}`);
        writeFileSync(small, first + "\nx\n");
        const expected = await ReadTool.run({ file_path: small, offset: 1, limit: 1 }, ctx);
        const file_path = big(name, first + "\n" + "x\n".repeat(5 * 1024 * 1024 + 1));
        const result = await withoutReadFile(() => ReadTool.run({ file_path, offset: 1, limit: 1 }, toolCtx(dirname(file_path))));
        return { result, expected };
    }
    const lineOne = (content: string) => content.split("\n")[0]!;

    test("a secret across the 8 KiB line cut is redacted whole, as in a small file", async () => {
        // The Google-format key starts at byte 8154: cut at 8192, it loses its last character and no pattern matches it.
        const key = "AIza" + "Z".repeat(35);
        const first = ("sk-ant-api03-" + "Q".repeat(249) + " ").repeat(31) + " " + key;
        expect(Buffer.byteLength(first.slice(0, first.indexOf(key)))).toBe(8154);
        const { result, expected } = await firstLine(first, "secret-at-cut.log");
        expect(result.isError).toBeFalsy();
        expect(result.content).not.toContain("AIzaZ");
        expect(result.content).toContain("[REDACTED google-key]");
        expect(result.content).toContain("Some secrets in this file were redacted");
        expect(lineOne(result.content)).toBe(lineOne(expected.content));
    });

    test("a pattern secret that runs past what's kept of the line is redacted, as in a small file", async () => {
        // The Slack and Tavily patterns end at a word boundary, which a kept part ending in hyphens doesn't have.
        for (const [first, label] of [
            ["xoxb-" + "-".repeat(20_000) + "Q", "slack-token"],
            ["tvly-" + "-".repeat(20_000) + "Q", "tavily-key"],
            ["xoxb-QQQQQQQQQ" + "-".repeat(20_000) + "Q", "slack-token"],
        ] as const) {
            const { result, expected } = await firstLine(first, `${label}.log`);
            expect(result.isError).toBeFalsy();
            expect(lineOne(result.content)).toBe(`     1\t[REDACTED ${label}]`);
            expect(lineOne(result.content)).toBe(lineOne(expected.content));
            expect(result.content).toContain("Some secrets in this file were redacted");
        }
        // Read ends a line it cut with "A", as every pattern's run of key characters takes it.
        const { SECRET_PATTERNS } = await import("../src/util/secret-patterns");
        for (const [pattern] of SECRET_PATTERNS) {
            const run = pattern.source.match(/\[[^\]]+\](?=\{\d+,?\d*\}[^[]*$)/)?.[0];
            expect(run && new RegExp(run).test("A"), pattern.source).toBe(true);
        }
        // A long line that isn't a secret still shows.
        const { result } = await firstLine("-".repeat(20_000) + "Q", "ruler.log");
        expect(lineOne(result.content)).toBe(`     1\t${"-".repeat(2000)}… [line truncated]`);
        expect(result.content).not.toContain("REDACTED");
    });

    test("a registered secret longer than the cut's lookahead is still redacted whole", async () => {
        const { registerSecret } = await import("../src/util/redact");
        const secret = "s3cr3t-" + "k".repeat(20_000);
        registerSecret(secret, "long-token");
        // Starts at byte 7890, before the cut, and runs past 16 KiB; the redacted keys before it leave it in the 2000 characters shown.
        const { result } = await firstLine(("sk-ant-api03-" + "Q".repeat(249) + " ").repeat(30) + secret, "long-secret.log");
        expect(result.isError).toBeFalsy();
        expect(result.content).not.toContain("s3cr3t");
        expect(result.content).not.toContain("kkkk");
        expect(result.content).toContain("[REDACTED long-token]");
    });

    test("a long line of valid UTF-8 cut mid-character isn't called non-UTF-8", async () => {
        for (const n of [3000, 30_000]) {
            // 8192 isn't a multiple of 3: the cut splits a "€".
            const { result } = await firstLine("€".repeat(n), `euro-${n}.log`);
            expect(result.isError).toBeFalsy();
            expect(result.content).not.toContain("UTF-8");
            expect(result.content).not.toContain("�");
            expect(result.content).toBe(`     1\t${"€".repeat(2000)}… [line truncated]\n\n(Showing lines 1-1. Use offset/limit to read more.)`);
        }
        // Invalid bytes before the cut are still reported.
        const bad = Buffer.concat([Buffer.from("€".repeat(100)), Buffer.from([0xff]), Buffer.from("€".repeat(3000) + "\n"), Buffer.from("x\n".repeat(5 * 1024 * 1024 + 1))]);
        const file_path = big("euro-bad.log", bad);
        const result = await withoutReadFile(() => ReadTool.run({ file_path, offset: 1, limit: 1 }, toolCtx(dirname(file_path))));
        expect(result.content).toContain("is not valid UTF-8");
    });

    test("small files still read ranges in memory", async () => {
        const file_path = big("small.log", "first\nsecond\nthird\n");
        const ctx = toolCtx(dirname(file_path));
        const result = await ReadTool.run({ file_path, offset: 2, limit: 1 }, ctx);
        expect(result.isError).toBeFalsy();
        expect(result.content).toContain("2\tsecond");
        expect(result.content).not.toContain("first");
        expect(ctx.state.fileState.get(file_path).partial).toBe(true);
    });
});

describe("Write re-checks the file after approval", () => {
    test("a change saved while the prompt was open isn't overwritten", async () => {
        const proj = tempDir();
        const file = join(proj, "notes.txt");
        writeFileSync(file, "original\n");
        const ctx = toolCtx(proj);
        await ReadTool.run({ file_path: file }, ctx);
        expect(await WriteTool.validate!({ file_path: file, content: "agent version\n" }, ctx)).toBeUndefined();
        // The user saves the file while the approval prompt is open.
        writeFileSync(file, "the user's edit, saved meanwhile\n");
        const r = await WriteTool.run({ file_path: file, content: "agent version\n" }, ctx);
        expect(r.isError).toBe(true);
        expect(r.content).toContain("modified since you last read it");
        expect(readFileSync(file, "utf-8")).toBe("the user's edit, saved meanwhile\n");
    });
    test("an unchanged file is still written", async () => {
        const proj = tempDir();
        const file = join(proj, "notes.txt");
        writeFileSync(file, "original\n");
        const ctx = toolCtx(proj);
        await ReadTool.run({ file_path: file }, ctx);
        const r = await WriteTool.run({ file_path: file, content: "agent version\n" }, ctx);
        expect(r.isError).toBeFalsy();
        expect(readFileSync(file, "utf-8")).toBe("agent version\n");
    });
});

describe("a config file with a JSON error is never overwritten", () => {
    test("updateSettings refuses and leaves the file as it was", () => {
        const proj = tempDir();
        const file = settingsMod.settingsPath("user", proj);
        mkdirSync(dirname(file), { recursive: true });
        const broken = '{ "model": "anthropic:x", "hooks": {} "permissions": { "allow": ["Bash(npm test)"] } }';
        writeFileSync(file, broken);
        expect(() => settingsMod.updateSettings("user", proj, (s) => (s.effort = "high"))).toThrow(settingsMod.JsonFileError);
        expect(readFileSync(file, "utf-8")).toBe(broken);
        rmSync(file);
    });
    test("trailing commas and comments are fine", () => {
        const proj = tempDir();
        const file = join(proj, "s.json");
        writeFileSync(file, '{\n  // the model\n  "model": "a:b",\n  "permissions": { "allow": ["x", "y",], },\n  "s": "a, }",\n}\n');
        expect(settingsMod.readJson(file)).toEqual({ model: "a:b", permissions: { allow: ["x", "y"] }, s: "a, }" });
    });
    test("a parse warning goes to the handler, once", () => {
        const proj = tempDir();
        const file = join(proj, "bad.json");
        writeFileSync(file, "{ nope");
        const seen: string[] = [];
        settingsMod.onConfigWarning((m) => seen.push(m));
        try {
            expect(settingsMod.readJson(file)).toBeUndefined();
            expect(settingsMod.readJson(file)).toBeUndefined();
        } finally {
            settingsMod.onConfigWarning((m) => process.stderr.write(`warning: ${m}\n`));
        }
        expect(seen.length).toBe(1);
        expect(seen[0]).toContain(file);
    });
    test("trusting a folder with a broken trusted.json keeps the file and trusts for this session", () => {
        const file = join(HARNESS_HOME, "trusted.json");
        writeFileSync(file, '{ "dirs": ["/a", "/b"] ');
        const dir = tempDir();
        try {
            expect(() => trustFolder(dir)).toThrow(settingsMod.JsonFileError);
            expect(isTrusted(dir)).toBe(true);
            expect(readFileSync(file, "utf-8")).toBe('{ "dirs": ["/a", "/b"] ');
        } finally {
            rmSync(file, { force: true });
        }
    });
    test("a broken credentials file isn't replaced by a new key", async () => {
        const file = paths.credentialsFile();
        mkdirSync(dirname(file), { recursive: true });
        const broken = `{ "openai": "${FAKE.openai}", `;
        writeFileSync(file, broken);
        chmodSync(file, 0o600);
        try {
            await expect(setKey("anthropic", FAKE.anthropic)).rejects.toThrow(settingsMod.JsonFileError);
            expect(readFileSync(file, "utf-8")).toBe(broken);
        } finally {
            rmSync(file, { force: true });
        }
    });
    test("a failed key update leaves the key in use masked", async () => {
        const { getKey, removeKey } = await import("../src/auth/credentials");
        const { redact } = await import("../src/util/redact");
        // No known key format, so only the registered value can mask it.
        const oldKey = "mistral-old-" + "q".repeat(24);
        await setKey("mistral", oldKey);
        expect((await getKey("mistral"))?.value).toBe(oldKey);
        const file = paths.credentialsFile();
        writeFileSync(file, readFileSync(file, "utf-8").replace(/}\s*$/, ","));
        try {
            await expect(setKey("mistral", "mistral-new-" + "r".repeat(24))).rejects.toThrow(settingsMod.JsonFileError);
            expect((await getKey("mistral"))?.value).toBe(oldKey);
            expect(redact(`key=${oldKey}`)).not.toContain(oldKey);
        } finally {
            rmSync(file, { force: true });
        }
        await removeKey("mistral");
        expect(redact(oldKey)).not.toContain(oldKey);
    });
    test("with a keychain, a broken providers.json fails the update before the keychain changes", async () => {
        const home = tempDir();
        const providers = '{ "keychain": ["openai"], ';
        writeFileSync(join(home, "providers.json"), providers);
        // A child process with an in-memory Bun.secrets: the real keychain is never touched.
        const script = join(tempDir(), "keychain-probe.ts");
        writeFileSync(
            script,
            `const store = new Map([["openai", "old-key-value-123456"]]);
const fake = { get: async ({ name }) => store.get(name) ?? null, set: async ({ name, value }) => void store.set(name, value), delete: async ({ name }) => store.delete(name) };
Bun.secrets = fake;
if (Bun.secrets !== fake) process.exit(3);
const { setKey } = await import(${JSON.stringify(join(ROOT, "src/auth/credentials.ts"))});
let error = "";
try { await setKey("openai", "new-key-value-654321"); } catch (e) { error = e.message; }
console.log(JSON.stringify({ error, stored: store.get("openai") }));
`,
        );
        const env: Record<string, string | undefined> = { ...process.env, HARNESS_HOME: home };
        delete env.HARNESS_NO_KEYCHAIN;
        const p = Bun.spawnSync([process.execPath, "--no-env-file", script], { env, cwd: home });
        expect(p.exitCode).toBe(0);
        const out = JSON.parse(p.stdout.toString().trim().split("\n").pop()!);
        expect(out.error).toContain("isn't valid JSON");
        expect(out.stored).toBe("old-key-value-123456");
        expect(readFileSync(join(home, "providers.json"), "utf-8")).toBe(providers);
    });
});

// ---------------------------------------------------------------------------
// Headless: an open stdin and retries

function mockProvider(handler: (n: number) => Response) {
    let n = 0;
    const server = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname.endsWith("/models") ? Response.json({ data: [{ id: "m1" }] }) : handler(++n)) });
    writeFileSync(join(HARNESS_HOME, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: `http://127.0.0.1:${server.port}/v1`, kind: "openai", requiresKey: false, models: ["m1"] }] }));
    return server;
}

const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });

/** Runs `harness -p` with stdin left open (never written or closed). */
async function headless(args: string[], proj: string): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
    const started = Date.now();
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: HARNESS_HOME, HARNESS_HOME, HARNESS_NO_KEYCHAIN: "1", HARNESS_STDIN_WAIT_MS: "300" };
    const child = spawn(process.execPath, ["--no-env-file", `--config=${join(ROOT, "bunfig.toml")}`, join(ROOT, "src/index.ts"), "-p", ...args], { cwd: proj, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));
    clearTimeout(killer);
    return { code, stdout, stderr, ms: Date.now() - started };
}

describe("headless runs", () => {
    test("an open, silent stdin doesn't hang -p, and retries are shown", async () => {
        const server = mockProvider((n) =>
            n === 1
                ? new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), { status: 429, headers: { "content-type": "application/json" } })
                : sse([{ choices: [{ index: 0, delta: { role: "assistant", content: "hello from mock" } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]),
        );
        try {
            const r = await headless(["say hi", "--model", "mock:m1"], tempDir());
            expect(r.stderr).toContain("no input on stdin after 0.3s");
            expect(r.stderr).toMatch(/retrying in \d+s \(attempt 1\): .*Rate limit reached/);
            expect(r.stdout).toContain("hello from mock");
            expect(r.code).toBe(0);
            expect(r.ms).toBeLessThan(15_000);
        } finally {
            server.stop(true);
        }
    }, 30_000);
    test("-c resumes with the session's own model, not the default", async () => {
        const server = mockProvider(() => sse([{ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]));
        // The child's cwd is the real path (/var is a symlink on macOS).
        const proj = realpathSync(tempDir());
        try {
            const s = Session.create(proj);
            s.setModel("mock:m1");
            s.push({ role: "user", content: [{ type: "text", text: "earlier" }], meta: { kind: "prompt" } } as any);
            // From an earlier run: this process is done with it, as that one would be.
            s.release();
            // The default names a provider with no key, so only the session's model can work.
            writeFileSync(join(HARNESS_HOME, "settings.json"), JSON.stringify({ model: "anthropic:claude-opus-5-5" }));
            const r = await headless(["again", "-c", "--output-format", "json"], proj);
            expect(r.stderr).not.toContain("No API key");
            expect(JSON.parse(r.stdout.trim().split("\n").pop()!).result).toBe("ok");
        } finally {
            server.stop(true);
            rmSync(join(HARNESS_HOME, "settings.json"), { force: true });
        }
    }, 30_000);
});

// ---------------------------------------------------------------------------

describe("session listing", () => {
    test("a session whose first message is bigger than the head is still listed and found", () => {
        const proj = tempDir();
        const s = Session.create(proj);
        s.push({ role: "user", content: [{ type: "text", text: "what is in this screenshot?" }, { type: "image", mediaType: "image/png", data: "A".repeat(400_000) }], meta: { kind: "prompt", display: "what is in this screenshot?" } } as any);
        const listed = listSessions(proj);
        expect(listed.map((x) => x.id)).toContain(s.meta.id);
        expect(listed.find((x) => x.id === s.meta.id)!.title).toBe("what is in this screenshot?");
        expect(findSession(proj, s.meta.id)).toBe(s.path);
    });
    test("a different path that maps to the same folder doesn't see the session", () => {
        const base = tempDir();
        const a = join(base, "foo-bar");
        const b = join(base, "foo.bar");
        mkdirSync(a);
        mkdirSync(b);
        expect(projectStateDir(a)).toBe(projectStateDir(b));
        const s = Session.create(a);
        s.push({ role: "user", content: [{ type: "text", text: "from foo-bar" }], meta: { kind: "prompt" } } as any);
        expect(listSessions(a).map((x) => x.id)).toContain(s.meta.id);
        expect(listSessions(b).map((x) => x.id)).not.toContain(s.meta.id);
        expect(findSession(b, s.meta.id)).toBeUndefined();
    });
});

describe("stopping background shells", () => {
    const start = (script: string) => spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
    const alive = (pid: number) => {
        try {
            process.kill(-pid, 0);
            return true;
        } catch {
            return false;
        }
    };
    /** Killed children of the shell go to init, and the group counts as alive until init reaps them; some inits take a while. */
    const reaped = async (pid: number, ms = 5000) => {
        for (const end = Date.now() + ms; alive(pid) && Date.now() < end; ) await Bun.sleep(50);
        return !alive(pid);
    };
    test("a process that ignores SIGTERM is force-killed", async () => {
        const child = start("trap '' TERM; while :; do sleep 0.1; done");
        await Bun.sleep(200);
        expect(await stopGroup(child.pid, 300)).toBe("killed");
        expect(await reaped(child.pid!)).toBe(true);
    });
    test("one that exits on SIGTERM is just stopped", async () => {
        const child = start("sleep 30");
        await Bun.sleep(100);
        expect(await stopGroup(child.pid, 2000)).toBe("stopped");
        expect(alive(child.pid!)).toBe(false);
    });
    test("KillShell says when it had to force it, and stops tracking it", async () => {
        const ctx = toolCtx(tempDir());
        ctx.state.shells.set("bash_9", { id: "bash_9", command: "server", startedAt: Date.now(), output: "", readOffset: 0, exitCode: null, kill: async () => "killed" });
        const r = await KillShellTool.run({ shell_id: "bash_9" }, ctx);
        expect(r.content).toContain("SIGKILL");
        expect(ctx.state.shells.size).toBe(0);
    });
});

describe("compacting a history too long to summarize", () => {
    test("a one-request history is summarized from a transcript that keeps the request", async () => {
        const proj = tempDir();
        const session = Session.create(proj, { persist: false });
        session.push({ role: "user", content: [{ type: "text", text: "fix the login redirect bug" }], meta: { kind: "prompt" } } as any);
        session.push({ role: "assistant", provider: "test", model: "test", stopReason: "tool_use", content: [{ type: "tool_call", id: "c1", name: "Read", input: { file_path: "huge.log" } }] } as any);
        session.push({ role: "user", content: [{ type: "tool_result", toolCallId: "c1", toolName: "Read", content: "x".repeat(50_000) }], meta: { kind: "tool_results" } } as any);
        const requests: any[] = [];
        const client = {
            stream: async (req: any) => {
                requests.push(req);
                if (requests.length === 1) throw new ProviderError("prompt is too long: 250000 tokens > 200000 maximum", 400);
                return { role: "assistant", provider: "test", model: "test", stopReason: "end_turn", content: [{ type: "text", text: "1. Primary request: fix the login redirect bug" }] };
            },
        };
        const settings = { autoCompact: false };
        const agent = new Agent({
            session,
            model: { provider: "test", id: "test", contextWindow: 32_000 } as any,
            client: client as any,
            settings: () => settings as any,
            checker: new PermissionChecker(() => settings as any, proj),
            classifier: new AutoClassifier(undefined),
            tools: [],
            mode: { get: () => "default", set() {} },
            toolState: toolState(proj),
            host: { emit() {}, ui: {} } as any,
        });
        expect(await agent.compact({ auto: true, signal: new AbortController().signal })).toBe(true);
        const fallback = requests[1];
        expect(fallback.tools).toEqual([]);
        expect(fallback.system).toContain("summarize");
        expect(fallback.messages.length).toBe(1);
        const sent = JSON.stringify(fallback.messages[0]);
        expect(sent).toContain("fix the login redirect bug");
        expect(sent).toContain("Your task is to write a detailed summary");
        expect(sent.length).toBeLessThan(32_000 * 3);
        expect(JSON.stringify(session.messages)).toContain("Primary request: fix the login redirect bug");
    });
    test("compactTranscriptText keeps the first message and the most recent ones", () => {
        const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "FIRST REQUEST" }] } as any];
        for (let i = 0; i < 50; i++) msgs.push({ role: "assistant", content: [{ type: "text", text: `step ${i} ` + "y".repeat(200) }] } as any);
        const t = compactTranscriptText(msgs, 3000);
        expect(t.startsWith("User: FIRST REQUEST")).toBe(true);
        expect(t).toContain("step 49");
        expect(t).not.toContain("step 0 ");
        expect(t).toContain("earlier messages omitted");
        expect(t.length).toBeLessThanOrEqual(3000 + 100);
    });
    test("one huge batch of tool results doesn't push out the messages around it", () => {
        const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "FIRST REQUEST" }] } as any];
        msgs.push({ role: "user", content: [{ type: "text", text: "LATER REQUIREMENT: keep the API stable" }] } as any);
        msgs.push({ role: "assistant", content: [{ type: "text", text: "Reading the files now." }] } as any);
        msgs.push({ role: "user", content: Array.from({ length: 40 }, (_, i) => ({ type: "tool_result", toolCallId: `c${i}`, toolName: "Read", content: `result ${i} ` + "z".repeat(3000) })) } as any);
        const t = compactTranscriptText(msgs, 20_000);
        expect(t).toContain("FIRST REQUEST");
        expect(t).toContain("LATER REQUIREMENT");
        expect(t).toContain("result 39");
        expect(t).not.toContain("earlier messages omitted");
        expect(t.length).toBeLessThanOrEqual(20_000);
    });
});

describe("pickers and the editor", () => {
    test("pasting into a searchable picker searches for it", () => {
        const d = new SelectDialog<string>({ title: "Model", items: [{ label: "gpt-5.5", value: "openai:gpt-5.5" }, { label: "claude-opus-5-5", value: "anthropic:claude-opus-5-5" }], searchable: true });
        d.onKey({ name: "paste", paste: "claude-opus\n" } as any);
        expect(d.list.query).toBe("claude-opus");
        expect(d.list.filtered().map((f) => f.item.value)).toEqual(["anthropic:claude-opus-5-5"]);
    });
    test("undo after clearing a large paste brings its content back", () => {
        const e = new Editor();
        const big = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
        e.paste(big);
        expect(e.text).toMatch(/^\[Pasted text #1 \+40 lines\]$/);
        e.clear();
        e.undo();
        expect(e.value()).toBe(big);
    });
    test("pasted text nothing refers to any more is dropped", () => {
        const e = new Editor();
        e.paste("a\n".repeat(20));
        e.clear();
        // The undo stack still refers to it; once that's gone, so is the paste.
        (e as any).undoStack = [];
        e.clear();
        expect((e as any).pastes.size).toBe(0);
    });
});

describe("HTML error pages", () => {
    test("only the title is kept", () => {
        expect(plainErrorText("<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><hr>nginx</body></html>")).toBe("502 Bad Gateway (HTML error page)");
        expect(plainErrorText("502 <!DOCTYPE html><html><body><h1>Upstream &amp; down</h1></body></html>")).toBe("502 Upstream & down (HTML error page)");
        expect(plainErrorText('{"error":"x"}')).toBe('{"error":"x"}');
    });
    test("in provider errors", () => {
        const e = httpError(502, "Bad Gateway", "<html><body><h1>502 Bad Gateway</h1></body></html>", null, "Mock");
        expect(e.message).toBe("Mock API error 502 Bad Gateway: 502 Bad Gateway (HTML error page)");
        expect(e.retryable).toBe(true);
    });
    test("an out-of-range entity is left as written, and the error stays retryable", () => {
        const e = httpError(502, "Bad Gateway", "<html><title>Gateway &#99999999; &#x110000; &amp;</title></html>", null, "Mock");
        expect(e.message).toContain("Gateway &#99999999; &#x110000; & (HTML error page)");
        expect(e.retryable).toBe(true);
    });
});

describe("Grep without ripgrep", () => {
    test("multiline patterns, context lines, types and .gitignore", async () => {
        const proj = tempDir();
        writeFileSync(join(proj, "a.ts"), "function one() {\n  return 1;\n}\nconst x = 2;\n");
        writeFileSync(join(proj, "b.py"), "def one():\n    return 1\n");
        mkdirSync(join(proj, "gen"));
        writeFileSync(join(proj, "gen/out.ts"), "function one() {\n  return 1;\n}\n");
        writeFileSync(join(proj, ".gitignore"), "gen/\n");
        Bun.spawnSync(["git", "init", "-q"], { cwd: proj });
        // A PATH with git but no rg.
        const bin = tempDir();
        symlinkSync(Bun.which("git")!, join(bin, "git"));
        const prev = process.env.PATH;
        process.env.PATH = bin;
        try {
            const ctx = toolCtx(proj);
            const multi = await GrepTool.run({ pattern: "one\\(\\) \\{\\n\\s+return", multiline: true, output_mode: "content" } as any, ctx);
            expect(multi.content).toContain("a.ts:1:function one() {");
            expect(multi.content).toContain("a.ts:2:  return 1;");
            expect(multi.content).not.toContain("gen/out.ts");
            const count = await GrepTool.run({ pattern: "return", output_mode: "count", type: "py" } as any, ctx);
            expect(count.content).toBe("b.py:1");
            const ctxLines = await GrepTool.run({ pattern: "const x", output_mode: "content", before: 1, glob: "*.ts" } as any, ctx);
            expect(ctxLines.content).toBe("a.ts-3-}\na.ts:4:const x = 2;");
        } finally {
            process.env.PATH = prev;
        }
    });

    /** Runs Grep with a PATH that has git but no rg. */
    async function grepWithoutRg(input: object, proj: string) {
        const bin = tempDir();
        symlinkSync(Bun.which("git")!, join(bin, "git"));
        const prev = process.env.PATH;
        process.env.PATH = bin;
        try {
            return (await GrepTool.run(input as any, toolCtx(proj))).content;
        } finally {
            process.env.PATH = prev;
        }
    }

    test("a glob still finds a file listed after the first 20,000", async () => {
        const proj = tempDir();
        mkdirSync(join(proj, "a"));
        for (let i = 0; i < 20_010; i++) writeFileSync(join(proj, "a", `f${i}.js`), "");
        mkdirSync(join(proj, "z"));
        writeFileSync(join(proj, "z/late.ts"), "needle\n");
        Bun.spawnSync(["git", "init", "-q"], { cwd: proj }); // git lists paths sorted, so z/ comes last
        expect(await grepWithoutRg({ pattern: "needle", glob: "*.ts", output_mode: "count" }, proj)).toBe("z/late.ts:1");
        const broad = await grepWithoutRg({ pattern: "needle" }, proj);
        expect(broad).toContain("Search incomplete");
        expect(broad).toContain("20,000");
        expect(broad).toContain("Narrow");
        expect(broad).not.toContain("No matches found");
        writeFileSync(join(proj, "a/f0.js"), "needle\n");
        for (const output_mode of ["files_with_matches", "count", "content"]) {
            const result = await grepWithoutRg({ pattern: "needle", output_mode, head_limit: 1 }, proj);
            expect(result).toContain("a/f0.js");
            expect(result).toContain("Search incomplete");
        }
        // Without git, enumeration must also disclose the cap.
        const prev = process.env.PATH;
        process.env.PATH = "";
        try {
            const result = await GrepTool.run({ pattern: "absent" }, toolCtx(proj));
            expect(result.content).toContain("Search incomplete");
            expect(result.content).not.toContain("No matches found");
            expect(result.display?.summary).toContain("incomplete");
        } finally {
            process.env.PATH = prev;
        }
    }, 30_000);
    test("files over 5 MB are reported as skipped, not as a miss", async () => {
        const proj = tempDir();
        writeFileSync(join(proj, "big.log"), "x".repeat(5_000_001) + "\nneedle\n");
        writeFileSync(join(proj, "small.txt"), "hay\n");
        const read = spyOn(fsPromises, "readFile");
        try {
            const miss = await grepWithoutRg({ pattern: "needle" }, proj);
            expect(miss).not.toBe("No matches found");
            expect(miss).toContain("No matches in the scanned files.");
            expect(miss).toContain("skipped 1 file over 5 MB");
            expect(miss).toContain("(big.log)");
            expect(read.mock.calls.map((c) => String(c[0]))).not.toContain(join(proj, "big.log"));
        } finally {
            read.mockRestore();
        }
        writeFileSync(join(proj, "small.txt"), "needle\n");
        const hit = await grepWithoutRg({ pattern: "needle" }, proj);
        expect(hit).toContain("small.txt");
        expect(hit).toContain("(Search incomplete: skipped 1 file over 5 MB");
        const file = await grepWithoutRg({ pattern: "needle", path: join(proj, "big.log") }, proj);
        expect(file).toContain("skipped 1 file over 5 MB");
    });

    test("multiline counts are matches, as with ripgrep, when a match crosses lines", async () => {
        const proj = tempDir();
        writeFileSync(join(proj, "imports.ts"), "import a\nimport b\nimport c\nimport d\nx\nimport e\nimport f\n");
        Bun.spawnSync(["git", "init", "-q"], { cwd: proj });
        const cases: [string, string][] = [
            ["import [a-z]\\nimport", "imports.ts:3"],
            ["import", "imports.ts:6"],
            ["^import.*\\nimport", "imports.ts:1"],
        ];
        for (const [pattern, want] of cases) {
            const input = { pattern, multiline: true, output_mode: "count" };
            expect(await grepWithoutRg(input, proj)).toBe(want);
            // The same answers ripgrep gives, where it's installed.
            if (Bun.which("rg")) expect((await GrepTool.run(input as any, toolCtx(proj))).content).toBe(want);
        }
    });
});

// ---------------------------------------------------------------------------
// The TUI's input handling, driven through App with the screen stubbed out.

function testApp(cwd = tempDir()) {
    const app = new App({ cwd, trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
    const printed: string[] = [];
    const print = (l: string | string[] | ((cols: number) => string[])) => (printed.push(...(typeof l === "function" ? l(100) : Array.isArray(l) ? l : [l])), {});
    (app as any).screen = { print, replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop() {}, clearScreen() {} };
    (app as any).renderLive = () => {};
    app.session = Session.create(cwd, { persist: false });
    app.session.setSystem("test system prompt");
    return { app, printed };
}

function gate() {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
}

describe("TUI input handling", () => {
    test("a prompt sent while MCP servers are still connecting is queued, not lost", async () => {
        const { app } = testApp();
        app.session = Session.create(app.cwd, { persist: false }); // no frozen system prompt yet
        app.model = { provider: "test", id: "test" } as any;
        const server = { name: "slow", status: "connecting" };
        (app.mcp as any).servers = new Map([["slow", server]]);
        const runs: string[] = [];
        const g = gate();
        app.agent = { run: async (parts: any[]) => (runs.push(parts[0].text), runs.length === 1 ? g.p : undefined) } as any;
        const first = app.submitText("first");
        await Bun.sleep(150);
        expect(app.busy).toBe(true);
        await app.submitText("second");
        server.status = "connected";
        await Bun.sleep(200);
        expect(runs).toEqual(["first"]);
        expect((app as any).abort).toBeDefined(); // esc can still interrupt the first
        g.open();
        await first;
        expect(runs).toEqual(["first", "second"]);
    });
    test("a message typed during /compact is sent when it finishes", async () => {
        const { app } = testApp();
        const runs: string[] = [];
        app.agent = { run: async (parts: any[]) => void runs.push(parts[0].text) } as any;
        const g = gate();
        const task = app.runTask("Compacting conversation", () => g.p);
        await app.submitText("follow-up");
        expect(runs).toEqual([]);
        g.open();
        await task;
        await Bun.sleep(50);
        expect(runs).toEqual(["follow-up"]);
    });
    test("after a cancelled task, queued messages go back to the prompt", async () => {
        const { app } = testApp();
        const runs: string[] = [];
        app.agent = { run: async (parts: any[]) => void runs.push(parts[0].text) } as any;
        const task = app.runTask("Compacting conversation", (signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))));
        await app.submitText("follow-up");
        (app as any).interrupt();
        await task;
        await Bun.sleep(50);
        expect(runs).toEqual([]);
        expect(app.editor.text).toBe("follow-up");
    });
    test("with a draft in the prompt, a cancel still doesn't send the queued message", async () => {
        const { app } = testApp();
        const runs: string[] = [];
        app.agent = { run: async (parts: any[]) => void runs.push(parts[0].text) } as any;
        const task = app.runTask("Compacting conversation", (signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))));
        await app.submitText("follow-up");
        app.editor.set("half-typed");
        (app as any).interrupt();
        await task;
        await Bun.sleep(50);
        expect(runs).toEqual([]);
        expect(app.editor.text).toBe("follow-up\nhalf-typed");
    });
    test("esc while MCP servers connect gives the prompt back even with a draft", async () => {
        const { app } = testApp();
        app.session = Session.create(app.cwd, { persist: false });
        app.model = { provider: "test", id: "test" } as any;
        (app.mcp as any).servers = new Map([["slow", { name: "slow", status: "connecting" }]]);
        const runs: string[] = [];
        app.agent = { run: async (parts: any[]) => void runs.push(parts[0].text) } as any;
        const first = app.submitText("first");
        await Bun.sleep(150);
        await app.submitText("second");
        app.editor.set("draft");
        (app as any).interrupt();
        await first;
        await Bun.sleep(50);
        expect(runs).toEqual([]);
        expect(app.editor.text).toBe("first\nsecond\ndraft");
    });
    test("an interrupted turn doesn't start the next queued message", async () => {
        const { app } = testApp();
        const runs: string[] = [];
        app.agent = { run: async (parts: any[], o: any) => (runs.push(parts[0].text), new Promise<void>((r) => o.signal.addEventListener("abort", () => r()))) } as any;
        const first = app.submitText("first");
        await Bun.sleep(20);
        await app.submitText("second");
        app.editor.set("draft");
        (app as any).interrupt();
        await first;
        await Bun.sleep(50);
        expect(runs).toEqual(["first"]);
        expect(app.editor.text).toBe("second\ndraft");
    });
    test("a prompt sent right after /resume waits for the session's model", async () => {
        const { app } = testApp();
        (app as any).modelReady = true;
        const ran: string[] = [];
        app.agent = { run: async () => void ran.push("old"), setModel() {} } as any;
        const g = gate();
        (app as any).setModel = async () => {
            await g.p;
            app.agent = { run: async () => void ran.push("new") } as any;
            return true;
        };
        app.session.model = "test:resumed";
        (app as any).replayTranscript();
        const sent = app.submitText("hello");
        await Bun.sleep(50);
        expect(ran).toEqual([]);
        g.open();
        await sent;
        expect(ran).toEqual(["new"]);
    });
    test("a resumed Codex turn shows its actions one a line, not the note the model reads, between clear markers", () => {
        const { app, printed } = testApp();
        const note = "[Codex used: Bash(gh issue create --title \"a, b\" --body-file /tmp/x.md), Edit(src/a.ts), Bash(python3 - <<'PY' …)]";
        app.session.push({ role: "user", content: [{ type: "text", text: "open the issue" }], meta: { kind: "prompt" } });
        app.session.push({ role: "assistant", content: [{ type: "text", text: `Opened issue #159.\n\n${note}` }] });
        (app as any).replayTranscript();
        const out = printed.map(stripAnsi);
        expect(out.join("\n")).not.toContain("Codex used");
        expect(out).toContain(`${BULLET} Opened issue #159.`);
        expect(out).toContain(`  ${BULLET} Bash(gh issue create --title "a, b" --body-file /tmp/x.md)`);
        expect(out).toContain(`  ${BULLET} Edit(src/a.ts)`);
        expect(out.some((l) => /^── Resumed session .* · 2 messages ─+$/.test(l))).toBe(true);
        expect(out.slice(-3)).toEqual(["", expect.stringMatching(/^── end of resumed history ─+$/), ""]);
        const reply = (...texts: string[]) => ({ role: "assistant" as const, content: texts.map((text) => ({ type: "text" as const, text })) });
        expect(splitActionsNote(reply("plain reply"))).toEqual({ text: "plain reply", actions: [] });
        expect(splitActionsNote(reply("done", "[Claude Code used: Read(a), Bash(ls), and 3 more]"))).toEqual({ text: "done", actions: ["Read(a)", "Bash(ls)", "and 3 more"] });
        expect(splitActionsNote(reply("[Codex used: Bash(ls)]"))).toEqual({ text: "", actions: ["Bash(ls)"] });
    });
    test("a reply that mentions a [Codex used: …] note isn't cut there: only the note closing the turn is taken out", () => {
        const { app, printed } = testApp();
        const prose = "To see the changes:\n- **Resumed history:** actions one per line, with no `[Codex used: …]` blob. Full-width rules mark it.\n- **End of a turn:** no blank rows under the footer.";
        app.session.push({ role: "user", content: [{ type: "text", text: "go" }], meta: { kind: "prompt" } });
        app.session.push({ role: "assistant", content: [{ type: "text", text: prose }, { type: "text", text: "[Claude Code used: Bash(gh pr merge 162), Bash(harness --version)]" }] });
        (app as any).replayTranscript();
        const out = printed.map(stripAnsi).join("\n");
        expect(out).toContain("with no [Codex used: …] blob. Full-width rules mark it.");
        expect(out).toContain("End of a turn: no blank rows under the footer.");
        expect(out).not.toContain("**");
        expect(out).toContain(`  ${BULLET} Bash(gh pr merge 162)\n  ${BULLET} Bash(harness --version)`);
        expect(splitActionsNote(app.session.messages.at(-1)!).text).toBe(prose);
    });
    test("a ! command can be interrupted", async () => {
        const { app, printed } = testApp();
        const run = (app as any).runBashMode("sleep 30");
        await Bun.sleep(200);
        expect(app.busy).toBe(true);
        const t = Date.now();
        (app as any).interrupt();
        await run;
        expect(Date.now() - t).toBeLessThan(5000);
        expect(app.busy).toBe(false);
        expect(printed.join("\n")).toContain("(interrupted)");
    });
    test("after /login the current model uses the new key", async () => {
        const { app } = testApp();
        const { forgetClient, clientFor } = await import("../src/providers/models");
        await setKey("openai", FAKE.openai);
        app.model = { provider: "openai", id: "gpt-5.5" } as any;
        const old = { stream: async () => ({}) };
        app.client = old as any;
        let given: unknown;
        app.agent = { setModel: (_m: unknown, c: unknown) => (given = c) } as any;
        await setKey("openai", FAKE.openai.replace("x", "y"));
        forgetClient("openai");
        await app.keyChanged("openai");
        expect(app.client).not.toBe(old);
        expect(given).toBe(app.client);
        expect(app.client).toBe(await clientFor("openai")); // built from the key just saved
    });
    test("after /logout with no key left, the model is deselected", async () => {
        const { app } = testApp();
        const { removeKey } = await import("../src/auth/credentials");
        const { forgetClient } = await import("../src/providers/models");
        app.model = { provider: "openai", id: "gpt-5.5" } as any;
        let disposed = false;
        app.agent = { setModel() {}, dispose: async () => void (disposed = true) } as any;
        await removeKey("openai");
        forgetClient("openai");
        await app.keyChanged("openai");
        expect(app.model).toBeUndefined();
        expect(app.agent).toBeUndefined();
        // The agent it drops stops what it delegated.
        expect(disposed).toBe(true);
    });
});

describe("live region layout", () => {
    function liveOf(app: InstanceType<typeof App>) {
        let got = { lines: [] as string[] };
        (app as any).screen.setLive = (lines: string[]) => (got = { lines: lines.map(stripAnsi) });
        App.prototype.renderLive.call(app);
        return got;
    }
    function busyApp() {
        const { app } = testApp();
        app.busy = true;
        (app as any).turnStart = Date.now();
        return app as any;
    }
    const tool = (title: string, progress = "") => ({ call: { id: title, name: "Bash", input: {} }, title, startedAt: Date.now(), progress });

    test("the reply, each running tool and the spinner are separate blocks", () => {
        const app = busyApp();
        app.md = { pending: () => ["Let me look."] };
        app.active.set("a", tool("ls -la", "file1\nfile2"));
        app.active.set("b", tool("git status"));
        const { lines } = liveOf(app);
        const at = (s: string) => lines.findIndex((l) => l.includes(s));
        expect(lines[0]).toBe("");
        expect(lines[1]).toContain("Let me look.");
        expect(lines[at("ls -la") - 1]).toBe("");
        expect(lines[at("file1") - 1]).toContain("ls -la");
        expect(lines[at("git status") - 1]).toBe("");
        expect(lines[at("esc to interrupt") - 1]).toBe("");
    });

    test("a sub-agent still working after the call that started it returned (Codex's spawn) shows until its turn ends", () => {
        const { app: a, printed } = testApp();
        const app = a as any;
        app.busy = true;
        app.turnStart = Date.now();
        const call = { type: "tool_call", id: "spawn-1", name: "Task", input: { description: "Count the files" } };
        app.onAgentEvent({ type: "tool_start", call, title: "Task(Count the files)" });
        app.onAgentEvent({ type: "tool_end", call, result: { content: "The sub-agent started; what it does shows under it.", isError: false }, durationMs: 5 });
        const sub = (event: AgentEvent) => app.onAgentEvent({ type: "subagent", parentId: "spawn-1", label: "Count the files", event });
        sub({ type: "request_start" });
        sub({ type: "tool_start", call: { type: "tool_call", id: "c1", name: "Bash", input: { command: "touch y" } }, title: "touch y" });
        sub({ type: "usage", usage: { inputTokens: 1000, outputTokens: 200 } });
        const live = () => liveOf(app).lines.join("\n");
        expect(live()).toContain("Task(Count the files)");
        expect(live()).toContain("⎿  touch y");
        printed.length = 0;
        sub({ type: "tool_end", call: { type: "tool_call", id: "c1", name: "Bash", input: { command: "touch y" } }, result: { content: "ok", isError: false }, durationMs: 5 });
        sub({ type: "text", text: "CHILD_REPORT: 2 files." });
        sub({ type: "turn_end", reason: "done" });
        expect(live()).not.toContain("Count the files");
        expect(printed.map(stripAnsi).join("\n")).toMatch(/Task\(Count the files\)\n\s+⎿  Done \(1 tool use · 1\.2k tokens · /);
        // A late word from one that's over (Claude Code saying again it ended) shows nothing more.
        printed.length = 0;
        sub({ type: "usage", usage: { inputTokens: 1, outputTokens: 1 } });
        sub({ type: "turn_end", reason: "done" });
        expect(printed).toEqual([]);
        expect(live()).not.toContain("Count the files");
    });

    test("a reply that's partly printed already continues it without a blank line", () => {
        const app = busyApp();
        app.md = { pending: () => ["second half"] };
        app.mdLines = 3;
        const { lines } = liveOf(app);
        expect(lines[0]).toBe("  second half");
    });

    test("the spinner says the model is thinking until its reply starts", () => {
        const app = busyApp();
        const spinner = () => liveOf(app).lines.find((l) => l.includes("esc to interrupt"))!;
        expect(spinner()).not.toContain("thinking");
        // Thinking that isn't streamed arrives as one empty event, then nothing until the reply.
        app.onAgentEvent({ type: "thinking", text: "" });
        expect(spinner()).toContain(" · thinking · esc to interrupt");
        app.onAgentEvent({ type: "tool_call_start", id: "t1", name: "Write" });
        expect(spinner()).not.toContain("thinking");
        app.onAgentEvent({ type: "thinking", text: "" });
        app.onAgentEvent({ type: "usage", usage: { inputTokens: 1, outputTokens: 2 } });
        expect(spinner()).not.toContain("thinking");
        // A web search the server runs isn't thinking either.
        app.onAgentEvent({ type: "thinking", text: "" });
        app.onAgentEvent({ type: "server_tool", name: "web_search", detail: "" });
        expect(spinner()).not.toContain("thinking");
    });

    test("a model that has been silent a while is named as what's being waited on", () => {
        const app = busyApp();
        app.model = { provider: "vertex", id: "google/gemini-4-argon", name: "gemini-4-argon" };
        app.agentWork = true; // a chat turn
        const spinner = () => liveOf(app).lines.find((l) => l.includes("esc to interrupt"))!;
        app.lastEventAt = Date.now() - 5_000;
        expect(spinner()).not.toContain("waiting");
        app.lastEventAt = Date.now() - 75_000;
        expect(spinner()).toContain(" · waiting for gemini-4-argon 1m 15s · esc to interrupt");
        // Not while a tool runs, a call streams in, or something else is said (a retry).
        app.active.set("a", tool("npm test"));
        expect(spinner()).not.toContain("waiting");
        app.active.clear();
        app.receiving.set("t1", { name: "Write", chars: 0 });
        expect(spinner()).not.toContain("waiting");
        app.receiving.clear();
        app.status = "overloaded · retrying in 4s (attempt 1)";
        expect(spinner()).not.toContain("waiting");
        app.status = undefined;
        // Any event resets it; thinking says how long it has been thinking.
        app.onAgentEvent({ type: "thinking", text: "" });
        expect(spinner()).toContain(" · thinking · esc to interrupt");
        app.lastEventAt = Date.now() - 12_000;
        expect(spinner()).toContain(" · thinking 12s · esc to interrupt");
    });

    test("a slow `!` command isn't called waiting for the model; /compact is", async () => {
        const { app } = testApp();
        (app as any).model = { provider: "vertex", id: "google/gemini-4-argon", name: "gemini-4-argon" };
        const spinner = () => liveOf(app).lines.find((l) => l.includes("esc to interrupt"))!;
        let open!: () => void;
        const task = app.runTask("Running", () => new Promise<void>((r) => (open = r)));
        (app as any).lastEventAt = Date.now() - 30_000;
        expect(spinner()).not.toContain("waiting");
        open();
        await task;
        // /compact runs as a task too, but the agent reports it, and it does wait on the model.
        const compact = app.runTask("Compacting conversation", () => new Promise<void>((r) => (open = r)));
        (app as any).onAgentEvent({ type: "compact_start", auto: false });
        (app as any).lastEventAt = Date.now() - 30_000;
        expect(spinner()).toContain(" · waiting for gemini-4-argon 30s");
        open();
        await compact;
    });

    test("thinking's markdown is styled, not shown as asterisks (Codex's summaries open with a **bold** title)", () => {
        const { app, printed } = testApp();
        const a = app as any;
        a.settings = { ...a.settings, showThinking: true };
        a.busy = true;
        a.turnStart = Date.now();
        a.thinking = "**Checking independent sources**\n\nComparing `a.ts` with *b*.";
        const { lines } = liveOf(app);
        expect(lines.some((l) => l.includes("✻ Checking independent sources"))).toBe(true);
        expect(lines.join("\n")).not.toContain("**");
        expect(lines.join("\n")).toContain("Comparing a.ts with b.");
        a.flushThinking();
        const shown = printed.map(stripAnsi).join("\n");
        expect(shown).toContain("✻ Checking independent sources");
        expect(shown).not.toContain("**");
        // A link is its text and URL, never a terminal hyperlink that a cut-short block could leave open.
        printed.length = 0;
        a.thinking = `See [the docs ${"word ".repeat(200)}](https://example.com/docs).`;
        a.flushThinking();
        expect(printed.join("\n")).not.toContain("\x1b]8;");
        expect(printed.map(stripAnsi).join(" ")).toContain("(https://example.com/docs)");
        expect(inline("[docs](https://example.com/docs)", true)).toContain("\x1b]8;;https://example.com/docs");
        // Nor one the model's text holds itself.
        printed.length = 0;
        a.thinking = `\x1b]8;;https://example.com\x1b\\${"word ".repeat(2000)}\x1b]8;;\x1b\\ \x1b[31mred`;
        a.flushThinking();
        expect(printed.join("\n")).not.toContain("\x1b]8;");
        expect(printed.join("\n")).not.toContain("\x1b[31m");
    });

    test("back at the plain prompt (a turn ended, then a dialog closed), the screen is asked to bring the output back down, once each", () => {
        const { app } = testApp();
        const a = app as any;
        let settled = 0;
        a.screen.settle = () => settled++;
        a.busy = true;
        a.turnStart = Date.now();
        App.prototype.renderLive.call(app);
        App.prototype.renderLive.call(app);
        expect(settled).toBe(0);
        // The turn ends with a dialog still open: not yet.
        a.dialogs.push({ render: () => ["dialog", "", "", ""] });
        a.busy = false;
        App.prototype.renderLive.call(app);
        expect(settled).toBe(0);
        a.dialogs.pop();
        App.prototype.renderLive.call(app);
        App.prototype.renderLive.call(app);
        expect(settled).toBe(1);
    });

    test("when idle, only the prompt is shown", () => {
        const { app } = testApp();
        const { lines } = liveOf(app);
        expect(lines[0]).toBe("");
        expect(lines.some((l) => l.includes("esc to interrupt"))).toBe(false);
    });
});
