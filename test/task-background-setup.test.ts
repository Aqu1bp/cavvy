// A background Task in an API session: a Stop while it's being set up (its agent type's model still
// resolving) means it doesn't start afterwards (#259), as the MCP delegate path already does.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { TaskTool } = await import("../src/tools/meta-tools");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { App } = await import("../src/ui/app");
const { runCommand } = await import("../src/commands/index");
afterAll(() => iso.cleanup());

const reply = (content: unknown[], stopReason: string) => ({ role: "assistant", content, provider: "anthropic", model: "claude-x", stopReason, usage: { inputTokens: 1, outputTokens: 1 } });

/** An agent whose model starts a background agent of a type on another model, with that model's lookup held. */
function setup() {
    const proj = tempDir("task-bg-setup-");
    mkdirSync(join(iso.home, "agents"), { recursive: true });
    writeFileSync(join(iso.home, "agents", "bg.md"), "---\nname: bg\ndescription: background agent\nmodel: openai:gpt-x\nbackground: true\n---\nYou are a background helper.\n");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let resolving = 0;
    const childRequests: unknown[] = [];
    const childModel = { provider: "openai", id: "gpt-x", contextWindow: 128_000, maxOutput: 16_000, pricing: { input: 1, output: 1 } };
    const childClient = {
        async stream(req: unknown) {
            childRequests.push(req);
            return { ...reply([{ type: "text", text: "child report" }], "end_turn"), provider: "openai", model: "gpt-x" };
        },
        async listModels() {
            return [];
        },
    };
    let calls = 0;
    const session = Session.create(proj, { system: "sys" });
    const settings = {} as any;
    const agent = new Agent({
        session,
        model: { provider: "anthropic", id: "claude-x", contextWindow: 200_000, maxOutput: 32_000, pricing: { input: 3, output: 15 } },
        client: {
            async stream() {
                if (++calls === 1) return reply([{ type: "tool_call", id: "t1", name: "Task", input: { description: "delayed task", prompt: "do x", subagent_type: "bg" } }], "tool_use");
                return reply([{ type: "text", text: "ok" }], "end_turn");
            },
            async listModels() {
                return [];
            },
        } as any,
        settings: () => settings,
        checker: new PermissionChecker(() => settings, proj),
        tools: [TaskTool],
        mode: { get: () => "bypassPermissions", set: () => {} },
        toolState: { cwd: proj, projectRoot: proj, fileState: new Map(), todos: [], shells: new Map() } as any,
        helpers: {
            resolveModel: async () => {
                resolving++;
                await gate;
                return { model: childModel, client: childClient };
            },
        },
        // An interactive session (askPermission): background tasks are allowed there, unlike -p.
        host: { emit: () => {}, ui: {}, askPermission: async () => ({ allow: true }) },
    } as any);
    return { agent, session, release, resolving: () => resolving, childRequests };
}

const resultText = (session: any) =>
    JSON.stringify(session.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []).filter((c: any) => c.type === "tool_result")));

async function untilResolving(s: { resolving: () => number }) {
    for (let i = 0; i < 400 && s.resolving() === 0; i++) await Bun.sleep(5);
    expect(s.resolving()).toBe(1);
}

test("Stop (Esc) while a background agent's model is resolving: it doesn't start afterwards", async () => {
    const s = setup();
    const ac = new AbortController();
    const turn = s.agent.run([{ type: "text", text: "start bg" }], { signal: ac.signal, display: "p" });
    await untilResolving(s);
    ac.abort();
    await Bun.sleep(20);
    s.release();
    await turn.catch(() => undefined);
    await Bun.sleep(100);
    expect(s.agent.delegatedTasks).toEqual([]);
    expect(s.childRequests).toEqual([]);
    expect(resultText(s.session)).not.toContain("Started background task");
});

test("stopping every delegated task while a background agent's model is resolving: it doesn't start, and the model is told why", async () => {
    const s = setup();
    const turn = s.agent.run([{ type: "text", text: "start bg" }], { signal: new AbortController().signal, display: "p" });
    await untilResolving(s);
    expect(s.agent.stopDelegated()).toBe(0);
    s.release();
    await turn;
    await Bun.sleep(100);
    expect(s.agent.delegatedTasks).toEqual([]);
    expect(s.childRequests).toEqual([]);
    expect(resultText(s.session)).toContain("wasn't started");
});

test("/tasks stop all while a background agent's model is resolving: it doesn't start, though none is listed yet", async () => {
    const s = setup();
    const turn = s.agent.run([{ type: "text", text: "start bg" }], { signal: new AbortController().signal, display: "p" });
    await untilResolving(s);
    const app = new App({ cwd: s.session.meta.cwd, trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
    const notes: string[] = [];
    (app as any).screen = { print: () => ({}), replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop() {}, clearScreen() {}, focus: true };
    app.session = s.session;
    app.agent = s.agent;
    app.notice = (m: string, level = "info") => void notes.push(`${level}: ${m}`);
    await runCommand(app, "/tasks stop all");
    expect(notes).toEqual(["info: No background tasks are running."]);
    s.release();
    await turn;
    await Bun.sleep(100);
    expect(s.agent.delegatedTasks).toEqual([]);
    expect(s.childRequests).toEqual([]);
    expect(resultText(s.session)).toContain("wasn't started");
});

test("without a Stop, the background agent starts on its type's model as before", async () => {
    const s = setup();
    const turn = s.agent.run([{ type: "text", text: "start bg" }], { signal: new AbortController().signal, display: "p" });
    await untilResolving(s);
    s.release();
    await turn;
    for (let i = 0; i < 200 && s.childRequests.length === 0; i++) await Bun.sleep(10);
    expect(s.agent.delegatedTasks.map((t: any) => t.model)).toEqual(["openai:gpt-x"]);
    expect(s.childRequests.length).toBeGreaterThan(0);
    expect(resultText(s.session)).toContain("Started background task task-1");
});
