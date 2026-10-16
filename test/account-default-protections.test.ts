// Only temporary CLI homes; permission decisions never open credential contents.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, sep } from "path";
import { isolate, tempDir } from "./helpers/isolate";

// Bun caches homedir at startup, so test the literal ~ paths in an isolated child.
if (!process.env.HARNESS_TEST_DEFAULT_ACCOUNTS) {
    test("Default account protections in an isolated home", () => {
        const home = realpathSync(tempDir());
        try {
            const result = Bun.spawnSync([process.execPath, "--no-env-file", "test", import.meta.path], {
                env: { ...process.env, HOME: home, HARNESS_HOME: join(home, ".harness"), HARNESS_TEST_DEFAULT_ACCOUNTS: home },
                timeout: 15000,
            });
            expect({ code: result.exitCode, output: result.stderr.toString() }).toMatchObject({ code: 0 });
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
} else {
    const home = process.env.HARNESS_TEST_DEFAULT_ACCOUNTS;
    if (!home.startsWith(realpathSync(tmpdir()) + sep) || home !== realpathSync(homedir())) throw new Error("Expected an isolated temporary home");
    const iso = isolate();
    const previous = { HOME: process.env.HOME, HARNESS_HOME: process.env.HARNESS_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
    process.env.HOME = home;
    process.env.HARNESS_HOME = join(home, ".harness");
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    for (const dir of [".claude", ".codex", ".harness"]) mkdirSync(join(home, dir));
    const alias = join(home, "codex-link");
    symlinkSync(join(home, ".codex"), alias);
    const { saveAgentConfig } = await import("../src/providers/registry");
    const { accountProtectedPaths } = await import("../src/providers/accounts");
    const { PermissionChecker } = await import("../src/permissions/checker");
    const { BUILTIN_TOOLS } = await import("../src/tools/index");
    const { accountTarget } = await import("../src/permissions/bash-safety");
    const { sandboxPolicy } = await import("../src/permissions/sandbox");
    const { claudePermissions } = await import("../src/backends/claude-code");
    const { claudeAccountSandbox, accountPermissionConfig } = await import("../src/backends/account-permissions");
    const checker = new PermissionChecker(() => ({}), home);
    const check = (name: string, input: unknown) => checker.check(BUILTIN_TOOLS.find((t) => t.name === name)!, input, "auto", home);
    const clear = () => { for (const p of ["claude-code", "codex"]) saveAgentConfig(p, { accounts: [] }); };
    afterAll(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        iso.cleanup();
    });

    function unchangedDefault() {
        expect(homedir()).toBe(home);
        expect(accountProtectedPaths()).toEqual([]);
        for (const command of ["ls ~", "ls ~/.claude", "tree ~/.codex", "grep -r token ~/.codex"]) {
            expect(accountTarget(command, home)).toBe(false);
            expect(check("Bash", { command }).behavior).toBe("allow");
        }
        for (const root of [home, join(home, ".claude"), join(home, ".codex"), alias]) {
            for (const tool of ["Grep", "Glob", "LS"]) expect(check(tool, { path: root, pattern: "token" }).behavior).toBe("allow");
        }
        for (const root of [join(home, ".claude"), join(home, ".codex"), alias]) {
            expect(checker.isProtectedArea(root)).toBe(false);
            expect(checker.hiddenFromSearch("Glob", root)).toBeUndefined();
        }
        const policy = sandboxPolicy([home], { harnessHome: process.env.HARNESS_HOME! });
        for (const file of [join(home, ".claude", ".credentials.json"), join(home, ".codex", "auth.json")]) {
            expect(check("Read", { file_path: file }).behavior).toBe("allow");
            expect(policy.unreadable).not.toContain(file);
            expect(claudePermissions({ deny: [], ask: [], root: home }).deny).not.toContain(`Read(/${file})`);
        }
        expect(claudeAccountSandbox()).toBeUndefined();
        expect(accountPermissionConfig([])).toBeUndefined();
    }

    test("without named accounts, Default searches, listings, grants and native policy match main", () => {
        clear();
        unchangedDefault();
    });

    for (const provider of ["claude-code", "codex"]) test(`${provider}: named accounts protect Default contents but allow name-only listings`, () => {
        clear();
        const named = join(home, "named");
        saveAgentConfig(provider, { accounts: [{ id: "named", name: "Named", folder: named, managed: provider === "codex" }] });
        try {
            for (const root of ["~/.claude", "~/.codex", alias]) {
                for (const command of [`ls ${root}`, `ls ${root}/*`, `tree ${root}`, `find ${root} -type f`, `fd token ${root}`, `rg --files ${root}`]) {
                    expect({ command, blocked: accountTarget(command, home) }).toEqual({ command, blocked: false });
                }
                for (const command of [`grep -r token ${root}`, `grep -R token ${root}`, `grep -d recurse token ${root}`, `grep --directories=recurse token ${root}`, `grep --directories recurse token ${root}`, `rg token ${root}`, `rg -e --files ${root}`, `ag token ${root}`, `ack token ${root}`, `find ${root} -exec cat {} \\;`, `find ${root} -execdir cat {} \\;`, `find ${root} -ok cat {} \\;`, `fd -x cat {} ${root}`, `fd -xcat ${root}`]) {
                    expect({ command, blocked: accountTarget(command, home) }).toEqual({ command, blocked: true });
                }
            }
            for (const command of ["grep -d recurse token", "grep --directories=recurse token", "rg -e --files", "fd -xcat"]) expect(accountTarget(command, join(home, ".codex"))).toBe(true);
            for (const command of ["ls", "tree", "find -type f", "fd token", "rg --files"]) expect(accountTarget(command, join(home, ".codex"))).toBe(false);
            expect(check("Bash", { command: "ls ~/.codex" }).behavior).toBe("allow");
            for (const command of ["cat ~/.codex/auth.json", "grep -r token ~/.codex", "cat ~/.claude/.credentials.json", "echo changed > ~/.codex/auth.json"]) expect(check("Bash", { command }).behavior).toBe("deny");
            for (const root of [join(home, ".claude"), join(home, ".codex"), alias]) {
                expect(check("Grep", { pattern: "token", path: root }).behavior).toBe("deny");
                for (const tool of ["Glob", "LS"]) {
                    expect(check(tool, { pattern: "*", path: root }).behavior).toBe("allow");
                    expect(checker.hiddenFromSearch(tool, root)).toBeUndefined();
                }
                expect(checker.isProtectedArea(root)).toBe(true);
            }
            for (const file of [join(home, ".claude", ".credentials.json"), join(home, ".codex", "auth.json")]) {
                expect(check("Read", { file_path: file }).behavior).toBe("deny");
                expect(check("Write", { file_path: file, content: "x" }).behavior).toBe("deny");
                expect(sandboxPolicy([home], { harnessHome: process.env.HARNESS_HOME! }).unreadable).toContain(file);
                expect(claudeAccountSandbox()!.filesystem.denyRead).toContain(file);
                for (const profile of Object.values(accountPermissionConfig([])!)) expect((profile as any).filesystem[file]).toBe("deny");
            }
            // Named folders retain whole-folder protection, even for name-only searches.
            expect(accountTarget(`ls '${named}'`, home)).toBe(true);
            expect(accountTarget(`find '${named}' -type f`, home)).toBe(true);
            expect(check("Glob", { path: named, pattern: "*" }).behavior).toBe("deny");
        } finally { clear(); }
        unchangedDefault();
    });

}
