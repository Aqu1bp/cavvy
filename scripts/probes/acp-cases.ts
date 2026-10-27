// The ACP probe cases, shared by acp-opencode.ts and acp-grok.ts. Each case writes one fixture
// test/fixtures/protocol/<cli>-<version>-<case>.jsonl. Run one case at a time:
//   bun scripts/probes/acp-grok.ts handshake
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, scrubAlso, sleep } from "./lib";
import { Acp, AcpLog, type AcpOpts, type PermissionRule, STATE_FILE, state, tempWorkspace, trackSession } from "./acp-lib";
const trackSessionFromState = trackSession;

export type Profile = {
    cli: "grok" | "opencode";
    version: string;
    /** Spawn args; the workspace is the process cwd. */
    args: (ws: string) => string[];
    /** Process env for runs a model drives (OpenCode: the "ask" permission config). */
    env?: Record<string, string>;
    /** Run after session/new before prompting: picks the cheapest model/effort. */
    prep: (acp: Acp, sessionId: string) => Promise<any>;
    /** Extra session/new params (e.g. Grok's _meta). */
    newSessionExtra?: Record<string, unknown>;
};

export type Ctx = { profile: Profile; log: AcpLog; ws: string; st: ReturnType<typeof state> };

export function ctx(profile: Profile, name: string, limits: { maxArray?: number; maxString?: number } = { maxString: 1500 }): Ctx {
    const log = new AcpLog(fixture(`${profile.cli}-${profile.version}-${name}`), limits);
    const ws = tempWorkspace(profile.cli);
    return { profile, log, ws, st: state(STATE_FILE(profile.cli)) };
}

export function start(c: Ctx, extra: Partial<AcpOpts> = {}, ws = c.ws) {
    return new Acp(c.log, { cli: c.profile.cli, args: c.profile.args(ws), workspace: ws, env: c.profile.env, ...extra });
}

/** initialize + session/new, then optionally the cheap model. */
export async function open(c: Ctx, acp: Acp, opts: { model?: boolean; newExtra?: Record<string, unknown> } = {}) {
    const t0 = Date.now();
    const init = await acp.initialize();
    c.log.note(`initialize -> ${init.error ? JSON.stringify(init.error) : "ok"} in ${init.ms} ms (since spawn ${Date.now() - t0} ms)`);
    const ns = await acp.newSession({ ...c.profile.newSessionExtra, ...opts.newExtra });
    const sessionId: string = ns.result?.sessionId;
    c.log.note(`session/new -> ${ns.error ? JSON.stringify(ns.error) : "ok"} in ${ns.ms} ms`);
    if (opts.model !== false && sessionId) {
        const r = await c.profile.prep(acp, sessionId);
        c.log.note(`prep (cheap model/effort) -> ${r?.error ? JSON.stringify(r.error) : "ok"}`);
    }
    return { init, ns, sessionId };
}

/** Runs one prompt and writes a summary note of what arrived. */
export async function turn(c: Ctx, acp: Acp, sessionId: string, text: string, label: string, timeoutMs = 180_000, extraBlocks: any[] = []) {
    const from = acp.p.frames.length;
    const r = await acp.prompt(sessionId, text, timeoutMs, extraBlocks);
    // Give trailing notifications (after the result) a moment to arrive, then summarise.
    await sleep(1500);
    const s = acp.summarize(from);
    c.log.note(`${label}: result ${r.timeout ? "TIMEOUT" : JSON.stringify(r.result ?? r.error)} after ${r.ms} ms`, { kinds: s.kinds.join(", "), text: s.text, thoughtChars: s.thoughtChars });
    return { r, from, ...s };
}

export const allow = (label: string, match: PermissionRule["match"], once = true): PermissionRule => ({ label, match, answer: "allow_once", once });
export const reject = (label: string, match: PermissionRule["match"], once = true): PermissionRule => ({ label, match, answer: "reject_once", once });
export const cancelled = (label: string, match: PermissionRule["match"], once = true): PermissionRule => ({ label, match, answer: "cancelled", once });

