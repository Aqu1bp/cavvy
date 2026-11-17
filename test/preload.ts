import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Run before test modules import application code, without replacing explicit isolation.
if (!process.env.CAVVY_HOME) {
    const home = mkdtempSync(join(tmpdir(), "cavvy-test-preload-"));
    process.env.CAVVY_HOME = home;
    process.on("exit", () => {
        try { rmSync(home, { recursive: true, force: true }); } catch { /* Best-effort cleanup. */ }
    });
}
process.env.CAVVY_NO_KEYCHAIN ??= "1";
// Tests never build or run the real Mac app helper (src/desktop/helper.ts): each run of it can add an entry to
// macOS's privacy lists. A live run opts in with CAVVY_DESKTOP_LIVE=1. A test that reached for it fails, even where
// the refusal was caught on the way.
process.env.CAVVY_TEST = "1";
afterEach(() => {
    const g = globalThis as Record<symbol, number>;
    const refused = g[Symbol.for("cavvy.desktop.realHelperRefused")];
    if (!refused) return;
    g[Symbol.for("cavvy.desktop.realHelperRefused")] = 0;
    throw new Error("This test reached for the real Cavvy Desktop Control: use a fake helper (setDesktopHelperStarter), or set CAVVY_DESKTOP_LIVE=1 for a live run.");
});
