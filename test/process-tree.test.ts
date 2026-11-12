// What a process started since a moment, picked out of the system's process table (src/util/process-tree.ts).
import { expect, test } from "bun:test";
import { descendantsOf, endGroupsStartedUnder, startedUnder } from "../src/util/process-tree";

const at = (text: string) => Date.parse(text);

test("descendants that started since a moment are found, whatever order the table is in; the rest of the machine isn't", () => {
    // As Linux and macOS print it: pid, ppid, pgid, then when it started (a single-digit day is padded with a space).
    const table = [
        "   900     1   900 Thu Nov 12 16:20:00 2026",
        "  1300  1200  1300 Thu Nov 12 16:29:01 2026",
        "  1000   900  1000 Thu Nov 12 16:28:00 2026",
        "  1100  1000  1000 Thu Nov 12 16:28:01 2026",
        "  1200  1100  1200 Thu Nov 12 16:29:00 2026",
        "  5000     1  5000 Thu Nov 12 16:29:00 2026",
        "  1400  1000  1000 Mon Nov  2 09:05:07 2026",
        "garbage",
    ].join("\n");
    const since = at("Thu Nov 12 16:29:00 2026");
    expect(startedUnder(table, 1000, since).map((p) => p.pid).sort()).toEqual([1200, 1300]);
    // To the second: one that started in the second before the moment counts.
    expect(startedUnder(table, 1000, since + 900).map((p) => p.pid).sort()).toEqual([1200, 1300]);
    expect(startedUnder(table, 1000, since + 2100).map((p) => p.pid)).toEqual([]);
    expect(startedUnder(table, 1000, 0).map((p) => p.pid).sort()).toEqual([1100, 1200, 1300, 1400]);
    expect(startedUnder(table, 1200, 0)).toEqual([{ pid: 1300, pgid: 1300, startedAt: at("Thu Nov 12 16:29:01 2026") }]);
    expect(startedUnder(table, 4242, 0)).toEqual([]);
});

test("the groups this process started are ended; what it was already running, what shares its group, and it, are left", async () => {
    const alive = (pid: number) => {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    };
    const kept = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const before = (await descendantsOf(process.pid))!;
    expect(before.has(kept.pid)).toBe(true);
    // A helper started since, in this process's own group; and a command as a shell runs it, in a group of its own.
    const helper = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const command = Bun.spawn(["sh", "-c", "sleep 30 & wait"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    try {
        await Bun.sleep(150);
        const inGroup = (await descendantsOf(command.pid))!;
        expect(inGroup.size).toBe(1);
        expect(await endGroupsStartedUnder(process.pid, before, 1500)).toEqual([command.pid]);
        await command.exited;
        expect([...inGroup].some(alive)).toBe(false);
        expect([alive(kept.pid), alive(helper.pid)]).toEqual([true, true]);
    } finally {
        kept.kill();
        helper.kill();
        command.kill();
    }
});
