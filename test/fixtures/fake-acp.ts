// A stand-in ACP agent (as `opencode acp` speaks it: test/fixtures/protocol/opencode-1.19.4-*.jsonl) for
// test/acp.test.ts and test/acp-backend.test.ts. JSON-RPC 2.0, one object a line.
//
// `models` as its first argument: prints model ids, one a line (opencode models).
// FAKE_LOG: where it logs its start ({argv, cwd, env}) and every message it reads ({received}).
// FAKE_ACP_INIT=fail: writes "fatal: can't start" to stderr and exits 2 before answering initialize.
// FAKE_ACP_IMAGES=0: says it takes no images. FAKE_ACP_RESUME=load: no session/resume, only session/load.
// FAKE_ACP_IGNORE_CANCEL=1: session/cancel does nothing (Grok's flavor too).
//
// session/resume or session/load of an id starting "gone" fails (-32602, session not found); session/load first
// replays the session's history as updates. A prompt's text picks what it does by a [[directive]] in it:
//   (none)            thinks, says "Hello there", reports usage (cost from [[cost:N]], cumulative), ends end_turn
//   [[run:CMD]]       a command (kind execute) it asks about first; runs it on allow_once ("ran CMD")
//   [[write:PATH]]    a file write (kind edit) it asks about; on allow_once writes it, then sends fs/write_text_file
//   [[fetch:URL]]     a fetch it asks about. [[other]]: a tool of kind "other" it asks about
//   [[malformed]]     asks about an edit that names no file
//   [[noask:PATH]]    writes PATH without asking (completed), starts `make` and says "Now building", then waits for
//                     session/cancel (the tripwire)
//   [[noask-read]]    reads a file without asking
//   [[fail:KIND]]     a tool it doesn't ask about fails: `execute` a command that ran, `edit` an edit refused before
//                     asking (must read first), `notrun` a command refused unrun; then waits a moment for session/cancel
//   [[slow]]          starts a command and waits for session/cancel: answers cancelled
//   [[crash]]         starts a command, says something, then writes "fatal: boom" to stderr and exits 3
//   [[auth]]          answers -32000 Authentication required. [[disabled]]: -32603 Model access is disabled
//   [[late]]          ends, then sends a message chunk after its answer
//   [[steps:N]]       N reads it doesn't ask about, FAKE_ACP_STEP_MS apart (100), until session/cancel; then its
//                     words, with what steered it: " (also: TEXT / TEXT)"
//   [[stream]]        says "Before the steer.", waits for a prompt folded into it, then goes on in the same message:
//                     " After: TEXT"
// A session/prompt while one runs is folded into it, as OpenCode's are (opencode-1.19.4-steer.jsonl): the running
// one takes its text at its next step, and both are answered together, alike ({folded} logged).
// stdin's end: exits 0.
//
// FAKE_ACP_FLAVOR=grok: speaks as `grok agent --no-leader stdio` does (test/fixtures/protocol/grok-1.0.70-*.jsonl):
// `models` prints `grok models`' text (FAKE_GROK_SIGNED_OUT=1: "You are not authenticated.", and session/new answers
// -32000). Its own _x.ai/* notifications all along; every update carries _meta; no `modes`; set_mode "plan" and
// "default" only; config values as bare strings. A session opened with _meta.autoMode runs writes unasked. A tool's
// first tool_call has no kind or status (those come in _meta and an update); a reject ends the turn cancelled. Its
// answer has no usage: tokens are in its _meta. After its answer: a title and a summary. stdin's end: exits after
// FAKE_GROK_EXIT_MS (logs {exit}).
// A client's PreToolUse hook (grok-1.0.70-hook-*.jsonl): registered by session/new, resume or load's
// _meta["x.ai/hooks"] ({PreToolUse: [{hookCallbackIds: [id], timeout}]}: `timeout` seconds, 30 by default; timeoutS
// ignored), for that open only. Then every tool's bare tool_call is followed by _x.ai/hooks/run (its request ids
// shared with session/request_permission, from 0), and the tool waits for its answer (logged {hookAnswer}): `{}`
// goes on; {decision: "deny", reason} fails it ("Hook denied: REASON", after a hook_annotation) and the turn goes on;
// anything else, or no answer in time ({hookTimeout}), fails open ({hookFailOpen}). Its directives:
//   (none)            thinks, says "Hello there"
//   [[run:CMD]]       a command: asked about, unless it's read-only (ls, sleep, cat) or the session is auto
//   [[write:PATH]]    a write: asked about, unless the session is auto; refused unasked in plan mode, but for a
//                     plan.md
//   [[read:PATH]]     read_file {target_file: PATH}, read-only: never asked about
//   [[noask:PATH]]    writes PATH without asking, as a user's own allow rule lets it (the hook still runs)
//   [[nogate:PATH]]   writes PATH with neither the hook nor an ask
//   [[cut:CMD]]       a command whose input it cut (toolInputTruncated, "CMD... [truncated]"): asked about
//   [[cutwrite:PATH]] a write whose content it cut (toolInputTruncated, "x... [truncated]"): asked about
//   [[changed:JSON]]  {name, hook, ask, cut?} (URI-encoded): tool `name` (kind edit) held at the gate with input `hook` (cut:
//                     toolInputTruncated), then asked about with input `ask`; runs nothing ("done")
//   [[todo]]          todo_write, its own bookkeeping: never asked about
//   [[subagent:PATH]] spawn_subagent, whose subagent (its own session, subagent_spawned first) writes PATH: asked
//                     about, unless the session is auto
//   [[slow]]          `sleep 20`, unasked, until session/cancel: answers cancelled, the tool never ends
//   [[fail:KIND]]     as OpenCode's (a refused one says _meta.toolNotRun)
//   [[image]]         drops an image (image_dropped), then answers
//   [[auth]]          answers -32000 Authentication required
//   [[steps:N]]       as OpenCode's; _x.ai/interject joins it (the next step takes the text), as Grok's
//                     (grok-1.0.70-steer.jsonl); a stop drops one not yet taken (-steer-taken.jsonl). Each step
//                     thinks first; nothing says when one is taken
//   [[requeue]]       answers as soon as an interjection comes, without it; that runs as a prompt of its own
// _x.ai/interject with nothing running runs as a prompt of its own (grok-1.0.70-steer-params.jsonl): its
// queue/changed names it running, it says "Fallback: TEXT", and its turn_completed carries its tokens.
// FAKE_GROK_INTERJECT_MS: an interjection is taken (and answered) that long after it comes.
// With GROK_HOME set, its record of each session (grok-1.0.70-steer-file.jsonl, -steer-marker.jsonl):
// <GROK_HOME>/sessions/<cwd, encoded>/<id>/updates.jsonl, made by session/new: each prompt, each interjection taken
// (user_message_chunk, _meta.interjection), and FAKE_GROK_RECORD_MS after its answer its turn_completed (not with
// FAKE_GROK_NO_MARKER=1). FAKE_GROK_CANCEL_TAKES=1: a stop takes what was queued, written just before that.
// FAKE_GROK_ANSWER_MS: its answer comes that long after (its record doesn't wait). FAKE_GROK_EXIT_AFTER_CANCEL_MS:
// it exits that long after a cancelled answer.
// FAKE_GROK_STEPS_DROP=1: [[steps:N]] never takes one (a stop drops it, though tools ended and it spoke since).
//   [[take-late:MS]]  says "alpha"; one sent as it's said is taken into another model call, no tool between
//                     (grok-1.0.70-steer-file.jsonl), which thinks; then MS (10 s) or session/cancel