export const writeTo = (name: string) => (req: { paths: string[]; command?: string }) => req.command === undefined && req.paths.length > 0 && req.paths.every((p) => p.endsWith(`/${name}`));
export const runs = (cmd: string) => (req: { command?: string }) => req.command?.trim() === cmd;
export const seed = (ws: string, name: string, text: string) => writeFileSync(join(ws, name), text);

// ---------- cases ----------

/** 1 + 2 + parts of 10/12: no prompt. initialize, session/new, idle notifications, session/list, unknown session, stdin close. */
export async function handshake(profile: Profile, extraNew: { label: string; params: Record<string, unknown> }[] = []) {
    const c = ctx(profile, "handshake", { maxArray: 8, maxString: 1500 });
    const acp = start(c, { sandbox: true, timeoutSec: 90 });
    const { sessionId } = await open(c, acp, { model: false });
    await sleep(3000);
    const cmds = acp.p.frames.find((f) => f.params?.update?.sessionUpdate === "available_commands_update")?.params.update.availableCommands ?? [];
    c.log.note(`available commands (${cmds.length}): ${cmds.map((x: any) => x.name).join(" ")}`.slice(0, 2000));
    const nsr = acp.p.frames.find((f) => f.id === 2 && f.result)?.result ?? {};
    c.log.note(`session/new ids: ${JSON.stringify({ modes: nsr.modes?.availableModes?.map((m: any) => m.id), currentModeId: nsr.modes?.currentModeId, models: nsr.models?.availableModels?.map((m: any) => m.modelId), currentModelId: nsr.models?.currentModelId, configOptions: nsr.configOptions?.map((o: any) => `${o.id}=${o.currentValue} [${o.options?.map((x: any) => x.value).join("|")}]`) })}`.slice(0, 4000));
    c.log.note(`idle after session/new: ${JSON.stringify(acp.summarize(0).kinds)}`);
    for (const x of extraNew) {
        const r = await acp.newSession(x.params);
        c.log.note(`session/new (${x.label}) -> ${r.error ? JSON.stringify(r.error) : "ok"}`);
    }
    const list = await acp.request("session/list", { cwd: c.ws });
    c.log.note(`session/list -> ${list.error ? JSON.stringify(list.error) : `${list.result?.sessions?.length} sessions`}`);
    const bad = await acp.request("session/prompt", { sessionId: "00000000-0000-4000-8000-000000000000", prompt: [{ type: "text", text: "hi" }] }, 20_000);
    c.log.note(`session/prompt on an unknown session -> ${JSON.stringify(bad.error ?? bad.result ?? "timeout")}`);
    const unknownMethod = await acp.request("session/does_not_exist", { sessionId }, 10_000);
    c.log.note(`unknown method -> ${JSON.stringify(unknownMethod.error ?? unknownMethod.result ?? "timeout")}`);
    const t = Date.now();
    await acp.closeStdin();
    const code = await Promise.race([acp.p.exited, sleep(10_000).then(() => "still running after 10 s")]);
    c.log.note(`stdin closed -> ${code} after ${Date.now() - t} ms`);
    await acp.stop();
}

