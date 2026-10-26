// Claude Code loads Cavvy's plugins itself (--plugin-dir), through the
// real Agent loop and a fake `claude` (test/fixtures/fake-claude.ts). Codex and
// read-only sub-agents get none; Cavvy doesn't run hooks Claude Code runs.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { cleanup } = isolate();
const registry = await import("../src/providers/registry");
const { clientFor, forgetClient } = await import("../src/providers/models");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const trust = await import("../src/config/trust");
const { loadSettings } = await import("../src/config/settings");
const { paths } = await import("../src/config/paths");
const { addMarketplace } = await import("../src/plugins/marketplaces");
const { installPlugin } = await import("../src/plugins/install");
const { readInstalled, clearJsonCache } = await import("../src/plugins/store");
const { clearPluginCache } = await import("../src/plugins/loader");
const { claudeManifest, runsPluginCommand, withoutPluginHooks } = await import("../src/plugins/native");
const { loadSkills } = await import("../src/agent/skills");
const { cliRunsSkills } = await import("../src/backends/native-skills");
const { runHeadless } = await import("../src/headless");

const bin = tempDir("native-plugins-");
const LOG = join(bin, "log.jsonl");
function wrapper(name: string, fixture: string): string {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", fixture)}" "$@"\n`);
    chmodSync(p, 0o755);
    return p;
}
const claudeBin = wrapper("claude", "fake-claude.ts");
const codexBin = wrapper("codex", "fake-codex.ts");
afterAll(() => {
    cleanup();
    rmSync(bin, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

function write(file: string, data: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
}
const starts = () => (existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((l) => l.argv);
const pluginDirs = (argv: string[]) => argv.flatMap((a, i) => (a === "--plugin-dir" ? [argv[i + 1]!] : []));

let cwd: string;
let marker: string;
beforeEach(async () => {
    cwd = tempDir("native-proj-");
    marker = join(cwd, "hook-ran");
    rmSync(LOG, { force: true });
    process.env.FAKE_LOG = LOG;
    delete process.env.FAKE_SCENARIO;
    registry.saveAgentConfig("claude-code", { path: claudeBin });
    registry.saveAgentConfig("codex", { path: codexBin });
    forgetClient("claude-code");
    forgetClient("codex");
    rmSync(paths.plugins(), { recursive: true, force: true });
    rmSync(paths.userSettings(), { force: true });
    clearJsonCache();
    clearPluginCache();
    // A marketplace with a plugin that has a command, a skill and a UserPromptSubmit hook, and one with no manifest of its own.
    const mk = join(cwd, "..", `${cwd.split("/").pop()}-mk`);
    write(join(mk, ".claude-plugin", "marketplace.json"), {
        name: "demo",
        plugins: [
            { name: "fmt", source: "./fmt" },
            { name: "bare", source: "./bare", strict: false, description: "No manifest" },
        ],
    });
    write(join(mk, "fmt", ".claude-plugin", "plugin.json"), { name: "fmt", version: "1.0.0", outputStyles: "./styles" });
    write(join(mk, "fmt", "commands", "tidy.md"), "Tidy $ARGUMENTS");
    write(join(mk, "fmt", "skills", "lint", "SKILL.md"), "---\nname: lint\ndescription: Lints\n---\nLint.");
    write(join(mk, "fmt", "hooks", "hooks.json"), {
        hooks: {
            UserPromptSubmit: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }],
            SessionStart: [{ hooks: [{ type: "command", command: `touch ${marker}-start` }] }],
        },
    });
    write(join(mk, "bare", "commands", "hi.md"), "Hi");
    await addMarketplace(mk, cwd);
    await installPlugin("fmt", "user", cwd);
    await installPlugin("bare", "user", cwd);
});

async function run(provider: "claude-code" | "codex", o: { readOnly?: boolean; trusted?: boolean } = {}) {
    await runAgent(provider, o);
    return starts()[0]!.argv as string[];
}

async function runAgent(provider: "claude-code" | "codex", o: { readOnly?: boolean; trusted?: boolean } = {}) {
    if (o.trusted) trust.trustFolder(cwd);
    else trust.trustForSession(cwd);
    const settings = loadSettings(cwd, { trusted: !!o.trusted });
    const agent = new Agent({
        session: Session.create(cwd, { persist: false }),
        model: { provider, id: "default" },
        client: await clientFor(provider),
        settings: () => settings,
        // Every server the MCP manager would start, plugins' and a project's alike.
        approvedMcpServers: () => ({ cwd, servers: Object.fromEntries(Object.entries(settings.mcpServers ?? {}).map(([n, config]) => [n, { config, source: "settings" as const }])) }),
        readOnly: o.readOnly,
        checker: new PermissionChecker(() => settings, cwd),
        tools: BUILTIN_TOOLS,
        mode: { get: () => "default", set: () => {} },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        host: { emit: () => {}, ui: {}, askPermission: async () => ({ allow: true }) },
    });
    await agent.run([{ type: "text", text: "go" }], { signal: new AbortController().signal });
}
const threadMcp = () => (existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").map((l) => JSON.parse(l)) : []).find((l) => "threadMcp" in l)?.threadMcp;

describe("Claude Code loads the plugins itself", () => {
    test("each enabled plugin's folder goes to it, with a manifest naming it as Cavvy does", async () => {
        const argv = await run("claude-code");
        const installed = readInstalled();
        expect(pluginDirs(argv).sort()).toEqual([installed["bare@demo"]!.installPath, installed["fmt@demo"]!.installPath].sort());
        // Its own manifest's fields are kept (Claude Code reads ones Cavvy doesn't).
        expect(JSON.parse(readFileSync(claudeManifest(installed["fmt@demo"]!.installPath), "utf-8"))).toMatchObject({ name: "fmt", version: "1.0.0", outputStyles: "./styles" });
        // A plugin with no manifest gets one named after its marketplace entry, not its version folder.
        expect(JSON.parse(readFileSync(claudeManifest(installed["bare@demo"]!.installPath), "utf-8"))).toMatchObject({ name: "bare", description: "No manifest" });
    });

    test("Cavvy doesn't also run the plugins' hooks on a Claude Code turn", async () => {
        await run("claude-code");
        expect(existsSync(marker)).toBe(false);
    });

    test("the plugins' hooks aren't also registered with Claude Code as Cavvy's own", async () => {
        const root = readInstalled()["fmt@demo"]!.installPath;
        write(join(root, "hooks", "hooks.json"), { hooks: { PostToolUse: [{ hooks: [{ type: "prompt", prompt: "PLUGIN-PROMPT-HOOK" }] }] } });
        write(paths.userSettings(), { ...JSON.parse(readFileSync(paths.userSettings(), "utf-8")), hooks: { PostToolUse: [{ hooks: [{ type: "prompt", prompt: "MY-PROMPT-HOOK" }] }] } });
        clearJsonCache();
        clearPluginCache();
        const argv = (await run("claude-code")).join(" ");
        expect(argv).toContain("MY-PROMPT-HOOK");
        expect(argv).not.toContain("PLUGIN-PROMPT-HOOK");
    });

    test("a plugin installed before manifests were written for Claude Code gets one when it's passed", async () => {
        const root = readInstalled()["fmt@demo"]!.installPath;
        rmSync(join(root, ".claude-plugin"), { recursive: true, force: true });
        clearPluginCache();
        expect(pluginDirs(await run("claude-code"))).toContain(root);
        expect(JSON.parse(readFileSync(claudeManifest(root), "utf-8")).name).toBe("fmt");
    });

    test("a disabled plugin isn't passed; nor any to a read-only sub-agent", async () => {
        write(paths.userSettings(), { enabledPlugins: { "fmt@demo": false, "bare@demo": true } });
        clearJsonCache();
        expect(pluginDirs(await run("claude-code")).map((d) => d.includes("/fmt/"))).toEqual([false]);
        rmSync(LOG, { force: true });
        expect(pluginDirs(await run("claude-code", { readOnly: true }))).toEqual([]);
    });

    test("Codex gets none, and Cavvy runs the plugin's hooks for it", async () => {
        expect(pluginDirs(await run("codex"))).toEqual([]);
        expect(existsSync(marker)).toBe(true);
    });

    test("Codex's threads get no servers from Cavvy's plugins: it takes MCP only from its own config", async () => {
        const root = readInstalled()["fmt@demo"]!.installPath;
        write(join(root, ".mcp.json"), { mcpServers: { echo: { command: "node", args: ["x.js"] } } });
        clearPluginCache();
        await runAgent("codex");
        expect(JSON.stringify(threadMcp() ?? {})).not.toContain("echo");
    });
});

describe("session hooks", () => {
    const headless = (modelRef: string) =>
        runHeadless({ cwd, prompt: "go", trusted: false, modelRef, mode: "default", outputFormat: "json", verbose: false, allowedTools: [], disallowedTools: [], addDirs: [], startupNotes: [] });
    // SessionStart runs in the background; give it a moment.
    const started = async () => {
        for (let i = 0; i < 40 && !existsSync(`${marker}-start`); i++) await Bun.sleep(25);
        return existsSync(`${marker}-start`);
    };

    test("on Claude Code Cavvy leaves a plugin's SessionStart to it; on Codex it runs it", async () => {
        trust.trustForSession(cwd);
        await headless("claude-code:default");
        expect(await started()).toBe(false);
        await headless("codex:default");
        expect(await started()).toBe(true);
    });
});

describe("what Cavvy hands to Claude Code", () => {
    test("plugin commands and skills go to Claude Code as typed, unless it lists them without", () => {
        expect(runsPluginCommand("claude-code", "fmt:tidy", undefined)).toBe(true);
        expect(runsPluginCommand("claude-code", "fmt:tidy", new Set(["fmt:tidy"]))).toBe(true);
        expect(runsPluginCommand("claude-code", "fmt:tidy", new Set(["other"]))).toBe(false);
        expect(runsPluginCommand("codex", "fmt:tidy", undefined)).toBe(false);
        expect(runsPluginCommand("anthropic", "fmt:tidy", undefined)).toBe(false);
        expect(loadSkills(cwd, false).find((s) => s.name === "fmt:lint")).toMatchObject({ source: "plugin" });
        expect(cliRunsSkills("claude-code")).toBe(true);
    });

    test("only plugin hooks are left out, and Notification hooks stay", () => {
        const s = {
            hooks: {
                UserPromptSubmit: [{ command: "mine" }, { command: "theirs", plugin: "fmt@demo" }],
                Stop: [{ command: "theirs", plugin: "fmt@demo" }],
                Notification: [{ command: "notify", plugin: "fmt@demo" }],
            },
        };
        expect(withoutPluginHooks(s as never).hooks).toEqual({ UserPromptSubmit: [{ command: "mine" }], Notification: [{ command: "notify", plugin: "fmt@demo" }] });
        const none = { hooks: { Stop: [{ command: "mine" }] } };
        expect(withoutPluginHooks(none as never)).toBe(none as never);
    });
});
