import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { AgentEvent } from "../src/agent/agent";

const iso = isolate();
const cwd = tempDir("codex-review-");
const log = join(cwd, "log.jsonl");
const bin = join(cwd, "codex");
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${join(import.meta.dir, "fixtures/fake-codex.ts")}" "$@"\n`);
chmodSync(bin, 0o755);
const { Agent } = await import("../src/agent/agent");
const { PermissionChecker } = await import("../src/permissions/checker");
const { saveAgentConfig } = await import("../src/providers/registry");
const { clientFor, forgetClient } = await import("../src/providers/models");
const { UiLog, replay, agentsFromTurns } = await import("../src/server/history");
const { Engine } = await import("../src/server/engine");

beforeEach(() => {
    process.env.FAKE_LOG = log;
    process.env.FAKE_REVIEW_APPROVE = "1";
    delete process.env.FAKE_REVIEW_NO_COMPLETED;
    delete process.env.FAKE_REVIEW_TIMING;
    delete process.env.FAKE_REVIEW_MULTIPLE;
    delete process.env.FAKE_SCENARIO;
    delete process.env.FAKE_COMMAND;
    delete process.env.FAKE_REJECT_CONFIG;
    rmSync(log, { force: true });
    saveAgentConfig("codex", { path: bin });
    forgetClient("codex");
});
afterAll(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    iso.cleanup();
    rmSync(cwd, { recursive: true, force: true });
});

async function run(mode: import("../src/permissions/modes").PermissionMode = "auto") {
    const engine = new Engine({ listModels: async () => [] });
    const runtime = await engine.createSession(cwd, { mode });
    await runtime.ready;
    const session = runtime.session;
    session.meta.system = "Test";
    session.setTitle("Codex review test");
    const events: AgentEvent[] = [];
    const settings = { delegation: false };
    const model = { provider: "codex", id: "test" };
    const agent = new Agent({ session, model, client: await clientFor("codex"), settings: () => settings, checker: new PermissionChecker(() => settings, cwd), tools: [], mode: { get: () => mode, set() {} }, toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() }, host: { emit: (e) => { events.push(e); (runtime as any).onEvent(e); runtime.flush(); }, ui: {} } });
    if (process.env.FAKE_REJECT_CONFIG === "1") (agent as any).orchestrator = () => ({ name: "harness", url: "unused", authorization: "test", tools: [], instructions: "Delegation instructions", toolTimeoutSec: 1 });
    Object.assign(runtime, { model, agent });
    await runtime.startTurn("Run the local tests");
    const snapshot = runtime.snapshot();
    await engine.stop();
    let next = 0;
    const ui = new UiLog(session.path, session.meta.id);
    const reopened = replay({ segments: [{ messages: session.messages }], current: session.messages, ui, meta: (c) => ({ title: c.name }), newId: () => `r${++next}` });
    const records = readFileSync(join(session.path, "..", "ui", `${session.meta.id}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    return { events, snapshot, reopened, records, agents: agentsFromTurns(reopened, undefined, ui.agents) };
}

test("completed reviewer approval patches the command without a prompt or prose notice", async () => {
    const { events, snapshot, records } = await run();
    const approvals = events.filter((e) => e.type === "tool_approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ id: "cmd-turn-1", sandboxed: false, reason: "Codex's reviewer (risk: low): The user requested this local test." });
    expect(events.filter((e) => e.type === "notice" && e.message.includes("approved"))).toEqual([]);
    const block = snapshot.turns.flatMap((t) => t.blocks).find((b) => b.t === "tool" && b.id === approvals[0]!.id);
    expect(block).toMatchObject({ approval: approvals[0]!.reason });
    const steps = records.filter((r) => r.t === "step" && r.block?.id === approvals[0]!.id);
    expect(steps[0].block.approval).toBeUndefined();
    expect(steps.some((r) => r.block.approval === approvals[0]!.reason)).toBe(true);
    expect(records.filter((r) => r.t === "tool").every((r) => r.block === undefined)).toBe(true);
});

test("a secret in the reviewer's reason is redacted, even one that ends in a space", async () => {
    const { registerSecret, unregisterSecret } = await import("../src/util/redact");
    const secret = "q7Zr2LmX9wPk4sVt ";
    registerSecret(secret, "REVIEW_TOKEN");
    process.env.FAKE_REVIEW_RATIONALE = `It runs with ${secret}`;
    try {
        const { events, records } = await run();
        const approval = events.find((e) => e.type === "tool_approved");
        expect(approval).toMatchObject({ reason: "Codex's reviewer (risk: low): It runs with [REDACTED REVIEW_TOKEN]" });
        expect(JSON.stringify(records)).not.toContain(secret.trim());
    } finally {
        delete process.env.FAKE_REVIEW_RATIONALE;
        unregisterSecret(secret);
    }
});

test("approved guardian warnings stay silent without creating synthetic tool records", async () => {
    process.env.FAKE_REVIEW_NO_COMPLETED = "1";
    const { events, reopened } = await run();
    expect(events.filter((e) => e.type === "tool_approved")).toEqual([]);
    expect(events.filter((e) => e.type === "notice" && e.message.includes("approved"))).toEqual([]);
    expect(reopened.flatMap((t) => t.blocks).filter((b) => b.t === "tool")).toHaveLength(1);
});

for (const mode of ["auto", "default", "acceptEdits", "plan", "bypassPermissions"] as const) test(`${mode}: listener guidance is in the thread's instructions, true in every mode (the mode can change later)`, async () => {
    process.env.FAKE_COMMAND = "pwd";
    await run(mode);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).flatMap((l) => l.received ? [l.received] : []);
    const turn = calls.find((m) => m.method === "turn/start").params;
    const thread = calls.find((m) => m.method === "thread/start").params;
    const instructions = thread.developerInstructions ?? "";
    if (mode !== "bypassPermissions") expect(turn.sandboxPolicy.networkAccess).toBe(false);
    expect(instructions).toContain("blocks local listeners too");
    expect(instructions).toContain("ask to run that command outside the sandbox");
    expect(turn.input[0].text).not.toContain("local listeners");
    expect(instructions).not.toContain("Keep outbound network access disabled");
});