import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { isAbsolute, join } from "path";

const log = (o: Record<string, unknown>) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\n");
const out = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");

const GROK = process.env.FAKE_ACP_FLAVOR === "grok";
const SIGNED_OUT = process.env.FAKE_GROK_SIGNED_OUT === "1";
if (process.argv[2] === "models") {
    if (GROK) process.stdout.write(`${SIGNED_OUT ? "You are not authenticated." : "You are logged in with grok.com."}\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n`);
    else process.stdout.write("opencode/big-pickle\nopencode/gpt-5-nano\nanthropic/claude-x\n");
    process.exit(0);
}
log({ argv: process.argv.slice(2), cwd: process.cwd(), env: { OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT, OPENCODE_DISABLE_PROJECT_CONFIG: process.env.OPENCODE_DISABLE_PROJECT_CONFIG } });
if (GROK) process.on("SIGTERM", () => {
    log({ signal: "SIGTERM" });
    process.exit(143);
});
if (process.env.FAKE_ACP_INIT === "fail") {
    process.stderr.write("fatal: can't start\n");
    process.exit(2);
}

let cwd = process.cwd();
let sessions = 0;
let seq = 0;
let cost = 0;
const waiting = new Map<number, (m: any) => void>();
let cancelled: (() => void) | undefined;
/** The prompt running: the ids it answers (its own, and those folded into it) and the texts steering it. */
let running: { ids: number[]; steers: string[] } | undefined;
const stepMs = () => Number(process.env.FAKE_ACP_STEP_MS ?? 100);
const config = { model: "opencode/big-pickle", mode: "build", effort: "low" };
const MODELS = ["opencode/big-pickle", "opencode/gpt-5-nano"];

function configOptions() {
    return [
        { id: "model", name: "Model", category: "model", type: "select", currentValue: config.model, options: MODELS.map((value) => ({ value, name: value })) },
        { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: config.effort, options: ["low", "high"].map((value) => ({ value, name: value })) },
        { id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: config.mode, options: [{ value: "build", name: "build" }, { value: "plan", name: "plan" }] },
    ];
}

