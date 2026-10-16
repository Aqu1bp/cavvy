// A stand-in for `codex app-server`: newline-delimited JSON-RPC with the
// requests, notifications and approval requests the harness uses. A turn
// says something, does one thing (a command by default), and finishes. No
// network.
//
// Like the real CLI (checked against Codex 0.162.1), it asks for approval
// only where its approval policy says so: under "untrusted" for every
// command (`cat` included) and for edits outside a writable sandbox; under
// "on-request" with a workspace-write sandbox it runs commands itself; under
// "never" it asks for nothing. With FAKE_CODEX_TRUSTS=1 it trusts the project
// and loads .codex/config.toml (its model), unless -c projects=… marks the
// folder untrusted.
//
// FAKE_LOG            each line: what it was started with, and what it received
// FAKE_ACCOUNT        chatgpt (default) | apikey | none
// FAKE_DECLINE=1      offer "decline" among the command's availableDecisions
// FAKE_REVIEW_DENY=1  with approvalsReviewer auto_review, the command leaves the sandbox and Codex's
//                     reviewer turns it down (the client isn't asked); FAKE_REVIEW_NO_COMPLETED=1 leaves out
//                     its item/autoApprovalReview/completed event; FAKE_REVIEW_MIXED=1 adds several more
//                     verdicts, out of step
// FAKE_COMMAND        the command the "cmd" scenario runs (default: touch x); FAKE_COMMAND_SCRIPT the whole
//                     script, where Codex's parsed commandActions leave part of it out; FAKE_COMMAND_RAW
//                     the command exactly as Codex shows it (its shell wrapper, quoted); FAKE_COMMAND_CWD its folder
// FAKE_SCENARIO       cmd (default) | rename | perms | slow | mcp | subagent | elicit | web
//                     subagent: Codex's own sub-agent (spawnAgent, then wait): its thread runs a command (which
//                     asks from its thread under untrusted), says something, answers and has usage of its own;
//                     FAKE_CHILD_EARLY=1 sends its first events before the spawn says which thread is whose;
//                     FAKE_RESUME_AGENT=1 resumes the sub-agent (of an earlier turn) instead of spawning it;
//                     FAKE_CHILD_TWICE=1 messages it after it answered, and it works again
//                     elicit: an MCP tool call Codex asks about (an elicitation of its own, FAKE_ELICIT=approval,
//                     the default), or an MCP server's form (FAKE_ELICIT=form) or link (FAKE_ELICIT=url)
//                     web: a web search whose query comes only when it completes
// FAKE_PHASES=1       agent messages say their phase (commentary, final_answer), as current models' do
// FAKE_CODEX_SCENARIO  overrides FAKE_SCENARIO here (a fake Claude Code and Codex in one test)
// FAKE_REJECT_CONFIG=1  thread/start and thread/resume fail when given config, like a Codex that can't parse it
// FAKE_HANG_INIT=1    never answers initialize, and ignores SIGTERM
// FAKE_PERMS          the permissions the "perms" scenario asks for (JSON)
// FAKE_THREAD_TIER     the service tier a resumed thread is already on (e.g. priority from an earlier turn);
// FAKE_CONFIG_TIER     the tier Codex's own config gives a new thread
// FAKE_SLOW_RESUME, FAKE_SLOW_TURN_START  milliseconds before answering thread/resume, turn/start
// FAKE_MCP_CALLS      the "mcp" scenario's calls to servers from the thread's config: [{ server?, tool, args }]
// FAKE_USER_MCP       config/read's mcp_servers: the user's own servers (JSON); FAKE_NO_CONFIG_READ=1 fails config/read
//
// Token usage is each thread's running total, kept beside the log as Codex keeps it with the thread. Like
// Codex 0.163 (checked against it with a stand-in model server), it reports the last usage again on
// thread/resume (with the earlier turn's id) and when a compaction starts.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { callTool, connect, type McpServerRef } from "./mcp-call";

