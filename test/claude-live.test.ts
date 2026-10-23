// Claude Code on the live CLI layer (#219 PR 4), through the real Agent loop with
// the fake `claude` (test/fixtures/fake-claude.ts), which, like Claude Code 2.1.304,
// stays up between turns. One process per session; a turn ends at the result that
// answers its prompt; background work outlives it and reports in a wake turn;
// Esc stops only the answer. Nothing here runs the real CLI.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { cleanup } = isolate();
const registry = await import("../src/providers/registry");
const { clientFor, forgetClient } = await import("../src/providers/models");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const { SessionBackground } = await import("../src/agent/background");
const { liveTiming, CARRIER_COMMAND } = await import("../src/backends/claude-live");
const { stopTiming } = await import("../src/backends/cli");
const trust = await import("../src/config/trust");

type AgentEvent = import("../src/agent/agent").AgentEvent;
type PermissionRequest = import("../src/agent/agent").PermissionRequest;
type PermissionResponse = import("../src/agent/agent").PermissionResponse;
type BackendWake = import("../src/backends/types").BackendWake;
type ClaudeCodeBackend = import("../src/backends/claude-code").ClaudeCodeBackend;

const bin = tempDir("fake-claude-live-");
const LOG = join(bin, "log.jsonl");
const claudeBin = join(bin, "claude");
writeFileSync(claudeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-claude.ts")}" "$@"\n`);
chmodSync(claudeBin, 0o755);

const timing = { ...liveTiming };
const interruptMs = stopTiming.interruptMs;

afterAll(() => {
    cleanup();
    rmSync(bin, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

let cwd: string;
beforeEach(() => {
    const real = tempDir("claude-live-proj-");
    cwd = `${real}-link`;
    symlinkSync(real, cwd);
    rmSync(LOG, { force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    process.env.FAKE_LOG = LOG;
    registry.saveAgentConfig("claude-code", { path: claudeBin });
    forgetClient("claude-code");
});

afterEach(async () => {
    Object.assign(liveTiming, timing);
    stopTiming.interruptMs = interruptMs;
    const c = (await clientFor("claude-code")) as ClaudeCodeBackend;
    await c.shutdown();
});

function logLines(): any[] {
    return existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}
const starts = () => logLines().filter((l) => l.argv && l.argv[0] !== "auth");
const received = () => logLines().flatMap((l) => (l.received ? [l.received] : []));
const controls = (subtype: string) => received().filter((m) => m.type === "control_request" && m.request?.subtype === subtype).map((m) => m.request);
const userTexts = () => received().flatMap((m) => (m.type === "user" ? m.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text as string) : []));
const notices = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "notice" ? [`${e.level}: ${e.message}`] : []));
const texts = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "assistant" ? e.message.content.map((c) => (c.type === "text" ? c.text : "")) : []));

async function until(cond: () => boolean, ms = 8000, what = "condition") {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(20);
    }
}

interface Opts {
    settings?: any;
    ask?: (req: PermissionRequest) => PermissionResponse | Promise<PermissionResponse>;
    /** No wake handler: the run takes the CLI's report turns itself (as -p does). */
    oneShot?: boolean;
    session?: InstanceType<typeof Session>;
    queued?: string[][];
}

async function makeAgent(o: Opts = {}) {
    const settings = o.settings ?? {};
    const events: AgentEvent[] = [];
    const wakes: BackendWake[] = [];
    let mode: import("../src/permissions/modes").PermissionMode = "default";
    trust.trustForSession(cwd);
    const client = await clientFor("claude-code");
    const session = o.session ?? Session.create(cwd, { persist: false });
    const background = new SessionBackground();
    const queued = [...(o.queued ?? [])];
    const agent = new Agent({
        session,
        model: { provider: "claude-code", id: "default" },
        client,
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map(), background },
        host: {
            emit: (e) => events.push(e),
            drainQueued: () => queued.shift() ?? [],
            ui: {},
            askPermission: o.ask ? async (req) => o.ask!(req) : o.oneShot ? undefined : async () => ({ allow: true }),
            ...(o.oneShot ? {} : { wake: (w: BackendWake) => void wakes.push(w) }),
        },
    });
    const run = (text: string, signal = new AbortController().signal) => agent.run([{ type: "text", text }], { signal });
    /** Adopt a wake as the runtime does: a wake turn that takes the CLI's own turn. */
    const adopt = (w: BackendWake, signal = new AbortController().signal) => agent.run([{ type: "text", text: w.label ?? "reported back" }], { signal, kind: w.prompt ? "prompt" : "wake", adopt: w });
    return { agent, events, wakes, session, run, adopt, background, client: client as ClaudeCodeBackend, setMode: (m: typeof mode) => (mode = m), queued };
}

describe("final review, blocker 3: a task's label is redacted whole, then cut", () => {
    test("a secret across the 300th character of a sub-agent's description leaves no piece of itself in the label", async () => {
        const { registerSecret, unregisterSecret } = await import("../src/util/redact");
        const secret = "zz9-PLURAL-Z-ALPHA-6tb2kq8wqe";
        registerSecret(secret, "test key");
        try {
            process.env.FAKE_SCENARIO = "agent-background";
            process.env.FAKE_AGENT_DESC = `${"x".repeat(290)} ${secret}`;
            const { run, agent } = await makeAgent();
            expect(await run("map auth in the background")).toBe("done");
            const task = agent.backgroundTasks().find((t) => t.id === "agent-1");
            expect(task?.label.startsWith("xxxx")).toBe(true);
            expect(task?.label).not.toContain("zz9-PLURA");
        } finally {
            unregisterSecret(secret);
        }
    });
});

describe("a prompt with Harness's catch-up (after a model switch) goes as the user's", () => {
    test("not synthetic; the catch-up is a block of its own before the user's words, the last block", async () => {
        const session = Session.create(cwd, { persist: false });
        session.push({ role: "user", content: [{ type: "text", text: "earlier, with another model" }], meta: { kind: "prompt" } });
        session.push({ role: "assistant", content: [{ type: "text", text: "a reply quoting @secrets.txt" }] });
        const { run } = await makeAgent({ session });
        expect(await run("go on")).toBe("done");
        const first = received().find((m) => m.type === "user");
        // Synthetic, Claude Code 2.1.304 records it as not the user's, and the model may refuse what they asked.
        expect(first.isSynthetic).toBeUndefined();
        const blocks = first.message.content.filter((b: any) => b.type === "text").map((b: any) => b.text);
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toContain("conversation-so-far");
        expect(blocks[0]).toContain("@secrets.txt");
        expect(blocks[1]).toBe("go on");
        expect(starts()).toHaveLength(1);
    });
});

describe("one Claude Code process per session", () => {
    test("serves two turns on one process (the same pid)", async () => {
        const { run, events } = await makeAgent();
        process.env.FAKE_SCENARIO = "silent";
        expect(await run("first")).toBe("done");
        expect(await run("second")).toBe("done");
        const s = starts();
        expect(s.length).toBe(1);
        expect(typeof s[0].pid).toBe("number");
        expect(userTexts().filter((t) => t === "first" || t === "second")).toEqual(["first", "second"]);
        expect(notices(events).some((n) => /without a reply/.test(n))).toBe(true);
    });

    test("a turn ends at its answer while a background sub-agent runs, and its report comes as a wake turn", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_BACKGROUND_MS = "400";
        const { run, events, wakes, adopt, background, agent } = await makeAgent();
        const t0 = Date.now();
        expect(await run("map auth")).toBe("done");
        // Over at its answer, not after the sub-agent.
        expect(Date.now() - t0).toBeLessThan(2500);
        expect(texts(events)).toContain("All done.");
        expect(agent.backgroundTasks().filter((t) => t.status === "running").map((t) => t.kind)).toEqual(["agent"]);
        await until(() => wakes.length > 0, 5000, "a wake");
        expect(wakes[0]).toMatchObject({ provider: "claude-code" });
        expect(wakes[0]!.label).toMatch(/Map auth/);
        expect(await adopt(wakes[0]!)).toBe("done");
        expect(texts(events)).toContain("The explorer reported back: sign-in strategies are registered in one list.");
        expect(background.list().find((t) => t.kind === "agent")?.status).toBe("done");
        expect(starts().length).toBe(1);
    });

    test("with agentCli.liveSessions off, a turn waits for its background work on a process of its own", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_BACKGROUND_MS = "200";
        const { run, events, wakes } = await makeAgent({ settings: { agentCli: { liveSessions: false } } });
        expect(await run("map auth")).toBe("done");
        // The report is in the turn itself, and the process is gone.
        expect(texts(events)).toContain("The explorer reported back: sign-in strategies are registered in one list.");
        expect(wakes).toEqual([]);
        expect(await run("again")).toBe("done");
        expect(starts().length).toBe(2);
    });

    test("review #295 P1-5: live sessions turned off with a wake waiting: adopting it still takes its report from the live process", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_BACKGROUND_MS = "200";
        const settings: any = {};
        const { run, events, wakes, adopt } = await makeAgent({ settings });
        expect(await run("map auth")).toBe("done");
        await until(() => wakes.length > 0, 5000, "a wake");
        settings.agentCli = { liveSessions: false };
        expect(await adopt(wakes[0]!)).toBe("done");
        expect(texts(events)).toContain("The explorer reported back: sign-in strategies are registered in one list.");
        expect(starts().length).toBe(1);
    });

    test("live sessions turned off with a process kept for the session: it goes (its background sub-agent stopped with it) before the per-run process runs", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_BACKGROUND_MS = "20000";
        const settings: any = {};
        const { run, events, background } = await makeAgent({ settings });
        expect(await run("map auth")).toBe("done");
        const pid = starts()[0].pid as number;
        expect(background.list().find((t) => t.kind === "agent")?.status).toBe("running");
        settings.agentCli = { liveSessions: false };
        process.env.FAKE_SCENARIO = "silent";
        expect(await run("again")).toBe("done");
        expect(() => process.kill(pid, 0)).toThrow();
        expect(background.list().find((t) => t.kind === "agent")).toMatchObject({ status: "stopped", withProcess: true });
        expect(notices(events).join("\n")).toContain("agentCli.liveSessions");
    });
});

/** Start a turn and wait until the fake is in its long-running step (a command, or mid-answer). */
async function startHanging(run: (t: string, s?: AbortSignal) => Promise<string>, events: AgentEvent[], prompt = "go") {
    const ac = new AbortController();
    const done = run(prompt, ac.signal);
    await until(() => events.some((e) => (e.type === "tool_start" && e.call.id === "toolu_h") || (e.type === "text" && e.text.startsWith("Counting"))), 8000, "the turn's long step");
    return { ac, done };
}

describe("Esc stops only the answer", () => {
    test("#203: Esc on a session with a running background Agent leaves it running, and its report still arrives", async () => {
        process.env.FAKE_SCENARIO = "agent-background-hang";
        process.env.FAKE_BACKGROUND_MS = "700";
        const { run, events, wakes, adopt, agent } = await makeAgent();
        const { ac, done } = await startHanging(run, events);
        ac.abort();
        expect(await done).toBe("aborted");
        // The stop went as send-now with a carrier, never as a plain interrupt (which stops background sub-agents).
        const sendNow = controls("interrupt");
        expect(sendNow.length).toBe(1);
        expect(sendNow[0]).toMatchObject({ send_now: true });
        const carrier = received().find((m) => m.type === "user" && m.uuid === sendNow[0].message_uuid);
        expect(carrier.message.content[0].text).toBe(CARRIER_COMMAND);
        expect(agent.backgroundTasks().find((t) => t.kind === "agent")?.status).toBe("running");
        await until(() => wakes.length > 0, 5000, "the sub-agent's report");
        expect(await adopt(wakes[0]!)).toBe("done");
        expect(texts(events)).toContain("The explorer reported back: sign-in strategies are registered in one list.");
        expect(agent.backgroundTasks().find((t) => t.kind === "agent")?.status).toBe("done");
        // The carrier's own turn showed nothing.
        expect(JSON.stringify(events)).not.toContain("Usage: /effort");
        expect(starts().length).toBe(1);
    });

    test("Esc during a command, with nothing in the background: a plain interrupt, and the process stays", async () => {
        process.env.FAKE_SCENARIO = "hang";
        process.env.FAKE_SECOND_SCENARIO = "silent";
        const { run, events } = await makeAgent();
        const { ac, done } = await startHanging(run, events);
        ac.abort();
        expect(await done).toBe("aborted");
        expect(controls("interrupt")).toEqual([{ subtype: "interrupt" }]);
        expect(await run("again")).toBe("done");
        expect(starts().length).toBe(1);
    });

    test("Esc while it streams its answer stops it, and the process stays", async () => {
        process.env.FAKE_SCENARIO = "stream-hang";
        process.env.FAKE_SECOND_SCENARIO = "silent";
        const { run, events } = await makeAgent();
        const { ac, done } = await startHanging(run, events);
        ac.abort();
        expect(await done).toBe("aborted");
        expect(controls("interrupt").length).toBe(1);
        expect(await run("again")).toBe("done");
        expect(starts().length).toBe(1);
    });

    for (const scenario of ["bg-shell-hang", "bg-monitor-hang"]) {
        test(`Esc with a background ${scenario.includes("shell") ? "command" : "monitor"} running: a plain interrupt, which it survives`, async () => {
            process.env.FAKE_SCENARIO = scenario;
            const { run, events, agent } = await makeAgent();
            const { ac, done } = await startHanging(run, events);
            ac.abort();
            expect(await done).toBe("aborted");
            expect(controls("interrupt")).toEqual([{ subtype: "interrupt" }]);
            expect(agent.backgroundTasks().filter((t) => t.status === "running").map((t) => t.kind)).toEqual([scenario.includes("shell") ? "shell" : "monitor"]);
        });
    }

    test("Esc with a background Agent on a Claude Code without send-now: a plain interrupt, a warning, and the sub-agent shown as stopped", async () => {
        process.env.FAKE_SCENARIO = "agent-background-hang";
        process.env.FAKE_BACKGROUND_MS = "5000";
        process.env.FAKE_NO_SEND_NOW = "1";
        const { run, events, agent } = await makeAgent();
        const { ac, done } = await startHanging(run, events);
        ac.abort();
        expect(await done).toBe("aborted");
        expect(controls("interrupt")).toEqual([{ subtype: "interrupt" }]);
        expect(notices(events)).toContain("warn: Stopped 1 background sub-agent (Map auth) when you pressed Esc (this Claude Code version can't stop a turn without them). It won't report back. Background commands and monitors keep running.");
        await until(() => agent.backgroundTasks().find((t) => t.kind === "agent")?.status === "stopped", 3000, "the sub-agent stopped");
        // The user's stop: its end is no news to them.
        expect(agent.backgroundTasks().find((t) => t.kind === "agent")).toMatchObject({ status: "stopped", byUser: true });
    });

    test("Esc while nothing runs sends nothing, and the background Agent keeps running", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_BACKGROUND_MS = "800";
        const { run, wakes, agent } = await makeAgent();
        const ac = new AbortController();
        expect(await run("map auth", ac.signal)).toBe("done");
        // The turn is over: Esc now (its signal, late) is nothing to Claude Code.
        ac.abort();
        await Bun.sleep(100);
        expect(controls("interrupt")).toEqual([]);
        expect(agent.backgroundTasks().find((t) => t.kind === "agent")?.status).toBe("running");
        await until(() => wakes.length > 0, 5000, "the report");
    });

    test("Esc during a wake turn stops that turn only; the process stays", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_BACKGROUND_MS = "100";
        process.env.FAKE_WAKE_HANG = "1";
        process.env.FAKE_SECOND_SCENARIO = "silent";
        const { run, events, wakes, adopt } = await makeAgent();
        expect(await run("map auth")).toBe("done");
        await until(() => wakes.length > 0, 5000, "the wake");
        const ac = new AbortController();
        const turn = adopt(wakes[0]!, ac.signal);
        await until(() => events.some((e) => e.type === "tool_start" && e.call.id === "toolu_wake_hang"), 5000, "the wake's command");
        ac.abort();
        expect(await turn).toBe("aborted");
        expect(controls("interrupt")).toEqual([{ subtype: "interrupt" }]);
        expect(await run("again")).toBe("done");
        expect(starts().length).toBe(1);
    });

    test("Esc with a message the user sent meanwhile sends it at once in place of the turn, and its turn comes back as theirs", async () => {
        process.env.FAKE_SCENARIO = "agent-background-hang";
        process.env.FAKE_SECOND_SCENARIO = "silent";
        process.env.FAKE_BACKGROUND_MS = "3000";
        const { run, events, wakes, adopt, agent } = await makeAgent();
        const { ac, done } = await startHanging(run, events);
        expect(agent.sendNow("Use the other branch instead")).toBe(true);
        ac.abort();
        expect(await done).toBe("aborted");
        const req = controls("interrupt");
        expect(req).toEqual([expect.objectContaining({ send_now: true })]);
        expect(received().find((m) => m.type === "user" && m.uuid === req[0].message_uuid).message.content[0].text).toBe("Use the other branch instead");
        await until(() => wakes.length > 0, 5000, "the follow-up's turn");
        expect(wakes[0]).toMatchObject({ prompt: true, label: "Use the other branch instead" });
        expect(await adopt(wakes[0]!)).toBe("done");
        expect(agent.backgroundTasks().find((t) => t.kind === "agent")?.status).toBe("running");
    });

    test("review #295 P1-2: with UserPromptSubmit hooks, Esc doesn't send a queued message at once (its hooks haven't admitted it)", async () => {
        process.env.FAKE_SCENARIO = "agent-background-hang";
        process.env.FAKE_BACKGROUND_MS = "3000";
        const settings = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "true" }] }] } };
        const { run, events, agent } = await makeAgent({ settings });
        const { ac, done } = await startHanging(run, events);
        expect(agent.sendNow("Use the other branch instead")).toBe(false);
        ac.abort();
        expect(await done).toBe("aborted");
        expect(userTexts()).not.toContain("Use the other branch instead");
    });

    test("review #295 P1-3: a second Esc while the first one's stop is under way doesn't take another message (it would never be sent)", async () => {
        process.env.FAKE_SCENARIO = "agent-background-hang";
        process.env.FAKE_BACKGROUND_MS = "3000";
        const { run, events, agent } = await makeAgent();
        const { ac, done } = await startHanging(run, events);
        expect(agent.sendNow("first")).toBe(true);
        ac.abort();
        expect(agent.sendNow("second")).toBe(false);
        expect(await done).toBe("aborted");
    });

    test("review #295 P2-8: a background sub-agent that ends during Esc's hidden carrier turn: its report and end still reach the session", async () => {
        process.env.FAKE_SCENARIO = "agent-background-hang";
        process.env.FAKE_BACKGROUND_MS = "60000";
        process.env.FAKE_CARRIER_AGENT_ENDS = "1";
        const { run, events, agent } = await makeAgent();
        const { ac, done } = await startHanging(run, events);
        const before = events.length;
        ac.abort();
        expect(await done).toBe("aborted");
        await until(() => agent.backgroundTasks().find((t) => t.kind === "agent")?.status === "done", 5000, "the sub-agent's end");
        await Bun.sleep(100);
        const after = events.slice(before);
        expect(after.some((e) => e.type === "subagent" && e.event.type === "text" && e.event.text.includes("sign-in strategies"))).toBe(true);
        expect(after.some((e) => e.type === "subagent" && e.event.type === "turn_end")).toBe(true);
        expect(after.some((e) => e.type === "tool_end" && e.call.id === "toolu_agent")).toBe(true);
    });

    test("an interrupt Claude Code doesn't answer ends the turn here, keeps the process, and says how to restart it", async () => {
        process.env.FAKE_SCENARIO = "hang";
        process.env.FAKE_IGNORE_INTERRUPT = "1";
        stopTiming.interruptMs = 300;
        const { run, events, client, session } = await makeAgent();
        const { ac, done } = await startHanging(run, events);
        ac.abort();
        expect(await done).toBe("aborted");
        expect(notices(events).join("\n")).toMatch(/didn't answer the stop in time.*\/tasks restart/);
        const live = client.live.get(session.meta.id)!;
        expect(live.state).not.toBe("dead");
        expect(live.unresponsive).toBe(true);
        await client.restart(session.meta.id);
        expect(live.state).toBe("dead");
    });
});

describe("background work across turns", () => {
    test("stop one task (stop_task, confirmed by its notification), and stop all", async () => {
        process.env.FAKE_SCENARIO = "two-shells";
        process.env.FAKE_SHELL_MS = "60000";
        const { run, agent } = await makeAgent();
        expect(await run("start two")).toBe("done");
        const running = () => agent.backgroundTasks().filter((t) => t.status === "running").map((t) => t.id).sort();
        expect(running()).toEqual(["background-1", "background-2"]);
        expect(await agent.stopBackground(["background-1"])).toEqual({ "background-1": "stopped" });
        expect(controls("stop_task")).toEqual([{ subtype: "stop_task", task_id: "background-1" }]);
        expect(running()).toEqual(["background-2"]);
        expect(await agent.stopBackground()).toEqual({ "background-2": "stopped" });
        expect(running()).toEqual([]);
        expect(agent.backgroundTasks().every((t) => t.status === "stopped")).toBe(true);
    });

    test("a stop Claude Code says succeeded but never confirms (an unknown id) times out, not 'stopped'", async () => {
        process.env.FAKE_SCENARIO = "two-shells";
        process.env.FAKE_SHELL_MS = "60000";
        process.env.FAKE_STOP_TASK = "hang";
        liveTiming.stopConfirmMs = 200;
        const { run, agent } = await makeAgent();
        expect(await run("start two")).toBe("done");
        expect(await agent.stopBackground(["background-1"])).toEqual({ "background-1": "timeout" });
    });

    test("a stop racing the task's own completion settles as stopped, and the report still comes", async () => {
        process.env.FAKE_SCENARIO = "two-shells";
        process.env.FAKE_SHELL_MS = "300";
        const { run, agent, wakes } = await makeAgent();
        expect(await run("start two")).toBe("done");
        await Bun.sleep(290);
        const r = await agent.stopBackground(["background-1"]);
        expect(r["background-1"]).toBe("stopped");
        await until(() => agent.backgroundTasks().every((t) => t.status !== "running"), 3000, "both ended");
        await until(() => wakes.length >= 1, 3000, "a report");
    });

    test("a task that finishes by itself as its stop goes out: the stop is refused, its own end stands, and its report comes", async () => {
        process.env.FAKE_SCENARIO = "two-shells";
        process.env.FAKE_SHELL_MS = "60000";
        process.env.FAKE_STOP_TASK = "ends-first";
        const { run, agent, wakes } = await makeAgent();
        expect(await run("start two")).toBe("done");
        // Refused because it had ended by itself: "ended" (#282 round 3).
        expect(await agent.stopBackground(["background-1"])).toEqual({ "background-1": "ended" });
        expect(agent.backgroundTasks().find((t) => t.id === "background-1")).toMatchObject({ status: "done" });
        expect(agent.backgroundTasks().find((t) => t.id === "background-1")?.byUser).toBeUndefined();
        await until(() => wakes.length > 0, 5000, "its report");
        expect(wakes[0]!.label).toBe("Background command finished: Check background-1");
    });

    test("review #295 P2-6: a task that fails by itself as its stop goes out, the stop answered success: its failure stands (ended, not the user's)", async () => {
        process.env.FAKE_SCENARIO = "two-shells";
        process.env.FAKE_SHELL_MS = "60000";
        process.env.FAKE_STOP_TASK = "fail-first";
        const { run, agent } = await makeAgent();
        expect(await run("start two")).toBe("done");
        expect(await agent.stopBackground(["background-1"])).toEqual({ "background-1": "ended" });
        expect(agent.backgroundTasks().find((t) => t.id === "background-1")).toMatchObject({ status: "failed" });
        expect(agent.backgroundTasks().find((t) => t.id === "background-1")?.byUser).toBeUndefined();
    });

    test("a sub-agent said to be done, then to have failed: the session follows the revised outcome", async () => {
        process.env.FAKE_SCENARIO = "agent-fails-later";
        const { run, agent, background } = await makeAgent();
        const seen: string[] = [];
        background.onChange(() => {
            const t = agent.backgroundTasks().find((x) => x.kind === "agent");
            if (t && seen.at(-1) !== t.status) seen.push(t.status);
        });
        expect(await run("map auth in the background")).toBe("done");
        await until(() => agent.backgroundTasks().find((t) => t.kind === "agent")?.status === "failed", 3000, "the revised outcome");
        expect(seen.slice(-2)).toEqual(["done", "failed"]);
    });

    test("two wakes at once: each is its own turn, adopted in order", async () => {
        process.env.FAKE_SCENARIO = "two-shells";
        process.env.FAKE_SHELL_MS = "100";
        const { run, wakes, adopt, events } = await makeAgent();
        expect(await run("start two")).toBe("done");
        await until(() => wakes.length === 2, 5000, "two wakes");
        expect(wakes.map((w) => w.label)).toEqual(["Background command finished: Check background-1", "Background command finished: Check background-2"]);
        expect(await adopt(wakes[0]!)).toBe("done");
        expect(await adopt(wakes[1]!)).toBe("done");
        expect(texts(events)).toEqual(expect.arrayContaining(["Check background-1: done.", "Check background-2: done."]));
        expect(starts().length).toBe(1);
    });

    test("two reports due at once: the session isn't quiet (nor reapable) between the first's turn and the second's", async () => {
        process.env.FAKE_SCENARIO = "two-shells";
        process.env.FAKE_SHELL_MS = "100";
        const { run, wakes, client, session } = await makeAgent();
        expect(await run("start two")).toBe("done");
        const live = client.live.get(session.meta.id)!;
        let wakesAtQuiet = -1;
        const quiet = live.whenQuiet().then(() => (wakesAtQuiet = wakes.length));
        await until(() => wakes.length === 2, 5000, "two wakes");
        await quiet;
        expect(wakesAtQuiet).toBe(2);
    });

    test("a wake while the user sends a prompt: each turn gets its own output", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_SECOND_SCENARIO = "silent";
        process.env.FAKE_BACKGROUND_MS = "100";
        const { run, wakes, adopt, events } = await makeAgent();
        expect(await run("map auth")).toBe("done");
        await until(() => wakes.length > 0, 5000, "the wake");
        // The user's prompt goes before the wake is adopted (the runtime was busy, say).
        const mark = events.length;
        expect(await run("next")).toBe("done");
        expect(texts(events.slice(mark))).not.toContain("The explorer reported back: sign-in strategies are registered in one list.");
        const before = events.length;
        expect(await adopt(wakes[0]!)).toBe("done");
        expect(texts(events.slice(before))).toContain("The explorer reported back: sign-in strategies are registered in one list.");
    });

    test("steering during a wake turn: the message Claude Code runs after it is still that turn's", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_SECOND_SCENARIO = "silent";
        process.env.FAKE_BACKGROUND_MS = "100";
        process.env.FAKE_WAKE_TOOL = "1";
        const { run, wakes, adopt, queued, session } = await makeAgent();
        expect(await run("map auth")).toBe("done");
        await until(() => wakes.length > 0, 5000, "the wake");
        queued.push(["also check the tests"]);
        expect(await adopt(wakes[0]!)).toBe("done");
        expect(userTexts()).toContain("also check the tests");
        // Recorded as the user's, in this session, once.
        expect(session.messages.filter((m) => m.role === "user" && JSON.stringify(m.content).includes("also check the tests")).length).toBe(1);
    });

    test("review #295 P2-7: a wake's result names no message, and doesn't answer the steering queued in it: that runs as the wake's, not a wake of its own", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_SECOND_SCENARIO = "silent";
        process.env.FAKE_BACKGROUND_MS = "100";
        process.env.FAKE_WAKE_TOOL = "1";
        const { run, wakes, adopt, queued, events } = await makeAgent();
        expect(await run("map auth")).toBe("done");
        await until(() => wakes.length > 0, 5000, "the wake");
        queued.push(["also check the tests"]);
        expect(await adopt(wakes[0]!)).toBe("done");
        await Bun.sleep(600);
        expect(wakes.length).toBe(1);
        expect(notices(events).join("\n")).not.toMatch(/error/i);
    });

    test("#305: a wake the session can't take over (it's on another model): its report shows, and the model is told", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_BACKGROUND_MS = "100";
        const { run, wakes, adopt, agent, events } = await makeAgent();
        expect(await run("map auth")).toBe("done");
        await until(() => wakes.length > 0, 5000, "the wake");
        expect(wakes[0]!.report).toContain("sign-in strategies");
        agent.setModel({ provider: "openai", id: "gpt-x", name: "GPT X" } as any, {} as any);
        expect(await adopt(wakes[0]!)).toBe("error");
        expect(notices(events).find((n) => n.includes("can't take it over now"))).toContain("sign-in strategies");
        const reminders: string[] = ((agent as any).pendingReminders as { text: string }[]).map((r) => r.text);
        expect(reminders.some((r) => r.includes("sign-in strategies") && r.includes("Claude Code"))).toBe(true);
    });

    test("#305 (final review, blocker 4): a monitor's wake carries no report; what its turn said shows, and the model is told", async () => {
        process.env.FAKE_SCENARIO = "monitor-repeated-reports";
        const { run, wakes, adopt, agent, events } = await makeAgent();
        expect(await run("watch the checks")).toBe("done");
        await until(() => wakes.length > 0, 5000, "the monitor's wake");
        expect(wakes[0]!.report).toBeUndefined();
        agent.setModel({ provider: "openai", id: "gpt-x", name: "GPT X" } as any, {} as any);
        expect(await adopt(wakes[0]!)).toBe("error");
        await until(() => notices(events).some((n) => /Monitor notification \d/.test(n)), 5000, "what the monitor's turn said");
        const reminders: string[] = ((agent as any).pendingReminders as { text: string }[]).map((r) => r.text);
        expect(reminders.some((r) => /Monitor notification \d/.test(r) && r.includes("Claude Code"))).toBe(true);
    });

    test("#305: what a monitor's turn says late (past any deadline) still shows, and the model is told", async () => {
        process.env.FAKE_SCENARIO = "monitor-repeated-reports";
        process.env.FAKE_MONITOR_REPORTS = "1";
        process.env.FAKE_WAKE_TEXT_MS = "800";
        // A deadline it once had, shortened: the words come after it.
        (liveTiming as any).wakeReportMs = 200;
        const { run, wakes, adopt, agent, events } = await makeAgent();
        expect(await run("watch the checks")).toBe("done");
        await until(() => wakes.length > 0, 5000, "the monitor's wake");
        agent.setModel({ provider: "openai", id: "gpt-x", name: "GPT X" } as any, {} as any);
        expect(await adopt(wakes[0]!)).toBe("error");
        await until(() => notices(events).some((n) => n.includes("Monitor notification 1.")), 5000, "what the monitor's turn said late");
        const reminders: string[] = ((agent as any).pendingReminders as { text: string }[]).map((r) => r.text);
        expect(reminders.some((r) => r.includes("Monitor notification 1."))).toBe(true);
    });

    test("a permission prompt from a background sub-agent between turns is asked (no turn running), and its answer reaches it", async () => {
        process.env.FAKE_SCENARIO = "agent-background-ask";
        const asked: PermissionRequest[] = [];
        const { run, wakes } = await makeAgent({
            ask: (req) => {
                asked.push(req);
                return { allow: true };
            },
        });
        expect(await run("start it")).toBe("done");
        await until(() => logLines().some((l) => l.backgroundAsk), 5000, "the sub-agent's ask");
        expect(asked.map((r) => r.tool.name)).toEqual(["Bash"]);
        // A background sub-agent's: the turn's end or Esc doesn't withdraw it (#295 review, P1-1).
        expect(asked[0]!.background).toBe(true);
        expect(logLines().find((l) => l.backgroundAsk).backgroundAsk).toBe("allow");
        await until(() => wakes.length > 0, 5000, "its report");
    });

    test("a background sub-agent's permission prompt after Esc stopped its turn is still asked, and its answer reaches it", async () => {
        process.env.FAKE_SCENARIO = "agent-background-hang";
        process.env.FAKE_BACKGROUND_MS = "900";
        process.env.FAKE_BACKGROUND_ASK = "1";
        const asked: PermissionRequest[] = [];
        const { run, events, wakes } = await makeAgent({
            ask: (req) => {
                asked.push(req);
                return { allow: true };
            },
        });
        const { ac, done } = await startHanging(run, events);
        ac.abort();
        expect(await done).toBe("aborted");
        await until(() => logLines().some((l) => l.backgroundAsk), 5000, "the sub-agent's ask");
        // Asked of the user, not refused because the turn that started the sub-agent was stopped.
        expect(asked.map((r) => r.tool.name)).toEqual(["Bash"]);
        // A background sub-agent's: the turn's end or Esc doesn't withdraw it (#295 review, P1-1).
        expect(asked[0]!.background).toBe(true);
        expect(logLines().find((l) => l.backgroundAsk).backgroundAsk).toBe("allow");
        await until(() => wakes.length > 0, 5000, "its report");
    });

    test("Esc on a prompt Claude Code hasn't started (it's on a report turn) withdraws it: the report turn isn't interrupted", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_SECOND_SCENARIO = "silent";
        process.env.FAKE_BACKGROUND_MS = "100";
        process.env.FAKE_WAKE_HANG = "1";
        const { run, wakes } = await makeAgent();
        expect(await run("map auth")).toBe("done");
        await until(() => wakes.length > 0, 5000, "the report turn");
        const ac = new AbortController();
        const next = run("next", ac.signal);
        await until(() => received().some((m) => m.type === "user" && m.message.content.some((c: any) => c.text === "next")), 5000, "the prompt sent");
        await Bun.sleep(100);
        ac.abort();
        expect(await next).toBe("aborted");
        const uuid = received().find((m) => m.type === "user" && m.message.content.some((c: any) => c.text === "next")).uuid;
        expect(controls("cancel_async_message")).toEqual([{ subtype: "cancel_async_message", message_uuid: uuid }]);
        expect(controls("interrupt")).toEqual([]);
    });

    test("-p (nothing takes reports after the run): as before #219, a process of its own waits for the background work, with its bounded wait", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_BACKGROUND_MS = "300";
        const { run, events, agent } = await makeAgent({ oneShot: true });
        expect(await run("map auth")).toBe("done");
        expect(texts(events)).toContain("The explorer reported back: sign-in strategies are registered in one list.");
        expect(agent.backgroundTasks().every((t) => t.status !== "running")).toBe(true);
        // The per-run path: the wait's terms are in the prompt, and the next run is a process of its own.
        expect(JSON.stringify(starts()[0].argv)).toContain("Harness waits for a reported background Bash command");
        process.env.FAKE_SCENARIO = "silent";
        expect(await run("again")).toBe("done");
        expect(starts().length).toBe(2);
    });

    test("-p stopped while it waits for background work ends then (Ctrl-C)", async () => {
        process.env.FAKE_SCENARIO = "agent-background-stuck";
        const { run } = await makeAgent({ oneShot: true });
        const ac = new AbortController();
        const done = run("map auth", ac.signal);
        await until(() => received().some((m) => m.type === "user"), 5000);
        await Bun.sleep(300);
        ac.abort();
        expect(await done).toBe("aborted");
    });
});

describe("the process: crashes, restarts, settings", () => {
    test("a crash mid-turn ends it with an error, its background work stopped with the process, and the next turn resumes on a new process", async () => {
        process.env.FAKE_SCENARIO = "agent-background-hang";
        process.env.FAKE_BACKGROUND_MS = "60000";
        process.env.FAKE_EXIT_AFTER_MS = "1500";
        const { run, events, agent } = await makeAgent();
        expect(await run("go")).toBe("error");
        expect(notices(events).join("\n")).toMatch(/Claude Code stopped/);
        expect(agent.backgroundTasks().find((t) => t.kind === "agent")).toMatchObject({ status: "stopped", withProcess: true });
        delete process.env.FAKE_EXIT_AFTER_MS;
        process.env.FAKE_SCENARIO = "silent";
        expect(await run("again")).toBe("done");
        const s = starts();
        expect(s.length).toBe(2);
        expect(s[1].argv).toContain("--resume");
        expect(s[1].pid).not.toBe(s[0].pid);
    });

    test("a crash while idle: its background work stopped with the process; the next turn resumes", async () => {
        process.env.FAKE_SCENARIO = "two-shells";
        process.env.FAKE_SHELL_MS = "60000";
        process.env.FAKE_EXIT_IDLE_MS = "200";
        const { run, agent, events } = await makeAgent();
        expect(await run("start two")).toBe("done");
        await until(() => agent.backgroundTasks().every((t) => t.status !== "running"), 5000, "the tasks lost");
        expect(agent.backgroundTasks().every((t) => t.withProcess)).toBe(true);
        delete process.env.FAKE_EXIT_IDLE_MS;
        process.env.FAKE_SCENARIO = "silent";
        expect(await run("again")).toBe("done");
        expect(starts()[1].argv).toContain("--resume");
        expect(notices(events).join("\n")).not.toMatch(/error/);
    });

    test("review #295 P1-4: a wake left unadopted, then a crash: the new process's first wake is a wake of its own", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_BACKGROUND_MS = "200";
        const { run, wakes, adopt } = await makeAgent();
        expect(await run("map auth")).toBe("done");
        await until(() => wakes.length === 1, 5000, "the first wake");
        const pid = starts()[0].pid as number;
        process.kill(pid, "SIGKILL");
        await until(() => {
            try {
                process.kill(pid, 0);
                return false;
            } catch {
                return true;
            }
        }, 5000, "the crash");
        expect(await run("map auth again")).toBe("done");
        await until(() => wakes.length === 2, 5000, "the new process's wake");
        expect(wakes[1]!.ref).not.toBe(wakes[0]!.ref);
        expect(await adopt(wakes[1]!)).toBe("done");
    });

    test("Harness quitting with background work: it stops with the process; the next run resumes the session", async () => {
        process.env.FAKE_SCENARIO = "two-shells";
        process.env.FAKE_SHELL_MS = "60000";
        const first = await makeAgent();
        expect(await first.run("start two")).toBe("done");
        await first.client.shutdown();
        expect(first.agent.backgroundTasks().every((t) => t.status === "stopped" && t.withProcess)).toBe(true);
        forgetClient("claude-code");
        process.env.FAKE_SCENARIO = "silent";
        const second = await makeAgent({ session: first.session });
        expect(await second.run("again")).toBe("done");
        const s = starts();
        expect(s[1].argv[s[1].argv.indexOf("--resume") + 1]).toBe(first.session.backends.get("claude-code")!.id);
    });

    test("a model, effort or mode change goes to the running process: no respawn", async () => {
        process.env.FAKE_SCENARIO = "silent";
        const { run, agent, setMode } = await makeAgent();
        expect(await run("one")).toBe("done");
        agent.setModel({ provider: "claude-code", id: "sonnet", effortLevels: ["low", "high"] }, agent.client);
        setMode("plan");
        expect(await run("two")).toBe("done");
        expect(starts().length).toBe(1);
        expect(controls("set_model")).toEqual([{ subtype: "set_model", model: "sonnet" }]);
        expect(controls("set_permission_mode").map((r) => r.mode)).toContain("plan");
    });

    test("a model change Claude Code refuses restarts the idle process, resuming the session", async () => {
        process.env.FAKE_SCENARIO = "silent";
        process.env.FAKE_SET_MODEL_FAIL = "1";
        const { run, agent } = await makeAgent();
        expect(await run("one")).toBe("done");
        agent.setModel({ provider: "claude-code", id: "sonnet" }, agent.client);
        expect(await run("two")).toBe("done");
        const s = starts();
        expect(s.length).toBe(2);
        expect(s[1].argv).toEqual(expect.arrayContaining(["--resume", "--model", "sonnet"]));
    });

    test("a spawn-time settings change while background work runs waits for it (the old process serves the turn); once it's over, the next turn restarts", async () => {
        process.env.FAKE_SCENARIO = "two-shells";
        process.env.FAKE_SHELL_MS = "60000";
        process.env.FAKE_SECOND_SCENARIO = "silent";
        const settings: any = {};
        const { run, events, agent } = await makeAgent({ settings });
        expect(await run("start two")).toBe("done");
        settings.permissions = { deny: ["Bash(rm:*)"] };
        expect(await run("two")).toBe("done");
        expect(starts().length).toBe(1);
        expect(notices(events).join("\n")).toMatch(/New Claude Code settings apply once its background work ends \(2 tasks running\)/);
        expect(agent.backgroundTasks().filter((t) => t.status === "running").length).toBe(2);
        await agent.stopBackground();
        expect(await run("three")).toBe("done");
        const s = starts();
        expect(s.length).toBe(2);
        expect(JSON.parse(s[1].argv[s[1].argv.indexOf("--settings") + 1]).permissions.deny).toContain("Bash(rm:*)");
    });

    test("an account switch while background work runs starts the other account's session; the old one's work stops, and the user is told", async () => {
        const { addAccount } = await import("../src/providers/accounts");
        const folder = tempDir("claude-work-account-");
        rmSync(folder, { recursive: true, force: true });
        addAccount("claude-code", { id: "work", name: "Work", folder });
        process.env.FAKE_SCENARIO = "two-shells";
        process.env.FAKE_SHELL_MS = "60000";
        process.env.FAKE_SECOND_SCENARIO = "silent";
        const { run, events, agent, session } = await makeAgent();
        expect(await run("start two")).toBe("done");
        session.setAccount("claude-code", "work");
        process.env.FAKE_SCENARIO = "silent";
        expect(await run("on work")).toBe("done");
        const s = starts();
        expect(s.length).toBe(2);
        expect(s[1].claudeConfigDir).toBe(realpathOf(folder));
        expect(s[1].argv).not.toContain("--resume");
        expect(notices(events).join("\n")).toMatch(/2 background tasks stopped with it/);
        expect(agent.backgroundTasks().every((t) => t.status !== "running")).toBe(true);
    });

    test("a switch to an account sharing the history (Harness-made) while background work runs: the same session, resumed by a new process signed in as it; the old one's work stops, and the user is told (#377)", async () => {
        const { addAccount } = await import("../src/providers/accounts");
        const work = addAccount("claude-code", { id: "shared-work", name: "Work" });
        process.env.FAKE_SCENARIO = "two-shells";
        process.env.FAKE_SHELL_MS = "60000";
        process.env.FAKE_SECOND_SCENARIO = "silent";
        process.env.FAKE_TRANSCRIPTS = "1";
        const { run, events, agent, session } = await makeAgent();
        expect(await run("start two")).toBe("done");
        const id = session.backends.get("claude-code")!.id;
        session.setAccount("claude-code", work.id);
        expect(session.backends.get("claude-code")?.id).toBe(id);
        process.env.FAKE_SCENARIO = "silent";
        expect(await run("on work")).toBe("done");
        // Not the process signed in as Default, though its background work would hold a restart back.
        const s = starts();
        expect(s.length).toBe(2);
        expect(s[0].claudeConfigDir).toBe(process.env.CLAUDE_CONFIG_DIR);
        expect(s[1].claudeConfigDir).toBe(realpathOf(work.folder));
        expect(s[1].argv[s[1].argv.indexOf("--resume") + 1]).toBe(id);
        expect(notices(events).join("\n")).toMatch(/restarted for the account change: 2 background tasks stopped/);
        expect(notices(events).join("\n")).not.toMatch(/New Claude Code settings apply once/);
        expect(agent.backgroundTasks().every((t) => t.status !== "running")).toBe(true);
        expect(userTexts().join("\n")).not.toContain("conversation-so-far");
    });

    test("a switch to an account sharing the history after the process was reaped: a resume its CLI can't do starts over with the conversation (#377)", async () => {
        const { addAccount } = await import("../src/providers/accounts");
        const work = addAccount("claude-code", { id: "reaped-work", name: "Work" });
        liveTiming.idleMs = 150;
        process.env.FAKE_SCENARIO = "silent";
        const { run, events, session, client } = await makeAgent();
        expect(await run("earlier")).toBe("done");
        await until(() => client.live.get(session.meta.id)!.state === "dead", 3000, "reaped");
        const id = session.backends.get("claude-code")!.id;
        session.setAccount("claude-code", work.id);
        // The new account's CLI can't find it.
        process.env.FAKE_GONE_ID = id;
        expect(await run("on work")).toBe("done");
        const s = starts();
        expect(s.map((x) => (x.argv.includes("--resume") ? x.argv[x.argv.indexOf("--resume") + 1] : "new"))).toEqual(["new", id, "new"]);
        expect(s[2].claudeConfigDir).toBe(realpathOf(work.folder));
        expect(notices(events).join("\n")).toMatch(/Couldn't resume the Claude Code session.*Starting a new one with this conversation as context/s);
        expect(userTexts().join("\n")).toContain("conversation-so-far");
        expect(userTexts().join("\n")).toContain("User: earlier");
    });

    test("a wake from the earlier account's process isn't taken over after a switch: refused before anything is drained, so a waiting message goes with the next turn (#377)", async () => {
        const { addAccount } = await import("../src/providers/accounts");
        const work = addAccount("claude-code", { id: "wake-work", name: "Work" });
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_BACKGROUND_MS = "300";
        process.env.FAKE_SECOND_SCENARIO = "silent";
        const { run, adopt, wakes, session, queued } = await makeAgent();
        expect(await run("map auth")).toBe("done");
        const [first] = starts();
        session.setAccount("claude-code", work.id);
        await until(() => wakes.length > 0, 5000, "the wake");
        // A message the user sent meanwhile, to be steered into whatever turn runs.
        queued.push(["also check the logs"]);
        expect(await adopt(wakes[0]!)).toBe("error");
        expect(queued).toEqual([["also check the logs"]]);
        expect(userTexts()).not.toContain("also check the logs");
        // The next turn is the new account's own process.
        expect(await run("on work")).toBe("done");
        const s = starts();
        expect(s).toHaveLength(2);
        expect(s[0].pid).toBe(first.pid);
        expect(s[1].claudeConfigDir).toBe(realpathOf(work.folder));
    });

    test("a session to be forked, switched to an account sharing its history: the new account's process forks it, not the earlier one's (#377)", async () => {
        const { addAccount } = await import("../src/providers/accounts");
        const work = addAccount("claude-code", { id: "fork-work-live", name: "Work" });
        process.env.FAKE_SCENARIO = "silent";
        const { run, session } = await makeAgent();
        expect(await run("before the fork")).toBe("done");
        const id = session.backends.get("claude-code")!.id;
        session.markBackendForked("claude-code");
        expect(session.backends.get("claude-code")?.fork).toBe(true);
        session.setAccount("claude-code", work.id);
        expect(await run("on work")).toBe("done");
        const s = starts();
        expect(s).toHaveLength(2);
        expect(s[1].claudeConfigDir).toBe(realpathOf(work.folder));
        expect(s[1].argv[s[1].argv.indexOf("--resume") + 1]).toBe(id);
        expect(s[1].argv).toContain("--fork-session");
        expect(session.backends.get("claude-code")?.id).not.toBe(id);
    });

    test("idle with nothing in the background, the process is reaped; the next turn resumes", async () => {
        liveTiming.idleMs = 150;
        process.env.FAKE_SCENARIO = "silent";
        const { run, client, session } = await makeAgent();
        expect(await run("one")).toBe("done");
        await until(() => client.live.get(session.meta.id)!.state === "dead", 3000, "reaped");
        expect(await run("two")).toBe("done");
        const s = starts();
        expect(s.length).toBe(2);
        expect(s[1].argv).toContain("--resume");
    });
});

describe("fork, rewind and compaction across a wake", () => {
    test("rewinding past the turns the CLI has seen lets its process go and starts a fresh session", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_BACKGROUND_MS = "100";
        process.env.FAKE_SECOND_SCENARIO = "silent";
        const { run, wakes, adopt, session } = await makeAgent();
        expect(await run("map auth")).toBe("done");
        await until(() => wakes.length > 0, 5000, "the wake");
        expect(await adopt(wakes[0]!)).toBe("done");
        session.rewind(1);
        expect(await run("start over")).toBe("done");
        const s = starts();
        expect(s.length).toBe(2);
        expect(s[1].argv).not.toContain("--resume");
    });

    test("compaction after a wake turn runs on the same process", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_BACKGROUND_MS = "100";
        const { run, wakes, adopt, agent, events } = await makeAgent();
        expect(await run("map auth")).toBe("done");
        await until(() => wakes.length > 0, 5000, "the wake");
        expect(await adopt(wakes[0]!)).toBe("done");
        expect(await agent.compact({ auto: false, signal: new AbortController().signal })).toBe(true);
        expect(userTexts()).toContain("/compact");
        expect(starts().length).toBe(1);
        expect(events.some((e) => e.type === "compact_end")).toBe(true);
    });

    test("a fork while the original's background work runs gets a session of its own; the original's work goes on", async () => {
        process.env.FAKE_SCENARIO = "two-shells";
        process.env.FAKE_SHELL_MS = "60000";
        const original = await makeAgent();
        expect(await original.run("start two")).toBe("done");
        const id = original.session.backends.get("claude-code")!.id;
        // As forkSession leaves it: the fork shares the CLI session until its first turn forks it.
        const forked = Session.create(cwd, { persist: false });
        forked.setBackendSession("claude-code", id, 0);
        forked.markBackendForked("claude-code");
        process.env.FAKE_SCENARIO = "silent";
        const fork = await makeAgent({ session: forked });
        expect(await fork.run("in the fork")).toBe("done");
        const s = starts();
        expect(s.length).toBe(2);
        expect(s[1].argv).toEqual(expect.arrayContaining(["--resume", id, "--fork-session"]));
        expect(fork.session.backends.get("claude-code")!.id).not.toBe(id);
        expect(original.agent.backgroundTasks().filter((t) => t.status === "running").length).toBe(2);
    });

    test("the original of a fork, quiet, forks its CLI session at its next turn (never continuing what the copy forks from)", async () => {
        process.env.FAKE_SCENARIO = "silent";
        const { run, session } = await makeAgent();
        expect(await run("one")).toBe("done");
        const id = session.backends.get("claude-code")!.id;
        session.fork({ persist: false, shareBackends: true });
        session.markBackendForked("claude-code");
        expect(await run("two")).toBe("done");
        const s = starts();
        expect(s.length).toBe(2);
        expect(s[1].argv).toEqual(expect.arrayContaining(["--resume", id, "--fork-session"]));
        expect(session.backends.get("claude-code")!.id).not.toBe(id);
        expect(session.backends.get("claude-code")!.fork).toBeFalsy();
    });

    test("the original of a fork with background work running goes on in place: its work isn't stopped", async () => {
        process.env.FAKE_SCENARIO = "two-shells";
        process.env.FAKE_SHELL_MS = "60000";
        process.env.FAKE_SECOND_SCENARIO = "silent";
        const { run, session, agent } = await makeAgent();
        expect(await run("start two")).toBe("done");
        session.markBackendForked("claude-code");
        expect(await run("two")).toBe("done");
        expect(starts().length).toBe(1);
        expect(agent.backgroundTasks().filter((t) => t.status === "running").length).toBe(2);
    });
});

function realpathOf(p: string): string {
    return require("fs").realpathSync(p);
}

describe("the carrier command, on the real Claude Code", () => {
    // Captured from Claude Code 2.1.304 (trimmed, personal paths redacted): a turn with a background Agent running,
    // stopped by send-now with `/effort` queued as the carrier.
    const frames = readFileSync(join(import.meta.dir, "fixtures", "protocol", "claude-2.1.304-sendnow-effort.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { t: number; dir: string; frame: any });

    test(`${CARRIER_COMMAND} as the carrier: the turn stops, the carrier's own turn only prints its usage line, and the background Agent goes on to report`, () => {
        const sent = frames.find((f) => f.dir === "out" && f.frame.type === "user" && f.frame.message.content[0].text === CARRIER_COMMAND)!;
        const stop = frames.find((f) => f.dir === "out" && f.frame.request?.subtype === "interrupt")!;
        expect(stop.frame.request).toMatchObject({ send_now: true, message_uuid: sent.frame.uuid });
        const after = frames.filter((f) => f.t > stop.t && f.dir === "in").map((f) => f.frame);
        // The running turn ends (aborted), then the carrier's turn runs: no tool, no model call, just its usage line.
        const firstResult = after.findIndex((f) => f.type === "result");
        expect(after[firstResult]).toMatchObject({ subtype: "error_during_execution", terminal_reason: "aborted_tools" });
        const carrierInit = after.findIndex((f) => f.type === "system" && f.subtype === "init" && f.user_message_uuids?.includes(sent.frame.uuid));
        expect(carrierInit).toBeGreaterThan(firstResult);
        const carrierEnd = after.findIndex((f, i) => i > carrierInit && f.type === "result");
        const carrierTurn = after.slice(carrierInit + 1, carrierEnd);
        expect(carrierTurn.map((f) => f.type)).toEqual(["assistant"]);
        expect(carrierTurn[0].message.content[0].text).toStartWith("Usage: /effort");
        expect(after[carrierEnd]).toMatchObject({ subtype: "success" });
        // The background Agent wasn't stopped: it finished later, and Claude Code started a turn to report it.
        const agent = frames.find((f) => f.frame.subtype === "task_started" && f.frame.task_type === "local_agent")!.frame.task_id;
        const ended = after.filter((f) => f.subtype === "task_notification" && f.task_id === agent);
        expect(ended.map((f) => f.status)).toEqual(["completed"]);
        const reportInit = after.findIndex((f) => f.subtype === "init" && after.indexOf(ended[0]) < after.indexOf(f));
        expect(reportInit).toBeGreaterThan(-1);
        expect(after[reportInit].user_message_uuids).toBeUndefined();
    });
});

