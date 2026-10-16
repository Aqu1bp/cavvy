import { afterAll, expect, test } from "bun:test";
import { isolate, tempDir } from "./helpers/isolate";
const iso = isolate();
const { Terminals, terminalDescendants } = await import("../src/server/terminals");
afterAll(() => iso.cleanup());

test("terminal descendants exclude other processes and signal deepest children first", () => {
    expect(terminalDescendants("10 1\n20 10\n40 20\n30 10\n50 40\n99 1\ninvalid\n-1 10\n", 10)).toEqual([50, 40, 30, 20]);
    expect(terminalDescendants("10 1\n99 1", 10)).toEqual([]);
});

// macOS sandbox profiles can deny ps even though PTYs and ordinary shells work.
let canEnumerate = false;
try {
    canEnumerate = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid="], { stdout: "ignore", stderr: "ignore", timeout: 500 }).exitCode === 0;
} catch { /* Denied process enumeration: the integration case must run outside this sandbox. */ }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean) {
    const deadline = Date.now() + 6000;
    while (!check()) { if (Date.now() > deadline) throw new Error("Terminal process timed out"); await Bun.sleep(20); }
}

test.skipIf(!canEnumerate)("closing a terminal kills and reaps a foreground job that ignores HUP (requires ps)", async () => {
    const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME };
    process.env.SHELL = "/bin/sh";
    process.env.HOME = tempDir("terminal-process-home-");
    const shells = new Terminals();
    let output = ""; let pid = 0;
    const owner = { send(event: { type: string; data?: string }) { if (event.type === "terminal.data") output += event.data; } };
    try {
        shells.open(owner, "job", iso.home, 80, 24);
        shells.write(owner, "job", `/bin/sh -c 'trap "" HUP; printf "__job__%s\\n" $$; while :; do :; done'\n`);
        await until(() => /__job__\d+/.test(output));
        pid = Number(output.match(/__job__(\d+)/)![1]);
        shells.close(owner, "job");
        await shells.stop();
        await until(() => !alive(pid));
    } finally {
        await shells.stop();
        if (pid && alive(pid)) process.kill(pid, "SIGKILL");
        for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
}, 15_000);
