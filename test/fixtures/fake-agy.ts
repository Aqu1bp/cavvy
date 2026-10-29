// A fake `agy` for test/agy.test.ts: Antigravity's CLI as 1.4.9 speaks headless stream-json
// (test/fixtures/protocol/agy-1.4.9-*.jsonl), with the hooks of each --add-dir folder's .agents/hooks.json run as it
// runs them (a shell command, the hook's input on stdin, its JSON answer on stdout). The message says what to do:
//   [[write:<file>]]   write_file of "x" to <file> (against the cwd), through the gate
//   [[run:<command>]]  run_command, through the gate
//   [[tool:<name>]]    a tool of its own with no arguments, through the gate
//   [[unasked]]        a run_command of `touch unasked.txt` that runs without the gate
//   [[hang]]           waits until SIGINT
//   [[slow]]           a run_command of `sleep 1` that takes a second, through the gate
//   [Image attached: <path>. ...] / [PDF attached: ...]   read_file of each, through the gate
//   anything else      replies "hi"
// Before each model call it runs the PreInvocation hooks; a userMessage they inject is a user_input step, and the reply
// says what it heard.
// `agy models` lists two models; FAKE_AGY_SIGNED_OUT=1 says to sign in instead (and so does a run), and
// FAKE_AGY_MODELS_FAIL=1 fails with an error. FAKE_LOG: what it
// did, as JSON lines.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { randomUUID } from "crypto";

const argv = process.argv.slice(2);
const log = (o: unknown) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\n");
log({ argv, gateEnv: Boolean(process.env.CAVVY_AGY_GATE && process.env.CAVVY_AGY_TOKEN) });

if (argv[0] === "models") {
    console.log("Fetching available models...");
    if (process.env.FAKE_AGY_MODELS_FAIL) {
        console.error("Error: the model service is unavailable");
        process.exit(2);
    }
    if (process.env.FAKE_AGY_SIGNED_OUT) {
        console.error("Error: Please sign in to view available models. Launch the CLI without arguments to sign in.");
        process.exit(1);
    }
    console.log("gemini-4-argon-high\tGemini 4 Argon (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)");
    process.exit(0);
}

const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const zero = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 };

if (process.env.FAKE_AGY_SIGNED_OUT) {
    console.log("Authentication required. Please visit the URL to log in:\n  https://accounts.example.com/o/oauth2/auth?x=1\n\nWaiting for authentication (timeout 60s)...");
    await Bun.sleep(60_000);
    process.exit(1);
}

const cwd = process.cwd();
const gates = argv.flatMap((a, i) => (argv[i - 1] === "--add-dir" ? [a] : []));
const asked = flag("--conversation");
let conversation = asked ?? randomUUID();
let fresh = !asked;
if (asked?.startsWith("missing")) {
    console.error(`warning: conversation "${asked}" not found`);
    conversation = randomUUID();
    fresh = true;
}
let step = 0;
let turns = 0;
const usage = (n: number) => ({ input_tokens: 100 * n, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 100 * n + 10 });

/** Each hook of this event in the gate folders, run as agy runs it: its answers. */
async function hooks(event: string, input: Record<string, unknown>): Promise<any[]> {
    const answers: any[] = [];
    for (const dir of gates) {
        const file = join(dir, ".agents", "hooks.json");
        if (!existsSync(file)) continue;
        for (const hook of Object.values(JSON.parse(readFileSync(file, "utf8"))) as any[]) {
            const groups = hook[event] ?? [];
            const handlers = event === "PreToolUse" ? groups.flatMap((g: any) => g.hooks) : groups;
            for (const h of handlers) {
                const p = Bun.spawn(["sh", "-c", h.command], { stdin: new Blob([JSON.stringify({ conversationId: conversation, workspacePaths: [cwd, ...gates], ...input })]), stdout: "pipe", stderr: "pipe", env: process.env });
                const text = await new Response(p.stdout).text();
                await p.exited;
                try {
                    answers.push(JSON.parse(text));
                } catch {
                    answers.push({ decision: "deny", reason: `hook failed: ${text}` });
                }
            }
        }
    }
    log({ hook: event, answers });
    return answers;
}

async function tool(name: string, args: Record<string, unknown>, run: () => string, gated = true) {
    const i = ++step;
    const parameters = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "Content"));
    out({ event: "step_update", step_update: { conversation_id: conversation, step_index: i, state: "ACTIVE", step_type: "tool", tool_name: name, tool_info: { name, parameters } } });
    const answers = gated ? await hooks("PreToolUse", { stepIdx: i, toolCall: { name, args } }) : [{ decision: "auto_approve" }];
    const denied = answers.find((a) => a.decision === "deny");
    if (denied || !answers.some((a) => a.decision === "auto_approve")) {
        const message = denied ? `tool call denied by pre-tool hook: ${denied.reason}` : `permission check failed for ${name}: user denied permission`;
        out({ event: "step_update", step_update: { conversation_id: conversation, step_index: i, state: "ERROR", step_type: "tool", tool_name: name, tool_info: { name, parameters, error: { type: "TOOL_ERROR", message } } } });
        // The model's next call takes a moment.
        await Bun.sleep(300);
        return message;
    }
    const output = run();
    out({ event: "step_update", step_update: { conversation_id: conversation, step_index: i, state: "DONE", step_type: "tool", tool_name: name, tool_info: { name, parameters, output } } });
    return output;
}

