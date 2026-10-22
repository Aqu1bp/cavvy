// Q2 (extra): does a Monitor task survive interrupt? Turn 1 starts a Monitor and ends; turn 2 runs a
// foreground command; we interrupt there and watch whether the Monitor keeps producing events.
//   bun scripts/probes/claude-interrupt-monitor.ts
import { Log, sleep, fixture } from "./lib";
import { startClaude } from "./claude-lib";

const count = async (re: string) => (await Bun.$`pgrep -f ${re}`.nothrow().text()).trim().split("\n").filter(Boolean).length;
const log = new Log(fixture("claude-interrupt-monitor"));
const { p, control, user, result } = startClaude(log);
await control({ subtype: "initialize" });

let mark = p.frames.length;
user(`Use the Monitor tool to watch this command, which prints a line every 2 seconds for about 90 seconds: for i in $(seq 1 45); do echo tick-$i; sleep 2; done . After starting the monitor, end your turn with the single word: monitoring.`);
const r1 = await result(mark, 90_000);
log.note(`turn 1: ${r1?.subtype} "${String(r1?.result).slice(0, 60)}"`);
const started = p.frames.filter((f) => f.type === "system" && f.subtype === "task_started");
log.note(`task_started: ${JSON.stringify(started.map((f) => ({ task_id: f.task_id, task_type: f.task_type, description: f.description })))}`);

mark = p.frames.length;
user(`Run this Bash command in the foreground (no run_in_background): python3 -c "import time; time.sleep(120)" . Then reply with the single word: finished.`);
for (let i = 0; i < 60 && !(await count("time.sleep\\(120\\)")); i++) await sleep(500);
await sleep(1000);
const ticksBefore = JSON.stringify(p.frames).match(/tick-\d+/g)?.length ?? 0;
mark = p.frames.length;
const resp = await control({ subtype: "interrupt" });
log.note(`interrupt -> ${JSON.stringify(resp?.response)}`);
const r2 = await result(mark, 20_000);
log.note(`result after interrupt: ${r2?.subtype} terminal_reason=${r2?.terminal_reason}`);
const afterMark = p.frames.length;
await sleep(12_000);
const after = p.frames.slice(afterMark);
log.note(`frames in the 12 s after (type/subtype): ${after.map((f) => `${f.type}${f.subtype ? "/" + f.subtype : ""}`).join(" ")}`);
const ticksAfter = JSON.stringify(after).match(/tick-\d+/g)?.length ?? 0;
log.note(`monitor ticks before interrupt=${ticksBefore}, ticks seen in the 12 s after=${ticksAfter}; monitor process alive=${(await count("seq 1 45")) > 0}`);
await p.kill();
await Bun.$`pkill -f "time.sleep.120."`.nothrow().quiet();
await Bun.$`pkill -f "seq 1 45"`.nothrow().quiet();
