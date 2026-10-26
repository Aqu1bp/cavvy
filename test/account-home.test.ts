// Bun caches homedir at startup; reproduce desktop startup in a child with a temporary HOME.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join, sep } from "path";
import { isolate, tempDir } from "./helpers/isolate";

if (!process.env.HARNESS_TEST_ACCOUNT_HOME) {
    test("desktop account folders in an isolated home", () => {
        const home = realpathSync(tempDir());
        try {
            const result = Bun.spawnSync([process.execPath, "--no-env-file", "test", import.meta.path], {
                env: { ...process.env, HOME: home, HARNESS_HOME: join(home, ".harness"), HARNESS_NO_KEYCHAIN: "1", HARNESS_TEST_ACCOUNT_HOME: home },
                timeout: 15000,
            });
            expect({ code: result.exitCode, output: result.stderr.toString() }).toMatchObject({ code: 0 });
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
} else {
    const home = process.env.HARNESS_TEST_ACCOUNT_HOME;
    if (!home.startsWith(realpathSync(tmpdir()) + sep) || home !== realpathSync(homedir())) throw new Error("Expected an isolated temporary home");
    const iso = isolate();
    process.env.HARNESS_HOME = join(home, ".harness");
    mkdirSync(join(home, ".git"));
    const { addAccount, removeAccount, accountEnv } = await import("../src/providers/accounts");
    const { Engine } = await import("../src/server/engine");
    const client = { subs: new Set<string>(), send() {} };
    afterAll(() => iso.cleanup());

    test("relative default selectors reserve home, launch cwd and every supplied project root", () => {
        const roots = [home, join(home, "open-project")];
        mkdirSync(roots[1]!, { recursive: true });
        for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CODEX_HOME"]) {
            const previous = process.env[key];
            process.env[key] = "profile";
            try {
                for (const root of [process.cwd(), ...roots]) {
                    expect(() => addAccount("claude-code", { id: "relative", name: "Relative", folder: join(root, "profile") }, roots)).toThrow(/default CLI folder/);
                }
                // Only the selector's own CLI refuses it; the other launches without it.
                const owner = key === "CODEX_HOME" ? "codex" : "claude-code";
                expect(() => accountEnv(owner)).toThrow(new RegExp(`relative ${key}.*absolute path`));
                expect(accountEnv(owner === "codex" ? "claude-code" : "codex")).not.toHaveProperty(key);
            } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
        }
    });

    test("restart from another cwd cannot delete a managed folder reached by a relative selector", () => {
        const a = addAccount("claude-code", { id: "work", name: "Work" });
        const sentinel = join(a.folder, "sentinel"); writeFileSync(sentinel, "keep");
        const cwd = process.cwd();
        const elsewhere = join(home, "elsewhere"); mkdirSync(elsewhere);
        try {
            process.chdir(elsewhere);
            for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CODEX_HOME"]) {
                const previous = process.env[key];
                process.env[key] = ".harness/accounts/claude-code/work";
                try {
                    expect(() => removeAccount("claude-code", a.id, a.folder)).toThrow(/default CLI folder/);
                    expect(existsSync(sentinel)).toBe(true);
                } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
            }
        } finally { process.chdir(cwd); removeAccount("claude-code", a.id, a.folder); }
    });

    for (const provider of ["claude-code", "codex"]) test(`${provider}: broad home roots allow accounts but repositories and project roots remain protected`, () => {
        const previousHarness = process.env.HARNESS_HOME;
        process.env.HARNESS_HOME = join(home, ".harness");
        try {
            // A dotfiles repository at home must not turn the whole home into a project.
            const roots = [home, dirname(home), process.env.HARNESS_HOME, join(process.env.HARNESS_HOME, "accounts", provider)];
            const managed = addAccount(provider, { id: "desktop", name: "Desktop" }, roots);
            removeAccount(provider, managed.id, managed.folder, roots);
            expect(existsSync(managed.folder)).toBe(false);
            const external = addAccount(provider, { id: "external", name: "External", folder: join(home, `${provider}-cli-home`) }, [home]);
            removeAccount(provider, external.id, external.folder, [home]);
            expect(existsSync(external.folder)).toBe(true);

            const repo = join(home, `${provider}-repo`);
            mkdirSync(repo); writeFileSync(join(repo, ".git"), "gitdir: elsewhere");
            const project = join(home, `${provider}-project`); mkdirSync(project);
            process.env.HARNESS_HOME = join(project, "state");
            expect(() => addAccount(provider, { id: "chosen", name: "Chosen", folder: join(project, "cli-home") }, [project])).toThrow(/projects/);
            const managedInProject = addAccount(provider, { id: "managed", name: "Managed" }, [project]);
            removeAccount(provider, managedInProject.id, managedInProject.folder, [project]);
            expect(existsSync(managedInProject.folder)).toBe(false);
            process.env.HARNESS_HOME = join(home, ".harness");
            const alias = join(home, `${provider}-repo-link`); symlinkSync(repo, alias);
            for (const folder of [repo, join(repo, "account"), join(alias, "account"), project, join(project, "account")]) {
                expect(() => addAccount(provider, { id: "refused", name: "Refused", folder }, [...roots, project])).toThrow(/projects/);
            }
            // A managed home inside a repository is still usable; chosen folders are not exempt.
            process.env.HARNESS_HOME = join(repo, "state");
            const nested = addAccount(provider, { id: "nested", name: "Nested" }, [repo]);
            removeAccount(provider, nested.id, nested.folder, [repo]);
            expect(existsSync(nested.folder)).toBe(false);
            expect(() => addAccount(provider, { id: "chosen", name: "Chosen", folder: join(repo, "state", "chosen") }, [repo])).toThrow(/projects/);
        } finally {
            process.env.HARNESS_HOME = previousHarness;
        }
    });

    for (const provider of ["claude-code", "codex"]) test(`${provider}: desktop home cwd and home workspace allow managed add and remove`, async () => {
        const previousHarness = process.env.HARNESS_HOME;
        process.env.HARNESS_HOME = join(home, ".harness");
        const engine = new Engine({ startCwd: home, listModels: async () => [] });
        // Exercise both sources of accountProjects without starting a CLI or reading project config.
        engine.workspaces.set(home, { cwd: home } as any);
        try {
            const providers = await engine.handle(client, "providers.list", {});
            expect(providers.find((p: any) => p.id === provider)?.agentCli?.accounts).toMatchObject([{ id: "default", managed: false }]);
            const added = await engine.handle(client, "accounts.add", { provider, id: "desktop", name: "Desktop" });
            expect(added.managed).toBe(true);
            expect(existsSync(added.folder)).toBe(true);
            await engine.handle(client, "accounts.remove", { provider, id: added.id, confirmedFolder: added.folder });
            expect(existsSync(added.folder)).toBe(false);
            expect(await engine.handle(client, "accounts.list", { provider })).toHaveLength(1);
        } finally {
            engine.workspaces.clear();
            await engine.stop();
            process.env.HARNESS_HOME = previousHarness;
        }
    });
}
