import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Find where finished turns come folded: the server's matches are used for the query they answer, and a jump from ⌘K
// waits for them (test/fixtures/gui-find-answered.ts).
test("find takes the server's matches only for the query they answer, and a jump waits for them", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-find-answered.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
