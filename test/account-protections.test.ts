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
        expect(check("Grep", { pattern: ".", path: outside }).behavior).toBe("deny");
        expect(checker.hiddenFromSearch("Grep", join(folder, "auth.json"))).toBe("protected");
        expect(checker.isProtectedArea(outside)).toBe(true);
        expect(checker.isProtectedArea(join(folder, "backups"))).toBe(true);
    });

    test("shell paths, search roots, globs, quoting, redirects and aliases cannot expose accounts", () => {
        for (const command of [
            "cat alias/auth.json", "cat alias/.clau''de.json", "cat alias/*", "cat alias/.*",
            `rg . '${outside}'`, `find '${outside}' -type f`, `cd '${folder}' && cat auth.json`,
            `python -c 'open("${folder}/auth.json").read()'`, `echo x > '${folder}/auth.json'`,
            `cat '${dirname(folder)}'/per*/auth.json`,
        ]) expect(check("Bash", { command }, "bypassPermissions").behavior).toBe("deny");
        expect(accountTarget("rg marker", outside)).toBe(true);
        expect(accountTarget("cat source.ts", workspace)).toBe(false);
    });

    test("new sandbox policies protect external accounts and managed accounts beneath Harness home", () => {
        const policy = sandboxPolicy([workspace, outside], { harnessHome: isolated.home });
        expect(policy.readOnly).toContain(folder);
        expect(policy.unreadable).toContain(folder);
        expect(policy.readOnly).toContain(realpathSync(isolated.home));
        expect(policy.unreadable).toContain(realpathSync(isolated.home));
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


test("effective Default homes stay protected with named accounts selected, including symlinked missing homes", async () => {
    const { accountFolders } = await import("../src/providers/accounts");
    const { claudePermissions } = await import("../src/backends/claude-code");
    const { claudeAccountSandbox, accountPermissionConfig } = await import("../src/backends/account-permissions");
    const previous = [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME];
    const link = join(workspace, "default-homes");
    symlinkSync(outside, link);
    process.env.CLAUDE_CONFIG_DIR = join(link, "claude-default");
    process.env.CODEX_HOME = join(link, "codex-default");
    saveAgentConfig("codex", { accounts: [{ id: "personal", name: "Personal", folder, managed: false }], defaultAccount: "personal" });
    try {
        for (const name of ["claude-default", "codex-default"]) {
            const canonical = join(outside, name);
            expect(accountFolders()).toContain(canonical);
            for (const root of [canonical, join(link, name)]) {
                expect(check("Read", { file_path: join(root, "auth.json") }).behavior).toBe("deny");
                expect(check("Write", { file_path: join(root, "auth.json"), content: "x" }).behavior).toBe("deny");
                expect(check("Bash", { command: `cat '${root}/auth.json'` }).behavior).toBe("deny");
            }
            const policy = sandboxPolicy([workspace], { harnessHome: isolated.home });
            expect(policy.unreadable).toContain(canonical);
            expect(policy.readOnly).toContain(canonical);
            expect(claudePermissions({ deny: [], ask: [], root: workspace }).deny).toContain(`Read(/${canonical}/**)`);
            expect(claudeAccountSandbox()!.filesystem.denyRead).toContain(canonical);
            expect(claudeAccountSandbox()!.filesystem.denyWrite).toContain(canonical);
            for (const profile of Object.values(accountPermissionConfig([])!)) expect((profile as any).filesystem[canonical]).toBe("deny");
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