const log = (o: unknown) => {
    if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\n");
};
const argv = process.argv.slice(2);
const cwd = process.cwd();
log({ argv, sawOpenAiKey: Boolean(process.env.OPENAI_API_KEY), sawApiKey: Boolean(process.env.ANTHROPIC_API_KEY) });
if (argv[0] !== "app-server") {
    console.error("fake codex: only app-server");
    process.exit(2);
}
if (process.env.FAKE_HANG_INIT === "1") process.on("SIGTERM", () => log({ ignored: "SIGTERM" }));

/** The project's own config, if it trusts the project (and wasn't told not to). */
function projectModel(): string | undefined {
    if (process.env.FAKE_CODEX_TRUSTS !== "1") return undefined;
    const overrides = argv.filter((_, i) => argv[i - 1] === "-c").join("\n");
    if (overrides.includes(`${JSON.stringify(cwd)}={trust_level="untrusted"}`)) return undefined;
    const f = join(cwd, ".codex", "config.toml");
    return existsSync(f) ? readFileSync(f, "utf-8").match(/model\s*=\s*"([^"]+)"/)?.[1] : undefined;
}

const scenario = process.env.FAKE_CODEX_SCENARIO ?? process.env.FAKE_SCENARIO ?? "cmd";
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const pending = new Map<number, (r: any) => void>();
let serverSeq = 100;
let turnSeq = 0;
/** Each thread's service tier, as Codex keeps it ("priority", "flex", or null for standard). */
// Codex keeps a thread's tier with the thread, so it outlives this process: kept beside the log.
const tierFile = process.env.FAKE_LOG ? process.env.FAKE_LOG + ".tiers.json" : undefined;
const tiers = new Map<string, string | null>(tierFile && existsSync(tierFile) ? Object.entries(JSON.parse(readFileSync(tierFile, "utf8"))) : []);
// As 0.163 does: no tier (or null, which clears one) is reported as "default".
const setTier = (id: string, tier: unknown) => {
    tiers.set(id, typeof tier === "string" ? tier : "default");
    if (tierFile) writeFileSync(tierFile, JSON.stringify(Object.fromEntries(tiers)));
};
let current: { threadId: string; turnId: string; interrupted: boolean; wake?: () => void } | undefined;
type Tokens = { totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
/** Each thread's token usage: its running total, its last response's, and the turn that was in. */
const usageFile = process.env.FAKE_LOG ? process.env.FAKE_LOG + ".usage.json" : undefined;
const usageOf = new Map<string, { total: Tokens; last: Tokens; turnId: string }>(usageFile && existsSync(usageFile) ? Object.entries(JSON.parse(readFileSync(usageFile, "utf8"))) : []);
const tokens = (input: number, cached: number, output: number, reasoning = 0): Tokens => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: reasoning });
/** A response's usage: added to the thread's total, and reported. */
function spend(threadId: string, turnId: string, last: Tokens) {
    const was = usageOf.get(threadId)?.total;
    const total = was ? (Object.fromEntries(Object.entries(was).map(([k, v]) => [k, v + last[k as keyof Tokens]])) as Tokens) : last;
    usageOf.set(threadId, { total, last, turnId });
    if (usageFile) writeFileSync(usageFile, JSON.stringify(Object.fromEntries(usageOf)));
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total, last, modelContextWindow: 400000 } });
}
/** The thread's usage as it last was, reported again (no new spend). */
function repeatUsage(threadId: string, turnId?: string) {
    const u = usageOf.get(threadId);
    if (u) notify("thread/tokenUsage/updated", { threadId, turnId: turnId ?? u.turnId, tokenUsage: { total: u.total, last: u.last, modelContextWindow: 400000 } });
}
const phase = (p: string) => (process.env.FAKE_PHASES === "1" ? { phase: p } : {});
/** MCP servers from the thread's config, connected at thread start. */
const mcpServers = new Map<string, McpServerRef>();

