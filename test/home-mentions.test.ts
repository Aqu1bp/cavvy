// Home's @ (fs.mentions) before any session opens in the folder: the real RPC dispatch, no socket.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const cwd = tempDir("home-mentions-");
const { Engine } = await import("../src/server/engine");
afterAll(() => {
    iso.cleanup();
    rmSync(cwd, { recursive: true, force: true });
});

test("Home's @ lists a folder's files with no session there, and opens no workspace for it", async () => {
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "README.md"), "hello\n");
    writeFileSync(join(cwd, "src", "main.ts"), "export {};\n");
    const engine = new Engine({ listModels: async () => [] });
    const client = { subs: new Set<string>(), send: () => {} };
    const found = await engine.handle(client, "fs.mentions", { cwd, query: "main" });
    expect(found).toContain("src/main.ts");
    expect(await engine.handle(client, "fs.mentions", { cwd, query: "READ" })).toContain("README.md");
    // Searching starts nothing there (no settings, MCP servers or trust).
    expect(engine.workspaces.size).toBe(0);
    // A path that isn't a folder lists nothing.
    expect(await engine.handle(client, "fs.mentions", { cwd: join(cwd, "README.md"), query: "" })).toEqual([]);
    expect(await engine.handle(client, "fs.mentions", { cwd: join(cwd, "missing"), query: "" })).toEqual([]);
});
