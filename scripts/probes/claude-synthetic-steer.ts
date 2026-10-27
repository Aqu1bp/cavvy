// Whether a result acknowledges a message sent mid-turn (user_message_uuids) when that message is marked isSynthetic, as
// Cavvy sends a watch's events (src/backends/claude-code.ts forwardQueued), against a plain one, as it sends the user's.
// Each turn runs two foreground commands; the message goes after the first one's tool result, as Cavvy steers.
//   bun scripts/probes/claude-synthetic-steer.ts
import { Log, sleep, fixture } from "./lib";
import { startClaude } from "./claude-lib";

const log = new Log(fixture("claude-synthetic-steer"));
const { p, control, user, result } = startClaude(log);
const init = await control({ subtype: "initialize" });
log.note(`claude_code_version=${init?.response?.response?.claude_code_version ?? "?"}`);

for (const synthetic of [true, false]) {
    const kind = synthetic ? "synthetic" : "plain";
    const mark = p.frames.length;
    const prompt = user(`Run these two Bash commands in the foreground, one tool call each, one after the other: \`sleep 4; echo ONE\` then \`sleep 4; echo TWO\`. Then reply with the single word: done.`);
    // After the first command's tool result, as Cavvy steers.
    await p.waitFor((f) => f.type === "user" && !f.parent_tool_use_id && JSON.stringify(f.message?.content ?? "").includes("tool_result"), 90_000, mark);
    const steer = user(`A note for you: ${kind} message mid-turn. Mention the word NOTED in your reply.`, synthetic ? { isSynthetic: true } : {});
    log.note(`${kind}: prompt=${prompt} steer=${steer}`);
    const r = await result(mark, 120_000);
    log.note(`${kind}: result user_message_uuid=${r?.user_message_uuid ?? null} user_message_uuids=${JSON.stringify(r?.user_message_uuids ?? null)} origin=${JSON.stringify(r?.origin ?? null)} text="${String(r?.result ?? "").slice(0, 80)}"`);
    log.note(`${kind}: the result acknowledges the prompt=${(r?.user_message_uuids ?? []).includes(prompt)} the steer=${(r?.user_message_uuids ?? []).includes(steer)}`);
    // Whether another turn comes for the steer on its own.
    const after = p.frames.length;
    const next = await p.waitFor((f) => f.type === "result", 20_000, after);
    log.note(`${kind}: another result within 20s: ${Boolean(next)}${next ? ` user_message_uuids=${JSON.stringify(next.user_message_uuids ?? null)}` : ""}`);
    log.note(`${kind}: frames in the turn (type/subtype): ${p.frames.slice(mark).map((f) => `${f.type}${f.subtype ? "/" + f.subtype : ""}`).join(" ")}`);
    await sleep(500);
}
// A turn whose own prompt is synthetic, as a wake turn's is (BackendTurn.synthetic), with nothing sent mid-turn.
{
    const mark = p.frames.length;
    const prompt = user("An event arrived: a check passed. Reply with the single word: seen.", { isSynthetic: true });
    const r = await result(mark, 120_000);
    log.note(`synthetic prompt: result user_message_uuid=${r?.user_message_uuid ?? null} user_message_uuids=${JSON.stringify(r?.user_message_uuids ?? null)} origin=${JSON.stringify(r?.origin ?? null)} acknowledges it=${(r?.user_message_uuids ?? []).includes(prompt)} text="${String(r?.result ?? "").slice(0, 60)}"`);
}
await p.kill();