const update = (sessionId: string, u: Record<string, unknown>) => out({ method: "session/update", params: { sessionId, update: u } });
/** A request of ours to the client: its answer. */
function ask(method: string, params: unknown): Promise<any> {
    const id = seq++;
    out({ id, method, params });
    return new Promise((resolve) => waiting.set(id, resolve));
}
const OPTIONS = [
    { optionId: "once", kind: "allow_once", name: "Allow once" },
    { optionId: "always", kind: "allow_always", name: "Always allow" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const untilCancel = (ms: number) => new Promise<boolean>((r) => {
    const t = setTimeout(() => r(false), ms);
    cancelled = () => (clearTimeout(t), r(true));
});

async function prompt(id: number, p: any) {
    const sid = p.sessionId;
    const text = (p.prompt ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const m = text.match(/\[\[([\w-]+)(?::([^\]]*))?\]\]/);
    const what = m?.[1];
    const arg = m?.[2] ?? "";
    running = { ids: [id], steers: [] };
    const end = (stopReason = "end_turn") => {
        update(sid, { sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: cost, currency: "USD" } });
        // Every prompt folded into it, answered alike.
        const ids = running?.ids ?? [id];
        running = undefined;
        for (const i of ids) out({ id: i, result: { stopReason, usage: { inputTokens: 100, outputTokens: 7, totalTokens: 1107, cachedReadTokens: 1000 } } });
    };
    const tool = async (callId: string, kind: string, title: string, rawInput: Record<string, unknown>, request: Record<string, unknown>, run: () => string) => {
        update(sid, { sessionUpdate: "tool_call", toolCallId: callId, title, kind, status: "pending", locations: [], rawInput: {} });
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "in_progress", kind, title, rawInput });
        const answer = await ask("session/request_permission", { sessionId: sid, toolCall: { toolCallId: callId, status: "pending", ...request }, options: OPTIONS });
        log({ permissionAnswer: answer.result ?? answer.error });
        const chosen = answer.result?.outcome?.optionId;
        if (chosen === "once" || chosen === "always") {
            const said = run();
            update(sid, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed", content: [{ type: "content", content: { type: "text", text: said } }] });
        } else update(sid, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "failed", content: [{ type: "content", content: { type: "text", text: "The user rejected permission to use this specific tool call." } }] });
    };
    const path = (x: string) => (isAbsolute(x) ? x : join(cwd, x));
    switch (what) {
        case "cost":
            cost += Number(arg);
            break;
        case "run":
            await tool("call_run", "execute", "bash", { command: arg, cwd }, { kind: "execute", title: arg, locations: [], rawInput: { command: arg } }, () => `ran ${arg}`);
            break;
        case "write": {
            const file = path(arg);
            await tool("call_write", "edit", "write", { filePath: file, content: "x" }, { kind: "edit", title: file, locations: [{ path: file }], rawInput: { filepath: file, diff: "+x" }, content: [{ type: "diff", path: file, oldText: "", newText: "x" }] }, () => {
                writeFileSync(file, "x");
                return "Wrote file successfully.";
            });
            const answer = await ask("fs/write_text_file", { sessionId: sid, path: file, content: "x" });
            log({ fsWrite: answer.result ?? answer.error });
            break;
        }
        case "fetch":
            await tool("call_fetch", "fetch", "webfetch", { url: arg }, { kind: "fetch", title: arg, rawInput: { url: arg } }, () => "fetched");
            break;
        case "other":
            await tool("call_other", "other", "task", { prompt: "x" }, { kind: "other", title: "task", rawInput: { prompt: "x" } }, () => "done");
            break;
        case "malformed":
            await tool("call_bad", "edit", "write", {}, { kind: "edit", title: "write", rawInput: {} }, () => "wrote");
            break;
        case "noask": {
            const file = path(arg);
            update(sid, { sessionUpdate: "tool_call", toolCallId: "call_noask", title: "write", kind: "edit", status: "pending", locations: [], rawInput: {} });
            update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_noask", status: "in_progress", kind: "edit", title: "write", locations: [{ path: file }], rawInput: { filePath: file, content: "x" } });
            writeFileSync(file, "x");
            update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_noask", status: "completed", title: file, content: [{ type: "content", content: { type: "text", text: "Wrote file successfully." } }] });
            // Goes on meanwhile: a command it never ends, and words not ended by a tool or the turn's end.
            update(sid, { sessionUpdate: "tool_call", toolCallId: "call_next", title: "bash", kind: "execute", status: "in_progress", rawInput: { command: "make" } });
            update(sid, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Now building" } });
            if (await untilCancel(3000)) return end("cancelled");
            update(sid, { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Done." } });
            return end();
        }
        case "noask-read":
            update(sid, { sessionUpdate: "tool_call", toolCallId: "call_read", title: "read", kind: "read", status: "pending", locations: [], rawInput: {} });
            update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_read", status: "in_progress", kind: "read", title: "read", locations: [{ path: path("README.txt") }], rawInput: { filePath: path("README.txt") } });
            update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_read", status: "completed", title: "README.txt", content: [{ type: "content", content: { type: "text", text: "secret word" } }] });
            break;
        case "slow":
            update(sid, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Working" } });
            update(sid, { sessionUpdate: "tool_call", toolCallId: "call_slow", title: "bash", kind: "execute", status: "in_progress", rawInput: { command: "sleep 20" } });
            if (await untilCancel(10_000)) return end("cancelled");
            break;
        case "fail": {
            const run = arg !== "edit";
            update(sid, { sessionUpdate: "tool_call", toolCallId: "call_fail", title: run ? "bash" : "edit", kind: run ? "execute" : "edit", status: "pending", locations: [], rawInput: {} });
            update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_fail", status: "in_progress", kind: run ? "execute" : "edit", title: run ? "bash" : "edit", rawInput: run ? { command: "make deploy" } : { filePath: path("a.txt"), oldString: "a", newString: "b" } });
            const said = arg === "execute" ? "make: *** [deploy] Error 2" : arg === "edit" ? "You must read file a.txt before overwriting it. Use the Read tool first" : "The user rejected permission to use this specific tool call.";
            update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_fail", status: "failed", content: [{ type: "content", content: { type: "text", text: said } }], rawOutput: { error: said } });
            if (await untilCancel(500)) return end("cancelled");
            break;
        }
        case "crash":
            update(sid, { sessionUpdate: "tool_call", toolCallId: "call_crash", title: "bash", kind: "execute", status: "in_progress", rawInput: { command: "make" } });
            update(sid, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "about to" } });
            await sleep(20);
            process.stderr.write("fatal: boom\n");
            process.exit(3);
        case "auth":
            running = undefined;
            return out({ id, error: { code: -32000, message: "Authentication required" } });
        case "disabled":
            running = undefined;
            return out({ id, error: { code: -32603, message: "Model access is disabled" } });
        case "steps":
            for (let i = 0; i < Number(arg); i++) {
                const callId = `call_step${i}`;
                update(sid, { sessionUpdate: "tool_call", toolCallId: callId, title: "read", kind: "read", status: "pending", locations: [], rawInput: {} });
                update(sid, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "in_progress", kind: "read", title: "read", locations: [{ path: path(`f${i}.txt`) }], rawInput: { filePath: path(`f${i}.txt`) } });
                if (await untilCancel(stepMs())) return end("cancelled");
                update(sid, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed", title: `f${i}.txt`, content: [{ type: "content", content: { type: "text", text: "ok" } }] });
            }
            update(sid, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Done" } });
            if (running?.steers.length) update(sid, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: ` (also: ${running.steers.join(" / ")})` } });
            return end();
    }
    if (what === "stream") {
        update(sid, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Before the steer." } });
        for (let i = 0; i < 300 && !running?.steers.length; i++) await sleep(10);
        update(sid, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: ` After: ${running?.steers.join(" / ")}` } });
        return end();
    }
    update(sid, { sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { type: "text", text: "thinking" } });
    update(sid, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Hello" } });
    update(sid, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: " there" } });
    end();
    if (what === "late") update(sid, { sessionUpdate: "agent_message_chunk", messageId: "m9", content: { type: "text", text: "late words" } });
}

