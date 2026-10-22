// Session-level background tasks in a GUI session (#219 PR 2; the real Engine
// and Runtime, the mock model): one list of what runs in the background, whoever
// runs it (an agent CLI's tasks, the session's own shells); session.stopBackground
// stops them; the list is kept in the session log, and a task that was running
// when Harness quit shows as stopped then, and the agent is told once.

import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
import type { ServerEvent, SessionSnapshot } from "../src/server/protocol";
import { backendModel, type BackendTurn, type BackgroundStop } from "../src/backends/types";
import type { BackgroundShell } from "../src/tools/types";
import type { BackgroundTaskInfo } from "../src/backends/live/info";

const mock = startMockLlm({ delayMs: 0 });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));
afterAll(() => {
    mock.stop();
    iso.cleanup();
});

/** Every event the engine sent, by client. */
const sent = new WeakMap<object, ServerEvent[]>();

function client(engine: InstanceType<typeof Engine>) {
    const events: ServerEvent[] = [];
    const c = { subs: new Set<string>(), send: (e: ServerEvent) => void events.push(e) };
    engine.clients.add(c as never);
    sent.set(c, events);
    return c as never;
}

const notices = (c: object) => (sent.get(c) ?? []).flatMap((e) => (e.type === "notify" && e.kind === "background" ? [e] : []));

async function session(cwd = createDemoProject(tempDir("harness-bg-proj-"), { git: false })) {
    const engine = new Engine();
    const c = client(engine);
    const snap = (await engine.handle(c, "session.create", { cwd })) as SessionSnapshot;
    const id = snap.state.id;
    const rt = engine.runtimes.get(id)!;
    await rt.ready;
    return { engine, c, id, cwd, rt };
}

async function until(pred: () => boolean, ms = 10_000) {
    const end = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(20);
    }
}

/** A background shell of the harness's own, as Bash leaves one (without a process). */
function shell(id: string, command: string): BackgroundShell & { killed: number } {
    const s = {
        id,
        command,
        startedAt: Date.now(),
        output: "",
        readOffset: 0,
        exitCode: null as number | null,
        killed: 0,
        kill: async () => {
            s.killed++;
            s.exitCode = 143;
            return "stopped" as const;
        },
    };
    return s;
}

/** An agent CLI that reports a background task during its turn, and stops it when asked. */
function cliBackend(stops: { key: string; ids?: string[] }[]) {
    let session: BackendTurn["session"] | undefined;
    const task: BackgroundTaskInfo = { id: "task-cli-1", provider: "fake-cli", kind: "agent", label: "Map the auth module", toolUseId: "toolu_1", startedAt: Date.now(), status: "running", stoppable: true };
    return {
        agentBackend: true as const,
        setMode() {},
        listModels: async () => [],
        stream: async () => {
            throw new Error("not used");
        },
        compact: async () => ({ reason: "done" as const, text: "", actions: [] }),
        runTurn: async (t: BackendTurn) => {
            session = t.session;
            t.session.emitSession?.({ type: "background_task", task });
            return { reason: "done" as const, text: "Started it in the background.", actions: [] };
        },
        stopBackground: async (key: string, ids?: string[]): Promise<Record<string, BackgroundStop>> => {
            stops.push({ key, ids });
            session?.emitSession?.({ type: "background_task", task: { ...task, status: "stopped" } });
            return Object.fromEntries((ids ?? [task.id]).map((id) => [id, "stopped" as const]));
        },
    };
}

const logLines = (path: string) =>
    readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));

