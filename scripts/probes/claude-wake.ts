// Q3 and Q4 (stop_task, background_tasks): the frames when a background task finishes while no turn is
// running; stop_task on a running background task; background_tasks {tool_use_id} on a foreground command.
//   bun scripts/probes/claude-wake.ts
import { Log, sleep, fixture, SCRATCH } from "./lib";
import { startClaude } from "./claude-lib";

const count = async (re: string) => (await Bun.$`pgrep -f ${re}`.nothrow().text()).trim().split("\n").filter(Boolean).length;
const log = new Log(fixture("claude-wake-and-stop-task"));
const { p, control, user, result } = startClaude(log);
await control({ subtype: "initialize" });

// Turn 1: two background commands, then the turn ends.
let mark = p.frames.length;
user("Start two background commands with Bash run_in_background=true, one tool call each: (A) `sleep 14; echo WAKE_OK` and (B) `sleep 301`. Then end your turn with the single word: started. Do not wait for them.");
const r1 = await result(mark, 90_000);
log.note(`turn 1 result: ${r1?.subtype} "${String(r1?.result).slice(0, 40)}" origin=${JSON.stringify(r1?.origin ?? null)}`);
const started = p.frames.filter((f) => f.type === "system" && f.subtype === "task_started" && f.task_type === "local_bash");
const idOf = (needle: string) => started.find((f) => String(f.description ?? "").includes(needle) || String(f.command ?? "").includes(needle));
log.note(`task_started frames: ${JSON.stringify(started.map((f) => ({ task_id: f.task_id, description: f.description, tool_use_id: f.tool_use_id })))}`);
const taskB = started.find((f) => /301/.test(JSON.stringify(f))) ?? started[1];
const taskA = started.find((f) => f !== taskB);

// Idle now. Task A finishes on its own: record the frames that arrive with no turn running.
mark = p.frames.length;
log.note("idle: waiting for task A to finish and for whatever Claude Code does about it");
const wakeResult = await p.waitFor((f) => f.type === "result", 60_000, mark);
await sleep(500);
const wakeFrames = p.frames.slice(mark);
log.note(`frames while idle (type/subtype): ${wakeFrames.map((f) => `${f.type}${f.subtype ? "/" + f.subtype : ""}`).join(" ")}`);
log.note(`wake result: subtype=${wakeResult?.subtype} origin=${JSON.stringify(wakeResult?.origin ?? null)} user_message_uuid=${wakeResult?.user_message_uuid ?? null} text="${String(wakeResult?.result).slice(0, 80)}"`);

// stop_task on B (still sleeping 301).
log.note(`before stop_task: sleep 301 processes=${await count("sleep 301")}, taskB=${taskB?.task_id}`);
mark = p.frames.length;
const stop = await control({ subtype: "stop_task", task_id: taskB?.task_id });
log.note(`stop_task -> ${JSON.stringify(stop?.response)}`);
await sleep(3000);
const stopFrames = p.frames.slice(mark);
log.note(`frames after stop_task (type/subtype): ${stopFrames.map((f) => `${f.type}${f.subtype ? "/" + f.subtype : ""}`).join(" ")}`);
log.note(`after stop_task: sleep 301 processes=${await count("sleep 301")}`);
const stopResult = stopFrames.find((f) => f.type === "result");
log.note(`stop_task produced a turn/result: ${Boolean(stopResult)} origin=${JSON.stringify(stopResult?.origin ?? null)}`);

// background_tasks {tool_use_id} on a running foreground command.
mark = p.frames.length;
user(`Run this Bash command in the foreground (no run_in_background): python3 -c "import time; time.sleep(45)" . Then reply with the single word: finished.`);
const fg = await p.waitFor((f) => f.type === "assistant" && JSON.stringify(f).includes("time.sleep(45)") && JSON.stringify(f).includes("tool_use"), 60_000, mark);
const toolUse = fg?.message?.content?.find((b: any) => b.type === "tool_use" && JSON.stringify(b).includes("time.sleep(45)"));
// A foreground command only becomes a task a few seconds after it starts (a task_started with is_backgrounded:false);
// a background_tasks request before that answers backgrounded:false (seen in a first attempt).
const early = await control({ subtype: "background_tasks", tool_use_id: toolUse?.id });
log.note(`background_tasks before its task_started -> ${JSON.stringify(early?.response)}`);
await p.waitFor((f) => f.type === "system" && f.subtype === "task_started" && f.tool_use_id === toolUse?.id, 15_000, mark);
log.note(`foreground command tool_use_id=${toolUse?.id}; python running=${await count("time.sleep\\(45\\)")}`);
mark = p.frames.length;
const bt = await control({ subtype: "background_tasks", tool_use_id: toolUse?.id });
log.note(`background_tasks -> ${JSON.stringify(bt?.response)}`);
const r3 = await result(mark, 30_000);
log.note(`turn ended soon after background_tasks: ${Boolean(r3)} (${r3?.result ? String(r3.result).slice(0, 60) : ""}); python still running=${await count("time.sleep\\(45\\)")}`);
log.note(`frames after background_tasks (type/subtype): ${p.frames.slice(mark).map((f) => `${f.type}${f.subtype ? "/" + f.subtype : ""}`).join(" ")}`);
// let that command finish to see its completion frames
await p.waitFor((f) => f.type === "system" && f.subtype === "task_notification" && f.tool_use_id === toolUse?.id, 60_000, mark);
await p.waitFor((f) => f.type === "result", 40_000, p.frames.length);
await p.kill();
await Bun.$`pkill -f "sleep 301"`.nothrow().quiet();
