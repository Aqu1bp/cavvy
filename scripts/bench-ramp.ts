// The heavy-use pass mark's breaking point and per-session cost (docs/performance-plan.md): Cavvy against the same
// agents with no Cavvy. N real Claude Code sessions, each in its own worktree of a large repository (bench-repo.ts),
// given the same prompts, either under one `cavvy serve` (as the desktop app runs it) or as bare `claude -p` processes.
// Each session sends its next prompt as soon as its last turn ends. With --per-session K, each does K turns and the
// step ends when all have (fixed work: compare the wall time and the machine's CPU); else it runs --minutes.
//
// Reported: wall time from launching Cavvy or the CLIs and from the first prompt to the last turn's end; the whole
// machine's CPU over it (/proc/stat: the machine should run nothing else); CPU and memory by role every second
// (Cavvy, its helper processes, the CLIs, what the agents run); and with --acct (root), every process's CPU from the
// kernel's process accounting, short-lived ones too, by command and by role. Linux only.
//
//   bun scripts/bench-ramp.ts --mode cavvy|bare --repo <repo> --steps 10,30 [--per-session 15 | --minutes 6]
//       [--model sonnet] [--cavvy <checkout>] [--label x] [--mock <url>] [--acct] [--profile] [--shown first|none|all]
//       [--debug <file>] [--times <file>] [--hold <seconds>]
//
// --mock: the CLIs talk to bench-claude-api.ts instead of Anthropic, for the same work to the byte in both modes.
// --debug: Cavvy's live-CLI debug log (CAVVY_DEBUG); --times: when each prompt was sent and each turn ended.
// Results go to <checkout>/bench-results (ramp-<label>.json), outside the repository's history.

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
/** Fixed work: each session does this many turns, and the step ends when they all have (makespan), not at MINUTES. */
const PER_SESSION = arg("--per-session") ? Number(arg("--per-session")) : undefined;
const OUT = resolve(arg("--out") ?? join(CAVVY, "bench-results"));
const DEBUG = arg("--debug");
/** --hold <s>: after the last turn, everything stays up this long, idle, and what it costs then is reported. */
const HOLD = Number(arg("--hold") ?? 0);
const TIMES = arg("--times");
const SHOWN = arg("--shown") ?? "first";
/** --mock <url>: the CLIs talk to mock-agent-api.ts instead of Anthropic: the same work, to the byte, in both modes. */
const MOCK = arg("--mock");
/** The step's worktrees, for the mock's prompts (they name files by path). */
let DIRS: string[] = [];
const NCPU = cpus().length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))]! : 0);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-C", cwd, ...a], { stdout: "pipe", stderr: "pipe" });

