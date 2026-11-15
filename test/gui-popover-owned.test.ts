import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// A popover's `open` read from the page's listeners makes nothing that outlives it (test/fixtures/gui-popover-owned.ts).
test("a popover reads its open state where it's owned, not from the page's listeners", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-popover-owned.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
