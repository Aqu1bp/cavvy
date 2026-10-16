// Engine/account regressions without a listening server or real CLI credentials.
import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { AgentBackendClient, BackendTurn } from "../src/backends/types";

const iso = isolate();
const cwd = tempDir("account-engine-");
const { Engine } = await import("../src/server/engine");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { addAccount } = await import("../src/providers/accounts");
const { saveAgentConfig, getProvider } = await import("../src/providers/registry");
const { loadSettings } = await import("../src/config/settings");
const client = { subs: new Set<string>(), send() {} };
afterAll(() => { iso.cleanup(); rmSync(cwd, { recursive: true, force: true }); });

for (const provider of ["claude-code", "codex"]) test(`${provider}: account changes wait for delegated CLI children after the parent switches`, async () => {
    const selected = addAccount(provider, { id: "working", name: "Working" });
    const unused = addAccount(provider, { id: "unused", name: "Unused" });
    const session = Session.create(cwd, { persist: false });
    session.setAccount(provider, selected.id);
    const entered = Promise.withResolvers<BackendTurn>();
    const finish = Promise.withResolvers<void>();
    const backend: AgentBackendClient = {
        agentBackend: true, listModels: async () => [], setMode() {},
        stream: async () => { throw new Error("Not a chat provider"); },
        compact: async () => { throw new Error("Not compacting"); },
        runTurn: async (turn) => { entered.resolve(turn); await finish.promise; return { reason: "done", text: "Done", answer: "Done", actions: [] }; },
    };
    const agent = new Agent({
        session, model: { provider, id: "default" }, client: backend,
        settings: () => ({ delegation: false }), checker: new PermissionChecker(() => ({}), cwd), tools: [],
        mode: { get: () => "default", set() {} },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        helpers: { resolveModel: async () => ({ model: { provider, id: "default" }, client: backend }) },
        host: { emit() {}, ui: {} },
    });
    const engine = new Engine({ listModels: async () => [] });
    // The parent turn has ended; only its delegated child is still running.
    engine.runtimes.set(session.meta.id, { busy: false, session, agent, ws: { cwd } } as any);
    const task = (agent as any).tasks().start({ description: "Wait", prompt: "Wait", agent: "general-purpose", model: `${provider}:default`, writes: false });
    try {
        expect((await entered.promise).accountId).toBe(selected.id);
        session.setAccount(provider, "default");
        await expect(engine.handle(client, "accounts.remove", { provider, id: selected.id, confirmedFolder: selected.folder })).rejects.toMatchObject({ code: "busy" });
        expect(existsSync(selected.folder)).toBe(true);
        // Adding either provider changes the protection snapshot of both CLIs.
        for (const addedProvider of ["claude-code", "codex"]) {
            await expect(engine.handle(client, "accounts.add", { provider: addedProvider, id: "while-running", name: "While running" })).rejects.toMatchObject({ code: "busy" });
        }
        await engine.handle(client, "accounts.remove", { provider, id: unused.id, confirmedFolder: unused.folder });
        expect(existsSync(unused.folder)).toBe(false);
        finish.resolve();
        await task.settled;
        await expect(engine.handle(client, "accounts.add", { provider, id: "after-child", name: "After child" })).resolves.toMatchObject({ id: "after-child" });
        await engine.handle(client, "accounts.remove", { provider, id: selected.id, confirmedFolder: selected.folder });
        expect(existsSync(selected.folder)).toBe(false);
    } finally {
        finish.resolve();
        await task.settled;
        engine.runtimes.clear();
        await agent.dispose();
        await engine.stop();
    }
});

test("account catalog refresh keeps the configured model for new sessions", async () => {
    writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: "http://127.0.0.1:1", requiresKey: false }] }));
    writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:test" }));
    saveAgentConfig("claude-code", { path: process.execPath });
    const selected = addAccount("claude-code", { id: "catalog", name: "Catalog" });
    const engine = new Engine({ listModels: async () => ["claude-code", "mock"].map((provider) => ({ provider: getProvider(provider)!, status: "ok", models: [{ provider, id: provider === "mock" ? "test" : "default", contextWindow: 10000 }] })) });
    try {
        await engine.handle(client, "accounts.setDefault", { provider: "claude-code", id: selected.id });
        const snapshot = await engine.handle(client, "session.create", { cwd });
        expect(snapshot.state.model?.provider).toBe("mock");
        expect(loadSettings(cwd).model).toBe("mock:test");
    } finally { await engine.stop(); }
});
