// What a session's commands left running where Cavvy can't see it, found by the mark they're started with and
// ended when the user stops everything (src/util/session-processes.ts). Only Linux lets the mark be read, so the
// tests with real processes run there (CI); how its /proc is read is tested everywhere, against a stand-in.

import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { endLeftRunning, endThese, leftNotice, leftRunning, readProc, SESSION_VAR, strays } from "../src/util/session-processes";
import { commandEnv } from "../src/tools/bash";
import { registerSecret, unregisterSecret } from "../src/util/redact";

const linux = process.platform === "linux";
const dir = mkdtempSync(join(tmpdir(), "cavvy-procs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const started: number[] = [];
afterEach(() => {
    for (const pid of started.splice(0)) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // gone, as it should be
        }
    }
});

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 10_000) {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ok()) return;
    throw new Error(`timed out waiting for ${what}`);
}

/** A command as a session would start one, which leaves a process behind and ends: the pid of what it left. */
async function leaves(session: string, script: string): Promise<number> {
    const p = Bun.spawn(["sh", "-c", `${script} & echo $!`], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { PATH: process.env.PATH ?? "", [SESSION_VAR]: session } });
    const pid = Number((await new Response(p.stdout).text()).trim());
    await p.exited;
    started.push(pid);
    // Until it is the program it was started to be (the shell's child becomes nohup, then that): its name is settled.
    await until("it to be running", () => readFileSync(`/proc/${pid}/cmdline`, "utf-8").startsWith("sleep\0"));
    return pid;
}

test("a session's commands carry its mark, and nothing else's do", async () => {
    const { env } = await commandEnv({ settings: {}, state: { session: "20260101-000000-abc123" } } as any, undefined);
    expect(env[SESSION_VAR]).toBe("20260101-000000-abc123");
    expect((await commandEnv({ settings: {}, state: {} } as any, undefined)).env[SESSION_VAR]).toBeUndefined();
});

