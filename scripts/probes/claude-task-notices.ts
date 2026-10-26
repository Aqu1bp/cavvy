// #311: which task frames Claude Code sends for a task this process ran and one an earlier process left behind.
//   bun scripts/probes/claude-task-notices.ts A   a foreground Bash stopped by interrupt (Esc)
//   bun scripts/probes/claude-task-notices.ts B   a background sub-agent's foreground commands (one fails)
//   bun scripts/probes/claude-task-notices.ts C   background work left behind by a killed process, then --resume
// Recorded 2026-10-23 against 2.1.304 with PROBE_CLAUDE_MODEL=claude-sonnet-5-5. Unlike the other probes it keeps the
// session (C resumes it). It stops only the processes it started, by pid (each claude and what runs under it).
import { JsonProc, Log, SCRATCH, fixture, sleep } from "./lib";
import { STREAM_ARGS } from "./claude-lib";

const model = process.env.PROBE_CLAUDE_MODEL ?? "haiku";
function start(name: string, extra: string[] = []) {
    const log = new Log(fixture(name));
    const p = new JsonProc(log, ["claude", ...STREAM_ARGS, "--model", model, "--effort", "low", "--permission-mode", "bypassPermissions", ...extra], { cwd: SCRATCH });
    let n = 0;
    const control = (request: Record<string, unknown>, ms = 15000) => {
        const request_id = `probe-${++n}`;
        const from = p.frames.length;
        p.send({ type: "control_request", request_id, request });
        return p.waitFor((f) => f.type === "control_response" && f.response?.request_id === request_id, ms, from);
    };
    const user = (text: string) => p.send({ type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "" });
    const result = (from: number, ms: number) => p.waitFor((f) => f.type === "result", ms, from);
    return { p, log, control, user, result };
}
const descendants = async (pid: number): Promise<number[]> => {
    const kids = (await Bun.$`pgrep -P ${pid}`.nothrow().text()).trim().split("\n").filter(Boolean).map(Number);
    return [...kids, ...(await Promise.all(kids.map(descendants))).flat()];
};
const killTree = async (pid: number) => {
    const under = await descendants(pid);
    for (const x of [pid, ...under]) {
        try {
            process.kill(x, "SIGKILL");
        } catch {}
    }
};

const which = process.argv[2];
if (which === "A") {
    const s = start("claude-311-a-esc-foreground");
    await s.control({ subtype: "initialize" });
    s.user(`Run this Bash command in the foreground (no run_in_background), exactly: python3 -c "import time; time.sleep(90)" . Nothing else.`);
    await s.p.waitFor((f) => f.type === "assistant" && JSON.stringify(f).includes("time.sleep(90)"), 60000);
    await sleep(12000);
    const from = s.p.frames.length;
    await s.control({ subtype: "interrupt" });
    await s.result(from, 20000);
    await sleep(3000);
    await killTree(s.p.pid);
} else if (which === "B") {
    const s = start("claude-311-b-subagent-commands");
    await s.control({ subtype: "initialize" });
    const from = s.p.frames.length;
    s.user(`Use the Agent tool with run_in_background=true, prompt: "Run this Bash command in the foreground, exactly: sh -c 'sleep 6; exit 3' . Then run this Bash command in the foreground, exactly: python3 -c \\"import time; time.sleep(8)\\" . Then reply done." Then reply launched. Do nothing else.`);
    await s.result(from, 60000);
    await s.p.waitFor((f) => f.type === "system" && f.subtype === "task_notification" && String(f.task_id).startsWith("a"), 120000);
    await sleep(15000);
    await killTree(s.p.pid);
} else if (which === "C") {
    const s = start("claude-311-c1-leave-behind");
    await s.control({ subtype: "initialize" });
    const from = s.p.frames.length;
    s.user(`Do both, without asking: 1) Bash with run_in_background=true, command: sleep 240 . 2) Agent tool with run_in_background=true, prompt: "Run this Bash command in the foreground, exactly: python3 -c \\"import time; time.sleep(240)\\" . Then reply done." Then reply launched. Do nothing else.`);
    const r = await s.result(from, 90000);
    await sleep(10000);
    s.log.note(`killing process tree, session ${r?.session_id}`);
    await killTree(s.p.pid);
    await sleep(1000);
    const s2 = start("claude-311-c2-resume", ["--resume", r?.session_id]);
    await s2.control({ subtype: "initialize" });
    const f2 = s2.p.frames.length;
    s2.user("Reply with exactly the word: resumed");
    await s2.p.waitFor((f) => f.type === "result" && String(f.result).includes("resumed"), 90000, f2);
    await sleep(5000);
    await killTree(s2.p.pid);
}
process.exit(0);
