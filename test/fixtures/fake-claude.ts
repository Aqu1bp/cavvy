// A stand-in for the `claude` CLI, speaking the parts of its stream-json
// protocol the harness uses: `auth status --json`, and `-p` with stream-json
// in and out (initialize, a turn that asks permission for one tool, interrupt,
// set_permission_mode, --resume). It makes no network requests.
//
// FAKE_LOG          each line: what it was started with, and what it received
// FAKE_LOGGED_IN=0  auth status says signed out
// FAKE_SCENARIO     write (default) | ask | plan | hang | bash | leak
// FAKE_API_KEY_SOURCE  system/init apiKeySource (default "none": a plan)

import { appendFileSync, writeFileSync } from "fs";
import { join } from "path";

const log = (o: unknown) => {
    if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\n");
};
const argv = process.argv.slice(2);
log({ argv, cwd: process.cwd(), sawApiKey: Boolean(process.env.ANTHROPIC_API_KEY), sawOpenAiKey: Boolean(process.env.OPENAI_API_KEY) });

if (argv[0] === "auth" && argv[1] === "status") {
    const on = process.env.FAKE_LOGGED_IN !== "0";
    console.log(JSON.stringify(on ? { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty", subscriptionType: "max" } : { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }));
    process.exit(on ? 0 : 1);
}

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const resume = flag("--resume");
const scenario = process.env.FAKE_SCENARIO ?? "write";
if (resume?.startsWith("gone")) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, errors: [`No conversation found with session ID: ${resume}`], usage: {}, session_id: resume });
    process.exit(1);
}
const sessionId = resume ?? `sess-${Math.random().toString(36).slice(2, 10)}`;
const pending = new Map<string, (r: any) => void>();
let interrupted = false;
let wake: (() => void) | undefined;
let seq = 0;

function result(subtype: string, extra: Record<string, unknown> = {}) {
    out({
        type: "result",
        subtype,
        is_error: subtype !== "success",
        session_id: sessionId,
        total_cost_usd: 0.5,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
        modelUsage: { "claude-test-1": { contextWindow: 200000 } },
        ...extra,
    });
}

function ask(toolName: string, input: Record<string, unknown>, id: string): Promise<any> {
    const request_id = `req-${++seq}`;
    out({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: toolName, display_name: toolName, input, tool_use_id: id, permission_suggestions: [] } });
    return new Promise((resolve) => pending.set(request_id, resolve));
}

function text(t: string) {
    out({ type: "stream_event", event: { type: "message_start", message: { id: "m" } }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } }, parent_tool_use_id: null, session_id: sessionId });
}

function toolUse(id: string, name: string, input: Record<string, unknown>) {
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null, session_id: sessionId });
}

function toolResult(id: string, content: string, isError: boolean, structured?: unknown) {
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] }, parent_tool_use_id: null, session_id: sessionId, tool_use_result: structured });
}

async function turn(content: any[]) {
    interrupted = false;
    out({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: process.env.FAKE_API_KEY_SOURCE ?? "none", permissionMode: flag("--permission-mode") });
    // Slash commands are Claude Code's own: /compact compacts the session.
    if (String(content.find((c) => c?.type === "text")?.text ?? "").startsWith("/compact")) {
        out({ type: "system", subtype: "compact_boundary", session_id: sessionId });
        return result("success", { result: "" });
    }
    text("Working on it.");
    if (scenario === "write") {
        const file = join(process.cwd(), "out.txt");
        const input = { file_path: file, content: "hi\n" };
        toolUse("toolu_1", "Write", input);
        const r = await ask("Write", input, "toolu_1");
        if (r.behavior === "allow") {
            writeFileSync(file, String((r.updatedInput ?? input).content));
            toolResult("toolu_1", `File created successfully at: ${file}`, false, { type: "create", filePath: file, content: "hi\n", originalFile: null });
        } else {
            toolResult("toolu_1", String(r.message), true);
            if (r.interrupt) return result("error_during_execution", { errors: ["interrupted by the permission handler"] });
        }
    } else if (scenario === "bash") {
        const input = { command: "npm test", description: "Run tests" };
        toolUse("toolu_b", "Bash", input);
        const r = await ask("Bash", input, "toolu_b");
        toolResult("toolu_b", r.behavior === "allow" ? "ok" : String(r.message), r.behavior !== "allow");
    } else if (scenario === "leak") {
        // Prints a file that holds a key.
        const input = { command: "cat secret.txt" };
        toolUse("toolu_l", "Bash", input);
        const r = await ask("Bash", input, "toolu_l");
        toolResult("toolu_l", r.behavior === "allow" ? require("fs").readFileSync(join(process.cwd(), "secret.txt"), "utf-8") : String(r.message), r.behavior !== "allow");
    } else if (scenario === "ask") {
        const input = { questions: [{ question: "Which color?", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }], multiSelect: false }] };
        toolUse("toolu_q", "AskUserQuestion", input);
        const r = await ask("AskUserQuestion", input, "toolu_q");
        toolResult("toolu_q", JSON.stringify(r), r.behavior !== "allow");
    } else if (scenario === "plan") {
        const input = { plan: "1. Do the thing" };
        toolUse("toolu_p", "ExitPlanMode", input);
        const r = await ask("ExitPlanMode", input, "toolu_p");
        toolResult("toolu_p", JSON.stringify(r), r.behavior !== "allow");
    } else if (scenario === "hang") {
        toolUse("toolu_h", "Bash", { command: "sleep 1000" });
        await new Promise<void>((r) => (wake = r));
        if (interrupted) return result("error_during_execution", { errors: ["Request interrupted by user"] });
    }
    text("All done.");
    result("success", { result: "All done." });
}

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
    buf += new TextDecoder().decode(chunk);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        log({ received: m });
        if (m.type === "control_request") {
            const sub = m.request?.subtype;
            if (sub === "initialize") {
                out({
                    type: "control_response",
                    response: {
                        subtype: "success",
                        request_id: m.request_id,
                        response: {
                            models: [
                                { value: "default", resolvedModel: "claude-test-1", displayName: "Default (recommended)", supportedEffortLevels: ["low", "high"] },
                                { value: "sonnet", resolvedModel: "claude-test-2", displayName: "Sonnet", supportedEffortLevels: ["low", "high"] },
                            ],
                            account: { tokenSource: "none" },
                        },
                    },
                });
            } else if (sub === "interrupt") {
                interrupted = true;
                out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
                wake?.();
            } else out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
        } else if (m.type === "control_response") {
            const r = pending.get(m.response?.request_id);
            pending.delete(m.response?.request_id);
            r?.(m.response?.response ?? {});
        } else if (m.type === "user") void turn(m.message?.content ?? []);
    }
}
