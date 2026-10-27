// Only temporary CLI homes; permission decisions never open credential contents.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, sep } from "path";
import { isolate, tempDir } from "./helpers/isolate";

// Bun caches homedir at startup, so test the literal ~ paths in an isolated child.
if (!process.env.CAVVY_TEST_DEFAULT_ACCOUNTS) {
    test("Default account protections in an isolated home", () => {
        const home = realpathSync(tempDir());
        try {
            // XDG_CONFIG_HOME (set on CI runners) would put OpenCode's global config outside this home.
            const { XDG_CONFIG_HOME: _, ...env } = process.env;
            const result = Bun.spawnSync([process.execPath, "--no-env-file", "test", import.meta.path], {
                env: { ...env, HOME: home, CAVVY_HOME: join(home, ".cavvy"), CAVVY_TEST_DEFAULT_ACCOUNTS: home },
                timeout: 15000,
            });
            expect({ code: result.exitCode, output: result.stderr.toString() }).toMatchObject({ code: 0 });
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
} else {
    const home = process.env.CAVVY_TEST_DEFAULT_ACCOUNTS;
    if (!home.startsWith(realpathSync(tmpdir()) + sep) || home !== realpathSync(homedir())) throw new Error("Expected an isolated temporary home");
    const iso = isolate();
    const previous = { HOME: process.env.HOME, CAVVY_HOME: process.env.CAVVY_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_SECURESTORAGE_CONFIG_DIR: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
    process.env.HOME = home;
    process.env.CAVVY_HOME = join(home, ".cavvy");
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    for (const dir of [".claude", ".codex", ".cavvy"]) mkdirSync(join(home, dir));
    const alias = join(home, "codex-link");
    symlinkSync(join(home, ".codex"), alias);
    const { saveAgentConfig } = await import("../src/providers/registry");
    const { accountProtectedPaths } = await import("../src/providers/accounts");
    const { PermissionChecker } = await import("../src/permissions/checker");
    const { BUILTIN_TOOLS } = await import("../src/tools/index");
    const { CASE_INSENSITIVE_FS } = await import("../src/util/files");
    const { accountTarget } = await import("../src/permissions/bash-safety");
    const { sandboxPolicy, seatbeltProfile } = await import("../src/permissions/sandbox");
    const { claudePermissions } = await import("../src/backends/claude-code");
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
        const policy = sandboxPolicy([home], { cavvyHome: process.env.CAVVY_HOME! });
        for (const file of [join(home, ".claude", ".credentials.json"), join(home, ".codex", "auth.json")]) {
            expect(check("Read", { file_path: file }).behavior).toBe("allow");
            expect(policy.unreadable).not.toContain(file);
            expect(claudePermissions({ deny: [], ask: [], root: home }).deny).not.toContain(`Read(/${file})`);
        }
    }

    test("without named accounts, the entire Seatbelt profile matches main's construction", async () => {
        clear();
        const policy = sandboxPolicy([home], { home, cavvyHome: join(home, ".cavvy") });
        // Keep only the fixture workspace writable so the baseline is independent of OS temp paths.
        policy.writable = [home];
        const expected = await Bun.file(join(import.meta.dir, "fixtures", "seatbelt-no-accounts.txt")).text();
        // Frozen from origin/main's construction without account paths, including its literal deny set; since then Cavvy
        // home's contents and extended attributes (not its listing) are what's denied, with its secrets and accounts/ wholly, ps works, and the
        // folder above OpenCode's global config (~/.config) can't be moved.
        expect(seatbeltProfile(policy).replaceAll(home, "/workspace")).toBe(expected);
    });

    test("without named accounts, Default searches, listings, grants and native policy match main", () => {
        clear();
        unchangedDefault();
    });

    for (const provider of ["claude-code", "codex"]) test(`${provider}: named accounts protect Default sign-in files, while searches and listings of their folders decide as without accounts`, () => {
        clear();
        const named = join(home, "named");
        saveAgentConfig(provider, { accounts: [{ id: "named", name: "Named", folder: named, managed: provider === "codex" }] });
        try {
            for (const root of ["~/.claude", "~/.codex", alias]) {
                // A folder that merely holds a sign-in file is searched as without accounts (#375).
                for (const command of [`ls ${root}`, `ls ${root}/*`, `tree ${root}`, `find ${root} -type f`, `fd token ${root}`, `rg --files ${root}`, `grep -r token ${root}`, `grep -R token ${root}`, `grep -d recurse token ${root}`, `grep --directories=recurse token ${root}`, `grep --directories recurse token ${root}`, `rg token ${root}`, `rg -e --files ${root}`, `ag token ${root}`, `ack token ${root}`, `find ${root} -exec cat {} \\;`, `find ${root} -execdir cat {} \\;`, `find ${root} -ok cat {} \\;`, `fd -x cat {} ${root}`, `fd -xcat ${root}`]) {
                    expect({ command, blocked: accountTarget(command, home) }).toEqual({ command, blocked: false });
                }
                // A pattern that can match the sign-in file, read or run, names it.
                for (const command of [`cat ${root}/*`, `grep token ${root}/*`, `rg token ${root}/*`, `find ${root}/* -exec cat {} \\;`]) {
                    expect({ command, blocked: accountTarget(command, home) }).toEqual({ command, blocked: true });
                }
            }
            for (const command of ["ls", "tree", "find -type f", "fd token", "rg --files", "grep -d recurse token", "grep --directories=recurse token", "rg -e --files", "fd -xcat"]) expect(accountTarget(command, join(home, ".codex"))).toBe(false);
            for (const prefix of ["env", "env FOO=bar", "command", "command -p", "nice", "nice -n 5", "xargs", "xargs -n 1"]) {
                expect(accountTarget(`${prefix} grep -r . .codex`, home)).toBe(false);
                expect(accountTarget(`${prefix} cat .codex/auth.json`, home)).toBe(true);
            }
            for (const wrapper of ["xargs -a", "time -o"]) {
                expect(accountTarget(`${wrapper} '${home}/.codex/auth.json' grep x /tmp/public`, home)).toBe(true);
                expect(accountTarget(`${wrapper} .codex/auth.json grep x /tmp/public`, home)).toBe(true);
                expect(accountTarget(`${wrapper} .codex/config.toml grep x /tmp/public`, home)).toBe(false);
            }
            for (const wrapper of [
                "xargs -a auth.json", "xargs -aauth.json", "xargs -0aauth.json", "xargs --arg-file=auth.json",
                "time -o auth.json", "time -oauth.json", "time -aoauth.json", "time --output=auth.json",
                "env nohup xargs --arg-file=auth.json", "time --output=public.txt xargs -aauth.json",
            ]) {
                const command = `${wrapper} grep foo /tmp/public`;
                expect({ command, blocked: accountTarget(command, join(home, ".codex")) }).toEqual({ command, blocked: true });
                expect(accountTarget(command.replaceAll("auth.json", "config.toml"), join(home, ".codex"))).toBe(false);
            }
            for (const wrapper of ["xargs -Iauth.json", "xargs --delimiter=auth.json", "time -fauth.json", "time --format=auth.json", "nohup"]) {
                expect(accountTarget(`${wrapper} grep foo /tmp/public`, join(home, ".codex"))).toBe(false);
            }
            for (const command of ["xargs -a auth.json", "xargs -aauth.json", "xargs --arg-file=auth.json"]) {
                expect(accountTarget(command, join(home, ".codex"))).toBe(true);
                expect(accountTarget(command.replaceAll("auth.json", "config.toml"), join(home, ".codex"))).toBe(false);
            }
            if (CASE_INSENSITIVE_FS) {
                for (const command of ["/usr/bin/CAT .codex/auth.json", "ENV CAT .CODEX/AUTH.JSON", "NICE -n 5 RG token .codex/AUTH.json"]) expect(accountTarget(command, home)).toBe(true);
            }
            for (const cd of ["cd --", "pushd --", "cd -P", "cd -L", "cd -P --"]) {
                expect(accountTarget(`${cd} .codex && cat auth.json`, home)).toBe(true);
                expect(accountTarget(`${cd} .codex && cat config.toml`, home)).toBe(false);
            }
            for (const command of [
                "grep --file=auth.json x", "grep -fauth.json x", "grep -ifauth.json x", "rg -fauth.json x",
                "grep --file auth.json x", "rg --file auth.json x", "rg --file=auth.json x",
                "grep --exclude-from=auth.json x", "grep --exclude-from auth.json x",
                "rg --ignore-file=auth.json x", "rg --ignore-file auth.json x",
            ]) {
                expect({ command, blocked: accountTarget(command, join(home, ".codex")) }).toEqual({ command, blocked: true });
                expect(accountTarget(command.replaceAll("auth.json", "config.toml") + " /tmp/public", join(home, ".codex"))).toBe(false);
            }
            for (const command of ["rg --pre cat token .codex/auth.json", "rg --pre=cat --files .codex/*"]) expect(accountTarget(command, home)).toBe(true);
            for (const filter of [`--filter 'merge ${home}/.codex/auth.json'`, `-f '. ${home}/.codex/auth.json'`]) {
                expect(accountTarget(`rsync -a ${filter} /tmp/public /tmp/copy`, home)).toBe(true);
            }
            for (const command of [
                "cp -r .codex /tmp/copy", "cp -R .codex /tmp/copy", "cp -a .codex /tmp/copy", "rsync -a .codex /tmp/copy",
                "tar cf /tmp/copy.tar .codex", "tar -rf /tmp/copy.tar .codex", "tar -uf /tmp/copy.tar .codex",
                "zip -r /tmp/copy.zip .codex", "ditto .codex /tmp/copy", "cpio -o .codex", "pax -w .codex",
                "scp -r .codex host:copy", "rclone copy .codex remote:copy",
            ]) expect({ command, blocked: accountTarget(command, home) }).toEqual({ command, blocked: true });
            for (const listing of ["ls ~/.codex/*", "find ~/.codex/* -type f", "fd . ~/.codex/*", "tree ~/.codex/*", "rg --files ~/.codex/*", "printf '%s\\n' ~/.codex/*"]) {
                for (const consumer of ["xargs cat", "parallel cat", "while read f; do cat \"$f\"; done", "sh", "env xargs cat", "sort | xargs cat", "(xargs cat)", "{ xargs cat; }"]) {
                    const command = `${listing} | ${consumer}`;
                    expect({ command, blocked: accountTarget(command, home) }).toEqual({ command, blocked: true });
                }
            }
            for (const command of ["ls ~/.codex | sort", "rg --files ~/.codex | wc -l", "ls ~/.codex; xargs cat", "ls /tmp/public | xargs cat", "ls ~/.codex | xargs cat"]) {
                expect({ command, blocked: accountTarget(command, home) }).toEqual({ command, blocked: false });
            }
            expect(check("Bash", { command: "ls ~/.codex" }).behavior).toBe("allow");
            // A search of a folder holding a sign-in file: sandboxed (macOS; Linux with "sandbox": true) the file can't be
            // read, so it runs; with no sandbox (Linux by default) it would read the file, so the reviewer decides.
            const grep = (sandbox: "seatbelt" | undefined) => new PermissionChecker(() => ({}), home, () => sandbox).check(BUILTIN_TOOLS.find((t) => t.name === "Bash")!, { command: "grep -r token ~/.codex" }, "auto", home);
            expect(grep("seatbelt").behavior).toBe("allow");
            expect(grep(undefined)).toMatchObject({ behavior: "ask", needsClassifier: true, sensitive: "Cavvy credential store" });
            for (const command of ["cat ~/.codex/auth.json", "cat ~/.claude/.credentials.json", "echo changed > ~/.codex/auth.json"]) expect(check("Bash", { command }).behavior).toBe("deny");
            for (const root of [join(home, ".claude"), join(home, ".codex"), alias]) {
                // Searched as without accounts, the sign-in file hidden in it.
                expect(check("Grep", { pattern: "token", path: root }).behavior).toBe("allow");
                expect(checker.hiddenFromSearch("Grep", root)).toBeUndefined();
                for (const tool of ["Glob", "LS"]) {
                    expect(check(tool, { pattern: "*", path: root }).behavior).toBe("allow");
                    expect(checker.hiddenFromSearch(tool, root)).toBeUndefined();
                }
                expect(checker.isProtectedArea(root)).toBe(true);
            }
            for (const file of [join(home, ".claude", ".credentials.json"), join(home, ".codex", "auth.json")]) {
                expect(check("Read", { file_path: file }).behavior).toBe("deny");
                expect(check("Write", { file_path: file, content: "x" }).behavior).toBe("deny");
                expect(sandboxPolicy([home], { cavvyHome: process.env.CAVVY_HOME! }).unreadable).toContain(file);
                expect(checker.hiddenFromSearch("Grep", file)).toBe("protected");
                expect(claudePermissions({ deny: [], ask: [], root: home }).deny).toContain(`Read(/${file})`);
            }
            // Named folders retain whole-folder protection, even for name-only searches.
            expect(accountTarget(`ls '${named}'`, home)).toBe(true);
            expect(accountTarget(`find '${named}' -type f`, home)).toBe(true);
            expect(check("Glob", { path: named, pattern: "*" }).behavior).toBe("deny");
        } finally { clear(); }
        unchangedDefault();
    });

    test("Claude's secure-storage sign-in file is protected for distinct, empty, unset, aliased and dangling selectors, only alongside named accounts", () => {
        clear();
        // Outside the workspace, where Auto otherwise reads freely.
        const project = join(home, "secure-project");
        const config = join(home, "claude-config");
        const secure = join(home, "secure-store");
        const target = join(home, "secure-target");
        const alias = join(home, "secure-alias");
        const later = join(home, "secure-later");
        const dangling = join(home, "secure-dangling");
        for (const dir of [project, config, secure, target]) mkdirSync(dir);
        symlinkSync(target, alias);
        symlinkSync(later, dangling);
        const outside = new PermissionChecker(() => ({}), project);
        const checkOutside = (name: string, input: unknown) => outside.check(BUILTIN_TOOLS.find((t) => t.name === name)!, input, "auto", project).behavior;
        // The file Claude Code uses (by the selector's spelling and where it really is), for each setting.
        const cases: { secure?: string; config?: string; file: string; real: string }[] = [
            { secure, file: join(secure, ".credentials.json"), real: join(secure, ".credentials.json") },
            { secure: "", config, file: join(home, ".claude", ".credentials.json"), real: join(home, ".claude", ".credentials.json") },
            { config, file: join(config, ".credentials.json"), real: join(config, ".credentials.json") },
            { secure: alias, file: join(alias, ".credentials.json"), real: join(target, ".credentials.json") },
            { secure: dangling, file: join(dangling, ".credentials.json"), real: join(later, ".credentials.json") },
            // Claude Code uses its selector in NFC.
            { secure: join(home, "secure-cafe\u0301"), file: join(home, "secure-caf\u00e9", ".credentials.json"), real: join(home, "secure-caf\u00e9", ".credentials.json") },
        ];
        const set = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
        try {
            for (const c of cases) {
                set("CLAUDE_SECURESTORAGE_CONFIG_DIR", c.secure);
                set("CLAUDE_CONFIG_DIR", c.config);
                clear();
                // Without named accounts, Default is unchanged.
                expect({ ...c, read: checkOutside("Read", { file_path: c.file }), protectedPaths: accountProtectedPaths() }).toEqual({ ...c, read: "allow", protectedPaths: [] });
                // A named account of either CLI protects it, for Cavvy's tools and sandbox, and Claude Code's deny rules.
                saveAgentConfig("codex", { accounts: [{ id: "named", name: "Named", folder: join(home, "named"), managed: false }] });
                const decisions = Object.fromEntries([...new Set([c.file, c.real])].flatMap((file) => [
                    [`Read ${file}`, checkOutside("Read", { file_path: file })],
                    [`Write ${file}`, checkOutside("Write", { file_path: file, content: "x" })],
                    [`cat ${file}`, checkOutside("Bash", { command: `cat '${file}'` })],
                ]));
                expect({ ...c, decisions }).toEqual({ ...c, decisions: Object.fromEntries(Object.keys(decisions).map((k) => [k, "deny"])) });
                expect(sandboxPolicy([project], { cavvyHome: process.env.CAVVY_HOME! }).unreadable).toContain(c.real);
                expect(claudePermissions({ deny: [], ask: [], root: project }).deny).toContain(`Read(/${c.real})`);
            }
            // Only the sign-in file: the rest of a separate secure-storage folder stays usable.
            set("CLAUDE_SECURESTORAGE_CONFIG_DIR", secure);
            set("CLAUDE_CONFIG_DIR", undefined);
            expect(checkOutside("Read", { file_path: join(secure, "notes.md") })).toBe("allow");
            for (const tool of ["Glob", "LS"]) expect(checkOutside(tool, { path: secure, pattern: "*" })).toBe("allow");
            expect(checkOutside("Grep", { path: secure, pattern: "token" })).toBe("allow");
            expect(outside.hiddenFromSearch("Grep", join(secure, ".credentials.json"))).toBe("protected");
            // Codex's own sign-in file is independent of Claude's selectors.
            expect(checkOutside("Read", { file_path: join(home, ".codex", "auth.json") })).toBe("deny");
        } finally {
            set("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);
            set("CLAUDE_CONFIG_DIR", undefined);
            clear();
        }
        unchangedDefault();
    });

}
