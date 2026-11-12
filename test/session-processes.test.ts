// What a session's commands left running where Cavvy can't see it, found by the mark they're started with and
// ended when the user stops everything (src/util/session-processes.ts). Only Linux lets the mark be read, so the
// tests with real processes run there (CI); how its /proc is read is tested everywhere, against a stand-in.

import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { endLeftRunning, leftRunning, readProc, SESSION_VAR, strays } from "../src/util/session-processes";
import { commandEnv } from "../src/tools/bash";

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
    return pid;
}

test("a session's commands carry its mark, and nothing else's do", async () => {
    const { env } = await commandEnv({ settings: {}, state: { session: "20260101-000000-abc123" } } as any, undefined);
    expect(env[SESSION_VAR]).toBe("20260101-000000-abc123");
    expect((await commandEnv({ settings: {}, state: {} } as any, undefined)).env[SESSION_VAR]).toBeUndefined();
});

test("read from /proc: each process's parent and whether it carries the mark, whatever its name holds", () => {
    const proc = (pid: number, comm: string, ppid: number, env?: string[]) => {
        mkdirSync(join(dir, String(pid)));
        writeFileSync(join(dir, String(pid), "stat"), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 100\n`);
        if (env) writeFileSync(join(dir, String(pid), "environ"), env.map((e) => `${e}\0`).join(""));
    };
    const mark = `${SESSION_VAR}=one`;
    proc(100, "cavvy", 1, ["PATH=/bin"]);
    proc(101, "sh", 100, ["PATH=/bin", mark]);
    proc(102, "sleep", 101, [mark, "X=1"]);
    proc(200, "node server.js) R 7 (", 1, ["A=1", mark]);
    proc(201, "worker", 200, [mark]);
    proc(300, "sleep", 1, [`${SESSION_VAR}=one-more`, `NOTE=${mark}`.replace("=", ":")]);
    proc(301, "other", 1, [`${SESSION_VAR}=two`]);
    // Another user's: its environment can't be read.
    proc(400, "theirs", 1);
    mkdirSync(join(dir, "self"));
    writeFileSync(join(dir, "uptime"), "1 1\n");
    const procs = readProc(mark, dir)!;
    expect(procs.sort((a, b) => a.pid - b.pid)).toEqual([
        { pid: 100, ppid: 1, marked: false },
        { pid: 101, ppid: 100, marked: true },
        { pid: 102, ppid: 101, marked: true },
        { pid: 200, ppid: 1, marked: true },
        { pid: 201, ppid: 200, marked: true },
        { pid: 300, ppid: 1, marked: false },
        { pid: 301, ppid: 1, marked: false },
        { pid: 400, ppid: 1, marked: false },
    ]);
    // What's under this Cavvy (100) is its own to stop; what isn't any more is what was left behind.
    expect(strays(procs, 100).sort()).toEqual([200, 201]);
    expect(strays(procs, 999).sort()).toEqual([101, 102, 200, 201]);
    expect(readProc(mark, join(dir, "nowhere"))).toBeUndefined();
});

test.skipIf(linux)("where a process's environment can't be read, nothing is looked for or ended", async () => {
    expect(await leftRunning("anything")).toBeUndefined();
    expect(await endLeftRunning("anything", 10)).toBe(0);
});

test.skipIf(!linux)("what a command left behind is found by the session's mark; what's still under this process, or another session's, isn't", async () => {
    const session = `test-${process.pid}-a`;
    const left = await leaves(session, "nohup sleep 291 >/dev/null 2>&1");
    const other = await leaves(`test-${process.pid}-b`, "nohup sleep 292 >/dev/null 2>&1");
    // Still under this process: a shell Cavvy runs, which it stops the usual way.
    const mine = Bun.spawn(["sleep", "293"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH ?? "", [SESSION_VAR]: session } });
    started.push(mine.pid);
    await until("the one left behind to be found", async () => ((await leftRunning(session)) ?? []).includes(left));
    const found = (await leftRunning(session))!;
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
    const stubborn = await leaves(session, `nohup sh -c 'trap "" TERM; sleep 295' >/dev/null 2>&1`);
    const other = await leaves(`test-${process.pid}-d`, "nohup sleep 296 >/dev/null 2>&1");
    await until("them to be found", async () => {
        const f = (await leftRunning(session)) ?? [];
        return f.includes(left) && f.includes(stubborn);
    });
    expect(await endLeftRunning(session, 500)).toBeGreaterThanOrEqual(2);
    await until("them to be gone", () => !alive(left) && !alive(stubborn));
    expect(alive(other)).toBe(true);
    expect(await endLeftRunning(session, 100)).toBe(0);
});
