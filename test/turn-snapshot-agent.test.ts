import { afterAll, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { AssistantMessage, ProviderClient } from "../src/providers/types";
import type { BackendTurn } from "../src/backends/types";

const iso = isolate();
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { gitArgv, gitEnv } = await import("../src/util/git");
const dirs: string[] = [];
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    iso.cleanup();
});

const answer = (): AssistantMessage => ({ role: "assistant", provider: "test", model: "test", content: [{ type: "text", text: "done" }], stopReason: "end_turn" });
function setup(client: ProviderClient, opts: { trusted?: boolean; subagent?: boolean; queue?: string[][]; tools?: any[]; settings?: any } = {}) {
    const cwd = realpathSync(tempDir("harness-turn-agent-"));
    dirs.push(cwd);
    const session = Session.create(cwd, { system: "test" });
    const settings = { autoCompact: false, delegation: false, ...opts.settings };
    const agent = new Agent({
        session,
        client,
        model: { provider: "test", id: "test" },
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: opts.tools ?? [],
        mode: { get: () => "bypassPermissions", set() {} },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        trusted: () => opts.trusted ?? true,
        isSubagent: opts.subagent,
        host: { emit() {}, ui: {}, drainQueued: () => opts.queue?.shift() ?? [] },
    });
    const run = () => agent.run([{ type: "text", text: "first" }], { signal: new AbortController().signal });
    return { agent, session, run };
}

function recordSnapshots(agent: InstanceType<typeof Agent>, events: string[]) {
    agent.turnSnapshots!.begin = async (_cp, prompt) => {
        await Promise.resolve();
        events.push(`start:${prompt}`);
    };
    agent.turnSnapshots!.end = async () => {
        await Promise.resolve();
        events.push("end");
    };
}

test("API prompt and queued prompt wait for start snapshots; run waits for its end snapshot", async () => {
    const events: string[] = [];
    const { agent, session, run } = setup({ stream: async () => (events.push("model"), answer()), listModels: async () => [] }, { queue: [["steered"], []] });
    recordSnapshots(agent, events);
    await run();
    expect(events).toEqual(["start:first", "model", "start:steered", "model", "end"]);
    expect(session.messages.filter((m) => m.role === "user").every((m) => m.meta?.checkpoint !== undefined)).toBe(true);
    session.release();
});

test("backend queued prompts wait for start snapshots before backend work resumes", async () => {
    const events: string[] = [];
    const backend = {
        agentBackend: true as const,
        setMode() {},
        listModels: async () => [],
        stream: async () => answer(),
        compact: async () => ({ reason: "done" as const, text: "", actions: [] }),
        runTurn: async (turn: BackendTurn) => {
            events.push("backend:first");
            const queued = await turn.host.drainQueued();
            events.push(`backend:${queued.join()}`);
            return { reason: "done" as const, text: "done", actions: [] };
        },
    };
    const { agent, session, run } = setup(backend, { queue: [["steered"]] });
    recordSnapshots(agent, events);
    await run();
    expect(events).toEqual(["start:first", "backend:first", "start:steered", "backend:steered", "end"]);
    session.release();
});

test("tool-result steering gets a snapshot id while edit copies stay with the original rewind target", async () => {
    const events: string[] = [];
    let requests = 0;
    let beforeSteering = async () => {};
    let afterSteering = async () => {};
    const client = {
        stream: async (): Promise<AssistantMessage> => {
            if (++requests === 1) return { ...answer(), content: [{ type: "tool_call", id: "read-1", name: "Probe", input: {} }], stopReason: "tool_use" };
            await afterSteering();
            return answer();
        },
        listModels: async () => [],
    };
    const probe = { name: "Probe", description: "test", parameters: { type: "object", properties: {} }, category: "read", readOnly: true, title: () => "probe", run: async () => (await beforeSteering(), { content: "ok" }) };
    const { agent, session, run } = setup(client, { queue: [["during tools"]], tools: [probe] });
    const history = agent.state.fileHistory!;
    const same = join(agent.state.cwd, "same.txt");
    const late = join(agent.state.cwd, "late.txt");
    writeFileSync(same, "original");
    beforeSteering = () => history.write(same, Buffer.from("before steering"));
    afterSteering = async () => {
        await history.write(same, Buffer.from("after steering"));
        await history.write(late, Buffer.from("created after steering"));
    };
    recordSnapshots(agent, events);
    await run();
    expect(events).toEqual(["start:first", "start:during tools", "end"]);
    const results = session.messages.find((m) => m.role === "user" && m.meta?.kind === "tool_results");
    const first = session.messages[0]!;
    const originalId = first.role === "user" ? first.meta!.checkpoint! : 0;
    const steeringId = results?.role === "user" ? results.meta!.checkpoint! : 0;
    expect(steeringId).toBeGreaterThan(originalId);
    expect(history.filesIn(originalId).sort()).toEqual([same, late].sort());
    expect(history.filesIn(steeringId)).toEqual([]);
    const original = history.originals().find((file) => file.path === same)!;
    expect(history.savedCopy(original.hash!)?.toString()).toBe("original");
    session.release();
});

test("untrusted agents do not begin snapshots and subagents do not own them", async () => {
    const client = { stream: async () => answer(), listModels: async () => [] };
    const events: string[] = [];
    const untrusted = setup(client, { trusted: false });
    recordSnapshots(untrusted.agent, events);
    await untrusted.run();
    expect(events).toEqual(["end"]);
    const child = setup(client, { subagent: true });
    expect(child.agent.turnSnapshots).toBeUndefined();
    await child.run();
    untrusted.session.release();
    child.session.release();
});

test("blocked prompt hooks still finish the snapshot without adding a transcript prompt", async () => {
    const events: string[] = [];
    const { agent, session, run } = setup({ stream: async () => (events.push("model"), answer()), listModels: async () => [] }, { settings: { hooks: { UserPromptSubmit: [{ command: "exit 2" }] } } });
    recordSnapshots(agent, events);
    expect(await run()).toBe("blocked");
    expect(events).toEqual(["start:first", "end"]);
    expect(session.messages).toHaveLength(0);
    session.release();
});


test("a real agent turn captures shell edits and a stubbed backend's writes together", async () => {
    const backend = {
        agentBackend: true as const,
        setMode() {},
        listModels: async () => [],
        stream: async () => answer(),
        compact: async () => ({ reason: "done" as const, text: "", actions: [] }),
        runTurn: async (turn: BackendTurn) => {
            const shell = Bun.spawnSync(["sh", "-c", "printf 'shell after\\n' > shell.txt"], { cwd: turn.cwd });
            expect(shell.exitCode).toBe(0);
            writeFileSync(join(turn.cwd, "backend.txt"), "backend after\n");
            return { reason: "done" as const, text: "done", actions: [] };
        },
    };
    const { agent, session, run } = setup(backend);
    const cwd = agent.state.cwd;
    const env = gitEnv();
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    const init = Bun.spawnSync(gitArgv(["init", "-q"]), { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(init.exitCode).toBe(0);
    writeFileSync(join(cwd, "shell.txt"), "shell before\n");
    writeFileSync(join(cwd, "backend.txt"), "backend before\n");
    await run();
    const changes = await agent.turnSnapshots!.changes({ scope: "last-turn" });
    expect(changes.files.map((f) => f.path).sort()).toEqual(["backend.txt", "shell.txt"]);
    expect(changes.files.every((f) => f.added === 1 && f.removed === 1)).toBe(true);
    session.release();
});
