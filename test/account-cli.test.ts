// Fake CLIs only: account selection must never become the environment of tools or hooks.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir, FAKE } from "./helpers/isolate";

const { home, cleanup } = isolate();
const { saveAgentConfig, BUILTIN_PROVIDERS } = await import("../src/providers/registry");
const { checkAgentCli, createBackend } = await import("../src/backends/index");
const { claudePermissions } = await import("../src/backends/claude-code");
const { childEnv } = await import("../src/util/env");
const { runShell } = await import("../src/tools/bash");
const { runHooks } = await import("../src/agent/hooks");
const root = realpathSync(tempDir("account-cli-"));
const log = join(root, "starts.jsonl");
const originalClaude = process.env.CLAUDE_CONFIG_DIR;
const originalCodex = process.env.CODEX_HOME;
const touched = ["FAKE_LOG", "FAKE_EMAIL", "FAKE_PLAN", "FAKE_ACCOUNT", "FAKE_LOGGED_IN", "FAKE_SCENARIO", "FAKE_REJECT_CONFIG", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_ACCESS_TOKEN", "ANTHROPIC_API_KEY"];
const old = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
const folder = join(root, "personal");
for (const [provider, fixture] of [["claude-code", "fake-claude.ts"], ["codex", "fake-codex.ts"]]) {
    const bin = join(root, provider!);
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${join(import.meta.dir, "fixtures", fixture!)}" "$@"\n`);
    chmodSync(bin, 0o700);
    saveAgentConfig(provider!, { path: bin, accounts: [{ id: "personal", name: "Personal", folder, managed: false }] });
}
const starts = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((line) => line.argv);
beforeEach(() => {
    process.env.HARNESS_HOME = home;
    process.env.CLAUDE_CONFIG_DIR = originalClaude;
    process.env.CODEX_HOME = originalCodex;
    for (const key of touched) delete process.env[key];
    process.env.FAKE_LOG = log;
    rmSync(log, { force: true });
    for (const provider of ["claude-code", "codex"]) saveAgentConfig(provider, { defaultAccount: "default" });
});
afterAll(() => {
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    process.env.CLAUDE_CONFIG_DIR = originalClaude;
    process.env.CODEX_HOME = originalCodex;
    cleanup();
    rmSync(root, { recursive: true, force: true });
});

test("each status child receives only its chosen CLI selector and no overriding token", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-private-oauth-token";
    process.env.CODEX_ACCESS_TOKEN = "fake-private-codex-token";
    process.env.ANTHROPIC_API_KEY = FAKE.anthropic;
    await checkAgentCli("claude-code", undefined, "personal");
    await checkAgentCli("codex", undefined, "personal");
    expect(starts()).toEqual([
        expect.objectContaining({ claudeConfigDir: folder, sawApiKey: false, sawOauthToken: false }),
        expect.objectContaining({ codexHome: folder, sawApiKey: false, sawOauthToken: false }),
    ]);
    expect(starts()[0].codexHome).toBeUndefined();
    expect(starts()[1].claudeConfigDir).toBeUndefined();
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(originalClaude);
    expect(process.env.CODEX_HOME).toBe(originalCodex);
});

test("Default preserves the user's inherited selectors", async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    await checkAgentCli("claude-code");
    await checkAgentCli("codex");
    expect(starts().every((s) => s.claudeConfigDir === undefined && s.codexHome === undefined)).toBe(true);
    process.env.CLAUDE_CONFIG_DIR = originalClaude;
    process.env.CODEX_HOME = originalCodex;
    await checkAgentCli("claude-code");
    await checkAgentCli("codex");
    expect(starts()[2]).toMatchObject({ claudeConfigDir: originalClaude });
    expect(starts()[2].codexHome).toBe(originalCodex);
    expect(starts()[3]).toMatchObject({ codexHome: originalCodex });
    expect(starts()[3].claudeConfigDir).toBe(originalClaude);
});

