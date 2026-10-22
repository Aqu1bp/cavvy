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
        expect(told[0]!.tag).toBe(`background:${id}:bash_1:${done.startedAt}`);
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
