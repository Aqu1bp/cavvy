import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { PermissionMode } from "../src/permissions/modes";

const isolated = isolate();
const workspace = realpathSync(tempDir());
const outside = realpathSync(tempDir());
const { saveAgentConfig } = await import("../src/providers/registry");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const { sandboxPolicy, sandboxArgv, sandboxKind, seatbeltProfile } = await import("../src/permissions/sandbox");
const { accountTarget } = await import("../src/permissions/bash-safety");
const checker = new PermissionChecker(() => ({}), workspace);
const tool = (name: string) => BUILTIN_TOOLS.find((t) => t.name === name)!;
const check = (name: string, input: unknown, mode: PermissionMode = "auto", cwd = workspace) => checker.check(tool(name), input, mode, cwd);
const folder = join(outside, "personal");
mkdirSync(folder);
for (const name of ["auth.json", ".credentials.json", ".claude.json"]) writeFileSync(join(folder, name), "fake-account-marker");
const alias = join(workspace, "alias");
symlinkSync(folder, alias);
const managed = join(isolated.home, "accounts", "codex", "managed");
mkdirSync(managed, { recursive: true });
writeFileSync(join(managed, "auth.json"), "fake-managed-marker");

afterAll(() => {
    isolated.cleanup();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
});

describe("CLI account folder protections", () => {
    test("a folder added after the checker was created is immediately denied", () => {
        expect(check("Read", { file_path: join(folder, "auth.json") }).behavior).toBe("allow");
        saveAgentConfig("codex", { accounts: [{ id: "personal", name: "Personal", folder, managed: false }] });
        for (const mode of ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as PermissionMode[]) {
            for (const root of [folder, alias, managed]) {
                for (const name of ["auth.json", ".credentials.json", ".claude.json", "backups/old"]) {
                    expect(check("Read", { file_path: join(root, name) }, mode).behavior).toBe("deny");
                    expect(check("Write", { file_path: join(root, name), content: "x" }, mode).behavior).toBe("deny");
                    expect(check("Bash", { command: `cat '${join(root, name)}'` }, mode).behavior).toBe("deny");
                }
                expect(check("Grep", { pattern: ".", path: root }, mode).behavior).toBe("deny");
            }
        }
        // A folder that merely holds an account is searched as without accounts (#375); the account is hidden in it.
        expect(check("Grep", { pattern: ".", path: outside }).behavior).toBe("allow");
        expect(checker.hiddenFromSearch("Grep", join(folder, "auth.json"))).toBe("protected");
        expect(checker.hiddenFromSearch("Grep", outside)).toBeUndefined();
        expect(checker.isProtectedArea(outside)).toBe(true);
        expect(checker.isProtectedArea(join(folder, "backups"))).toBe(true);
    });

    test("shell paths, search roots, globs, quoting, redirects and aliases cannot expose accounts", () => {
        for (const command of [
            "cat alias/auth.json", "cat alias/.clau''de.json", "cat alias/*", "cat alias/.*",
            `rg . '${folder}'`, `find '${folder}' -type f`, `cd '${folder}' && cat auth.json`,
            `python -c 'open("${folder}/auth.json").read()'`, `echo x > '${folder}/auth.json'`,
            `cat '${dirname(folder)}'/per*/auth.json`,
        ]) expect(check("Bash", { command }, "bypassPermissions").behavior).toBe("deny");
        expect(accountTarget("rg marker", folder)).toBe(true);
        // Searches of a folder that merely holds an account decide as without accounts (#375).
        for (const command of [`rg . '${outside}'`, `find '${outside}' -type f`, `ls -la '${outside}'`]) expect(check("Bash", { command }, "bypassPermissions").behavior).toBe("allow");
        expect(accountTarget("rg marker", outside)).toBe(false);
        expect(accountTarget("cat source.ts", workspace)).toBe(false);
    });

    test("new sandbox policies protect external accounts and managed accounts beneath Harness home", () => {
        const policy = sandboxPolicy([workspace, outside], { harnessHome: isolated.home });
        expect(policy.readOnly).toContain(folder);
        expect(policy.unreadable).toContain(folder);
        expect(policy.readOnly).toContain(realpathSync(isolated.home));
        // Only the secrets in it are unreadable, managed accounts included.
        expect(policy.unreadable).toContain(join(realpathSync(isolated.home), "accounts"));
        expect(policy.unreadable).not.toContain(realpathSync(isolated.home));
        const later = join(outside, "later");
        mkdirSync(later);
        saveAgentConfig("claude-code", { accounts: [{ id: "later", name: "Later", folder: later, managed: false }] });
        expect(sandboxPolicy([workspace], { harnessHome: isolated.home }).unreadable).toContain(later);
    });

    test.skipIf(!sandboxKind())("sandboxed commands cannot read or write either account location", () => {
        const kind = sandboxKind()!;
        const policy = sandboxPolicy([workspace, outside], { harnessHome: isolated.home });
        for (const root of [folder, managed]) {
            for (const script of [`cat '${root}/auth.json'`, `printf changed > '${root}/auth.json'`, `touch '${root}/new'`]) {
                const result = Bun.spawnSync(sandboxArgv({ kind, policy }, "/bin/sh", script), { cwd: workspace, env: { PATH: "/usr/bin:/bin" } });
                expect(result.exitCode).not.toBe(0);
                expect(result.stdout.toString()).not.toContain("fake-");
            }
        }
    });
});