test("legacy accounts and changed default selectors cannot launch into Default's identity", async () => {
    const { accountEnv } = await import("../src/providers/accounts");
    const { loginCommand } = await import("../src/backends/account-login");
    // These accounts were seeded directly in providers.json above, as if an older
    // version had accepted them. A later environment change must fail closed too.
    for (const [provider, key] of [["claude-code", "CLAUDE_CONFIG_DIR"], ["claude-code", "CLAUDE_SECURESTORAGE_CONFIG_DIR"], ["codex", "CODEX_HOME"]]) {
        const previous = process.env[key!];
        process.env[key!] = folder;
        try {
            expect(() => accountEnv(provider!, "personal")).toThrow(/default CLI folder/);
            expect(() => loginCommand(provider!, "personal")).toThrow(/default CLI folder/);
            await expect(checkAgentCli(provider!, undefined, "personal")).rejects.toThrow(/default CLI folder/);
            saveAgentConfig(provider!, { defaultAccount: "personal" });
            await expect(createBackend(BUILTIN_PROVIDERS.find((p) => p.id === provider)!).listModels()).rejects.toThrow(/default CLI folder/);
            expect(existsSync(log)).toBe(false);
            // Default still gets the user's exact selectors, even when they overlap.
            const expected = Object.fromEntries(["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CODEX_HOME"].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
            expect(accountEnv(provider!)).toEqual(expected);
            await checkAgentCli(provider!, undefined, "default");
            expect(starts()).toHaveLength(1);
            rmSync(log);
        } finally {
            if (previous === undefined) delete process.env[key!]; else process.env[key!] = previous;
            saveAgentConfig(provider!, { defaultAccount: "default" });
        }
    }
});

test("agent shell and hook environments cannot inherit or reintroduce account selectors", async () => {
    const env = childEnv({ CLAUDE_CONFIG_DIR: folder, CLAUDE_SECURESTORAGE_CONFIG_DIR: folder, CODEX_HOME: folder, CLAUDE_CODE_OAUTH_TOKEN: "fake-override" });
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const command = 'test -z "$CLAUDE_CONFIG_DIR" && test -z "$CODEX_HOME" && printf clean';
    const shell = await runShell({ command, cwd: root, env, timeoutMs: 3000, signal: new AbortController().signal });
    expect(shell.exitCode).toBe(0);
    expect(shell.output).toBe("clean");
    const hooks = await runHooks({ hooks: { UserPromptSubmit: [{ command }] } }, "UserPromptSubmit", {}, root);
    expect(hooks).toEqual({ errors: [], additionalContext: "clean" });
});

test("model catalogs use the configured default account, including first use", async () => {
    for (const provider of ["claude-code", "codex"]) {
        saveAgentConfig(provider, { defaultAccount: "personal" });
        const backend = createBackend(BUILTIN_PROVIDERS.find((p) => p.id === provider)!);
        expect((await backend.listModels()).length).toBeGreaterThan(0);
    }
    expect(starts()[0]).toMatchObject({ claudeConfigDir: folder });
    expect(starts()[1]).toMatchObject({ codexHome: folder });
});

test("unsigned accounts stay unsigned, while optional identity fields are bounded and redacted", async () => {
    process.env.FAKE_LOGGED_IN = "0";
    process.env.FAKE_ACCOUNT = "none";
    for (const provider of ["claude-code", "codex"]) expect(await checkAgentCli(provider, undefined, "personal")).toMatchObject({ signedIn: false, description: "not signed in" });
    delete process.env.FAKE_LOGGED_IN;
    delete process.env.FAKE_ACCOUNT;
    process.env.FAKE_EMAIL = `me@example.com ${FAKE.openai}`;
    process.env.FAKE_PLAN = "x".repeat(1000);
    for (const provider of ["claude-code", "codex"]) {
        const status = await checkAgentCli(provider, undefined, "personal");
        expect(status.signedIn).toBe(true);
        expect(status.email).toBe("me@example.com [REDACTED openai-key]");
        expect(status.plan?.length).toBe(200);
    }
});

function fakeTurn(provider: string): import("../src/backends/types").BackendTurn {
    return {
        prompt: "hello", images: [], cwd: root, model: { provider, id: "default" }, mode: "auto", accountId: "personal",
        additionalDirectories: [], trusted: true, rules: { deny: [], ask: [], root }, signal: new AbortController().signal,
        host: {
            emit: () => {}, mode: () => "auto", permission: async () => ({ allow: true }), askQuestions: async () => undefined,
            approvePlan: async () => ({ approved: false }), setMode: () => {}, usage: () => {}, sessionId: () => {}, drainQueued: () => [],
        },
    };
}

test("native CLI turns select their account and deny account folders in their own tool rules", async () => {
    process.env.FAKE_SCENARIO = "silent";
    for (const provider of ["claude-code", "codex"]) {
        const backend = createBackend(BUILTIN_PROVIDERS.find((p) => p.id === provider)!);
        expect((await backend.runTurn(fakeTurn(provider))).reason).toBe("done");
    }
    expect(starts()[0]).toMatchObject({ claudeConfigDir: folder });
    expect(starts()[1]).toMatchObject({ codexHome: folder });
    expect(claudePermissions({ deny: [], ask: [], root }).deny).toContain(`Read(/${folder}/**)`);
    const claudeArgs = starts()[0].argv;
    const settings = JSON.parse(claudeArgs[claudeArgs.indexOf("--settings") + 1]);
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, filesystem: { disabled: false } });
    expect(settings.sandbox.filesystem.denyRead).toContain(folder);
    expect(settings.sandbox.filesystem.denyWrite).toContain(folder);
    expect(settings.sandbox.filesystem.denyRead).toContain(join(realpathSync(root), "personal"));
    expect(settings.permissions.ask).toContain("Bash");
    const received = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).received).filter(Boolean);
    const thread = received.find((message) => message.method === "thread/start").params;
    const turn = received.find((message) => message.method === "turn/start").params;
    expect(received.find((message) => message.method === "initialize").params.capabilities).toEqual({ experimentalApi: true });
    expect(thread.sandbox).toBeUndefined();
    expect(thread.permissions).toBe("harness_accounts_write");
    expect(thread.config["permissions.harness_accounts_write"].filesystem[folder]).toBe("deny");
    expect(thread.config["permissions.harness_accounts_write"].extends).toBe(":workspace");
    expect(turn.sandboxPolicy).toBeUndefined();
    expect(turn.permissions).toBe("harness_accounts_write");
});

