import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, Workspace } from "../src/server/engine";
import { adoptLoginPath, loginPathSettled } from "../src/server/login-env";

let dir: string;
let file: string;
const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL, CAVVY_HOME: process.env.CAVVY_HOME };

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cavvy-login-"));
    file = join(dir, "login-path");
    // A login shell that takes a moment to start, then says PATH has /from/shell.
    const shell = join(dir, "shell");
    writeFileSync(shell, `#!/bin/sh\nsleep 0.4\nPATH=/from/shell:$PATH\neval "$2"\n`);
    chmodSync(shell, 0o755);
    process.env.SHELL = shell;
    process.env.PATH = "/usr/bin:/bin";
});

afterEach(() => {
    process.env.PATH = saved.PATH;
    process.env.SHELL = saved.SHELL;
    if (saved.CAVVY_HOME === undefined) delete process.env.CAVVY_HOME;
    else process.env.CAVVY_HOME = saved.CAVVY_HOME;
    rmSync(dir, { recursive: true, force: true });
});

test("a first launch waits for the login shell, and remembers what it said", async () => {
    await adoptLoginPath(file);
    expect(process.env.PATH).toBe("/from/shell:/usr/bin:/bin");
    expect(readFileSync(file, "utf8")).toBe("/from/shell:/usr/bin:/bin");
});

test("later launches don't wait: what it said last time now, its answer when it comes", async () => {
    writeFileSync(file, "/from/last/time:/usr/bin");
    const t0 = performance.now();
    const { answered } = await adoptLoginPath(file);
    expect(performance.now() - t0).toBeLessThan(300);
    expect(process.env.PATH).toBe("/from/last/time:/usr/bin:/bin");
    await answered;
    expect(process.env.PATH).toBe("/from/shell:/usr/bin:/bin");
    expect(readFileSync(file, "utf8")).toBe("/from/shell:/usr/bin:/bin");
});

test("a shell that says nothing leaves what was remembered", async () => {
    writeFileSync(file, "/from/last/time:/usr/bin");
    writeFileSync(process.env.SHELL!, `#!/bin/sh\nexit 1\n`);
    const { answered } = await adoptLoginPath(file);
    await answered;
    expect(process.env.PATH).toBe("/from/last/time:/usr/bin:/bin");
    expect(readFileSync(file, "utf8")).toBe("/from/last/time:/usr/bin");
});

test("what's looked for once waits for its answer, so a tool new since last time is found", async () => {
    // The shell's PATH has a folder last time's didn't, with a local MCP server's command in it.
    const bin = join(dir, "bin"), started = join(dir, "started");
    mkdirSync(bin);
    writeFileSync(join(bin, "new-tool"), `#!/bin/sh\ntouch ${started}\n`);
    chmodSync(join(bin, "new-tool"), 0o755);
    writeFileSync(process.env.SHELL!, `#!/bin/sh\nsleep 0.4\nPATH=${bin}:$PATH\neval "$2"\n`);
    writeFileSync(file, "/from/last/time:/usr/bin");
    const home = join(dir, "home");
    mkdirSync(home);
    writeFileSync(join(home, "settings.json"), JSON.stringify({ mcpServers: { fresh: { command: "new-tool" } } }));
    process.env.CAVVY_HOME = home;

    const { answered } = await adoptLoginPath(file);
    let settled = false;
    void loginPathSettled().then(() => (settled = true));
    let listedWith: string | undefined;
    const engine = new Engine({ startCwd: dir, listModels: async () => ((listedWith = process.env.PATH), []) });
    const listed = engine.refreshListings();
    const workspace = new Workspace(engine, dir, false);
    await Bun.sleep(50);
    expect(settled).toBe(false);
    expect(listedWith).toBeUndefined();
    expect(workspace.mcp.servers.get("fresh")?.status).toBe("pending");

    await answered;
    await listed;
    expect(listedWith).toContain(bin);
    for (let i = 0; i < 100 && !existsSync(started); i++) await Bun.sleep(20);
    expect(existsSync(started)).toBe(true);
    await workspace.mcp.closeAll();
});
