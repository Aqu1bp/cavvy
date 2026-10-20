// The lifecycle hook events (SessionStart, SessionEnd, PreCompact and
// SubagentStop; Notification is in notify.test.ts), which events can block,
// hooks that exit without reading their input, and PostToolUse's
// additionalContext reaching the model.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir, FAKE } from "./helpers/isolate";

const { home: HARNESS_HOME, cleanup } = isolate();
const { runHooks, fireHooks } = await import("../src/agent/hooks");
const { unregisterSecret } = await import("../src/util/redact");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { TaskTool } = await import("../src/tools/meta-tools");
const { loadSettings } = await import("../src/config/settings");
const { App } = await import("../src/ui/app");
const { runHeadless } = await import("../src/headless");
import type { ChatRequest } from "../src/providers/types";

afterAll(cleanup);

/** A hook that appends its stdin, one JSON object per line, to `file`. */
const record = (file: string, extra = "") => ({ command: `cat >> '${file}'; echo >> '${file}'${extra}` });
const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

async function until(fn: () => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (!fn() && Date.now() < end) await Bun.sleep(20);
}

const reply = (content: any[], stopReason = "end_turn") => ({ role: "assistant", provider: "test", model: "test", stopReason, content }) as any;
const text = (t: string) => reply([{ type: "text", text: t }]);
const toolCall = (id: string, name: string, input: unknown) => reply([{ type: "tool_call", id, name, input }], "tool_use");

/** An agent on a scripted model, in bypass mode so tools run without prompts. */
function agentFor(proj: string, settings: any, answer: (req: ChatRequest, n: number) => any, tools: any[] = []) {
    const requests: { system: string; messages: any[] }[] = [];
    const notices: string[] = [];
    const session = Session.create(proj, { persist: false, system: "PARENT" });
    const agent = new Agent({
        session,
        model: { provider: "test", id: "test" } as any,
        client: { stream: async (req: ChatRequest) => (requests.push({ system: req.system, messages: JSON.parse(JSON.stringify(req.messages)) }), answer(req, requests.length)) } as any,
        settings: () => settings,
        checker: new PermissionChecker(() => settings, proj),
        tools,
        mode: { get: () => "bypassPermissions", set() {} },
        toolState: { cwd: proj, projectRoot: proj, fileState: new Map(), todos: [], shells: new Map() } as any,
        host: { emit: (e: any) => e.type === "notice" && notices.push(e.message), ui: {} } as any,
    });
    return { agent, session, requests, notices };
}

const run = (agent: any, prompt: string) => agent.run([{ type: "text", text: prompt }], { signal: new AbortController().signal });