// ---- The work: a heavy user's turns, the same for both modes.
function prompt(i: number, k: number): string {
    // A folder bench-repo.ts made: mod<d>/sub<d % 7>.
    const d = (i * 37 + k * 11) % 400, a = String(d).padStart(3, "0"), b = d % 7, c = (i + k) % 250;
    if (MOCK) {
        const cmd = Buffer.from(`make -C mod${a}/sub${b} -j2 >/dev/null 2>&1; git status --short | wc -l`).toString("base64");
        return `workday file=${DIRS[i]}/mod${a}/sub${b}/file${c}.c cmd=${cmd} out=${k % 3 === 2 ? 256 : 0} words=200`;
    }
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
    env.NO_PROXY = env.no_proxy = [env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
    env.HOME = home;
    if (MOCK) Object.assign(env, { ANTHROPIC_BASE_URL: MOCK, ANTHROPIC_API_KEY: "sk-ant-mock-0000" });
    // Commits work in both modes (no question about who to commit as).
    Object.assign(env, { GIT_AUTHOR_NAME: "Ramp", GIT_AUTHOR_EMAIL: "ramp@example.com", GIT_COMMITTER_NAME: "Ramp", GIT_COMMITTER_EMAIL: "ramp@example.com" });
    return env;
}

interface Driver {
    /** Sends turn k to session i and resolves once it has ended, as soon as it has (error: how it failed). */
    turn(i: number, k: number): Promise<{ error?: string }>;
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
    const env = { ...cleanEnv(home), CAVVY_HOME: cavvyHome, CAVVY_NO_KEYCHAIN: "1", CAVVY_GUI_TOKEN: token, ...(DEBUG ? { CAVVY_DEBUG: "1", CAVVY_DEBUG_FILE: DEBUG } : {}) };
    const prof = args.includes("--profile") ? ["--cpu-prof", "--cpu-prof-md", "--cpu-prof-interval=1000", `--cpu-prof-dir=${join(OUT, `profile-${LABEL}-${n}`)}`] : [];
    const server = Bun.spawn(["bun", ...prof, "--no-env-file", `--config=${join(CAVVY, "bunfig.toml")}`, join(CAVVY, "src/index.ts"), "serve", "--port", String(port)], { cwd: REPO, env, stdout: "ignore", stderr: Bun.file(join(home, "server.log")) });
    for (let i = 0; !(await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false)); i++) { if (i > 300) throw new Error("server didn't start"); await sleep(100); }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["cavvy.v1", `auth.${token}`]);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0;
    const pending = new Map<number, (v: any) => void>();
    // Statuses as the server broadcasts them (as the GUI hears them), not asked for every second.
    const status = new Map<string, string>();
    /** The turn under way in each session: running seen yet, and how to end it. */
    const waiters = new Map<string, { seen: boolean; done: (r: { error?: string }) => void }>();
    const onStatus = (id: string, st: string) => {
        const w = waiters.get(id);
        if (!w) return;
        if (st === "running") { w.seen = true; return; }
        if (st === "waiting") { w.seen = true; void answer(id); return; }
        if (!w.seen) return;
        waiters.delete(id);
        w.done({ error: st === "error" ? "error" : undefined });
    };
    // A question that would come to a person is declined, as `claude -p` declines what it would ask.
    const answer = async (id: string) => {
        const st = (await call("session.open", { id })).result?.state;
        for (const ask of st?.interactions ?? []) {
            asks++;
            console.error("ask:", JSON.stringify({ kind: ask.kind, title: ask.title, detail: String(ask.detail ?? ask.input?.command ?? "").slice(0, 200) }));
            const response = ask.kind === "permission" ? { kind: "permission", choice: ask.options.find((o: { id: string }) => o.id === "no")?.id ?? "no" } : ask.kind === "plan" ? { kind: "plan", approved: false } : { kind: ask.kind };
            await call("session.respond", { id, interactionId: ask.id, response }).catch(() => {});
        }
    };
    ws.onmessage = (e) => {
        const x = JSON.parse(String(e.data));
        if (x.event?.type === "sessions.upsert") {
            if (TIMES && status.get(x.event.session.id) !== x.event.session.status) require("fs").appendFileSync(TIMES, JSON.stringify({ at: Date.now(), what: "status", id: x.event.session.id, status: x.event.session.status }) + "\n");
            status.set(x.event.session.id, x.event.session.status);
            onStatus(x.event.session.id, x.event.session.status);
        }
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
    // As a window says which session it has on screen (the others' words come less often): the first, unless
    // `--shown all` (every one, as a client that never says) or `--shown none` (a window on Home).
    if (SHOWN !== "all") await call("session.shown", SHOWN === "none" ? {} : { id: ids[0] });
    console.error(`cavvy: ${n} sessions on ${ref}${SHOWN === "all" ? "" : `, shown: ${SHOWN}`}`);
    return {
        serverPid: server.pid,
        async turn(i, k) {
            const id = ids[i]!;
            if (TIMES) require("fs").appendFileSync(TIMES, JSON.stringify({ at: Date.now(), what: "send", i, k, id }) + "\n");
            const done = new Promise<{ error?: string }>((r) => waiters.set(id, { seen: false, done: r }));
            const r = await call("session.send", { id, text: prompt(i, k) });
            if (r.error) { waiters.delete(id); return { error: r.error.message }; }
            // Over before its "running" was heard (statuses can coalesce): asked, every few seconds.
            const check = setInterval(async () => {
                const w = waiters.get(id);
                if (!w || w.seen) return;
                const st = (await call("session.open", { id })).result?.state;
                if (waiters.get(id) === w && st && !st.busy && st.status !== "running" && st.status !== "waiting") { waiters.delete(id); w.done({ error: st.status === "error" ? "error" : undefined }); }
            }, 5000);
            try { return await done; } finally { clearInterval(check); }
        },
        // Something the server answers from memory: how long the GUI's requests wait behind its other work.
        async ping() { const t = performance.now(); await call("terminal.list", {}, 30_000); return performance.now() - t; },
        async stop() { ws.close(); server.kill("SIGTERM"); await Promise.race([server.exited, sleep(20_000)]); server.kill("SIGKILL"); },
    };
}

