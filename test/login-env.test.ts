import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptLoginPath } from "../src/server/login-env";

let dir: string;
let file: string;
const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };

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