test("the session's background list has an agent CLI's tasks and its own shells, and session.stopBackground stops them", async () => {
    const { engine, c, id, rt } = await session();
    try {
        const stops: { key: string; ids?: string[] }[] = [];
        rt.agent!.setModel(backendModel("fake-cli", "x"), cliBackend(stops) as never);
        await engine.handle(c, "session.send", { id, text: "map auth in the background" });
        await until(() => rt.idle);
        const sh = shell("bash_1", "npm run dev");
        rt.toolState.shells.set(sh.id, sh);
        // The next tool's end, or the panel's poll, looks at the shells: a stop does too.
        await engine.handle(c, "session.stopBackground", { id, ids: [] });
        expect(rt.snapshot().state.backgroundTasks).toMatchObject([
            { id: "task-cli-1", provider: "fake-cli", kind: "agent", label: "Map the auth module", status: "running", stoppable: true },
            { id: "bash_1", provider: "harness", kind: "shell", label: "npm run dev", status: "running", stoppable: true },
        ]);
        // One by id: the CLI's goes to its backend, for this session.
        expect(await engine.handle(c, "session.stopBackground", { id, ids: ["task-cli-1"] })).toEqual({ results: { "task-cli-1": "stopped" } });
        expect(stops).toEqual([{ key: id, ids: ["task-cli-1"] }]);
        expect(rt.snapshot().state.backgroundTasks!.filter((t) => t.status === "running").map((t) => t.id)).toEqual(["bash_1"]);
        // Every one running: the shell.
        expect(await engine.handle(c, "session.stopBackground", { id })).toEqual({ results: { bash_1: "stopped" } });
        expect(sh.killed).toBe(1);
        expect(rt.snapshot().state.backgroundTasks!.filter((t) => t.status === "running")).toEqual([]);
        expect(await engine.handle(c, "session.stopBackground", { id, ids: ["nope"] })).toEqual({ results: { nope: "unknown" } });
        await expect(engine.handle(c, "session.stopBackground", { id, ids: "bash_1" })).rejects.toThrow("ids must be a list");
        // Each start and end is in the session log.
        const lines = logLines(rt.session.path).filter((l) => l.t === "bgtask");
        expect(lines.map((l) => [l.task.id, l.task.status])).toEqual([
            ["task-cli-1", "running"],
            ["bash_1", "running"],
            ["task-cli-1", "stopped"],
            // Killed by the user's stop (exit 143): stopped, not failed.
            ["bash_1", "stopped"],
        ]);
        // The user's own stops are no news; both are listed as finished until cleared.
        expect(notices(c)).toEqual([]);
        expect(rt.snapshot().state.backgroundTasks!.map((t) => [t.id, t.status])).toEqual([
            ["task-cli-1", "stopped"],
            ["bash_1", "stopped"],
        ]);
    } finally {
        await engine.stop();
    }
});

test("a task running when Harness quit shows as stopped then when the session is opened again, and the agent is told once", async () => {
    const first = await session();
    const { id } = first;
    let path: string;
    try {
        await first.engine.handle(first.c, "session.send", { id, text: "hello" });
        await until(() => first.rt.idle && first.rt.session.messages.some((m) => m.role === "assistant"));
        const sh = shell("bash_1", "npm run watch");
        first.rt.toolState.shells.set(sh.id, sh);
        await first.engine.handle(first.c, "session.stopBackground", { id, ids: [] });
        path = first.rt.session.path;
        expect(logLines(path).filter((l) => l.t === "bgtask").map((l) => l.task.status)).toEqual(["running"]);
        // Harness quits with it running (its stop isn't written: the process is gone, not the task's own end).
        first.rt.toolState.shells.delete(sh.id);
    } finally {
        await first.engine.stop();
    }

    const engine = new Engine();
    const c = client(engine);
    try {
        const snap = (await engine.handle(c, "session.open", { id })) as SessionSnapshot;
        expect(snap.state.backgroundTasks).toMatchObject([{ id: "bash_1", kind: "shell", label: "npm run watch", status: "stopped", lost: true }]);
        const rt = engine.runtimes.get(id)!;
        // What ended before isn't news again.
        expect(notices(c)).toEqual([]);
        await rt.ready;
        await engine.handle(c, "session.send", { id, text: "what happened?" });
        await until(() => rt.idle && rt.session.messages.filter((m) => m.role === "assistant").length >= 2);
        const sent = JSON.stringify([...mock.bodies].reverse().find((b) => b.tools?.length)?.messages ?? []);
        expect(sent).toContain("These background tasks stopped when Harness quit: background command: npm run watch (bash_1)");
        expect(rt.snapshot().state.backgroundTasks).toEqual([]);
        expect(logLines(path!).filter((l) => l.t === "bgtask").map((l) => [l.task.status, l.task.lost ?? false])).toEqual([
            ["running", false],
            ["stopped", true],
        ]);
    } finally {
        await engine.stop();
    }

    // Told once: opened again, nothing is shown or said.
    const again = new Engine();
    const c3 = client(again);
    try {
        const snap = (await again.handle(c3, "session.open", { id })) as SessionSnapshot;
        expect(snap.state.backgroundTasks).toEqual([]);
    } finally {
        await again.stop();
    }
});

