// Q6: a Codex background terminal across turn completion and turn/interrupt; thread/backgroundTerminals/list and
// /terminate, with and without the experimentalApi capability in initialize.
//   bun scripts/probes/codex-background-terminal.ts            (no capability: expect the methods to be refused)
//   PROBE_EXPERIMENTAL=1 bun scripts/probes/codex-background-terminal.ts
import { existsSync, rmSync } from "node:fs";
import { Log, sleep, fixture, SCRATCH } from "./lib";
import { startCodex } from "./codex-lib";

const EXP = process.env.PROBE_EXPERIMENTAL === "1";
const MODEL = process.env.PROBE_CODEX_MODEL ?? "gpt-6-luna";
const marker = `${SCRATCH}/codex-bg-marker.txt`;
rmSync(marker, { force: true });
const count = async (re: string) => (await Bun.$`pgrep -f ${re}`.nothrow().text()).trim().split("\n").filter(Boolean).length;
const BG = "time.sleep(70)";
const FG = "time.sleep(55)";

const log = new Log(fixture(EXP ? "codex-background-terminal-experimental" : "codex-background-terminal-no-capability"));
const c = startCodex(log, { experimentalApi: EXP });
const init = await c.handshake();
log.note(`initialize -> ${init.error ? JSON.stringify(init.error) : "ok"}`);
const th = await c.request("thread/start", { cwd: SCRATCH, model: MODEL, approvalPolicy: "never", sandbox: "workspace-write" });
const threadId = th.result?.thread?.id;
log.note(`thread/start -> ${threadId} ${th.error ? JSON.stringify(th.error) : ""}`);

const list = async (label: string) => {
    const r = await c.request("thread/backgroundTerminals/list", { threadId });
    log.note(`thread/backgroundTerminals/list ${label} -> ${JSON.stringify(r.result ?? r.error ?? "timeout")}`);
    return r;
};

// Turn A: start a command that outlives the turn.
let from = c.p.frames.length;
const a = await c.turnStart(threadId, `Call your exec_command tool once with yield_time_ms=1000 and this exact command, with no nohup, no & and no redirection (so that it is still running when the tool returns and stays a background terminal): python3 -c "import time,pathlib; time.sleep(70); pathlib.Path('${marker}').touch()"   Do not poll it and do not wait for it. Then end your turn with the single word: started.`, { effort: "low", model: MODEL });
const aId = a.result?.turn?.id;
const aDone = await c.p.waitFor((f) => f.method === "turn/completed" && f.params?.turn?.id === aId, 120_000, from);
log.note(`turn A completed: ${aDone?.params?.turn?.status}; python (70 s) processes=${await count("time.sleep\\(70\\)")}`);
const items = c.p.frames.slice(from).filter((f) => f.method === "item/completed" && f.params?.item?.type === "commandExecution").map((f) => ({ status: f.params.item.status, processId: f.params.item.processId, source: f.params.item.source, command: String(f.params.item.command).slice(0, 80) }));
log.note(`commandExecution items of turn A: ${JSON.stringify(items)}`);
log.note(`after turn A: background python (70 s) processes=${await count("time.sleep\\(70\\)")}`);
const l1 = await list("after turn A completed");

// Turn B: a foreground command, interrupted mid-turn.
from = c.p.frames.length;
const b = await c.turnStart(threadId, `Run this in the foreground and wait for it to finish: python3 -c "import time; time.sleep(55)"`, { effort: "low", model: MODEL });
const bId = b.result?.turn?.id;
for (let i = 0; i < 120 && !(await count("time.sleep\\(55\\)")); i++) await sleep(500);
log.note(`turn B running; background python (70 s) processes=${await count("time.sleep\\(70\\)")}; foreground python processes=${await count("time.sleep\\(55\\)")}`);
const intFrom = c.p.frames.length;
const int = await c.request("turn/interrupt", { threadId, turnId: bId });
log.note(`turn/interrupt -> ${JSON.stringify(int.result ?? int.error)}`);
const bDone = await c.p.waitFor((f) => f.method === "turn/completed" && f.params?.turn?.id === bId, 30_000, intFrom);
log.note(`turn B completed: ${bDone?.params?.turn?.status}`);
await sleep(1500);
log.note(`after interrupt: background python (70 s) processes=${await count(BG.replace(/[()]/g, "\\$&"))}, foreground python (55 s) processes=${await count(FG.replace(/[()]/g, "\\$&"))}; app-server alive=${c.p.alive()}`);
const l2 = await list("after turn/interrupt");

// Terminate.
const procs: any[] = l2.result?.data ?? l2.result?.terminals ?? l1.result?.data ?? l1.result?.terminals ?? [];
const processId = procs[0]?.processId ?? procs[0]?.id;
if (processId) {
    const t = await c.request("thread/backgroundTerminals/terminate", { threadId, processId: String(processId) });
    log.note(`thread/backgroundTerminals/terminate ${processId} -> ${JSON.stringify(t.result ?? t.error ?? "timeout")}`);
    await sleep(2000);
    log.note(`after terminate: background python processes=${await count(BG.replace(/[()]/g, "\\$&"))}`);
    await list("after terminate");
} else {
    const t = await c.request("thread/backgroundTerminals/terminate", { threadId, processId: "does-not-exist" });
    log.note(`no terminal listed; terminate(does-not-exist) -> ${JSON.stringify(t.result ?? t.error ?? "timeout")}`);
}
// Turn C: a terminal that ends on its own after the turn completed: what does the app-server say, if anything?
if (EXP) {
    from = c.p.frames.length;
    const cc = await c.turnStart(threadId, `Call your exec_command tool once with yield_time_ms=1000 and this exact command, with no nohup, no & and no redirection: python3 -c "import time; time.sleep(9)"   Do not poll it and do not wait for it. Then end your turn with the single word: started.`, { effort: "low", model: MODEL });
    const cId = cc.result?.turn?.id;
    const cDone = await c.p.waitFor((f) => f.method === "turn/completed" && f.params?.turn?.id === cId, 120_000, from);
    const doneAt = c.p.frames.length;
    log.note(`turn C completed (${cDone?.params?.turn?.status}); its command should still be running; waiting 20 s for it to end by itself`);
    await sleep(20_000);
    log.note(`notifications after turn C completed, while its terminal ended by itself: ${JSON.stringify(c.notes(doneAt).map((f) => ({ method: f.method, item: f.params?.item?.type, status: f.params?.item?.status, processId: f.params?.processId ?? f.params?.item?.processId })))}`);
    await list("after turn C's terminal ended by itself");
}
log.note(`notifications seen (distinct): ${[...new Set(c.notes().map((f) => f.method))].join(", ")}`);
log.note(`marker written (the background command finished its sleep): ${existsSync(marker)}`);
await c.stop();
await Bun.$`pkill -f "time.sleep.70."`.nothrow().quiet();
await Bun.$`pkill -f "time.sleep.55."`.nothrow().quiet();
