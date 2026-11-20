// runCli (src/backends/cli.ts): a short CLI command that's cancelled or runs out of time doesn't keep Cavvy waiting.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
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

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

test("one that ignores SIGTERM is killed, and one that left its pipes open isn't waited on; neither reads as a success", async () => {
    const saved = { ...stopTiming };
    Object.assign(stopTiming, { killMs: 200 });
    const pidFile = join(dir, "stubborn.pid");
    try {
        const stubborn = script("stubborn", `echo $$ > "${pidFile}"\necho partial\ntrap '' TERM\nwhile :; do sleep 0.05; done`);
        let t = Date.now();
        const c = new AbortController();
        setTimeout(() => c.abort(), 150);
        const r1 = await runCli(stubborn, [], { signal: c.signal });
        expect(Date.now() - t).toBeLessThan(2000);
        expect(r1.code).not.toBe(0);
        // What it wrote before it was stopped is kept.
        expect(r1.stdout).toContain("partial");
        expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
        // Gone with exit 0, but a process it started still holds its output: given up on once the kill's grace has
        // passed, and not a success (a status check would otherwise read an empty answer as one).
        const leaver = script("leaver", `sleep 30 &\necho $! > "${pidFile}"\necho started\nexit 0`);
        t = Date.now();
        const r2 = await runCli(leaver, [], { timeoutMs: 100 });
        expect(Date.now() - t).toBeLessThan(2000);
        expect(r2.code).not.toBe(0);
        expect(r2.stdout).toContain("started");
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    } finally {
        Object.assign(stopTiming, saved);
    }
});