function handle(msg: any) {
    log({ received: msg });
    if (msg.method === undefined) {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        return w?.(msg);
    }
    const { id, method, params: p } = msg;
    switch (method) {
        case "initialize":
            return out({
                id,
                result: {
                    protocolVersion: 1,
                    agentCapabilities: {
                        loadSession: true,
                        promptCapabilities: { image: process.env.FAKE_ACP_IMAGES !== "0", embeddedContext: true },
                        sessionCapabilities: process.env.FAKE_ACP_RESUME === "load" ? { close: {} } : { close: {}, resume: {} },
                    },
                    agentInfo: { name: "OpenCode", version: "0.0.0-fake" },
                },
            });
        case "session/new":
            cwd = p.cwd;
            return out({ id, result: { sessionId: `ses_fake${++sessions}_${process.pid}`, configOptions: configOptions() } });
        case "session/resume":
        case "session/load":
            if (String(p.sessionId).startsWith("gone")) return out({ id, error: { code: -32602, message: `Invalid params: session not found: ${p.sessionId}` } });
            cwd = p.cwd;
            if (method === "session/load") {
                update(p.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier prompt" } });
                update(p.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "old", content: { type: "text", text: "earlier answer" } });
            }
            return out({ id, result: { configOptions: configOptions() } });
        case "session/set_config_option":
            if (p.configId === "model" && !MODELS.includes(p.value)) return out({ id, error: { code: -32602, message: `Invalid params: model not found: ${p.value}` } });
            if (!(p.configId in config)) return out({ id, error: { code: -32602, message: `Invalid params: unknown config option: ${p.configId}` } });
            (config as Record<string, string>)[p.configId] = p.value;
            return out({ id, result: { configOptions: configOptions() } });
        case "session/set_model":
            config.model = p.modelId;
            return out({ id, result: {} });
        case "session/prompt":
            if (running) {
                running.ids.push(id);
                running.steers.push((p.prompt ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"));
                return log({ folded: id, images: (p.prompt ?? []).filter((b: any) => b.type === "image").length });
            }
            return void prompt(id, p);
        case "session/cancel":
            if (process.env.FAKE_ACP_IGNORE_CANCEL === "1") return;
            cancelled?.();
            cancelled = undefined;
            return;
        default:
            if (id !== undefined) out({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
}


// ---------- Grok ----------

const grok = { model: "grok-4.7", effort: "high" };
/** Per session: opened with _meta.autoMode, its mode (set_mode), and the hook it was opened with. Plan lasts across resume, auto and the hook don't. */
const grokSessions = new Map<string, { auto: boolean; mode: string; hook?: { id: string; timeoutS: number } }>();
/** The PreToolUse hook an open registers (_meta["x.ai/hooks"]). */
function grokHook(meta: any): { id: string; timeoutS: number } | undefined {
    const g = meta?.["x.ai/hooks"]?.PreToolUse?.[0];
    const id = g?.hookCallbackIds?.[0];
    if (typeof id !== "string") return undefined;
    return { id, timeoutS: typeof g.timeout === "number" ? g.timeout : 30 };
}
/** A request of ours that may go unanswered: undefined after `ms` (a late answer is dropped). */
function askFor(method: string, params: unknown, ms: number): Promise<any> {
    const id = seq++;
    out({ id, method, params });
    return new Promise((resolve) => {
        const t = setTimeout(() => {
            waiting.delete(id);
            resolve(undefined);
        }, ms);
        waiting.set(id, (m) => {
            clearTimeout(t);
            resolve(m);
        });
    });
}
const GROK_MODELS = ["grok-4.7", "grok-4.6"];
let grokEvent = 0;
/** The prompt under way: its updates and its answer carry its id (_meta.promptId), as Grok's do. */
let promptId = "";
/** The prompt running: interjections not yet taken, those taken, and who waits for the next. */
let grokRunning: { sid: string; pending: string[]; taken: string[]; arrived?: () => void } | undefined;

/** An interjection with nothing running: a prompt of its own, which no session/prompt answers. */
async function grokFallback(sid: string, text: string) {
    const id = `interject-fallback-${++grokEvent}`;
    xai("queue/changed", { sessionId: sid, entries: [], runningPromptId: id, runningText: text, runningKind: "prompt" });
    const was = promptId;
    promptId = id;
    gUpdate(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Fallback: ${text}` } });
    promptId = was;
    await sleep(20);
    xai("queue/changed", { sessionId: sid, entries: [] });
    xai("session_notification", { sessionId: sid, update: { sessionUpdate: "turn_completed", prompt_id: id, stop_reason: "end_turn", usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55, cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, modelCalls: 1 } } });
    xai("session/prompt_complete", { sessionId: sid, promptId: id, stopReason: "end_turn", agentResult: null });
}

function grokConfig() {
    return [
        { id: "model", name: "Model", category: "model", type: "select", currentValue: grok.model, options: GROK_MODELS.map((value) => ({ value, name: value })) },
        { id: "reasoning_effort", name: "Reasoning Effort", category: "thought_level", type: "select", currentValue: grok.effort, options: ["xhigh", "high", "medium", "low"].map((value) => ({ value, name: value })) },
    ];
}
const grokModels = () => ({ currentModelId: grok.model, availableModels: GROK_MODELS.map((modelId) => ({ modelId, name: modelId, _meta: { totalContextTokens: 256000, supportsReasoningEffort: true } })) });
/** Its own notifications: for its UI, never needed by a client. */
const xai = (method: string, params: Record<string, unknown>) => out({ method: `_x.ai/${method}`, params });
const gUpdate = (sessionId: string, u: Record<string, unknown>) => out({ method: "session/update", params: { sessionId, update: u, _meta: { eventId: `${sessionId}-${++grokEvent}`, totalTokens: 1300, ...(promptId ? { promptId } : {}) } } });
/** Its record of a session (GROK_HOME set), as Grok's updates.jsonl. */
const recordDir = (sid: string) => join(process.env.GROK_HOME!, "sessions", encodeURIComponent(cwd), sid);
function record(sid: string, update: Record<string, unknown>, method = "session/update") {
    if (!process.env.GROK_HOME) return;
    mkdirSync(recordDir(sid), { recursive: true });
    appendFileSync(join(recordDir(sid), "updates.jsonl"), JSON.stringify({ timestamp: 1, method, params: { sessionId: sid, update, _meta: { eventId: `${sid}-${++grokEvent}` } } }) + "\n");
}
const recordTaken = (sid: string, text: string) =>
    record(sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text: `The user sent a message while you were working:\n<user_query>\n${text}\n</user_query>\n`, _meta: { displayText: text } }, _meta: { modelId: grok.model, interjection: true } });
const GROK_EDIT_OPTIONS = [
    { optionId: "allow-edits-session", name: "Yes, allow all edits during this session", kind: "allow_always" },
    { optionId: "allow-once", name: "Yes", kind: "allow_once" },
    { optionId: "reject-once", name: "No, and tell Grok what to do differently", kind: "reject_once" },
];
const GROK_BASH_OPTIONS = [
    { optionId: "always-allow", name: "Yes, and don't ask again for bash commands", kind: "allow_always" },
    { optionId: "allow-once", name: "Yes, proceed", kind: "allow_once" },
    { optionId: "reject-once", name: "No, and tell Grok what to do differently", kind: "reject_once" },
    { optionId: "reject-always", name: "No, and don't ask again", kind: "reject_always" },
];

async function grokPrompt(id: number, p: any) {
    const sid = p.sessionId;
    const s = grokSessions.get(sid);
    if (!s) return out({ id, error: { code: -32602, message: "Invalid params", data: "unknown session id" } });
    const text = (p.prompt ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const m = text.match(/\[\[([\w-]+)(?::([^\]]*))?\]\]/);
    const what = m?.[1];
    const arg = m?.[2] ?? "";
    promptId = `prompt-${++grokEvent}`;
    grokRunning = { sid, pending: [], taken: [] };
    record(sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text }, _meta: { modelId: grok.model, promptIndex: 0 } });
    xai("queue/changed", { sessionId: sid, queue: [] });
    gUpdate(sid, { sessionUpdate: "config_option_update", configOptions: grokConfig() });
    const end = (stopReason = "end_turn", extra: Record<string, unknown> = {}) => {
        // A stop drops what it hadn't taken.
        const late = stopReason === "cancelled" && process.env.FAKE_GROK_CANCEL_TAKES === "1" ? (grokRunning?.pending.splice(0) ?? []) : [];
        grokRunning = undefined;
        // Its record, a moment after its answer: what it took last, then the prompt's end.
        const ended = promptId;
        setTimeout(() => {
            for (const t of late) recordTaken(sid, t);
            if (process.env.FAKE_GROK_NO_MARKER !== "1") record(sid, { sessionUpdate: "turn_completed", prompt_id: ended, stop_reason: stopReason }, "_x.ai/session/update");
        }, Number(process.env.FAKE_GROK_RECORD_MS ?? 0));
        const answer = () => {
            out({ id, result: { stopReason, _meta: { sessionId: sid, promptId: ended, totalTokens: 1300, modelId: grok.model, inputTokens: 1200, outputTokens: 7, cachedReadTokens: 1000, reasoningTokens: 3, usage: { inputTokens: 2400, outputTokens: 14, cachedReadTokens: 2000, cacheCreationTokens: 0, reasoningTokens: 6, modelCalls: 2, costUsdTicks: 1234 }, ...extra } } });
            // After its answer: a title, a summary, its commands again, and its own notice that the prompt is done.
            gUpdate(sid, { sessionUpdate: "session_info_update", title: "A title" });
            gUpdate(sid, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "x" }] });
            gUpdate(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late words" } });
            xai("session/prompt_complete", { sessionId: sid, stopReason });
            xai("session_notification", { sessionId: sid, update: { sessionUpdate: "session_summary_generated", summary: "x" } });
        };
        if (process.env.FAKE_GROK_ANSWER_MS) setTimeout(answer, Number(process.env.FAKE_GROK_ANSWER_MS));
        else answer();
        if (stopReason === "cancelled" && process.env.FAKE_GROK_EXIT_AFTER_CANCEL_MS) setTimeout(() => process.exit(0), Number(process.env.FAKE_GROK_EXIT_AFTER_CANCEL_MS));
    };
    /**
     * A tool as Grok sends it: a bare tool_call; held by the hook (when one's registered, unless `nogate`); its kind;
     * asked about (unless `unasked`); run or refused. `at`: a subagent's session (its updates, hook and asks), of `type`.
     */
    const tool = async (callId: string, name: string, kind: string, title: string, rawInput: Record<string, unknown>, o: { unasked?: boolean; nogate?: boolean; readOnly?: boolean; cut?: boolean; hookInput?: Record<string, unknown>; refuse?: string; run: () => string | Promise<string>; options: unknown[]; at?: { sid: string; type: string } }) => {
        const here = o.at?.sid ?? sid;
        xai("session_notification", { sessionId: here, update: { sessionUpdate: "tool_call_delta_chunk", tool_call_id: callId, name } });
        const { variant: _, ...first } = rawInput;
        const meta = { "x.ai/tool": { version: 1, name, kind: kind === "edit" ? "write" : kind, read_only: Boolean(o.readOnly) } };
        gUpdate(here, { sessionUpdate: "tool_call", toolCallId: callId, title: name, rawInput: first, _meta: meta });
        if (s.hook && !o.nogate) {
            const params = { hookCallbackId: s.hook.id, hookEventName: "pre_tool_use", sessionId: here, cwd, workspaceRoot: cwd, permissionMode: s.auto ? "auto" : s.mode, toolName: name, toolUseId: callId, toolInput: o.hookInput ?? first, toolInputTruncated: Boolean(o.cut), ...(o.at ? { subagentType: o.at.type } : {}) };
            const answer = await askFor("_x.ai/hooks/run", params, s.hook.timeoutS * 1000);
            if (!answer) log({ hookTimeout: callId });
            else log({ hookAnswer: answer.result ?? answer.error });
            const r = answer?.result;
            if (r && r.decision === "deny" && typeof r.reason === "string") {
                xai("session_notification", { sessionId: here, update: { sessionUpdate: "hook_annotation", kind: "tool_outcome" } });
                gUpdate(here, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "failed", content: [{ type: "content", content: { type: "text", text: `Hook denied: ${r.reason}` } }] });
                return true;
            }
            if (!r || typeof r !== "object" || Object.keys(r).length) log({ hookFailOpen: callId });
        }
        gUpdate(here, { sessionUpdate: "tool_call_update", toolCallId: callId, kind, title, rawInput, _meta: meta });
        if (o.refuse) {
            gUpdate(here, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "failed", content: [{ type: "content", content: { type: "text", text: o.refuse } }] });
            return true;
        }
        if (!o.unasked) {
            xai("session_notification", { sessionId: here, update: { sessionUpdate: "pending_interaction", tool_call_id: callId, kind: "permission" } });
            const answer = await ask("session/request_permission", { sessionId: here, toolCall: { toolCallId: callId, kind, title, rawInput, _meta: { "x.ai/tool": { name, kind, read_only: false }, "x.ai/requestingSessionId": here } }, options: o.options });
            log({ permissionAnswer: answer.result ?? answer.error });
            if (answer.result?.outcome?.optionId !== "allow-once") {
                gUpdate(here, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "failed", content: [{ type: "content", content: { type: "text", text: `User rejected the execution for tool \`${name}\`` } }], _meta: { toolNotRun: "rejected" } });
                end("cancelled", { cancellationCategory: "PermissionRejected" });
                return false;
            }
        }
        gUpdate(here, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "in_progress", content: [{ type: "content", content: { type: "text", text: "" } }] });
        const said = await o.run();
        gUpdate(here, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed", content: [{ type: "content", content: { type: "text", text: said } }] });
        return true;
    };
    const path = (x: string) => (isAbsolute(x) ? x : join(cwd, x));
    const write = (file: string) => () => {
        writeFileSync(file, "x");
        return `The file ${file} has been created.`;
    };
    switch (what) {
        case "run": {
            const readOnly = /^(ls|cat|sleep)\b/.test(arg);
            if (!(await tool("call-run", "run_terminal_command", "execute", `Execute \`${arg}\``, { variant: "Bash", command: arg, description: "x", is_background: false }, { unasked: readOnly || s.auto, run: () => `ran ${arg}`, options: GROK_BASH_OPTIONS }))) return;
            break;
        }
        case "write": {
            const file = path(arg);
            const refuse = s.mode === "plan" && !file.endsWith("/plan.md") ? "Plan mode only allows edits to the plan file." : undefined;
            if (!(await tool("call-write", "write", "edit", `Write \`${file}\``, { variant: "Write", file_path: file, content: "x" }, { unasked: s.auto, refuse, run: write(file), options: GROK_EDIT_OPTIONS }))) return;
            break;
        }
        case "noask":
        case "nogate": {
            const file = path(arg);
            await tool(`call-${what}`, "write", "edit", `Write \`${file}\``, { variant: "Write", file_path: file, content: "x" }, { unasked: true, nogate: what === "nogate", run: write(file), options: GROK_EDIT_OPTIONS });
            break;
        }
        case "read":
            await tool("call-read", "read_file", "read", `Read \`${arg}\``, { variant: "ReadFile", target_file: arg }, { unasked: true, readOnly: true, run: () => "contents", options: [] });
            break;
        case "cut": {
            const command = `${arg}... [truncated]`;
            if (!(await tool("call-cut", "run_terminal_command", "execute", `Execute \`${command}\``, { variant: "Bash", command }, { unasked: s.auto, cut: true, run: () => "ran it", options: GROK_BASH_OPTIONS }))) return;
            break;
        }
        case "cutwrite": {
            const file = path(arg);
            if (!(await tool("call-cutwrite", "write", "edit", `Write \`${file}\``, { variant: "Write", file_path: file, content: "x... [truncated]" }, { unasked: s.auto, cut: true, run: write(file), options: GROK_EDIT_OPTIONS }))) return;
            break;
        }
        case "changed": {
            const c = JSON.parse(decodeURIComponent(arg));
            if (!(await tool("call-changed", c.name, "edit", c.name, c.ask, { hookInput: c.hook, cut: c.cut, unasked: s.auto, run: () => "done", options: GROK_EDIT_OPTIONS }))) return;
            break;
        }
        case "todo":
            await tool("call-todo", "todo_write", "other", "Update to-dos", { todos: [{ content: "x", status: "pending" }] }, { unasked: true, run: () => "Updated", options: [] });
            break;
        case "subagent": {
            const file = path(arg);
            const child = `child-${++grokEvent}-${process.pid}`;
            const run = async () => {
                xai("session_notification", { sessionId: sid, update: { sessionUpdate: "subagent_spawned", parent_session_id: sid, child_session_id: child, subagent_type: "general-purpose", description: "Write a note" } });
                let wrote = false;
                await tool("call-child-write", "write", "edit", `Write \`${file}\``, { variant: "Write", file_path: file, content: "x" }, { unasked: s.auto, at: { sid: child, type: "general-purpose" }, run: () => ((wrote = true), write(file)()), options: GROK_EDIT_OPTIONS });
                return wrote ? "The subagent wrote it." : "The subagent couldn't write it.";
            };
            await tool("call-spawn", "spawn_subagent", "other", "Write a note", { prompt: `Write ${arg}`, description: "Write a note", background: false }, { unasked: true, run, options: [] });
            break;
        }
        case "slow":
            gUpdate(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working" } });
            gUpdate(sid, { sessionUpdate: "tool_call", toolCallId: "call-slow", title: "run_terminal_command", rawInput: { command: "sleep 20" }, _meta: { "x.ai/tool": { name: "run_terminal_command", kind: "execute", read_only: false } } });
            gUpdate(sid, { sessionUpdate: "tool_call_update", toolCallId: "call-slow", kind: "execute", title: "Execute `sleep 20`", rawInput: { variant: "Bash", command: "sleep 20" } });
            gUpdate(sid, { sessionUpdate: "tool_call_update", toolCallId: "call-slow", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "" } }] });
            // Cancelled, it answers at once, and says nothing more of the command.
            if (await untilCancel(10_000)) return end("cancelled");
            break;
        case "fail": {
            const run = arg !== "edit";
            const callId = "call-fail";
            gUpdate(sid, { sessionUpdate: "tool_call", toolCallId: callId, title: run ? "run_terminal_command" : "edit", rawInput: {}, _meta: { "x.ai/tool": { name: run ? "run_terminal_command" : "edit", kind: run ? "execute" : "write", read_only: false } } });
            gUpdate(sid, { sessionUpdate: "tool_call_update", toolCallId: callId, kind: run ? "execute" : "edit", title: run ? "Execute `make deploy`" : "Edit `a.txt`", rawInput: run ? { variant: "Bash", command: "make deploy" } : { variant: "Edit", file_path: path("a.txt"), old_string: "a", new_string: "b" } });
            const said = arg === "execute" ? "make: *** [deploy] Error 2" : arg === "edit" ? "File has not been read yet." : "Refused";
            gUpdate(sid, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "failed", content: [{ type: "content", content: { type: "text", text: said } }], ...(arg === "notrun" ? { _meta: { toolNotRun: "rejected" } } : {}) });
            break;
        }
        case "image":
            xai("session_notification", { sessionId: sid, update: { sessionUpdate: "image_dropped", notes: ["Image 1 was dropped before send: too small (16×16 = 256 px); images must have at least 512 total pixels."] } });
            break;
        case "auth":
            grokRunning = undefined;
            return out({ id, error: { code: -32000, message: "Authentication required" } });
        case "steps": {
            const take = () => {
                if (!grokRunning || process.env.FAKE_GROK_STEPS_DROP === "1") return;
                for (const t of grokRunning.pending) recordTaken(sid, t);
                grokRunning.taken.push(...grokRunning.pending.splice(0));
            };
            for (let i = 0; i < Number(arg); i++) {
                const callId = `call-step-${i}`;
                // Each step is a model call, which thinks first (and has taken what was queued before it began).
                gUpdate(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `step ${i}` } });
                gUpdate(sid, { sessionUpdate: "tool_call", toolCallId: callId, title: "read_file", rawInput: { path: path(`f${i}.txt`) }, _meta: { "x.ai/tool": { name: "read_file", kind: "read", read_only: true } } });
                gUpdate(sid, { sessionUpdate: "tool_call_update", toolCallId: callId, kind: "read", title: `Read f${i}.txt`, status: "in_progress", rawInput: { path: path(`f${i}.txt`) } });
                if (await untilCancel(stepMs())) return end("cancelled");
                gUpdate(sid, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] });
                take();
            }
            take();
            gUpdate(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } });
            if (grokRunning?.taken.length) gUpdate(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ` (also: ${grokRunning.taken.join(" / ")})` } });
            return end();
        }
        case "take-late": {
            const r = grokRunning!;
            gUpdate(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "alpha" } });
            if (!r.pending.length) await new Promise<void>((resolve) => ((r.arrived = resolve), setTimeout(resolve, 3000)));
            for (const t of r.pending) recordTaken(sid, t);
            r.taken.push(...r.pending.splice(0));
            xai("session_notification", { sessionId: sid, update: { sessionUpdate: "response_completed" } });
            gUpdate(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "and then" } });
            if (await untilCancel(Number(arg || 10_000))) return end("cancelled");
            break;
        }
        case "requeue": {
            const r = grokRunning!;
            if (!r.pending.length) await new Promise<void>((resolve) => ((r.arrived = resolve), setTimeout(resolve, 3000)));
            const late = r.pending.splice(0);
            gUpdate(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } });
            end();
            await sleep(30);
            for (const text of late) await grokFallback(sid, text);
            return;
        }
    }
    gUpdate(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    gUpdate(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } });
    gUpdate(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " there" } });
    end();
}

