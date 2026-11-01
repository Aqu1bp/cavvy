// The breaking point and per-session cost of Cavvy against the same agents with no Cavvy: N real Claude Code sessions,
// each in its own worktree of a large repository, given the same prompts, in steps of N, either under one `cavvy
// serve` (as the desktop app runs it) or as bare `claude` processes started with the flags Cavvy gives them. Every
// second: CPU and memory by role (Cavvy, its helpers, the CLIs, what the agents run, the rest), the machine's
// pressure, and, under Cavvy, how fast its socket answers. Writes results/ramp-<label>.json after each step.
//
//   bun scripts/bench-ramp.ts --mode cavvy|bare --repo <large repo> --steps 5,10,20,30 [--minutes 4] [--model sonnet] [--cavvy <checkout>] [--label x]
//
// The CLIs use the sign-in `claude` has, in a fresh HOME per step (keep the commands harmless: these are real agents).
// Run it in a memory cgroup the size of the laptop it stands for. Writes desktop-electron/bench-results/ramp-<label>.json.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { cpus, freemem, totalmem, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const MODE = (arg("--mode") ?? "cavvy") as "cavvy" | "bare";
const CAVVY = resolve(arg("--cavvy") ?? join(import.meta.dir, ".."));
const REPO = resolve(arg("--repo")!);
const STEPS = (arg("--steps") ?? "5,10").split(",").map(Number);
const MINUTES = Number(arg("--minutes") ?? 6);
const MODEL = arg("--model") ?? "sonnet";
const LABEL = arg("--label") ?? `${MODE}`;
const OUT = join(CAVVY, "desktop-electron", "bench-results");
const NCPU = cpus().length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))]! : 0);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-C", cwd, ...a], { stdout: "pipe", stderr: "pipe" });

// ---- The work: a heavy user's turns, the same for both modes.
function prompt(i: number, k: number): string {
    const a = String((i * 37 + k * 11) % 400).padStart(3, "0"), b = (i * 37 + k * 11) % 7, c = (i + k) % 250;
    const port = 20000 + i * 20 + (k % 20);
    const turns = [
        `In mod${a}/sub${b}/file${c}.c add a function named added_${i}_${k} that returns the sum of the first three functions in that file applied to its argument. Then run \`make -C mod${a}/sub${b} -j2\` and tell me in one sentence whether it built.`,
        `Use a subagent (the Task tool) to find which files under mod${a} mention "return x * 7 + 3", and tell me how many there are, in one line.`,
        `Run \`head -c 12000000 /dev/urandom | base64 -w 200 | wc -l\` and also \`head -c 3000000 /dev/urandom | base64 -w 200\`, then tell me only the line count from the first one.`,
        `Start a dev server in the background with \`python3 -m http.server ${port} --directory mod${a}\`, wait a second, fetch / from it once with curl and show the HTTP status, then stop the server.`,
        `Commit everything you changed in this worktree with a one-line message, then show \`git log --oneline -1\`.`,
    ];
    return turns[k % turns.length]!;
}

// ---- Processes and roles.
type Proc = { pid: number; ppid: number; rssKB: number; cpu: number; args: string };
function procs(): Map<number, Proc> {
    const out = new Map<number, Proc>();
    for (const line of Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,rss=,args="]).stdout.toString().split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const p: Proc = { pid: Number(m[1]), ppid: Number(m[2]), rssKB: Number(m[3]), cpu: 0, args: m[4]! };
        try {
            const f = readFileSync(`/proc/${p.pid}/stat`, "utf8");
            const rest = f.slice(f.lastIndexOf(")") + 2).split(" ");
            p.cpu = (Number(rest[11]) + Number(rest[12])) / 100;
        } catch {}
        out.set(p.pid, p);
    }
    return out;
}
const isClaude = (a: string) => /(^|\/)claude(\s|$)/.test(a) || /\/claude\s/.test(a);
function roles(ps: Map<number, Proc>, root: number, server?: number): Map<number, string> {
    const kids = new Map<number, number[]>();
    for (const p of ps.values()) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
    const out = new Map<number, string>();
    const walk = (pid: number, role: string) => {
        const p = ps.get(pid);
        let r = role;
        if (pid === server) r = "cavvy";
        else if (p && isClaude(p.args) && role !== "agent-tools") r = "claude-cli";
        else if (role === "claude-cli") r = "agent-tools";
        else if (role === "cavvy") r = "cavvy-helpers";
        out.set(pid, r);
        for (const k of kids.get(pid) ?? []) walk(k, r);
    };
    walk(root, "harness");
    for (const pid of ps.keys()) if (!out.has(pid)) out.set(pid, "other");
    return out;
}
const psi = (k: string) => { try { return Number(readFileSync(`/proc/pressure/${k}`, "utf8").match(/some avg10=([\d.]+)/)?.[1]); } catch { return undefined; } };
function cpuStat() {
    const f = readFileSync("/proc/stat", "utf8").split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
    const total = f.reduce((a, b) => a + b, 0);
    return { busy: total - f[3]! - f[4]!, total };
}
function memAvailableMB(): number {
    const m = readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/);
    return m ? Math.round(Number(m[1]) / 1024) : Math.round(freemem() / 1048576);
}