async function startMcp(config: any) {
    for (const [name, cfg] of Object.entries<any>(config?.mcp_servers ?? {})) {
        if (!cfg?.url) continue;
        const s = { url: cfg.url, headers: cfg.http_headers ?? {} };
        try {
            const c = await connect(s);
            mcpServers.set(name, s);
            log({ mcpConnected: name, instructions: c.instructions, tools: c.tools.map((t: any) => t.name), approvalMode: cfg.default_tools_approval_mode, toolTimeoutSec: cfg.tool_timeout_sec });
        } catch (e) {
            log({ mcpFailed: name, error: (e as Error).message });
        }
    }
}

function serverRequest(method: string, params: unknown): Promise<any> {
    const id = ++serverSeq;
    out({ id, method, params });
    return new Promise((resolve) => pending.set(id, resolve));
}

const notify = (method: string, params: unknown) => out({ method, params });

async function runTurn(threadId: string, turnId: string, policy: { approvalPolicy?: string; sandboxPolicy?: { type?: string }; approvalsReviewer?: string }) {
    const t: NonNullable<typeof current> = { threadId, turnId, interrupted: false };
    current = t;
    const finish = (status: string) => notify("turn/completed", { threadId, turn: { id: turnId, status, error: null } });
    notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
    notify("item/started", { threadId, turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text: "", ...phase("commentary") } });
    notify("item/agentMessage/delta", { threadId, turnId, itemId: `msg-${turnId}`, delta: "Running it." });
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text: "Running it.", ...phase("commentary") } });
    if (scenario === "slow" && turnSeq === 1) {
        // The first turn works until interrupted (or a while).
        await Promise.race([new Promise<void>((r) => (t.wake = r)), Bun.sleep(5000)]);
        return finish(t.interrupted ? "interrupted" : "completed");
    }
    let decision: string | undefined = "accept";
    if (scenario === "mcp") {
        const calls: { server?: string; tool: string; args: Record<string, unknown> }[] = JSON.parse(process.env.FAKE_MCP_CALLS ?? "[]");
        const results: string[] = [];
        for (const [i, c] of calls.entries()) {
            const server = c.server ?? [...mcpServers.keys()][0] ?? "none";
            const s = mcpServers.get(server);
            const item = { type: "mcpToolCall", id: `mcp-${turnId}-${i}`, server, tool: c.tool, arguments: c.args, status: "inProgress", result: null, error: null };
            notify("item/started", { threadId, turnId, item });
            if (!s) {
                notify("item/completed", { threadId, turnId, item: { ...item, status: "failed", error: { message: `unknown MCP server ${server}` } } });
                results.push(`(no server ${server})`);
                continue;
            }
            // Codex sends the call's id in the request's _meta.
            const r = await callTool(s, c.tool, c.args, { callId: item.id });
            log({ mcpResult: { tool: c.tool, ...r } });
            notify("item/completed", { threadId, turnId, item: { ...item, status: r.isError ? "failed" : "completed", result: { content: [{ type: "text", text: r.text }], isError: r.isError } } });
            results.push(r.text);
            if (t.interrupted) return finish("interrupted");
        }
        notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg2-${turnId}`, text: results.join("\n---\n") } });
        return finish("completed");
    }
    if (scenario === "subagent") {
        const child = "thr-child";
        const childTurn = `turn-c${turnSeq}`;
        // FAKE_SUBAGENT_V2=1: as multi_agent_v2 announces one, with an item naming its thread rather than a spawn call.
        const v2 = process.env.FAKE_SUBAGENT_V2 === "1";
        const spawn = { type: "collabAgentToolCall", id: `spawn-${turnId}`, tool: "spawnAgent", status: "inProgress", senderThreadId: threadId, receiverThreadIds: [] as string[], prompt: "Count the files\nin src, then report.", model: "", reasoningEffort: "medium", agentsStates: {} };
        const activity = (kind: string) => ({ type: "subAgentActivity", id: `act-${kind}-${turnId}`, kind, agentThreadId: child, agentPath: "/root/count_files", model: "gpt-test", reasoningEffort: "medium" });
        // FAKE_RESUME_AGENT=1: the sub-agent is one of an earlier turn's, resumed (v2: messaged again).
        const resume = process.env.FAKE_RESUME_AGENT === "1";
        if (resume) Object.assign(spawn, { id: `resume-${turnId}`, tool: "resumeAgent", receiverThreadIds: [child], prompt: null });
        const begins = resume ? "interacted" : "started";
        if (v2) {
            notify("item/started", { threadId, turnId, item: activity(begins) });
            notify("item/completed", { threadId, turnId, item: activity(begins) });
        } else notify("item/started", { threadId, turnId, item: spawn });
        const childStarts = () => {
            notify("turn/started", { threadId: child, turn: { id: childTurn, rootTurnId: turnId, status: "inProgress" } });
            notify("item/agentMessage/delta", { threadId: child, turnId: childTurn, itemId: "c-msg1", delta: "Looking around." });
            notify("item/completed", { threadId: child, turnId: childTurn, item: { type: "agentMessage", id: "c-msg1", text: "Looking around.", phase: "commentary" } });
        };
        // FAKE_CHILD_EARLY=1: its first events come before the spawn says whose thread it is; =all: all of them.
        const early = process.env.FAKE_CHILD_EARLY;
        if (early === "1" || early === "all") childStarts();
        if (early === "all") await childRest();
        if (!v2) notify("item/completed", { threadId, turnId, item: { ...spawn, status: "completed", receiverThreadIds: [child], model: "gpt-test", agentsStates: { [child]: { status: "pendingInit", message: null } } } });
        const wait = { type: "collabAgentToolCall", id: `wait-${turnId}`, tool: "wait", status: "inProgress", senderThreadId: threadId, receiverThreadIds: [child], prompt: null, model: null, reasoningEffort: null, agentsStates: {} };
        if (!v2) notify("item/started", { threadId, turnId, item: wait });
        if (!early) childStarts();
        if (early !== "all") await childRest();
        if (v2) {
            notify("item/started", { threadId, turnId, item: activity("completed") });
            notify("item/completed", { threadId, turnId, item: activity("completed") });
        } else notify("item/completed", { threadId, turnId, item: { ...wait, status: "completed", agentsStates: { [child]: { status: "completed", message: "CHILD_REPORT: 2 files." } } } });
        // FAKE_CHILD_TWICE=1: messaged after it answered, the sub-agent works again (a second turn of its thread).
        if (process.env.FAKE_CHILD_TWICE === "1") {
            const send = { type: "collabAgentToolCall", id: `send-${turnId}`, tool: "sendInput", status: "inProgress", senderThreadId: threadId, receiverThreadIds: [child], prompt: "Now count the tests.", model: null, reasoningEffort: null, agentsStates: {} };
            notify("item/started", { threadId, turnId, item: send });
            notify("item/completed", { threadId, turnId, item: { ...send, status: "completed" } });
            const again = `${childTurn}b`;
            notify("turn/started", { threadId: child, turn: { id: again, rootTurnId: turnId, status: "inProgress" } });
            const cmd = { type: "commandExecution", id: `c-cmd2-${turnId}`, command: "/bin/zsh -lc 'touch z'", cwd, status: "inProgress", commandActions: [{ type: "unknown", command: "touch z" }], aggregatedOutput: null, exitCode: null };
            notify("item/started", { threadId: child, turnId: again, item: cmd });
            const runsItself = policy.approvalPolicy === "never" || (policy.approvalPolicy === "on-request" && policy.sandboxPolicy?.type === "workspaceWrite");
            const d = runsItself ? "accept" : (await serverRequest("item/commandExecution/requestApproval", { threadId: child, turnId: again, itemId: cmd.id, command: cmd.command, cwd, commandActions: cmd.commandActions, availableDecisions: ["accept", "decline", "cancel"] }))?.decision;
            notify("item/completed", { threadId: child, turnId: again, item: { ...cmd, status: d === "accept" ? "completed" : "declined", exitCode: d === "accept" ? 0 : null, aggregatedOutput: d === "accept" ? "ok\n" : null } });
            notify("item/completed", { threadId: child, turnId: again, item: { type: "agentMessage", id: "c-msg3", text: "CHILD_REPORT: 3 tests.", phase: "final_answer" } });
            notify("turn/completed", { threadId: child, turn: { id: again, rootTurnId: turnId, status: "completed", error: null } });
        }
        async function childRest() {
            // What only concerns the sub-agent's thread: a warning, an error it recovers from, a compaction.
            notify("warning", { threadId: child, message: "Model metadata for `gpt-test` not found." });
            notify("error", { threadId: child, turnId: childTurn, willRetry: false, error: { message: "child stream hiccup" } });
            notify("thread/compacted", { threadId: child, turnId: childTurn });
            const cmd = { type: "commandExecution", id: `c-cmd-${turnId}`, command: "/bin/zsh -lc 'touch y'", cwd, status: "inProgress", commandActions: [{ type: "unknown", command: "touch y" }], aggregatedOutput: null, exitCode: null };
            notify("item/started", { threadId: child, turnId: childTurn, item: cmd });
            notify("item/commandExecution/outputDelta", { threadId: child, turnId: childTurn, itemId: cmd.id, delta: "working\n" });
            const runsItself = policy.approvalPolicy === "never" || (policy.approvalPolicy === "on-request" && policy.sandboxPolicy?.type === "workspaceWrite");
            const childDecision = runsItself ? "accept" : (await serverRequest("item/commandExecution/requestApproval", { threadId: child, turnId: childTurn, itemId: cmd.id, command: cmd.command, cwd, commandActions: cmd.commandActions, availableDecisions: ["accept", "decline", "cancel"] }))?.decision;
            log({ childRan: childDecision === "accept" });
            notify("item/completed", { threadId: child, turnId: childTurn, item: { ...cmd, status: childDecision === "accept" ? "completed" : "declined", exitCode: childDecision === "accept" ? 0 : null, aggregatedOutput: childDecision === "accept" ? "ok\n" : null } });
            spend(child, childTurn, tokens(5000, 1000, 50));
            notify("item/completed", { threadId: child, turnId: childTurn, item: { type: "agentMessage", id: "c-msg2", text: "CHILD_REPORT: 2 files.", phase: "final_answer" } });
            notify("turn/completed", { threadId: child, turn: { id: childTurn, rootTurnId: turnId, status: "completed", error: null } });
        }
    } else if (scenario === "elicit") {
        const kind = process.env.FAKE_ELICIT ?? "approval";
        const item = { type: "mcpToolCall", id: `mcp-${turnId}`, server: "probe", tool: "write_thing", arguments: { what: "x" }, status: "inProgress", result: null, error: null };
        notify("item/started", { threadId, turnId, item });
        // FAKE_ELICIT_OTHER_CALL=1: another call of the same server, with the same arguments, still open (started after it).
        if (process.env.FAKE_ELICIT_OTHER_CALL === "1") notify("item/started", { threadId, turnId, item: { ...item, id: `mcp-read-${turnId}`, tool: "read_thing" } });
        // As Codex 0.163 sends them: its own question before an MCP tool call, or a server's form or link passed on.
        const params =
            kind === "approval"
                ? { threadId, turnId, serverName: "probe", mode: "form", _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_description: "Writes a thing", tool_params: { what: "x" } }, message: 'Allow the probe MCP server to run tool "write_thing"?', requestedSchema: { type: "object", properties: {} } }
                : kind === "url"
                  ? { threadId, turnId, serverName: "probe", mode: "url", _meta: null, message: "Sign in to Probe.", url: "https://probe.example/login", elicitationId: "el-1" }
                  : { threadId, turnId, serverName: "probe", mode: "form", _meta: null, message: "Which color?", requestedSchema: { type: "object", properties: JSON.parse(process.env.FAKE_ELICIT_FIELDS ?? '{"color":{"type":"string","enum":["red","blue"],"enumNames":["Red","Blue"]},"count":{"type":"integer","title":"How many"},"ok":{"type":"boolean","title":"Sure?"},"tags":{"type":"array","items":{"anyOf":[{"const":"a","title":"Tag A"},{"const":"b","title":"Tag B"}]}},"note":{"type":"string","title":"Note"}}'), required: ["color"] } };
        const r = await serverRequest("mcpServer/elicitation/request", params);
        log({ elicitation: r });
        const ok = r?.action === "accept";
        const error = r?.action === "decline" ? { message: "user rejected MCP tool call" } : r?.action === "cancel" ? { message: "user cancelled MCP tool call" } : null;
        notify("item/completed", { threadId, turnId, item: { ...item, status: ok ? "completed" : "failed", error: ok ? null : error, result: ok ? { content: [{ type: "text", text: `wrote ${JSON.stringify(r?.content)}` }] } : null } });
    } else if (scenario === "web") {
        const ws = { type: "webSearch", id: `ws-${turnId}`, query: "", action: { type: "other" }, results: null };
        notify("item/started", { threadId, turnId, item: ws });
        notify("item/completed", { threadId, turnId, item: { ...ws, query: "bun test runner", action: { type: "search", query: "bun test runner", queries: ["bun test runner"] } } });
    } else if (scenario === "rename") {
        const change = { type: "fileChange", id: `fc-${turnId}`, changes: [{ path: join(cwd, "a.txt"), kind: { type: "update", move_path: join(cwd, "secrets", "a.txt") }, diff: "" }], status: "inProgress" };
        if (process.env.FAKE_UNANNOUNCED !== "1") notify("item/started", { threadId, turnId, item: change });
        decision = (await serverRequest("item/fileChange/requestApproval", { threadId, turnId, itemId: change.id, reason: null, grantRoot: null }))?.decision;
        notify("item/completed", { threadId, turnId, item: { ...change, status: decision === "accept" ? "completed" : "declined" } });
    } else if (scenario === "perms") {
        const permissions = process.env.FAKE_PERMS ? JSON.parse(process.env.FAKE_PERMS) : { network: null, fileSystem: { read: null, write: [join(cwd, "secrets")] } };
        const r = await serverRequest("item/permissions/requestApproval", { threadId, turnId, itemId: `p-${turnId}`, cwd, reason: "needs to write there", permissions });
        log({ granted: r });
    } else {
        const shown = process.env.FAKE_COMMAND ?? "touch x";
        const cmd = { type: "commandExecution", id: `cmd-${turnId}`, command: process.env.FAKE_COMMAND_RAW ?? `/bin/zsh -lc '${process.env.FAKE_COMMAND_SCRIPT ?? shown}'`, cwd: process.env.FAKE_COMMAND_CWD ?? cwd, status: "inProgress", commandActions: [{ type: "unknown", command: shown }], aggregatedOutput: null, exitCode: null };
        notify("item/started", { threadId, turnId, item: cmd });
        // Its own policy: in a workspace-write sandbox with on-request, or never, it just runs it.
        const runsItself = policy.approvalPolicy === "never" || (policy.approvalPolicy === "on-request" && policy.sandboxPolicy?.type === "workspaceWrite");
        if (process.env.FAKE_REVIEW_DENY === "1" && policy.approvalsReviewer === "auto_review") {
            const review = { threadId, turnId, reviewId: `rev-${turnId}`, targetItemId: cmd.id, startedAtMs: 1, action: { type: "command", command: shown, cwd: cmd.cwd, source: "shell" } };
            notify("item/autoApprovalReview/started", { ...review, review: { status: "inProgress" } });
            if (process.env.FAKE_REVIEW_NO_COMPLETED !== "1") notify("item/autoApprovalReview/completed", { ...review, completedAtMs: 2, decisionSource: "agent", review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "It sends the project to an unknown host." } });
            // What Codex 0.163 also says about every verdict, and about the reviewer itself.
            notify("guardianWarning", { threadId, message: "Automatic approval review approved (risk: low, authorization: high): The user asked for it." });
            notify("guardianWarning", { threadId, message: "Automatic approval review denied (risk: high, authorization: low): It sends the project to an unknown host." });
            notify("guardianWarning", { threadId, message: "Automatic approval review failed: the reviewer didn't answer" });
            if (process.env.FAKE_REVIEW_MIXED === "1") {
                // Several actions, out of step: B's no comes only as its verdict line, before A's; a timeout
                // (no reason) and then C's no; the same reason as A's from a sub-agent's thread.
                const denied = (why: string, thread = threadId) => notify("guardianWarning", { threadId: thread, message: `Automatic approval review denied (risk: high, authorization: low): ${why}` });
                notify("item/autoApprovalReview/completed", { ...review, reviewId: "rev-a", completedAtMs: 3, decisionSource: "agent", review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "A: deletes the home folder." } });
                denied("B: pushes to main.");
                denied("A: deletes the home folder.");
                notify("item/autoApprovalReview/completed", { ...review, reviewId: "rev-t", completedAtMs: 4, decisionSource: "agent", review: { status: "timedOut" } });
                denied("C: posts the token.");
                denied("A: deletes the home folder.", "thr-sub");
            }
            decision = "decline";
        } else if (!runsItself) {
            const r = await serverRequest("item/commandExecution/requestApproval", {
                threadId,
                turnId,
                itemId: cmd.id,
                command: cmd.command,
                cwd: cmd.cwd,
                commandActions: cmd.commandActions,
                // What Codex 0.162 offers in untrusted mode. Like Codex, the answer isn't checked against it.
                availableDecisions: process.env.FAKE_DECLINE === "1" ? ["accept", "acceptForSession", "decline", "cancel"] : ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: shown.split(" ") } }, "cancel"],
            });
            decision = r?.decision;
        }
        log({ ran: decision === "accept", command: shown });
        if (decision === "accept") notify("item/completed", { threadId, turnId, item: { ...cmd, status: "completed", exitCode: 0, aggregatedOutput: "ok\n" } });
        else notify("item/completed", { threadId, turnId, item: { ...cmd, status: "declined" } });
    }
    spend(threadId, turnId, tokens(120, 20, 30, 5));
    if (decision === "cancel" || t.interrupted) return finish("interrupted");
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg2-${turnId}`, text: process.env.FAKE_FINAL_TEXT ?? "Finished.", ...phase("final_answer") } });
    finish("completed");
}