/** A stand-in for /proc: one process's files. */
function proc(root: string, pid: number, comm: string, ppid: number, env?: string[], o: { start?: number; cmdline?: string[] } = {}) {
    mkdirSync(join(root, String(pid)), { recursive: true });
    // Fields 3 to 22 (state … starttime), as Linux writes them.
    writeFileSync(join(root, String(pid), "stat"), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0 ${o.start ?? pid * 10} 1000 100\n`);
    if (env) writeFileSync(join(root, String(pid), "environ"), env.map((e) => `${e}\0`).join(""));
    if (o.cmdline) writeFileSync(join(root, String(pid), "cmdline"), o.cmdline.map((a) => `${a}\0`).join(""));
}

test("read from /proc: each process's parent, start and whether it carries the mark, whatever its name holds", async () => {
    const root = join(dir, "read");
    const mark = `${SESSION_VAR}=one`;
    proc(root, 100, "cavvy", 1, ["PATH=/bin"]);
    proc(root, 101, "sh", 100, ["PATH=/bin", mark]);
    proc(root, 102, "sleep", 101, [mark, "X=1"]);
    proc(root, 200, "node server.js) R 7 (", 1, ["A=1", mark], { cmdline: ["node", "server.js", "--port", "3000"] });
    proc(root, 201, "worker", 200, [mark]);
    proc(root, 300, "sleep", 1, [`${SESSION_VAR}=one-more`, `NOTE=${mark}`.replace("=", ":")]);
    proc(root, 301, "other", 1, [`${SESSION_VAR}=two`]);
    // Another user's: its environment can't be read.
    proc(root, 400, "theirs", 1);
    mkdirSync(join(root, "self"));
    writeFileSync(join(root, "uptime"), "1 1\n");
    const procs = (await readProc(mark, root))!;
    expect(procs.sort((a, b) => a.pid - b.pid).map((p) => [p.pid, p.ppid, p.marked, p.start])).toEqual([
        [100, 1, false, "1000"],
        [101, 100, true, "1010"],
        [102, 101, true, "1020"],
        [200, 1, true, "2000"],
        [201, 200, true, "2010"],
        [300, 1, false, "3000"],
        [301, 1, false, "3010"],
        [400, 1, false, "4000"],
    ]);
    const pids = (self: number) => strays(procs, self).map((p) => p.pid).sort();
    // What's under this Cavvy (100) is its own to stop; what isn't any more is what was left behind.
    expect(pids(100)).toEqual([200, 201]);
    expect(pids(999)).toEqual([101, 102, 200, 201]);
    expect(await readProc(mark, join(root, "nowhere"))).toBeUndefined();
    // By name, for the line that says what was ended: the command line, or the pid when there's none to read.
    expect((await leftRunning("one", 100, root))!.sort((a, b) => a.pid - b.pid)).toEqual([
        { pid: 200, start: "2000", name: "node server.js --port 3000" },
        { pid: 201, start: "2010", name: "process 201" },
    ]);
    expect(await leftRunning("a b; rm", 100, root)).toEqual([]);
});

test("a secret in a left-behind command's line isn't shown, even where the name is cut", async () => {
    const root = join(dir, "secret");
    const token = "2abcdefghijklmnopqrstuvwxyz0123456789_ABCDEFGHIJ";
    registerSecret(token);
    try {
        proc(root, 500, "ngrok", 1, [`${SESSION_VAR}=s`], { cmdline: ["ngrok", "http", "3000", "--authtoken", token, "--log", "stdout", "--region", "eu"] });
        const [left] = (await leftRunning("s", 100, root))!;
        expect(left!.name).toStartWith("ngrok http 3000 --authtoken [REDACTED");
        expect(left!.name).not.toContain("2abc");
        expect(left!.name.length).toBeLessThanOrEqual(60);
    } finally {
        unregisterSecret(token);
    }
});

test("when Cavvy is the first process (a container), what it runs is still its own", () => {
    const procs = [
        { pid: 1, ppid: 0, marked: false, start: "1" },
        { pid: 10, ppid: 1, marked: true, start: "2" },
        { pid: 11, ppid: 10, marked: true, start: "3" },
    ];
    expect(strays(procs, 1)).toEqual([]);
    // And under another first process, what was handed to it is what was left behind.
    expect(strays(procs, 50).map((p) => p.pid)).toEqual([10, 11]);
});

test("stopping everything ends the process that was found, and never another that got its pid since", async () => {
    const root = join(dir, "end");
    const sleeper = () => {
        const p = Bun.spawn(["sleep", "297"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        started.push(p.pid);
        return p;
    };
    const left = sleeper();
    const reused = sleeper();
    proc(root, left.pid, "sleep", 1, [`${SESSION_VAR}=end`], { cmdline: ["sleep", "297"] });
    proc(root, reused.pid, "sleep", 1, [`${SESSION_VAR}=end`], { cmdline: ["old", "server"] });
    const found = (await leftRunning("end", process.pid, root))!;
    expect(found.map((p) => p.name).sort()).toEqual(["old server", "sleep 297"]);
    // Between the look and the signal, the second one's pid became another process (its start differs).
    proc(root, reused.pid, "sleep", 1, [], { start: 7 });
    // The stand-in keeps saying the first is there, so it is also killed once the wait is over: it's gone either way.
    expect(await endThese(found, 300, root)).toEqual(["sleep 297"]);
    await left.exited;
    expect(alive(reused.pid)).toBe(true);
});

test("the line that says what was also stopped names them, a few at most", () => {
    expect(leftNotice(["node server.js"])).toBe("Stopped a process this session left running: node server.js");
    expect(leftNotice(["a", "b", "c", "d", "e"])).toBe("Stopped 5 processes this session left running: a, b, c, and 2 more");
});

test.skipIf(linux)("where a process's environment can't be read, nothing is looked for or ended", async () => {
    expect(await leftRunning("anything")).toBeUndefined();
    expect(await endLeftRunning("anything", 10)).toEqual([]);
});

test.skipIf(!linux)("what a command left behind is found by the session's mark; what's still under this process, or another session's, isn't", async () => {
    const session = `test-${process.pid}-a`;
    const left = await leaves(session, "nohup sleep 291 >/dev/null 2>&1");
    const other = await leaves(`test-${process.pid}-b`, "nohup sleep 292 >/dev/null 2>&1");
    // Still under this process: a shell Cavvy runs, which it stops the usual way.
    const mine = Bun.spawn(["sleep", "293"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH ?? "", [SESSION_VAR]: session } });
    started.push(mine.pid);
    const pids = async (of: string) => ((await leftRunning(of)) ?? []).map((p) => p.pid);
    await until("the one left behind to be found", async () => (await pids(session)).includes(left));
    const found = await pids(session);
    expect(found).toContain(left);
    expect(found).not.toContain(other);
    expect(found).not.toContain(mine.pid);
    expect(found).not.toContain(process.pid);
    expect(await leftRunning("no-such-session")).toEqual([]);
    // A name that isn't a session's finds nothing, whatever is running.
    expect(await leftRunning("a b; rm")).toEqual([]);
});

test.skipIf(!linux)("stopping everything ends what was left behind, even what ignores being asked; the rest runs on", async () => {
    const session = `test-${process.pid}-c`;
    const left = await leaves(session, "nohup sleep 294 >/dev/null 2>&1");
    // exec keeps the pid and the ignored TERM, so nothing of it outlives a failed run of this test.
    const stubborn = await leaves(session, `nohup sh -c 'trap "" TERM; exec sleep 295' >/dev/null 2>&1`);
    const other = await leaves(`test-${process.pid}-d`, "nohup sleep 296 >/dev/null 2>&1");
    await until("them to be found", async () => {
        const f = ((await leftRunning(session)) ?? []).map((p) => p.pid);
        return f.includes(left) && f.includes(stubborn);
    });
    const ended = await endLeftRunning(session, 500);
    expect(ended.length).toBeGreaterThanOrEqual(2);
    expect(ended).toContain("sleep 294");
    await until("them to be gone", () => !alive(left) && !alive(stubborn));
    expect(alive(other)).toBe(true);
    expect(await endLeftRunning(session, 100)).toEqual([]);
});
