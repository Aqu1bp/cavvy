// A live Codex app-server (#219) serves several turns, so a test that changes
// the fakes' FAKE_* settings between turns writes them to a file the fake reads
// again with every message (FAKE_ENV_FILE, test/fixtures/fake-codex.ts).

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * What a fake CLI has logged to `file` (FAKE_LOG), a line each. Whole lines only: a fake still running may be partway
 * through writing its last one, and half a line doesn't parse. The next read has it.
 */
export function fakeLog(file: string | undefined): any[] {
    if (!file || !existsSync(file)) return [];
    const text = readFileSync(file, "utf-8");
    return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Point the fakes at `dir`/fake-env.json; `write()` saves the FAKE_* settings as this process has them now. */
export function fakeEnvFile(dir: string): { path: string; write(): void } {
    const path = join(dir, "fake-env.json");
    process.env.FAKE_ENV_FILE = path;
    return {
        path,
        write() {
            process.env.FAKE_ENV_FILE = path;
            writeFileSync(path, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("FAKE_") && k !== "FAKE_ENV_FILE" && k !== "FAKE_LOG"))));
        },
    };
}

/** Stop every live Codex app-server (as Cavvy quitting does): the next turn starts one that resumes its thread. */
export async function stopLiveCodex(): Promise<void> {
    await (await import("../../src/backends/codex-live")).shutdownCodexLive();
}
