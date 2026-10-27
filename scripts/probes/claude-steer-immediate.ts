// When does Claude Code take a message written to its stdin while a turn runs, sent the moment the user sends it
// (as Cavvy steers now), plain or with "priority":"now"? Five cases (a turn each, and one message written to it; d writes two):
//   a  plain, while a foreground `sleep 5` runs
//   b  "now", while the model streams text (no tool running)
//   c  "now", while a foreground `sleep 5` runs
//   d  plain, while a foreground `sleep 5` runs, then cancel_async_message for it, then an interrupt
//   f  "now", the moment a tool's result is in (the model's next request under way, no text yet)
// Run in a scratch folder of its own with --permission-mode default: every permission request is denied except the
// exact harmless command the case asks for.
//   bun scripts/probes/claude-steer-immediate.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonProc, Log, fixture, sleep } from "./lib";
import { STREAM_ARGS } from "./claude-lib";

class QuietLog extends Log {
    private deltas = 0;
    add(dir: "in" | "out" | "err" | "note", frame: unknown) {
        // Small fixtures: text deltas only as a count, a few of each kind kept.
        const f = frame as any;
        if (dir === "in" && f?.type === "stream_event" && f.event?.type === "content_block_delta" && ++this.deltas % 25 !== 1) return;
        super.add(dir, frame);
    }
}

const log = new QuietLog(fixture("claude-steer-immediate"));
const cwd = mkdtempSync(join(tmpdir(), "steer-probe-"));
const args = [...STREAM_ARGS, "--model", process.env.PROBE_CLAUDE_MODEL ?? "haiku", "--effort", "low", "--include-partial-messages", "--permission-prompt-tool", "stdio", "--permission-mode", "default", "--no-session-persistence"];
log.note(`spawn claude ${args.join(" ")} (in a scratch folder of its own)`);
const p = new JsonProc(log, ["claude", ...args], { cwd });
let n = 0;
const control = async (request: Record<string, unknown>, timeoutMs = 15000) => {
    const request_id = `probe-${++n}`;
    const from = p.frames.length;
    p.send({ type: "control_request", request_id, request });
    return p.waitFor((f) => f.type === "control_response" && f.response?.request_id === request_id, timeoutMs, from);
};
const user = (text: string, extra: Record<string, unknown> = {}) => {
    const uuid = crypto.randomUUID();
    p.send({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "", ...extra });
    return uuid;
};

// Permission requests: only the exact command the running case asks for is allowed.
let allowed: string | undefined;
void (async () => {
    let seen = 0;
    for (;;) {
        const f = await p.waitFor((x) => x.type === "control_request" && x.request?.subtype === "can_use_tool", 600_000, seen);
        if (!f) return;
        seen = p.frames.indexOf(f) + 1;
        const command = f.request.input?.command;
        const ok = f.request.tool_name === "Bash" && command === allowed;
        log.note(`permission ${f.request.tool_name} ${JSON.stringify(command ?? null)}: ${ok ? "allowed" : "denied"}`);
        p.send({ type: "control_response", response: { subtype: "success", request_id: f.request_id, response: ok ? { behavior: "allow", updatedInput: f.request.input } : { behavior: "deny", message: "Not allowed in this probe." } } });
    }
})();

await control({ subtype: "initialize" });
const t0 = Date.now();
const at = () => Date.now() - t0;
const isTop = (f: any) => !f.parent_tool_use_id;
const toolUse = (from: number) => p.waitFor((f) => f.type === "assistant" && isTop(f) && f.message?.content?.some((b: any) => b?.type === "tool_use"), 90_000, from);
const toolResult = (from: number) => p.waitFor((f) => f.type === "user" && isTop(f) && JSON.stringify(f.message?.content ?? "").includes("tool_result"), 90_000, from);
const textDelta = (from: number) => p.waitFor((f) => f.type === "stream_event" && isTop(f) && f.event?.delta?.type === "text_delta", 90_000, from);
const lifecycle = (uuid: string, state: string, from: number, ms = 60_000) => p.waitFor((f) => f.type === "command_lifecycle" && f.command_uuid === uuid && f.state === state, ms, from);
/** Results until the steer's turn (or the turn it was folded into) is over: the one naming it, or none for 20 s. */
async function results(from: number, steer: string) {
    const out: any[] = [];
    let mark = from;
    for (;;) {
        const r = await p.waitFor((f) => f.type === "result", 90_000, mark);
        if (!r) break;
        out.push(r);
        mark = p.frames.indexOf(r) + 1;
        if ((r.user_message_uuids ?? []).includes(steer)) break;
        const next = await p.waitFor((f) => f.type === "result", 20_000, mark);
        if (!next) break;
    }
    return out;
}
function summary(kind: string, mark: number, prompt: string, steer: string) {
    const frames = p.frames.slice(mark).filter((f) => f.type !== "stream_event");
    const seq = frames.map((f) => (f.type === "command_lifecycle" ? `lifecycle:${f.command_uuid === steer ? "steer" : f.command_uuid === prompt ? "prompt" : "?"}:${f.state}` : f.type === "result" ? `result/${f.subtype}/${f.terminal_reason ?? "-"}[${(f.user_message_uuids ?? []).map((u: string) => (u === steer ? "steer" : u === prompt ? "prompt" : "?")).join(",")}]` : f.type === "system" && f.subtype === "init" ? `init` : f.type === "user" && isTop(f) ? "tool_result" : f.type === "assistant" && isTop(f) ? `assistant:${f.message?.content?.map((b: any) => b.type).join("+")}` : `${f.type}${f.subtype ? "/" + f.subtype : ""}`));
    log.note(`${kind}: frames after the prompt: ${seq.join(" ")}`);
    const texts = frames.filter((f) => f.type === "assistant" && isTop(f)).flatMap((f) => f.message.content.filter((b: any) => b.type === "text").map((b: any) => b.text as string));
    log.note(`${kind}: replies: ${JSON.stringify(texts.map((t) => (t.length > 120 ? `${t.slice(0, 60)}…${t.slice(-40)}` : t)))}`);
}

