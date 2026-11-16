import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Picking a session on another machine opens it in this page (state/app.ts activate), where the window used to load
// again on that machine (lib/machines.ts switchMachine): 0.5-0.8 s each way, its sessions opened afresh each time.
test("switching to a session on another machine opens it in the same page, and no row leaves the sidebar", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-machine-switch.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
}, 60_000);