async function handle(m: any) {
    log({ received: m });
    if (m.method === undefined) {
        const r = pending.get(m.id);
        pending.delete(m.id);
        r?.(m.result);
        return;
    }
    const reply = (result: unknown) => out({ id: m.id, result });
    const fail = (message: string) => out({ id: m.id, error: { code: -32600, message } });
    const p = m.params ?? {};
    if ((m.method === "thread/start" || m.method === "thread/resume") && p.config && process.env.FAKE_REJECT_CONFIG === "1") return fail("invalid config: unknown field `default_tools_approval_mode`");
    switch (m.method) {
        case "initialize":
            if (process.env.FAKE_HANG_INIT === "1") return;
            return reply({ userAgent: "fake-codex/0.0.1", codexHome: "/tmp/none", platformFamily: "unix", platformOs: "linux" });
        case "config/read":
            if (process.env.FAKE_NO_CONFIG_READ === "1") return fail("config/read failed: invalid configuration");
            return reply({ config: { model: null, ...(process.env.FAKE_USER_MCP ? { mcp_servers: JSON.parse(process.env.FAKE_USER_MCP) } : {}) }, origins: {} });
        case "initialized":
            return;
        case "account/read": {
            const a = process.env.FAKE_ACCOUNT ?? "chatgpt";
            return reply(a === "none" ? { account: null, requiresOpenaiAuth: true } : a === "apikey" ? { account: { type: "apiKey" }, requiresOpenaiAuth: true } : { account: { type: "chatgpt", email: "me@example.com", planType: "plus" }, requiresOpenaiAuth: true });
        }
        case "model/list":
            return reply({
                data: [
                    { id: "gpt-hidden", model: "gpt-hidden", displayName: "Hidden", hidden: true, isDefault: false, supportedReasoningEfforts: [], inputModalities: ["text"] },
                    { id: "gpt-other", model: "gpt-other", displayName: "Other", hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }], inputModalities: ["text"] },
                    // As Codex 0.163 lists it: the tier is "priority", the legacy field still says "fast".
                    { serviceTiers: [{ id: "priority", name: "Fast", description: "Fast service" }], additionalSpeedTiers: ["fast"], defaultServiceTier: null, id: "gpt-test", model: "gpt-test", displayName: "GPT Test", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], inputModalities: ["text", "image"] },
                ],
                nextCursor: null,
            });
        case "thread/start":
            await startMcp(p.config);
            setTier("thr-new", "serviceTier" in p ? p.serviceTier : (process.env.FAKE_CONFIG_TIER ?? null));
            // A new thread starts with no usage.
            usageOf.delete("thr-new");
            return reply({ thread: { id: "thr-new" }, model: projectModel() ?? p.model ?? "gpt-test", serviceTier: tiers.get("thr-new") ?? "default" });
        case "thread/resume":
            if (process.env.FAKE_SLOW_RESUME) await Bun.sleep(Number(process.env.FAKE_SLOW_RESUME));
            if (String(p.threadId).startsWith("gone")) return fail(`thread not found: ${p.threadId}`);
            await startMcp(p.config);
            if (!tiers.has(p.threadId)) setTier(p.threadId, process.env.FAKE_THREAD_TIER ?? null);
            if ("serviceTier" in p) setTier(p.threadId, p.serviceTier);
            reply({ thread: { id: p.threadId }, model: projectModel() ?? p.model ?? "gpt-test", serviceTier: tiers.get(p.threadId) ?? "default" });
            // The thread's last usage again, with that earlier turn's id.
            repeatUsage(p.threadId);
            return;
        case "turn/start": {
            // Like Codex's: a value (or null) changes the thread's tier from this turn on; leaving it out keeps it.
            if ("serviceTier" in p) setTier(p.threadId, p.serviceTier);
            const turnId = `turn-${++turnSeq}`;
            if (process.env.FAKE_SLOW_TURN_START && turnSeq === 1) await Bun.sleep(Number(process.env.FAKE_SLOW_TURN_START));
            reply({ turn: { id: turnId, status: "inProgress" } });
            void runTurn(p.threadId, turnId, p);
            return;
        }
        case "turn/interrupt":
            if (current) {
                current.interrupted = true;
                current.wake?.();
            }
            return reply({});
        case "turn/steer":
            // FAKE_STEER_FAIL: the turn has already ended.
            if (process.env.FAKE_STEER_FAIL) return fail("no active turn to steer");
            return reply({ turnId: p.expectedTurnId });
        case "thread/compact/start": {
            reply({});
            // As 0.163 runs it: a turn, which first reports the usage as it was, then the compaction's.
            const turnId = `turn-${++turnSeq}`;
            notify("turn/started", { threadId: p.threadId, turn: { id: turnId, status: "inProgress" } });
            notify("item/started", { threadId: p.threadId, turnId, item: { type: "contextCompaction", id: `cc-${turnId}` } });
            repeatUsage(p.threadId, turnId);
            spend(p.threadId, turnId, tokens(400, 0, 40));
            notify("item/completed", { threadId: p.threadId, turnId, item: { type: "contextCompaction", id: `cc-${turnId}` } });
            notify("turn/completed", { threadId: p.threadId, turn: { id: turnId, status: "completed", error: null } });
            return;
        }
        default:
            return fail(`unknown method ${m.method}`);
    }
}

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
    buf += new TextDecoder().decode(chunk);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) void handle(JSON.parse(line));
    }
}
if (process.env.FAKE_HANG_INIT === "1") await new Promise(() => {});