test("only effective Default credentials are protected, including symlinked missing homes", async () => {
    const { accountFolders } = await import("../src/providers/accounts");
    const { claudePermissions } = await import("../src/backends/claude-code");
    const previous = [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME];
    const link = join(workspace, "default-homes");
    symlinkSync(outside, link);
    process.env.CLAUDE_CONFIG_DIR = join(link, "claude-default");
    process.env.CODEX_HOME = join(link, "codex-default");
    saveAgentConfig("codex", { accounts: [{ id: "personal", name: "Personal", folder, managed: false }], defaultAccount: "personal" });
    try {
        for (const [name, credential] of [["claude-default", ".credentials.json"], ["codex-default", "auth.json"]]) {
            const canonical = join(outside, name!);
            const secret = join(canonical, credential!);
            expect(accountFolders()).not.toContain(canonical);
            for (const root of [canonical, join(link, name!)]) {
                for (const mode of ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as PermissionMode[]) {
                    expect(check("Read", { file_path: join(root, credential!) }, mode).behavior).toBe("deny");
                    expect(check("Write", { file_path: join(root, credential!), content: "x" }, mode).behavior).toBe("deny");
                    expect(check("Bash", { command: `cat '${root}/${credential}'` }, mode).behavior).toBe("deny");
                    for (const file of [".claude.json", "settings.json", "CLAUDE.md", "skills/example.md", "plugins/example.json", "config.toml"]) {
                        expect(check("Read", { file_path: join(root, file) }, mode).behavior).not.toBe("deny");
                        expect(accountTarget(`cat '${root}/${file}'`, workspace)).toBe(false);
                    }
                }
            }
            const policy = sandboxPolicy([workspace], { harnessHome: isolated.home });
            expect(policy.unreadable).toContain(secret);
            expect(policy.readOnly).toContain(secret);
            expect(policy.unreadable).not.toContain(canonical);
            const deny = claudePermissions({ deny: [], ask: [], root: workspace }).deny;
            expect(deny).toContain(`Read(/${secret})`);
            expect(deny).not.toContain(`Read(/${canonical}/**)`);
            // Resolve individual credential-file symlinks as well as home aliases.
            mkdirSync(canonical);
            const target = join(outside, `${name}-credential`);
            writeFileSync(target, "fake-default-marker");
            symlinkSync(target, secret);
            expect(check("Read", { file_path: target }).behavior).toBe("deny");
            expect(accountTarget(`cat '${target}'`, workspace)).toBe(true);
            expect(sandboxPolicy([workspace], { harnessHome: isolated.home }).unreadable).toContain(target);
            expect(claudePermissions({ deny: [], ask: [], root: workspace }).deny).toContain(`Read(/${target})`);
        }
    } finally {
        [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME] = previous;
        saveAgentConfig("codex", { defaultAccount: "default" });
    }
});

test("account ancestors inside writable roots cannot be renamed, while siblings stay writable", () => {
    const ancestor = join(outside, "container", "nested");
    const nested = join(ancestor, "account");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "auth.json"), "fake-nested-marker");
    saveAgentConfig("claude-code", { accounts: [{ id: "nested", name: "Nested", folder: nested, managed: false }] });
    const policy = sandboxPolicy([workspace, outside], { harnessHome: isolated.home });
    const profile = seatbeltProfile(policy);
    for (const path of [outside, join(outside, "container"), ancestor, nested, realpathSync(isolated.home)]) {
        expect(profile).toContain(`(literal "${path}")`);
    }
    expect(profile).not.toContain(`(subpath "${ancestor}")`);
    if (sandboxKind() === "seatbelt") {
        const moved = join(outside, "moved");
        const result = Bun.spawnSync(sandboxArgv({ kind: "seatbelt", policy }, "/bin/sh", `mv '${ancestor}' '${moved}' && cat '${moved}/account/auth.json'`));
        expect(result.exitCode).not.toBe(0);
        expect(Bun.spawnSync(sandboxArgv({ kind: "seatbelt", policy }, "/bin/sh", `touch '${ancestor}/sibling'`)).exitCode).toBe(0);
    }
});


