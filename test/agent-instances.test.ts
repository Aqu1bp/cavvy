import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
const iso = isolate();
const { allProviders, getProvider, readProvidersFile, saveAgentConfig, writeProvidersFile } = await import("../src/providers/registry");
const { addInstance, listInstances, removeInstance, updateInstance } = await import("../src/providers/instances");
const { cliEnv } = await import("../src/providers/agent-env");
const { agentCli, baseCli } = await import("../src/backends/defs");
const { clientFor, listAllModels, resolveModelInfo } = await import("../src/providers/models");
const { findCli, extraArgs } = await import("../src/backends/cli");
const { addAccount, defaultAccount, setDefaultAccount } = await import("../src/providers/accounts");
const { getKey } = await import("../src/auth/credentials");
const { secretEnvId } = await import("../src/providers/agent-env");

const dir = tempDir("agent-instances-");
const bin = join(dir, "claude");
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-claude.ts")}" "$@"\n`);
chmodSync(bin, 0o755);
const log = join(dir, "log.jsonl");
process.env.FAKE_LOG = log;
process.env.FAKE_LOG_ENV = "1";
afterAll(() => {
    delete process.env.FAKE_LOG;
    delete process.env.FAKE_LOG_ENV;
    iso.cleanup();
});

/** The fake CLI's starts since the log was cleared, each with its environment. */
const starts = (): Record<string, string>[] => (existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.env).map((o) => o.env) : []);

beforeEach(() => {
    rmSync(log, { force: true });
    writeProvidersFile({ agents: { "claude-code": { path: bin } } });
    rmSync(join(iso.home, "cache"), { recursive: true, force: true });
});

test("an instance is a provider of its own that runs its CLI", async () => {
    const id = await addInstance("claude-code", { name: "OpenRouter", env: [{ name: "ANTHROPIC_BASE_URL", value: "https://openrouter.example/api" }] });
    expect(id).toBe("claude-code@openrouter");
    const def = getProvider(id)!;
    expect(def).toMatchObject({ name: "Claude Code · OpenRouter", kind: "agent", auth: "cli", instanceOf: "claude-code" });
    // Right after its CLI.
    const ids = allProviders().map((p) => p.id);
    expect(ids.indexOf(id)).toBe(ids.indexOf("claude-code") + 1);
    expect(agentCli(id)?.id).toBe("claude-code");
    expect(baseCli(id)).toBe("claude-code");
    // Its CLI's path unless it has its own; its own arguments only.
    saveAgentConfig("claude-code", { args: ["--base-only"] });
    expect(findCli(id, agentCli(id)!.cli)).toBe(bin);
    expect(extraArgs(id)).toEqual([]);
    // A second of the same name gets told; another name gets its own id.
    await expect(addInstance("claude-code", { name: "openrouter" })).rejects.toThrow(/already/);
    expect(await addInstance("claude-code", { name: "Open Router!" })).toBe("claude-code@open-router");
    await expect(addInstance("anthropic", { name: "X" })).rejects.toThrow(/isn't an agent CLI/);
});

test("its CLI is started with its own variables, on the account chosen for the CLI", async () => {
    const id = await addInstance("claude-code", { name: "Router", env: [{ name: "ANTHROPIC_AUTH_TOKEN", value: "router-secret-for-tests-0123", secret: true }] });
    expect(cliEnv(id).ANTHROPIC_AUTH_TOKEN).toBe("router-secret-for-tests-0123");
    expect(cliEnv("claude-code").ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    // Not in providers.json.
    expect(readFileSync(join(iso.home, "providers.json"), "utf-8")).not.toContain("router-secret-for-tests-0123");
    const a = addAccount("claude-code", { id: "work", name: "Work" });
    setDefaultAccount("claude-code", a.id);
    expect(defaultAccount(id)).toBe("work");
    expect(cliEnv(id, "work").CLAUDE_CONFIG_DIR).toBe(cliEnv("claude-code", "work").CLAUDE_CONFIG_DIR);
});

test("listed without a CLI process until asked, then with its own setup; its own models after", async () => {
    const id = await addInstance("claude-code", { name: "Router", env: [{ name: "ROUTER_MARK", value: "on" }], models: ["anthropic/claude-sonnet-4.5", "sonnet"] });
    // The startup listing: the CLI is listed (one process); the instance shows its list, and adds no process.
    let listings = await listAllModels();
    expect(starts()).toHaveLength(1);
    expect(starts()[0]!.ROUTER_MARK).toBeUndefined();
    const inst = listings.find((l) => l.provider.id === id)!;
    expect(inst.models.map((m) => m.id)).toEqual(["default", "sonnet", "anthropic/claude-sonnet-4.5"]);
    expect(inst.models.every((m) => m.provider === id)).toBe(true);
    expect(resolveModelInfo(`${id}:sonnet`)).toMatchObject({ provider: id, id: "sonnet", name: "Sonnet (claude-test-2)" });
    // Asked (added, changed, or a refresh): its CLI with its variables, once.
    rmSync(log, { force: true });
    listings = await listAllModels({ refreshIds: [id] });
    expect(starts()).toHaveLength(1);
    expect(starts()[0]!.ROUTER_MARK).toBe("on");
    // Cached since, at any age: not asked again.
    const cache = JSON.parse(readFileSync(join(iso.home, "cache", "models.json"), "utf-8"));
    cache.providers[id].fetchedAt = 1;
    cache.providers["claude-code"].fetchedAt = Date.now();
    writeFileSync(join(iso.home, "cache", "models.json"), JSON.stringify(cache));
    rmSync(log, { force: true });
    listings = await listAllModels();
    expect(starts()).toHaveLength(0);
    // Its own models aren't cached with the CLI's list: a change shows at once.
    await updateInstance(id, { name: "Router", env: [{ name: "ROUTER_MARK", value: "on" }], models: ["router/other"] });
    rmSync(log, { force: true });
    listings = await listAllModels();
    expect(listings.find((l) => l.provider.id === id)!.models.map((m) => m.id)).toEqual(["default", "sonnet", "router/other"]);
    expect(starts()).toHaveLength(0);
    // Its variables changed: its cached list is another setup's (another fingerprint), so its CLI's shows, still without a process.
    await updateInstance(id, { name: "Router", env: [{ name: "ROUTER_MARK", value: "off" }] });
    listings = await listAllModels();
    expect(starts()).toHaveLength(0);
    expect(listings.find((l) => l.provider.id === id)!.models.map((m) => m.id)).toEqual(["default", "sonnet"]);
});

test("a bad model id or name is refused before anything's saved", async () => {
    await expect(addInstance("claude-code", { name: "X", models: ["--evil"] })).rejects.toThrow(/isn't a model id/);
    await expect(addInstance("claude-code", { name: "" })).rejects.toThrow(/name/);
    await expect(addInstance("claude-code", { name: "Y", env: [{ name: "CODEX_HOME", value: "/tmp" }] })).rejects.toThrow(/account/);
    expect(Object.keys(readProvidersFile().agents ?? {})).toEqual(["claude-code"]);
});

test("removed, its secrets go, and its sessions can't start it as its CLI's own setup", async () => {
    const id = await addInstance("claude-code", { name: "Router", env: [{ name: "ANTHROPIC_AUTH_TOKEN", value: "router-secret-for-tests-4567", secret: true }] });
    expect(listInstances("claude-code").map((i) => i.id)).toEqual([id]);
    expect(JSON.stringify(listInstances("claude-code"))).not.toContain("router-secret-for-tests-4567");
    await clientFor(id);
    expect(await removeInstance(id)).toBe(true);
    expect(getProvider(id)).toBeUndefined();
    expect(await getKey(secretEnvId(id, "ANTHROPIC_AUTH_TOKEN"))).toBeUndefined();
    expect(() => cliEnv(id)).toThrow(/"router" was removed\. Pick another model/);
    await expect(clientFor(id)).rejects.toThrow(/was removed/);
    expect((await listAllModels()).some((l) => l.provider.id === id)).toBe(false);
});