/** 10: start in a cwd that doesn't exist (process cwd fine, session/new cwd missing; and --cwd missing for OpenCode). */
export async function badCwd(profile: Profile, spawnArgsWithMissingCwd?: string[]) {
    const c = ctx(profile, "bad-cwd");
    const missing = `${c.ws}/does-not-exist`;
    const acp = start(c, { sandbox: true, timeoutSec: 60 });
    await acp.initialize();
    const r = await acp.request("session/new", { cwd: missing, mcpServers: [] }, 20_000);
    c.log.note(`session/new with a missing cwd -> ${JSON.stringify(r.error ?? r.result ?? "timeout")}`);
    const rel = await acp.request("session/new", { cwd: "relative/path", mcpServers: [] }, 20_000);
    c.log.note(`session/new with a relative cwd -> ${JSON.stringify(rel.error ?? (rel.result ? "ok" : "timeout"))}`);
    await acp.stop();
    if (spawnArgsWithMissingCwd) {
        const acp2 = new Acp(c.log, { cli: profile.cli, args: spawnArgsWithMissingCwd.map((a) => a.replace("<missing>", missing)), workspace: c.ws, sandbox: true, timeoutSec: 30 });
        const i = await acp2.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 15_000);
        c.log.note(`spawn with a missing --cwd: initialize -> ${JSON.stringify(i.error ?? (i.result ? "ok" : "timeout"))}; alive=${acp2.alive()}`);
        await acp2.stop();
    }
}

/** 2 + 5 + 8 without a prompt: which mode/model/config calls each CLI takes, their results and the notifications they cause. */
export async function controls(profile: Profile, calls: { label: string; method: string; params: Record<string, unknown> }[]) {
    const c = ctx(profile, "controls", { maxArray: 8, maxString: 600 });
    const acp = start(c, { sandbox: true, timeoutSec: 90 });
    const { sessionId } = await open(c, acp, { model: false });
    await sleep(1500);
    for (const x of calls) {
        const from = acp.p.frames.length;
        const r = await acp.request(x.method, { sessionId, ...x.params }, 15_000);
        await sleep(700);
        const res = r.error ?? r.result;
        const summary = res?.configOptions ? { configOptions: res.configOptions.map((o: any) => `${o.id}=${o.currentValue}`), other: Object.keys(res).filter((k) => k !== "configOptions") } : res;
        c.log.note(`${x.label}: ${x.method} -> ${r.timeout ? "timeout" : JSON.stringify(summary)}`, { after: acp.summarize(from).kinds });
    }
    await acp.stop();
}

const exists = (ws: string, name: string) => existsSync(join(ws, name));

/** Runs prompts in one session with the given permission rules per prompt; notes which files exist after each. */
export async function promptSeries(
    profile: Profile,
    name: string,
    steps: { text: string; rules?: PermissionRule[]; files?: string[]; label: string; safeCommands?: string[]; blocks?: any[] }[],
    opts: { env?: Record<string, string>; newExtra?: Record<string, unknown>; before?: (c: Ctx, acp: Acp, sessionId: string) => Promise<void>; after?: (c: Ctx, acp: Acp) => void; seedFiles?: Record<string, string>; saveAs?: string; args?: string[] } = {},
) {
    const c = ctx(profile, name);
    for (const [f, t] of Object.entries(opts.seedFiles ?? {})) seed(c.ws, f, t);
    const safe = steps.flatMap((s) => s.safeCommands ?? []);
    const acp = new Acp(c.log, { cli: profile.cli, args: opts.args ?? profile.args(c.ws), workspace: c.ws, env: opts.env ?? profile.env, sandbox: true, timeoutSec: 60 + steps.length * 150, safeCommands: safe });
    const { sessionId } = await open(c, acp, { newExtra: opts.newExtra });
    if (opts.saveAs) c.st.set(opts.saveAs, { sessionId, ws: c.ws });
    if (opts.before) await opts.before(c, acp, sessionId);
    for (const s of steps) {
        acp.rules = s.rules ?? [];
        const permsBefore = acp.permissionLog.length;
        await turn(c, acp, sessionId, s.text, s.label, 180_000, s.blocks ?? []);
        const perms = acp.permissionLog.slice(permsBefore).map((p) => ({ answer: p.answer, rule: p.rule, note: p.note, command: p.req.command, paths: p.req.paths, title: p.req.params?.toolCall?.title, options: p.req.params?.options?.map((o: any) => `${o.optionId}:${o.kind}`) }));
        c.log.note(`${s.label}: permission requests ${perms.length}; files ${JSON.stringify(Object.fromEntries((s.files ?? []).map((f) => [f, exists(c.ws, f)])))}`, { perms });
        if (!acp.alive()) break;
    }
    opts.after?.(c, acp);
    await acp.stop();
    return c;
}

