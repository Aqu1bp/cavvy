// A stand-in for the `claude` CLI, speaking the parts of its stream-json
// protocol the harness uses: `auth status --json`, and `-p` with stream-json
// in and out (initialize, a turn with one tool call, interrupt,
// set_permission_mode, --resume). It makes no network requests.
//
// It decides like the real CLI (checked against Claude Code 2.1.300) what it
// does without asking: deny rules from --settings or the project's
// .claude/settings.json refuse, ask rules ask, reads inside the folder run,
// and in its own acceptEdits mode so do edits and file commands (rm, mv, …);
// everything else asks the host. Without --setting-sources excluding
// "project", it loads .claude/settings.json and runs its SessionStart hooks.
//
// FAKE_LOG          each line: what it was started with, and what it received
// FAKE_LOGGED_IN=0  auth status says signed out
// FAKE_SCENARIO     write (default) | write-config | read-secret | rm | bash | leak | ask | plan | hang
// FAKE_API_KEY_SOURCE  system/init apiKeySource (default "none": a plan)
// FAKE_IGNORE_STOP=1   ignores interrupt requests and SIGTERM
// FAKE_CRASH_ON_SECOND=1  exits without a result on its second prompt

import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

const log = (o: unknown) => {
    if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\n");
};
const argv = process.argv.slice(2);
const cwd = process.cwd();
log({ argv, cwd, sawApiKey: Boolean(process.env.ANTHROPIC_API_KEY), sawOpenAiKey: Boolean(process.env.OPENAI_API_KEY) });

if (argv[0] === "auth" && argv[1] === "status") {
    const on = process.env.FAKE_LOGGED_IN !== "0";
    console.log(JSON.stringify(on ? { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty", subscriptionType: "max" } : { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }));
    process.exit(on ? 0 : 1);
}
if (process.env.FAKE_IGNORE_STOP === "1") process.on("SIGTERM", () => log({ ignored: "SIGTERM" }));

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

// ---- configuration, as the real CLI loads it
let mode = flag("--permission-mode") ?? "default";
const sources = flag("--setting-sources");
const loadsProject = sources === undefined || sources.split(",").includes("project");
const projectFile = join(cwd, ".claude", "settings.json");
const project: any = loadsProject && existsSync(projectFile) ? JSON.parse(readFileSync(projectFile, "utf-8")) : {};
const fromFlag: any = flag("--settings") ? JSON.parse(flag("--settings")!).permissions ?? {} : {};
const deny: string[] = [...(fromFlag.deny ?? []), ...(project.permissions?.deny ?? [])];
const askRules: string[] = [...(fromFlag.ask ?? []), ...(project.permissions?.ask ?? [])];
const allow: string[] = project.permissions?.allow ?? [];
for (const h of project.hooks?.SessionStart ?? []) for (const c of h.hooks ?? []) Bun.spawnSync(["sh", "-c", c.command]);

/** Claude Code's rule matching, for the forms the harness passes: Tool, Tool(//abs/path[/**]), Bash(prefix:*). */
function ruleHits(rule: string, tool: string, input: any): boolean {
    const m = rule.match(/^(\w+)(?:\((.*)\))?$/);
    if (!m) return false;
    const [, rTool, spec] = m;
    const kind = ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool) ? "Edit" : ["Read", "Glob", "Grep"].includes(tool) ? "Read" : tool;
    if (rTool !== kind) return false;
    if (!spec) return true;
    if (kind === "Bash") return spec.endsWith(":*") ? String(input.command).startsWith(spec.slice(0, -2)) : input.command === spec;
    if (!spec.startsWith("//")) return false;
    // gitignore-style: ** spans directories (**/ also matches none), * stays within one.
    const re = spec
        .slice(1)
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "\u0000")
        .replace(/\*\*/g, "\u0001")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, "(?:.*/)?")
        .replace(/\u0001/g, ".*");
    return new RegExp(`^${re}$`).test(String(input.file_path ?? ""));
}

const inside = (p: unknown) => typeof p === "string" && p.startsWith(cwd + "/");
const FILE_COMMANDS = /^(rm|mv|cp|mkdir|touch|sed)\b/;

