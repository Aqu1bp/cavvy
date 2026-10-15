// A stand-in for `codex app-server`: newline-delimited JSON-RPC with the
// requests, notifications and approval requests the harness uses. A turn
// says something, asks to run one command, and finishes. No network.
//
// FAKE_LOG            each line: what it was started with, and what it received
// FAKE_ACCOUNT        chatgpt (default) | apikey | none
// FAKE_DECLINE=1      offer "decline" among the command's availableDecisions

import { appendFileSync } from "fs";

const log = (o: unknown) => {
    if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\n");
};
const argv = process.argv.slice(2);
log({ argv, sawOpenAiKey: Boolean(process.env.OPENAI_API_KEY), sawApiKey: Boolean(process.env.ANTHROPIC_API_KEY) });
if (argv[0] !== "app-server") {
    console.error("fake codex: only app-server");
    process.exit(2);
}

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const pending = new Map<number, (r: any) => void>();
let serverSeq = 100;
let turnSeq = 0;
let current: { threadId: string; turnId: string; interrupted: boolean } | undefined;

function serverRequest(method: string, params: unknown): Promise<any> {
    const id = ++serverSeq;
    out({ id, method, params });
    return new Promise((resolve) => pending.set(id, resolve));
}

const notify = (method: string, params: unknown) => out({ method, params });

async function runTurn(threadId: string, turnId: string) {
    const t = { threadId, turnId, interrupted: false };
    current = t;
    notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
    notify("item/started", { threadId, turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text: "" } });
    notify("item/agentMessage/delta", { threadId, turnId, itemId: `msg-${turnId}`, delta: "Running it." });
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text: "Running it." } });
    const cmd = { type: "commandExecution", id: `cmd-${turnId}`, command: "/bin/bash -lc 'touch x'", cwd: process.cwd(), status: "inProgress", commandActions: [{ type: "unknown", command: "touch x" }], aggregatedOutput: null, exitCode: null };
    notify("item/started", { threadId, turnId, item: cmd });
    const r = await serverRequest("item/commandExecution/requestApproval", {
        threadId,
        turnId,
        itemId: cmd.id,
        command: cmd.command,
        cwd: cmd.cwd,
        commandActions: cmd.commandActions,
        availableDecisions: process.env.FAKE_DECLINE === "1" ? ["accept", "acceptForSession", "decline", "cancel"] : ["accept", "cancel"],
    });
    const decision = r?.decision;
    if (decision === "accept") notify("item/completed", { threadId, turnId, item: { ...cmd, status: "completed", exitCode: 0, aggregatedOutput: "ok\n" } });
    else notify("item/completed", { threadId, turnId, item: { ...cmd, status: "declined" } });
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: {}, last: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 5 }, modelContextWindow: 400000 } });
    if (decision === "cancel" || t.interrupted) {
        notify("turn/completed", { threadId, turn: { id: turnId, status: "interrupted", error: null } });
        return;
    }
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg2-${turnId}`, text: "Finished." } });
    notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", error: null } });
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
            return reply({ thread: { id: "thr-new" } });
        case "thread/resume":
            if (String(p.threadId).startsWith("gone")) return fail(`thread not found: ${p.threadId}`);
            return reply({ thread: { id: p.threadId } });
        case "turn/start": {
            const turnId = `turn-${++turnSeq}`;
            reply({ turn: { id: turnId, status: "inProgress" } });
            void runTurn(p.threadId, turnId);
            return;
        }
        case "turn/interrupt":
            if (current) current.interrupted = true;
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
