// What the server (`cavvy serve`) costs while sessions stream, with no window: a fresh server for each case, one
// client following every session as a window would, on the demo's mock model ("perfstream" in scripts/mock-llm.ts).
// Writes bench-results/bench-server-<label>.json; with --profile, Bun's CPU profile of each case's server next to it.
//
//   bun desktop-electron/bench-server.ts --label before [--seconds 20] [--only text1,text4,cmd1] [--profile]
//
// Cases: one reply streaming, four at once, and one command's output streaming.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { startMockLlm } from "../scripts/mock-llm";
import { createDemoProject } from "../scripts/demo-project";

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const label = arg("--label") ?? "run";
const SECONDS = Number(arg("--seconds") ?? 20);
const only = arg("--only")?.split(",");
const profile = args.includes("--profile");
const repo = resolve(import.meta.dir, "..");
const results = join(import.meta.dir, "bench-results");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TOKEN = "server-bench-token-123456789";
const PORT = 4639;
const TEXT = "perfstream text 8 80";
const CMD = "perfstream cmd 2000";
const cases: { name: string; prompts: string[] }[] = [
    { name: "text1", prompts: [TEXT] },
    { name: "text4", prompts: [TEXT, TEXT, TEXT, TEXT] },
    { name: "cmd1", prompts: [CMD] },
    // Text four times as fast (four times as much of it, so it lasts as long); and one session open with
    // nothing running, for what the server costs anyway.
    { name: "fast1", prompts: ["perfstream text 32 320"] },
    { name: "idle1", prompts: [""] },
].filter((c) => !only || only.includes(c.name));
const report: Record<string, any> = { label, at: new Date().toISOString(), seconds: SECONDS, cases: {} };

/** A JSON-RPC client on a cavvy server's /ws, counting what it's sent. */
async function rpcTo(port: number, token: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["cavvy.v1", `auth.${token}`]);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0;
    const pending = new Map<number, (v: any) => void>();
    const got = { bytes: 0, messages: 0, ops: 0 };
    ws.onmessage = (e) => {
        const text = String(e.data);
        got.bytes += text.length;
        got.messages++;
        const x = JSON.parse(text);
        if (x.event?.type === "session.ops") got.ops += x.event.ops.length;
        if (x.id) { pending.get(x.id)?.(x); pending.delete(x.id); }
    };
    const call = (method: string, params: unknown, ms = 30_000) => new Promise<any>((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.delete(id)) r({ error: "timeout" }); }, ms); });
    return { ws, call, got };
}

/** Cumulative CPU seconds of a pid (ps's TIME: user + system). */
function cpuSeconds(pid: number): number {
    const t = Bun.spawnSync(["ps", "-o", "time=", "-p", String(pid)]).stdout.toString().trim();
    return t ? t.split(":").map(Number).reduce((a, x) => a * 60 + x, 0) : 0;
}
/**
 * Instructions a process has retired (macOS's proc_pid_rusage, RUSAGE_INFO_V4). Unlike CPU time, it doesn't depend on
 * which cores ran the work or how fast they were clocked: the same work counts the same.
 */
const libproc = dlopen("/usr/lib/libproc.dylib", { proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
function instructions(pid: number): number {
    const buf = new BigUint64Array(64);
    if (libproc.symbols.proc_pid_rusage(pid, 4, ptr(buf)) !== 0) return NaN;
    // After a 16-byte uuid, ri_instructions is the 30th 64-bit field.
    return Number(buf[2 + 29]);
}
const rssMB = (pid: number) => Math.round(Number(Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]).stdout.toString().trim() || 0) / 1024);

