import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Another machine's session opened in this window when that machine can't be reached, drops, says what isn't its to
// say, or the window loads again (test/fixtures/gui-machine-failures.ts).
const run = async (mode: string) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-machine-failures.ts", import.meta.url))], { env: { ...process.env, MODE: mode }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
};

test("another machine's session: reached after failing, a drop with a failed reconnect, its events kept to its own, a fork, an overtaken click", async () => {
    expect(await run("main")).toEqual({ code: 0, stdout: "", stderr: "" });
}, 60_000);

test("loaded again with another machine's session on screen, it opens from there", async () => {
    expect(await run("reload")).toEqual({ code: 0, stdout: "", stderr: "" });
}, 60_000);
