import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Run before test modules import application code, without replacing explicit isolation.
if (!process.env.CAVVY_HOME) {
    const home = mkdtempSync(join(tmpdir(), "cavvy-test-preload-"));
    process.env.CAVVY_HOME = home;
    ((globalThis as { __cavvyTestDirs?: string[] }).__cavvyTestDirs ??= []).push(home);
    process.on("exit", () => {
        try { rmSync(home, { recursive: true, force: true }); } catch { /* Best-effort cleanup. */ }
    });
}
process.env.CAVVY_NO_KEYCHAIN ??= "1";
// No real inhibitor while tests run turns (src/agent/keep-awake.ts): bun test runs no "exit" handlers to stop it.
process.env.CAVVY_NO_KEEP_AWAKE ??= "1";

// After the last test file: the folders test/helpers/isolate.ts made (`bun test` doesn't run "exit" handlers).
afterAll(() => {
    if (process.env.CAVVY_KEEP_TEST_DIRS) return;
    for (const d of (globalThis as { __cavvyTestDirs?: string[] }).__cavvyTestDirs?.splice(0) ?? []) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* Best effort. */ }
    }
});
