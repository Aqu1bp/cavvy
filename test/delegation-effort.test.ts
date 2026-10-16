import { afterAll, expect, test } from "bun:test";
import { rmSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";
import type { ChatRequest, ModelInfo } from "../src/providers/types";

const iso = isolate();
const cwd = tempDir("delegation-effort-");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { orchestratorTools, DELEGATE_TOOL } = await import("../src/agent/delegation");
const { agentFromCall } = await import("../src/server/history");
afterAll(() => { iso.cleanup(); rmSync(cwd, { recursive: true, force: true }); });

const model: ModelInfo = { provider: "gemini", id: "test", effortLevels: ["low", "high"] };
async function delegate(effort: unknown, parentEffort = "low") {
    const requests: ChatRequest[] = [];
    const events: any[] = [];
    const settings = { effort: parentEffort as "low" | "max", delegation: false };
    const client = { stream: async (req: ChatRequest) => { requests.push(req); return { role: "assistant" as const, content: [{ type: "text" as const, text: "Done" }], stopReason: "end_turn" as const }; }, listModels: async () => [model] };
    const agent = new Agent({ session: Session.create(cwd, { persist: false }), model, client, settings: () => settings, checker: new PermissionChecker(() => settings, cwd), tools: [], mode: { get: () => "default", set() {} }, toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() }, helpers: { resolveModel: async () => ({ model, client }) }, host: { emit: (e) => events.push(e), ui: {} } });
    const tools = orchestratorTools({ caller: () => "codex", listings: () => [], projectRoot: () => cwd, checkModel: (ref) => (agent as any).checkModel(ref), claimCall: async () => "delegate-1", tasks: (agent as any).tasks() });
    const tool = tools.find((t) => t.name === "delegate")!;
    const result = await tool.call({ task: "Inspect the task", description: "Inspect task", model: "gemini:test", effort }, { signal: new AbortController().signal, meta: {} });
    const tasks = agent.delegatedTasks;
    await agent.dispose();
    return { result, requests, events, tasks, settings, tool };
}

test("delegate high starts the child with high and records it without changing the parent", async () => {
    const { result, requests, tasks, settings, tool, events } = await delegate("high");
    expect(result.isError).not.toBe(true);
    expect(requests[0]!.effort).toBe("high");
    expect(tasks[0]).toMatchObject({ effort: "high" });
    expect(settings.effort).toBe("low");
    expect(result.text).toContain("high effort");
    expect((tool.inputSchema as any).properties.effort).toBeDefined();
    expect(events.filter((e) => e.type === "subagent" && e.event.type === "request_start").every((e) => !("effort" in e.event))).toBe(true);
});

test("unsupported delegation effort lists the chosen model's valid levels without starting a child", async () => {
    for (const effort of ["max", "banana", 4, ""]) {
        const { result, requests, tasks } = await delegate(effort);
        expect(result.isError).toBe(true);
        expect(result.text).toContain("low, high");
        expect(requests).toHaveLength(0);
        expect(tasks).toHaveLength(0);
    }
});

test("agent rows recover explicit effort from a delegated call", () => {
    const run = agentFromCall({ t: "tool", id: "c", name: DELEGATE_TOOL, title: "Inspect task", status: "ok", input: { model: "gemini:test", effort: "high" } }, "turn");
    expect(run).toMatchObject({ model: "gemini:test", effort: "high" });
});

test("omitted effort inherits a supported level and uses model default for an unsupported one", async () => {
    const supported = await delegate(undefined);
    expect(supported.requests[0]!.effort).toBe("low");
    expect(supported.tasks[0]!.effort).toBe("low");
    const unsupported = await delegate(undefined, "max");
    expect(unsupported.requests[0]!.effort).toBeUndefined();
    expect(unsupported.tasks[0]!.effort).toBeUndefined();
});

test("a model with no effort levels rejects an explicit effort", async () => {
    const levels = model.effortLevels;
    model.effortLevels = [];
    try {
        const { result, requests } = await delegate("high");
        expect(result.isError).toBe(true);
        expect(result.text).toContain("Valid levels: none");
        expect(requests).toHaveLength(0);
    } finally {
        model.effortLevels = levels;
    }
});
