// Structured Mac -> server state sync (src/servers/sync-state.ts):
// settings key-level merge, strict ownership of portable rules, MCP/URL/provider validation, endpoint-bound
// opt-in Cavvy API keys, CLI topology + managed accounts (zero CLI credentials), marketplace conflict guards,
// unreadable-file safety, dynamic secret opt-out, digest short-circuit, and backward compatibility.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { setKey, getKey, removeKey, forgetCachedKeys } = await import("../src/auth/credentials");
const { readProvidersFile, readProvidersFileForUpdate, writeProvidersFile } = await import("../src/providers/registry");
const { addAccount, listAccounts, removeAccount, setDefaultAccount } = await import("../src/providers/accounts");
const { loadScope, writeJson } = await import("../src/config/settings");
const { paths } = await import("../src/config/paths");
const { pluginPaths, readInstalled, writeInstalled, writeKnownMarketplaces } = await import("../src/plugins/store");
const { portableMcpEntry } = await import("../src/servers/copy");
const { applyStateSync, isSafeRemoteUrl, localSyncState, readSyncedStateDigest, secretMcpEntry, syncAllTo, syncStateTo } = await import("../src/servers/sync-state");
const { draftServer, getServer, saveServer, setServerSync } = await import("../src/servers/store");
const { installState, installing } = await import("../src/servers/sync-install");
const { agentCli } = await import("../src/backends/defs");

afterAll(() => iso.cleanup());

/** Runs `fn` with CAVVY_HOME temporarily pointed to `home`, simulating a remote server's isolated home. */
async function inHome<T>(home: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = process.env.CAVVY_HOME;
    process.env.CAVVY_HOME = home;
    forgetCachedKeys();
    try {
        return await fn();
    } finally {
        process.env.CAVVY_HOME = prev;
        forgetCachedKeys();
    }
}

