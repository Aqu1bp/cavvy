import { expect, test } from "bun:test";
import { JsonLinesProcess } from "../src/backends/cli";

// A process that writes two results and exits, leaving a child that holds stdout open for 5 s.
const script = `echo '{"n":1}'; echo '{"n":2}'; (sleep 5) & exit 0`;

test("after the process exits, everything it wrote is read even by a slow reader, then reading ends once output goes quiet", async () => {
    const proc = new JsonLinesProcess("/bin/sh", ["-c", script], { cwd: process.cwd(), env: process.env as Record<string, string> });
    const started = Date.now();
    const seen: unknown[] = [];
    for await (const m of proc.messages({ quietAfterExitMs: 100 })) {
        seen.push(m);
        // Slower than the quiet period: what was already written must still come.
        await Bun.sleep(400);
    }
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    // The child holds stdout for 5 s; reading ended long before.
    expect(Date.now() - started).toBeLessThan(3000);
    await proc.kill();
});

test("without the option, reading waits for stdout to end", async () => {
    const proc = new JsonLinesProcess("/bin/sh", ["-c", `echo '{"n":1}'; (sleep 1) & exit 0`], { cwd: process.cwd(), env: process.env as Record<string, string> });
    const started = Date.now();
    const seen: unknown[] = [];
    for await (const m of proc.messages()) seen.push(m);
    expect(seen).toEqual([{ n: 1 }]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
});
