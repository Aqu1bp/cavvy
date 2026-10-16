import { expect, test } from "bun:test";
import { fileURLToPath } from "url";

for (const mode of ["settled", "pending", "interrupted-bootstrap"]) {
    test(`session reads keep offline results and refresh after reopening (${mode})`, async () => {
        // Solid's default server build does not run reactive effects. Keep browser
        // conditions in a child so other Bun tests retain their usual module resolution.
        const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-changes-reconnect.ts", import.meta.url)), ...(mode !== "settled" ? [`--${mode}`] : [])], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
    });
}
