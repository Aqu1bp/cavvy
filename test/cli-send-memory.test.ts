// What's written to a CLI isn't kept until it exits. Each send used to race its write against the process's exit:
// that race's reaction stayed on `exited` while the CLI ran, holding the call's scope and the line sent (every prompt,
// every file an @-mention attached: 14.8 MB of a real run's server heap after 75 minutes, 4 sessions).

import { expect, test } from "bun:test";

const { JsonLinesProcess } = await import("../src/backends/cli");

/** Sent, then let go of by the caller: collected unless something the send left behind holds it. */
async function sendAll(p: InstanceType<typeof JsonLinesProcess>, n: number): Promise<WeakRef<object>[]> {
    const refs: WeakRef<object>[] = [];
    for (let i = 0; i < n; i++) {
        const line = { type: "user", message: { role: "user", content: [{ type: "text", text: `${i} `.padEnd(50_000, "x") }] } };
        refs.push(new WeakRef(line));
        expect(await p.send(line)).toBe(true);
    }
    return refs;
}

test("a line sent to a running CLI is let go of once it's written, not kept until the CLI exits", async () => {
    // A CLI that takes what it's sent and goes on running.
    const p = new JsonLinesProcess("sh", ["-c", "cat > /dev/null"], { cwd: process.cwd() });
    try {
        const refs = await sendAll(p, 40);
        await Bun.sleep(10);
        for (let i = 0; i < 4; i++) {
            Bun.gc(true);
            await Bun.sleep(0);
        }
        expect(p.hasExited).toBe(false);
        // The collector may keep one or two it sees on the stack; kept by the sends, it kept all 40.
        expect(refs.filter((r) => r.deref() !== undefined).length).toBeLessThanOrEqual(2);
    } finally {
        await p.stop(500);
    }
});

test("a send to a CLI that exits while it's written says it wasn't taken, and one after says so at once", async () => {
    const p = new JsonLinesProcess("sh", ["-c", "exit 0"], { cwd: process.cwd() });
    await p.exited;
    expect(await p.send({ type: "user" })).toBe(false);
    // One that waits on the pipe: settled by the exit, not left waiting.
    const q = new JsonLinesProcess("sh", ["-c", "sleep 0.2"], { cwd: process.cwd() });
    const big = { text: "y".repeat(4 << 20) };
    expect(await Promise.race([q.send(big), Bun.sleep(5000).then(() => "hung")])).toBe(false);
});
