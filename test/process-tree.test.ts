// Finding and ending a command a process started and left running (src/util/process-tree.ts).
import { afterEach, expect, test } from "bun:test";
import { descendantsOf, endCommandsUnder, processRows, under } from "../src/util/process-tree";

test("the processes under one are found, whatever order the table is in; nothing a process calls itself is a row", () => {
    const rows = processRows(["   900     1   900", "  1300  1200  1300", "  1000   900  1000", "  1100  1000  1000", "  1200  1100  1200", "  5000     1  5000", "garbage", "  77 1000 77 sleep 60", ""].join("\n"));
    expect(rows).toHaveLength(6);
    expect(under(rows, 1000).map((p) => p.pid).sort()).toEqual([1100, 1200, 1300]);
    expect(under(rows, 1200)).toEqual([{ pid: 1300, ppid: 1200, pgid: 1300 }]);
    expect(under(rows, 4242)).toEqual([]);
});

const groupAlive = (pgid: number) => {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch {
        return false;
    }
};
const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};
async function until(what: string, ok: () => boolean, ms = 8000) {
    for (const end = Date.now() + ms; !ok(); ) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(25);
    }
}

/** What a test started, ended after it however it went: process groups, and single processes. */
const started: number[] = [];
afterEach(() => {
    for (const pid of started.splice(0)) {
        for (const target of [-pid, pid]) {
            try {
                process.kill(target, "SIGKILL");
            } catch {
                // gone, or not a group
            }
        }
    }
});

// Stands for the CLI: it runs a helper from the start, and on "go" starts a command (a shell leading a group of
// its own, with a child that takes no notice of being asked to stop) and something else in a group of its own.
const CLI = `
const helper = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
console.log(JSON.stringify({ helper: helper.pid }));
for await (const _ of console) {
    const command = Bun.spawn(["sh", "-c", "(trap '' TERM; exec sleep 301) & wait"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    const other = Bun.spawn(["sleep", "302"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    console.log(JSON.stringify({ command: command.pid, other: other.pid }));
}
`;

test("the command is ended, all of its group; what was running before, what else was started, and the CLI, are left", async () => {
    const cli = Bun.spawn([process.execPath, "-e", CLI], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    started.push(cli.pid);
    const lines = cli.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const next = async () => {
        while (!text.includes("\n")) {
            const { value, done } = await lines.read();
            if (done) throw new Error("the stand-in CLI ended");
            text += decoder.decode(value, { stream: true });
        }
        const line = text.slice(0, text.indexOf("\n"));
        text = text.slice(line.length + 1);
        return JSON.parse(line);
    };
    const { helper } = await next();
    started.push(helper);
    const before = (await descendantsOf(cli.pid))!;
    expect([...before]).toEqual([helper]);

    cli.stdin.write("go\n");
    await cli.stdin.flush();
    const { command, other } = await next();
    started.push(command, other);
    await until("the command's child to be running", () => groupAlive(command) && (Bun.spawnSync(["/usr/bin/pgrep", "-g", String(command)]).stdout.toString().trim().split("\n").length >= 2));

    expect(await endCommandsUnder(cli.pid, before, ["(trap '' TERM; exec sleep 301) & wait"], 600)).toEqual([command]);
    // Its shell went when asked; the child that took no notice was killed with the group.
    await until("the whole of the command's group to be gone", () => !groupAlive(command));
    expect([alive(other), alive(helper), alive(cli.pid)]).toEqual([true, true, true]);
    // A command nothing there is running, and no command at all: nothing is ended.
    expect(await endCommandsUnder(cli.pid, before, ["sleep 999"], 100)).toEqual([]);
    expect(await endCommandsUnder(cli.pid, before, ["", "  "], 100)).toEqual([]);
    // One it was already running is never taken for the command, whatever it's called.
    expect(await endCommandsUnder(cli.pid, new Set([helper, other]), ["sleep 302", "sleep 300"], 100)).toEqual([]);
    expect([alive(other), alive(helper)]).toEqual([true, true]);
});
