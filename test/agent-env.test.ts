import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";
const iso = isolate();
const { saveAgentConfig, readProvidersFile } = await import("../src/providers/registry");
const { agentEnv, agentEnvFingerprint, agentEnvInfo, cliEnv, envNameProblem, loadAgentSecrets, saveAgentEnv, secretEnvId, turnOffAgent } = await import("../src/providers/agent-env");
const { runCli } = await import("../src/backends/cli");
const { childEnv } = await import("../src/util/env");
const { redact } = await import("../src/util/redact");
const { getKey } = await import("../src/auth/credentials");
afterAll(() => iso.cleanup());

const TOKEN = "router-token-for-tests-0123456789";
const SHELL_KEY = "shell-key-for-tests-0123456789";

/** What a process started as Cavvy starts a CLI's gets: childEnv, then the CLI's own (runCli). */
async function seen(provider: string): Promise<Record<string, string>> {
    const r = await runCli("/usr/bin/env", [], { env: cliEnv(provider) });
    return Object.fromEntries(r.stdout.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

test("by default a CLI gets none of Cavvy's provider keys", async () => {
    process.env.ANTHROPIC_API_KEY = SHELL_KEY;
    process.env.ANTHROPIC_AUTH_TOKEN = "shell-token-value";
    try {
        saveAgentConfig("claude-code");
        const env = await seen("claude-code");
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(env.CAVVY).toBe("1");
    } finally {
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
});

test("variables set for a CLI win over the stripping, for that CLI only", async () => {
    process.env.ANTHROPIC_API_KEY = SHELL_KEY;
    try {
        saveAgentConfig("claude-code");
        saveAgentConfig("codex");
        await saveAgentEnv("claude-code", [
            { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.example/api" },
            { name: "ANTHROPIC_API_KEY", value: "" },
            { name: "ANTHROPIC_AUTH_TOKEN", value: TOKEN, secret: true },
        ]);
        const env = await seen("claude-code");
        expect(env.ANTHROPIC_BASE_URL).toBe("https://openrouter.example/api");
        // Set empty on purpose (a router's instructions): not the shell's key.
        expect(env.ANTHROPIC_API_KEY).toBe("");
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN);
        // Another CLI, and every other process Cavvy starts, get none of it.
        const codex = await seen("codex");
        expect(codex.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(codex.ANTHROPIC_BASE_URL).toBeUndefined();
        expect(codex.ANTHROPIC_API_KEY).toBeUndefined();
        expect(Object.values(childEnv({ LEAK: TOKEN }))).not.toContain(TOKEN);
    } finally {
        delete process.env.ANTHROPIC_API_KEY;
    }
});

test("a secret's value is stored like a key, never in providers.json, and is redacted", async () => {
    saveAgentConfig("claude-code");
    await saveAgentEnv("claude-code", [{ name: "ANTHROPIC_AUTH_TOKEN", value: TOKEN, secret: true }, { name: "PLAIN", value: "visible" }]);
    const file = readFileSync(join(iso.home, "providers.json"), "utf-8");
    expect(file).not.toContain(TOKEN);
    expect(readProvidersFile().agents?.["claude-code"]).toMatchObject({ env: { PLAIN: "visible" }, secretEnv: ["ANTHROPIC_AUTH_TOKEN"] });
    expect(readFileSync(join(iso.home, "credentials.json"), "utf-8")).toContain(TOKEN);
    expect((await getKey(secretEnvId("claude-code", "ANTHROPIC_AUTH_TOKEN")))?.value).toBe(TOKEN);
    // What Settings is sent: the name, never the value.
    expect(JSON.stringify(agentEnvInfo("claude-code"))).not.toContain(TOKEN);
    expect(agentEnvInfo("claude-code")).toEqual([{ name: "PLAIN", value: "visible" }, { name: "ANTHROPIC_AUTH_TOKEN", secret: true }]);
    expect(redact(`the CLI said ${TOKEN}`)).not.toContain(TOKEN);
    // The models cache keeps a fingerprint of them: no value in it.
    expect(agentEnvFingerprint("claude-code")).not.toContain(TOKEN);
    expect(agentEnvFingerprint("claude-code")).not.toContain("visible");
});

test("saved again without a secret's value keeps it; dropped, it's deleted", async () => {
    saveAgentConfig("claude-code");
    await saveAgentEnv("claude-code", [{ name: "ANTHROPIC_AUTH_TOKEN", value: TOKEN, secret: true }]);
    await saveAgentEnv("claude-code", [{ name: "ANTHROPIC_AUTH_TOKEN", secret: true }, { name: "X", value: "1" }]);
    expect(agentEnv("claude-code")).toEqual({ X: "1", ANTHROPIC_AUTH_TOKEN: TOKEN });
    await saveAgentEnv("claude-code", [{ name: "X", value: "1" }]);
    expect(agentEnv("claude-code")).toEqual({ X: "1" });
    expect(await getKey(secretEnvId("claude-code", "ANTHROPIC_AUTH_TOKEN"))).toBeUndefined();
    expect(readFileSync(join(iso.home, "credentials.json"), "utf-8")).not.toContain(TOKEN);
});

test("a new secret needs a value; names are checked; the account's selectors can't be set", async () => {
    saveAgentConfig("claude-code");
    await expect(saveAgentEnv("claude-code", [{ name: "NEW_SECRET", secret: true }])).rejects.toThrow(/Enter a value/);
    await expect(saveAgentEnv("claude-code", [{ name: "1BAD", value: "x" }])).rejects.toThrow(/isn't a variable name/);
    await expect(saveAgentEnv("claude-code", [{ name: "A", value: "x" }, { name: "A", value: "y" }])).rejects.toThrow(/twice/);
    expect(envNameProblem("CLAUDE_CONFIG_DIR")).toMatch(/account/);
    expect(envNameProblem("CODEX_HOME")).toMatch(/account/);
    expect(envNameProblem("CAVVY_SESSION")).toMatch(/Cavvy/);
    // Written into providers.json by hand, they're left out all the same.
    const pf = readProvidersFile();
    const { writeProvidersFile } = await import("../src/providers/registry");
    writeProvidersFile({ ...pf, agents: { ...pf.agents, "claude-code": { env: { CLAUDE_CONFIG_DIR: "/tmp/elsewhere", OK: "1" } } } });
    expect(agentEnv("claude-code")).toEqual({ OK: "1" });
    expect(cliEnv("claude-code").CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
});

test("a CLI that's off can't be given variables; turning one off deletes its secrets", async () => {
    await expect(saveAgentEnv("opencode", [{ name: "A", value: "x" }])).rejects.toThrow(/Turn on/);
    saveAgentConfig("opencode");
    await saveAgentEnv("opencode", [{ name: "OPENCODE_TOKEN", value: TOKEN, secret: true }]);
    expect(agentEnv("opencode").OPENCODE_TOKEN).toBe(TOKEN);
    expect(await turnOffAgent("opencode")).toBe(true);
    expect(await getKey(secretEnvId("opencode", "OPENCODE_TOKEN"))).toBeUndefined();
    expect(agentEnv("opencode")).toEqual({});
});

test("a secret that can't be read stops the launch, saying which", async () => {
    const { writeProvidersFile } = await import("../src/providers/registry");
    const pf = readProvidersFile();
    writeProvidersFile({ ...pf, agents: { ...pf.agents, codex: { secretEnv: ["MISSING_TOKEN"] } } });
    await loadAgentSecrets("codex");
    expect(() => cliEnv("codex")).toThrow(/MISSING_TOKEN couldn't be read/);
});

test("Claude Code's status check and model listing are started with them", async () => {
    const { chmodSync, writeFileSync, existsSync } = await import("fs");
    const { tempDir } = await import("./helpers/isolate");
    const dir = tempDir("agent-env-fake-");
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-claude.ts")}" "$@"\n`);
    chmodSync(bin, 0o755);
    const log = join(dir, "log.jsonl");
    process.env.FAKE_LOG = log;
    process.env.FAKE_LOG_ENV = "1";
    try {
        const { writeProvidersFile } = await import("../src/providers/registry");
        const pf = readProvidersFile();
        writeProvidersFile({ ...pf, agents: { ...pf.agents, "claude-code": { path: bin } } });
        await saveAgentEnv("claude-code", [{ name: "ANTHROPIC_BASE_URL", value: "https://router.example" }, { name: "ANTHROPIC_AUTH_TOKEN", value: TOKEN, secret: true }]);
        const { claudeStatus, ClaudeCodeBackend } = await import("../src/backends/claude-code");
        const { getProvider } = await import("../src/providers/registry");
        await claudeStatus("claude-code");
        await new ClaudeCodeBackend(getProvider("claude-code")!).listModels();
        expect(existsSync(log)).toBe(true);
        const envs = readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.env).map((o) => o.env);
        expect(envs.length).toBeGreaterThanOrEqual(2);
        for (const env of envs) {
            expect(env.ANTHROPIC_BASE_URL).toBe("https://router.example");
            expect(env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN);
        }
    } finally {
        delete process.env.FAKE_LOG;
        delete process.env.FAKE_LOG_ENV;
    }
});