function grokHandle(msg: any) {
    log({ received: msg });
    if (msg.method === undefined) {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        return w?.(msg);
    }
    const { id, method, params: p } = msg;
    switch (method) {
        case "initialize":
            return out({
                id,
                result: {
                    protocolVersion: 1,
                    agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { list: {}, resume: {}, close: {} } },
                    authMethods: SIGNED_OUT ? [{ id: "grok.com", name: "Grok" }] : [{ id: "cached_token", name: "Cached" }, { id: "grok.com", name: "Grok" }],
                    agentInfo: { name: "grok", title: "Grok Build", version: "0.0.0-fake" },
                },
            });
        case "session/new": {
            if (SIGNED_OUT) return out({ id, error: { code: -32000, message: "Authentication required", data: "no auth method id provided" } });
            if (!isAbsolute(p.cwd)) return out({ id, error: { code: -32602, message: "Invalid params", data: `Path is not absolute: ${p.cwd}` } });
            cwd = p.cwd;
            const sid = `0000000${++sessions}-fake-${process.pid}`;
            if (process.env.GROK_HOME) mkdirSync(recordDir(sid), { recursive: true });
            grokSessions.set(sid, { auto: p._meta?.autoMode === true, mode: "default", hook: grokHook(p._meta) });
            out({ id, result: { sessionId: sid, models: grokModels(), configOptions: grokConfig(), _meta: { currentWorkingDirectory: cwd } } });
            xai("sessions/changed", { upserted: [{ sessionId: sid, yolo: false, activity: "idle" }], removed: [] });
            return gUpdate(sid, { sessionUpdate: "available_commands_update", availableCommands: [] });
        }
        case "session/resume":
        case "session/load": {
            if (String(p.sessionId).startsWith("gone")) return out({ id, error: { code: -32603, message: "Internal error", data: { code: "FS_NOT_FOUND", message: "Path not found." } } });
            cwd = p.cwd;
            // Its mode was kept with the session; auto only as this open says.
            const was = grokSessions.get(p.sessionId);
            grokSessions.set(p.sessionId, { auto: p._meta?.autoMode === true, mode: was?.mode ?? (process.env.FAKE_GROK_RESUMED_MODE ?? "default"), hook: grokHook(p._meta) });
            if (method === "session/load") gUpdate(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier answer" }, _meta: { isReplay: true } });
            return out({ id, result: { models: grokModels(), configOptions: grokConfig(), _meta: {} } });
        }
        case "session/set_mode": {
            const s = grokSessions.get(p.sessionId);
            if (s && (p.modeId === "plan" || p.modeId === "default")) {
                s.mode = p.modeId;
                out({ id, result: {} });
                return gUpdate(p.sessionId, { sessionUpdate: "current_mode_update", currentModeId: p.modeId });
            }
            return out({ id, result: {} });
        }
        case "session/set_config_option":
            if (typeof p.value !== "string") return out({ id, error: { code: -32602, message: "Invalid params", data: "data did not match any variant of untagged enum SessionConfigOptionValue" } });
            if (p.configId === "model" && !GROK_MODELS.includes(p.value)) return out({ id, error: { code: -32602, message: "Invalid params", data: "unknown model id" } });
            if (p.configId === "model") grok.model = p.value;
            else if (p.configId === "reasoning_effort") grok.effort = p.value;
            else return out({ id, error: { code: -32602, message: "Invalid params", data: `unknown config option: ${p.configId}` } });
            out({ id, result: { configOptions: grokConfig() } });
            return gUpdate(p.sessionId, { sessionUpdate: "config_option_update", configOptions: grokConfig() });
        case "session/prompt":
            return void grokPrompt(id, p);
        case "_x.ai/interject": {
            if (typeof p?.text !== "string") return out({ id, error: { code: -32602, message: "Invalid params", data: "invalid params: missing field `text`" } });
            const take = () => {
                out({ id, result: { status: "queued" } });
                xai("session/interjection", { sessionId: p.sessionId, text: p.text });
                // Taken late, it starts a moment after its answer.
                if (!grokRunning) return void (later ? setTimeout(() => grokFallback(p.sessionId, p.text), 50) : grokFallback(p.sessionId, p.text));
                grokRunning.pending.push(p.text);
                grokRunning.arrived?.();
            };
            const later = Number(process.env.FAKE_GROK_INTERJECT_MS ?? 0);
            return void (later ? setTimeout(take, later) : take());
        }
        case "session/cancel":
            if (process.env.FAKE_ACP_IGNORE_CANCEL === "1") return;
            cancelled?.();
            cancelled = undefined;
            return;
        default:
            if (id !== undefined) out({ id, error: { code: -32601, message: "Method not found" } });
    }
}

let buf = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) (GROK ? grokHandle : handle)(JSON.parse(line));
    }
}
if (GROK) {
    // Grok takes about 3 s to exit once its stdin closes.
    await sleep(Number(process.env.FAKE_GROK_EXIT_MS ?? 0));
    log({ exit: "stdin" });
}
process.exit(0);