async function bareDriver(n: number, dirs: string[], home: string): Promise<Driver> {
    const env = cleanEnv(home);
    const model = MODEL;
    const sessions = dirs.map((cwd) => {
        // As Cavvy starts it (claude-code.ts claudeArgs), but for its own permission prompts and MCP server.
        const proc = Bun.spawn(["claude", "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "auto", "--model", model], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
        // A prompt is done when a result names it (user_message_uuids): a report turn Claude Code starts by itself has a
        // result too, which isn't the prompt's.
        const s = { proc, running: false, error: undefined as string | undefined, waitingFor: "", done: undefined as undefined | ((r: { error?: string }) => void) };
        const finish = () => { const d = s.done; s.done = undefined; d?.({ error: s.error }); };
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
                        if (s.waitingFor && Array.isArray(r.user_message_uuids) && !r.user_message_uuids.includes(s.waitingFor)) continue;
                        if (s.waitingFor && !Array.isArray(r.user_message_uuids)) continue;
                        s.error = r.is_error ? String(r.subtype) : undefined;
                    } catch { continue; }
                    s.running = false;
                    finish();
                }
            }
            s.running = false;
            s.error = "exited";
            finish();
        })();
        return s;
    });
    console.error(`bare: ${n} claude processes on ${model}`);
    return {
        async turn(i, k) {
            const s = sessions[i]!;
            if (s.error === "exited") return { error: "exited" };
            s.running = true;
            s.waitingFor = crypto.randomUUID();
            const done = new Promise<{ error?: string }>((r) => (s.done = r));
            s.proc.stdin.write(JSON.stringify({ type: "user", uuid: s.waitingFor, message: { role: "user", content: [{ type: "text", text: prompt(i, k) }] } }) + "\n");
            await s.proc.stdin.flush();
            return done;
        },
        async ping() { return undefined; },
        async stop() { for (const s of sessions) { try { s.proc.stdin.end(); } catch {} s.proc.kill("SIGTERM"); } await sleep(2000); for (const s of sessions) s.proc.kill("SIGKILL"); },
    };
}

let asks = 0;

// ---- Kernel process accounting (--acct, root): every process's CPU when it ends, short-lived ones too.
const ACCT = args.includes("--acct");
const ACCT_KNOBS = "/proc/sys/kernel/acct";

/** Accounting on into `file`, or off. False when it can't be (not root, no BSD accounting in the kernel). */
function acctSwitch(file?: string): boolean {
    try {
        const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
        const lib = dlopen("libc.so.6", { acct: { args: [FFIType.ptr], returns: FFIType.i32 } });
        const path = file ? Buffer.from(`${file}\0`) : undefined;
        const r = lib.symbols.acct(path ? ptr(path) : null);
        lib.close();
        return r === 0;
    } catch {
        return false;
    }
}

/** comp_t: a 13-bit mantissa and a base-8 exponent, in 1/100 s (acct_v3's AHZ). */
const compT = (v: number) => (v & 0x1fff) * 8 ** ((v >> 13) & 7);

/** Each process accounted that ended after `since` (s since the epoch): its pid, parent, command and CPU seconds. */
function acctRecords(file: string, since: number): { pid: number; ppid: number; comm: string; cpu: number }[] {
    let d: Buffer;
    try { d = readFileSync(file); } catch { return []; }
    const out: { pid: number; ppid: number; comm: string; cpu: number }[] = [];
    for (let o = 0; o + 64 <= d.length; o += 64) {
        if (d[o + 1] !== 3) continue; // acct_v3
        const btime = d.readUInt32LE(o + 24), etime = d.readFloatLE(o + 28);
        if (btime + etime / 100 < since) continue;
        const end = d.indexOf(0, o + 48);
        out.push({ pid: d.readUInt32LE(o + 16), ppid: d.readUInt32LE(o + 20), comm: d.toString("latin1", o + 48, end < 0 || end > o + 64 ? o + 64 : end), cpu: (compT(d.readUInt16LE(o + 32)) + compT(d.readUInt16LE(o + 34))) / 100 });
    }
    return out;
}

/**
 * CPU seconds by command and by role: a process the samples saw as Cavvy or a CLI is that, one started under it is
 * "cavvy-helpers" or "agent-tools" (found through its parents).
 */
function acctReport(file: string, since: number, pidRoles: Record<number, string>) {
    const recs = acctRecords(file, since);
    const byPid = new Map(recs.map((r) => [r.pid, r]));
    const roleOf = (pid: number): string => {
        let p = pid, own = true;
        for (let k = 0; k < 64 && p; k++) {
            const r = pidRoles[p];
            if (r) return own ? r : r === "cavvy" ? "cavvy-helpers" : r === "claude-cli" ? "agent-tools" : `${r}-children`;
            const rec = byPid.get(p);
            if (!rec) return "other";
            p = rec.ppid;
            own = false;
        }
        return "other";
    };
    const byComm: Record<string, number> = {}, byRole: Record<string, number> = {};
    for (const r of recs) {
        byComm[r.comm] = (byComm[r.comm] ?? 0) + r.cpu;
        const role = roleOf(r.pid);
        byRole[role] = (byRole[role] ?? 0) + r.cpu;
    }
    const top = (o: Record<string, number>, k: number) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, k).map(([n, v]) => [n, r1(v)]));
    return { total: Math.round(recs.reduce((a, r) => a + r.cpu, 0)), byRole: top(byRole, 12), byCommand: top(byComm, 12) };
}

