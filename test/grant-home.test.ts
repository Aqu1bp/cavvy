// Bun caches homedir at startup; a grant for ~/.env is checked in a child with a temporary HOME.
import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, sep } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { Tool } from "../src/tools/types";

if (!process.env.HARNESS_TEST_GRANT_HOME) {
    test("a grant for ~/.env, in an isolated home", () => {
        const home = realpathSync(tempDir());
        try {
            const result = Bun.spawnSync([process.execPath, "--no-env-file", "test", import.meta.path], {
                env: { ...process.env, HOME: home, HARNESS_HOME: join(home, ".harness"), HARNESS_NO_KEYCHAIN: "1", HARNESS_TEST_GRANT_HOME: home },
                timeout: 15000,
            });
            expect({ code: result.exitCode, output: result.stderr.toString() }).toMatchObject({ code: 0 });
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
} else {
    const home = process.env.HARNESS_TEST_GRANT_HOME;
    if (!home.startsWith(realpathSync(tmpdir()) + sep) || home !== realpathSync(homedir())) throw new Error("Expected an isolated temporary home");
    isolate();
    const { PermissionChecker } = await import("../src/permissions/checker");
    const { BUILTIN_TOOLS } = await import("../src/tools/index");
    const Bash = BUILTIN_TOOLS.find((t) => t.name === "Bash") as Tool<any>;

    test("it covers ~/.env written out, not a quoted or escaped ~, which is a folder named ~", () => {
        const W = join(home, "work");
        mkdirSync(join(W, "~"), { recursive: true });
        writeFileSync(join(home, ".env"), "A=1\n");
        writeFileSync(join(W, "~", ".env"), "B=2\n");
        const c = new PermissionChecker(() => ({}), W, () => "seatbelt");
        c.applyGrant({ paths: [join(home, ".env")] });
        expect(c.check(Bash, { command: "cat ~/.env" }, "default", W).sensitive).toBeUndefined();
        for (const command of ["cat '~/.env'", 'cat "~/.env"', "cat \\~/.env", 'cat ~"/.env"', "cat '~'/.env"]) {
            expect([command, c.check(Bash, { command }, "default", W).sensitive]).toEqual([command, expect.any(String)]);
        }
    });
}
