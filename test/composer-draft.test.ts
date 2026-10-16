import { expect, test } from "bun:test";
import { join } from "path";

test("Composer's draft lifecycle clears successful Home sends and preserves newer or failed drafts", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", join(import.meta.dir, "fixtures", "composer-draft.ts")], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
});
