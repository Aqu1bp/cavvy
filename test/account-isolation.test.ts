// Each scenario starts Bun with a temporary HOME (Bun caches homedir at startup).
// All real Engine RPC and backend work uses fake claude/codex executables on PATH.
import { expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { homedir, tmpdir } from "os";
import { join, resolve, sep } from "path";
import type { Method, Methods, ServerEvent } from "../src/server/protocol";

const selectors = ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CODEX_HOME"] as const;
// Expected identity comes from the driving operation, never the observed folder.
function assertIntendedLaunch(entry: any, defaults: Record<string, string | null>, folders: Record<string, string>) {
    expect(["claude-code", "codex"]).toContain(entry.provider);
    expect(["default", "work"]).toContain(entry.intendedAccount);
    const expected = entry.intendedAccount === "default" ? defaults : entry.provider === "claude-code"
        ? { HOME: defaults.HOME, CLAUDE_CONFIG_DIR: folders[entry.provider], CLAUDE_SECURESTORAGE_CONFIG_DIR: folders[entry.provider], CODEX_HOME: null }
        : { HOME: defaults.HOME, CODEX_HOME: folders[entry.provider], CLAUDE_CONFIG_DIR: null, CLAUDE_SECURESTORAGE_CONFIG_DIR: null };
    expect(entry.env).toEqual(expected);
    expect(entry.folder).toBe(entry.intendedAccount === "work" ? folders[entry.provider] :
        (entry.provider === "codex" ? defaults.CODEX_HOME || join(defaults.HOME!, ".codex") : defaults.CLAUDE_CONFIG_DIR || join(defaults.HOME!, ".claude")));
}

test("launch checker rejects a Default probe that observes the named folder", () => {
    const defaults = { HOME: "/fake/home", CLAUDE_CONFIG_DIR: null, CLAUDE_SECURESTORAGE_CONFIG_DIR: null, CODEX_HOME: null };
    const entry = { provider: "codex", intendedAccount: "default", folder: "/fake/work", env: { ...defaults, CODEX_HOME: "/fake/work" } };
    expect(() => assertIntendedLaunch(entry, defaults, { codex: "/fake/work" })).toThrow();
    expect(() => assertIntendedLaunch({ ...entry, intendedAccount: "work" }, defaults, { codex: "/fake/work" })).not.toThrow();
});

const scenario = process.env.CAVVY_TEST_ISOLATION_CASE;
if (!scenario) {
    for (const mode of ["unset", "custom", "empty-secure", "empty", "relative"]) test(`account isolation lifecycle: ${mode}`, async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "account-isolation-")));
        const home = join(root, "home");
        mkdirSync(home);
        const env = { ...process.env, HOME: home, CAVVY_HOME: join(root, "state"), CAVVY_NO_KEYCHAIN: "1", CAVVY_TEST_ISOLATION_ROOT: root, CAVVY_TEST_ISOLATION_CASE: mode };
        for (const key of selectors) delete env[key];
        // Do not carry credentials or fixture switches from the invoking test process.
        for (const key of Object.keys(env)) if (/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|BASE_URL)$/.test(key) || key.startsWith("FAKE_")) delete env[key];
        if (mode !== "unset") Object.assign(env, {
            CLAUDE_CONFIG_DIR: mode === "empty" ? "" : join(root, "user-claude"),
            CLAUDE_SECURESTORAGE_CONFIG_DIR: mode === "custom" ? join(root, "user-secure") : "",
            CODEX_HOME: mode === "empty" ? "" : join(root, "user-codex"),
        });
        if (mode === "relative") Object.assign(env, { CLAUDE_CONFIG_DIR: "user-claude", CLAUDE_SECURESTORAGE_CONFIG_DIR: "user-secure", CODEX_HOME: "user-codex" });
        try {
            const proc = Bun.spawn([process.execPath, "--no-env-file", "test", import.meta.path], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
            const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
            expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 });
        } finally { rmSync(root, { recursive: true, force: true }); }
    }, 60_000);
} else {
    const root = process.env.CAVVY_TEST_ISOLATION_ROOT!;
    const home = realpathSync(homedir());
    if (!root?.startsWith(realpathSync(tmpdir()) + sep) || home !== join(root, "home") || process.env.CAVVY_NO_KEYCHAIN !== "1") throw new Error("Expected temporary HOME and disabled keychain");
    const parent = Object.fromEntries(["HOME", ...selectors].map((key) => [key, process.env[key] ?? null]));
    const defaultEnv = parent;
    const bin = join(root, "bin"), cwd = join(home, "project");
    for (const dir of [bin, cwd, process.env.CAVVY_HOME!]) mkdirSync(dir, { recursive: true });
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    for (const [name, provider] of [["claude", "claude-code"], ["codex", "codex"]]) {
        const path = join(bin, name!);
        writeFileSync(path, `#!/bin/sh\nexec ${quote(process.execPath)} --no-env-file ${quote(join(import.meta.dir, "fixtures/account-isolation-cli.ts"))} ${quote(provider!)} "$@"\n`);
        chmodSync(path, 0o700);
    }
    // No user startup files or real CLI path is needed by these children.
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.FAKE_SCENARIO = "silent";
    process.env.FAKE_CODEX_SCENARIO = "web";
    process.env.FAKE_LOG = join(root, "protocol.jsonl");
    const log = process.env.CAVVY_TEST_ISOLATION_LOG = join(root, "starts.jsonl");
    const claudeHome = defaultEnv.CLAUDE_CONFIG_DIR || join(home, ".claude");
    const codexHome = defaultEnv.CODEX_HOME || join(home, ".codex");
    const protectedDirs = [...new Set([join(home, ".claude"), join(home, ".codex"), claudeHome, codexHome, ...(defaultEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR ? [defaultEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR] : [])])];
    for (const dir of protectedDirs) {
        mkdirSync(join(dir, "nested"), { recursive: true });
        writeFileSync(join(dir, "nested", "sentinel"), `untouched: ${dir}\n`);
    }
    writeFileSync(join(home, ".claude.json"), '{"defaultLogin":"must survive"}\n');
    for (const [folder, provider] of [[claudeHome, "claude-code"], [codexHome, "codex"]]) writeFileSync(join(folder!, "cli-canary"), `${provider}\n`);
    // History folders each CLI makes on its first run: a named account's links share them (account-layout.ts),
    // and Cavvy makes them in Default only when missing.
    for (const d of ["projects", "file-history", "plans", "tasks", "paste-cache"]) mkdirSync(join(claudeHome, d), { recursive: true });
    for (const d of ["sessions", "archived_sessions", "thread-writer-locks"]) mkdirSync(join(codexHome, d), { recursive: true });
    const { claudeSession, codexSession } = await import("./helpers/cli-stores");
    const native = {
        "claude-code": claudeSession(claudeHome, { cwd, turns: [{ prompt: "Before Cavvy", reply: "Existing Claude conversation" }] }),
        codex: codexSession(codexHome, { cwd, turns: [{ prompt: "Before Cavvy", reply: "Existing Codex conversation" }] }),
    };
    const hashTree = (path: string): unknown => statSync(path).isDirectory()
        ? Object.fromEntries(readdirSync(path).sort().map((name) => [name, hashTree(join(path, name))]))
        : createHash("sha256").update(readFileSync(path)).digest("hex");
    const snapshot = () => Object.fromEntries([...protectedDirs, join(home, ".claude.json")].map((path) => [path, hashTree(path)]));
    const before = snapshot();
    const { Engine } = await import("../src/server/engine");
    const { saveAgentConfig, getProvider } = await import("../src/providers/registry");
    const { createBackend } = await import("../src/backends/index");
    const { accountEnv } = await import("../src/providers/accounts");
    const providers = ["claude-code", "codex"] as const;
    for (const provider of providers) saveAgentConfig(provider, {});
    writeFileSync(join(process.env.CAVVY_HOME!, "settings.json"), JSON.stringify({ delegation: false }));
    const starts = (): any[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const until = async (check: () => boolean) => {
        const end = Date.now() + 10000;
        while (!check()) { if (Date.now() > end) throw new Error(`Timed out: ${process.env.CAVVY_TEST_ISOLATION_PHASE}`); await Bun.sleep(10); }
    };

    test.skipIf(scenario !== "relative")("relative Default selectors refuse login, probes and models before spawning", async () => {
        const { loginCommand } = await import("../src/backends/account-login");
        const { checkAgentCli } = await import("../src/backends/index");
        for (const provider of providers) {
            expect(() => accountEnv(provider)).toThrow(/relative.*absolute path/);
            expect(() => loginCommand(provider)).toThrow(/relative.*absolute path/);
            await expect(checkAgentCli(provider)).rejects.toThrow(/relative.*absolute path/);
            await expect(createBackend(getProvider(provider)!).listModels()).rejects.toThrow(/relative.*absolute path/);
        }
        expect(starts()).toHaveLength(0);
        expect(snapshot()).toEqual(before);
    });

    test.skipIf(scenario === "relative")("Engine/RPC lifecycle preserves Default and confines named accounts", async () => {
        // Exercise the real CLI catalogs while excluding unrelated network providers.
        const engine = new Engine({ startCwd: cwd, listModels: async () => Promise.all(providers.map(async (provider) => ({ provider: getProvider(provider)!, status: "ok" as const, models: await createBackend(getProvider(provider)!).listModels() }))) });
        const events: ServerEvent[] = [];
        const client = { subs: new Set<string>(), send(event: ServerEvent) { events.push(event); } };
        engine.clients.add(client);
        const call = <M extends Method>(method: M, params: Methods[M]["params"]) => engine.handle(client, method, params);
        const folders: Record<string, string> = {};
        // Tag the real spawn at invocation time using an explicit operation plan.
        // This handles concurrent status checks without depending on child log order,
        // selectors, or the account chosen by the implementation under test.
        let pending: Record<string, string[] | string> = {};
        const preferences: Record<string, string> = { "claude-code": "default", codex: "default" };
        const unexpected: string[] = [];
        const spawn = Bun.spawn;
        const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((argv: any, opts: any) => {
            const provider = Array.isArray(argv) ? argv[0] === join(bin, "claude") ? "claude-code" : argv[0] === join(bin, "codex") ? "codex" : undefined : undefined;
            if (provider) {
                const planned = pending[provider];
                const intendedAccount = typeof planned === "string" ? planned : planned?.shift();
                if (!intendedAccount) unexpected.push(`${process.env.CAVVY_TEST_ISOLATION_PHASE}: ${provider}`);
                opts = { ...opts, env: { ...opts.env, CAVVY_TEST_INTENDED_ACCOUNT: intendedAccount ?? "UNPLANNED" } };
            }
            return spawn(argv, opts);
        }) as typeof Bun.spawn);
        const phase = (label: string, plan: Record<string, string[] | string> = {}) => {
            expect(unexpected).toEqual([]);
            expect(Object.values(pending).filter(Array.isArray).flat()).toEqual([]);
            pending = plan;
            process.env.CAVVY_TEST_ISOLATION_PHASE = label;
            return starts().length;
        };
        const catalogs = (provider?: string, id = "default") => Object.fromEntries(providers.map((p) => [p, [p === provider ? id : "default"]]));
        const assertEnv = (entry: any, provider: string, id: string) => {
            expect(entry.provider).toBe(provider);
            expect(entry.intendedAccount).toBe(id);
            assertIntendedLaunch(entry, defaultEnv, folders);
        };
        const session = async (provider: string) => {
            phase(`create-${provider}`, { ...preferences });
            const snap = await call("session.create", { cwd, model: `${provider}:${provider === "codex" ? "gpt-test" : "default"}` });
            const rt = engine.runtimes.get(snap.state.id)!;
            // Avoid optional secret/delegation listeners and generated titles.
            rt.toolState.secrets = undefined;
            rt.session.setTitle("Canary");
            rt.session.meta.system = "Account isolation canary";
            return rt;
        };
        const turn = async (rt: Awaited<ReturnType<typeof session>>, provider: string, id: string) => {
            const from = phase(`turn-${provider}-${id}`, { [provider]: [id] });
            const count = rt.snapshot().turns.length;
            await call("session.send", { id: rt.id, text: `Hello ${provider} ${id}` });
            await until(() => rt.idle && rt.snapshot().turns.length > count);
            expect(rt.snapshot().turns.at(-1)?.status).toBe("done");
            const launched = starts().slice(from);
            expect(launched.length).toBeGreaterThan(0);
            for (const entry of launched) assertEnv(entry, provider, id);
            expect(Object.fromEntries(["HOME", ...selectors].map((key) => [key, process.env[key] ?? null]))).toEqual(parent);
            phase("after-turn");
        };
        try {
            phase("initial-list");
            const listed = await call("providers.list", {});
            for (const provider of providers) {
                expect(listed.find((p) => p.id === provider)?.agentCli?.installed).toBe(true);
                expect(await call("accounts.list", { provider })).toHaveLength(1);
            }
            expect(starts()).toHaveLength(0);
            if (process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR) {
                for (const provider of providers) await expect(call("accounts.add", { provider, id: "collision", name: "Collision", folder: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR })).rejects.toMatchObject({ code: "invalid" });
            }
            // Both accounts coexist: removal must preserve the other provider's folder.
            for (const provider of providers) {
                phase(`add-${provider}`, catalogs());
                const added = await call("accounts.add", { provider, id: "work", name: "Work" });
                folders[provider] = added.folder;
                expect(added.managed).toBe(true);
            }
            for (const provider of providers) {
                for (const id of ["work", "default"]) {
                    const from = phase(`login-${provider}-${id}`, { ...catalogs(), [provider]: [id, "default", "work", "default"] });
                    const changed = events.filter((e) => e.type === "models.changed").length;
                    const terminal = `login-${provider}-${id}`;
                    await call("terminal.open", { id: terminal, cwd, cols: 80, rows: 24, login: { provider, accountId: id } });
                    // onExit refreshes statuses and catalogs; wait for it before the next phase.
                    await until(() => events.filter((e) => e.type === "models.changed").length > changed);
                    const login = starts().slice(from).filter((s) => s.argv.includes("login"));
                    expect(login).toHaveLength(1);
                    assertEnv(login[0], provider, id);
                    await call("terminal.close", { id: terminal });
                }
                const from = phase(`status-${provider}`, { [provider]: ["default", "work"] });
                const status = await call("accounts.list", { provider, refresh: true });
                expect(status.every((a) => a.signedIn)).toBe(true);
                const checked = starts().slice(from);
                expect(checked).toHaveLength(2);
                for (const id of ["default", "work"]) {
                    const entry = checked.find((s) => s.intendedAccount === id);
                    expect(entry).toBeDefined(); assertEnv(entry, provider, id);
                }
                const named = await session(provider);
                await call("session.setAccount", { id: named.id, provider, accountId: "work" });
                await turn(named, provider, "work");
                const normal = await session(provider);
                await turn(normal, provider, "default");
                await call("session.setAccount", { id: named.id, provider, accountId: "default" });
                await turn(named, provider, "default");
                await call("session.setAccount", { id: named.id, provider, accountId: "work" });
                await turn(named, provider, "work");
                preferences[provider] = "work";
                phase(`prefer-${provider}`, catalogs(provider, "work"));
                const catalogFrom = starts().length;
                await call("accounts.setDefault", { provider, id: "work" });
                const catalog = starts().slice(catalogFrom).find((s) => s.provider === provider);
                expect(catalog).toBeDefined(); assertEnv(catalog, provider, "work");
                const preferred = await session(provider);
                expect(preferred.session.accountId(provider)).toBe("work");
                await turn(preferred, provider, "work");
                // Imports continue on Default even when new sessions prefer Work.
                phase(`import-${provider}`, { ...preferences });
                const imported = await call("cliSessions.import", { cwd, source: provider, id: native[provider].id });
                const rt = engine.runtimes.get(imported.state.id)!;
                rt.toolState.secrets = undefined; rt.session.setTitle("Imported canary"); rt.session.meta.system = "Imported canary";
                expect(rt.session.accountId(provider)).toBe("default");
                await turn(rt, provider, "default");
                preferences[provider] = "default";
                phase(`unprefer-${provider}`, catalogs());
                await call("accounts.setDefault", { provider, id: "default" });
                const unpreferred = await session(provider);
                expect(unpreferred.session.accountId(provider)).toBe("default");
                await turn(unpreferred, provider, "default");
                expect(preferred.session.accountId(provider)).toBe("work");
                await call("accounts.rename", { provider, id: "work", name: "Renamed" });
                expect((await call("accounts.list", { provider })).find((a) => a.id === "work")?.name).toBe("Renamed");
                // No caller can retain a shared env object and contaminate a later Default.
                const mutable = accountEnv(provider, "work"); mutable.CLAUDE_CONFIG_DIR = "bad";
                expect(accountEnv(provider)).toEqual(Object.fromEntries(selectors.filter((key) => defaultEnv[key] !== null).map((key) => [key, defaultEnv[key]])));
            }
            const protocol = readFileSync(process.env.FAKE_LOG!, "utf8");
            expect(protocol).toContain('"method":"account/rateLimits/read"');
            await call("limits.get", {});
            await call("usage.summary", { days: 7 });
            for (const provider of providers) {
                expect(existsSync(join(folders[provider]!, "cli-canary"))).toBe(true);
                await call("accounts.remove", { provider, id: "work", confirmedFolder: folders[provider]! });
                expect(existsSync(folders[provider]!)).toBe(false);
                expect(await call("accounts.list", { provider })).toHaveLength(1);
                if (provider === "claude-code") expect(existsSync(join(folders.codex!, "cli-canary"))).toBe(true);
                expect(snapshot()).toEqual(before);
            }
        } finally { await engine.stop(); spawnSpy.mockRestore(); }
        // Validate every spawn, including automatic post-login checks and model probes.
        phase("final-check");
        for (const entry of starts()) assertIntendedLaunch(entry, defaultEnv, folders);
        expect(snapshot()).toEqual(before);
    }, 50_000);
}
