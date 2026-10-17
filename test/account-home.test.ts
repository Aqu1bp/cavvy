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
    const { addAccount, removeAccount } = await import("../src/providers/accounts");
    const { Engine } = await import("../src/server/engine");
    const client = { subs: new Set<string>(), send() {} };
    afterAll(() => iso.cleanup());

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