test("a task that ends on its own is news (a notify event, tagged per task), stays listed as finished, and can be cleared", async () => {
    const { engine, c, id, rt } = await session();
    try {
        const done = shell("bash_1", "npm test");
        const fails = shell("bash_2", "npm run lint");
        rt.toolState.shells.set(done.id, done);
        rt.toolState.shells.set(fails.id, fails);
        await engine.handle(c, "session.stopBackground", { id, ids: [] });
        expect(notices(c)).toEqual([]);
        done.exitCode = 0;
        fails.exitCode = 1;
        await engine.handle(c, "session.stopBackground", { id, ids: [] });
        const told = notices(c);
        expect(told.map((e) => [e.body.replace(/ \(\d+s\)$/, ""), e.task, e.sessionId])).toEqual([
            ["Background command finished: npm test", { id: "bash_1", outcome: "done" }, id],
            ["Background command failed: npm run lint", { id: "bash_2", outcome: "failed" }, id],
        ]);
        expect(told[0]!.tag).toBe(`background:${id}:bash_1:${done.startedAt}:done`);
        expect(new Set(told.map((e) => e.tag)).size).toBe(2);
        // Said once: looking again says nothing more.
        await engine.handle(c, "session.stopBackground", { id, ids: [] });
        expect(notices(c)).toHaveLength(2);
        expect(rt.snapshot().state.backgroundTasks!.map((t) => [t.id, t.status])).toEqual([
            ["bash_1", "done"],
            ["bash_2", "failed"],
        ]);
        await engine.handle(c, "session.clearBackground", { id });
        expect(rt.snapshot().state.backgroundTasks).toEqual([]);
    } finally {
        await engine.stop();
    }
});

test("a shell the agent stops with KillShell is kept as stopped in the log, so reopening doesn't say Harness's quitting stopped it (#282 review 4)", async () => {
    const { KillShellTool } = await import("../src/tools/bash");
    const first = await session();
    const { id } = first;
    let path: string;
    try {
        await first.engine.handle(first.c, "session.send", { id, text: "hello" });
        await until(() => first.rt.idle && first.rt.session.messages.some((m) => m.role === "assistant"));
        const sh = shell("bash_1", "npm run watch");
        first.rt.toolState.shells.set(sh.id, sh);
        await first.engine.handle(first.c, "session.stopBackground", { id, ids: [] });
        // The agent's own KillShell: it stops the shell and takes it out of the list.
        await KillShellTool.run({ shell_id: "bash_1" }, { state: first.rt.toolState } as never);
        expect(first.rt.toolState.shells.has("bash_1")).toBe(false);
        // The tool's end looks at the shells again (as any look does).
        await first.engine.handle(first.c, "session.stopBackground", { id, ids: [] });
        path = first.rt.session.path;
        expect(logLines(path).filter((l) => l.t === "bgtask").map((l) => l.task.status)).toEqual(["running", "stopped"]);
        expect(first.rt.snapshot().state.backgroundTasks!.map((t) => [t.id, t.status])).toEqual([["bash_1", "stopped"]]);
        // The agent stopped it: that's no news.
        expect(notices(first.c)).toEqual([]);
    } finally {
        await first.engine.stop();
    }
    const again = new Engine();
    const c = client(again);
    try {
        const snap = (await again.handle(c, "session.open", { id })) as SessionSnapshot;
        expect(snap.state.backgroundTasks).toEqual([]);
    } finally {
        await again.stop();
    }
});

function stubCli(task: BackgroundTaskInfo, stopAnswer: BackgroundStop) {
    const h: { session?: BackendTurn["session"] } = {};
    const backend = {
        agentBackend: true as const,
        setMode() {},
        listModels: async () => [],
        stream: async () => {
            throw new Error("not used");
        },
        compact: async () => ({ reason: "done" as const, text: "", actions: [] }),
        runTurn: async (t: BackendTurn) => {
            h.session = t.session;
            t.session.emitSession?.({ type: "background_task", task });
            return { reason: "done" as const, text: "Started.", actions: [] };
        },
        stopBackground: async (_key: string, ids?: string[]) => Object.fromEntries((ids ?? []).map((i) => [i, stopAnswer])),
    };
    return { backend, h };
}

