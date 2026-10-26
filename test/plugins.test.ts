import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { loadSettings } = await import("../src/config/settings");
const { paths } = await import("../src/config/paths");
const trust = await import("../src/config/trust");
const { loadCustomCommands, pluginCommandFor } = await import("../src/commands/custom");
const { loadAgents } = await import("../src/agent/agents");
const { loadSkills } = await import("../src/agent/skills");
const { runHooks } = await import("../src/agent/hooks");
const { loadPlugins, clearPluginCache, readPlugin } = await import("../src/plugins/loader");
const { parseMarketplace, parsePluginManifest, parseSource, validName } = await import("../src/plugins/manifest");
const { parseMarketplaceSource, addMarketplace, updateMarketplace } = await import("../src/plugins/marketplaces");
const { installPlugin, uninstallPlugin, enablePlugin, updatePlugin, listPlugins, removeMarketplace, findEntry } = await import("../src/plugins/install");
const { pickVersion, checkIntegrity, swapIn, secureUrl, pruneSymlinks, fetchNpm } = await import("../src/plugins/sources");
const { runPluginCli, countsText } = await import("../src/plugins/cli");
const { reload } = await import("../src/commands/plugins");
const { runCommand } = await import("../src/commands/index");
const { claudeManifest, claudeHooks } = await import("../src/plugins/native");
const { pluginPaths, clearJsonCache, readInstalled } = await import("../src/plugins/store");

const ROOT = tempDir("cavvy-plugins-");
afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
    iso.cleanup();
});

let n = 0;
const dir = (name = "d") => {
    const d = join(ROOT, `${name}${++n}`);
    mkdirSync(d, { recursive: true });
    return d;
};
function write(file: string, data: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
}
const readJ = (f: string) => JSON.parse(readFileSync(f, "utf-8"));

/** A plugin folder with one of everything. */
function makePlugin(root: string, name: string, o: { version?: string; manifestDir?: string; noManifest?: boolean } = {}) {
    if (!o.noManifest) write(join(root, o.manifestDir ?? ".claude-plugin", "plugin.json"), { name, version: o.version ?? "1.0.0", description: `${name} plugin` });
    write(join(root, "commands", "fmt.md"), "---\ndescription: Format files\n---\nFormat $ARGUMENTS");
    write(join(root, "commands", "git", "pr.md"), "Open a PR");
    write(join(root, "agents", "checker.md"), "---\nname: checker\ndescription: Checks\n---\nYou check.");
    write(join(root, "skills", "tidy", "SKILL.md"), "---\nname: tidy\n---\nTidy.");
    write(join(root, "hooks", "hooks.json"), { hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: 'printf %s "$CLAUDE_PLUGIN_ROOT" > "$OUT"', timeout: 5 }] }] } });
    write(join(root, ".mcp.json"), { mcpServers: { echo: { command: "${CLAUDE_PLUGIN_ROOT}/bin/server", args: ["--root=${CAVVY_PLUGIN_ROOT}"], env: { X: "1" } } } });
}

/** A marketplace folder holding plugins under plugins/<name>. */
function makeMarket(name: string, plugins: { name: string; source?: unknown; version?: string; extra?: Record<string, unknown> }[], o: { make?: boolean } = {}) {
    const root = dir("market");
    for (const p of plugins) if (o.make !== false && !p.source) makePlugin(join(root, "plugins", p.name), p.name, { version: p.version });
    write(join(root, ".claude-plugin", "marketplace.json"), { name, owner: { name: "Test" }, plugins: plugins.map((p) => ({ name: p.name, source: p.source ?? `./plugins/${p.name}`, description: `${p.name} from ${name}`, ...p.extra })) });
    return root;
}

function git(cwd: string, ...args: string[]) {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
}
function commitAll(repo: string, msg = "c") {
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", msg);
    return git(repo, "rev-parse", "HEAD");
}

beforeEach(() => {
    rmSync(iso.home, { recursive: true, force: true });
    mkdirSync(iso.home, { recursive: true });
    clearJsonCache();
    clearPluginCache();
});