for (const timing of ["before", "after"]) test(`review approval survives step replay when received ${timing} the command`, async () => {
    process.env.FAKE_REVIEW_TIMING = timing;
    const { events, reopened, records } = await run();
    const approval = events.find((e) => e.type === "tool_approved");
    expect(approval).toBeDefined();
    const blocks = reopened.flatMap((t) => t.blocks).filter((b) => b.t === "tool");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ id: approval!.id, approval: approval!.reason, status: "ok", input: { command: "touch x" } });
    expect(records.some((r) => r.t === "step" && r.block?.approval === approval!.reason)).toBe(true);
});

test("repeated reviews replace the verdict without accumulating duplicates", async () => {
    process.env.FAKE_REVIEW_MULTIPLE = "1";
    const { reopened } = await run();
    const blocks = reopened.flatMap((t) => t.blocks).filter((b) => b.t === "tool");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ approval: "Codex's reviewer (risk: medium): The user also requested cleanup." });
});

test("native Codex sub-agent approvals survive in their agent records", async () => {
    process.env.FAKE_SCENARIO = "subagent";
    const { events, snapshot, agents, records } = await run();
    const approval = events.find((e) => e.type === "subagent" && e.event.type === "tool_approved");
    expect(approval).toBeDefined();
    const live = snapshot.agents.flatMap((a) => a.blocks).find((b) => b.t === "tool" && b.approval);
    expect(live).toBeDefined();
    expect(live!.approval).toContain("The delegated task needs this command.");
    expect(agents.flatMap((a) => a.blocks)).toContainEqual(live);
    expect(records.some((r) => r.t === "agent" && r.block?.approval === live!.approval)).toBe(true);
});

test("listener instructions survive rejection of the delegation configuration", async () => {
    process.env.FAKE_REJECT_CONFIG = "1";
    await run();
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).flatMap((l) => l.received ? [l.received] : []);
    const threads = calls.filter((m) => m.method === "thread/start");
    expect(threads).toHaveLength(2);
    expect(threads[1].params.config).toBeUndefined();
    expect(threads[1].params.developerInstructions).toContain("blocks local listeners too");
    expect(threads[1].params.developerInstructions).not.toContain("Delegation instructions");
});