// a: plain, while a foreground command runs.
{
    const mark = p.frames.length;
    allowed = "sleep 5; echo A_DONE";
    const prompt = user("Run this Bash command in the foreground, exactly: `sleep 5; echo A_DONE` . Then reply with one short sentence.");
    await toolUse(mark);
    await sleep(1500);
    const steer = user("Also put the word PINEAPPLE in your reply.");
    const sentAt = at();
    const queued = await lifecycle(steer, "queued", mark, 5000);
    const result = await toolResult(mark);
    const resultAt = at();
    const started = await lifecycle(steer, "started", mark);
    log.note(`a: steer sent at ${sentAt} ms, queued=${Boolean(queued)}, the command's result at ${resultAt} ms, the steer started ${started ? `${at() - resultAt} ms or less after it` : "never"} (result frame seen=${Boolean(result)})`);
    await results(mark, steer);
    summary("a", mark, prompt, steer);
    await sleep(500);
}
// b: "now", while the model streams text.
{
    const mark = p.frames.length;
    allowed = undefined;
    const prompt = user("Write the integers from 1 to 300, one per line, as plain text. Use no tools.");
    await textDelta(mark);
    await sleep(400);
    const steer = user("Stop counting. Reply with exactly the word: steered", { priority: "now" });
    const sentAt = at();
    const firstResult = await p.waitFor((f) => f.type === "result", 60_000, p.frames.length - 1);
    log.note(`b: the running turn's result ${at() - sentAt} ms after the steer: subtype=${firstResult?.subtype} is_error=${firstResult?.is_error} terminal_reason=${firstResult?.terminal_reason} names=${JSON.stringify((firstResult?.user_message_uuids ?? []).map((u: string) => (u === steer ? "steer" : u === prompt ? "prompt" : "?")))}`);
    await results(mark, steer);
    summary("b", mark, prompt, steer);
    await sleep(500);
}
// c: "now", while a foreground command runs.
{
    const mark = p.frames.length;
    allowed = "sleep 5; echo C_DONE";
    const prompt = user("Run this Bash command in the foreground, exactly: `sleep 5; echo C_DONE` . Then reply with one short sentence.");
    await toolUse(mark);
    await sleep(1500);
    const steer = user("Also put the word MANGO in your reply.", { priority: "now" });
    const sentAt = at();
    await toolResult(mark);
    log.note(`c: steer sent at ${sentAt} ms; the command's result came ${at() - sentAt} ms later (it ran to its end)`);
    await results(mark, steer);
    summary("c", mark, prompt, steer);
    await sleep(500);
}
// d: plain, while a foreground command runs; then cancel_async_message for it; then an interrupt.
{
    const mark = p.frames.length;
    allowed = "sleep 5; echo D_DONE";
    const prompt = user("Run this Bash command in the foreground, exactly: `sleep 5; echo D_DONE` . Then reply with one short sentence.");
    await toolUse(mark);
    await sleep(1500);
    const steer = user("Also put the word KIWI in your reply.");
    await lifecycle(steer, "queued", mark, 5000);
    const cancel = await control({ subtype: "cancel_async_message", message_uuid: steer });
    log.note(`d: cancel_async_message for the queued steer -> ${JSON.stringify(cancel?.response?.response ?? cancel?.response ?? null)}`);
    const steer2 = user("Also put the word LEMON in your reply.");
    await lifecycle(steer2, "queued", mark, 5000);
    const r = await control({ subtype: "interrupt" });
    log.note(`d: a second steer queued, then interrupt -> ${JSON.stringify(r?.response?.response ?? null)}`);
    const end = await p.waitFor((f) => f.type === "result", 30_000, mark);
    const cancelled2 = await lifecycle(steer2, "cancelled", mark, 5000);
    const started2 = p.frames.slice(mark).some((f) => f.type === "command_lifecycle" && f.command_uuid === steer2 && f.state === "started");
    log.note(`d: the turn ended ${end?.subtype}/${end?.terminal_reason}; the second steer cancelled=${Boolean(cancelled2)} started=${started2}`);
    await sleep(8000);
    summary("d", mark, prompt, steer2);
}
// f: "now", the moment a tool's result is in.
{
    const mark = p.frames.length;
    allowed = "sleep 2; echo F_DONE";
    const prompt = user("Run this Bash command in the foreground, exactly: `sleep 2; echo F_DONE` . Then write the integers from 1 to 40, one per line.");
    await toolResult(mark);
    const steer = user("Do not write the integers. Reply with exactly the word: switched", { priority: "now" });
    const sentAt = at();
    const firstResult = await p.waitFor((f) => f.type === "result", 60_000, mark);
    const sawText = p.frames.slice(mark).some((f) => f.type === "stream_event" && isTop(f) && f.event?.delta?.type === "text_delta" && p.frames.indexOf(f) < p.frames.indexOf(firstResult));
    log.note(`f: the running turn's result ${at() - sentAt} ms after the steer: ${firstResult?.subtype}/${firstResult?.terminal_reason} names=${JSON.stringify((firstResult?.user_message_uuids ?? []).map((u: string) => (u === steer ? "steer" : u === prompt ? "prompt" : "?")))}; text streamed before it=${sawText}`);
    await results(mark, steer);
    summary("f", mark, prompt, steer);
}
await p.kill();
