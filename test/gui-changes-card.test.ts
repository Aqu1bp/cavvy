import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("changes cards keep finished turns' file lists across remounts", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/gui-changes-card.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", "test", fixture], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" });
});
