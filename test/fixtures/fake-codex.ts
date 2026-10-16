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
// FAKE_SCENARIO       cmd (default) | rename | perms | slow | mcp
// FAKE_CODEX_SCENARIO  overrides FAKE_SCENARIO here (a fake Claude Code and Codex in one test)
// FAKE_REJECT_CONFIG=1  thread/start and thread/resume fail when given config, like a Codex that can't parse it
// FAKE_HANG_INIT=1    never answers initialize, and ignores SIGTERM
// FAKE_PERMS          the permissions the "perms" scenario asks for (JSON)
// FAKE_SLOW_RESUME, FAKE_SLOW_TURN_START  milliseconds before answering thread/resume, turn/start
// FAKE_MCP_CALLS      the "mcp" scenario's calls to servers from the thread's config: [{ server?, tool, args }]
// FAKE_USER_MCP       config/read's mcp_servers: the user's own servers (JSON); FAKE_NO_CONFIG_READ=1 fails config/read

import { appendFileSync, existsSync, readFileSync } from "fs";
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
let current: { threadId: string; turnId: string; interrupted: boolean; wake?: () => void } | undefined;
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
    notify("item/started", { threadId, turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text: "" } });
    notify("item/agentMessage/delta", { threadId, turnId, itemId: `msg-${turnId}`, delta: "Running it." });
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text: "Running it." } });
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
    if (scenario === "rename") {
        const change = { type: "fileChange", id: `fc-${turnId}`, changes: [{ path: join(cwd, "a.txt"), kind: { type: "update", move_path: join(cwd, "secrets", "a.txt") }, diff: "" }], status: "inProgress" };
        notify("item/started", { threadId, turnId, item: change });
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
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: {}, last: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 5 }, modelContextWindow: 400000 } });
    if (decision === "cancel" || t.interrupted) return finish("interrupted");
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg2-${turnId}`, text: "Finished." } });
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
                    { serviceTiers: [{ id: "fast", name: "Fast", description: "Fast service" }], id: "gpt-test", model: "gpt-test", displayName: "GPT Test", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], inputModalities: ["text", "image"] },
                ],
                nextCursor: null,
            });
        case "thread/start":
            await startMcp(p.config);
            return reply({ thread: { id: "thr-new" }, model: projectModel() ?? p.model ?? "gpt-test" });
        case "thread/resume":
            if (process.env.FAKE_SLOW_RESUME) await Bun.sleep(Number(process.env.FAKE_SLOW_RESUME));
            if (String(p.threadId).startsWith("gone")) return fail(`thread not found: ${p.threadId}`);
            await startMcp(p.config);
            return reply({ thread: { id: p.threadId }, model: projectModel() ?? p.model ?? "gpt-test" });
        case "turn/start": {
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
        case "thread/compact/start":
            reply({});
            notify("thread/compacted", { threadId: p.threadId });
            return;
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