test("Claude account sandbox stays on for read-only delegates and Bypass", async () => {
    process.env.FAKE_SCENARIO = "silent";
    const backend = createBackend(BUILTIN_PROVIDERS.find((p) => p.id === "claude-code")!);
    for (const readOnly of [false, true]) {
        const turn = fakeTurn("claude-code");
        turn.mode = "bypassPermissions";
        turn.host.mode = () => "bypassPermissions";
        turn.readOnly = readOnly;
        expect((await backend.runTurn(turn)).reason).toBe("done");
    }
    for (const start of starts()) {
        const settings = JSON.parse(start.argv[start.argv.indexOf("--settings") + 1]);
        expect(settings.sandbox.enabled).toBe(true);
        expect(settings.sandbox.filesystem.denyRead).toContain(folder);
        expect(settings.sandbox.filesystem.denyWrite).toContain(folder);
        expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
        expect(settings.permissions.ask).toContain("Bash");
    }
});

test("Codex fails closed if it cannot apply account protections, even with delegation enabled", async () => {
    process.env.FAKE_REJECT_CONFIG = "1";
    const backend = createBackend(BUILTIN_PROVIDERS.find((p) => p.id === "codex")!);
    const turn = fakeTurn("codex");
    turn.orchestrator = { name: "harness", url: "http://127.0.0.1:1", authorization: "fake", tools: [], instructions: "fake", toolTimeoutSec: 1 };
    expect((await backend.runTurn(turn)).reason).toBe("error");
    const received = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).received).filter(Boolean);
    expect(received.filter((message) => message.method === "thread/start")).toHaveLength(1);
    expect(received.some((message) => message.method === "turn/start")).toBe(false);
});


test("invalid persisted named folders fail before login, status or model spawns", async () => {
    const { accountEnv } = await import("../src/providers/accounts");
    const { readAgentConfig } = await import("../src/providers/registry");
    const { loginCommand } = await import("../src/backends/account-login");
    for (const provider of ["claude-code", "codex"]) {
        for (const invalid of ["", "relative", "..", `${root}/../escape`]) {
            saveAgentConfig(provider, { accounts: [{ id: "personal", name: "Personal", folder: invalid, managed: false }], defaultAccount: "personal" });
            try {
                expect(() => readAgentConfig(provider)).toThrow(/Invalid account folder.*absolute/);
                expect(() => accountEnv(provider, "personal")).toThrow(/Invalid account folder/);
                expect(() => loginCommand(provider, "personal")).toThrow(/Invalid account folder/);
                await expect(checkAgentCli(provider, undefined, "personal")).rejects.toThrow(/Invalid account folder/);
                await expect(createBackend(BUILTIN_PROVIDERS.find((p) => p.id === provider)!).listModels()).rejects.toThrow(/Invalid account folder/);
                expect(existsSync(log)).toBe(false);
            } finally { saveAgentConfig(provider, { accounts: [{ id: "personal", name: "Personal", folder, managed: false }], defaultAccount: "default" }); }
        }
    }
});

test("persisted aliases are checked against Default and launch with the canonical validated path", async () => {
    const { accountEnv } = await import("../src/providers/accounts");
    const alias = join(root, "alias");
    mkdirSync(folder, { recursive: true });
    for (const provider of ["claude-code", "codex"]) {
        const defaultFolder = provider === "codex" ? originalCodex! : originalClaude!;
        for (const target of [defaultFolder, folder]) {
            symlinkSync(target, alias);
            saveAgentConfig(provider, { accounts: [{ id: "personal", name: "Personal", folder: alias, managed: false }] });
            try {
                if (target === defaultFolder) {
                    expect(() => accountEnv(provider, "personal")).toThrow(/default CLI folder/);
                    await expect(checkAgentCli(provider, undefined, "personal")).rejects.toThrow(/default CLI folder/);
                    expect(existsSync(log)).toBe(false);
                } else {
                    const env = accountEnv(provider, "personal");
                    expect(Object.values(env).every((v) => v === realpathSync(folder))).toBe(true);
                }
            } finally { rmSync(alias); saveAgentConfig(provider, { accounts: [{ id: "personal", name: "Personal", folder, managed: false }] }); }
        }
    }
});
