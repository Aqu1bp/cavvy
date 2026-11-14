import { expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "fs";
import { join } from "path";
import { tempDir } from "./helpers/isolate";
import { runBounded } from "../src/util/run-bounded";

const dir = tempDir("run-bounded-");
const script = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
};
const env = { PATH: process.env.PATH ?? "" };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("what it printed and how it ended", async () => {
    expect(await runBounded([script("ok", "echo out; echo err >&2; exit 3")], { cwd: dir, env, timeoutMs: 5000 })).toEqual({ code: 3, out: "out\nerr\n" });
    expect((await runBounded([script("in", "cat")], { cwd: dir, env, stdin: "typed", timeoutMs: 5000 })).out).toBe("typed");
});

test("a wrapper whose real program hangs ends at the limit, and the program with it", async () => {
    // The wrapper waits on a child that holds its output open: killing the wrapper alone leaves the child, and the pipe.
    const wrapper = script("hang", `sleep 60 &\necho $! > ${join(dir, "child.pid")}\necho started\nwait`);
    const at = Date.now();
    const r = await runBounded([wrapper], { cwd: dir, env, timeoutMs: 300 });
    expect(Date.now() - at).toBeLessThan(5000);
    expect(r.out).toBe("started\n");
    expect(r.code).not.toBe(0);
    const child = Number(await Bun.file(join(dir, "child.pid")).text());
    for (let i = 0; i < 40 && alive(child); i++) await Bun.sleep(50);
    expect(alive(child)).toBe(false);
});

test("stopped, it ends at once; and something it leaves running by itself isn't waited for", async () => {
    const stop = new AbortController();
    const run = runBounded([script("long", "sleep 60")], { cwd: dir, env, timeoutMs: 60_000, signal: stop.signal });
    setTimeout(() => stop.abort(), 100);
    const at = Date.now();
    expect((await run).code).not.toBe(0);
    expect(Date.now() - at).toBeLessThan(5000);
    // It exits by itself with a child still holding its output: answered a moment later, not when the child ends.
    const left = script("leaves", `sleep 3 &\necho $! > ${join(dir, "left.pid")}\necho done`);
    const began = Date.now();
    expect(await runBounded([left], { cwd: dir, env, timeoutMs: 60_000 })).toEqual({ code: 0, out: "done\n" });
    expect(Date.now() - began).toBeLessThan(2000);
    try { process.kill(Number(await Bun.file(join(dir, "left.pid")).text()), "SIGKILL"); } catch { /* gone */ }
});