describe("which events can block", () => {
    test("exit 2 from an informational hook is reported, doesn't block, and later hooks still run", async () => {
        const proj = tempDir();
        const out = join(proj, "second.jsonl");
        for (const event of ["SessionStart", "SessionEnd", "PostCompact", "Notification"] as const) {
            const settings = { hooks: { [event]: [{ command: "echo refused >&2; exit 2" }, record(out)] } } as any;
            const o = await runHooks(settings, event, { session_id: "s" }, proj);
            expect(o.blocked).toBeUndefined();
            expect(o.errors).toEqual([`${event} hook "echo refused >&2; exit 2" exited with 2: refused`]);
        }
        expect(lines(out).map((l) => l.hook_event_name)).toEqual(["SessionStart", "SessionEnd", "PostCompact", "Notification"]);
    });
    test("Stop and SubagentStop can", async () => {
        for (const event of ["Stop", "SubagentStop"] as const) {
            const o = await runHooks({ hooks: { [event]: [{ command: "echo keep going >&2; exit 2" }] } } as any, event, {}, tempDir());
            expect(o.blocked).toBe("keep going");
        }
    });
    test("fireHooks never throws and passes problems on", async () => {
        const warnings: string[] = [];
        await fireHooks({ hooks: { SessionEnd: [{ command: "exit 3" }] } }, "SessionEnd", {}, tempDir(), (m) => warnings.push(m));
        expect(warnings).toEqual(['SessionEnd hook "exit 3" exited with 3']);
    });
    test("what the hooks receive is redacted", async () => {
        // A key the harness doesn't know, caught by its pattern (other test files may have registered this fake one).
        unregisterSecret(FAKE.anthropic);
        const out = join(tempDir(), "in.jsonl");
        await fireHooks({ hooks: { PreCompact: [record(out)] } }, "PreCompact", { custom_instructions: `keep ${FAKE.anthropic}` }, tempDir(), () => {});
        expect(readFileSync(out, "utf-8")).not.toContain(FAKE.anthropic);
        expect(lines(out)[0].custom_instructions).toBe("keep [REDACTED anthropic-key]");
    });
    test("an untrusted project's hooks for the new events are ignored", () => {
        const proj = tempDir();
        mkdirSync(join(proj, ".harness"), { recursive: true });
        const hooks = Object.fromEntries(["SessionStart", "SessionEnd", "PreCompact", "Notification", "SubagentStop"].map((e) => [e, [{ command: "touch pwned" }]]));
        writeFileSync(join(proj, ".harness", "settings.json"), JSON.stringify({ hooks }));
        expect(loadSettings(proj, { trusted: false }).hooks).toBeUndefined();
        expect(Object.keys(loadSettings(proj, { trusted: true }).hooks ?? {}).sort()).toEqual(["Notification", "PreCompact", "SessionEnd", "SessionStart", "SubagentStop"]);
    });
});

describe("a hook that exits without reading its input", () => {
    // More input than a pipe holds, so the write can't finish before the hook
    // exits: the harness always gets EPIPE instead of only when it loses a race.
    const big = { tool_name: "Write", tool_input: { file_path: "big.txt", content: "line of file content\n".repeat(50_000) } };

    test("its decision is honored", async () => {
        const settings = { hooks: { PreToolUse: [{ command: `echo '{"permissionDecision":"deny","permissionDecisionReason":"not reading that"}'` }] } } as any;
        const o = await runHooks(settings, "PreToolUse", big, tempDir());
        expect(o).toEqual({ errors: [], messages: [], decision: "deny", reason: "not reading that" });
    });
    test("its exit code and stderr are too", async () => {
        const o = await runHooks({ hooks: { PreToolUse: [{ command: "echo too big >&2; exit 2" }] } } as any, "PreToolUse", big, tempDir());
        expect(o.blocked).toBe("too big");
    });
});

describe("PostToolUse additionalContext", () => {
    const echo = { name: "Echo", category: "meta", readOnly: true, description: "echo", title: () => "Echo", parameters: { type: "object", properties: {} }, run: async () => ({ content: "echoed" }) };

    test("reaches the model with the tool results, once", async () => {
        const proj = tempDir();
        const settings = {
            autoCompact: false,
            hooks: { PostToolUse: [{ matcher: "Echo", command: `echo '{"hookSpecificOutput":{"additionalContext":"lint: 2 warnings"}}'` }, { command: "echo plain output is not context" }] },
        };
        const other = { ...echo, name: "Other", title: () => "Other" };
        // Each turn: one tool call, then an answer. The second turn's tool has no context hook.
        const answer = (req: ChatRequest, n: number) => ((req.messages.at(-1) as any)?.meta?.kind === "tool_results" ? text("ok") : toolCall(`c${n}`, n === 1 ? "Echo" : "Other", {}));
        const { agent, requests } = agentFor(proj, settings, answer, [echo, other]);
        await run(agent, "go");
        expect(requests).toHaveLength(2);
        const results = requests[1]!.messages.at(-1);
        expect(results.meta.kind).toBe("tool_results");
        expect(results.content[0]).toMatchObject({ type: "tool_result", toolCallId: "c1", content: "echoed" });
        expect(results.content.slice(1)).toEqual([{ type: "text", text: "<system-reminder>\nContext from a PostToolUse hook (Echo):\nlint: 2 warnings\n</system-reminder>" }]);
        const all = JSON.stringify(requests[1]!.messages);
        expect(all).not.toContain("plain output is not context");
        // Later tool results don't carry it again.
        await run(agent, "again");
        expect(requests).toHaveLength(4);
        expect(requests[3]!.messages.at(-1).content).toHaveLength(1);
        expect(JSON.stringify(requests[3]!.messages).split("lint: 2 warnings").length - 1).toBe(1);
    });
    test("UserPromptSubmit context still arrives with the prompt", async () => {
        const settings = { autoCompact: false, hooks: { UserPromptSubmit: [{ command: "echo branch is main" }] } };
        const { agent, requests } = agentFor(tempDir(), settings, () => text("ok"));
        await run(agent, "hi");
        expect(JSON.stringify(requests[0]!.messages.at(-1).content)).toContain("Context from a UserPromptSubmit hook:\\nbranch is main");
    });
});