describe("#311: a notice of a task only when an earlier process left it behind", () => {
    /** The "Claude Code: <summary>." rows a task's end can give. */
    const taskNotices = (events: AgentEvent[]) => notices(events).filter((n) => n.startsWith("info: Claude Code: "));

    test("a background sub-agent's own foreground commands, one failing and one stopped, say nothing of their own; its report still wakes the session", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_SUB_COMMANDS = "1";
        process.env.FAKE_BACKGROUND_MS = "100";
        const { run, events, wakes, adopt, agent } = await makeAgent();
        expect(await run("map auth")).toBe("done");
        await until(() => wakes.length > 0, 5000, "the sub-agent's report");
        // Its commands ran (its steps show them).
        expect(JSON.stringify(events)).toContain("toolu_sub_cmd2");
        expect(wakes[0]!.report).toContain("sign-in strategies");
        expect(await adopt(wakes[0]!)).toBe("done");
        expect(texts(events)).toContain("The explorer reported back: sign-in strategies are registered in one list.");
        expect(agent.backgroundTasks().find((t) => t.kind === "agent")?.status).toBe("done");
        // Never shown as tasks of their own, nor as left behind.
        expect(agent.backgroundTasks().map((t) => t.id)).toEqual(["agent-1"]);
        expect(taskNotices(events)).toEqual([]);
    });

    test("Esc on a foreground command, in a process that resumed the session: its stop says nothing beyond its own row", async () => {
        process.env.FAKE_SCENARIO = "silent";
        const first = await makeAgent();
        expect(await first.run("one")).toBe("done");
        await first.client.shutdown();
        forgetClient("claude-code");
        process.env.FAKE_SCENARIO = "hang";
        process.env.FAKE_FG_TASK = "1";
        const { run, events } = await makeAgent({ session: first.session });
        const { ac, done } = await startHanging(run, events);
        ac.abort();
        expect(await done).toBe("aborted");
        expect(starts()[1].argv).toContain("--resume");
        // The command's stop came (task_notification stopped), after the resumed process's first turn began.
        await Bun.sleep(100);
        expect(events.some((e) => e.type === "tool_end" && e.call.id === "toolu_h")).toBe(true);
        expect(taskNotices(events)).toEqual([]);
    });

    test("what the earlier process left behind is said when the next one resumes the session", async () => {
        process.env.FAKE_SCENARIO = "two-shells";
        process.env.FAKE_SHELL_MS = "60000";
        const first = await makeAgent();
        expect(await first.run("start two")).toBe("done");
        await first.client.shutdown();
        forgetClient("claude-code");
        process.env.FAKE_SCENARIO = "silent";
        process.env.FAKE_STALE_TASK = "2";
        const second = await makeAgent({ session: first.session });
        expect(await second.run("again")).toBe("done");
        expect(starts()[1].argv).toContain("--resume");
        await until(() => taskNotices(second.events).length === 2, 3000, "the notices of what was left behind");
        expect(taskNotices(second.events)).toEqual([
            "info: Claude Code: Background agent \"Map auth\" didn't finish before the previous session ended.",
            "info: Claude Code: Background shell command didn't finish before the previous session ended.",
        ]);
    }, 15000);
});
