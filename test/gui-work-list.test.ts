import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("the side panel's work list keeps its rows in place: under the pointer as agents finish, as they change, and as the fold opens (no sockets)", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-work-list.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
