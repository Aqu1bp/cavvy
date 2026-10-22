// Q2 follow-up (#219): can ANY control message stop the foreground turn while keeping a background Agent alive?
// One variant per run:  PROBE_VARIANT=<name> bun scripts/probes/claude-interrupt-variants.ts
//   base                plain interrupt (control run, agent sleeping in a Bash call)
//   a-uuid              interrupt with message_uuid = the running turn's prompt uuid (no send_now)
//   a-uuid-sendnow      interrupt {send_now:true, message_uuid: the running turn's prompt uuid}
//   b-noqueue           interrupt {cancel_queued:false}
//   b-sendnow-empty     interrupt {send_now:true}, nothing queued
//   b-sendnow-bash      queue a 2nd user message, then interrupt {send_now:true, message_uuid:<2nd>} while the turn waits on a foreground Bash
//   b-sendnow-text      same, but the turn is streaming text (no tool running)
//   c-agent-text        plain interrupt while the background Agent is generating text (no tool call inside it)
//   d-moved             foreground Agent -> background_tasks {tool_use_id} -> plain interrupt
//   e-now-text          user message priority "now" while the turn streams text
//   f-spared            interrupt {for_user_message_uuids:[<unrelated uuid>]}
//   b-sendnow-slash     like b-sendnow-bash, but the queued message is the slash command "/cost" (does a no-model message work as the Send-now carrier?)
//   f-reason            interrupt {reason:"user-cancel"} (the documented @internal abort-reason field)
//   e-now-slash         like e-now-text, but the priority "now" message is the slash command "/cost" (a carrier that needs no model call)
//   entry-desktop       base, with CLAUDE_CODE_ENTRYPOINT=claude-desktop
//   entry-local-agent   base, with CLAUDE_CODE_ENTRYPOINT=local-agent
// The background Agent either runs `python3 sleep(AGENT_S); touch marker` in a foreground Bash, or (c) writes a long text.
import { existsSync, rmSync } from "node:fs";
import { Log, sleep, fixture, SCRATCH } from "./lib";
import { startClaude } from "./claude-lib";

const V = process.env.PROBE_VARIANT ?? "base";
if (V === "entry-desktop") process.env.CLAUDE_CODE_ENTRYPOINT = "claude-desktop";
if (V === "entry-local-agent") process.env.CLAUDE_CODE_ENTRYPOINT = "local-agent";
const AGENT_S = 45;
const marker = `${SCRATCH}/marker-agent-${V}.txt`;
rmSync(marker, { force: true });
const count = async (re: string) => (await Bun.$`pgrep -f ${re}`.nothrow().text()).trim().split("\n").filter(Boolean).length;
const pyAgent = `python3 -c "import time,pathlib; time.sleep(${AGENT_S}); pathlib.Path('${marker}').touch()"`;
const pyFg = `python3 -c "import time; time.sleep(121)"`;

