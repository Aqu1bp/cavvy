import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const mode of ["reload", "desktop", "isolated", "missing", "transient", "retry", "trust", "navigate", "home", "corrupt", "unavailable"]) {
    test(`window navigation survives reload and reconnect (${mode})`, async () => {
        const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-navigation.ts", import.meta.url)), mode], { stdout: "pipe", stderr: "pipe" });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
    });
}
