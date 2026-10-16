import { expect, test } from "bun:test";
import { join } from "path";

// In a fresh `bun test` with neither variable set, so an inherited environment
// can't stand in for the preload; it reads the project's bunfig.toml as every run does.
test("bun test's preload isolates the home and disables the keychain", () => {
    const env = { ...process.env };
    delete env.HARNESS_HOME;
    delete env.HARNESS_NO_KEYCHAIN;
    const root = join(import.meta.dir, "..");
    const r = Bun.spawnSync([process.execPath, "test", "./test/fixtures/preload-probe.test.ts"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    expect(r.stderr.toString()).toContain("1 pass");
    expect(r.exitCode).toBe(0);
}, 20_000);