describe("PreCompact", () => {
    test("gets the trigger and instructions, for /compact and for auto-compact", async () => {
        const proj = tempDir();
        const out = join(proj, "pre.jsonl");
        const settings = { autoCompact: false, hooks: { PreCompact: [record(out)] } };
        const { agent, session } = agentFor(proj, settings, () => text("1. Summary of it all"));
        await run(agent, "hello");
        expect(await agent.compact({ auto: false, signal: new AbortController().signal, instructions: "keep the API notes" })).toBe(true);
        await run(agent, "more");
        expect(await agent.compact({ auto: true, signal: new AbortController().signal })).toBe(true);
        expect(lines(out)).toEqual([
            { hook_event_name: "PreCompact", cwd: proj, session_id: session.meta.id, permission_mode: "bypassPermissions", trigger: "manual", custom_instructions: "keep the API notes" },
            { hook_event_name: "PreCompact", cwd: proj, session_id: session.meta.id, permission_mode: "bypassPermissions", trigger: "auto", custom_instructions: null },
        ]);
    });
});

describe("SubagentStop", () => {
    test("runs when a sub-agent finishes (not Stop), with the parent's session, and can make it keep going", async () => {
        const proj = tempDir();
        const subOut = join(proj, "sub.jsonl");
        const stopOut = join(proj, "stop.jsonl");
        const flag = join(proj, "flag");
        const settings = {
            autoCompact: false,
            hooks: {
                SubagentStop: [record(subOut, `; [ -f '${flag}' ] || { touch '${flag}'; echo "check the tests too" >&2; exit 2; }`)],
                Stop: [record(stopOut)],
            },
        };
        let child = 0;
        const { agent, session, requests } = agentFor(
            proj,
            settings,
            (req) => {
                if (req.system !== "PARENT") return text(++child === 1 ? "child report one" : "child report two");
                return req.messages.at(-1)?.meta?.kind === "tool_results" ? text("parent done") : toolCall("t1", "Task", { description: "Greet", prompt: "Say hi", subagent_type: "general-purpose" });
            },
            [TaskTool],
        );
        expect(await run(agent, "delegate")).toBe("done");
        const base = { hook_event_name: "SubagentStop", cwd: proj, session_id: session.meta.id, permission_mode: "bypassPermissions", agent_id: expect.any(String), agent_type: "general-purpose", description: "Greet" };
        expect(lines(subOut)).toEqual([
            { ...base, stop_hook_active: false, last_assistant_message: "child report one", last_message: "child report one" },
            { ...base, stop_hook_active: true, last_assistant_message: "child report two", last_message: "child report two" },
        ]);
        const childSecond = requests.filter((r) => r.system !== "PARENT")[1]!;
        expect(JSON.stringify(childSecond.messages.at(-1).content)).toContain("A SubagentStop hook asked you to keep going:\\ncheck the tests too");
        expect(lines(stopOut)).toEqual([{ hook_event_name: "Stop", cwd: proj, session_id: session.meta.id, permission_mode: "bypassPermissions", stop_hook_active: false, last_assistant_message: "parent done", last_message: "parent done" }]);
        // The parent got the report the sub-agent finished with.
        expect(JSON.stringify(requests.at(-1)!.messages.at(-1).content)).toContain("child report two");
    });
});

