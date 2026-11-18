// Finding an agent CLI (src/backends/cli.ts findCli): on PATH, and where the official installer puts Claude Code,
// ~/.local/bin, which a Mac app started from the Dock doesn't have on PATH. Run in a process of its own: Bun reads
// HOME once.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tempDir } from "./helpers/isolate";

const cli = join(import.meta.dir, "..", "src", "backends", "cli.ts");

const program = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "claude");
    writeFileSync(p, "#!/bin/sh\n");
    chmodSync(p, 0o755);
    return p;
};

const found = (home: string, path: string) => {
    const code = `const { CLAUDE_CLI, findCli } = await import(${JSON.stringify(cli)}); console.log(findCli("claude-code", CLAUDE_CLI) ?? "")`;
    const r = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, HOME: home, PATH: path }, stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    return r.stdout.toString().trim() || undefined;
};

test("a CLI in ~/.local/bin is found when it isn't on PATH", () => {
    const home = tempDir("cavvy-find-cli-home-");
    const bin = program(join(home, ".local", "bin"));
    expect(found(home, tempDir("cavvy-find-cli-path-"))).toBe(bin);
});

test("the one on PATH comes first", () => {
    const home = tempDir("cavvy-find-cli-home-");
    program(join(home, ".local", "bin"));
    const dir = tempDir("cavvy-find-cli-path-");
    const onPath = program(dir);
    expect(found(home, dir)).toBe(onPath);
});

test("none in either: not found", () => {
    expect(found(tempDir("cavvy-find-cli-home-"), tempDir("cavvy-find-cli-path-"))).toBeUndefined();
});