/** 6: session/cancel while a `sleep 20` runs (after its permission, if any, was allowed); then a later prompt. */
export async function cancelCase(profile: Profile, opts: { newExtra?: Record<string, unknown> } = {}) {
    const c = ctx(profile, "cancel");
    const acp = new Acp(c.log, { cli: profile.cli, args: profile.args(c.ws), workspace: c.ws, env: profile.env, sandbox: true, timeoutSec: 300, safeCommands: ["sleep 20"] });
    const { sessionId } = await open(c, acp, { newExtra: opts.newExtra });
    acp.rules = [allow("sleep 20", runs("sleep 20"))];
    const from = acp.p.frames.length;
    const t0 = Date.now();
    const id = acp.fire("session/prompt", { sessionId, prompt: [{ type: "text", text: "Run exactly this shell command and nothing else, then say done: sleep 20" }] });
    const started = await acp.p.waitFor((f) => f.method === "session/update" && /tool_call/.test(f.params?.update?.sessionUpdate) && f.params.update.status === "in_progress", 90_000, from);
    c.log.note(`tool in progress: ${Boolean(started)} after ${Date.now() - t0} ms`);
    await sleep(3000);
    const tc = Date.now();
    acp.notify("session/cancel", { sessionId });
    const res = await acp.response(id, 60_000, from);
    c.log.note(`session/prompt answered ${Date.now() - tc} ms after session/cancel: ${JSON.stringify(res?.result ?? res?.error ?? "timeout")}`);
    await sleep(3000);
    const s = acp.summarize(from);
    c.log.note(`cancelled turn`, { kinds: s.kinds, text: s.text, alive: acp.alive() });
    if (acp.alive()) await turn(c, acp, sessionId, "Reply with the single word: after", "prompt after cancel");
    await acp.stop();
}

/** 10: a second session/prompt while the first runs. */
export async function concurrency(profile: Profile) {
    const c = ctx(profile, "concurrent-prompt");
    const acp = new Acp(c.log, { cli: profile.cli, args: profile.args(c.ws), workspace: c.ws, env: profile.env, sandbox: true, timeoutSec: 240 });
    const { sessionId } = await open(c, acp);
    const from = acp.p.frames.length;
    const a = acp.fire("session/prompt", { sessionId, prompt: [{ type: "text", text: "Write the numbers from 1 to 40 separated by spaces. Do not use any tools." }] });
    await acp.p.waitFor((f) => f.params?.update?.sessionUpdate === "agent_message_chunk", 60_000, from);
    const b = acp.fire("session/prompt", { sessionId, prompt: [{ type: "text", text: "Reply with the single word: second" }] });
    const [ra, rb] = await Promise.all([acp.response(a, 120_000, from), acp.response(b, 120_000, from)]);
    await sleep(1500);
    const order = acp.p.frames.slice(from).filter((f) => !f.method && (f.id === a || f.id === b)).map((f) => f.id === a ? "A" : "B");
    c.log.note(`concurrent prompts: A -> ${JSON.stringify(ra?.result ?? ra?.error ?? "timeout")}, B -> ${JSON.stringify(rb?.result ?? rb?.error ?? "timeout")}; response order ${order.join(",")}`, { kinds: acp.summarize(from).kinds, text: acp.summarize(from).text });
    await acp.stop();
}