async function step(n: number) {
    const home = mkdtempSync(join(tmpdir(), `ramp-${MODE}-${n}-`));
    const dirs = Array.from({ length: n }, (_, i) => worktree(i));
    DIRS = dirs;
    const rep: Record<string, any> = { mode: MODE, sessions: n, model: MODEL, ...(MOCK ? { mock: true } : {}) };
    const samples: any[] = [];
    /** Long-lived processes by role, for attributing accounting records (their children) afterwards. */
    const pidRoles: Record<number, string> = { [process.pid]: "harness" };
    const turns: { session: number; k: number; seconds: number; error?: string }[] = [];
    const acctFile = join(OUT, `acct-${LABEL}-${n}.bin`);
    let knobs: string | undefined, accounting = false;
    if (ACCT) {
        try { require("fs").rmSync(acctFile, { force: true }); } catch {}
        // Accounting stops while the disk has under 2% free: on a benchmarking machine, it goes on to the end.
        try { knobs = readFileSync(ACCT_KNOBS, "utf8"); writeFileSync(ACCT_KNOBS, "1 0 30"); } catch { knobs = undefined; }
        writeFileSync(acctFile, "");
        accounting = acctSwitch(acctFile);
        if (!accounting) console.error("--acct: process accounting couldn't be turned on (it needs root, and BSD accounting in the kernel)");
    }
    // Everything from here is the run: starting Cavvy or the CLIs counts.
    const launchedAt = performance.now(), launchedEpoch = Date.now() / 1000, stat0 = cpuStat();
    let driver: Driver | undefined;
    let firstSendAt = 0, endAt = 0, stat1 = stat0;
    let sampling = true;
    const sampler = (async () => {
        const ps0 = procs();
        let lastPs = ps0, lastT = performance.now(), lastStat = cpuStat();
        while (sampling) {
            await sleep(1000);
            const pingP = driver?.ping() ?? Promise.resolve(undefined);
            const now = performance.now(), w = (now - lastT) / 1000;
            const ps = procs(), role = roles(ps, process.pid, driver?.serverPid);
            const cpu: Record<string, number> = {}, rss: Record<string, number> = {}, count: Record<string, number> = {};
            for (const p of ps.values()) {
                const rl = role.get(p.pid) ?? "other";
                if (rl === "cavvy" || rl === "claude-cli" || rl === "harness") pidRoles[p.pid] = rl;
                cpu[rl] = (cpu[rl] ?? 0) + Math.max(0, p.cpu - (lastPs.get(p.pid)?.cpu ?? (ps0.has(p.pid) ? p.cpu : 0)));
                rss[rl] = (rss[rl] ?? 0) + p.rssKB / 1024;
                count[rl] = (count[rl] ?? 0) + 1;
            }
            const st = cpuStat();
            const ping = await Promise.race([pingP, sleep(5000).then(() => 5000)]);
            samples.push({
                t: r1((now - launchedAt) / 1000), w: r1(w), pingMs: ping === undefined ? undefined : r1(ping),
                cpuSec: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, Math.round(v * 100) / 100])),
                rssMB: Object.fromEntries(Object.entries(rss).map(([k, v]) => [k, Math.round(v)])), procs: count,
                machineBusyPct: r1(((st.busy - lastStat.busy) / (st.total - lastStat.total)) * 100),
                psi: { cpu: psi("cpu"), io: psi("io"), memory: psi("memory") }, availMB: memAvailableMB(),
            });
            lastPs = ps; lastT = now; lastStat = st;
        }
    })();
    try {
        driver = MODE === "cavvy" ? await cavvyDriver(n, dirs, home) : await bareDriver(n, dirs, home);
        firstSendAt = performance.now();
        const total = PER_SESSION ?? 1e9;
        const deadline = firstSendAt + (PER_SESSION ? 40 : MINUTES) * 60_000;
        // Each session sends its next turn as soon as its last one ends. Started a little apart, as people do.
        await Promise.all(dirs.map(async (_, i) => {
            await sleep(i * 300);
            for (let k = 0; k < total && performance.now() < deadline; k++) {
                const t = performance.now();
                const r = await Promise.race([driver!.turn(i, k), sleep(8 * 60_000).then(() => ({ error: "hung" }))]);
                turns.push({ session: i, k, seconds: r1((performance.now() - t) / 1000), error: r.error });
                if (TIMES) require("fs").appendFileSync(TIMES, JSON.stringify({ at: Date.now(), what: "done", i, k }) + "\n");
                if (r.error === "exited" || r.error === "hung") break;
            }
        }));
        endAt = performance.now();
        stat1 = cpuStat();
        if (HOLD > 0) {
            // Idle: sessions open, their CLIs alive, nothing asked. Each role's CPU over it, from the samples.
            const from = samples.length, statHeld = cpuStat();
            await sleep(HOLD * 1000);
            const held = samples.slice(from);
            const roleSum = (r: string) => Math.round(held.reduce((a, x) => a + (x.cpuSec[r] ?? 0), 0) * 100) / 100;
            rep.idle = { seconds: HOLD, machineCpuSeconds: Math.round((cpuStat().busy - statHeld.busy) / 100), cpuSeconds: Object.fromEntries(["cavvy", "cavvy-helpers", "claude-cli", "agent-tools", "other"].map((r) => [r, roleSum(r)])) };
        }
    } catch (e) {
        rep.error = String((e as Error)?.stack ?? e);
    } finally {
        sampling = false;
        await sampler;
        await driver?.stop();
        if (accounting) acctSwitch();
        if (knobs !== undefined) try { writeFileSync(ACCT_KNOBS, knobs); } catch {}
    }
    const stoppedStat = cpuStat();
    const col = (f: (x: any) => number | undefined) => samples.map(f).filter((x): x is number => typeof x === "number" && !Number.isNaN(x));
    const rssAvg = (r: string) => Math.round(avg(col((x) => x.rssMB[r] ?? 0)));
    const turnSecs = turns.filter((t) => !t.error).map((t) => t.seconds);
    const jiffies = (a: { busy: number }, b: { busy: number }) => Math.round((b.busy - a.busy) / 100);
    rep.summary = {
        sessions: n, turns: turns.length, asks, failed: turns.filter((t) => t.error).length, hung: turns.filter((t) => t.error === "hung").length,
        // Wall time: from launching Cavvy or the CLIs, and from the first prompt, to the last turn's end.
        secondsFromLaunch: r1((endAt - launchedAt) / 1000), secondsFromFirstPrompt: r1((endAt - firstSendAt) / 1000),
        turnSecondsMedian: r1(pct(turnSecs, 0.5)), turnSecondsP90: r1(pct(turnSecs, 0.9)),
        // The whole machine's CPU over that time (the machine runs nothing else), and up to everything stopped.
        machineCpuSeconds: jiffies(stat0, stat1), machineCpuSecondsWithStop: jiffies(stat0, stoppedStat),
        // CPU by role, from the 1 s samples (misses processes shorter than a sample) and by command, from accounting.
        sampledCpuSeconds: Object.fromEntries(["cavvy", "cavvy-helpers", "claude-cli", "agent-tools", "other"].map((r) => [r, Math.round(col((x) => x.cpuSec[r] ?? 0).reduce((a, b) => a + b, 0))])),
        ...(accounting ? { acct: acctReport(acctFile, launchedEpoch, pidRoles) } : {}),
        rssMBAvg: { cavvy: rssAvg("cavvy"), helpers: rssAvg("cavvy-helpers"), cli: rssAvg("claude-cli"), tools: rssAvg("agent-tools") },
        rssMBPeak: { cavvy: Math.max(0, ...samples.map((x) => x.rssMB.cavvy ?? 0)), cli: Math.max(0, ...samples.map((x) => x.rssMB["claude-cli"] ?? 0)) },
        machineBusyPctAvg: r1(avg(col((x) => x.machineBusyPct))), availMBMin: Math.min(...col((x) => x.availMB)),
        psiAvg: { cpu: r1(avg(col((x) => x.psi.cpu))), io: r1(avg(col((x) => x.psi.io))), memory: r1(avg(col((x) => x.psi.memory))) },
        pingMs: { p50: r1(pct(col((x) => x.pingMs), 0.5)), p95: r1(pct(col((x) => x.pingMs), 0.95)), max: r1(Math.max(0, ...col((x) => x.pingMs))) },
        cores: NCPU, memMB: Math.round(totalmem() / 1048576),
        ...(rep.idle ? { idle: rep.idle } : {}),
    };
    rep.turns = turns;
    rep.pidRoles = pidRoles;
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
