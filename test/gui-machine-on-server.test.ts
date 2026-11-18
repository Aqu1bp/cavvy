import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// In a window on a server, which sessions are another machine's is the other way round from a window on this computer:
// New session sends the window nowhere and lands in a folder of the machine it's on (gui/src/state/app.ts awayUnopened).
test("a window on a server: new session from its own or from this computer's unopened one lands on the window's machine", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-machine-on-server.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
}, 60_000);