const mock = startMockLlm({ port: 0, delayMs: 14 });
mkdirSync(results, { recursive: true });
try {
    for (const c of cases) {
        const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cavvy-server-bench-"));
        const home = join(dir, "home");
        const project = join(dir, "acme-platform");
        mkdirSync(home, { recursive: true });
        mkdirSync(project, { recursive: true });
        createDemoProject(project);
        writeFileSync(join(home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock (demo)", baseUrl: mock.url, requiresKey: false }] }));
        writeFileSync(join(home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku", permissions: { defaultMode: "bypassPermissions" } }));
        const profDir = join(results, `bench-server-${label}-${c.name}`);
        const server = Bun.spawn([
            "bun", ...(profile ? ["--cpu-prof", "--cpu-prof-md", "--cpu-prof-interval=500", `--cpu-prof-dir=${profDir}`] : []),
            "--no-env-file", `--config=${join(repo, "bunfig.toml")}`, join(repo, "src/index.ts"), "serve", "--port", String(PORT),
        ], { cwd: project, env: { ...process.env, CAVVY_HOME: home, CAVVY_NO_KEYCHAIN: "1", CAVVY_GUI_TOKEN: TOKEN }, stdout: "ignore", stderr: Bun.file(join(dir, "server.log")) });
        try {
            for (let i = 0; !(await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.ok, () => false)); i++) { if (i > 200) throw new Error("server didn't start"); await sleep(100); }
            const rpc = await rpcTo(PORT, TOKEN);
            await rpc.call("projects.trust", { path: project, trust: true });
            const ids: string[] = [];
            for (const _ of c.prompts) ids.push((await rpc.call("session.create", { cwd: project, mode: "bypassPermissions" })).result.state.id);
            // Followed, as a window showing them would.
            for (const id of ids) await rpc.call("session.open", { id });
            const status = async () => new Map(((await rpc.call("sessions.list", { limit: 50 })).result as { id: string; status: string }[]).map((s) => [s.id, s.status]));
            await Promise.all(ids.map((id, i) => c.prompts[i] && rpc.call("session.send", { id, text: c.prompts[i] })));
            for (let i = 0; ; i++) { const s = await status(); if (ids.every((id, n) => !c.prompts[n] || s.get(id) === "running")) break; if (i > 100) throw new Error(`not running: ${JSON.stringify([...s])}`); await sleep(100); }
            await sleep(2000);
            // A command's approval, if it's asked for: allowed (the mock's commands only print).
            for (const id of ids) {
                const st = (await rpc.call("session.open", { id })).result?.state;
                for (const ask of st?.interactions ?? []) if (ask.kind === "permission") {
                    report.permissionAsks = (report.permissionAsks ?? 0) + 1;
                    await rpc.call("session.respond", { id, interactionId: ask.id, response: { kind: "permission", choice: ["always", "session", "yes"].find((o) => ask.options.some((x: { id: string }) => x.id === o)) } });
                }
            }
            await sleep(1000);
            // Nothing of ours asks the server anything while it's measured.
            const b0 = { ...rpc.got }, c0 = cpuSeconds(server.pid), i0 = instructions(server.pid), t0 = performance.now();
            await sleep(SECONDS * 1000);
            const wall = (performance.now() - t0) / 1000, cpu = cpuSeconds(server.pid) - c0, ins = instructions(server.pid) - i0;
            const after = await status();
            const percent = Math.round((cpu / wall) * 1000) / 10;
            report.cases[c.name] = {
                sessions: ids.length,
                serverCpuPercent: percent,
                perSessionPercent: Math.round((percent / ids.length) * 10) / 10,
                megaInstructionsPerSecond: Math.round(ins / wall / 1e6),
                rssMB: rssMB(server.pid),
                wsKBPerSecond: Math.round((rpc.got.bytes - b0.bytes) / 1024 / wall * 10) / 10,
                messagesPerSecond: Math.round((rpc.got.messages - b0.messages) / wall),
                opsPerSecond: Math.round((rpc.got.ops - b0.ops) / wall),
                ...(ids.some((id, n) => c.prompts[n] && after.get(id) !== "running") ? { invalid: `a session stopped early: ${JSON.stringify([...after.values()])}` } : {}),
            };
            console.error(c.name, JSON.stringify(report.cases[c.name]));
            await Promise.all(ids.map((id) => rpc.call("session.interrupt", { id }).catch(() => undefined)));
            rpc.ws.close();
        } finally {
            // SIGTERM: it shuts down, and Bun writes the profile.
            server.kill("SIGTERM");
            await Promise.race([server.exited, sleep(10_000)]);
            server.kill("SIGKILL");
            rmSync(dir, { recursive: true, force: true });
        }
    }
} catch (e) {
    report.error = String((e as Error)?.stack ?? e);
} finally {
    mock.stop();
    await Bun.write(join(results, `bench-server-${label}.json`), JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report, null, 1));
    process.exit(0);
}
