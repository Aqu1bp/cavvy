import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Switching machines loads the window again today (lib/machines.ts switchMachine): it's to open the other machine's
// session in the same page instead. Failing until it does: then a test.
test.failing("switching to a session on another machine opens it in the same page, and no row leaves the sidebar", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-machine-switch.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
}, 60_000);
