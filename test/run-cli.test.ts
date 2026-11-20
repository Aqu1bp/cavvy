// runCli (src/backends/cli.ts): a short CLI command that's cancelled or runs out of time doesn't keep Cavvy waiting.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tempDir } from "./helpers/isolate";

const { runCli, stopTiming } = await import("../src/backends/cli");
const dir = tempDir("run-cli-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const script = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
};

test("cancelled before it starts: not started", async () => {
    const marker = join(dir, "started");
    const bin = script("touch", `touch "${marker}"`);
    const c = new AbortController();
    c.abort();
    await expect(runCli(bin, [], { signal: c.signal })).rejects.toThrow(/Cancelled/);
    await Bun.sleep(100);
    expect(existsSync(marker)).toBe(false);
});

test("one that ignores SIGTERM is killed, and one that left its pipes open isn't waited on", async () => {
    const saved = { ...stopTiming };
    Object.assign(stopTiming, { killMs: 200 });
    try {
        const stubborn = script("stubborn", "trap '' TERM\nwhile :; do sleep 0.05; done");
        let t = Date.now();
        const c = new AbortController();
        setTimeout(() => c.abort(), 100);
        await runCli(stubborn, [], { signal: c.signal });
        expect(Date.now() - t).toBeLessThan(2000);
        // Gone, but a process it started still holds its output: given up on once the kill's grace has passed.
        const leaver = script("leaver", "sleep 30 &\nexit 0");
        t = Date.now();
        const r = await runCli(leaver, [], { timeoutMs: 100 });
        expect(Date.now() - t).toBeLessThan(2000);
        expect(r.stdout).toBe("");
    } finally {
        Object.assign(stopTiming, saved);
    }
});