/** 7: a new process loads (and resumes) an earlier session; does it replay; does it remember. */
export async function resumeCase(profile: Profile, key = "pong") {
    const saved = state(STATE_FILE(profile.cli)).get(key);
    if (!saved) throw new Error(`run the ${key} case first`);
    const c = { ...ctx(profile, "resume"), ws: saved.ws };
    scrubAlso(saved.ws, `/tmp/acp-${profile.cli}`);
    const acp = new Acp(c.log, { cli: profile.cli, args: profile.args(saved.ws), workspace: saved.ws, env: profile.env, sandbox: true, timeoutSec: 240 });
    trackSessionFromState(saved.sessionId);
    await acp.initialize();
    const from = acp.p.frames.length;
    const r = await acp.request("session/load", { sessionId: saved.sessionId, cwd: saved.ws, mcpServers: [] });
    const replay = acp.p.frames.slice(from).filter((f) => f.method === "session/update");
    const respIdx = acp.p.frames.slice(from).findIndex((f) => f.id === r.id && !f.method);
    await sleep(2000);
    const after = acp.p.frames.slice(from + respIdx + 1).filter((f) => f.method === "session/update").length;
    c.log.note(`session/load -> ${r.error ? JSON.stringify(r.error) : "ok"} in ${r.ms} ms; session/update before the response: ${replay.length}; after it (2 s): ${after}`, { kinds: acp.summarize(from).kinds, resultKeys: Object.keys(r.result ?? {}) });
    await profile.prep(acp, saved.sessionId);
    await turn(c, acp, saved.sessionId, "What single word did you reply with in your previous answer in this conversation? Reply with just that word.", "prompt after load");
    await acp.stop();
    // A second process: session/resume (no replay expected) and session/list.
    const acp2 = new Acp(c.log, { cli: profile.cli, args: profile.args(saved.ws), workspace: saved.ws, env: profile.env, sandbox: true, timeoutSec: 60 });
    await acp2.initialize();
    const from2 = acp2.p.frames.length;
    const r2 = await acp2.request("session/resume", { sessionId: saved.sessionId, cwd: saved.ws, mcpServers: [] });
    await sleep(2000);
    c.log.note(`session/resume (new process) -> ${r2.error ? JSON.stringify(r2.error) : "ok"} in ${r2.ms} ms`, { kinds: acp2.summarize(from2).kinds, resultKeys: Object.keys(r2.result ?? {}) });
    const l = await acp2.request("session/list", { cwd: saved.ws });
    c.log.note(`session/list -> ${l.error ? JSON.stringify(l.error) : `${l.result?.sessions?.length} sessions`}`);
    const missing = await acp2.request("session/load", { sessionId: "00000000-0000-4000-8000-0000000000ff", cwd: saved.ws, mcpServers: [] }, 20_000);
    c.log.note(`session/load of an unknown id -> ${JSON.stringify(missing.error ?? missing.result ?? "timeout")}`);
    await acp2.stop();
}

/** A tiny PNG (16x16, solid red) for the image case. */
export const RED_PNG = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
export const IMAGE_STEP = { label: "image prompt", text: "What is the color of the attached image? Reply with one word." };

/** No prompt: session/close, then calls on the closed session; a second session/close. */
export async function closeCase(profile: Profile, probeCall: (sessionId: string) => { method: string; params: Record<string, unknown> }) {
    const c = ctx(profile, "close");
    const acp = start(c, { sandbox: true, timeoutSec: 60 });
    const { sessionId } = await open(c, acp, { model: false });
    await sleep(1000);
    const from = acp.p.frames.length;
    const r = await acp.request("session/close", { sessionId }, 15_000);
    await sleep(700);
    c.log.note(`session/close -> ${JSON.stringify(r.error ?? r.result ?? "timeout")}`, { after: acp.summarize(from).kinds });
    const x = probeCall(sessionId);
    const r2 = await acp.request(x.method, x.params, 15_000);
    c.log.note(`${x.method} on the closed session -> ${JSON.stringify(r2.error ?? r2.result ?? "timeout")}`);
    const r3 = await acp.request("session/close", { sessionId }, 15_000);
    c.log.note(`second session/close -> ${JSON.stringify(r3.error ?? r3.result ?? "timeout")}`);
    const l = await acp.request("session/list", { cwd: c.ws });
    c.log.note(`session/list after close -> ${l.error ? JSON.stringify(l.error) : `${l.result?.sessions?.length} sessions`}`);
    await acp.stop();
}

