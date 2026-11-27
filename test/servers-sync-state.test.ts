// Structured Mac -> server state sync (src/servers/sync-state.ts):
// settings key-level merge, strict ownership of portable rules, MCP/URL/provider validation, endpoint-bound
// opt-in Cavvy API keys, CLI topology + managed accounts (zero CLI credentials), marketplace conflict guards,
// unreadable-file safety, dynamic secret opt-out, digest short-circuit, and backward compatibility.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { setKey, getKey, removeKey, forgetCachedKeys } = await import("../src/auth/credentials");
const { readProvidersFile, writeProvidersFile } = await import("../src/providers/registry");
const { addAccount, listAccounts, removeAccount, setDefaultAccount } = await import("../src/providers/accounts");
const { loadScope, writeJson } = await import("../src/config/settings");
const { paths } = await import("../src/config/paths");
const { pluginPaths, readInstalled, writeInstalled, writeKnownMarketplaces } = await import("../src/plugins/store");
const { portableMcpEntry } = await import("../src/servers/copy");
const { applyStateSync, isSafeRemoteUrl, localSyncState, readSyncedStateDigest, secretMcpEntry, syncAllTo, syncStateTo } = await import("../src/servers/sync-state");
const { draftServer, getServer, saveServer, setServerSyncSecrets } = await import("../src/servers/store");

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
    expect(secretMcpEntry({ url: "https://mcp.example.com/v1", headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345" } })).toBeUndefined();
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

test("opt-in secrets bind API keys to endpoints, block opt-out endpoint redirects, and reject CLI OAuth tokens", async () => {
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

    // Opt-out redirect & re-insert guards: after syncing `acme` + its key, opting out of secrets sync must NOT
    // allow redirecting `acme.baseUrl`, nor removing and re-inserting `acme` onto a different URL while the key remains.
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
        const blocked = await applyStateSync("f".repeat(64), optOutPayload);
        expect(readProvidersFile().custom?.[0]?.baseUrl).toBe("https://api.acme.example/v1");
        expect((await getKey("acme"))?.value).toBe("acme-mac-key-1234567890");
        // Said, and still sync's own: with the key gone, the next sync takes the new address.
        expect(blocked.warnings.some((w) => w.includes("acme"))).toBe(true);
        await removeKey("acme");
        const after = await applyStateSync("f".repeat(64), optOutPayload);
        expect(after.warnings).toEqual([]);
        expect(readProvidersFile().custom?.[0]?.baseUrl).toBe("https://redirected.acme.example/v1");
        await applyStateSync("e".repeat(64), payload);
        expect(readProvidersFile().custom?.[0]?.baseUrl).toBe("https://api.acme.example/v1");
        expect((await getKey("acme"))?.value).toBe("acme-mac-key-1234567890");
    });
    // Remove `acme` on serverHome2 while leaving its key behind, then try inserting `acme` with a different URL.
    await inHome(serverHome2, async () => {
        writeProvidersFile({});
        const r = await applyStateSync("0".repeat(64), optOutPayload);
        expect(r.warnings.some((w) => w.includes("acme"))).toBe(true);
        expect(readProvidersFile().custom ?? []).toEqual([]);
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

test("ServerEntry.syncSecrets persists only when enabled", () => {
    const e = draftServer({ name: "sync-box", destination: "dev@sync.example" });
    saveServer(e);
    expect(getServer("sync-box")?.syncSecrets).toBeUndefined();
    setServerSyncSecrets("sync-box", true);
    expect(getServer("sync-box")?.syncSecrets).toBe(true);
    setServerSyncSecrets("sync-box", false);
    expect(getServer("sync-box")?.syncSecrets).toBeUndefined();
});