test("searches and listings name an account only by what they name, wherever they start (#375)", () => {
    const unrelated = join(outside, "public");
    mkdirSync(unrelated);
    for (const command of [
        `ls '${unrelated}'`, `ls -la '${unrelated}'`, `tree '${unrelated}'`, `find '${unrelated}' -type f`,
        `rg marker '${unrelated}'`, `rg -m 2 marker '${unrelated}'`, `rg -e marker '${unrelated}'`, `rg --context 2 marker '${unrelated}'`, `rg --color always marker '${unrelated}'`, `rg --files --color never '${unrelated}'`,
        `grep -R marker '${unrelated}'`, `fd marker '${unrelated}'`,
        `rg -g '*.ts' marker '${unrelated}'`, `rg --glob '*.ts' --stats marker '${unrelated}'`,
        `rg --iglob '*.TS' -t ts marker '${unrelated}'`, `rg --glob='*.ts' --type=ts marker '${unrelated}'`,
        `rg --stats marker '${unrelated}'`, `env rg --stats -g '*.ts' marker '${unrelated}'`,
        `grep -R --include '*.ts' --exclude '*.json' marker '${unrelated}'`,
        `grep -R --include='*.ts' --exclude='*.json' marker '${unrelated}'`,
        `ls --ignore '*.ts' '${unrelated}'`, `rsync -a --exclude '*.ts' '${unrelated}' /tmp/copy`,
        `tar -cf /tmp/copy.tar --exclude '*.ts' '${unrelated}'`,
    ]) expect({ command, blocked: accountTarget(command, outside) }).toEqual({ command, blocked: false });
    // A cwd, or an operand, that merely holds an account is searched as without accounts.
    for (const command of ["ls", "ls -la", "ls -w 80", "ls -T 8", "tree", "find -type f", "rg marker", "rg -g '*.ts' marker", "rg -e marker", "rg --files", "rg --context 2 marker", "rg --color always marker", "rg --files --color never", "grep -R marker", "fd marker", "ag --depth 2 marker", "ack --max-count 2 marker", "fd --max-results 1 marker", "ls --width 80", "tree --sort name", `rg marker '${outside}'`, `find '${outside}' -type f`]) {
        expect({ command, blocked: accountTarget(command, outside) }).toEqual({ command, blocked: false });
    }
    // Naming the account, starting in it, or a pattern that can match into it still counts.
    for (const command of [`ls '${folder}'`, `ls '${unrelated}' '${folder}'`, "rg marker personal", "cat */auth.json", "ls * | xargs cat", "find * -exec cat {} +"]) {
        expect({ command, blocked: accountTarget(command, outside) }).toEqual({ command, blocked: true });
    }
    for (const command of ["ls", "rg marker", "find -type f"]) expect(accountTarget(command, folder)).toBe(true);
});


test("recursive copies and archives cannot read a folder containing a named account", () => {
    for (const command of [
        "cp -r . /tmp/copy", "cp -R . /tmp/copy", "cp -a . /tmp/copy", "cp --recursive . /tmp/copy",
        "rsync -a . /tmp/copy", "tar cf /tmp/copy.tar .", "tar -rf /tmp/copy.tar .", "tar --update -f /tmp/copy.tar .",
        "zip -r /tmp/copy.zip .", "ditto . /tmp/copy", "cpio -o .", "pax -w .", "scp -r . host:copy", "rclone copy . remote:copy",
    ]) expect({ command, blocked: accountTarget(command, outside) }).toEqual({ command, blocked: true });
    expect(accountTarget("cp source.ts /tmp/copy", outside)).toBe(false);
});

test("copy destinations and archive outputs do not recursively read account ancestors", () => {
    const project = join(outside, "project");
    mkdirSync(join(project, "src"), { recursive: true });
    for (const command of [
        "cp -r src ..", "rsync -a src ../", "scp -r src ..", "ditto src ..", "rclone copy src ..",
        "cp -r -t .. src", "cp -rt.. src", "cp -r --target-directory .. src", "cp -r --target-directory=.. src",
        "cp -r src --target-directory=..", "cp -r -- src ..", "cp -r src .. -v", "rsync -a src ../ --verbose",
        "tar -cf .. src", "tar cf .. src", "tar -cf.. src", "tar --create --file=.. src", "zip -r .. src",
    ]) expect({ command, blocked: accountTarget(command, project) }).toEqual({ command, blocked: false });
    for (const command of [
        "cp -r .. src", "rsync -a ../ src", "scp -r .. src", "ditto .. src", "rclone copy .. src",
        "cp -r -t src ..", "cp -r --target-directory=src ..", "cp -r src .. /tmp/copy",
        "cp -r src .. --target-dir=/tmp/copy", "cp -r src .. --target-dir /tmp/copy",
        "rclone cat ..", "rclone ls ..", "rsync -a --port 123 ..", "rsync -a src .. --list-only",
        "tar -cf copy.tar ..", "tar cf copy.tar ..", "tar -cfcopy.tar ..", "tar --create --file=copy.tar ..", "zip -r copy.zip ..",
        "cp -r src ../personal", "rsync -a src ../personal/", "scp -r src ../personal", "ditto src ../personal", "rclone copy src ../personal",
        "cp -rt../personal src", "cp -r --target-directory=../personal src",
        "tar -cf../personal/copy.tar src", "tar --create --file=../personal/copy.tar src", "zip -r ../personal/copy.zip src",
    ]) expect({ command, blocked: accountTarget(command, project) }).toEqual({ command, blocked: true });
});
