import { expect, test } from "bun:test";

test("accounts settings workflows with Solid client reactivity", () => {
    // Keep browser module resolution isolated from the server test suite.
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "--conditions=browser", "test", new URL("./fixtures/gui-accounts.ts", import.meta.url).pathname], {
        timeout: 15000,
    });
    expect({ code: result.exitCode, output: result.stderr.toString() }).toMatchObject({ code: 0 });
});