describe("manifests", () => {
    test("names are folder- and command-safe", () => {
        for (const ok of ["fmt", "my-plugin", "a1_b"]) expect(validName(ok)).toBe(true);
        for (const bad of ["", "../x", "a/b", "A", ".x", "-x", "a b", "a.b", "x".repeat(65), 5]) expect(validName(bad)).toBe(false);
    });

    test("plugin.json: fields, lists, author string, bad name", () => {
        const m = parsePluginManifest({ name: "x", version: "2", author: "Ann", commands: "./extra", keywords: ["a", 1], hooks: { Stop: [] } }, "fallback");
        expect(m).toMatchObject({ name: "x", version: "2", author: { name: "Ann" }, commands: ["./extra"], keywords: ["a"] });
        expect(parsePluginManifest({}, "fallback").name).toBe("fallback");
        expect(() => parsePluginManifest({ name: "../evil" }, "f")).toThrow(/isn't valid/);
        expect(() => parsePluginManifest([], "f")).toThrow(/object/);
    });

    test("sources: every form, bad ones refused", () => {
        expect(parseSource("./p")).toEqual({ source: "path", path: "./p" });
        expect(parseSource({ source: "github", repo: "o/r", ref: "v1" })).toEqual({ source: "github", repo: "o/r", ref: "v1" });
        expect(parseSource({ source: "url", url: "https://x/y.git" })).toEqual({ source: "git", url: "https://x/y.git" });
        expect(parseSource({ source: "git-subdir", url: "https://x/y.git", path: "plugins/a" })).toMatchObject({ source: "git", path: "plugins/a" });
        expect(parseSource({ source: "npm", package: "@s/p", version: "^1" })).toEqual({ source: "npm", package: "@s/p", version: "^1" });
        expect(() => parseSource({ source: "github", repo: "nope" })).toThrow();
        expect(() => parseSource({ source: "url", url: "--upload-pack=x" })).toThrow();
        expect(() => parseSource({ source: "github", repo: "o/r", ref: "--evil" })).toThrow();
        expect(() => parseSource({ source: "github", repo: "o/r", sha: "zz" })).toThrow();
        expect(() => parseSource({ source: "npm", package: "Bad Name" })).toThrow();
        expect(() => parseSource({ source: "npm", package: "p", registry: "http://registry.example.com" })).toThrow(/https/);
        expect(parseSource({ source: "npm", package: "p", registry: "http://localhost:4873" })).toMatchObject({ registry: "http://localhost:4873" });
        expect(() => parseSource({ source: "ftp" })).toThrow(/unknown source/);
    });

    test("marketplace.json: bad entries dropped with reasons, the rest kept", () => {
        const m = parseMarketplace({ name: "m", plugins: [{ name: "ok", source: "./ok" }, { name: "Bad!", source: "./b" }, { name: "nosrc" }, { name: "ok", source: "./dup" }, 7] });
        expect(m.plugins.map((p) => p.name)).toEqual(["ok"]);
        expect(m.errors.length).toBe(4);
        expect(() => parseMarketplace({ name: "Bad Name", plugins: [] })).toThrow();
    });

    test("marketplace source strings", () => {
        const cwd = dir();
        write(join(cwd, "mk", ".claude-plugin", "marketplace.json"), { name: "m", plugins: [] });
        expect(parseMarketplaceSource("owner/repo", cwd)).toEqual({ source: "github", repo: "owner/repo" });
        expect(parseMarketplaceSource("owner/repo#v2", cwd)).toEqual({ source: "github", repo: "owner/repo", ref: "v2" });
        expect(parseMarketplaceSource("https://git.example.com/a/b.git", cwd)).toEqual({ source: "git", url: "https://git.example.com/a/b.git" });
        expect(parseMarketplaceSource("git@github.com:a/b.git#dev", cwd)).toEqual({ source: "git", url: "git@github.com:a/b.git", ref: "dev" });
        expect(parseMarketplaceSource("https://example.com/marketplace.json", cwd)).toEqual({ source: "url", url: "https://example.com/marketplace.json" });
        expect(parseMarketplaceSource("./mk", cwd)).toEqual({ source: "directory", path: join(cwd, "mk") });
        expect(parseMarketplaceSource("./mk/.claude-plugin/marketplace.json", cwd)).toEqual({ source: "file", path: join(cwd, "mk", ".claude-plugin", "marketplace.json") });
        expect(() => parseMarketplaceSource("./missing", cwd)).toThrow(/doesn't exist/);
        expect(() => parseMarketplaceSource("", cwd)).toThrow();
        expect(() => parseMarketplaceSource("not a source", cwd)).toThrow(/isn't a marketplace source/);
        expect(() => parseMarketplaceSource("o/r#--x", cwd)).toThrow();
    });
});

describe("loading", () => {
    test("one of everything, in both manifest folders; Cavvy's wins", () => {
        const a = dir("plug");
        makePlugin(a, "a");
        write(join(a, ".cavvy-plugin", "plugin.json"), { name: "a", version: "9.9.9", description: "ours" });
        const p = readPlugin(a, { id: "a@m", name: "a", marketplace: "m", version: "9.9.9" });
        expect(p.errors).toEqual([]);
        expect(p.manifest.description).toBe("ours");
        expect(p.hooks.PostToolUse).toEqual([{ matcher: "Edit|Write", type: "command", command: 'printf %s "$CLAUDE_PLUGIN_ROOT" > "$OUT"', timeout: 5, plugin: "a@m", pluginRoot: a }]);
        expect(p.mcpServers["plugin:a:echo"]).toEqual({ command: `${a}/bin/server`, args: [`--root=${a}`], env: { X: "1" }, cwd: a, plugin: "a@m" });
    });

    test("flat hooks, inline manifest hooks and servers, and every hook type", () => {
        const a = dir("plug");
        write(join(a, "plugin-hooks.json"), { Stop: [{ command: "echo stop" }] });
        write(join(a, ".claude-plugin", "plugin.json"), { name: "a", hooks: "./plugin-hooks.json", mcpServers: { web: { url: "https://x/mcp" } } });
        write(join(a, "hooks", "hooks.json"), { hooks: { PreToolUse: [{ hooks: [{ type: "http", url: "https://x" }, { type: "command", command: "echo pre" }] }] } });
        const p = readPlugin(a, { id: "a@m", name: "a", marketplace: "m", version: "1" });
        expect(p.hooks.Stop?.[0]?.command).toBe("echo stop");
        // Every hook type Cavvy runs loads, as on Claude Code.
        expect(p.hooks.PreToolUse?.map((h) => h.type ?? "command")).toEqual(["http", "command"]);
        expect(p.errors).toEqual([]);
        expect(p.mcpServers["plugin:a:web"]).toEqual({ url: "https://x/mcp", plugin: "a@m" });
    });

    test("broken files are reported and the rest still loads", () => {
        const a = dir("plug");
        makePlugin(a, "a");
        write(join(a, ".claude-plugin", "plugin.json"), "{ not json");
        write(join(a, ".mcp.json"), { mcpServers: { bad: { args: [] } } });
        const p = readPlugin(a, { id: "a@m", name: "a", marketplace: "m", version: "1" });
        expect(p.errors.some((e) => /isn't valid JSON/.test(e))).toBe(true);
        expect(p.errors.some((e) => /needs a "command" or a "url"/.test(e))).toBe(true);
        expect(p.hooks.PostToolUse?.length).toBe(1);
    });

    test("manifest paths outside the plugin, absolute or through a symlink, are ignored", () => {
        const a = dir("plug");
        const outside = dir("outside");
        write(join(outside, "x.md"), "secret");
        symlinkSync(outside, join(a, "link"));
        write(join(a, ".claude-plugin", "plugin.json"), { name: "a", commands: ["../outside", "/etc", "./link", "./mine"], hooks: "../h.json" });
        const p = readPlugin(a, { id: "a@m", name: "a", marketplace: "m", version: "1" });
        expect(p.commandPaths).toEqual([join(a, "commands"), join(a, "mine")]);
        expect(p.errors.filter((e) => /outside the plugin/.test(e)).length).toBe(4);
    });

    test("skills: folders of skills and single skill folders; language servers", () => {
        const a = dir("plug");
        write(join(a, "skills", "one", "SKILL.md"), "one");
        write(join(a, "solo", "SKILL.md"), "solo");
        write(join(a, "more", "two", "SKILL.md"), "two");
        write(join(a, ".claude-plugin", "plugin.json"), { name: "a", skills: ["./solo", "./more"], lspServers: { clangd: { command: "clangd", args: ["--root=${CLAUDE_PLUGIN_ROOT}"] } } });
        const p = readPlugin(a, { id: "a@m", name: "a", marketplace: "m", version: "1" });
        expect(p.skillDirs).toEqual([join(a, "skills"), join(a, "more")]);
        expect(p.skillFolders).toEqual([join(a, "solo")]);
        expect(p.lspServers).toEqual({ clangd: { command: "clangd", args: [`--root=${a}`] } });
    });

    test("a missing install folder is an error, not a crash", () => {
        const p = readPlugin(join(ROOT, "gone"), { id: "a@m", name: "a", marketplace: "m", version: "1" });
        expect(p.errors[0]).toMatch(/is missing/);
    });

    test("cache: an unchanged plugin isn't parsed again; a change is seen", async () => {
        const a = dir("plug");
        makePlugin(a, "a");
        const who = { id: "a@m", name: "a", marketplace: "m", version: "1" };
        const first = readPlugin(a, who);
        expect(readPlugin(a, who)).toBe(first);
        await Bun.sleep(5);
        write(join(a, ".mcp.json"), { mcpServers: {} });
        expect(readPlugin(a, who).mcpServers).toEqual({});
    });
});

describe("install, scopes and settings", () => {
    test("install from a folder marketplace: commands, agents, hooks and MCP servers load", async () => {
        const cwd = dir("proj");
        const mk = makeMarket("demo", [{ name: "fmt" }]);
        const m = await addMarketplace(mk, cwd);
        expect(m.plugins.map((p) => p.name)).toEqual(["fmt"]);
        const r = await installPlugin("fmt", "user", cwd);
        expect(r).toMatchObject({ id: "fmt@demo", version: "1.0.0", reused: false, counts: { commands: 2, agents: 1, skills: 1, hooks: 1, mcpServers: 1 } });
        expect(readJ(paths.userSettings()).enabledPlugins).toEqual({ "fmt@demo": true });
        const installPath = readInstalled()["fmt@demo"]!.installPath;
        expect(installPath).toBe(join(pluginPaths.cache(), "demo", "fmt", "1.0.0"));
        // A copy: editing the marketplace doesn't change the installed plugin.
        expect(existsSync(join(installPath, "commands", "fmt.md"))).toBe(true);

        const s = loadSettings(cwd, { trusted: false });
        expect(s.hooks?.PostToolUse?.[0]).toMatchObject({ plugin: "fmt@demo", pluginRoot: installPath });
        expect(s.mcpServers?.["plugin:fmt:echo"]?.command).toBe(`${installPath}/bin/server`);
        const cmds = loadCustomCommands(cwd, false);
        expect(cmds.filter((c) => c.source === "plugin").map((c) => c.name)).toEqual(["fmt:fmt", "fmt:git:pr"]);
        expect(pluginCommandFor(cmds, "fmt")?.name).toBe("fmt:fmt");
        expect(pluginCommandFor(cmds, "pr")).toBeUndefined(); // nested commands need their full name
        expect(loadAgents(cwd).find((a) => a.name === "fmt:checker")).toMatchObject({ source: "plugin", prompt: "You check." });
        expect(loadPlugins(cwd, false)[0]!.skillDirs).toEqual([join(installPath, "skills")]);
        expect(loadSkills(cwd, false).find((k) => k.name === "fmt:tidy")).toMatchObject({ source: "plugin" });
    });

    test("plugin agents use the full definition format, without hooks, servers or a permission mode", async () => {
        const cwd = dir("proj");
        const mk = makeMarket("demo", [{ name: "fmt" }]);
        write(join(mk, "plugins", "fmt", "agents", "rich.md"), "---\nname: rich\ndescription: Rich\ntools: [Read, Grep]\neffort: high\nmaxTurns: 7\npermissionMode: acceptEdits\nmcpServers:\n  - github\n---\nRich prompt.");
        await addMarketplace(mk, cwd);
        await installPlugin("fmt", "user", cwd);
        const a = loadAgents(cwd).find((x) => x.name === "fmt:rich")!;
        expect(a).toMatchObject({ source: "plugin", tools: ["Read", "Grep"], effort: "high", maxTurns: 7, prompt: "Rich prompt." });
        expect(a.permissionMode).toBeUndefined();
        expect(a.mcpServers).toBeUndefined();
        expect(a.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/mcpServers are ignored/), expect.stringMatching(/permissionMode is ignored/)]));
    });

    test("single skill folders load under the plugin's name; untrusted folders still get user-scope plugin skills", async () => {
        const cwd = dir("proj");
        const mk = makeMarket("demo", [{ name: "solo", extra: { skills: ["./lint"] } }], { make: false });
        write(join(mk, "plugins", "solo", "lint", "SKILL.md"), "---\nname: lint\ndescription: Lints\n---\nLint it.");
        await addMarketplace(mk, cwd);
        await installPlugin("solo", "user", cwd);
        expect(loadSkills(cwd, false).find((k) => k.name === "solo:lint")).toMatchObject({ source: "plugin", description: "Lints" });
    });

    test("plugin hooks run with the plugin root in their environment", async () => {
        const cwd = dir("proj");
        await addMarketplace(makeMarket("demo", [{ name: "fmt" }]), cwd);
        await installPlugin("fmt@demo", "user", cwd);
        const out = join(dir(), "out.txt");
        process.env.OUT = out;
        try {
            const r = await runHooks(loadSettings(cwd, { trusted: false }), "PostToolUse", { tool_name: "Edit" }, cwd);
            expect(r.errors).toEqual([]);
        } finally {
            delete process.env.OUT;
        }
        expect(readFileSync(out, "utf-8")).toBe(readInstalled()["fmt@demo"]!.installPath);
    });

    test("a plugin server never replaces the user's own server of that name", async () => {
        const cwd = dir("proj");
        await addMarketplace(makeMarket("demo", [{ name: "fmt" }]), cwd);
        await installPlugin("fmt", "user", cwd);
        const u = readJ(paths.userSettings());
        u.mcpServers = { "plugin:fmt:echo": { command: "mine" } };
        write(paths.userSettings(), u);
        expect(loadSettings(cwd, { trusted: false }).mcpServers?.["plugin:fmt:echo"]?.command).toBe("mine");
    });

    test("a plugin's language servers join lsp.servers, after the user's own and never over them", async () => {
        const { lspServers, serverFor } = await import("../src/lsp/config");
        const cwd = dir("proj");
        const mk = makeMarket("demo", [{ name: "lsp", extra: { strict: false, lspServers: { gopls: { command: "${CLAUDE_PLUGIN_ROOT}/bin/gopls", extensionToLanguage: { ".go": "go" } }, deno: { command: "deno", args: ["lsp"], extensionToLanguage: { ".ts": "typescript" } } } } }], { make: false });
        mkdirSync(join(mk, "plugins", "lsp"), { recursive: true });
        await addMarketplace(mk, cwd);
        await installPlugin("lsp", "user", cwd);
        const root = readInstalled()["lsp@demo"]!.installPath;
        const u = readJ(paths.userSettings());
        write(paths.userSettings(), { ...u, lsp: { servers: { mine: { command: "mine", extensionToLanguage: { ".x": "x" } }, "plugin:lsp@demo:deno": { command: "deno", disabled: true, extensionToLanguage: { ".ts": "typescript" } } } } });
        const s = loadSettings(cwd, { trusted: false });
        expect(Object.keys((s.lsp as any).servers)).toEqual(["mine", "plugin:lsp@demo:deno", "plugin:lsp@demo:gopls"]);
        const servers = lspServers(s);
        expect(servers.find((x) => x.name === "plugin:lsp@demo:gopls")).toMatchObject({ command: `${root}/bin/gopls`, builtin: false });
        // The user's entry under that name wins (here: turning it off), and the built-in gopls stays behind the plugin's.
        expect(servers.some((x) => x.name === "plugin:lsp@demo:deno")).toBe(false);
        expect(serverFor(join(cwd, "a.go"), servers, () => true)?.server.name).toBe("plugin:lsp@demo:gopls");
        write(paths.userSettings(), { ...u, lsp: false });
        expect(loadSettings(cwd, { trusted: false }).lsp).toBe(false);
    });

    test("same-named plugins from two marketplaces each get their language server", async () => {
        const { lspServers } = await import("../src/lsp/config");
        const cwd = dir("proj");
        for (const market of ["a", "b"]) {
            const mk = makeMarket(market, [{ name: "fmt", extra: { strict: false, lspServers: { lang: { command: `${market}-ls`, extensionToLanguage: { ".go": "go" } } } } }], { make: false });
            mkdirSync(join(mk, "plugins", "fmt"), { recursive: true });
            await addMarketplace(mk, cwd);
            await installPlugin(`fmt@${market}`, "user", cwd);
        }
        const servers = lspServers(loadSettings(cwd, { trusted: false })).filter((x) => x.name.startsWith("plugin:"));
        expect(servers.map((x) => [x.name, x.command])).toEqual([["plugin:fmt@a:lang", "a-ls"], ["plugin:fmt@b:lang", "b-ls"]]);
    });

    test("project and local scopes: only in trusted folders; later scope wins", async () => {
        const cwd = dir("proj");
        await addMarketplace(makeMarket("demo", [{ name: "fmt" }]), cwd);
        await installPlugin("fmt", "project", cwd);
        expect(readJ(paths.projectSettings(cwd)).enabledPlugins).toEqual({ "fmt@demo": true });
        expect(loadPlugins(cwd, true).map((p) => p.id)).toEqual(["fmt@demo"]);
        expect(loadPlugins(cwd, false)).toEqual([]);
        expect(loadSettings(cwd, { trusted: false }).mcpServers?.["plugin:fmt:echo"]).toBeUndefined();
        // Local turns it off for just this user.
        enablePlugin("fmt", false, cwd, true, "local");
        expect(loadPlugins(cwd, true)).toEqual([]);
        expect(listPlugins(cwd, true).plugins[0]).toMatchObject({ enabled: false, scopes: { project: true, local: false } });
        // Enable without a scope: the narrowest scope that sets it.
        expect(enablePlugin("fmt", true, cwd, true)).toEqual({ id: "fmt@demo", scope: "local" });
        expect(() => enablePlugin("fmt", true, cwd, false, "project")).toThrow(/isn't trusted/);
    });

    test("installing again at another scope reuses the download", async () => {
        const cwd = dir("proj");
        await addMarketplace(makeMarket("demo", [{ name: "fmt" }]), cwd);
        await installPlugin("fmt", "user", cwd);
        const r = await installPlugin("fmt", "local", cwd);
        expect(r.reused).toBe(true);
        expect(readInstalled()["fmt@demo"]!.scopes).toEqual([{ scope: "user" }, { scope: "local", projectPath: cwd }]);
    });

    test("uninstall: one scope keeps the files, the last one removes them", async () => {
        const cwd = dir("proj");
        await addMarketplace(makeMarket("demo", [{ name: "fmt" }]), cwd);
        await installPlugin("fmt", "user", cwd);
        await installPlugin("fmt", "local", cwd);
        const path = readInstalled()["fmt@demo"]!.installPath;
        expect(uninstallPlugin("fmt", cwd, true, "local")).toEqual({ id: "fmt@demo", scopes: ["local"], removed: false });
        expect(existsSync(path)).toBe(true);
        expect(readJ(paths.localSettings(cwd)).enabledPlugins).toBeUndefined();
        expect(uninstallPlugin("fmt", cwd, true)).toEqual({ id: "fmt@demo", scopes: ["user"], removed: true });
        expect(existsSync(path)).toBe(false);
        expect(existsSync(join(pluginPaths.cache(), "demo"))).toBe(false);
        expect(readInstalled()).toEqual({});
    });

    test("a disabled plugin adds nothing", async () => {
        const cwd = dir("proj");
        await addMarketplace(makeMarket("demo", [{ name: "fmt" }]), cwd);
        await installPlugin("fmt", "user", cwd);
        enablePlugin("fmt", false, cwd, false);
        expect(loadSettings(cwd, { trusted: false }).hooks).toBeUndefined();
        expect(loadCustomCommands(cwd, false).some((c) => c.source === "plugin")).toBe(false);
        expect(loadAgents(cwd).some((a) => a.source === "plugin")).toBe(false);
    });

    test("on in settings but not installed: listed as missing, nothing breaks", () => {
        const cwd = dir("proj");
        write(paths.projectSettings(cwd), { enabledPlugins: { "team-tool@corp": true } });
        expect(loadSettings(cwd, { trusted: true }).enabledPlugins).toEqual({ "team-tool@corp": true });
        expect(loadPlugins(cwd, true)).toEqual([]);
        expect(listPlugins(cwd, true).plugins).toEqual([expect.objectContaining({ id: "team-tool@corp", missing: true, enabled: true })]);
        expect(() => enablePlugin("team-tool@corp", true, cwd, true)).toThrow(/isn't installed/);
        // It can still be turned off.
        expect(enablePlugin("team-tool", false, cwd, true)).toEqual({ id: "team-tool@corp", scope: "project" });
    });

    test("ambiguous and unknown names", async () => {
        const cwd = dir("proj");
        expect(() => findEntry("x")).toThrow(/No marketplaces are added/);
        await addMarketplace(makeMarket("one", [{ name: "fmt" }]), cwd);
        await addMarketplace(makeMarket("two", [{ name: "fmt" }]), cwd);
        expect(() => findEntry("fmt")).toThrow(/fmt@one, fmt@two/);
        expect(() => findEntry("nope")).toThrow(/No marketplace has a plugin named "nope"/);
        expect(() => findEntry("nope@one")).toThrow(/It has: fmt/);
        expect(() => findEntry("fmt@three")).toThrow(/Added: one, two/);
        await installPlugin("fmt@one", "user", cwd);
        await installPlugin("fmt@two", "user", cwd);
        expect(() => uninstallPlugin("fmt", cwd, false)).toThrow(/fmt@one, fmt@two/);
    });

    test("a relative source outside the marketplace is refused, and nothing is left behind", async () => {
        const cwd = dir("proj");
        const mk = makeMarket("demo", [{ name: "evil", source: "../" }], { make: false });
        await addMarketplace(mk, cwd);
        await expect(installPlugin("evil", "user", cwd)).rejects.toThrow(/outside its marketplace/);
        expect(readInstalled()).toEqual({});
        expect(existsSync(paths.userSettings())).toBe(false);
    });

    test("a symlinked manifest can't make the install write outside the plugin", async () => {
        const cwd = dir("proj");
        write(paths.userSettings(), { model: "keep:me" });
        const mk = makeMarket("demo", [{ name: "evil", extra: { hooks: { SessionStart: [{ command: "echo pwned" }] } } }]);
        const p = join(mk, "plugins", "evil");
        mkdirSync(join(p, ".cavvy-plugin"), { recursive: true });
        symlinkSync(paths.userSettings(), join(p, ".cavvy-plugin", "plugin.json"));
        symlinkSync(ROOT, join(p, "commands", "escape"));
        await addMarketplace(mk, cwd);
        await installPlugin("evil", "user", cwd);
        expect(readJ(paths.userSettings())).toEqual({ model: "keep:me", enabledPlugins: { "evil@demo": true } });
        const installed = readInstalled()["evil@demo"]!.installPath;
        expect(existsSync(join(installed, "commands", "escape"))).toBe(false);
        expect(readJ(join(installed, ".cavvy-plugin", "plugin.json")).name).toBe("evil");
    });

    test("a pluginRoot outside the marketplace is ignored", async () => {
        const cwd = dir("proj");
        const mk = makeMarket("demo", [{ name: "x", source: "./" }], { make: false });
        const outside = dir("outside");
        write(join(outside, "commands", "b.md"), "stolen");
        const j = readJ(join(mk, ".claude-plugin", "marketplace.json"));
        j.metadata = { pluginRoot: `../${outside.split("/").at(-1)}` };
        write(join(mk, ".claude-plugin", "marketplace.json"), j);
        const m = await addMarketplace(mk, cwd);
        expect(m.errors.join()).toMatch(/pluginRoot .* is outside the marketplace/);
        // "./" is then the marketplace itself, which has no plugin parts.
        await expect(installPlugin("x", "user", cwd)).rejects.toThrow(/has no commands/);
    });

    test("uninstalling at a project scope needs a trusted folder", async () => {
        const cwd = dir("proj");
        await addMarketplace(makeMarket("demo", [{ name: "fmt" }]), cwd);
        await installPlugin("fmt", "local", cwd);
        expect(() => uninstallPlugin("fmt", cwd, false, "local")).toThrow(/isn't trusted/);
        expect(existsSync(readInstalled()["fmt@demo"]!.installPath)).toBe(true);
    });

    test("a plugin with nothing in it isn't installed", async () => {
        const cwd = dir("proj");
        const mk = makeMarket("demo", [{ name: "empty" }], { make: false });
        write(join(mk, "plugins", "empty", "README.md"), "hi");
        await addMarketplace(mk, cwd);
        await expect(installPlugin("empty", "user", cwd)).rejects.toThrow(/has no commands, agents/);
    });

    test("a manifest agent or command path that isn't a folder or .md file is reported, and every other agent still loads", async () => {
        const cwd = dir("proj");
        const mk = makeMarket("demo", [{ name: "bad", extra: { agents: ["./config.json"], commands: ["./config.json"] } }]);
        write(join(mk, "plugins", "bad", "config.json"), { not: "an agent" });
        write(join(paths.userAgents(), "mine.md"), "---\ndescription: Mine\n---\nMine.");
        await addMarketplace(mk, cwd);
        const r = await installPlugin("bad", "user", cwd);
        expect(r.errors).toEqual(expect.arrayContaining([expect.stringMatching(/agents path "\.\/config\.json" isn't a folder or \.md file/), expect.stringMatching(/commands path "\.\/config\.json" isn't a folder or \.md file/)]));
        const names = loadAgents(cwd).map((a) => a.name);
        expect(names).toEqual(expect.arrayContaining(["bad:checker", "mine", "general-purpose"]));
        expect(loadCustomCommands(cwd, false).filter((c) => c.source === "plugin").map((c) => c.name)).toEqual(["bad:fmt", "bad:git:pr"]);
    });

    test("strict: false marketplace entries supply the manifest", async () => {
        const cwd = dir("proj");
        const mk = makeMarket("demo", [{ name: "lite", version: "3.1.0", extra: { strict: false, version: "3.1.0", commands: ["./cmds"] } }], { make: false });
        write(join(mk, "plugins", "lite", "cmds", "hello.md"), "Hello");
        await addMarketplace(mk, cwd);
        const r = await installPlugin("lite", "user", cwd);
        expect(r).toMatchObject({ version: "3.1.0", counts: { commands: 1 } });
        expect(loadCustomCommands(cwd, false).map((c) => c.name)).toContain("lite:hello");
    });

    test("a plugin with only language servers or only skills installs", async () => {
        const cwd = dir("proj");
        const mk = makeMarket("demo", [{ name: "lsp", extra: { strict: false, lspServers: { gopls: { command: "gopls" } } } }, { name: "skills", extra: { strict: false, skills: ["./a"] } }], { make: false });
        mkdirSync(join(mk, "plugins", "lsp"), { recursive: true });
        write(join(mk, "plugins", "skills", "a", "SKILL.md"), "a");
        await addMarketplace(mk, cwd);
        expect((await installPlugin("lsp", "user", cwd)).counts.lspServers).toBe(1);
        expect((await installPlugin("skills", "user", cwd)).counts.skills).toBe(1);
        // A plugin from a folder marketplace that gives no version.
        expect(readInstalled()["lsp@demo"]!.version).toBe("local");
    });

    test("a plugin whose only hooks are prompt or http hooks installs, and Cavvy runs them", async () => {
        const cwd = dir("proj");
        const mk = makeMarket("demo", [{ name: "guard", source: "./guard" }], { make: false });
        write(join(mk, "guard", "hooks", "hooks.json"), { hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "Done?" }] }], PreToolUse: [{ hooks: [{ type: "http", url: "https://x" }] }] } });
        await addMarketplace(mk, cwd);
        const r = await runPluginCli(["install", "guard"], cwd, false);
        expect(r.ok).toBe(true);
        expect(r.lines[1]).toBe("  2 hooks");
        // Cavvy runs them too (src/config/hook-config.ts).
        const hooks = loadSettings(cwd, { trusted: false }).hooks ?? {};
        expect([hooks.Stop?.[0]?.type, hooks.PreToolUse?.[0]?.type]).toEqual(["prompt", "http"]);
        expect(countsText({ commands: 1, agents: 0, skills: 0, hooks: 3, mcpServers: 0, lspServers: 1 })).toBe("1 command, 3 hooks, 1 language server");
    });

    test("a broken settings file at the target scope stops the install before anything is fetched", async () => {
        const cwd = dir("proj");
        await addMarketplace(makeMarket("demo", [{ name: "fmt" }]), cwd);
        write(paths.userSettings(), "{ broken");
        await expect(installPlugin("fmt", "user", cwd)).rejects.toThrow(/isn't valid JSON/);
        expect(readFileSync(paths.userSettings(), "utf-8")).toBe("{ broken");
        expect(readInstalled()).toEqual({});
    });

    test("removing a marketplace clears its plugins for you and this folder, not other folders' settings", async () => {
        const here = dir("proj");
        const there = dir("proj");
        trust.trustFolder(here);
        trust.trustFolder(there);
        await addMarketplace(makeMarket("demo", [{ name: "fmt" }]), here);
        await installPlugin("fmt", "project", there);
        await installPlugin("fmt", "local", here);
        removeMarketplace("demo", here);
        expect(readJ(join(here, ".cavvy", "settings.local.json")).enabledPlugins).toBeUndefined();
        // Left as it is (often committed); a plugin that isn't installed loads nothing.
        expect(readJ(join(there, ".cavvy", "settings.json")).enabledPlugins).toEqual({ "fmt@demo": true });
        clearPluginCache();
        expect(loadPlugins(there, true)).toEqual([]);
    });

    test("removing a marketplace uninstalls its plugins", async () => {
        const cwd = dir("proj");
        const mk = makeMarket("demo", [{ name: "fmt" }]);
        await addMarketplace(mk, cwd);
        await installPlugin("fmt", "user", cwd);
        expect(removeMarketplace("demo", cwd)).toEqual({ uninstalled: ["fmt@demo"] });
        expect(readInstalled()).toEqual({});
        expect(readJ(paths.userSettings()).enabledPlugins).toBeUndefined();
        // A marketplace read in place is never deleted.
        expect(existsSync(join(mk, ".claude-plugin", "marketplace.json"))).toBe(true);
    });

    test("the same marketplace name from another source is refused", async () => {
        const cwd = dir("proj");
        await addMarketplace(makeMarket("demo", []), cwd);
        await expect(addMarketplace(makeMarket("demo", []), cwd)).rejects.toThrow(/already added/);
    });
});

describe("git sources", () => {
    test("a git marketplace: add, install, update to a new version", async () => {
        const cwd = dir("proj");
        const repo = makeMarket("gitmk", [{ name: "fmt", version: "1.0.0" }]);
        git(repo, "init", "-q");
        commitAll(repo);
        const m = await addMarketplace(`file://${repo}`, cwd);
        expect(m.known.installLocation).toBe(join(pluginPaths.marketplaces(), "gitmk"));
        expect(existsSync(join(m.known.installLocation, ".git"))).toBe(false);
        await installPlugin("fmt", "user", cwd);
        expect(readInstalled()["fmt@gitmk"]!.version).toBe("1.0.0");

        write(join(repo, "plugins", "fmt", ".claude-plugin", "plugin.json"), { name: "fmt", version: "1.1.0" });
        commitAll(repo, "bump");
        const r = await updatePlugin("fmt", cwd, false);
        expect(r).toMatchObject({ from: "1.0.0", to: "1.1.0", changed: true });
        expect(readInstalled()["fmt@gitmk"]!.installPath).toMatch(/1\.1\.0$/);
        expect(existsSync(join(pluginPaths.cache(), "gitmk", "fmt", "1.0.0"))).toBe(false);
        expect(readInstalled()["fmt@gitmk"]!.scopes).toEqual([{ scope: "user" }]);
        expect((await updateMarketplace("gitmk")).plugins.length).toBe(1);
        // Without a version of its own, a plugin in a git marketplace is versioned by the marketplace's commit.
        write(join(repo, "plugins", "fmt", ".claude-plugin", "plugin.json"), { name: "fmt" });
        const sha = commitAll(repo, "unversion");
        expect(await updatePlugin("fmt", cwd, false)).toMatchObject({ to: sha.slice(0, 12), changed: true });
    });

    test("plugins from a git URL, a pinned sha and a subfolder", async () => {
        const cwd = dir("proj");
        const prepo = dir("prepo");
        makePlugin(prepo, "remote", { noManifest: true });
        git(prepo, "init", "-q");
        const first = commitAll(prepo);
        makePlugin(join(prepo, "sub", "inner"), "inner", { version: "0.2.0" });
        commitAll(prepo, "second");
        const mk = makeMarket("demo", [
            { name: "remote", source: { source: "url", url: `file://${prepo}` } },
            { name: "pinned", source: { source: "url", url: `file://${prepo}`, sha: first } },
            { name: "inner", source: { source: "git-subdir", url: `file://${prepo}`, path: "sub/inner" } },
            { name: "outside", source: { source: "git-subdir", url: `file://${prepo}`, path: "../../" } },
        ]);
        await addMarketplace(mk, cwd);
        const remote = await installPlugin("remote", "user", cwd);
        expect(remote.version).toMatch(/^[0-9a-f]{12}$/); // no version anywhere: the commit
        const pinned = await installPlugin("pinned", "user", cwd);
        expect(pinned.version).toBe(first.slice(0, 12));
        expect(existsSync(join(readInstalled()["pinned@demo"]!.installPath, "sub"))).toBe(false);
        expect((await installPlugin("inner", "user", cwd)).version).toBe("0.2.0");
        await expect(installPlugin("outside", "user", cwd)).rejects.toThrow(/isn't a folder in/);
    });

    test("a git failure is a clear error and leaves nothing", async () => {
        const cwd = dir("proj");
        await addMarketplace(makeMarket("demo", [{ name: "x", source: { source: "url", url: `file://${join(ROOT, "no-such-repo")}` } }], { make: false }), cwd);
        await expect(installPlugin("x", "user", cwd)).rejects.toThrow(/Couldn't fetch x from/);
        await expect(addMarketplace(`file://${join(ROOT, "nope")}.git`, cwd)).rejects.toThrow();
        expect(readInstalled()).toEqual({});
        const leftovers = existsSync(pluginPaths.cache()) ? Bun.spawnSync(["ls", "-A", pluginPaths.cache()]).stdout.toString().trim() : "";
        expect(leftovers).toBe("");
    });
});

describe("npm sources", () => {
    async function registry(pkgDir: string, versions: string[], o: { corrupt?: boolean } = {}) {
        const tgz = join(dir("tgz"), "p.tgz");
        // npm's layout: everything under package/.
        const stage = dir("stage");
        Bun.spawnSync(["cp", "-R", pkgDir, join(stage, "package")]);
        Bun.spawnSync(["tar", "-czf", tgz, "-C", stage, "package"]);
        const data = readFileSync(tgz);
        const integrity = `sha512-${createHash("sha512").update(o.corrupt ? Buffer.from("x") : data).digest("base64")}`;
        const server = Bun.serve({
            port: 0,
            fetch(req) {
                const u = new URL(req.url);
                if (u.pathname === "/@acme%2fplug" || u.pathname === "/@acme%2Fplug")
                    return Response.json({ "dist-tags": { latest: versions.at(-1) }, versions: Object.fromEntries(versions.map((v) => [v, { version: v, dist: { tarball: `${u.origin}/t/${v}.tgz`, integrity } }])) });
                if (u.pathname.startsWith("/t/")) return new Response(data);
                return new Response("nope", { status: 404 });
            },
        });
        return server;
    }

    test("installs the highest version a range allows, checking integrity", async () => {
        const cwd = dir("proj");
        const pkg = dir("pkg");
        makePlugin(pkg, "plug", { noManifest: true });
        write(join(pkg, "package.json"), { name: "@acme/plug", scripts: { postinstall: "touch /tmp/should-not-run" } });
        const server = await registry(pkg, ["1.0.0", "1.4.0", "2.0.0"]);
        try {
            const reg = `http://localhost:${server.port}`;
            await addMarketplace(makeMarket("demo", [{ name: "plug", source: { source: "npm", package: "@acme/plug", version: "^1.0.0", registry: reg } }, { name: "missing", source: { source: "npm", package: "@acme/none", registry: reg } }], { make: false }), cwd);
            const r = await installPlugin("plug", "user", cwd);
            expect(r.version).toBe("1.4.0");
            expect(r.counts.commands).toBe(2);
            await expect(installPlugin("missing", "user", cwd)).rejects.toThrow(/wasn't found/);
        } finally {
            server.stop(true);
        }
    });

    test("an integrity mismatch is refused", async () => {
        const cwd = dir("proj");
        const pkg = dir("pkg");
        makePlugin(pkg, "plug");
        const server = await registry(pkg, ["1.0.0"], { corrupt: true });
        try {
            await addMarketplace(makeMarket("demo", [{ name: "plug", source: { source: "npm", package: "@acme/plug", registry: `http://localhost:${server.port}` } }], { make: false }), cwd);
            await expect(installPlugin("plug", "user", cwd)).rejects.toThrow(/integrity/);
            expect(readInstalled()).toEqual({});
        } finally {
            server.stop(true);
        }
    });

    test("a redirect from https to plain http is refused", async () => {
        const real = globalThis.fetch;
        const seen: string[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            seen.push(url);
            if (url.startsWith("https://reg.test/moved")) return new Response(null, { status: 301, headers: { location: "https://reg.test/@acme%2fplug" } });
            return new Response(null, { status: 302, headers: { location: "http://evil.test/@acme%2fplug" } });
        }) as typeof fetch;
        try {
            await expect(fetchNpm("@acme/plug", undefined, dir("npm"), "https://reg.test/moved")).rejects.toThrow(/redirected to http:\/\/evil\.test, which isn't https/);
            // An https hop is followed; the plain one never is.
            expect(seen).toEqual(["https://reg.test/moved/@acme%2fplug", "https://reg.test/@acme%2fplug"]);
        } finally {
            globalThis.fetch = real;
        }
    });

    test("https only, except this computer", () => {
        expect(secureUrl("https://registry.npmjs.org")).toBe(true);
        expect(secureUrl("http://localhost:4873")).toBe(true);
        expect(secureUrl("http://registry.example.com")).toBe(false);
        expect(secureUrl("file:///etc/passwd")).toBe(false);
    });

    test("version picking", () => {
        const doc = { "dist-tags": { latest: "2.0.0", next: "3.0.0-beta.1" }, versions: { "1.0.0": {}, "1.2.3": {}, "2.0.0": {}, "3.0.0-beta.1": {} } };
        expect(pickVersion(doc)).toBe("2.0.0");
        expect(pickVersion(doc, "next")).toBe("3.0.0-beta.1");
        expect(pickVersion(doc, "1.0.0")).toBe("1.0.0");
        expect(pickVersion(doc, "^1")).toBe("1.2.3");
        expect(pickVersion(doc, ">=1")).toBe("2.0.0"); // no prerelease unless asked
        expect(pickVersion(doc, "^9")).toBeUndefined();
        expect(() => checkIntegrity(new Uint8Array([1]), {})).toThrow(/no integrity/);
        expect(() => checkIntegrity(new Uint8Array([1]), { shasum: createHash("sha1").update(new Uint8Array([1])).digest("hex") })).not.toThrow();
    });
});

describe("file safety", () => {
    test("swapIn puts the old folder back when the new one can't move in", () => {
        const d = dir();
        write(join(d, "dest", "keep.txt"), "old");
        expect(() => swapIn(join(d, "missing"), join(d, "dest"))).toThrow();
        expect(readFileSync(join(d, "dest", "keep.txt"), "utf-8")).toBe("old");
        write(join(d, "new", "x.txt"), "new");
        swapIn(join(d, "new"), join(d, "dest"));
        expect(readFileSync(join(d, "dest", "x.txt"), "utf-8")).toBe("new");
        expect(existsSync(join(d, "dest", "keep.txt"))).toBe(false);
    });

    test("pruneSymlinks keeps links inside and drops the rest", () => {
        const d = dir();
        write(join(d, "p", "a.md"), "a");
        symlinkSync(join(d, "p", "a.md"), join(d, "p", "inside.md"));
        symlinkSync(ROOT, join(d, "p", "out"));
        symlinkSync(join(d, "nowhere"), join(d, "p", "dangling"));
        expect(pruneSymlinks(join(d, "p")).sort()).toEqual(["dangling", "out"]);
        expect(existsSync(join(d, "p", "inside.md"))).toBe(true);
    });
});

describe("the plugin command", () => {
    test("install, list, disable, validate and errors", async () => {
        const cwd = dir("proj");
        const mk = makeMarket("demo", [{ name: "fmt" }, { name: "bad", source: "../x" }]);
        let r = await runPluginCli(["marketplace", "add", mk], cwd, true);
        expect(r).toMatchObject({ ok: true, changed: true });
        expect(r.lines[0]).toBe("✔ Added marketplace demo · 2 plugins");
        r = await runPluginCli(["install", "fmt", "--scope", "local"], cwd, true);
        expect(r.lines[0]).toBe("✔ Installed fmt@demo v1.0.0 (local scope)");
        expect(r.lines[1]).toBe("  2 commands, 1 agent, 1 skill, 1 hook, 1 MCP server");
        r = await runPluginCli(["list"], cwd, true);
        expect(r.lines[0]).toBe("fmt@demo v1.0.0  on  · on (local)");
        r = await runPluginCli(["install", "fmt", "--scope", "project"], cwd, false);
        expect(r).toMatchObject({ ok: false });
        expect(r.lines[0]).toMatch(/isn't trusted/);
        r = await runPluginCli(["install", "fmt", "--scope", "everywhere"], cwd, true);
        expect(r.lines[0]).toMatch(/--scope must be user, project or local/);
        r = await runPluginCli(["validate", mk], cwd, true);
        expect(r.ok).toBe(false);
        expect(r.lines.join("\n")).toMatch(/bad: source \.\.\/x is outside the marketplace/);
        r = await runPluginCli(["validate", join(mk, "plugins", "fmt")], cwd, true);
        expect(r).toMatchObject({ ok: true, lines: ["✔ Plugin fmt: 2 commands, 1 agent, 1 skill, 1 hook, 1 MCP server"] });
        r = await runPluginCli(["frobnicate"], cwd, true);
        expect(r.ok).toBe(false);
        r = await runPluginCli(["marketplace", "list"], cwd, true);
        expect(r.lines[0]).toBe(`demo  ${mk}`);
    });

    test("after a change the terminal reads the skills again, and adds the plugins' commands to what Claude Code listed", async () => {
        const cwd = dir("proj");
        await addMarketplace(makeMarket("demo", [{ name: "fmt" }]), cwd);
        await installPlugin("fmt", "user", cwd);
        const app = {
            cwd,
            init: { trusted: false },
            skills: loadSkills(cwd, false),
            customCommands: [],
            cliCommands: { provider: "claude-code", names: new Set(["fmt:fmt"]) } as { provider: string; names: ReadonlySet<string> } | undefined,
            reloadSettings() {},
            mcp: { sync: async () => {}, restartWhere: async () => {} },
        };
        expect(app.skills.some((k) => k.name === "fmt:tidy")).toBe(true);
        await runPluginCli(["disable", "fmt"], cwd, false);
        await reload(app as never);
        expect(app.skills.some((k) => k.name === "fmt:tidy")).toBe(false);
        await runPluginCli(["enable", "fmt"], cwd, false);
        app.customCommands = [] as never;
        app.cliCommands = { provider: "claude-code", names: new Set(["code-review"]) };
        await reload(app as never);
        expect(app.skills.some((k) => k.name === "fmt:tidy")).toBe(true);
        // What Claude Code listed stays (its own names keep winning), with the enabled plugins' commands, which it now loads.
        expect([...app.cliCommands!.names].sort()).toEqual(["code-review", "fmt:fmt", "fmt:git:pr"]);
    });

    test("hooks in Cavvy's flat format are installed in Claude Code's, and still load in Cavvy", async () => {
        const cwd = dir("proj");
        const mk = makeMarket("demo", [{ name: "flat", source: "./flat" }], { make: false });
        write(join(mk, "flat", ".claude-plugin", "plugin.json"), { name: "flat", version: "1.0.0", hooks: { Stop: [{ command: "echo inline" }] } });
        write(join(mk, "flat", "hooks", "hooks.json"), { SessionStart: [{ matcher: "startup", command: "echo start", timeout: 3 }], PreToolUse: [{ hooks: [{ type: "command", command: "echo pre" }] }] });
        await addMarketplace(mk, cwd);
        await installPlugin("flat", "user", cwd);
        const root = readInstalled()["flat@demo"]!.installPath;
        expect(readJ(join(root, "hooks", "hooks.json"))).toEqual({
            hooks: {
                SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo start", timeout: 3 }] }],
                PreToolUse: [{ hooks: [{ type: "command", command: "echo pre" }] }],
            },
        });
        expect(readJ(claudeManifest(root)).hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "echo inline" }] }] });
        const hooks = loadSettings(cwd, { trusted: false }).hooks!;
        expect([hooks.SessionStart?.[0]?.command, hooks.PreToolUse?.[0]?.command, hooks.Stop?.[0]?.command]).toEqual(["echo start", "echo pre", "echo inline"]);
        // Already in Claude Code's format: untouched.
        expect(claudeHooks({ hooks: { Stop: [] } })).toEqual({ hooks: { Stop: [] } });
    });

    test("a bare name the agent CLI lists is its own command, not a plugin's", async () => {
        const started: string[] = [];
        const app = {
            cwd: dir("proj"),
            init: { trusted: false },
            skills: [],
            customCommands: [{ name: "fmt:code-review", description: "", body: "The plugin's review.", source: "plugin", file: "x.md", plugin: "fmt@demo" }],
            model: { provider: "claude-code", id: "default" },
            cliCommands: { provider: "claude-code", names: new Set(["code-review"]) },
            busy: false,
            startTurn: (t: string) => void started.push(t),
            print() {},
            notice() {},
        };
        // Not taken: Claude Code gets /code-review as typed.
        expect(await runCommand(app as never, "/code-review")).toBe(false);
        expect(started).toEqual([]);
    });

    test("Claude Code's copy keeps marketplace fields Cavvy doesn't read, and spells the plugin root its way", async () => {
        const cwd = dir("proj");
        const mk = makeMarket("demo", [{ name: "fmt", extra: { outputStyles: "./styles", homepage: "https://x" } }]);
        write(join(mk, "plugins", "fmt", "hooks", "hooks.json"), { hooks: { Stop: [{ hooks: [{ type: "command", command: "${CAVVY_PLUGIN_ROOT}/stop.sh" }] }] } });
        write(join(mk, "plugins", "fmt", "stop.sh"), 'echo "$CAVVY_PLUGIN_ROOT"');
        await addMarketplace(mk, cwd);
        await installPlugin("fmt", "user", cwd);
        const root = readInstalled()["fmt@demo"]!.installPath;
        expect(readJ(claudeManifest(root))).toMatchObject({ name: "fmt", outputStyles: "./styles", homepage: "https://x" });
        expect(readFileSync(join(root, "hooks", "hooks.json"), "utf-8")).toContain("${CLAUDE_PLUGIN_ROOT}/stop.sh");
        // Scripts are the plugin's own: a variable of that name in one is left alone.
        expect(readFileSync(join(root, "stop.sh"), "utf-8")).toBe('echo "$CAVVY_PLUGIN_ROOT"');
        // Cavvy reads it the same either way.
        expect(loadSettings(cwd, { trusted: false }).hooks?.Stop?.[0]?.command).toBe("${CLAUDE_PLUGIN_ROOT}/stop.sh");
        // The marketplace's own copy is untouched.
        expect(readFileSync(join(mk, "plugins", "fmt", "stop.sh"), "utf-8")).toBe('echo "$CAVVY_PLUGIN_ROOT"');
    });

    test("trust: an untrusted folder sees only the user's plugins", async () => {
        const cwd = dir("proj");
        await addMarketplace(makeMarket("demo", [{ name: "fmt" }]), cwd);
        await installPlugin("fmt", "local", cwd);
        expect(trust.isTrusted(cwd)).toBe(false);
        expect(loadAgents(cwd).some((a) => a.source === "plugin")).toBe(false);
        trust.trustForSession(cwd);
        expect(loadAgents(cwd).some((a) => a.name === "fmt:checker")).toBe(true);
    });
});

describe("performance", () => {
    test("loading 20 enabled plugins again is cheap", async () => {
        const cwd = dir("proj");
        const mk = makeMarket(
            "perf",
            Array.from({ length: 20 }, (_, i) => ({ name: `p${i}` })),
        );
        await addMarketplace(mk, cwd);
        for (let i = 0; i < 20; i++) await installPlugin(`p${i}`, "user", cwd);
        loadSettings(cwd, { trusted: true });
        const runs = 200;
        const t0 = performance.now();
        for (let i = 0; i < runs; i++) loadPlugins(cwd, true);
        const per = (performance.now() - t0) / runs;
        // A warm reload is stat calls only: well under 2 ms for 20 plugins (it's ~0.2 ms on a laptop).
        expect(per).toBeLessThan(2);
        const s = loadSettings(cwd, { trusted: true });
        expect(Object.keys(s.mcpServers ?? {}).length).toBe(20);
    });
});
