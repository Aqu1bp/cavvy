// Agent CLIs run a step below the server (backends/cli.ts cliPriority), so the server isn't queued behind them.
import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { JsonLinesProcess, cliPriority } from "../src/backends/cli";

/** The niceness a JsonLinesProcess's process runs at, as it reports it itself, and its pid as it sees it. */
async function started(): Promise<{ ni: number; pid: number; procPid: number }> {
    const p = new JsonLinesProcess("/bin/sh", ["-c", `echo "{\\"ni\\": $(ps -o ni= -p $$), \\"pid\\": $$}"`], { cwd: tmpdir() });
    let out = "";
    for await (const m of p.messages()) out = JSON.stringify(m);
    await p.exited;
    return { ...JSON.parse(out), procPid: p.pid };
}

test.skipIf(process.platform === "win32")("a CLI runs at niceness 5 more than the server, as the same process it was started as", async () => {
    const own = Number(Bun.spawnSync(["ps", "-o", "ni=", "-p", String(process.pid)]).stdout.toString().trim());
    const { ni, pid, procPid } = await started();
    expect(ni).toBe(Math.min(19, own + 5));
    // `nice` execs the CLI: the pid Cavvy holds (to signal it, to find its children) is the CLI's own.
    expect(pid).toBe(procPid);
});

test("CAVVY_CLI_NICE sets it, and 0 or nonsense runs CLIs as the server is", () => {
    expect(cliPriority({ CAVVY_CLI_NICE: "0" })).toEqual([]);
    expect(cliPriority({ CAVVY_CLI_NICE: "-3" })).toEqual([]);
    expect(cliPriority({ CAVVY_CLI_NICE: "x" })).toEqual([]);
    if (process.platform !== "win32") {
        expect(cliPriority({ CAVVY_CLI_NICE: "10" }).slice(1)).toEqual(["-n", "10"]);
        expect(cliPriority({}).slice(1)).toEqual(["-n", "5"]);
    }
});

test("a CLI that isn't there fails to start with its own error, as without the priority", () => {
    expect(() => new JsonLinesProcess("/nonexistent/fake-cli", [], { cwd: tmpdir() })).toThrow(/ENOENT/);
});
