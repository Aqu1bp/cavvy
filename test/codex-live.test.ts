// Codex on the live CLI layer (#219 PR 3): one app-server per session, kept across turns. What must hold
// when things go wrong: Esc never ends the app-server or its background work, a stop and a command's own
// end can race, the app-server can crash (mid-turn, idle), Harness can quit, the account can change, and
// wakes meet the user's own messages, steering, forks, rewinds and compactions. Fake Codex
// (test/fixtures/fake-codex.ts, persistent); no network.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { fakeEnvFile, stopLiveCodex } from "./helpers/fake-env";

const iso = isolate();
const registry = await import("../src/providers/registry");
const { clientFor, forgetClient } = await import("../src/providers/models");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { SessionBackground } = await import("../src/agent/background");
const { forkSession } = await import("../src/agent/fork");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const trust = await import("../src/config/trust");

type AgentEvent = import("../src/agent/agent").AgentEvent;
type BackendWake = import("../src/backends/types").BackendWake;
type Session = InstanceType<typeof Session>;

const bin = tempDir("fake-codex-live-");
const LOG = join(bin, "log.jsonl");
const CRASH = join(bin, "crash");
const codexBin = join(bin, "codex");
writeFileSync(codexBin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-codex.ts")}" "$@"\n`);
chmodSync(codexBin, 0o755);
const fakeEnv = fakeEnvFile(bin);

let cwd: string;
const agents: InstanceType<typeof Agent>[] = [];
beforeEach(() => {
    cwd = realpathSync(tempDir("codex-live-proj-"));
    for (const f of [LOG, LOG + ".goals.json", LOG + ".tiers.json", LOG + ".usage.json", CRASH]) rmSync(f, { force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    process.env.FAKE_LOG = LOG;
    process.env.FAKE_CRASH_FILE = CRASH;
    fakeEnv.write();
    registry.saveAgentConfig("codex", { path: codexBin });
    forgetClient("codex");
});
afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.dispose(500)));
    await stopLiveCodex();
});
afterAll(() => {
    iso.cleanup();
    rmSync(bin, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

const logLines = (): any[] => (existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const received = () => logLines().flatMap((l) => (l.received ? [l.received] : []));
const calls = (method: string) => received().filter((m) => m.method === method).map((m) => m.params);
/** Each app-server started: its pid. */
const pids = () => logLines().flatMap((l) => (l.argv ? [l.pid as number] : []));
const turnTexts = () => calls("turn/start").map((p) => (p.input ?? []).map((i: any) => i.text ?? "").join("\n"));
const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

async function until(ok: () => boolean, what: string, ms = 5000) {
    for (const end = Date.now() + ms; !ok(); ) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(10);
    }
}

async function makeAgent(o: { session?: Session; settings?: Record<string, unknown>; queue?: string[] } = {}) {
    const settings = { agentCli: { liveSessions: true }, ...o.settings } as any;
    const session = o.session ?? Session.create(cwd, { persist: false });
    const wakes: BackendWake[] = [];
    const events: AgentEvent[] = [];
    const queue = o.queue ?? [];
    trust.trustForSession(cwd);
    const background = new SessionBackground(session);
    let mode: import("../src/permissions/modes").PermissionMode = "bypassPermissions";
    const agent = new Agent({
        session,
        model: { provider: "codex", id: "default" } as any,
        client: await clientFor("codex"),
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map(), background },
        // As the runtime does: the list is kept in the session log as it changes.
        host: { drainQueued: () => queue.splice(0), emit: (e) => events.push(e), ui: {}, wake: (w) => void wakes.push(w), backgroundChanged: () => background.persist() },
    });
    agents.push(agent);
    const run = (text: string, signal = new AbortController().signal) => {
        fakeEnv.write();
        return agent.run([{ type: "text", text }], { signal });
    };
    /** The next wake: adopted as the runtime adopts one (a wake turn of the session). */
    const nextWake = async (ms = 5000) => {
        await until(() => wakes.length > 0, "a wake", ms);
        return wakes.shift()!;
    };
    const adopt = (w: BackendWake, signal = new AbortController().signal) => agent.run([{ type: "text", text: w.label ?? "" }], { signal, kind: "wake", display: w.label, adopt: w });
    const task = (id: string) => agent.backgroundTasks().find((t) => t.id === id);
    const notices = () => events.flatMap((e) => (e.type === "notice" ? [e.message] : []));
    return { agent, session, events, run, wakes, nextWake, adopt, task, notices, queue, background, settings };
}

describe("one app-server per session", () => {
    test("the session's turns go to one app-server, on one thread", async () => {
        const a = await makeAgent();
        expect(await a.run("one")).toBe("done");
        expect(await a.run("two")).toBe("done");
        expect(pids()).toHaveLength(1);
        expect(calls("thread/start")).toHaveLength(1);
        expect(calls("thread/resume")).toEqual([]);
        expect(calls("turn/start").map((p) => p.threadId)).toEqual(["thr-new", "thr-new"]);
        expect(calls("initialize")[0].capabilities).toEqual({ experimentalApi: true });
    });

    test("the kill switch (agentCli.liveSessions false): an app-server per turn, as before", async () => {
        const a = await makeAgent({ settings: { agentCli: { liveSessions: false } } });
        expect(await a.run("one")).toBe("done");
        expect(await a.run("two")).toBe("done");
        expect(pids()).toHaveLength(2);
        expect(calls("thread/resume").map((p) => p.threadId)).toEqual(["thr-new"]);
    });
});

describe("background terminals", () => {
    test("a command still running when its turn ends is a background task; its end starts a turn the session adopts as a wake", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_MS = "500";
        const a = await makeAgent();
        expect(await a.run("start the build")).toBe("done");
        expect(a.task("exec-turn-1-1")).toMatchObject({ provider: "codex", kind: "shell", status: "running", stoppable: true });
        // The turn's row for it says it goes on.
        expect(JSON.stringify(a.events)).toContain("Still running in the background (process 40001)");
        const w = await a.nextWake();
        expect(w.provider).toBe("codex");
        expect(w.label).toBe("Background command finished: sleep 1; echo bg 1");
        expect(await a.adopt(w)).toBe("done");
        expect(a.task("exec-turn-1-1")?.status).toBe("done");
        const told = turnTexts()[1]!;
        expect(told).toContain("(process 40001) has finished with exit code 0");
        expect(told).toContain("bg 1 done");
        // The wake turn's answer is the session's.
        expect(JSON.stringify(a.session.messages)).toContain("Running it.\\n\\nFinished.");
        expect(pids()).toHaveLength(1);
    });

    test("codex.wakeOnBackgroundCommand false: no turn starts for it; Codex hears with the next prompt", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_MS = "100";
        const a = await makeAgent({ settings: { codex: { wakeOnBackgroundCommand: false } } });
        expect(await a.run("start it")).toBe("done");
        await until(() => a.task("exec-turn-1-1")?.status === "done", "the command's end");
        await Bun.sleep(300);
        expect(a.wakes).toEqual([]);
        expect(calls("turn/start")).toHaveLength(1);
        expect(await a.run("what happened?")).toBe("done");
        expect(turnTexts()[1]).toMatch(/has finished with exit code 0[\s\S]*what happened\?/);
    });

    test("two commands ending together: one turn tells Codex of both", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_COUNT = "2";
        process.env.FAKE_BG_MS = "300";
        // A few milliseconds apart, as two ends are.
        process.env.FAKE_BG_STAGGER_MS = "20";
        const a = await makeAgent();
        expect(await a.run("start both")).toBe("done");
        const w = await a.nextWake();
        expect(w.label).toBe("2 background commands finished");
        expect(await a.adopt(w)).toBe("done");
        await Bun.sleep(300);
        expect(a.wakes).toEqual([]);
        expect(calls("turn/start")).toHaveLength(2);
        expect(turnTexts()[1]).toContain("(process 40001) has finished");
        expect(turnTexts()[1]).toContain("(process 40002) has finished");
    });

    test("stop one, then all: thread/backgroundTerminals/terminate; no turn starts for them, and Codex hears with the next prompt", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_COUNT = "2";
        process.env.FAKE_BG_MS = "never";
        const a = await makeAgent();
        expect(await a.run("start both")).toBe("done");
        expect(await a.agent.stopBackground(["exec-turn-1-1"])).toEqual({ "exec-turn-1-1": "stopped" });
        expect(calls("thread/backgroundTerminals/terminate")).toEqual([{ threadId: "thr-new", processId: "40001" }]);
        expect(a.task("exec-turn-1-1")?.status).toBe("stopped");
        expect(a.task("exec-turn-1-2")?.status).toBe("running");
        expect(await a.agent.stopBackground()).toEqual({ "exec-turn-1-2": "stopped" });
        expect(a.task("exec-turn-1-2")?.status).toBe("stopped");
        await Bun.sleep(300);
        expect(a.wakes).toEqual([]);
        expect(calls("turn/start")).toHaveLength(1);
        expect(await a.run("next")).toBe("done");
        expect(turnTexts()[1]).toContain("The user stopped the background command `sleep 1; echo bg 1` (process 40001).");
        expect(turnTexts()[1]).toContain("(process 40002).");
        expect(pids()).toHaveLength(1);
    });

    test("a stop racing the command's own end: it ended by itself (done), the stop says so (ended), and no turn starts for it", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_MS = "never";
        process.env.FAKE_TERMINATE_LATE = "1";
        const a = await makeAgent();
        expect(await a.run("start it")).toBe("done");
        // Not terminated: it had ended by itself (BackgroundStop "ended").
        expect(await a.agent.stopBackground(["exec-turn-1-1"])).toEqual({ "exec-turn-1-1": "ended" });
        expect(a.task("exec-turn-1-1")?.status).toBe("done");
        await Bun.sleep(300);
        expect(a.wakes).toEqual([]);
        expect(await a.run("next")).toBe("done");
        expect(turnTexts()[1]).toContain("has finished with exit code 0. The end of its output:\nfinished first");
    });

    test("a sub-agent still working when its turn ends is a background task; a stop interrupts its thread's turn", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bgagent,cmd";
        process.env.FAKE_BG_MS = "never";
        const a = await makeAgent();
        expect(await a.run("watch the build")).toBe("done");
        expect(a.task("thr-bg-1")).toMatchObject({ provider: "codex", kind: "agent", status: "running", stoppable: true });
        expect(await a.agent.stopBackground(["thr-bg-1"])).toEqual({ "thr-bg-1": "stopped" });
        expect(calls("turn/interrupt")).toEqual([{ threadId: "thr-bg-1", turnId: "turn-bg-1" }]);
        expect(a.task("thr-bg-1")?.status).toBe("stopped");
        expect(pids()).toHaveLength(1);
    });
});

describe("Esc interrupts the turn, never the app-server or its background work", () => {
    for (const phase of ["stream", "tool"] as const)
        test(`while Codex is ${phase === "stream" ? "streaming its answer" : "running a command"}`, async () => {
            process.env.FAKE_SCENARIO = "hang";
            process.env.FAKE_HANG_PHASE = phase;
            const a = await makeAgent();
            const stop = new AbortController();
            const running = a.run("go", stop.signal);
            await until(() => calls("turn/start").length === 1 && (phase === "tool" ? JSON.stringify(a.events).includes("sleep 60") : a.events.some((e) => e.type === "text")), "the turn to be under way");
            stop.abort();
            expect(await running).toBe("aborted");
            expect(calls("turn/interrupt")).toEqual([{ threadId: "thr-new", turnId: "turn-1" }]);
            expect(logLines().find((l) => l.hangEnded)?.hangEnded).toEqual({ turnId: "turn-1", interrupted: true });
            const [pid] = pids();
            expect(alive(pid!)).toBe(true);
            process.env.FAKE_SCENARIO = "cmd";
            expect(await a.run("again")).toBe("done");
            expect(pids()).toEqual([pid!]);
            expect(calls("thread/resume")).toEqual([]);
        });

    test("with a background command and a sub-agent working: the turn and the sub-agent's turn stop, the command goes on", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,bgagent";
        process.env.FAKE_BG_MS = "never";
        process.env.FAKE_AGENT_PARENT = "hang";
        const a = await makeAgent();
        expect(await a.run("start the build")).toBe("done");
        const stop = new AbortController();
        const running = a.run("watch it", stop.signal);
        await until(() => logLines().some((l) => l.childStarted), "the sub-agent");
        await Bun.sleep(50);
        stop.abort();
        expect(await running).toBe("aborted");
        expect(calls("turn/interrupt")).toEqual([
            { threadId: "thr-bg-2", turnId: "turn-bg-2" },
            { threadId: "thr-new", turnId: "turn-2" },
        ]);
        expect(logLines().find((l) => l.childEnded)?.childEnded).toEqual({ thread: "thr-bg-2", status: "interrupted" });
        expect(calls("thread/backgroundTerminals/terminate")).toEqual([]);
        expect(a.task("exec-turn-1-1")?.status).toBe("running");
        expect(alive(pids()[0]!)).toBe(true);
        expect(await a.agent.stopBackground(["exec-turn-1-1"])).toEqual({ "exec-turn-1-1": "stopped" });
    });

    test("in a wake turn: it stops, and the app-server stays", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,hang,cmd";
        process.env.FAKE_BG_MS = "100";
        const a = await makeAgent();
        expect(await a.run("start it")).toBe("done");
        const w = await a.nextWake();
        const stop = new AbortController();
        const running = a.adopt(w, stop.signal);
        await until(() => JSON.stringify(a.events).includes("sleep 60"), "the wake turn's command");
        stop.abort();
        expect(await running).toBe("aborted");
        expect(calls("turn/interrupt")).toEqual([{ threadId: "thr-new", turnId: "turn-2" }]);
        expect(alive(pids()[0]!)).toBe(true);
        expect(await a.run("again")).toBe("done");
        expect(pids()).toHaveLength(1);
    });

    test("in a turn Codex started for its goal: it stops, the goal pauses, and no more of its turns start", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "cmd,hang";
        process.env.FAKE_GOAL_TURNS = "5";
        const a = await makeAgent();
        expect(await a.run("/goal the docs build")).toBe("done");
        const w = await a.nextWake();
        expect(w.label).toBe("Codex went on with the goal: the docs build");
        const stop = new AbortController();
        const running = a.adopt(w, stop.signal);
        await until(() => JSON.stringify(a.events).includes("sleep 60"), "the goal's turn");
        stop.abort();
        expect(await running).toBe("aborted");
        expect(calls("turn/interrupt")).toEqual([{ threadId: "thr-new", turnId: "turn-2" }]);
        // (The /goal itself set it paused, then active once its turn had started.)
        const afterStop = () => received().slice(received().findIndex((m) => m.method === "turn/start") + 1);
        await until(() => afterStop().some((m) => m.method === "thread/goal/set" && m.params.status === "paused"), "the goal's pause");
        await Bun.sleep(300);
        expect(calls("turn/start")).toHaveLength(1);
        expect(logLines().filter((l) => l.hangEnded)).toHaveLength(1);
        expect(a.wakes).toEqual([]);
        expect(alive(pids()[0]!)).toBe(true);
    });

    test("while idle, or as a prompt starts: nothing is interrupted, and the background command goes on", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_MS = "never";
        const a = await makeAgent();
        expect(await a.run("start it")).toBe("done");
        const stop = new AbortController();
        stop.abort();
        expect(await a.run("never sent", stop.signal)).toBe("aborted");
        expect(calls("turn/interrupt")).toEqual([]);
        expect(calls("turn/start")).toHaveLength(1);
        expect(a.task("exec-turn-1-1")?.status).toBe("running");
        expect(await a.run("next")).toBe("done");
        expect(a.task("exec-turn-1-1")?.status).toBe("running");
        expect(pids()).toHaveLength(1);
        expect(alive(pids()[0]!)).toBe(true);
        expect(await a.agent.stopBackground()).toEqual({ "exec-turn-1-1": "stopped" });
    });
});

describe("the app-server goes away", () => {
    test("a crash mid-turn ends the turn with an error; the next turn resumes the thread on a new app-server", async () => {
        process.env.FAKE_SCENARIO = "hang";
        const a = await makeAgent();
        const running = a.run("go");
        await until(() => JSON.stringify(a.events).includes("sleep 60"), "the command");
        writeFileSync(CRASH, "");
        expect(await running).toBe("error");
        process.env.FAKE_SCENARIO = "cmd";
        expect(await a.run("again")).toBe("done");
        expect(pids()).toHaveLength(2);
        expect(calls("thread/resume").map((p) => p.threadId)).toEqual(["thr-new"]);
        expect(calls("thread/start")).toHaveLength(1);
        expect(a.session.backends.get("codex")?.id).toBe("thr-new");
    });

    test("a crash while idle: its background command is reported stopped, and Codex hears so with the next prompt (resumed)", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_MS = "never";
        const a = await makeAgent();
        expect(await a.run("start it")).toBe("done");
        const [pid] = pids();
        writeFileSync(CRASH, "");
        await until(() => a.task("exec-turn-1-1")?.status === "stopped", "the task's end");
        expect(a.task("exec-turn-1-1")?.withProcess).toBe(true);
        expect(alive(pid!)).toBe(false);
        expect(a.wakes).toEqual([]);
        expect(await a.run("is it done?")).toBe("done");
        expect(calls("thread/resume").map((p) => p.threadId)).toEqual(["thr-new"]);
        expect(turnTexts()[1]).toMatch(/background command `sleep 1; echo bg 1` \(exec-turn-1-1\) stopped when Codex's app-server stopped[\s\S]*is it done\?/);
    });

    test("Harness quits with a background command running: the log keeps it running, and the reopened session tells Codex it stopped", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_MS = "never";
        const session = Session.create(cwd, {});
        const a = await makeAgent({ session });
        expect(await a.run("start it")).toBe("done");
        const [pid] = pids();
        expect(session.backgroundTasks.get("exec-turn-1-1")?.status).toBe("running");
        // Quitting: the agent is let go (its app-server stops), and what the app-server's end reports no longer
        // reaches the session (its agent is disposed): the log keeps the command running.
        agents.splice(agents.indexOf(a.agent), 1);
        await a.agent.dispose(500);
        await until(() => !alive(pid!), "the app-server to stop");
        expect(session.backgroundTasks.get("exec-turn-1-1")?.status).toBe("running");
        session.release();

        const reopened = Session.load(session.path);
        const b = await makeAgent({ session: reopened });
        expect(b.background.shown().map((t) => [t.id, t.status, t.lost])).toEqual([["exec-turn-1-1", "stopped", true]]);
        expect(await b.run("where were we?")).toBe("done");
        expect(pids()).toHaveLength(2);
        expect(calls("thread/resume").map((p) => p.threadId)).toEqual(["thr-new"]);
        expect(turnTexts()[1]).toContain("These background tasks stopped when Harness quit: background command: sleep 1; echo bg 1 (exec-turn-1-1).");
        reopened.release();
    });

    test("released while the session goes on (a sub-agent's run over, say): its background command is reported stopped with the app-server", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_MS = "never";
        const a = await makeAgent();
        expect(await a.run("start it")).toBe("done");
        const [pid] = pids();
        expect(a.task("exec-turn-1-1")?.status).toBe("running");
        await a.agent.releaseBackends();
        expect(alive(pid!)).toBe(false);
        await until(() => a.task("exec-turn-1-1")?.status === "stopped", "the task's end");
        expect(a.task("exec-turn-1-1")?.withProcess).toBe(true);
        expect(a.wakes).toEqual([]);
    });

    test("an agent that switched to another model's client still lets the Codex app-server it used go when it's disposed", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_MS = "never";
        const a = await makeAgent();
        expect(await a.run("start it")).toBe("done");
        const [pid] = pids();
        // Another provider now: Codex's client is no longer the agent's, but its app-server still runs the command.
        a.agent.setModel({ provider: "openai", id: "gpt-x" } as any, {} as any);
        expect(alive(pid!)).toBe(true);
        agents.splice(agents.indexOf(a.agent), 1);
        await a.agent.dispose(500);
        await until(() => !alive(pid!), "the app-server to stop");
    });
});

describe("the account changes during background work", () => {
    function accounts(ids: string[]) {
        const list = ids.map((id) => {
            const folder = join(iso.home, "accounts", "codex", id);
            mkdirSync(folder, { recursive: true });
            return { id, name: id, folder, managed: true };
        });
        registry.saveAgentConfig("codex", { path: codexBin, accounts: list });
        return list;
    }

    test("another account: a new app-server and thread (its CODEX_HOME), and the background command is reported stopped", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_MS = "never";
        const [personal, work] = accounts(["personal", "work"]);
        const a = await makeAgent();
        a.session.setAccount("codex", "personal");
        expect(await a.run("start it")).toBe("done");
        const [pid] = pids();
        // (The new app-server's first turn is a plain one.)
        process.env.FAKE_CODEX_SCENARIOS = "cmd";
        a.session.setAccount("codex", "work");
        expect(await a.run("now on work")).toBe("done");
        expect(a.task("exec-turn-1-1")?.status).toBe("stopped");
        expect(a.notices()).toContain("Codex starts a new thread for this session, so its background task stopped.");
        expect(alive(pid!)).toBe(false);
        const homes = logLines().flatMap((l) => (l.argv ? [l.codexHome] : []));
        expect(homes.map((h: string) => realpathSync(h))).toEqual([realpathSync(personal!.folder), realpathSync(work!.folder)]);
        expect(calls("thread/start")).toHaveLength(2);
    });

    test("the account protections change while it's idle: the app-server restarts before the next turn, which resumes the thread and tells Codex", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_MS = "never";
        accounts(["personal"]);
        const a = await makeAgent();
        a.session.setAccount("codex", "personal");
        expect(await a.run("start it")).toBe("done");
        const [pid] = pids();
        process.env.FAKE_CODEX_SCENARIOS = "cmd";
        // Another account's folder is protected now: the running app-server's sandbox doesn't deny it.
        accounts(["personal", "work"]);
        await Bun.sleep(600);
        expect(await a.run("next")).toBe("done");
        expect(alive(pid!)).toBe(false);
        expect(pids()).toHaveLength(2);
        expect(a.notices()).toContain("Codex was restarted for the account's protections, so its background task stopped.");
        expect(a.task("exec-turn-1-1")?.status).toBe("stopped");
        expect(calls("thread/resume").map((p) => p.threadId)).toEqual(["thr-new"]);
        expect(turnTexts()[1]).toContain("(exec-turn-1-1) stopped when Codex's app-server stopped");
    });
});

describe("wakes meet the user", () => {
    test("steering a wake turn: the message goes into it (turn/steer)", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,hang";
        process.env.FAKE_BG_MS = "100";
        process.env.FAKE_HANG_MS = "1500";
        process.env.FAKE_STEER_WAKES = "1";
        const a = await makeAgent();
        expect(await a.run("start it")).toBe("done");
        const w = await a.nextWake();
        const running = a.adopt(w);
        await until(() => JSON.stringify(a.events).includes("sleep 60"), "the wake turn's command");
        a.queue.push("also check the logs");
        a.agent.queueChanged();
        await until(() => calls("turn/steer").length > 0, "the steer");
        expect(calls("turn/steer").map((p) => [p.expectedTurnId, p.input[0].text])).toEqual([["turn-2", "also check the logs"]]);
        expect(await running).toBe("done");
        expect(logLines().find((l) => l.hangSteered)?.hangSteered).toEqual(["also check the logs"]);
    });

    test("a prompt sent as a wake turn starts (before it's adopted): it goes into that turn, and nothing is lost", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,hang,cmd";
        process.env.FAKE_BG_MS = "100";
        process.env.FAKE_HANG_MS = "800";
        process.env.FAKE_STEER_WAKES = "1";
        process.env.FAKE_ONE_TURN = "1";
        const a = await makeAgent();
        expect(await a.run("start it")).toBe("done");
        const w = await a.nextWake();
        await until(() => JSON.stringify(a.events).includes("sleep 60") || logLines().some((l) => l.received?.method === "turn/start" && l.received.params.input?.[0]?.text?.includes("has finished")), "the wake turn");
        expect(await a.run("what's the status?")).toBe("done");
        expect(a.notices()).toContain("Codex was already in a turn of its own, so your message went into that turn: its answer shows there.");
        expect(await a.adopt(w)).toBe("done");
        expect(logLines().find((l) => l.hangSteered)?.hangSteered.join("\n")).toContain("what's the status?");
    });

    test("a command ending while the user's turn runs: Codex hears in that turn (turn/steer), and no wake starts", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,hang";
        process.env.FAKE_BG_MS = "400";
        process.env.FAKE_HANG_MS = "1200";
        process.env.FAKE_STEER_WAKES = "1";
        const a = await makeAgent();
        expect(await a.run("start it")).toBe("done");
        expect(await a.run("meanwhile")).toBe("done");
        expect(logLines().find((l) => l.hangSteered)?.hangSteered.join("\n")).toContain("(process 40001) has finished");
        await Bun.sleep(200);
        expect(a.wakes).toEqual([]);
        expect(calls("turn/start")).toHaveLength(2);
    });
});

describe("forks, rewinds and compactions across a wake", () => {
    test("compaction while a command runs: on the same app-server; its end then wakes the session as before", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_MS = "1000";
        const a = await makeAgent();
        expect(await a.run("start it")).toBe("done");
        expect(await a.agent.compact({ auto: false, signal: new AbortController().signal })).toBe(true);
        expect(calls("thread/compact/start")).toHaveLength(1);
        expect(a.task("exec-turn-1-1")?.status).toBe("running");
        const w = await a.nextWake();
        expect(await a.adopt(w)).toBe("done");
        expect(a.task("exec-turn-1-1")?.status).toBe("done");
        expect(pids()).toHaveLength(1);
    });

    test("a rewind while a command runs: a new thread on a new app-server; the old one's command neither wakes nor reaches it", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_MS = "600";
        const a = await makeAgent();
        expect(await a.run("start it")).toBe("done");
        a.session.rewind(0);
        process.env.FAKE_CODEX_SCENARIOS = "cmd";
        expect(await a.run("start over")).toBe("done");
        expect(a.notices()).toContain("Codex starts a new thread for this session, so its background task stopped.");
        expect(calls("thread/start")).toHaveLength(2);
        expect(pids()).toHaveLength(2);
        await Bun.sleep(800);
        expect(a.wakes).toEqual([]);
        expect(a.task("exec-turn-1-1")?.status).toBe("stopped");
    });

    test("the original of a fork goes on in a copy of its thread on the same app-server; the command's end wakes it there", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd,cmd";
        process.env.FAKE_BG_MS = "800";
        const session = Session.create(cwd, {});
        const a = await makeAgent({ session });
        expect(await a.run("start it")).toBe("done");
        const fork = forkSession(session, { cut: session.messages.length });
        expect(await a.run("go on here")).toBe("done");
        const forked = calls("thread/fork");
        expect(forked.map((p) => p.threadId)).toEqual(["thr-new"]);
        const copy = calls("turn/start")[1].threadId;
        expect(copy).toStartWith("thr-fork-");
        expect(a.task("exec-turn-1-1")?.status).toBe("running");
        const w = await a.nextWake();
        expect(await a.adopt(w)).toBe("done");
        expect(calls("turn/start")[2].threadId).toBe(copy);
        expect(pids()).toHaveLength(1);
        fork.release();
        session.release();
    });
});

describe("review round 1 (#293)", () => {
    test("Esc while a steer sent as the turn ended is unanswered, and Codex refuses it: the message reaches Codex with the next prompt", async () => {
        process.env.FAKE_SCENARIO = "hang";
        process.env.FAKE_HANG_MS = "300";
        process.env.FAKE_STEER_DELAY_MS = "800";
        process.env.FAKE_STEER_FAIL = "1";
        const a = await makeAgent();
        const esc = new AbortController();
        const running = a.run("go", esc.signal);
        await until(() => JSON.stringify(a.events).includes("sleep 60"), "the command");
        a.queue.push("and check the logs");
        a.agent.queueChanged();
        await until(() => calls("turn/steer").length > 0, "the steer");
        await until(() => logLines().some((l) => l.hangEnded), "the turn's end");
        await Bun.sleep(100);
        esc.abort();
        expect(await running).toBe("aborted");
        for (const k of ["FAKE_STEER_DELAY_MS", "FAKE_STEER_FAIL", "FAKE_HANG_MS"]) delete process.env[k];
        process.env.FAKE_SCENARIO = "cmd";
        expect(await a.run("next")).toBe("done");
        expect(turnTexts().at(-1)).toContain("and check the logs");
    });

    test("live sessions turned off with an app-server running: it goes (its background command reported stopped with it) before the per-turn app-server runs", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_MS = "never";
        const a = await makeAgent();
        expect(await a.run("start it")).toBe("done");
        const [pid] = pids();
        a.settings.agentCli = { liveSessions: false };
        expect(await a.run("again")).toBe("done");
        expect(alive(pid!)).toBe(false);
        expect(a.task("exec-turn-1-1")?.status).toBe("stopped");
        expect(a.task("exec-turn-1-1")?.withProcess).toBe(true);
        expect(a.notices().join("\n")).toContain("background task");
    });

    test("HARNESS_DEBUG: a wake's label (a command, perhaps with a credential in it) isn't logged", async () => {
        const file = join(bin, "live-cli.log");
        rmSync(file, { force: true });
        process.env.HARNESS_DEBUG = "1";
        process.env.HARNESS_DEBUG_FILE = file;
        try {
            process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
            process.env.FAKE_BG_MS = "100";
            process.env.FAKE_BG_COMMAND = "curl -u alice:private-password https://example.invalid";
            const a = await makeAgent();
            expect(await a.run("start it")).toBe("done");
            await a.nextWake();
            await until(() => existsSync(file) && readFileSync(file, "utf-8").includes('"what":"wake"'), "the wake's line");
            expect(readFileSync(file, "utf-8")).not.toContain("private-password");
        } finally {
            delete process.env.HARNESS_DEBUG;
            delete process.env.HARNESS_DEBUG_FILE;
        }
    });

    test("a finished command's note (no wake for it) survives the app-server's crash: Codex hears with the next prompt", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_MS = "100";
        const a = await makeAgent({ settings: { codex: { wakeOnBackgroundCommand: false } } });
        expect(await a.run("start it")).toBe("done");
        await until(() => a.task("exec-turn-1-1")?.status === "done", "the command's end");
        const [pid] = pids();
        writeFileSync(CRASH, "");
        await until(() => !alive(pid!), "the crash");
        rmSync(CRASH, { force: true });
        expect(await a.run("is it done?")).toBe("done");
        expect(turnTexts().at(-1)).toMatch(/background command `sleep 1; echo bg 1` you started earlier[\s\S]*has finished[\s\S]*is it done\?/);
    });

    test("a turn/start Codex refuses doesn't use up the notes it carried: the next prompt has them", async () => {
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd,cmd";
        process.env.FAKE_BG_MS = "100";
        process.env.FAKE_FAIL_TURN_START_AT = "2";
        const a = await makeAgent({ settings: { codex: { wakeOnBackgroundCommand: false } } });
        expect(await a.run("start it")).toBe("done");
        await until(() => a.task("exec-turn-1-1")?.status === "done", "the command's end");
        expect(await a.run("refused")).toBe("error");
        expect(await a.run("is it done?")).toBe("done");
        expect(turnTexts().at(-1)).toMatch(/you started earlier[\s\S]*has finished[\s\S]*is it done\?/);
    });

    test("turn/started before turn/start's answer: the turn is the prompt's, and no wake is made of it", async () => {
        process.env.FAKE_STARTED_FIRST = "1";
        const a = await makeAgent();
        expect(await a.run("one")).toBe("done");
        expect(await a.run("two")).toBe("done");
        await Bun.sleep(200);
        expect(a.wakes).toEqual([]);
        expect(pids()).toHaveLength(1);
    });
});