/** Whether it runs a call without asking the host, in its current mode. */
function selfApproved(tool: string, input: any): boolean {
    if (allow.some((r) => ruleHits(r, tool, input))) return true;
    if (tool === "Read" && inside(input.file_path)) return true;
    if (mode === "bypassPermissions") return true;
    if (mode === "acceptEdits") {
        if (["Write", "Edit"].includes(tool) && inside(input.file_path) && !String(input.file_path).includes("/.claude/")) return true;
        if (tool === "Bash" && FILE_COMMANDS.test(String(input.command))) return true;
    }
    return false;
}

const sessionId = resume ?? `sess-${Math.random().toString(36).slice(2, 10)}`;
const pending = new Map<string, (r: any) => void>();
let interrupted = false;
let wake: (() => void) | undefined;
let seq = 0;
let prompts = 0;

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

/** What running the call does (only what the scenarios need). */
function execute(tool: string, input: any): { content: string; structured?: unknown } {
    if (tool === "Write") {
        writeFileSync(input.file_path, String(input.content));
        return { content: `File created successfully at: ${input.file_path}`, structured: { type: "create", filePath: input.file_path, content: input.content, originalFile: null } };
    }
    if (tool === "Read") return { content: readFileSync(input.file_path, "utf-8") };
    const cmd = String(input.command);
    if (cmd.startsWith("rm ")) {
        unlinkSync(join(cwd, cmd.slice(3).trim()));
        return { content: "" };
    }
    if (cmd.startsWith("cat ")) return { content: readFileSync(join(cwd, cmd.slice(4).trim()), "utf-8") };
    return { content: "ok" };
}

/** One tool call, decided like the real CLI. False when the turn was stopped. */
async function use(id: string, tool: string, input: any): Promise<boolean> {
    toolUse(id, tool, input);
    if (deny.some((r) => ruleHits(r, tool, input))) {
        toolResult(id, `Permission to use ${tool} has been denied by your permission settings.`, true);
        return true;
    }
    if (!askRules.some((r) => ruleHits(r, tool, input)) && selfApproved(tool, input)) {
        const r = execute(tool, input);
        toolResult(id, r.content, false, r.structured);
        return true;
    }
    const r = await ask(tool, input, id);
    if (r.behavior === "allow") {
        const x = execute(tool, r.updatedInput ?? input);
        toolResult(id, x.content, false, x.structured);
        return true;
    }
    toolResult(id, String(r.message), true);
    if (r.interrupt) {
        result("error_during_execution", { errors: ["interrupted by the permission handler"] });
        return false;
    }
    return true;
}

async function turn(content: any[]) {
    interrupted = false;
    if (++prompts === 2 && process.env.FAKE_CRASH_ON_SECOND === "1") process.exit(3);
    out({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: process.env.FAKE_API_KEY_SOURCE ?? "none", permissionMode: mode });
    // Slash commands are Claude Code's own: /compact compacts the session.
    if (String(content.find((c) => c?.type === "text")?.text ?? "").startsWith("/compact")) {
        out({ type: "system", subtype: "compact_boundary", session_id: sessionId });
        return result("success", { result: "" });
    }
    text("Working on it.");
    let go = true;
    if (scenario === "write") go = await use("toolu_1", "Write", { file_path: join(cwd, "out.txt"), content: "hi\n" });
    else if (scenario === "write-config") go = await use("toolu_c", "Write", { file_path: join(cwd, ".claude", "settings.json"), content: "{}" });
    else if (scenario === "read-secret") go = await use("toolu_r", "Read", { file_path: join(cwd, "secret.txt") });
    else if (scenario === "rm") go = await use("toolu_rm", "Bash", { command: "rm victim.txt", description: "Remove it" });
    else if (scenario === "bash") go = await use("toolu_b", "Bash", { command: "npm test", description: "Run tests" });
    else if (scenario === "leak") go = await use("toolu_l", "Bash", { command: "cat secret.txt" });
    else if (scenario === "ask") {
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
    if (!go) return;
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
                if (process.env.FAKE_IGNORE_STOP === "1") continue;
                interrupted = true;
                out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
                wake?.();
            } else {
                if (sub === "set_permission_mode") mode = m.request.mode;
                out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
            }
        } else if (m.type === "control_response") {
            const r = pending.get(m.response?.request_id);
            pending.delete(m.response?.request_id);
            r?.(m.response?.response ?? {});
        } else if (m.type === "user") void turn(m.message?.content ?? []);
    }
}
// stdin closed: like the real CLI, exit once nothing's left to do (unless it's stuck).
if (process.env.FAKE_IGNORE_STOP === "1") await new Promise(() => {});