test("review round 2, A1/B4: Stop all on a task that can't be stopped doesn't make it the user's: when it ends on its own, the user is told", async () => {
    const { engine, c, id, rt } = await session();
    try {
        const task: BackgroundTaskInfo = { id: "cli-ns", provider: "fake-cli", kind: "agent", label: "Map auth", startedAt: Date.now(), status: "running", stoppable: false };
        const { backend, h } = stubCli(task, "stopped");
        rt.agent!.setModel(backendModel("fake-cli", "x"), backend as never);
        await engine.handle(c, "session.send", { id, text: "go" });
        await until(() => rt.idle);
        expect(await engine.handle(c, "session.stopBackground", { id })).toEqual({ results: { "cli-ns": "not_stoppable" } });
        h.session!.emitSession?.({ type: "background_task", task: { ...task, status: "done" } });
        expect(notices(c).map((n) => [n.task?.id, n.task?.outcome])).toEqual([["cli-ns", "done"]]);
    } finally {
        await engine.stop?.();
    }
});

test("review round 2, A1/B4: a stop the CLI refuses, then the task fails on its own: shown failed and announced", async () => {
    const { engine, c, id, rt } = await session();
    try {
        const task: BackgroundTaskInfo = { id: "cli-rf", provider: "fake-cli", kind: "agent", label: "Map auth", startedAt: Date.now(), status: "running", stoppable: true };
        const { backend, h } = stubCli(task, "failed");
        rt.agent!.setModel(backendModel("fake-cli", "x"), backend as never);
        await engine.handle(c, "session.send", { id, text: "go" });
        await until(() => rt.idle);
        expect(await engine.handle(c, "session.stopBackground", { id, ids: ["cli-rf"] })).toEqual({ results: { "cli-rf": "failed" } });
        h.session!.emitSession?.({ type: "background_task", task: { ...task, status: "failed" } });
        expect(rt.snapshot().state.backgroundTasks!.find((t) => t.id === "cli-rf")?.status).toBe("failed");
        expect(notices(c).map((n) => [n.task?.id, n.task?.outcome])).toEqual([["cli-rf", "failed"]]);
    } finally {
        await engine.stop?.();
    }
});

test("review round 2, A1/B4: a task that ends while its stop is being answered: the answer decides whether it's news", async () => {
    const { engine, c, id, rt } = await session();
    try {
        const a: BackgroundTaskInfo = { id: "cli-a", provider: "fake-cli", kind: "agent", label: "Map auth", startedAt: Date.now(), status: "running", stoppable: true };
        const b: BackgroundTaskInfo = { ...a, id: "cli-b", label: "Map billing" };
        const { backend, h } = stubCli(a, "stopped");
        const answers: Record<string, BackgroundStop> = { "cli-a": "failed", "cli-b": "stopped" };
        // Each task ends while its stop is pending: a refused stop's end is news; a stop that went through, not.
        backend.stopBackground = async (_key: string, ids?: string[]) => {
            for (const i of ids ?? []) h.session!.emitSession?.({ type: "background_task", task: { ...(i === "cli-a" ? a : b), status: i === "cli-a" ? "done" : "stopped" } });
            return Object.fromEntries((ids ?? []).map((i) => [i, answers[i]!]));
        };
        rt.agent!.setModel(backendModel("fake-cli", "x"), backend as never);
        await engine.handle(c, "session.send", { id, text: "go" });
        await until(() => rt.idle);
        h.session!.emitSession?.({ type: "background_task", task: b });
        expect(rt.snapshot().state.backgroundTasks!.filter((t) => t.status === "running").map((t) => t.id)).toEqual(["cli-a", "cli-b"]);
        await engine.handle(c, "session.stopBackground", { id });
        expect(notices(c).map((n) => [n.task?.id, n.task?.outcome])).toEqual([["cli-a", "done"]]);
        expect(rt.snapshot().state.backgroundTasks!.map((t) => [t.id, t.status])).toEqual([["cli-a", "done"], ["cli-b", "stopped"]]);
    } finally {
        await engine.stop?.();
    }
});

test("review round 2, A1/B4: a stop not confirmed in time: ending stopped it was the user's; ending done, it's news", async () => {
    const { engine, c, id, rt } = await session();
    try {
        const a: BackgroundTaskInfo = { id: "cli-a", provider: "fake-cli", kind: "agent", label: "Map auth", startedAt: Date.now(), status: "running", stoppable: true };
        const b: BackgroundTaskInfo = { ...a, id: "cli-b", label: "Map billing" };
        const { backend, h } = stubCli(a, "timeout");
        rt.agent!.setModel(backendModel("fake-cli", "x"), backend as never);
        await engine.handle(c, "session.send", { id, text: "go" });
        await until(() => rt.idle);
        h.session!.emitSession?.({ type: "background_task", task: b });
        expect(await engine.handle(c, "session.stopBackground", { id })).toEqual({ results: { "cli-a": "timeout", "cli-b": "timeout" } });
        h.session!.emitSession?.({ type: "background_task", task: { ...a, status: "stopped" } });
        h.session!.emitSession?.({ type: "background_task", task: { ...b, status: "done" } });
        expect(notices(c).map((n) => [n.task?.id, n.task?.outcome])).toEqual([["cli-b", "done"]]);
    } finally {
        await engine.stop?.();
    }
});