/** What a steering probe sends mid-turn (OpenCode: a second session/prompt; Grok: _x.ai/interject), and when. */
export type SteerOpts = {
    /** The turn's own prompt. */
    first: string;
    /** The frame after which the steer goes (the first tool call, the first words of the answer). */
    trigger: (f: any) => boolean;
    steer: string;
    /** Sends the steer; returns the request's id when it's a request whose answer to wait for. */
    send: (acp: Acp, sessionId: string, text: string) => Promise<{ id?: number; note: string }>;
    /** session/cancel this long after the steer went. */
    cancelAfterMs?: number;
    /** Watched this long after the first prompt answered (a prompt the agent runs on its own after). */
    watchMs?: number;
    safeCommands?: string[];
};

/** A message sent into a running turn: when each prompt answered, what the agent said before and after, and what ran after. */
export async function steerCase(profile: Profile, name: string, o: SteerOpts) {
    const c = ctx(profile, name);
    const acp = new Acp(c.log, { cli: profile.cli, args: profile.args(c.ws), workspace: c.ws, env: profile.env, sandbox: true, timeoutSec: 300, safeCommands: o.safeCommands ?? [] });
    acp.rules = (o.safeCommands ?? []).map((cmd) => allow(cmd, runs(cmd), false));
    const { sessionId } = await open(c, acp);
    const from = acp.p.frames.length;
    const t0 = Date.now();
    const a = acp.fire("session/prompt", { sessionId, prompt: [{ type: "text", text: o.first }] });
    const hit = await acp.p.waitFor((f) => o.trigger(f), 120_000, from);
    c.log.note(`trigger seen: ${Boolean(hit)} after ${Date.now() - t0} ms`);
    const sent = await o.send(acp, sessionId, o.steer);
    const steerAt = acp.p.frames.length;
    c.log.note(`steer sent after ${Date.now() - t0} ms: ${sent.note}`);
    if (o.cancelAfterMs !== undefined) {
        await sleep(o.cancelAfterMs);
        acp.notify("session/cancel", { sessionId });
        c.log.note(`session/cancel sent after ${Date.now() - t0} ms`);
    }
    const ra = await acp.response(a, 180_000, from);
    const aAt = acp.p.frames.findIndex((f, i) => i >= from && f.id === a && !f.method);
    c.log.note(`first prompt answered after ${Date.now() - t0} ms: ${JSON.stringify(ra?.result ?? ra?.error ?? "timeout")}`);
    const rb = sent.id !== undefined ? await acp.response(sent.id, 120_000, from) : undefined;
    if (sent.id !== undefined) c.log.note(`steer prompt answered after ${Date.now() - t0} ms: ${JSON.stringify(rb?.result ?? rb?.error ?? "timeout")}`);
    await sleep(o.watchMs ?? 5000);
    const before = acp.summarize(from, steerAt);
    const during = acp.summarize(steerAt, aAt < 0 ? acp.p.frames.length : aAt + 1);
    const after = aAt < 0 ? undefined : acp.summarize(aAt + 1);
    const promptIds = [...new Set(acp.p.frames.slice(from).map((f) => f.params?._meta?.promptId).filter(Boolean))];
    const order = acp.p.frames.slice(from).filter((f) => !f.method && (f.id === a || f.id === sent.id)).map((f) => (f.id === a ? "first" : "steer"));
    c.log.note(`${name}: answers in order ${order.join(",")}; update promptIds ${JSON.stringify(promptIds)}`, { beforeSteer: before.text, afterSteerUntilAnswer: { kinds: during.kinds, text: during.text }, afterAnswer: after ? { kinds: after.kinds, text: after.text } : null, alive: acp.alive() });
    await acp.stop();
}
