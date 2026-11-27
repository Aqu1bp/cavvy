// Test isolation. Call isolate() at the top of every test file, BEFORE any
// src module is imported (src modules are loaded with dynamic import()).
//
// - CAVVY_HOME points at a fresh temp dir, so ~/.cavvy is never touched.
// - CAVVY_NO_KEYCHAIN keeps the credential store off the OS keychain.
// - CAVVY_BROWSER names no browser, so the Browser tools aren't offered unless a test sets it.
// - CAVVY_SIMULATOR=0 hides the Mac's simulators, so the Simulator tools aren't offered unless a test fakes them.
// - Every API-key-like variable is removed from the environment.
// - CLI config and secure-storage selectors point at fresh empty folders, so nothing
//   (listing CLI sessions, say) can reach the real Claude Code or Codex stores.
//
// This module must not import anything from src.

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";

const SECRETISH = /(_API_KEY|_AUTH_TOKEN|_BASE_URL)$/;

/**
 * Every folder made here, removed once the tests are done (test/preload.ts, after the last file) or the process
 * exits: a whole run left about 10,000 behind. CAVVY_KEEP_TEST_DIRS=1 keeps them, to look at.
 */
const made: string[] = ((globalThis as { __cavvyTestDirs?: string[] }).__cavvyTestDirs ??= []);
let hooked = false;
function track(dir: string): string {
    made.push(dir);
    if (!hooked) {
        hooked = true;
        process.on("exit", removeTestDirs);
    }
    return dir;
}
export function removeTestDirs() {
    if (process.env.CAVVY_KEEP_TEST_DIRS) return;
    for (const d of made.splice(0)) {
        try {
            rmSync(d, { recursive: true, force: true });
        } catch {
            // Best effort: one still in use is left.
        }
    }
}
const EXTRA = ["API_KEY", "BASE_URL", "MODEL", "CAVVY_MODEL"];

export function isolate(): { home: string; cleanup: () => void } {
    const home = track(mkdtempSync(join(tmpdir(), "cavvy-test-")));
    if (!resolve(home).startsWith(resolve(tmpdir()) + sep)) throw new Error(`refusing to use ${home} as CAVVY_HOME`);
    process.env.CAVVY_HOME = home;
    process.env.CAVVY_NO_KEYCHAIN = "1";
    // No test finds the machine's own Chrome (the Browser tools would be offered, and served to agent CLIs, wherever one is
    // installed): only a test that points CAVVY_BROWSER at one gets a browser.
    process.env.CAVVY_BROWSER = join(home, "no-browser");
    // Nor the Mac's own simulators (the Simulator tools would be offered wherever Xcode is): a test that wants them fakes them.
    process.env.CAVVY_SIMULATOR = "0";
    const claude = track(mkdtempSync(join(tmpdir(), "cavvy-test-claude-")));
    const codex = track(mkdtempSync(join(tmpdir(), "cavvy-test-codex-")));
    const agents = track(mkdtempSync(join(tmpdir(), "cavvy-test-agents-")));
    process.env.CLAUDE_CONFIG_DIR = claude;
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = claude;
    process.env.CODEX_HOME = codex;
    process.env.CAVVY_AGENTS_HOME = agents;
    delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    for (const k of Object.keys(process.env)) {
        if (SECRETISH.test(k) || EXTRA.includes(k)) delete process.env[k];
    }
    return {
        home,
        cleanup: () => {
            for (const d of [home, claude, codex, agents]) rmSync(d, { recursive: true, force: true });
        },
    };
}

/** A fresh temp directory (project dirs, .env files, ...). */
export function tempDir(prefix = "cavvy-test-"): string {
    return track(mkdtempSync(join(tmpdir(), prefix)));
}

// Fake keys only. None of these are real credentials.
export const FAKE = {
    anthropic: "sk-ant-api03-" + "x".repeat(40),
    openai: "sk-proj-" + "x".repeat(40),
    openrouter: "sk-or-v1-" + "a".repeat(64),
    gemini: "AIza" + "x".repeat(35),
    deepseek: "sk-" + "a".repeat(32),
};
