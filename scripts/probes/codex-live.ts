// Q5 and Q7: two turn/start on one thread on one app-server connection; is the thread still loaded
// between them; does account/rateLimits/updated arrive between turns.
//   bun scripts/probes/codex-live.ts
import { Log, sleep, fixture, SCRATCH } from "./lib";
import { startCodex } from "./codex-lib";

const MODEL = process.env.PROBE_CODEX_MODEL ?? "gpt-6-luna";
const log = new Log(fixture("codex-two-turns-one-connection"));
const c = startCodex(log);
const pid = c.p.pid;
const init = await c.handshake();
log.note(`initialize -> ${init.error ? JSON.stringify(init.error) : "ok"}; pid ${pid}`);
const th = await c.request("thread/start", { cwd: SCRATCH, model: MODEL, approvalPolicy: "never", sandbox: "workspace-write", ephemeral: false });
const threadId = th.result?.thread?.id;
log.note(`thread/start -> ${threadId} (${th.error ? JSON.stringify(th.error) : "ok"})`);

const loaded = async (label: string) => {
    const r = await c.request("thread/loaded/list", {});
    log.note(`thread/loaded/list ${label} -> ${JSON.stringify(r.result ?? r.error)} (contains ours: ${(r.result?.data ?? []).includes(threadId)})`);
};
await loaded("before turn 1");

const runTurn = async (n: number, text: string) => {
    const from = c.p.frames.length;
    const r = await c.turnStart(threadId, text, { effort: "low", model: MODEL });
    const turnId = r.result?.turn?.id;
    log.note(`turn ${n}: turn/start -> turn ${turnId} ${r.error ? JSON.stringify(r.error) : ""}`);
    const done = await c.p.waitFor((f) => f.method === "turn/completed" && f.params?.turn?.id === turnId, 90_000, from);
    log.note(`turn ${n}: turn/completed status=${done?.params?.turn?.status}`);
    return { turnId, done, from };
};

const t1 = await runTurn(1, "Reply with exactly the word: one");
await loaded("after turn 1");
const idleFrom = c.p.frames.length;
await sleep(10_000);
const idle = c.notes(idleFrom);
log.note(`idle 10 s after turn 1: alive=${c.p.alive()} notifications=${JSON.stringify(idle.map((f) => f.method))}`);
const rl = await c.request("account/rateLimits/read", {});
log.note(`account/rateLimits/read -> ${rl.error ? JSON.stringify(rl.error) : "ok (keys: " + Object.keys(rl.result ?? {}).join(",") + ")"}`);
const t2 = await runTurn(2, "Reply with exactly the word: two");
await loaded("after turn 2");
const idle2From = c.p.frames.length;
await sleep(5_000);

const all = c.notes();
const rlu = c.p.frames.map((f, i) => ({ f, i })).filter(({ f }) => f.method === "account/rateLimits/updated");
const turnEnds = c.p.frames.map((f, i) => ({ f, i })).filter(({ f }) => f.method === "turn/completed").map((x) => x.i);
log.note(`account/rateLimits/updated count=${rlu.length}; frame indexes ${JSON.stringify(rlu.map((x) => x.i))}; turn/completed indexes ${JSON.stringify(turnEnds)}; turn1.from=${t1.from} turn2.from=${t2.from}`);
log.note(`rateLimits/updated between turns (after turn 1 completed, before turn 2 started): ${rlu.filter(({ i }) => i > turnEnds[0] && i < t2.from).length}; during the idle after turn 2: ${rlu.filter(({ i }) => i > turnEnds[1]).length}`);
log.note(`same pid for both turns: ${c.p.pid === pid}; methods seen: ${[...new Set(all.map((f) => f.method))].join(", ")}`);
await c.stop();
