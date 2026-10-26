// A conversation through the harness SDK: each message from the prompt
// iterable is a turn in one session, steer() reaches the turn that's running,
// and interrupt() stops it. Afterwards the session can be opened with
// `harness -r <id>`.
//
//   bun examples/sdk/conversation.ts [--cwd path/to/project] [--model provider:model]

import { query, type SDKUserMessage } from "my-own-harness/sdk";

const args = process.argv.slice(2);
const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};

// The messages, sent as each turn ends.
const turns = ["What is in this project? Answer in two sentences.", "Which file would you change first, and why?"];
let next: (() => void) | undefined;
async function* messages(): AsyncGenerator<SDKUserMessage> {
    for (const text of turns) {
        yield text;
        await new Promise<void>((r) => (next = r));
    }
}

const q = query({ prompt: messages(), options: { cwd: flag("--cwd") ?? process.cwd(), model: flag("--model"), permissionMode: "plan" } });
let steered = false;

for await (const m of q) {
    if (m.type === "assistant") {
        const text = m.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        if (text) console.log(`\n${text}`);
        // While the first turn works, add to it.
        if (!steered && m.message.content.some((b) => b.type === "tool_call")) {
            steered = await q.steer("Keep it short.");
        }
    }
    if (m.type === "result") {
        console.error(`(${m.subtype}, ${m.num_turns} steps)`);
        next?.();
    }
}
console.error(`session: ${await q.sessionId}`);
