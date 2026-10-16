import { expect, test } from "bun:test";
import { join } from "path";

test("Home checks commands before creation; sends and retries preserve real drafts", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", join(import.meta.dir, "fixtures", "gui-send.ts")], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
});