// ---- Worktrees: one a session, made once, put back before each step.
function worktree(i: number): string {
    const path = join(REPO, ".claude", "worktrees", `ramp-${i}`);
    if (!existsSync(path)) {
        if (git(REPO, "rev-parse", "--verify", "-q", "ramp-base").exitCode !== 0) git(REPO, "branch", "ramp-base", "HEAD");
        git(REPO, "worktree", "add", "-q", "-b", `ramp-${i}`, path, "ramp-base");
    } else {
        git(path, "reset", "-q", "--hard", "ramp-base");
        git(path, "clean", "-qfd");
    }
    return path;
}

/** A clean environment for the agents: none of this container's own session variables. */
function cleanEnv(home: string): Record<string, string> {
    const keep = ["PATH", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "LANG", "TMPDIR", "USER", "SHELL"];
    const env: Record<string, string> = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]!]));
    if (!env.NODE_EXTRA_CA_CERTS && existsSync("/root/.ccr/ca-bundle.crt")) env.NODE_EXTRA_CA_CERTS = "/root/.ccr/ca-bundle.crt";
    env.NO_PROXY = env.no_proxy = [env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
    env.HOME = home;
    return env;
}

interface Driver {
    /** Sends turn k to session i; resolves when it's under way. */
    send(i: number, k: number): Promise<void>;
    /** Each session's state: running, idle (its last turn ended, ok or not). */
    poll(): Promise<{ running: boolean; error?: string }[]>;
    /** Its own responsiveness this second, ms (undefined for bare). */
    ping(): Promise<number | undefined>;
    stop(): Promise<void>;
    serverPid?: number;
}

async function cavvyDriver(n: number, dirs: string[], home: string): Promise<Driver> {
    const cavvyHome = join(home, ".cavvy");
    mkdirSync(cavvyHome, { recursive: true });
    writeFileSync(join(cavvyHome, "settings.json"), JSON.stringify({ permissions: { defaultMode: "auto" } }));
    const port = 4800 + Math.floor(Math.random() * 300), token = "ramp-" + crypto.randomUUID();
    const env = { ...cleanEnv(home), CAVVY_HOME: cavvyHome, CAVVY_NO_KEYCHAIN: "1", CAVVY_GUI_TOKEN: token };
    const server = Bun.spawn(["bun", "--no-env-file", `--config=${join(CAVVY, "bunfig.toml")}`, join(CAVVY, "src/index.ts"), "serve", "--port", String(port)], { cwd: REPO, env, stdout: "ignore", stderr: Bun.file(join(home, "server.log")) });
    for (let i = 0; !(await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false)); i++) { if (i > 300) throw new Error("server didn't start"); await sleep(100); }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["cavvy.v1", `auth.${token}`]);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0;
    const pending = new Map<number, (v: any) => void>();
    // Statuses as the server broadcasts them (as the GUI hears them), not asked for every second.
    const status = new Map<string, string>();
    ws.onmessage = (e) => {
        const x = JSON.parse(String(e.data));
        if (x.event?.type === "sessions.upsert") status.set(x.event.session.id, x.event.session.status);
        if (x.id) { pending.get(x.id)?.(x); pending.delete(x.id); }
    };
    const call = (method: string, params: unknown, ms = 120_000) => new Promise<any>((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.delete(id)) r({ error: { message: "timeout" } }); }, ms); });
    const c = await call("providers.connectCli", { provider: "claude-code" });
    if (c.error) throw new Error("connect: " + c.error.message);
    const models = ((await call("models.list", { refresh: true })).result ?? []) as { provider: string; models: { ref: string; id: string }[] }[];
    const refs = models.find((p) => p.provider === "claude-code")?.models ?? [];
    const ref = refs.find((m) => m.ref.endsWith(`:${MODEL}`))?.ref ?? refs.find((m) => m.id.includes(MODEL))?.ref ?? c.result?.model;
    const ids: string[] = [];
    for (const d of dirs) {
        await call("projects.trust", { path: d, trust: true });
        const s = await call("session.create", { cwd: d, mode: "auto", model: ref });
        if (s.error) throw new Error("session.create: " + s.error.message);
        ids.push(s.result.state.id);
        await call("session.open", { id: s.result.state.id });
    }
    console.error(`cavvy: ${n} sessions on ${ref}`);
    return {
        serverPid: server.pid,
        async send(i, k) {
            status.set(ids[i]!, "running");
            const r = await call("session.send", { id: ids[i], text: prompt(i, k) });
            if (r.error) throw new Error(r.error.message);
        },
        async poll() {
            // A question that would come to a person is declined, as `claude -p` declines what it would ask.
            for (const id of ids) if (status.get(id) === "waiting") {
                const st = (await call("session.open", { id })).result?.state;
                for (const ask of st?.interactions ?? []) {
                    asks++;
                    const response = ask.kind === "permission" ? { kind: "permission", choice: ask.options.find((o: { id: string }) => o.id === "no")?.id ?? "no" } : ask.kind === "plan" ? { kind: "plan", approved: false } : { kind: ask.kind };
                    await call("session.respond", { id, interactionId: ask.id, response }).catch(() => {});
                }
            }
            return ids.map((id) => {
                const st = status.get(id);
                return { running: st === "running" || st === "waiting", error: st === "error" ? "error" : undefined };
            });
        },
        // Something the server answers from memory: how long the GUI's requests wait behind its other work.
        async ping() { const t = performance.now(); await call("terminal.list", {}, 30_000); return performance.now() - t; },
        async stop() { ws.close(); server.kill("SIGTERM"); await Promise.race([server.exited, sleep(10_000)]); server.kill("SIGKILL"); },
    };
}