/** Before a model call: what the PreInvocation hooks inject, as user_input steps. */
let invocation = 0;
const heard: string[] = [];
async function invoke() {
    for (const a of await hooks("PreInvocation", { invocationNum: invocation++, initialNumSteps: step + 1 })) {
        for (const s of a.injectSteps ?? []) {
            if (typeof s.userMessage !== "string") continue;
            heard.push(s.userMessage);
            log({ injected: s.userMessage });
            out({ event: "step_update", step_update: { conversation_id: conversation, step_index: ++step, state: "DONE", step_type: "user_input" } });
        }
    }
}

function reply(text: string) {
    const i = ++step;
    out({ event: "step_update", step_update: { conversation_id: conversation, step_index: i, state: "ACTIVE", step_type: "agent_response", text_delta: text } });
    out({ event: "step_update", step_update: { conversation_id: conversation, step_index: i, state: "DONE", step_type: "agent_response", text_delta: "\n", usage: usage(turns) } });
}

let hang = false;
process.on("SIGINT", () => {
    log({ signal: "SIGINT", hang });
    console.error("error: interrupted");
    out({ event: "result", result: { conversation_id: conversation, status: "ERROR", response: "", error: "interrupted", num_turns: turns, usage: zero } });
    process.exit(1);
});

await Bun.sleep(20);
out({ event: "init", conversation_id: conversation, init: { model: flag("--model") ?? "default", cwd, tools: ["run_command"], permission_mode: "request-review" } });

const reader = Bun.stdin.stream().getReader();
const d = new TextDecoder();
let buf = "";
for (;;) {
    const r = await reader.read();
    if (r.done) break;
    buf += d.decode(r.value, { stream: true });
    let n: number;
    while ((n = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, n).trim();
        buf = buf.slice(n + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        log({ input: msg });
        if (msg.event !== "user") {
            console.error(`warning: ignoring unsupported stream input message event "${msg.event}"`);
            continue;
        }
        if (typeof msg.message?.content !== "string") {
            out({ event: "result", result: { conversation_id: conversation, status: "ERROR", response: "", error: 'stream input content block type "image" is not supported (only "text")', num_turns: turns, usage: zero } });
            process.exit(1);
        }
        turns++;
        const text: string = msg.message.content;
        out({ event: "step_update", step_update: { conversation_id: conversation, step_index: ++step, state: "DONE", step_type: "user_input" } });
        if (fresh) {
            fresh = false;
            await hooks("SessionStart", {});
        }
        let said = "hi";
        invocation = 0;
        heard.length = 0;
        await invoke();
        const write = /\[\[write:([^\]]+)\]\]/.exec(text);
        const run = /\[\[run:([^\]]+)\]\]/.exec(text);
        const own = /\[\[tool:([^\]]+)\]\]/.exec(text);
        if (write) {
            const path = isAbsolute(write[1]!) ? write[1]! : resolve(cwd, write[1]!);
            said = await tool("write_file", { Path: path, Content: "x" }, () => (writeFileSync(path, "x"), "Created file"));
        } else if (run) said = await tool("run_command", { CommandLine: run[1], WaitMsBeforeAsync: 5000 }, () => "Command exited with code 0.");
        else if (own) said = await tool(own[1]!, {}, () => "ok");
        else if (text.includes("[[slow]]")) said = await tool("run_command", { CommandLine: "sleep 1" }, () => (Bun.sleepSync(1000), "Command exited with code 0."));
        else if (/\[(Image|PDF) attached: /.test(text)) {
            const outs: string[] = [];
            for (const m of text.matchAll(/\[(?:Image|PDF) attached: (\S+)\. /g)) outs.push(await tool("read_file", { Path: m[1] }, () => `read ${readFileSync(m[1]!).length} bytes`));
            said = outs.join("; ");
        }
        else if (text.includes("[[unasked]]")) said = await tool("run_command", { CommandLine: "touch unasked.txt" }, () => (writeFileSync(join(cwd, "unasked.txt"), ""), "Command exited with code 0."), false);
        else if (text.includes("[[hang]]")) {
            hang = true;
            out({ event: "step_update", step_update: { conversation_id: conversation, step_index: ++step, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "sleep 600" } } } });
            await hooks("PreToolUse", { stepIdx: step, toolCall: { name: "run_command", args: { CommandLine: "sleep 600" } } });
            await Bun.sleep(600_000);
        }
        await invoke();
        if (heard.length) said += ` (heard: ${heard.join(" | ")})`;
        reply(said);
        out({ event: "result", result: { conversation_id: conversation, status: "SUCCESS", response: said, num_turns: turns, usage: usage(turns) } });
    }
}
process.exit(0);
