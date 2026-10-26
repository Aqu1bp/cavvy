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
