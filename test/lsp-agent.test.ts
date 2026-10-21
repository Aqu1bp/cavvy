import { afterAll, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { AssistantMessage, Message, ProviderClient } from "../src/providers/types";

const iso = isolate();
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { EditTool, WriteTool, ReadTool } = await import("../src/tools/file-tools");
const { BUILTIN_SERVERS } = await import("../src/lsp/config");
const { LspManager } = await import("../src/lsp/manager");
const { trustFolder } = await import("../src/config/trust");

const FIXTURE = join(import.meta.dir, "fixtures", "fake-lsp.ts");
const NO_BUILTINS = Object.fromEntries(Object.keys(BUILTIN_SERVERS).map((n) => [n, { disabled: true }]));
const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
    await Promise.all(cleanups.map((c) => c()));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    iso.cleanup();
});

const call = (id: string, name: string, input: Record<string, unknown>): AssistantMessage => ({ role: "assistant", provider: "test", model: "test", content: [{ type: "tool_call", id, name, input }], stopReason: "tool_use" });
const answer: AssistantMessage = { role: "assistant", provider: "test", model: "test", content: [{ type: "text", text: "done" }], stopReason: "end_turn" };

function setup(steps: AssistantMessage[], o: { env?: Record<string, string>; settings?: Record<string, unknown>; lsp?: (cwd: string, settings: () => any) => InstanceType<typeof LspManager>; untrusted?: boolean } = {}) {
    const cwd = realpathSync(tempDir("harness-lsp-agent-"));
    dirs.push(cwd);
    if (!o.untrusted) trustFolder(cwd);
    const settings = { autoCompact: false, delegation: false, lsp: { servers: { ...NO_BUILTINS, fake: { command: process.execPath, args: [FIXTURE], env: o.env ?? {}, extensionToLanguage: { ".ts": "typescript" } } } }, ...o.settings } as any;
    const session = Session.create(cwd, { system: "test" });
    const events: any[] = [];
    let i = 0;
    const client: ProviderClient = { stream: async () => steps[Math.min(i++, steps.length - 1)]!, listModels: async () => [] };
    const toolState: any = { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() };
    if (o.lsp) toolState.lsp = o.lsp(cwd, () => settings);
    const agent = new Agent({
        session,
        client,
        model: { provider: "test", id: "test" },
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: [ReadTool, EditTool, WriteTool],
        mode: { get: () => "bypassPermissions", set() {} },
        toolState,
        trusted: () => true,
        host: { emit: (e) => events.push(e), ui: {} },
    });
    cleanups.push(async () => {
        await toolState.lsp?.dispose();
        session.release();
    });
    const run = (text = "go") => agent.run([{ type: "text", text }], { signal: new AbortController().signal });
    return { cwd, agent, session, events, run, toolState };
}

function toolResults(messages: Message[]): string[] {
    return messages.flatMap((m) => (m.role === "user" ? m.content.flatMap((p) => (p.type === "tool_result" ? [p.content] : [])) : []));
}

function reminders(messages: Message[]): string[] {
    return messages.flatMap((m) => (m.role === "user" ? m.content.flatMap((p) => (p.type === "text" && p.text.includes("<new-diagnostics>") ? [p.text] : [])) : []));
}

test("an edit's result carries the new errors for the model, and its display for the user", async () => {
    const steps = [
        call("w1", "Write", { file_path: "src/a.ts", content: "const a = 1;\nERROR: Type 'string' is not assignable to type 'number'.\n" }),
        call("e1", "Edit", { file_path: "src/a.ts", old_string: "ERROR: Type 'string' is not assignable to type 'number'.\n", new_string: "" }),
        answer,
    ];
    const { session, events, run } = setup(steps);
    expect(await run()).toBe("done");
    const [write, edit] = toolResults(session.messages);
    expect(write).toContain("File created successfully");
    expect(write).toContain("<new-diagnostics>");
    expect(write).toContain("src/a.ts: 1 error");
    expect(write).toContain("2:1 error [fake error]: Type 'string' is not assignable to type 'number'.");
    expect(edit).toContain("src/a.ts: 1 fixed");
    const ends = events.filter((e) => e.type === "tool_end");
    expect(ends[0].result.display.diagnostics.files[0].newErrors).toBe(1);
    expect(ends[0].result.display.diff).toBeDefined();
    expect(ends[1].result.display.diagnostics.files[0].fixed).toBe(1);
});

test("an edit that fails, a file no server handles, and diagnostics turned off add nothing", async () => {
    const steps = [
        call("w1", "Write", { file_path: "notes.md", content: "ERROR: not code\n" }),
        call("r1", "Read", { file_path: "notes.md" }),
        call("e1", "Edit", { file_path: "notes.md", old_string: "missing", new_string: "x" }),
        answer,
    ];
    const one = setup(steps);
    await one.run();
    for (const r of toolResults(one.session.messages)) expect(r).not.toContain("<new-diagnostics>");
    expect(one.toolState.lsp.status()).toEqual([]);

    const two = setup([call("w1", "Write", { file_path: "a.ts", content: "ERROR: x\n" }), answer], { settings: { lsp: false } });
    await two.run();
    expect(toolResults(two.session.messages)[0]).not.toContain("<new-diagnostics>");
});

test("diagnostics that come after the edit stopped waiting reach the model with the next results, or the next prompt", async () => {
    const lsp = (cwd: string, settings: () => any) => new LspManager({ root: cwd, settings, coldTimeoutMs: 200, warmTimeoutMs: 200 });
    const steps = [call("w1", "Write", { file_path: "a.ts", content: "ERROR: slow\n" }), answer];
    const { session, events, run, cwd } = setup(steps, { env: { FAKE_LSP_DELAY: "700" }, lsp });
    await run();
    expect(toolResults(session.messages)[0]).not.toContain("<new-diagnostics>");
    await Bun.sleep(1200);
    writeFileSync(join(cwd, "unrelated.txt"), "x");
    await run("next");
    const late = reminders(session.messages);
    expect(late).toHaveLength(1);
    expect(late[0]).toContain("a.ts: 1 error");
    expect(events.some((e) => e.type === "notice" && e.message === "Diagnostics: 1 error in a.ts")).toBe(true);
});

test("in a folder the user hasn't trusted, edits get no diagnostics and the user is told once", async () => {
    const { session, events, run } = setup([call("w1", "Write", { file_path: "a.ts", content: "ERROR: x\n" }), call("w2", "Write", { file_path: "b.ts", content: "ERROR: y\n" }), answer], { untrusted: true });
    await run();
    for (const r of toolResults(session.messages)) expect(r).not.toContain("<new-diagnostics>");
    expect(events.filter((e) => e.type === "notice" && /until you trust it/.test(e.message))).toHaveLength(1);
});
