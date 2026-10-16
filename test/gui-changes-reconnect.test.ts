import { expect, test } from "bun:test";
import { fileURLToPath } from "url";

test("session change resources retain results across reconnect before an unchanged reopen", async () => {
    // Solid's default server build does not run reactive effects. Keep browser
    // conditions in a child so other Bun tests retain their usual module resolution.
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-changes-reconnect.ts", import.meta.url))], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
