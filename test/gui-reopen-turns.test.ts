import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("a long session opened again comes with the turns the window had, and back to where it was read", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-reopen-turns.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
}, 60_000);
