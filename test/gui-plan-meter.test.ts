import { expect, test } from "bun:test";

test("combined composer meter renders context, limits, account actions, and accessible interactions", () => {
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "--conditions=browser", "test", new URL("./fixtures/gui-plan-meter.ts", import.meta.url).pathname], { timeout: 15000 });
    expect({ code: result.exitCode, output: result.stderr.toString() }).toMatchObject({ code: 0 });
});
