// Agent CLIs run a step below the server (backends/cli.ts cliPriority), so the server isn't queued behind them.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { JsonLinesProcess, cliPriority } from "../src/backends/cli";

// What the shell running the tests has set is not what these test: each sets its own.
const was = process.env.CAVVY_CLI_NICE;
beforeEach(() => { delete process.env.CAVVY_CLI_NICE; });
afterEach(() => {
    if (was === undefined) delete process.env.CAVVY_CLI_NICE;
    else process.env.CAVVY_CLI_NICE = was;
});

const PATH = process.env.PATH ?? "";

/** The niceness a JsonLinesProcess's process runs at, as it reports it itself, and its pid as it sees it. */
async function started(env?: Record<string, string>): Promise<{ ni: number; pid: number; procPid: number }> {
    const p = new JsonLinesProcess("/bin/sh", ["-c", `echo "{\\"ni\\": $(ps -o ni= -p $$), \\"pid\\": $$}"`], { cwd: tmpdir(), env });
    let out = "";
    for await (const m of p.messages()) out = JSON.stringify(m);
    await p.exited;
    return { ...JSON.parse(out), procPid: p.pid };
}
const own = () => Number(Bun.spawnSync(["ps", "-o", "ni=", "-p", String(process.pid)]).stdout.toString().trim());

test.skipIf(process.platform === "win32")("a CLI runs at niceness 5 more than the server, as the same process it was started as", async () => {
    const { ni, pid, procPid } = await started();
    expect(ni).toBe(Math.min(19, own() + 5));
    // `nice` execs the CLI: the pid Cavvy holds (to signal it, to find its children) is the CLI's own.
    expect(pid).toBe(procPid);
});

test.skipIf(process.platform === "win32")("CAVVY_CLI_NICE sets the step, and 0 runs CLIs as the server is", async () => {
    process.env.CAVVY_CLI_NICE = "0";
    expect((await started()).ni).toBe(own());
    process.env.CAVVY_CLI_NICE = "3";
    expect((await started()).ni).toBe(Math.min(19, own() + 3));
});

test("CAVVY_CLI_NICE: nonsense runs CLIs as the server is, and past 19 is 19, the most there is", () => {
    expect(cliPriority({ PATH, CAVVY_CLI_NICE: "0" })).toEqual([]);
    expect(cliPriority({ PATH, CAVVY_CLI_NICE: "-3" })).toEqual([]);
    expect(cliPriority({ PATH, CAVVY_CLI_NICE: "x" })).toEqual([]);
    if (process.platform !== "win32") {
        expect(cliPriority({ PATH, CAVVY_CLI_NICE: "10" }).slice(1)).toEqual(["-n", "10"]);
        expect(cliPriority({ PATH, CAVVY_CLI_NICE: "40" }).slice(1)).toEqual(["-n", "19"]);
        expect(cliPriority({ PATH }).slice(1)).toEqual(["-n", "5"]);
    }
});

test.skipIf(process.platform === "win32")("`nice` is looked for on the PATH the CLI starts with", () => {
    const dir = mkdtempSync(join(tmpdir(), "cavvy-nice-"));
    try {
        symlinkSync(Bun.which("nice")!, join(dir, "nice"));
        expect(cliPriority({ PATH: dir })[0]).toBe(join(dir, "nice"));
        // Not on that PATH: CLIs run as the server is.
        expect(cliPriority({ PATH: join(dir, "empty") })).toEqual([]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a CLI that isn't there, or whose folder isn't, fails to start with its own error, as without the priority", () => {
    expect(() => new JsonLinesProcess("/nonexistent/fake-cli", [], { cwd: tmpdir() })).toThrow(/ENOENT.*fake-cli/);
    expect(() => new JsonLinesProcess("/bin/sh", ["-c", "true"], { cwd: "/nonexistent/session-folder" })).toThrow(/ENOENT.*\/bin\/sh/);
});
