import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// The pacing of a fast agent's output (#351): text, the live line and step rows. Run in a child with Solid's
// browser build (its reactivity), as test/gui-activity-motion.test.ts does.
test("a fast agent's output stays readable: paced text, a live line that dwells, rows that come in in turn", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", "test", fileURLToPath(new URL("./fixtures/gui-fast-pacing.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" });
}, 120_000);