test("URL, MCP and marketplace validators reject credentials, query params, local/trailing-dot hosts and OAuth tokens", () => {
    expect(isSafeRemoteUrl("https://api.example.com/v1")).toBe(true);
    expect(isSafeRemoteUrl("https://user:pass@api.example.com/v1")).toBe(false);
    expect(isSafeRemoteUrl("https://api.example.com/v1?token=secret")).toBe(false);
    expect(isSafeRemoteUrl("http://127.0.0.1:8080/v1")).toBe(false);
    expect(isSafeRemoteUrl("http://localhost./v1")).toBe(false);
    expect(isSafeRemoteUrl("https://box.local./v1")).toBe(false);
    expect(isSafeRemoteUrl("file:///tmp/repo.git")).toBe(false);
    expect(isSafeRemoteUrl("https://mcp.example.com/ya29.a0AfB_byC1234567890abcdef")).toBe(false);

    // Local binary command refused even with includeSecrets.
    expect(secretMcpEntry({ command: "node", args: ["/Users/me/server.js"] })).toBeUndefined();
    // Package runner with third-party env allowed; CLI OAuth env and tokens blocked across headers/oauth.
    expect(secretMcpEntry({ command: "npx", args: ["-y", "@scope/mcp"], env: { GITHUB_TOKEN: "ghp_12345" } })).toBeDefined();
    expect(secretMcpEntry({ command: "npx", args: ["-y", "@scope/mcp"], env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } })).toBeUndefined();
    expect(secretMcpEntry({ url: "https://mcp.example.com/v1", headers: { Authorization: "Bearer sk-ant-oat01-secret123456" } })).toBeUndefined();
    expect(secretMcpEntry({ url: "https://mcp.example.com/v1", headers: { Authorization: "Bearer ya29.a0AfB_byC1234567890abcdef" } })).toBeUndefined();
    // A JWT may be a key as well as a sign-in: with key sync on it goes like any other secret.
    expect(secretMcpEntry({ url: "https://mcp.example.com/v1", headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345" } })).toBeDefined();
    expect(portableMcpEntry({ url: "https://mcp.example.com/v1", headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345" } })).toBeUndefined();
    expect(secretMcpEntry({ url: "https://mcp.example.com/v1", oauth: { clientId: "sk-ant-oat01-secret123456" } })).toBeUndefined();
    expect(secretMcpEntry({ url: "https://mcp.example.com/v1", oauth: { scopes: ["read", "ya29.a0AfB_byC1234567890abcdef"] } })).toBeUndefined();
    expect(secretMcpEntry({ url: "https://mcp.example.com/v1", headers: { "X-sk-ant-oat01-secret123456": "1" } })).toBeUndefined();
    // Non-opt-in portableMcpEntry also blocks JWTs and subscription tokens in OAuth fields.
    expect(portableMcpEntry({ url: "https://mcp.example.com/v1", oauth: { clientId: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345" } })).toBeUndefined();
    expect(portableMcpEntry({ url: "https://mcp.example.com/v1", oauth: { scopes: ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345"] } })).toBeUndefined();
});

test("settings, portable rules, MCP servers and custom providers sync without adopting pre-existing server rules", async () => {
    writeJson(paths.userSettings(), {
        model: "anthropic:claude-opus-5",
        effort: "high",
        fastMode: true,
        permissions: {
            defaultMode: "default",
            allow: ["Bash(npm test:*)", "Bash(curl -H 'Authorization: Bearer secret123')"],
            deny: ["Read(~/.ssh/*)"],
        },
        hooks: { PreToolUse: [{ command: "echo hi" }] },
        env: { SECRET_ENV: "nope" },
        mcpServers: {
            docs: { command: "npx", args: ["-y", "@scope/docs-mcp"] },
            privateApi: { url: "https://mcp.example.com/v1", headers: { Authorization: "Bearer tok_1234567890abcdef" } },
            localOnly: { url: "http://127.0.0.1:9999/mcp" },
        },
    });
    writeProvidersFile({
        custom: [
            { id: "acme", name: "Acme AI", baseUrl: "https://api.acme.example/v1", headers: { "X-Secret": "shhh" } },
            { id: "bad-creds", name: "Bad", baseUrl: "https://user:pass@api.bad.example/v1" },
            { id: "ollama-local", name: "Local Ollama", baseUrl: "http://localhost:11434/v1", requiresKey: false },
        ],
    });
    writeKnownMarketplaces({
        "local-file-git": { source: { source: "git", url: "file:///tmp/evil.git" }, installLocation: "/tmp/x", lastUpdated: "2026-01-01" },
        "signed-url": { source: { source: "url", url: "https://example.com/m.json?sig=secret" }, installLocation: "/tmp/y", lastUpdated: "2026-01-01" },
    });
    await setKey("anthropic", "sk-ant-api03-1234567890abcdefghijklmnop");

    const payloadNoSecrets = await localSyncState({ includeSecrets: false });
    expect(payloadNoSecrets.apiKeys).toBeUndefined();
    expect(Object.keys(payloadNoSecrets.mcpServers ?? {})).toEqual(["docs"]);
    expect(payloadNoSecrets.customProviders?.map((c) => c.id)).toEqual(["acme"]);
    expect(payloadNoSecrets.customProviders?.[0]?.headers).toBeUndefined();
    expect(payloadNoSecrets.marketplaces).toEqual([]);
    expect(payloadNoSecrets.permissions?.allow).toEqual(["Bash(npm test:*)"]);
    expect((payloadNoSecrets.settings as Record<string, unknown>).hooks).toBeUndefined();
    expect((payloadNoSecrets.settings as Record<string, unknown>).env).toBeUndefined();

    const serverHome = tempDir("cavvy-state-server-");
    await inHome(serverHome, async () => {
        // Server already has its own `fastMode: true` and `deny: ["Read(~/.ssh/*)"]` before sync: sync must NOT adopt them.
        writeJson(paths.userSettings(), {
            effort: "low",
            fastMode: true,
            permissions: { defaultMode: "bypassPermissions", allow: ["Bash(make build)"], deny: ["Read(~/.ssh/*)"] },
        });
        const r = await applyStateSync("a".repeat(64), payloadNoSecrets);
        expect(r.settingsChanged).toBeGreaterThan(0);
        expect(r.providersChanged).toBe(1);
        expect(r.keysChanged).toBe(0);

        const s = loadScope("user", serverHome);
        expect(s.effort).toBe("low");
        expect(s.permissions?.defaultMode).toBe("bypassPermissions");
        expect(s.permissions?.allow).toEqual(["Bash(make build)", "Bash(npm test:*)"]);
        expect(s.permissions?.deny).toEqual(["Read(~/.ssh/*)"]);
        expect(s.model).toBe("anthropic:claude-opus-5");
        expect(s.fastMode).toBe(true);
        expect(s.mcpServers).toEqual({ docs: { command: "npx", args: ["-y", "@scope/docs-mcp"] } });
        expect(await getKey("anthropic")).toBeUndefined();
    });

    // Unreadable/malformed Mac settings file must NOT wipe synced settings on server.
    writeFileSync(paths.userSettings(), "{ broken json");
    const unreadablePayload = await localSyncState({ includeSecrets: false });
    expect(unreadablePayload.settings).toBeUndefined();
    await inHome(serverHome, async () => {
        await applyStateSync("b".repeat(64), unreadablePayload);
        expect(loadScope("user", serverHome).model).toBe("anthropic:claude-opus-5");
    });

    // Valid update removes synced allow rule and docs MCP while keeping server-owned effort, fastMode, defaultMode, and pre-existing deny rule.
    writeJson(paths.userSettings(), {
        model: "anthropic:claude-sonnet-5",
        effort: "medium",
        permissions: { defaultMode: "default", allow: [], deny: [] },
        mcpServers: {},
    });
    const payload2 = await localSyncState({ includeSecrets: false });
    await inHome(serverHome, async () => {
        await applyStateSync("c".repeat(64), payload2);
        const s = loadScope("user", serverHome);
        expect(s.model).toBe("anthropic:claude-sonnet-5");
        expect(s.fastMode).toBe(true);
        expect(s.effort).toBe("low");
        expect(s.permissions?.allow).toEqual(["Bash(make build)"]);
        expect(s.permissions?.deny).toEqual(["Read(~/.ssh/*)"]);
        expect(s.permissions?.defaultMode).toBe("bypassPermissions");
        expect(s.mcpServers).toBeUndefined();
    });
});

test("opt-in secrets bind API keys to endpoints, are taken back on opt-out, and reject CLI OAuth tokens", async () => {
    writeJson(paths.userSettings(), {
        permissions: { allow: ["Bash(npm test:*)", "Bash(curl -H 'Authorization: Bearer secret123')"] },
        mcpServers: {
            privateApi: { url: "https://mcp.example.com/v1", headers: { Authorization: "Bearer tok_1234567890abcdef" } },
            localOnly: { url: "http://127.0.0.1:9999/mcp" },
            localBin: { command: "node", args: ["/Users/me/server.js"] },
        },
    });
    writeProvidersFile({
        custom: [{ id: "acme", name: "Acme AI", baseUrl: "https://api.acme.example/v1" }],
    });
    await setKey("anthropic", "sk-ant-api03-1234567890abcdefghijklmnop");
    await setKey("acme", "acme-mac-key-1234567890");

    const payload = await localSyncState({ includeSecrets: true });
    // Rules remain strictly portable even when includeSecrets is true.
    expect(payload.permissions?.allow).toEqual(["Bash(npm test:*)"]);
    expect(Object.keys(payload.mcpServers ?? {})).toEqual(["privateApi"]);
    expect(payload.apiKeys?.anthropic?.value).toBe("sk-ant-api03-1234567890abcdefghijklmnop");
    expect(payload.apiKeys?.acme).toEqual({ value: "acme-mac-key-1234567890", endpoint: "https://api.acme.example/v1" });

    const serverHome = tempDir("cavvy-secrets-server-");
    await inHome(serverHome, async () => {
        // Server already has `acme` pointed at a different endpoint with its own key: Mac's `acme` key must NOT be sent there.
        writeProvidersFile({
            custom: [{ id: "acme", name: "Server Acme", baseUrl: "https://other.acme.example/v1" }],
        });
        await setKey("acme", "server-local-acme-key");

        const injected = {
            ...payload,
            apiKeys: {
                ...payload.apiKeys,
                "claude-code": { value: "stolen-token-12345678", endpoint: "https://api.anthropic.com" },
                openai: { value: "sk-ant-oat01-injected-oauth", endpoint: "https://api.openai.com/v1" },
            },
        };
        const r = await applyStateSync("d".repeat(64), injected);
        expect(r.keysChanged).toBe(1);
        expect((await getKey("anthropic"))?.value).toBe("sk-ant-api03-1234567890abcdefghijklmnop");
        expect((await getKey("acme"))?.value).toBe("server-local-acme-key");
        expect(await getKey("claude-code")).toBeUndefined();
        expect(await getKey("openai")).toBeUndefined();

        const rawRecord = readFileSync(join(serverHome, "synced-state.json"), "utf-8");
        expect(rawRecord).not.toContain("sk-ant-api03-1234567890abcdefghijklmnop");
    });

    // Key sync turned off: the keys sync put on the server go, so none of them holds a provider's address back.
    const serverHome2 = tempDir("cavvy-optout-server-");
    await inHome(serverHome2, async () => {
        await applyStateSync("e".repeat(64), payload);
        expect(readProvidersFile().custom?.[0]?.baseUrl).toBe("https://api.acme.example/v1");
        expect((await getKey("acme"))?.value).toBe("acme-mac-key-1234567890");
    });
    writeProvidersFile({
        custom: [{ id: "acme", name: "Acme AI", baseUrl: "https://redirected.acme.example/v1" }],
    });
    const optOutPayload = await localSyncState({ includeSecrets: false });
    await inHome(serverHome2, async () => {
        const off = await applyStateSync("f".repeat(64), optOutPayload);
        expect(off.warnings).toEqual([]);
        expect(off.keysChanged).toBe(2);
        expect([...off.changedProviders].sort()).toEqual(["acme", "anthropic"]);
        expect(await getKey("acme")).toBeUndefined();
        expect(await getKey("anthropic")).toBeUndefined();
        expect(readProvidersFile().custom?.[0]?.baseUrl).toBe("https://redirected.acme.example/v1");
        expect(JSON.parse(readFileSync(join(serverHome2, "synced-state.json"), "utf-8")).apiKeys).toEqual({});

        // Turned on again: they're back.
        await applyStateSync("e".repeat(64), payload);
        expect(readProvidersFile().custom?.[0]?.baseUrl).toBe("https://api.acme.example/v1");
        expect((await getKey("acme"))?.value).toBe("acme-mac-key-1234567890");
        expect((await getKey("anthropic"))?.value).toBe("sk-ant-api03-1234567890abcdefghijklmnop");

        // A key changed on the server since is its own: off leaves it, and it still holds its provider's address.
        await setKey("acme", "server-own-acme-key");
        const blocked = await applyStateSync("f".repeat(64), optOutPayload);
        expect((await getKey("acme"))?.value).toBe("server-own-acme-key");
        expect(await getKey("anthropic")).toBeUndefined();
        expect(readProvidersFile().custom?.[0]?.baseUrl).toBe("https://api.acme.example/v1");
        // Said, and still sync's own: with the key gone, the next sync takes the new address.
        expect(blocked.warnings.some((w) => w.includes("acme"))).toBe(true);
        await removeKey("acme");
        const after = await applyStateSync("f".repeat(64), optOutPayload);
        expect(after.warnings).toEqual([]);
        expect(readProvidersFile().custom?.[0]?.baseUrl).toBe("https://redirected.acme.example/v1");
    });
    // `acme` removed on the server with a key of the server's own left behind: it isn't put back onto another address.
    await inHome(serverHome2, async () => {
        writeProvidersFile({});
        await setKey("acme", "server-own-acme-key");
        const r = await applyStateSync("0".repeat(64), optOutPayload);
        expect(r.warnings.some((w) => w.includes("acme"))).toBe(true);
        expect(readProvidersFile().custom ?? []).toEqual([]);
        expect((await getKey("acme"))?.value).toBe("server-own-acme-key");
    });

    // Derived env var on server for an absent custom provider also blocks inserting the provider onto a new endpoint.
    const serverHome3 = tempDir("cavvy-envkey-server-");
    const prevAcmeEnv = process.env.ACME_API_KEY;
    process.env.ACME_API_KEY = "env-acme-secret";
    try {
        await inHome(serverHome3, async () => {
            const r = await applyStateSync("2".repeat(64), optOutPayload);
            expect(r.warnings.some((w) => w.includes("acme"))).toBe(true);
            expect(readProvidersFile().custom ?? []).toEqual([]);
        });
    } finally {
        if (prevAcmeEnv === undefined) delete process.env.ACME_API_KEY;
        else process.env.ACME_API_KEY = prevAcmeEnv;
    }

    // Built-in provider whose env baseUrl override contains embedded credentials must be excluded from outgoing apiKeys.
    const prevBase = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://user:pass@proxy.example.com/v1";
    try {
        const pUnsafe = await localSyncState({ includeSecrets: true });
        expect(pUnsafe.apiKeys?.anthropic).toBeUndefined();
    } finally {
        if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
        else process.env.ANTHROPIC_BASE_URL = prevBase;
    }
});

test("CLI topology reconciles newly installed CLIs, managed account ownership/removals, and preserves signed-in accounts", async () => {
    const binDir = tempDir("cavvy-fake-bin-");
    const fakeClaude = join(binDir, "claude");
    // Real `claude auth status --json` semantics: empty stdout with exit 0 means signed in, so return explicit JSON.
    writeFileSync(
        fakeClaude,
        [
            "#!/bin/sh",
            'if [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.signed-in" ]; then',
            '  printf \'{"loggedIn":true,"email":"me@example.com"}\\n\'',
            "else",
            '  printf \'{"loggedIn":false}\\n\'',
            "fi",
            "",
        ].join("\n"),
        { mode: 0o755 },
    );
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    try {
        writeProvidersFile({
            agents: {
                "claude-code": { path: "/Users/me/bin/claude", args: ["--should-not-sync"] },
                grok: {},
            },
        });
        addAccount("claude-code", { id: "work", name: "Work" });
        addAccount("claude-code", { id: "personal", name: "Personal" });
        addAccount("claude-code", { id: "server-own", name: "Same ID On Mac" });
        setDefaultAccount("claude-code", "work");

        const serverHome = tempDir("cavvy-cli-server-");
        // Pre-existing managed account on the server with the same ID must never be adopted or deleted by sync.
        await inHome(serverHome, () => {
            // Grok counts as missing here even when it's installed on the machine running the tests (findCli also
            // looks in ~/.local/bin, and homedir() doesn't follow HOME): this path is taken away when it's "installed".
            writeProvidersFile({ agents: { grok: { path: join(serverHome, "no-grok") } } });
            addAccount("claude-code", { id: "server-own", name: "Server Local" });
        });

        const calls: string[] = [];
        const ask = async (method: string, params: Record<string, unknown>) => {
            calls.push(method);
            return inHome(serverHome, () => {
                if (method === "sync.state") return readSyncedStateDigest();
                if (method === "sync.applyState") return applyStateSync(params.digest, params.payload);
                return {};
            });
        };

        const first = await syncStateTo(ask, { includeSecrets: false });
        expect(first.result?.accountsAdded).toBe(2);
        expect(first.missingClis).toContain("grok");
        expect(first.needsSignIn?.some((s) => s.provider === "claude-code" && s.accountId === "work")).toBe(true);
        expect(first.needsSignIn?.some((s) => s.provider === "claude-code" && s.accountId === "personal")).toBe(true);

        await inHome(serverHome, () => {
            const pf = readProvidersFile();
            expect(pf.agents?.["claude-code"]?.path).toBeUndefined();
            expect(pf.agents?.["claude-code"]?.args).toBeUndefined();
            expect(pf.agents?.["claude-code"]?.defaultAccount).toBe("work");
            // Pre-existing server account kept its original name.
            expect(listAccounts("claude-code").find((a) => a.id === "server-own")?.name).toBe("Server Local");
        });

        // Second sync short-circuits on matching digest AND still reports pending sign-ins.
        calls.length = 0;
        const second = await syncStateTo(ask, { includeSecrets: false });
        expect(second.unchanged).toBe(true);
        expect(calls).toEqual(["sync.state"]);
        expect(second.missingClis).toContain("grok");
        expect(second.needsSignIn?.some((s) => s.provider === "claude-code" && s.accountId === "work")).toBe(true);

        // Installing `grok` on the server invalidates the digest so the next sync enables it immediately.
        writeFileSync(join(binDir, "grok"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        await inHome(serverHome, () => {
            const pf = readProvidersFileForUpdate();
            delete pf.agents?.grok;
            writeProvidersFile(pf);
        });
        calls.length = 0;
        const third = await syncStateTo(ask, { includeSecrets: false });
        expect(third.unchanged).toBeUndefined();
        expect(calls).toEqual(["sync.state", "sync.applyState"]);
        expect(third.missingClis).toEqual([]);
        await inHome(serverHome, () => {
            expect(readProvidersFile().agents?.grok).toBeDefined();
        });

        // Sign in `personal` on the server, then drop `work`, `personal`, and `server-own` on Mac:
        // - `work` (sync-owned, unsigned) is removed
        // - `personal` (sync-owned, signed-in) is preserved
        // - `server-own` (pre-existing server account, even unsigned) is preserved
        await inHome(serverHome, () => {
            const personalAcc = listAccounts("claude-code").find((a) => a.id === "personal")!;
            writeFileSync(join(personalAcc.folder, ".signed-in"), "ok");
        });
        setDefaultAccount("claude-code", "default");
        for (const id of ["work", "personal", "server-own"]) {
            const acc = listAccounts("claude-code").find((a) => a.id === id)!;
            removeAccount("claude-code", id, acc.folder);
        }
        const afterDrop = await syncStateTo(ask, { includeSecrets: false });
        expect(afterDrop.needsSignIn?.some((s) => s.provider === "claude-code" && s.accountId === "personal")).toBe(false);
        await inHome(serverHome, () => {
            expect(readProvidersFile().agents?.["claude-code"]?.defaultAccount).toBe("default");
            const ids = listAccounts("claude-code").map((a) => a.id);
            expect(ids).not.toContain("work");
            expect(ids).toContain("personal");
            expect(ids).toContain("server-own");
        });

        // Dynamic opt-out rechecked before dispatching sync.applyState.
        let optedIn = true;
        const askOptOut = async (method: string, params: Record<string, unknown>) => {
            if (method === "sync.state") {
                optedIn = false;
                return { missingClis: [], needsSignIn: [] };
            }
            if (method === "sync.applyState") {
                expect((params.payload as { includeSecrets?: boolean; apiKeys?: unknown }).includeSecrets).toBeUndefined();
                expect((params.payload as { apiKeys?: unknown }).apiKeys).toBeUndefined();
                return {
                    settingsChanged: 0,
                    providersChanged: 0,
                    keysChanged: 0,
                    pluginsChanged: 0,
                    accountsAdded: 0,
                    changedProviders: [],
                    restartedPlugins: [],
                    missingClis: [],
                    needsSignIn: [],
                    warnings: [],
                };
            }
            return {};
        };
        await syncStateTo(askOptOut, { includeSecrets: () => optedIn });
    } finally {
        process.env.PATH = prevPath;
    }
});

test("marketplace conflict and unreadable manifests preserve server plugins and enablement", async () => {
    const mktDir = tempDir("cavvy-mkt-");
    const plugDir = tempDir("cavvy-plug-");
    writeJson(paths.userSettings(), { enabledPlugins: { "tool@acme-mkt": false } });
    writeKnownMarketplaces({
        "acme-mkt": { source: { source: "github", repo: "org/acme-plugins" }, installLocation: mktDir, lastUpdated: "2026-01-01" },
    });
    writeInstalled({
        "tool@acme-mkt": {
            version: "1.0.0",
            installPath: plugDir,
            installedAt: "2026-01-01",
            lastUpdated: "2026-01-01",
            scopes: [{ scope: "user" }],
        },
    });

    const normal = await localSyncState({ includeSecrets: false });
    expect(normal.plugins).toEqual([{ id: "tool@acme-mkt", enabled: false, version: "1.0.0" }]);

    // Readable settings.json without an enabledPlugins entry means disabled (false), not undefined/true.
    writeJson(paths.userSettings(), {});
    const absentEnabled = await localSyncState({ includeSecrets: false });
    expect(absentEnabled.plugins).toEqual([{ id: "tool@acme-mkt", enabled: false, version: "1.0.0" }]);

    // Corrupt settings.json: plugin entry omits `enabled` so server enablement is preserved.
    writeFileSync(paths.userSettings(), "{ broken");
    const badSettings = await localSyncState({ includeSecrets: false });
    expect(badSettings.plugins).toEqual([{ id: "tool@acme-mkt", version: "1.0.0" }]);

    // Corrupt, blank, or wrong-shape installed_plugins.json: plugin section is omitted.
    writeJson(paths.userSettings(), {});
    for (const content of ["{ broken", "[]", "   \n"]) {
        writeFileSync(pluginPaths.installed(), content);
        const skipped = await localSyncState({ includeSecrets: false });
        expect(skipped.marketplaces).toBeUndefined();
        expect(skipped.plugins).toBeUndefined();
    }

    // Marketplace conflict on server skips installing/uninstalling plugins under the conflicting marketplace.
    const serverHome = tempDir("cavvy-mkt-conflict-");
    await inHome(serverHome, async () => {
        writeKnownMarketplaces({
            "acme-mkt": { source: { source: "github", repo: "other/different-plugins" }, installLocation: mktDir, lastUpdated: "2026-01-01" },
        });
        writeInstalled({
            "tool@acme-mkt": {
                version: "1.0.0",
                installPath: plugDir,
                installedAt: "2026-01-01",
                lastUpdated: "2026-01-01",
                scopes: [{ scope: "user" }],
            },
        });
        mkdirSync(serverHome, { recursive: true });
        writeFileSync(
            join(serverHome, "synced-state.json"),
            JSON.stringify({
                settings: {},
                rules: { allow: [], ask: [], deny: [] },
                mcpServers: {},
                customProviders: {},
                apiKeys: {},
                agents: {},
                marketplaces: {},
                plugins: { "tool@acme-mkt": { enabled: true, version: "1.0.0" } },
            }),
        );
        const r = await applyStateSync("1".repeat(64), normal);
        expect(r.warnings.some((w) => w.includes("acme-mkt"))).toBe(true);
        expect(readInstalled()["tool@acme-mkt"]).toBeDefined();
    });
});

test("an unreadable providers file here doesn't take MCP servers with secrets off a server", async () => {
    writeJson(paths.userSettings(), { mcpServers: { tool: { command: "npx", args: ["-y", "@scope/tool-mcp"], env: { TOOL_TOKEN: "abc" } } } });
    writeProvidersFile({});
    const good = await localSyncState({ includeSecrets: true });
    writeFileSync(paths.providers(), "{ broken json");
    const broken = await localSyncState({ includeSecrets: true });
    writeProvidersFile({});
    expect(broken.customProviders).toBeUndefined();
    expect(broken.apiKeys).toBeUndefined();
    expect(broken.includeSecrets).toBe(true);

    const serverHome = tempDir("cavvy-unreadable-providers-server-");
    await inHome(serverHome, async () => {
        await applyStateSync("3".repeat(64), good);
        expect(loadScope("user", serverHome).mcpServers?.tool?.env).toEqual({ TOOL_TOKEN: "abc" });
        await applyStateSync("4".repeat(64), broken);
        expect(loadScope("user", serverHome).mcpServers?.tool?.env).toEqual({ TOOL_TOKEN: "abc" });
    });
});

test("older server without sync.state returns unsupported cleanly", async () => {
    const ask = async (method: string) => {
        if (method === "sync.files") return {};
        if (method === "sync.apply") return { written: 0, removed: 0 };
        if (method === "sync.state") throw Object.assign(new Error("Unknown method: sync.state"), { code: "unknown" });
        return null;
    };
    const r = await syncAllTo(ask, { includeSecrets: false });
    expect(r.state.unsupported).toBe(true);
});

test("a server's sync is on, off, or not asked yet; an earlier build's key switch reads as on", () => {
    const e = draftServer({ name: "sync-box", destination: "dev@sync.example" });
    saveServer(e);
    expect(getServer("sync-box")?.sync).toBeUndefined();
    setServerSync("sync-box", true);
    expect(getServer("sync-box")?.sync).toBe(true);
    setServerSync("sync-box", false);
    expect(getServer("sync-box")?.sync).toBe(false);
    const old = draftServer({ name: "old-box", destination: "dev@old.example", syncSecrets: true } as Parameters<typeof draftServer>[0]);
    expect(old.sync).toBe(true);
});

test("with sync on, a CLI the server lacks is installed there by its own installer, once; a failed one is said and not tried again", async () => {
    const serverHome = tempDir("cavvy-install-server-");
    const userHome = tempDir("cavvy-install-home-");
    const bin = tempDir("cavvy-install-bin-");
    const opencode = join(userHome, "tools", "opencode");
    const grok = join(userHome, "tools", "grok");
    // A stand-in for curl. OpenCode's "installer" puts it where the server's Cavvy is told to look for it; Grok's
    // site can't be reached.
    writeFileSync(
        join(bin, "curl"),
        [
            "#!/bin/sh",
            'case "$*" in *x.ai*) echo "curl: (6) Could not resolve host: x.ai" >&2; exit 6 ;; esac',
            `printf '%s\\n' 'mkdir -p "${join(userHome, "tools")}" && printf "#!/bin/sh\\n" > "${opencode}" && chmod +x "${opencode}" && mkdir -p "$HOME/.opencode/bin" && touch "$HOME/.opencode/bin/opencode"'`,
            "",
        ].join("\n"),
        { mode: 0o755 },
    );
    const prev = { PATH: process.env.PATH, HOME: process.env.HOME };
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.HOME = userHome;
    try {
        writeProvidersFile({ agents: { opencode: {}, grok: {} } });
        // Where the server looks for each: not there yet (and never this test machine's own).
        await inHome(serverHome, () => writeProvidersFile({ agents: { opencode: { path: opencode }, grok: { path: grok } } }));
        const ask = (method: string, params: Record<string, unknown>) =>
            inHome(serverHome, () => (method === "sync.state" ? readSyncedStateDigest() : method === "sync.applyState" ? applyStateSync(params.digest, params.payload) : {}));

        // Without sync's say-so, nothing is installed.
        const plain = await syncStateTo(ask, { includeSecrets: false });
        expect([...(plain.missingClis ?? [])].sort()).toEqual(["grok", "opencode"]);
        expect(installing()).toEqual([]);

        const first = await syncStateTo(ask, { includeSecrets: false, installMissing: true });
        expect(first.installing).toEqual(["grok", "opencode"]);
        // Waited for as the server: it looks for what it installed in its own home.
        await inHome(serverHome, async () => {
            while (installing().length) await Bun.sleep(20);
        });
        expect(installState("opencode")).toEqual({});
        expect(existsSync(opencode)).toBe(true);
        expect(installState("grok").installError).toBe("curl: (6) Could not resolve host: x.ai");

        // The next sync sees OpenCode there; Grok's installer isn't run again behind the user's back.
        const after = await syncStateTo(ask, { includeSecrets: false, installMissing: true });
        expect(after.unchanged).toBeUndefined();
        expect(after.missingClis).toEqual(["grok"]);
        expect(after.installing).toBeUndefined();
        const again = await syncStateTo(ask, { includeSecrets: false, installMissing: true });
        expect(again.unchanged).toBe(true);
        expect(again.installing).toBeUndefined();

        // The server gets a new installer for it (an update): this computer's state hasn't changed, and the next
        // sync installs it all the same.
        const def = agentCli("grok")!;
        const was = def.cli.installCommand;
        def.cli.installCommand = `mkdir -p "${join(userHome, "tools")}" && printf "#!/bin/sh\\n" > "${grok}" && chmod +x "${grok}"`;
        try {
            const updated = await syncStateTo(ask, { includeSecrets: false, installMissing: true });
            expect(updated.installing).toEqual(["grok"]);
            await inHome(serverHome, async () => {
                while (installing().length) await Bun.sleep(20);
            });
            expect(existsSync(grok)).toBe(true);
        } finally {
            def.cli.installCommand = was;
        }
    } finally {
        process.env.PATH = prev.PATH;
        if (prev.HOME === undefined) delete process.env.HOME;
        else process.env.HOME = prev.HOME;
    }
});

test("with key sync on, a key or a secret shaped like a JWT syncs; a CLI's own sign-in token never does", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345";
    writeJson(paths.userSettings(), {
        mcpServers: { internal: { url: "https://mcp.example.com/v1", headers: { Authorization: `Bearer ${jwt}` } } },
    });
    writeProvidersFile({
        custom: [{ id: "gateway", name: "Gateway", baseUrl: "https://gateway.example/v1", headers: { "X-Token": jwt } }],
    });
    await setKey("gateway", jwt);
    await setKey("openai", `sk-ant-oat01-${"a".repeat(30)}`);
    try {
        const off = await localSyncState({ includeSecrets: false });
        expect(off.apiKeys).toBeUndefined();
        expect(off.mcpServers?.internal).toBeUndefined();
        expect(off.customProviders?.find((c) => c.id === "gateway")?.headers).toBeUndefined();

        const on = await localSyncState({ includeSecrets: true });
        expect(on.apiKeys?.gateway).toEqual({ value: jwt, endpoint: "https://gateway.example/v1" });
        expect(on.apiKeys?.openai).toBeUndefined();
        expect(on.mcpServers?.internal?.headers).toEqual({ Authorization: `Bearer ${jwt}` });
        expect(on.customProviders?.find((c) => c.id === "gateway")?.headers).toEqual({ "X-Token": jwt });

        const serverHome = tempDir("cavvy-jwt-server-");
        await inHome(serverHome, async () => {
            const r = await applyStateSync("a".repeat(64), on);
            expect(r.warnings).toEqual([]);
            expect((await getKey("gateway"))?.value).toBe(jwt);
            expect(loadScope("user", serverHome).mcpServers?.internal?.headers).toEqual({ Authorization: `Bearer ${jwt}` });
            // Off again: the key and the secret leave with it.
            const back = await applyStateSync("b".repeat(64), off);
            expect(back.warnings).toEqual([]);
            expect(await getKey("gateway")).toBeUndefined();
            expect(loadScope("user", serverHome).mcpServers).toBeUndefined();
            expect(readProvidersFile().custom?.find((c) => c.id === "gateway")?.headers).toBeUndefined();
        });
    } finally {
        await removeKey("gateway");
        await removeKey("openai");
    }
});

test("turning key sync off takes a synced key back though an environment variable stands over it", async () => {
    writeJson(paths.userSettings(), {});
    writeProvidersFile({});
    await setKey("anthropic", "sk-ant-api03-1234567890abcdefghijklmnop");
    const on = await localSyncState({ includeSecrets: true });
    const off = await localSyncState({ includeSecrets: false });
    await removeKey("anthropic");

    const serverHome = tempDir("cavvy-env-over-server-");
    const prevEnv = process.env.ANTHROPIC_API_KEY;
    try {
        await inHome(serverHome, async () => {
            await applyStateSync("a".repeat(64), on);
            expect((await getKey("anthropic"))?.source).not.toBe("env");
            process.env.ANTHROPIC_API_KEY = "sk-ant-api03-the-servers-own-environment";
            forgetCachedKeys();
            expect((await getKey("anthropic"))?.source).toBe("env");

            // Still on, with the variable over it: it stays sync's to take back.
            await applyStateSync("b".repeat(64), on);
            const r = await applyStateSync("c".repeat(64), off);
            expect(r.warnings).toEqual([]);
            expect(r.keysLeft).toBeUndefined();
            expect(r.keysChanged).toBe(1);

            delete process.env.ANTHROPIC_API_KEY;
            forgetCachedKeys();
            expect(await getKey("anthropic")).toBeUndefined();
        });
    } finally {
        if (prevEnv === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevEnv;
    }
});

test("a settings write that fails on the server leaves what sync owns on record, for the next sync to take back", async () => {
    writeJson(paths.userSettings(), { mcpServers: { tool: { command: "npx", args: ["-y", "@scope/tool-mcp"], env: { TOOL_TOKEN: "abc" } } } });
    writeProvidersFile({});
    const on = await localSyncState({ includeSecrets: true });
    const off = await localSyncState({ includeSecrets: false });

    const serverHome = tempDir("cavvy-readonly-settings-server-");
    // The server keeps its settings elsewhere, by a link: that folder can be closed without closing sync's own record.
    const elsewhere = tempDir("cavvy-readonly-settings-target-");
    writeFileSync(join(elsewhere, "settings.json"), "{}");
    symlinkSync(join(elsewhere, "settings.json"), join(serverHome, "settings.json"));
    await inHome(serverHome, async () => {
        await applyStateSync("a".repeat(64), on);
        expect(loadScope("user", serverHome).mcpServers?.tool?.env).toEqual({ TOOL_TOKEN: "abc" });

        chmodSync(join(elsewhere, "settings.json"), 0o444);
        chmodSync(elsewhere, 0o555);
        try {
            await expect(applyStateSync("b".repeat(64), off)).rejects.toThrow();
        } finally {
            chmodSync(elsewhere, 0o755);
            chmodSync(join(elsewhere, "settings.json"), 0o644);
        }
        expect(loadScope("user", serverHome).mcpServers?.tool?.env).toEqual({ TOOL_TOKEN: "abc" });

        const r = await applyStateSync("b".repeat(64), off);
        expect(r.warnings).toEqual([]);
        expect(loadScope("user", serverHome).mcpServers).toBeUndefined();
    });
});

test("settings and keys still sync when the server can't take a file", async () => {
    const asked: string[] = [];
    const ask = async (method: string) => {
        asked.push(method);
        if (method === "sync.files") throw new Error("read-only file system");
        if (method === "sync.state") return { digest: "none", missingClis: [], needsSignIn: [] };
        if (method === "sync.applyState") return { warnings: [], missingClis: [], needsSignIn: [] };
        return null;
    };
    await expect(syncAllTo(ask, { includeSecrets: false })).rejects.toThrow("read-only file system");
    expect(asked).toEqual(["sync.files", "sync.state", "sync.applyState"]);
});