class QuietLog extends Log {
    private streamEvents = 0;
    add(dir: "in" | "out" | "err" | "note", frame: unknown) {
        // keep fixtures small: only the first few partial-message frames
        if (dir === "in" && (frame as any)?.type === "stream_event" && ++this.streamEvents > 4) return;
        // /cost prints the account's usage; keep the shape, drop the numbers
        const text = JSON.stringify(frame);
        if (/% used/.test(text)) frame = JSON.parse(text.replace(/\d+% used/g, "<n>% used").replace(/resets [^\\"]*/g, "resets <t>"));
        super.add(dir, frame);
    }
}
const log = new QuietLog(fixture(`claude-q2-${V}`));
const extra = ["--include-partial-messages"];
if (process.env.PROBE_DEBUG) extra.push("--debug-file", process.env.PROBE_DEBUG);
const { p, control, user, result } = startClaude(log, extra);
await control({ subtype: "initialize" });

const agentPrompt =
    V === "c-agent-text"
        ? `Write the integers from 1 to 700, one per line, as plain text. Use no tools. Then say done.`
        : `Run this Bash command in the foreground, exactly: ${pyAgent.replace(/"/g, '\\"')} . Then reply done.`;
const launchAgent =
    V === "d-moved"
        ? `1) Agent tool in the FOREGROUND (do NOT set run_in_background), prompt: "${agentPrompt}" `
        : `1) Agent tool with run_in_background=true, prompt: "${agentPrompt}" `;
const textTurn = (V.endsWith("-text") && V !== "c-agent-text") || V === "e-now-slash";
const N_TEXT = V === "b-sendnow-text" ? 2500 : 400;
const second = textTurn ? `2) Then write the integers from 1 to ${N_TEXT}, one per line, as plain text, with no tools. ` : `2) Then Bash in the foreground (no run_in_background), command: ${pyFg} `;
const mark = p.frames.length;
const promptUuid = user(`Do these in order, without asking anything. ${launchAgent}${second}Do not do anything else.`);

// wait for the agent task to start
const started = await p.waitFor((f) => f.type === "system" && f.subtype === "task_started" && /agent/i.test(`${f.task_type}`), 90_000, mark);
log.note(`agent task_started: ${JSON.stringify({ task_id: started?.task_id, tool_use_id: started?.tool_use_id, task_type: started?.task_type })}`);
if (V === "d-moved") {
    for (let i = 0; i < 60 && !(await count(`time.sleep\\(${AGENT_S}\\)`)); i++) await sleep(500);
    let r: any;
    for (let i = 0; i < 6 && !r?.response?.backgrounded; i++) {
        await sleep(1500);
        r = await control({ subtype: "background_tasks", tool_use_id: started?.tool_use_id });
        log.note(`background_tasks -> ${JSON.stringify(r?.response)}`);
    }
}
// wait until the main turn is in the state the variant needs
if (V === "d-moved") {
    // the Agent call is still blocking the turn: nothing else to wait for
} else if (textTurn) {
    // first text delta of the main turn after the agent was launched
    const d = await p.waitFor((f) => f.type === "stream_event" && f.event?.type === "content_block_delta" && f.event?.delta?.type === "text_delta" && !f.parent_tool_use_id, 60_000, p.frames.indexOf(started));
    log.note(`main turn streaming text: ${!!d}`);
    await sleep(1500);
} else if (V === "c-agent-text") {
    await sleep(5000);
    for (let i = 0; i < 60 && !(await count("time.sleep\\(121\\)")); i++) await sleep(500);
} else {
    for (let i = 0; i < 120 && !((await count(`time.sleep\\(${AGENT_S}\\)`)) && (await count("time.sleep\\(121\\)"))); i++) await sleep(500);
}
const st = { agentPy: await count(`time.sleep\\(${AGENT_S}\\)`), fgPy: await count("time.sleep\\(121\\)") };
log.note(`before action: ${JSON.stringify(st)}; main turn running=${!p.frames.slice(mark).some((f) => f.type === "result")}`);

const afterMark = p.frames.length;
const t = Date.now();
let resp: any;
const ctl = async (req: Record<string, unknown>) => {
    resp = await control(req);
    log.note(`${JSON.stringify(req)} -> ${JSON.stringify(resp?.response ?? resp)}`);
};
switch (V) {
    case "base":
    case "entry-desktop":
    case "entry-local-agent":
    case "c-agent-text":
    case "d-moved":
        await ctl({ subtype: "interrupt" });
        break;
    case "a-uuid":
        await ctl({ subtype: "interrupt", message_uuid: promptUuid });
        break;
    case "a-uuid-sendnow":
        await ctl({ subtype: "interrupt", send_now: true, message_uuid: promptUuid });
        break;
    case "b-noqueue":
        await ctl({ subtype: "interrupt", cancel_queued: false });
        break;
    case "b-sendnow-empty":
        await ctl({ subtype: "interrupt", send_now: true });
        break;
    case "b-sendnow-bash":
    case "b-sendnow-slash":
    case "b-sendnow-text": {
        const u2 = user(V === "b-sendnow-slash" ? "/cost" : "Reply with exactly the word: second");
        const q = await p.waitFor((f) => f.type === "command_lifecycle" && f.command_uuid === u2 && f.state === "queued", 5000, afterMark);
        log.note(`second message queued: ${!!q}`);
        await ctl({ subtype: "interrupt", send_now: true, message_uuid: u2 });
        break;
    }
    case "f-reason":
        await ctl({ subtype: "interrupt", reason: "user-cancel" });
        break;
    case "f-spared":
        await ctl({ subtype: "interrupt", for_user_message_uuids: [crypto.randomUUID()] });
        break;
    case "e-now-text":
        user("Reply with exactly the word: steered", { priority: "now" });
        break;
    case "e-now-slash":
        user("/cost", { priority: "now" });
        break;
    default:
        throw new Error(`unknown variant ${V}`);
}
const r = await result(afterMark, V === "b-sendnow-bash" || V === "b-sendnow-slash" || V === "f-spared" || V === "a-uuid-sendnow" || V === "b-sendnow-empty" ? 25_000 : 30_000);
log.note(`first result after the action in ${Date.now() - t} ms: ${r ? `subtype=${r.subtype} is_error=${r.is_error} terminal_reason=${r.terminal_reason ?? ""} result="${String(r.result).slice(0, 40)}"` : "none within the wait"}`);
await sleep(2000);
log.note(`2 s later: alive=${p.alive()} agentPy=${await count(`time.sleep\\(${AGENT_S}\\)`)} fgPy=${await count("time.sleep\\(121\\)")}`);

// Is the agent still alive? wait for its end (marker or notification)
const agentNotif = (from: number) => p.frames.slice(from).find((f) => f.type === "system" && f.subtype === "task_notification" && f.task_id === started?.task_id);
const deadline = Date.now() + (AGENT_S + 25) * 1000;
while (Date.now() < deadline && !agentNotif(afterMark)) await sleep(1500);
const n = agentNotif(afterMark);
log.note(`agent task_notification: ${n ? n.status : "none"}; marker written=${existsSync(marker)}`);
const after = p.frames.slice(afterMark).filter((f) => f.type !== "stream_event");
log.note(`frames after the action (type/subtype): ${after.map((f) => `${f.type}${f.subtype ? "/" + f.subtype : ""}${f.state ? ":" + f.state : ""}${f.status ? ":" + f.status : ""}`).join(" ")}`);
await p.kill();
await Bun.$`pkill -f "time.sleep.121."`.nothrow().quiet();
await Bun.$`pkill -f ${`time.sleep.${AGENT_S}.`}`.nothrow().quiet();