test("review round 2, A4/B5: a delegated task a call waits on is never listed, logged, or announced; one that runs on after the wait is background work", async () => {
    const { Delegations } = await import("../src/agent/delegation");
    const { engine, c, rt } = await session();
    try {
        const finish: ((r: any) => void)[] = [];
        const d = new Delegations(
            () => new Promise((r) => finish.push(r)),
            undefined,
            () => (rt as any).syncBackground(),
        );
        (rt.agent as any).delegations = d;
        const recorded: string[] = [];
        const orig = rt.session.recordBackgroundTask.bind(rt.session);
        rt.session.recordBackgroundTask = (x) => (recorded.push(`${x.id}:${x.status}`), orig(x));
        const done = { status: "done", report: "LGTM", model: "gemini:gemini-test", tokens: 1, durationMs: 5 };
        // As the delegate tool does: started as the call's own work, then waited on.
        const t = d.start({ description: "Review the diff", prompt: "review", agent: "explore", model: "gemini:gemini-test", writes: false, foreground: true }) as any;
        const waiting = d.waitForeground(t, 10_000, undefined, true);
        expect(rt.snapshot().state.backgroundTasks ?? []).toEqual([]);
        finish[0]!(done);
        await waiting;
        expect(t.status).toBe("done");
        expect(rt.snapshot().state.backgroundTasks ?? []).toEqual([]);
        expect(recorded).toEqual([]);
        // An older order (listed first, then waited on): never "stopped" either.
        const u = d.start({ description: "Review the tests", prompt: "review", agent: "explore", model: "gemini:gemini-test", writes: false }) as any;
        const waitingU = d.waitForeground(u, 10_000);
        finish[1]!(done);
        await waitingU;
        expect(rt.snapshot().state.backgroundTasks!.map((x) => [x.id, x.status])).toEqual([[u.id, "done"]]);
        expect(recorded).toEqual([`${u.id}:running`, `${u.id}:done`]);
        // A wait that runs out: it's background work from then on.
        const w = d.start({ description: "Review the docs", prompt: "review", agent: "explore", model: "gemini:gemini-test", writes: false, foreground: true }) as any;
        await d.waitForeground(w, 10, undefined, true);
        expect(rt.snapshot().state.backgroundTasks!.filter((x) => x.status === "running").map((x) => x.id)).toEqual([w.id]);
        finish[2]!(done);
        await w.settled;
        expect(notices(c).map((n) => n.task?.id)).toEqual([u.id, w.id]);
    } finally {
        await engine.stop?.();
    }
});

test("review round 2, B3: a task said to be done, then to have failed: Finished says failed, and that's news again (its own tag)", async () => {
    const { engine, c, id, rt } = await session();
    try {
        const task: BackgroundTaskInfo = { id: "cli-rv", provider: "fake-cli", kind: "agent", label: "Map auth", startedAt: Date.now(), status: "running", stoppable: true };
        const { backend, h } = stubCli(task, "stopped");
        rt.agent!.setModel(backendModel("fake-cli", "x"), backend as never);
        await engine.handle(c, "session.send", { id, text: "go" });
        await until(() => rt.idle);
        h.session!.emitSession?.({ type: "background_task", task: { ...task, status: "done" } });
        expect(rt.snapshot().state.backgroundTasks!.map((t) => [t.id, t.status])).toEqual([["cli-rv", "done"]]);
        h.session!.emitSession?.({ type: "background_task", task: { ...task, status: "failed" } });
        expect(rt.snapshot().state.backgroundTasks!.map((t) => [t.id, t.status])).toEqual([["cli-rv", "failed"]]);
        expect(notices(c).map((n) => [n.task?.id, n.task?.outcome])).toEqual([["cli-rv", "done"], ["cli-rv", "failed"]]);
        expect(new Set(notices(c).map((n) => n.tag)).size).toBe(2);
        // Said the same again: nothing new.
        h.session!.emitSession?.({ type: "background_task", task: { ...task, status: "failed" } });
        expect(notices(c).length).toBe(2);
    } finally {
        await engine.stop?.();
    }
});
