// Q1 and Q4: does the process stay alive and idle after a result; does a second user message start a
// second turn on the same pid; do the control requests succeed between turns.
//   bun scripts/probes/claude-idle.ts
import { Log, sleep, fixture, pidAlive } from "./lib";
import { startClaude } from "./claude-lib";

const log = new Log(fixture("claude-idle-and-controls"));
const { p, control, user, result } = startClaude(log);
const pid = p.pid;
log.note(`pid ${pid}`);
const init = await control({ subtype: "initialize" });
log.note(`initialize -> ${init?.response?.subtype}`);

let mark = p.frames.length;
user("Reply with exactly the word: one");
const r1 = await result(mark, 90_000);
log.note(`turn 1 result: ${r1?.subtype} "${String(r1?.result).slice(0, 60)}"`, { sessionId: r1?.session_id });

// Idle: nothing should arrive; the process should stay alive and stdin open.
await sleep(500); // the "completed" lifecycle frame follows the result closely
const framesBeforeIdle = p.frames.length;
await sleep(8000);
log.note(`after 8 s idle: alive=${p.alive() && pidAlive(pid)}, new frames while idle=${p.frames.length - framesBeforeIdle}`);

// Control requests between turns.
for (const request of [
    { subtype: "set_model", model: "haiku" },
    { subtype: "apply_flag_settings", settings: { effortLevel: "low" } },
    { subtype: "get_context_usage" },
    { subtype: "background_tasks", tool_use_id: "toolu_does_not_exist" },
    { subtype: "stop_task", task_id: "task_does_not_exist" },
    { subtype: "set_permission_mode", mode: "bypassPermissions" },
]) {
    const r = await control(request);
    log.note(`${request.subtype} between turns -> ${r ? JSON.stringify(r.response).slice(0, 300) : "NO RESPONSE"}`);
}

mark = p.frames.length;
user("Reply with exactly the word: two");
const r2 = await result(mark, 90_000);
log.note(`turn 2 result: ${r2?.subtype} "${String(r2?.result).slice(0, 60)}" same pid=${p.pid === pid} alive=${p.alive()}`);
log.note(`same session_id across turns: ${r1?.session_id === r2?.session_id}`);

await p.kill();
console.log(JSON.stringify({ turn1: r1?.subtype, turn2: r2?.subtype, samePid: p.pid === pid }));
