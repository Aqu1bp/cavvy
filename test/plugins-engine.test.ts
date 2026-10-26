// The GUI server's plugin methods and plugin commands, without a listening server.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const root = tempDir("plugins-engine-");
const { Engine } = await import("../src/server/engine");
const { trustFolder } = await import("../src/config/trust");
const client = { subs: new Set<string>(), send() {} };
afterAll(() => {
    iso.cleanup();
    rmSync(root, { recursive: true, force: true });
});

function write(file: string, data: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
}

test("list, install at a scope, toggle, run a bare plugin command, uninstall, remove", async () => {
    const mk = join(root, "mk");
    write(join(mk, ".claude-plugin", "marketplace.json"), { name: "demo", plugins: [{ name: "fmt", source: "./fmt", description: "Formats" }] });
    write(join(mk, "fmt", "commands", "tidy.md"), "Tidy $ARGUMENTS");
    const cwd = join(root, "proj");
    mkdirSync(cwd, { recursive: true });
    const engine = new Engine({ listModels: async () => [] });
    try {
        expect(await engine.handle(client, "plugins.list", { cwd })).toMatchObject({ marketplaces: [], plugins: [], trusted: false, cwd });
        const added = await engine.handle(client, "plugins.action", { action: "marketplaceAdd", source: mk, cwd });
        expect(added.message).toBe("✔ Added marketplace demo · 1 plugin\nInstall one with: plugin install <name>@demo  (fmt)");
        expect(added.plugins).toEqual([expect.objectContaining({ id: "fmt@demo", enabled: false, description: "Formats" })]);

        // Project scopes need a trusted project.
        await expect(engine.handle(client, "plugins.action", { action: "install", id: "fmt", scope: "project", cwd })).rejects.toMatchObject({ code: "plugin", message: expect.stringMatching(/isn't trusted/) });
        await expect(engine.handle(client, "plugins.action", { action: "install", id: "fmt", scope: "local" })).rejects.toMatchObject({ code: "invalid" });
        trustFolder(cwd);
        engine.workspaceFor(cwd);
        engine.cliCommandsReported("claude-code", cwd, ["code-review"]);
        const inst = await engine.handle(client, "plugins.action", { action: "install", id: "fmt", scope: "local", cwd });
        // What Claude Code listed keeps its own names after a change, and gains the enabled plugins' commands.
        expect([...engine.cliCommands("claude-code", cwd)!].sort()).toEqual(["code-review", "fmt:tidy"]);
        expect(inst.plugins[0]).toMatchObject({ enabled: true, scopes: { local: true }, installed: { version: "local", counts: { commands: 1 } } });

        // Its command is listed, and the bare name resolves to it.
        const cmds = await engine.handle(client, "commands.list", { cwd, provider: "mock", command: "tidy" });
        expect(cmds.some((c) => c.name === "fmt:tidy")).toBe(true);
        await expect(engine.handle(client, "commands.list", { cwd, provider: "mock", command: "nope" })).rejects.toMatchObject({ code: "unknown_command" });

        const off = await engine.handle(client, "plugins.action", { action: "disable", id: "fmt", cwd });
        expect(off.plugins[0]).toMatchObject({ enabled: false, scopes: { local: false } });
        await expect(engine.handle(client, "commands.list", { cwd, provider: "mock", command: "tidy" })).rejects.toMatchObject({ code: "unknown_command" });

        const gone = await engine.handle(client, "plugins.action", { action: "uninstall", id: "fmt", cwd });
        expect(gone.plugins[0]!.installed).toBeUndefined();
        const removed = await engine.handle(client, "plugins.action", { action: "marketplaceRemove", name: "demo", cwd });
        expect(removed).toMatchObject({ marketplaces: [], plugins: [] });
        await expect(engine.handle(client, "plugins.action", { action: "frob", cwd } as never)).rejects.toMatchObject({ code: "invalid" });
    } finally {
        await engine.stop();
    }
});

test("updating a plugin whose files changed under the same version restarts its MCP servers", async () => {
    const FIXTURE = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");
    const mk = join(root, "mk-srv");
    const marker = join(root, "srv-marker");
    const server = (v: string) => `import { appendFileSync } from "fs";\nappendFileSync(${JSON.stringify(marker)}, "${v}\\n");\nawait import(${JSON.stringify(FIXTURE)});\n`;
    write(join(mk, ".claude-plugin", "marketplace.json"), { name: "srvmk", plugins: [{ name: "srv", source: "./srv" }] });
    write(join(mk, "srv", ".claude-plugin", "plugin.json"), { name: "srv", version: "1.0.0" });
    write(join(mk, "srv", ".mcp.json"), { mcpServers: { probe: { command: process.execPath, args: ["--no-env-file", "${CLAUDE_PLUGIN_ROOT}/server.ts"] } } });
    write(join(mk, "srv", "server.ts"), server("v1"));
    const cwd = join(root, "proj-srv");
    mkdirSync(cwd, { recursive: true });
    const engine = new Engine({ listModels: async () => [] });
    const lines = () => (existsSync(marker) ? readFileSync(marker, "utf-8").trim().split("\n") : []);
    const status = () => engine.workspaceFor(cwd).mcp.servers.get("plugin:srv:probe")?.status;
    async function until(ok: () => boolean) {
        for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(25);
        expect(ok()).toBe(true);
    }
    try {
        await engine.handle(client, "plugins.action", { action: "marketplaceAdd", source: mk, cwd });
        await engine.handle(client, "plugins.action", { action: "install", id: "srv", scope: "user", cwd });
        engine.workspaceFor(cwd);
        await until(() => status() === "connected" && lines().length === 1);
        expect(lines()).toEqual(["v1"]);

        // Unchanged files: nothing restarts.
        const same = await engine.handle(client, "plugins.action", { action: "update", id: "srv", cwd });
        expect(same.message).toMatch(/up to date/);
        await Bun.sleep(200);
        expect(lines()).toEqual(["v1"]);

        // New code, same version and server configuration (a plugin being developed locally).
        write(join(mk, "srv", "server.ts"), server("v2"));
        const r = await engine.handle(client, "plugins.action", { action: "update", id: "srv", cwd });
        expect(r.message).not.toMatch(/up to date/);
        await until(() => lines().at(-1) === "v2" && status() === "connected");
        expect(lines()).toEqual(["v1", "v2"]);
    } finally {
        await engine.stop();
    }
});