async function bareDriver(n: number, dirs: string[], home: string): Promise<Driver> {
    const env = cleanEnv(home);
    const model = MODEL;
    const sessions = dirs.map((cwd) => {
        // As Cavvy starts it (claude-code.ts claudeArgs), but for its own permission prompts and MCP server.
        const proc = Bun.spawn(["claude", "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "auto", "--model", model], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
        const s = { proc, running: false, error: undefined as string | undefined };
        (async () => {
            let buf = "";
            for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
                buf += new TextDecoder().decode(chunk);
                let nl;
                while ((nl = buf.indexOf("\n")) >= 0) {
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    if (!line.includes('"type":"result"')) continue;
                    try {
                        const r = JSON.parse(line);
                        if (r.type !== "result") continue;
                        s.error = r.is_error ? String(r.subtype) : undefined;
                    } catch { continue; }
                    s.running = false;
                }
            }
            s.running = false;
            s.error = "exited";
        })();
        return s;
    });
    console.error(`bare: ${n} claude processes on ${model}`);
    return {
        async send(i, k) {
            const s = sessions[i]!;
            s.running = true;
            s.proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt(i, k) }] } }) + "\n");
            await s.proc.stdin.flush();
        },
        async poll() { return sessions.map((s) => ({ running: s.running, error: s.error })); },
        async ping() { return undefined; },
        async stop() { for (const s of sessions) { try { s.proc.stdin.end(); } catch {} s.proc.kill("SIGTERM"); } await sleep(2000); for (const s of sessions) s.proc.kill("SIGKILL"); },
    };
}

let asks = 0;

