// A stand-in for `codex app-server`: newline-delimited JSON-RPC with the
// requests, notifications and approval requests the harness uses. A turn
// says something, does one thing (a command by default), and finishes. No
// network.
//
// Like the real CLI (checked against Codex 0.162.1), it asks for approval
// only where its approval policy says so: under "untrusted" for commands
// other than read-only ones and for edits outside a writable sandbox; under
// "on-request" with a workspace-write sandbox it runs commands itself; under
// "never" it asks for nothing. With FAKE_CODEX_TRUSTS=1 it trusts the project
// and loads .codex/config.toml (its model), unless -c projects=… marks the
// folder untrusted.
//
// FAKE_LOG            each line: what it was started with, and what it received
// FAKE_ACCOUNT        chatgpt (default) | apikey | none
// FAKE_DECLINE=1      offer "decline" among the command's availableDecisions
// FAKE_SCENARIO       cmd (default) | rename | perms | slow
// FAKE_HANG_INIT=1    never answers initialize, and ignores SIGTERM

import { appendFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";

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

const scenario = process.env.FAKE_SCENARIO ?? "cmd";
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const pending = new Map<number, (r: any) => void>();
let serverSeq = 100;
let turnSeq = 0;
let current: { threadId: string; turnId: string; interrupted: boolean; wake?: () => void } | undefined;

function serverRequest(method: string, params: unknown): Promise<any> {
    const id = ++serverSeq;
    out({ id, method, params });
    return new Promise((resolve) => pending.set(id, resolve));
}

const notify = (method: string, params: unknown) => out({ method, params });

async function runTurn(threadId: string, turnId: string, policy: { approvalPolicy?: string; sandboxPolicy?: { type?: string } }) {
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
    if (scenario === "rename") {
        const change = { type: "fileChange", id: `fc-${turnId}`, changes: [{ path: join(cwd, "a.txt"), kind: { type: "update", move_path: join(cwd, "secrets", "a.txt") }, diff: "" }], status: "inProgress" };
        notify("item/started", { threadId, turnId, item: change });
        decision = (await serverRequest("item/fileChange/requestApproval", { threadId, turnId, itemId: change.id, reason: null, grantRoot: null }))?.decision;
        notify("item/completed", { threadId, turnId, item: { ...change, status: decision === "accept" ? "completed" : "declined" } });
    } else if (scenario === "perms") {
        const r = await serverRequest("item/permissions/requestApproval", { threadId, turnId, itemId: `p-${turnId}`, cwd, reason: "needs to write there", permissions: { network: null, fileSystem: { read: null, write: [join(cwd, "secrets")] } } });
        log({ granted: r });
    } else {
        const cmd = { type: "commandExecution", id: `cmd-${turnId}`, command: "/bin/bash -lc 'touch x'", cwd, status: "inProgress", commandActions: [{ type: "unknown", command: "touch x" }], aggregatedOutput: null, exitCode: null };
        notify("item/started", { threadId, turnId, item: cmd });
        // Its own policy: in a workspace-write sandbox with on-request, or never, it just runs it.
        const runsItself = policy.approvalPolicy === "never" || (policy.approvalPolicy === "on-request" && policy.sandboxPolicy?.type === "workspaceWrite");
        if (!runsItself) {
            const r = await serverRequest("item/commandExecution/requestApproval", {
                threadId,
                turnId,
                itemId: cmd.id,
                command: cmd.command,
                cwd: cmd.cwd,
                commandActions: cmd.commandActions,
                availableDecisions: process.env.FAKE_DECLINE === "1" ? ["accept", "acceptForSession", "decline", "cancel"] : ["accept", "cancel"],
            });
            decision = r?.decision;
        }
        log({ ran: decision === "accept", command: "touch x" });
        if (decision === "accept") notify("item/completed", { threadId, turnId, item: { ...cmd, status: "completed", exitCode: 0, aggregatedOutput: "ok\n" } });
        else notify("item/completed", { threadId, turnId, item: { ...cmd, status: "declined" } });
    }
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: {}, last: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 5 }, modelContextWindow: 400000 } });
    if (decision === "cancel" || t.interrupted) return finish("interrupted");
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg2-${turnId}`, text: "Finished." } });
    finish("completed");
}

function handle(m: any) {
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
    switch (m.method) {
        case "initialize":
            if (process.env.FAKE_HANG_INIT === "1") return;
            return reply({ userAgent: "fake-codex/0.0.1", codexHome: "/tmp/none", platformFamily: "unix", platformOs: "linux" });
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
                    { id: "gpt-test", model: "gpt-test", displayName: "GPT Test", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], inputModalities: ["text", "image"] },
                ],
                nextCursor: null,
            });
        case "thread/start":
            return reply({ thread: { id: "thr-new" }, model: projectModel() ?? p.model ?? "gpt-test" });
        case "thread/resume":
            if (String(p.threadId).startsWith("gone")) return fail(`thread not found: ${p.threadId}`);
            return reply({ thread: { id: p.threadId }, model: projectModel() ?? p.model ?? "gpt-test" });
        case "turn/start": {
            const turnId = `turn-${++turnSeq}`;
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
        if (line) handle(JSON.parse(line));
    }
}
if (process.env.FAKE_HANG_INIT === "1") await new Promise(() => {});