describe("SessionStart and SessionEnd", () => {
    function testApp(cwd: string) {
        const app = new App({ cwd, trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
        (app as any).screen = { print: () => ({}), replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop() {}, clearScreen() {} };
        (app as any).renderLive = () => {};
        app.session = Session.create(cwd, { persist: false });
        return app;
    }
    function projectWithHooks() {
        const proj = tempDir();
        const out = join(proj, "session.jsonl");
        mkdirSync(join(proj, ".harness"), { recursive: true });
        writeFileSync(join(proj, ".harness", "settings.json"), JSON.stringify({ hooks: { SessionStart: [record(out)], SessionEnd: [record(out)] } }));
        return { proj, out };
    }

    test("/clear and /resume end the old session and start the new one", async () => {
        const { proj, out } = projectWithHooks();
        const saved = Session.create(proj);
        saved.push({ role: "user", content: [{ type: "text", text: "earlier" }] } as any);
        const app = testApp(proj);
        const first = app.session.meta.id;
        app.newSession();
        const second = app.session.meta.id;
        await until(() => lines(out).length === 2);
        app.resume(saved.path);
        await until(() => lines(out).length === 4);
        const base = { cwd: proj };
        expect(lines(out)).toEqual([
            { hook_event_name: "SessionEnd", ...base, session_id: first, reason: "clear" },
            { hook_event_name: "SessionStart", ...base, session_id: second, source: "clear" },
            { hook_event_name: "SessionEnd", ...base, session_id: second, reason: "resume" },
            { hook_event_name: "SessionStart", ...base, session_id: saved.meta.id, source: "resume" },
        ]);
    });

    describe("in -p mode", () => {
        const realWrite = process.stdout.write;
        afterEach(() => {
            process.stdout.write = realWrite;
        });

        test("startup and exit (and resume)", async () => {
            const server = Bun.serve({
                port: 0,
                hostname: "127.0.0.1",
                fetch: (req) => {
                    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "mock-1" }] });
                    const chunks = [{ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];
                    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
                },
            });
            try {
                writeFileSync(join(HARNESS_HOME, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: `http://127.0.0.1:${server.port}/v1`, kind: "openai", requiresKey: false }] }));
                const { proj, out } = projectWithHooks();
                let stdout = "";
                process.stdout.write = ((s: string) => ((stdout += s), true)) as any;
                const opts = { cwd: proj, prompt: "hello", trusted: true, modelRef: "mock:mock-1", mode: "default" as const, outputFormat: "json" as const, verbose: false, allowedTools: [], disallowedTools: [], addDirs: [], startupNotes: [] };
                expect(await runHeadless(opts)).toBe(0);
                const id = JSON.parse(stdout.trim().split("\n").at(-1)!).session_id;
                const resumed = Session.create(proj);
                resumed.push({ role: "user", content: [{ type: "text", text: "before" }] } as any);
                expect(await runHeadless({ ...opts, resumeFile: resumed.path })).toBe(0);
                process.stdout.write = realWrite;
                expect(lines(out)).toEqual([
                    { hook_event_name: "SessionStart", cwd: proj, session_id: id, source: "startup" },
                    { hook_event_name: "SessionEnd", cwd: proj, session_id: id, reason: "exit" },
                    { hook_event_name: "SessionStart", cwd: proj, session_id: resumed.meta.id, source: "resume" },
                    { hook_event_name: "SessionEnd", cwd: proj, session_id: resumed.meta.id, reason: "exit" },
                ]);
            } finally {
                server.stop(true);
            }
        });
    });
});
