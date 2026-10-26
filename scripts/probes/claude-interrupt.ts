// Q2: do background tasks survive control_request {subtype:"interrupt"} mid-turn?
// One turn starts a background Bash (sleep 61, then writes a marker file), a background sub-agent
// (which runs a python sleep 63 then writes a marker) and then a foreground `sleep 120` so the turn is
// still running; we interrupt there. Afterwards we watch whether the sleeps are still alive, the
// markers appear, and what frames the CLI emits (task_notification, a wake turn).
//   bun scripts/probes/claude-interrupt.ts            (control_request interrupt)
//   PROBE_ACTION=now bun scripts/probes/claude-interrupt.ts   (instead: a user message with priority "now", the t3code steer path)
import { existsSync, rmSync } from "node:fs";
import { Log, sleep, fixture, SCRATCH } from "./lib";
import { startClaude } from "./claude-lib";

const markers = { bash: `${SCRATCH}/marker-bash.txt`, agent: `${SCRATCH}/marker-agent.txt` };
for (const m of Object.values(markers)) rmSync(m, { force: true });
// Counts processes whose command line matches a regex (pgrep -f).
const count = async (re: string) => (await Bun.$`pgrep -f ${re}`.nothrow().text()).trim().split("\n").filter(Boolean).length;
const pyAgent = `python3 -c "import time,pathlib; time.sleep(63); pathlib.Path('${markers.agent}').touch()"`;
const pyFg = `python3 -c "import time; time.sleep(120)"`;

const ACTION = process.env.PROBE_ACTION === "now" ? "now" : "interrupt";
const log = new Log(fixture(ACTION === "now" ? "claude-steer-now-background" : "claude-interrupt-background"));
const { p, control, user, result } = startClaude(log);
await control({ subtype: "initialize" });

const mark = p.frames.length;
user(
    `Do these in order, without asking anything. ` +
        `1) Bash with run_in_background=true, command: sleep 61; touch ${markers.bash} ` +
        `2) Agent tool with run_in_background=true, prompt: "Run this Bash command in the foreground, exactly: ${pyAgent.replace(/"/g, '\\"')} . Then reply done." ` +
        `3) Bash in the foreground (no run_in_background), command: ${pyFg} ` +
        `Do not do anything else.`,
);
// Wait until the foreground sleep 120 is actually running (the third tool_use), plus a moment for the launches.
const running = async () => ({ bashSleep61: await count("sleep 61"), agentPy63: await count("time.sleep\\(63\\)"), fgPy120: await count("time.sleep\\(120\\)") });
let st = await running();
for (let i = 0; i < 120 && !(st.bashSleep61 && st.agentPy63 && st.fgPy120); i++) (await sleep(500), (st = await running()));
log.note(`before interrupt (process counts): ${JSON.stringify(st)}; turn still running=${!p.frames.slice(mark).some((f) => f.type === "result")}`);
const bgBefore = p.frames.filter((f) => f.type === "system" && /task_|background_tasks/.test(f.subtype ?? "")).map((f) => f.subtype);
log.note(`task frames before interrupt: ${bgBefore.join(", ")}`);

const afterMark = p.frames.length;
const t = Date.now();
if (ACTION === "now") user("Reply with exactly the word: steered", { priority: "now" });
const resp = ACTION === "now" ? undefined : await control({ subtype: "interrupt" });
if (resp) log.note(`interrupt -> ${JSON.stringify(resp.response)}`);
const r = await result(afterMark, 20_000);
log.note(`result after interrupt in ${Date.now() - t} ms: subtype=${r?.subtype} is_error=${r?.is_error} stop_reason=${r?.stop_reason} terminal_reason=${r?.terminal_reason ?? ""}`);
log.note(`result usage keys: ${r ? Object.keys(r).join(",") : ""}`);
await sleep(1500);
log.note(`just after interrupt: process alive=${p.alive()} ${JSON.stringify(await running())}`);

// Let the background work finish (and report) while we only watch.
const deadline = Date.now() + 75_000;
while (Date.now() < deadline && !(existsSync(markers.bash) && existsSync(markers.agent))) await sleep(2000);
await sleep(8000);
log.note(`after waiting: bash marker=${existsSync(markers.bash)} agent marker=${existsSync(markers.agent)} ${JSON.stringify(await running())} alive=${p.alive()}`);
const after = p.frames.slice(afterMark);
log.note(`frames after the interrupt (type/subtype): ${after.map((f) => `${f.type}${f.subtype ? "/" + f.subtype : ""}`).join(" ")}`);
const wake = after.filter((f) => f.type === "result");
log.note(`results after interrupt: ${wake.length}; origins: ${JSON.stringify(wake.map((w) => w.origin ?? null))}`);

// The same process still takes a new prompt?
const m2 = p.frames.length;
user("Reply with exactly the word: still-here");
const r2 = await result(m2, 60_000);
log.note(`prompt after interrupt: ${r2?.subtype} "${String(r2?.result).slice(0, 60)}" alive=${p.alive()}`);

await p.kill();
await Bun.$`pkill -f "time.sleep.120."`.nothrow().quiet();
