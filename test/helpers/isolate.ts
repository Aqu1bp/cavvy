// Test isolation. Call isolate() at the top of every test file, BEFORE any
// src module is imported (src modules are loaded with dynamic import()).
//
// - HARNESS_HOME points at a fresh temp dir, so ~/.harness is never touched.
// - HARNESS_NO_KEYCHAIN keeps the credential store off the OS keychain.
// - Every API-key-like variable is removed from the environment.
//
// This module must not import anything from src.

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";

const SECRETISH = /(_API_KEY|_AUTH_TOKEN|_BASE_URL)$/;
const EXTRA = ["API_KEY", "BASE_URL", "MODEL", "HARNESS_MODEL"];

export function isolate(): { home: string; cleanup: () => void } {
    const home = mkdtempSync(join(tmpdir(), "harness-test-"));
    if (!resolve(home).startsWith(resolve(tmpdir()) + sep)) throw new Error(`refusing to use ${home} as HARNESS_HOME`);
    process.env.HARNESS_HOME = home;
    process.env.HARNESS_NO_KEYCHAIN = "1";
    for (const k of Object.keys(process.env)) {
        if (SECRETISH.test(k) || EXTRA.includes(k)) delete process.env[k];
    }
    return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** A fresh temp directory (project dirs, .env files, ...). */
export function tempDir(prefix = "harness-test-"): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

// Fake keys only. None of these are real credentials.
export const FAKE = {
    anthropic: "sk-ant-api03-" + "x".repeat(40),
    openai: "sk-proj-" + "x".repeat(40),
    openrouter: "sk-or-v1-" + "a".repeat(64),
    gemini: "AIza" + "x".repeat(35),
    deepseek: "sk-" + "a".repeat(32),
};