async function step(n: number) {
    const home = mkdtempSync(join(tmpdir(), `ramp-${MODE}-${n}-`));
    const dirs = Array.from({ length: n }, (_, i) => worktree(i));
    const rep: Record<string, any> = { mode: MODE, sessions: n, model: MODEL };
    const samples: any[] = [];
    const turns: { session: number; seconds: number; error?: string }[] = [];
    let driver: Driver | undefined;
    try {
        driver = MODE === "cavvy" ? await cavvyDriver(n, dirs, home) : await bareDriver(n, dirs, home);
        const sent = dirs.map(() => 0), sentAt = dirs.map(() => 0);
        // Started a little apart, as people do.
        for (let i = 0; i < n; i++) { await driver.send(i, 0); sent[i] = 1; sentAt[i] = performance.now(); await sleep(300); }
        let prev = (await driver.poll()).map(() => true);
        const ps0 = procs();
        let lastPs = ps0, lastT = performance.now(), lastStat = cpuStat();
        const t0 = lastT;
        for (;;) {
            await sleep(1000);
            const ping = await driver.ping();
            const now = performance.now(), w = (now - lastT) / 1000;
            const ps = procs(), role = roles(ps, process.pid, driver.serverPid);
            const cpu: Record<string, number> = {}, rss: Record<string, number> = {}, count: Record<string, number> = {};
            for (const p of ps.values()) {
                const rl = role.get(p.pid) ?? "other";
                cpu[rl] = (cpu[rl] ?? 0) + Math.max(0, p.cpu - (lastPs.get(p.pid)?.cpu ?? (ps0.has(p.pid) ? p.cpu : 0)));
                rss[rl] = (rss[rl] ?? 0) + p.rssKB / 1024;
                count[rl] = (count[rl] ?? 0) + 1;
            }
            const st = cpuStat();
            const states = await driver.poll();
            samples.push({
                t: Math.round((now - t0) / 1000), pingMs: ping === undefined ? undefined : r1(ping),
                cpuPct: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, r1((v / w) * 100)])),
                rssMB: Object.fromEntries(Object.entries(rss).map(([k, v]) => [k, Math.round(v)])), procs: count,
                machineBusyPct: r1(((st.busy - lastStat.busy) / (st.total - lastStat.total)) * 100),
                psi: { cpu: psi("cpu"), io: psi("io"), memory: psi("memory") }, availMB: memAvailableMB(),
                running: states.filter((s) => s.running).length,
            });
            lastPs = ps; lastT = now; lastStat = st;
            for (let i = 0; i < n; i++) {
                if (prev[i] && !states[i]!.running) {
                    turns.push({ session: i, seconds: r1((now - sentAt[i]!) / 1000), error: states[i]!.error });
                    if (now - t0 < MINUTES * 60_000 && states[i]!.error !== "exited") { await driver.send(i, sent[i]!); sent[i]!++; sentAt[i] = performance.now(); states[i]!.running = true; }
                }
            }
            prev = states.map((s) => s.running);
            if ((now - t0 >= MINUTES * 60_000 && !states.some((s) => s.running)) || now - t0 > (MINUTES + 6) * 60_000) { rep.capped = states.some((s) => s.running); break; }
        }
    } catch (e) {
        rep.error = String((e as Error)?.stack ?? e);
    } finally {
        await driver?.stop();
    }
    const col = (f: (x: any) => number | undefined) => samples.map(f).filter((x): x is number => typeof x === "number" && !Number.isNaN(x));
    const roleAvg = (r: string) => r1(avg(col((x) => x.cpuPct[r] ?? 0)));
    const rssAvg = (r: string) => Math.round(avg(col((x) => x.rssMB[r] ?? 0)));
    const turnSecs = turns.filter((t) => !t.error).map((t) => t.seconds);
    rep.summary = {
        sessions: n, seconds: samples.length, turns: turns.length, asks, failed: turns.filter((t) => t.error).length,
        turnSecondsMedian: r1(pct(turnSecs, 0.5)), turnSecondsP90: r1(pct(turnSecs, 0.9)),
        cpuPctAvg: { cavvy: roleAvg("cavvy"), helpers: roleAvg("cavvy-helpers"), cli: roleAvg("claude-cli"), tools: roleAvg("agent-tools"), other: roleAvg("other") },
        rssMBAvg: { cavvy: rssAvg("cavvy"), helpers: rssAvg("cavvy-helpers"), cli: rssAvg("claude-cli"), tools: rssAvg("agent-tools") },
        rssMBPeak: { cavvy: Math.max(0, ...samples.map((x) => x.rssMB.cavvy ?? 0)), cli: Math.max(0, ...samples.map((x) => x.rssMB["claude-cli"] ?? 0)) },
        machineBusyPctAvg: r1(avg(col((x) => x.machineBusyPct))), availMBMin: Math.min(...col((x) => x.availMB)),
        psiAvg: { cpu: r1(avg(col((x) => x.psi.cpu))), io: r1(avg(col((x) => x.psi.io))), memory: r1(avg(col((x) => x.psi.memory))) },
        pingMs: { p50: r1(pct(col((x) => x.pingMs), 0.5)), p95: r1(pct(col((x) => x.pingMs), 0.95)), max: r1(Math.max(0, ...col((x) => x.pingMs))) },
        cores: NCPU, memMB: Math.round(totalmem() / 1048576),
    };
    rep.turns = turns;
    rep.samples = samples;
    return rep;
}

mkdirSync(OUT, { recursive: true });
const report: Record<string, any> = { label: LABEL, mode: MODE, at: new Date().toISOString(), repo: REPO, steps: [] };
const file = join(OUT, `ramp-${LABEL}.json`);
for (const n of STEPS) {
    console.error(`--- ${MODE}: ${n} sessions, ${MINUTES} min`);
    const r = await step(n);
    report.steps.push(r);
    writeFileSync(file, JSON.stringify(report, null, 1));
    console.error(JSON.stringify(r.summary));
    if (r.error) console.error("error:", r.error);
}
console.error("wrote", file);
process.exit(0);
