// One prompt through the harness SDK: stream the answer, answer permission
// prompts in code, and give the agent a tool of your own.
//
//   bun examples/sdk/basic.ts "add SSO sign-in" [--cwd path/to/project] [--model provider:model] [--yes]
//
// Without --yes, edits and commands are shown and declined. Try it without
// keys with `bun run sdk:example`, which runs it against the mock model.

import { query, tool, type CanUseTool } from "my-own-harness/sdk";

const args = process.argv.slice(2);
const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const cwd = flag("--cwd") ?? process.cwd();
const model = flag("--model");
const yes = args.includes("--yes");
const prompt = args.filter((a) => a !== "--yes").join(" ") || "What does this project do?";

// A tool the model can call; it runs here, in this process.
const releaseDate = tool(
    "release_date",
    "The planned release date of a feature, from the team's roadmap.",
    { type: "object", properties: { feature: { type: "string" } }, required: ["feature"] },
    async ({ feature }: { feature: string }) => `${feature}: planned for 2026-11-15`,
    { readOnly: true },
);

// Asked only for what rules and the permission mode don't already allow.
const canUseTool: CanUseTool = async (name, _input, { title, reason }) => {
    console.error(`\n? ${title}${reason ? ` (${reason})` : ""} -> ${yes ? "allowed" : "declined"}`);
    return yes ? { behavior: "allow" } : { behavior: "deny", message: "Not now: describe the change instead of making it." };
};

const q = query({ prompt, options: { cwd, model, canUseTool, tools: [releaseDate], includePartialMessages: true } });

for await (const m of q) {
    switch (m.type) {
        case "system":
            if (m.subtype === "init") console.error(`session ${m.session_id} on ${m.model} (${m.permission_mode})`);
            else if (m.subtype === "notice" && m.level !== "info") console.error(`${m.level}: ${m.message}`);
            break;
        case "stream_event":
            if (m.event.type === "text_delta") process.stdout.write(m.event.text);
            break;
        case "assistant":
            for (const b of m.message.content) if (b.type === "tool_call") console.error(`\n> ${b.name} ${JSON.stringify(b.input).slice(0, 120)}`);
            process.stdout.write("\n");
            break;
        case "tool_result":
            console.error(`  ${m.is_error ? "error" : "ok"}: ${m.content.split("\n")[0]?.slice(0, 120)}`);
            break;
        case "result":
            console.error(`\n${m.subtype} in ${m.num_turns} steps, ${m.duration_ms} ms, $${m.total_cost_usd}${m.permission_denials.length ? `, declined: ${m.permission_denials.join(", ")}` : ""}`);
            process.exitCode = m.is_error ? 1 : 0;
            break;
    }
}
