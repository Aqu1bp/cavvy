// Grok Build as an ACP agent (src/backends/acp, its hooks in agents.ts): the recorded Grok sessions
// (test/fixtures/protocol/grok-1.0.70-*.jsonl) replayed through a connection, then the backend on the live pool and
// the real Agent loop against a fake `grok` (test/fixtures/fake-acp.ts, FAKE_ACP_FLAVOR=grok). The real Grok is never
// run here.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, relative } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { Replay } from "./helpers/acp-replay";

const { cleanup } = isolate();
const registry = await import("../src/providers/registry");
const { forgetClient, clientFor } = await import("../src/providers/models");
const { AcpConnection } = await import("../src/backends/acp/connection");
const { AcpBackend, acpStatus, acpModels } = await import("../src/backends/acp/backend");
const { acpAgent } = await import("../src/backends/acp/agents");
const { agentCli } = await import("../src/backends/defs");
const { backendModel } = await import("../src/backends/types");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const trust = await import("../src/config/trust");
const { loginCommand } = await import("../src/backends/account-login");
type AgentEvent = import("../src/agent/agent").AgentEvent;
type PermissionRequest = import("../src/agent/agent").PermissionRequest;
type PermissionResponse = import("../src/agent/agent").PermissionResponse;
type CliEvent = import("../src/backends/live/types").CliEvent;
type SessionHost = import("../src/backends/types").SessionHost;
type BackendPermission = import("../src/backends/types").BackendPermission;
type PermissionAnswer = import("../src/backends/types").PermissionAnswer;
type PermissionMode = import("../src/permissions/modes").PermissionMode;
type Usage = import("../src/providers/types").Usage;

const GROK = agentCli("grok")!;
/** What registers Cavvy's gate with Grok, with every session opened. */
const HOOKS = { "x.ai/hooks": { PreToolUse: [{ matcher: "*", hookCallbackIds: ["cavvy-gate"], timeout: 600, timeoutS: 600 }] } };
const bin = tempDir("fake-grok-");
const LOG = join(bin, "log.jsonl");
const fake = join(bin, "grok");
writeFileSync(fake, `#!/bin/sh\nFAKE_ACP_FLAVOR=grok exec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-acp.ts")}" "$@"\n`);
chmodSync(fake, 0o755);

afterAll(() => {
    cleanup();
    rmSync(bin, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

const logLines = (): any[] => (existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const received = () => logLines().flatMap((l) => (l.received ? [l.received] : []));
const answers = () => logLines().flatMap((l) => (l.permissionAnswer ? [l.permissionAnswer] : []));
const hookAnswers = (): any[] => logLines().flatMap((l) => (l.hookAnswer ? [l.hookAnswer] : []));
const starts = () => logLines().filter((l) => l.argv);

function host(o: { mode?: () => PermissionMode; answer?: (r: BackendPermission) => PermissionAnswer | Promise<PermissionAnswer> } = {}) {
    const asked: BackendPermission[] = [];
    const usage: { u: Usage; o: { contextTokens?: number; contextWindow?: number } }[] = [];
    const h: SessionHost = {
        mode: o.mode ?? (() => "default"),
        permission: async (r) => {
            asked.push(r);
            return o.answer ? o.answer(r) : { allow: true };
        },
        askQuestions: async () => undefined,
        approvePlan: async () => ({ approved: false }),
        setMode: () => {},
        usage: (u, x) => usage.push({ u, o: x }),
        sessionId: () => {},
    };
    return { h, asked, usage };
}

const texts = (es: AgentEvent[]) => es.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
const notices = (es: AgentEvent[]) => es.flatMap((e) => (e.type === "notice" ? [`${e.level}: ${e.message}`] : []));
const tools = (es: AgentEvent[]) => es.flatMap((e) => (e.type === "tool_start" ? [`start ${e.call.name} ${e.title}`] : e.type === "tool_end" ? [`end ${e.call.name}${e.result.isError ? " error" : ""}: ${e.result.content}`] : []));

/** A connection to a recorded Grok session, opened in a mode at low effort (what the probes set). */
async function replay(name: string, o: { mode?: PermissionMode; answer?: (r: BackendPermission) => PermissionAnswer | Promise<PermissionAnswer> } = {}) {
    const rec = new Replay(`grok-1.0.70-${name}`);
    const events: CliEvent[] = [];
    const { h, asked, usage } = host({ mode: () => o.mode ?? "default", answer: o.answer });
    const conn = new AcpConnection(rec as any, (e) => events.push(e), h, GROK, acpAgent("grok"), "/tmp/acp-grok");
    await conn.initialize();
    await conn.open({ settings: { model: backendModel("grok", "grok-4.7"), mode: o.mode ?? "default", effort: "low" } });
    const ended = () => events.filter((e): e is Extract<CliEvent, { t: "turn_ended" }> => e.t === "turn_ended");
    const turn = async (text: string, images: any[] = []) => {
        const before = ended().length;
        const { ref } = await conn.prompt({ text, images });
        for (let i = 0; i < 500 && ended().length === before; i++) await Bun.sleep(5);
        const end = ended()[before];
        expect(end?.ref).toBe(ref);
        return end!;
    };
    const agentEvents = () => events.flatMap((e) => (e.t === "turn_event" ? [e.event] : []));
    return { rec, conn, events, agentEvents, asked, usage, turn };
}

describe("Grok Build 1.0.70, recorded", () => {
    test("a text prompt: its _x.ai notifications and the updates after its answer are dropped; tokens from its answer's _meta", async () => {
        const r = await replay("prompt-text");
        const end = await r.turn("Reply with the single word: pong");
        expect(end.reason).toBe("done");
        expect(texts(r.agentEvents()).toLowerCase()).toContain("pong");
        expect(notices(r.agentEvents())).toEqual([]);
        // Its answer's _meta.usage: input counts cache reads, so they're taken out.
        expect(r.usage).toHaveLength(1);
        expect(r.usage[0]!.u).toEqual({ inputTokens: 16391 - 1664, outputTokens: 28, cacheReadTokens: 1664, reasoningTokens: 27, resolvedModel: "grok:grok-4.7" });
        expect(r.usage[0]!.o).toEqual({ contextTokens: 16428, contextWindow: 256000 });
        // Nothing reached the turn after it ended (its title and summary come after its answer).
        await Bun.sleep(30);
        const at = r.events.findIndex((e) => e.t === "turn_ended");
        expect(r.events.slice(at + 1)).toEqual([]);
        // Effort as a bare string; its session mode set to default (no `modes` said what it was); only the gate in _meta.
        expect(r.rec.sent.find((m) => m.method === "session/set_config_option")?.params).toMatchObject({ configId: "reasoning_effort", value: "low" });
        expect(r.rec.sent.find((m) => m.method === "session/new")?.params._meta).toEqual(HOOKS);
        expect(r.rec.extra.map((m) => [m.method, m.params?.modeId])).toEqual([["session/set_mode", "default"]]);
    });

    test("asks: a tool_call without a kind, then its kind; Write and Bash, answered by kind; a no ends its turn, as the user's", async () => {
        const answers: PermissionAnswer[] = [{ allow: true }, { allow: true }, { allow: false, message: "no", stop: false }, { allow: false, message: "no", stop: false }];
        const r = await replay("permissions-default", { answer: async () => answers.shift()! });
        expect((await r.turn("Create a file named a.txt")).reason).toBe("done");
        expect(r.asked[0]).toMatchObject({ toolName: "Write", input: { file_path: "/tmp/acp-grok/a.txt" }, callId: expect.stringMatching(/^call-/), preview: { diff: { path: "a.txt", before: "", after: "a" } } });
        expect((await r.turn("echo hi > out.txt")).reason).toBe("done");
        expect(r.asked[1]).toMatchObject({ toolName: "Bash", input: { command: "echo hi > out.txt" } });
        // Grok ends the turn at a reject (stopReason cancelled): it's the user's turn, not an interruption.
        const c = await r.turn("Create a file named b.txt");
        expect(c.reason).toBe("done");
        expect((await r.turn("echo hi > out2.txt")).reason).toBe("done");
        const answered = r.rec.sent.filter((m) => m.method === undefined && m.result?.outcome).map((m) => m.result.outcome.optionId);
        expect(answered).toEqual(["allow-once", "allow-once", "reject-once", "reject-once"]);
        expect(notices(r.agentEvents()).filter((n) => /stopped at the refusal/.test(n))).toHaveLength(2);
        const ends = tools(r.agentEvents()).filter((t) => t.startsWith("end"));
        expect(ends[0]).toMatch(/^end Write: Edited \/tmp\/acp-grok\/a\.txt/);
        expect(ends[2]).toMatch(/^end Write error: User rejected/);
        // Nothing it did unasked: no tripwire.
        expect(notices(r.agentEvents()).some((n) => n.includes("without asking"))).toBe(false);
    });

    test("Esc: session/cancel, aborted at once; the command it never ends is closed; the next turn runs", async () => {
        const r = await replay("cancel");
        const { ref } = await r.conn.prompt({ text: "sleep 20", images: [] });
        while (!r.agentEvents().some((e) => e.type === "tool_start")) await Bun.sleep(5);
        await r.conn.interrupt(ref);
        while (!r.events.some((e) => e.t === "turn_ended")) await Bun.sleep(5);
        expect(r.events.find((e) => e.t === "turn_ended")).toMatchObject({ reason: "aborted" });
        expect(tools(r.agentEvents())).toEqual(["start Bash Bash(sleep 20)", "end Bash error: Cancelled: the turn ended before it finished."]);
        // `sleep` ran unasked, as Grok runs read-only commands: no tripwire notice.
        expect(notices(r.agentEvents())).toEqual([]);
        expect((await r.turn("Reply with the single word: after")).reason).toBe("done");
    });

    test("plan mode: session/set_mode plan", async () => {
        const r = await replay("plan-mode", { mode: "plan" });
        expect(r.rec.sent.find((m) => m.method === "session/set_mode")?.params).toMatchObject({ modeId: "plan" });
        expect((await r.turn("Create a file named plan-test.txt")).reason).toBe("done");
        expect(r.rec.extra).toEqual([]);
    });

    test("auto: session/new with _meta.autoMode, and its writes need no ask; in a mode that asks, the same write (recorded without the gate) stops the turn", async () => {
        const auto = await replay("auto-new", { mode: "auto" });
        expect(auto.rec.sent.find((m) => m.method === "session/new")?.params._meta).toEqual({ ...HOOKS, autoMode: true });
        expect((await auto.turn("Create a file named note.txt")).reason).toBe("done");
        expect(auto.asked).toEqual([]);
        expect(notices(auto.agentEvents())).toEqual([]);
        // The same session, as if Cavvy were in default mode: Grok wrote with neither an ask nor the gate (it wasn't
        // registered when this was recorded): the tripwire stops the turn.
        const manual = await replay("auto-new");
        const end = await manual.turn("Create a file named note.txt");
        expect(end).toMatchObject({ reason: "error", error: "Grok Build ran `Write(/tmp/acp-grok/note.txt)` without asking Cavvy, so the turn was stopped. Its own permission settings may be overriding Cavvy's." });
        expect(manual.events.some((e) => e.t === "stop")).toBe(true);
        expect(manual.rec.extra.map((m) => m.method)).toEqual(["session/set_mode", "session/cancel"]);
    });

    test("an image it drops says so", async () => {
        const r = await replay("image");
        await r.turn("What is the color?", [{ type: "image", mediaType: "image/png", data: "AAAA" }]);
        expect(notices(r.agentEvents())).toEqual([expect.stringMatching(/^warn: Image 1 was dropped before send: too small/)]);
    });
});

describe("Cavvy's gate (Grok's client PreToolUse hook), recorded", () => {
    /** The answers the connection sent to Grok's requests, by id: the gate's and its asks'. */
    const replies = (r: Awaited<ReturnType<typeof replay>>) => r.rec.sent.filter((m) => m.method === undefined).map((m) => [m.id, m.result?.outcome?.optionId ?? m.result]);

    test("Manual, Grok in its default mode: each call asked about once, at the gate (id 0 too); Grok's ask after a yes is answered yes unasked", async () => {
        const r = await replay("hook-allow-default");
        expect(r.rec.sent.find((m) => m.method === "session/new")?.params._meta).toEqual(HOOKS);
        expect((await r.turn("Write note.txt, then echo hi > out.txt")).reason).toBe("done");
        expect(r.asked).toEqual([
            expect.objectContaining({ toolName: "Write", input: { file_path: "/tmp/acp-grok/note.txt", content: "hi" }, asksAlways: true, callId: expect.stringMatching(/^call-/) }),
            expect.objectContaining({ toolName: "Bash", input: { command: "echo hi > out.txt", description: "Write hi to out.txt" }, asksAlways: true }),
        ]);
        expect(r.asked.some((a) => a.agentLabel)).toBe(false);
        expect(replies(r)).toEqual([[0, {}], [1, "allow-once"], [2, {}], [3, "allow-once"]]);
        expect(tools(r.agentEvents())).toEqual(["start Write Write(/tmp/acp-grok/note.txt)", expect.stringMatching(/^end Write: Edited \/tmp\/acp-grok\/note\.txt/), "start Bash Bash(echo hi > out.txt)", "end Bash: Done"]);
        expect(notices(r.agentEvents())).toEqual([]);
    });

    test("Manual, Grok in auto mode (the user's Claude settings): its calls still come to Cavvy at the gate; run without its own ask, no tripwire", async () => {
        const r = await replay("hook-allow-auto");
        expect((await r.turn("Write note.txt, then echo hi > out.txt")).reason).toBe("done");
        expect(r.asked.map((a) => a.toolName)).toEqual(["Write", "Bash"]);
        expect(replies(r)).toEqual([[0, {}], [1, {}]]);
        expect(notices(r.agentEvents())).toEqual([]);
    });

    test("a no at the gate: {decision: deny, reason}; Grok fails the call (Hook denied) and goes on; no tripwire", async () => {
        const r = await replay("hook-deny", { answer: () => ({ allow: false, message: "Not in this test.", stop: false }) });
        expect((await r.turn("Write note.txt, then echo hi > out.txt")).reason).toBe("done");
        expect(replies(r)).toEqual([[0, { decision: "deny", reason: "Not in this test." }], [1, { decision: "deny", reason: "Not in this test." }]]);
        expect(tools(r.agentEvents())).toEqual(["start Write Write(/tmp/acp-grok/note.txt)", "end Write error: Hook denied: Cavvy probe: write is denied by the client gate.", "start Bash Bash(echo hi > out.txt)", "end Bash error: Hook denied: Cavvy probe: run_terminal_command is denied by the client gate."]);
        expect(notices(r.agentEvents())).toEqual([]);
    });

    test("read-only calls come to the gate too: ls as Bash, read_file's relative target_file as a Read of the file in its folder", async () => {
        const r = await replay("hook-readonly");
        await r.turn("ls, then read README.txt");
        expect(r.asked).toEqual([expect.objectContaining({ toolName: "Bash", input: { command: "ls .", description: "List files in the current directory" } }), expect.objectContaining({ toolName: "Read", input: { file_path: "/tmp/acp-grok/README.txt" } })]);
    });

    test("a background command (block_until_ms) is checked as its command", async () => {
        const r = await replay("hook-background");
        await r.turn("echo hi > out.txt in the background");
        expect(r.asked).toEqual([expect.objectContaining({ toolName: "Bash", input: { command: "echo hi > out.txt", description: "Write hi to out.txt in background" } })]);
    });

    test("a subagent's call, in its own session: decided as the session's, labelled with what it was started for, no row", async () => {
        const r = await replay("hook-subagent");
        expect((await r.turn("Use a subagent to write note.txt")).reason).toBe("done");
        expect(r.asked.map((a) => [a.toolName, a.input.file_path ?? a.input.subagent_type, a.agentLabel ?? null, a.callId ? "row" : null])).toEqual([
            ["Task", "general-purpose", null, "row"],
            ["Write", "/tmp/acp-grok/note.txt", "Write note.txt with hi", null],
        ]);
        expect(replies(r)).toEqual([[0, {}], [1, {}]]);
    });

    test("plan: the gate holds a write in Grok's plan mode too, and a no refuses it", async () => {
        const r = await replay("hook-plan", { mode: "plan", answer: () => ({ allow: false, message: "Plan mode is active", stop: false }) });
        await r.turn("Write note.txt");
        expect(r.asked.map((a) => a.toolName)).toEqual(["Write"]);
        expect(replies(r)).toEqual([[0, { decision: "deny", reason: "Plan mode is active" }]]);
    });

    test("auto: let go at once, unasked (Grok's reviewer decides)", async () => {
        const r = await replay("hook-automode", { mode: "auto" });
        expect(r.rec.sent.find((m) => m.method === "session/new")?.params._meta).toEqual({ ...HOOKS, autoMode: true });
        await r.turn("echo hi > out.txt");
        expect(r.asked).toEqual([]);
        expect(replies(r)).toEqual([[0, {}]]);
    });

    test("a resumed session registers the gate again (it doesn't last into another process)", async () => {
        const rec = new Replay("grok-1.0.70-hook-resume-meta");
        const events: CliEvent[] = [];
        const { h, asked } = host({ answer: () => ({ allow: false, message: "no", stop: false }) });
        const conn = new AcpConnection(rec as any, (e) => events.push(e), h, GROK, acpAgent("grok"), "/tmp/acp-grok");
        await conn.initialize();
        await conn.open({ resumeId: "<session-1>", settings: { model: backendModel("grok", "grok-4.7"), mode: "default", effort: "low" } });
        expect(rec.sent.find((m) => m.method === "session/resume")?.params).toMatchObject({ sessionId: "<session-1>", _meta: HOOKS });
        await conn.prompt({ text: "echo hi > out.txt", images: [] });
        for (let i = 0; i < 400 && !events.some((e) => e.t === "turn_ended"); i++) await Bun.sleep(5);
        expect(asked.map((a) => a.toolName)).toEqual(["Bash"]);
    });
});

describe("Grok's hooks", () => {
    const g = acpAgent("grok");
    test("its spawn, modes and read-only calls", () => {
        expect(GROK).toMatchObject({ acpArgs: ["agent", "--no-leader", "stdio"], stopGraceMs: 5000, cli: { command: "grok", signIn: "grok login", signOut: "grok logout" } });
        expect(GROK.caps.autoReviewer).toBe(true);
        expect(g.spawn({ cwd: "/w", trusted: false } as any)).toEqual({ args: [], env: {} });
        // The gate with every open, in every mode; auto mode only in auto.
        expect(g.sessionMeta!("auto")).toEqual({ ...HOOKS, autoMode: true });
        for (const m of ["default", "acceptEdits", "plan", "bypassPermissions"] as const) expect(g.sessionMeta!(m)).toEqual(HOOKS);
        expect(["default", "acceptEdits", "plan", "auto", "bypassPermissions"].map((m) => g.tripwire!(m as PermissionMode))).toEqual(["stop", "stop", "stop", undefined, undefined]);
        expect(g.readOnly!({ kind: "read", _meta: { "x.ai/tool": { read_only: true } } })).toBe(true);
        // A write whose content Grok cut is still a Write (Write rules cover it), checked by its path.
        expect(g.gate!.tool({ sessionId: "s", toolUseId: "c", toolName: "write", input: { file_path: "a.txt", content: "x... [truncated]" }, truncated: true }, "/w")).toEqual({ toolName: "Write", input: { file_path: "/w/a.txt" }, reason: "Its new content is too long to show here." });
        expect(g.readOnly!({ kind: "execute", rawInput: { command: "git status" }, _meta: { "x.ai/tool": { read_only: false } } })).toBe(true);
        expect(g.readOnly!({ kind: "execute", rawInput: { command: "git push origin main" }, _meta: { "x.ai/tool": { read_only: false } } })).toBe(false);
        // Its plan file: the session's, under its home (GROK_HOME, ~/.grok by default), as spelled and where it leads.
        const plan = (home: string, id = "<id>") => ({ kind: "edit", rawInput: { file_path: join(home, "sessions", "%2Fw", id, "plan.md") } });
        delete process.env.GROK_HOME;
        expect(g.readOnly!(plan(join(homedir(), ".grok")), "<id>")).toBe(true);
        expect(g.readOnly!(plan(join(homedir(), ".grok"), "other"), "<id>")).toBe(false);
        expect(g.readOnly!(plan(join(homedir(), ".grok")))).toBe(false);
        expect(g.readOnly!({ kind: "edit", rawInput: { file_path: "/w/plan.md" } }, "<id>")).toBe(false);
        expect(g.readOnly!({ kind: "edit", rawInput: { file_path: "/workspace/sessions/a/b/plan.md" } }, "b")).toBe(false);
        expect(g.readOnly!({ kind: "edit", rawInput: { file_path: join(homedir(), ".grok", "sessions", "..", "..", "w", "sessions", "a", "<id>", "plan.md") } }, "<id>")).toBe(false);
        const home = realpathSync(tempDir("grok-home-"));
        try {
            process.env.GROK_HOME = home;
            expect(g.readOnly!(plan(home), "<id>")).toBe(true);
            expect(g.readOnly!(plan(join(homedir(), ".grok")), "<id>")).toBe(false);
            // A link elsewhere to its plan file isn't it (it could be a git hook); nor is a link there out to the workspace.
            const ws = realpathSync(tempDir("grok-ws-"));
            mkdirSync(join(home, "sessions", "%2Fw", "<id>"), { recursive: true });
            symlinkSync(join(home, "sessions", "%2Fw", "<id>", "plan.md"), join(ws, "plan-link.md"));
            expect(g.readOnly!({ kind: "edit", rawInput: { file_path: join(ws, "plan-link.md") } }, "<id>")).toBe(false);
            mkdirSync(join(home, "sessions", "%2Fx", "<id>"), { recursive: true });
            symlinkSync(join(ws, "notes.md"), join(home, "sessions", "%2Fx", "<id>", "plan.md"));
            expect(g.readOnly!({ kind: "edit", rawInput: { file_path: join(home, "sessions", "%2Fx", "<id>", "plan.md") } }, "<id>")).toBe(false);
            rmSync(ws, { recursive: true, force: true });
        } finally {
            delete process.env.GROK_HOME;
            rmSync(home, { recursive: true, force: true });
        }
    });
});

// Its record of a session (updates.jsonl), which says what interjections it took: read only where it should be.
describe("Grok's record of a session", () => {
    const rec = acpAgent("grok").interject!.record!;
    const line = (method: string, update: Record<string, unknown>) => JSON.stringify({ method, params: { sessionId: "s1", update } }) + "\n";
    const took = (text: string) => line("session/update", { sessionUpdate: "user_message_chunk", content: { type: "text", text: `<user_query>\n${text}\n</user_query>`, _meta: { displayText: text } }, _meta: { interjection: true } });
    const ended = (id: string) => line("_x.ai/session/update", { sessionUpdate: "turn_completed", prompt_id: id, stop_reason: "cancelled" });
    let home: string;
    const write = (body: string, dir = join(home, "sessions", "%2Fw", "s1")) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "updates.jsonl"), body);
    };
    beforeEach(() => {
        home = realpathSync(tempDir("grok-record-"));
        process.env.GROK_HOME = home;
    });
    afterEach(() => {
        delete process.env.GROK_HOME;
        rmSync(home, { recursive: true, force: true });
    });

    test("what it took in a prompt, by its id; with none, in the last it says ended and after", () => {
        write(took("old") + ended("p1") + took("hello") + ended("p2") + took("next"));
        expect(rec.taken("s1", 0, "p2")).toEqual({ texts: ["hello"], ended: true });
        expect(rec.taken("s1", 0, "p3")).toEqual({ texts: ["next"], ended: false });
        expect(rec.taken("s1", 0)).toEqual({ texts: ["hello", "next"], ended: false });
    });

    test("one that leads out of its sessions folder through a link isn't read", () => {
        const out = realpathSync(tempDir("grok-record-out-"));
        try {
            write(took("hello") + ended("p1"), join(out, "s1"));
            mkdirSync(join(home, "sessions"));
            symlinkSync(out, join(home, "sessions", "%2Fw"));
            expect(() => rec.size("s1")).toThrow("leads out");
            expect(() => rec.taken("s1", 0, "p1")).toThrow("leads out");
            rmSync(join(home, "sessions", "%2Fw"));
            mkdirSync(join(home, "sessions", "%2Fx", "s1"), { recursive: true });
            symlinkSync(join(out, "s1", "updates.jsonl"), join(home, "sessions", "%2Fx", "s1", "updates.jsonl"));
            expect(() => rec.taken("s1", 0, "p1")).toThrow("leads out");
        } finally {
            rmSync(out, { recursive: true, force: true });
        }
    });

    test("a FIFO there isn't waited on", () => {
        const dir = join(home, "sessions", "%2Fw", "s1");
        mkdirSync(dir, { recursive: true });
        expect(Bun.spawnSync(["mkfifo", join(dir, "updates.jsonl")]).exitCode).toBe(0);
        // In a process of its own: one blocked opening it would block this one's tests too.
        const agents = join(import.meta.dir, "../src/backends/acp/agents.ts");
        const script = `const { acpAgent } = await import(${JSON.stringify(agents)}); try { acpAgent("grok").interject.record.taken("s1", 0, "p1"); console.log("read"); } catch (e) { console.log("threw: " + e.message); }`;
        const r = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, GROK_HOME: home }, timeout: 5000 });
        expect(r.stdout.toString().trim()).toBe("threw: its record isn't a file");
    });

    test("a relative GROK_HOME isn't read: Grok resolves it against its own folder", () => {
        write(took("hello") + ended("p1"));
        process.env.GROK_HOME = relative(process.cwd(), home);
        expect(() => rec.size("s1")).toThrow("GROK_HOME is relative");
        expect(() => rec.taken("s1", 0, "p1")).toThrow("GROK_HOME is relative");
    });
});

describe("the backend, on the live pool, against a fake grok", () => {
    let cwd: string;
    let backend: InstanceType<typeof AcpBackend>;
    beforeEach(() => {
        cwd = realpathSync(tempDir("acp-grok-proj-"));
        rmSync(LOG, { force: true });
        process.env.FAKE_LOG = LOG;
        for (const k of ["FAKE_GROK_SIGNED_OUT", "FAKE_GROK_EXIT_MS", "FAKE_GROK_RESUMED_MODE"]) delete process.env[k];
        registry.saveAgentConfig("grok", { path: fake });
        forgetClient("grok");
        backend = new AcpBackend(registry.getProvider("grok")!);
    });
    afterEach(async () => {
        await backend.shutdown();
    });

    /** `now`: the session's mode as it is now (the user may switch it mid-turn); `mode` by default. */
    function turn(prompt: string, o: { mode?: PermissionMode; now?: () => PermissionMode; resumeId?: string; model?: string; effort?: "low" | "high"; key?: string; answer?: (r: BackendPermission) => PermissionAnswer | Promise<PermissionAnswer>; signal?: AbortSignal } = {}) {
        const events: AgentEvent[] = [];
        const ids: string[] = [];
        const { h, asked, usage } = host({ mode: o.now ?? (() => o.mode ?? "default"), answer: o.answer });
        h.sessionId = (id) => ids.push(id);
        const run = backend.runTurn({
            prompt,
            images: [],
            cwd,
            model: backendModel("grok", o.model ?? "grok-4.7"),
            mode: o.mode ?? "default",
            effort: o.effort,
            additionalDirectories: [],
            trusted: false,
            rules: { deny: [], ask: [], root: cwd },
            signal: o.signal ?? new AbortController().signal,
            sessionKey: o.key ?? "s1",
            resumeId: o.resumeId,
            session: h,
            sink: { emit: (e) => events.push(e), drainQueued: () => [] },
        });
        return { run, events, asked, usage, ids };
    }

    test("a turn: its spawn, its tokens and context, and nothing of a turn's after its answer in the next", async () => {
        const a = turn("hi");
        expect(await a.run).toMatchObject({ reason: "done", text: "Hello there" });
        expect(starts()).toHaveLength(1);
        expect(starts()[0]).toMatchObject({ argv: ["agent", "--no-leader", "stdio"], cwd });
        expect(a.usage[0]).toEqual({ u: { inputTokens: 400, outputTokens: 14, cacheReadTokens: 2000, reasoningTokens: 6, resolvedModel: "grok:grok-4.7" }, o: { contextTokens: 1300, contextWindow: 256000 } });
        expect(notices(a.events)).toEqual([]);
        const b = turn("again", { resumeId: a.ids[0] });
        expect((await b.run).text).toBe("Hello there");
        expect(b.events.some((e) => e.type === "text" && e.text === "late words")).toBe(false);
        expect(starts()).toHaveLength(1);
    });

    test("model and effort as bare strings; a model it doesn't have says why", async () => {
        const a = turn("hi", { model: "grok-4.6", effort: "low" });
        expect((await a.run).reason).toBe("done");
        expect(received().filter((m) => m.method === "session/set_config_option").map((m) => [m.params.configId, m.params.value])).toEqual([["model", "grok-4.6"], ["reasoning_effort", "low"]]);
        expect(a.usage[0]!.u.resolvedModel).toBe("grok:grok-4.6");
        const b = await turn("hi", { model: "grok-9", key: "s2" }).run;
        expect(b.reason).toBe("error");
        expect(b.error).toMatch(/Invalid params \(unknown model id\)/);
    });

    test("plan mode by session/set_mode, back to default; one process", async () => {
        // The gate asks Cavvy (this host says yes to all), then Grok's plan mode refuses it.
        const a = turn("[[write:p.txt]]", { mode: "plan" });
        expect((await a.run).reason).toBe("done");
        expect(a.asked).toMatchObject([{ toolName: "Write" }]);
        expect(existsSync(join(cwd, "p.txt"))).toBe(false);
        const b = turn("[[write:q.txt]]", { resumeId: a.ids[0] });
        expect((await b.run).reason).toBe("done");
        expect(b.asked).toHaveLength(1);
        expect(received().filter((m) => m.method === "session/set_mode").map((m) => m.params.modeId)).toEqual(["plan", "default"]);
        expect(starts()).toHaveLength(1);
    });

    test("auto: into it and out of it, a new process resumes the same session with or without _meta.autoMode", async () => {
        const a = turn("hi");
        expect((await a.run).reason).toBe("done");
        const sid = a.ids[0]!;
        const b = turn("[[write:auto.txt]]", { mode: "auto", resumeId: sid });
        expect((await b.run).reason).toBe("done");
        expect(b.asked).toEqual([]);
        expect(readFileSync(join(cwd, "auto.txt"), "utf-8")).toBe("x");
        // Its reviewer let it: no tripwire notice in auto.
        expect(notices(b.events)).toEqual([]);
        const c = turn("[[write:manual.txt]]", { resumeId: sid });
        expect((await c.run).reason).toBe("done");
        expect(c.asked).toHaveLength(1);
        expect(starts()).toHaveLength(3);
        const opens = received().filter((m) => m.method === "session/new" || m.method === "session/resume").map((m) => [m.method, m.params.sessionId ?? null, m.params._meta ?? null]);
        expect(opens).toEqual([["session/new", null, HOOKS], ["session/resume", sid, { ...HOOKS, autoMode: true }], ["session/resume", sid, HOOKS]]);
        // The process it left exited by itself (stdin closed), not by a signal.
        expect(logLines().filter((l) => l.signal)).toEqual([]);
        // Plan and acceptEdits don't need a restart: only auto's _meta does.
        expect((await turn("hi", { mode: "acceptEdits", resumeId: sid }).run).reason).toBe("done");
        expect(starts()).toHaveLength(3);
    });

    test("out of auto mid-turn: the turn stops, and goes on in a process that resumed the session without autoMode; its asks come to Cavvy", async () => {
        let mode: PermissionMode = "auto";
        const a = turn("[[slow]]", { mode: "auto", now: () => mode });
        while (!a.events.some((e) => e.type === "tool_start")) await Bun.sleep(5);
        mode = "default";
        backend.setMode(mode);
        const r = await a.run;
        expect(r).toMatchObject({ reason: "done", text: "Working\n\nHello there" });
        const sid = a.ids[0]!;
        expect(received().filter((m) => m.method === "session/cancel")).toHaveLength(1);
        expect(starts()).toHaveLength(2);
        const opens = received().filter((m) => m.method === "session/new" || m.method === "session/resume").map((m) => [m.method, m.params.sessionId ?? null, m.params._meta ?? null]);
        expect(opens).toEqual([["session/new", null, { ...HOOKS, autoMode: true }], ["session/resume", sid, HOOKS]]);
        const prompts = received().filter((m) => m.method === "session/prompt").map((m) => m.params.prompt[0].text);
        expect(prompts).toEqual(["[[slow]]", expect.stringContaining('The user switched the permission mode to "default" while you were working')]);
        const b = turn("[[write:after.txt]]", { resumeId: sid });
        expect((await b.run).reason).toBe("done");
        expect(b.asked).toMatchObject([{ toolName: "Write" }]);
        expect(starts()).toHaveLength(2);
    });

    test("out of auto while the turn is starting: its prompt goes to a session opened without autoMode", async () => {
        let mode: PermissionMode = "auto";
        const a = turn("[[write:x.txt]]", { mode: "auto", now: () => mode });
        mode = "default";
        backend.setMode(mode);
        expect((await a.run).reason).toBe("done");
        expect(a.asked).toMatchObject([{ toolName: "Write" }]);
        const prompts = received().filter((m) => m.method === "session/prompt").map((m) => m.params.prompt[0].text);
        expect(prompts).toEqual(["[[write:x.txt]]"]);
    });

    test("into auto mid-turn: nothing stops; the next turn restarts with autoMode", async () => {
        let mode: PermissionMode = "default";
        const ac = new AbortController();
        const a = turn("[[slow]]", { now: () => mode, signal: ac.signal });
        while (!a.events.some((e) => e.type === "tool_start")) await Bun.sleep(5);
        mode = "auto";
        backend.setMode(mode);
        await Bun.sleep(100);
        expect(received().some((m) => m.method === "session/cancel")).toBe(false);
        ac.abort();
        expect((await a.run).reason).toBe("aborted");
        expect(starts()).toHaveLength(1);
        const b = turn("[[write:auto.txt]]", { mode: "auto", resumeId: a.ids[0] });
        expect((await b.run).reason).toBe("done");
        expect(b.asked).toEqual([]);
        expect(starts()).toHaveLength(2);
        expect(received().filter((m) => m.method === "session/resume").map((m) => m.params._meta)).toEqual([{ ...HOOKS, autoMode: true }]);
    });

    test("plan lasts across a resume, so a resumed session is set to what Cavvy's mode wants", async () => {
        process.env.FAKE_GROK_RESUMED_MODE = "plan";
        const a = turn("[[write:x.txt]]", { resumeId: "earlier" });
        expect((await a.run).reason).toBe("done");
        expect(a.asked).toHaveLength(1);
        expect(received().filter((m) => m.method === "session/set_mode").map((m) => m.params.modeId)).toEqual(["default"]);
    });

    test("its calls go to Cavvy at the gate: a yes lets it go, and Grok's ask after it is answered yes unasked; a no fails the call and the turn goes on; a no that stops is aborted; bypass is hooksOnly", async () => {
        const a = turn("[[run:make build]]");
        expect((await a.run).reason).toBe("done");
        // Asked once (at the gate), not again when Grok asks.
        expect(a.asked).toEqual([expect.objectContaining({ toolName: "Bash", input: { command: "make build", description: "x" }, asksAlways: true, callId: "call-run" })]);
        expect(tools(a.events)).toEqual(["start Bash Bash(make build)", "end Bash: ran make build"]);
        const b = turn("[[write:n.txt]]", { key: "s2", answer: () => ({ allow: false, message: "Not that file.", stop: false }) });
        expect((await b.run).reason).toBe("done");
        expect(existsSync(join(cwd, "n.txt"))).toBe(false);
        expect(tools(b.events)).toEqual([`start Write Write(${join(cwd, "n.txt")})`, "end Write error: Hook denied: Not that file."]);
        expect(notices(b.events)).toEqual([]);
        const c = turn("[[run:rm -rf build]]", { key: "s3", answer: () => ({ allow: false, message: "no", stop: true }) });
        expect((await c.run).reason).toBe("aborted");
        const d = turn("[[run:make]]", { key: "s4", mode: "bypassPermissions" });
        expect((await d.run).reason).toBe("done");
        expect(d.asked[0]).toMatchObject({ hooksOnly: true });
        expect(logLines().flatMap((l) => (l.hookAnswer ? [l.hookAnswer] : []))).toEqual([{}, { decision: "deny", reason: "Not that file." }, { decision: "deny", reason: "no" }, {}]);
        expect(answers().map((x) => x.outcome?.optionId)).toEqual(["allow-once", "allow-once"]);
        // Never Grok's own always-approve: no _meta.yoloMode, in bypass either.
        expect(received().some((m) => m.params?._meta?.yoloMode)).toBe(false);
    });

    test("a hook's rewrite of a call approved at the gate: Grok runs only its own call, so neither runs; the same input approved goes", async () => {
        const a = turn("[[run:make build]]", { answer: () => ({ allow: true, updatedInput: { command: "make test", description: "x" } }) });
        expect((await a.run).reason).toBe("done");
        const why = "A hook rewrote this call, and Grok Build can only run the call as it asked, so neither the rewrite nor the original ran.";
        expect(hookAnswers()).toEqual([{ decision: "deny", reason: why }]);
        expect(tools(a.events)).toEqual(["start Bash Bash(make build)", `end Bash error: Hook denied: ${why}`]);
        const b = turn("[[run:make build]]", { key: "s2", answer: (r) => ({ allow: true, updatedInput: { ...r.input } }) });
        expect((await b.run).reason).toBe("done");
        expect(hookAnswers().at(-1)).toEqual({});
        expect(tools(b.events)).toEqual(["start Bash Bash(make build)", "end Bash: ran make build"]);
    });

    test("a yes at the gate answers Grok's ask that follows only in the mode it was given in: switched to Plan meanwhile, the ask is checked again", async () => {
        let mode: PermissionMode = "default";
        const answer = (): PermissionAnswer => {
            if (mode === "plan") return { allow: false, message: "Plan mode is active", stop: false };
            mode = "plan";
            return { allow: true };
        };
        const a = turn("[[run:make build]]", { now: () => mode, answer });
        expect((await a.run).reason).toBe("done");
        expect(a.asked.map((r) => r.toolName)).toEqual(["Bash", "Bash"]);
        expect(hookAnswers()).toEqual([{}]);
        expect(answers().map((x) => x.outcome?.optionId)).toEqual(["reject-once"]);
        expect(tools(a.events).some((t) => t.includes("ran make build"))).toBe(false);
    });

    test("a yes at the gate answers Grok's ask only about the very call it checked, and never one checked on a cut input", async () => {
        const f = join(cwd, "f.txt");
        const edit = { file_path: f, old_string: "a", new_string: "b" };
        const call = (key: string, o: { name: string; hook: Record<string, unknown>; ask: Record<string, unknown>; cut?: boolean }) => turn(`[[changed:${encodeURIComponent(JSON.stringify(o))}]]`, { key });
        // The same call: answered yes unasked.
        const same = call("a", { name: "search_replace", hook: edit, ask: edit });
        expect((await same.run).reason).toBe("done");
        expect(same.asked).toHaveLength(1);
        // One that replaces every match now: checked again.
        const all = call("b", { name: "search_replace", hook: edit, ask: { ...edit, replace_all: true } });
        expect((await all.run).reason).toBe("done");
        expect(all.asked.map((r) => r.input)).toEqual([edit, { file_path: f }]);
        // A write checked by its path (Grok cut its content): its ask, with whatever content, is checked again.
        const other = call("c", { name: "write", hook: { file_path: f, content: "x... [truncated]" }, ask: { file_path: f, content: "something else" }, cut: true });
        expect((await other.run).reason).toBe("done");
        expect(other.asked.map((r) => r.input)).toEqual([{ file_path: f }, { file_path: f, content: "something else" }]);
        // Checked on an input Grok cut (toolInputTruncated): its ask is checked again, though it maps to the same.
        const cut = call("d", { name: "hashline_edit", hook: { file_path: f, edits: "x..." }, ask: { file_path: f, edits: "y" }, cut: true });
        expect((await cut.run).reason).toBe("done");
        expect(cut.asked).toHaveLength(2);
        expect(answers().map((x) => x.outcome?.optionId)).toEqual(["allow-once", "allow-once", "allow-once", "allow-once"]);
    });

    test("the tripwire: what the gate let go and Grok ran unasked is fine; what got past the gate stops the turn, in the modes that ask; not in auto or bypass", async () => {
        for (const [mode, key] of [["default", "a"], ["acceptEdits", "b"], ["plan", "c"]] as const) {
            const t = turn(`[[noask:${key}.txt]]`, { mode, key });
            expect((await t.run).reason).toBe("done");
            expect(t.asked).toHaveLength(1);
            expect(notices(t.events)).toEqual([]);
            const n = turn(`[[nogate:${key}2.txt]]`, { mode, key: `${key}2` });
            const r = await n.run;
            expect(r).toMatchObject({ reason: "error", error: `Grok Build ran \`Write(${join(cwd, `${key}2.txt`)})\` without asking Cavvy, so the turn was stopped. Its own permission settings may be overriding Cavvy's.` });
        }
        for (const [mode, key] of [["auto", "d"], ["bypassPermissions", "e"]] as const) {
            const t = turn(`[[nogate:${key}.txt]]`, { mode, key });
            expect((await t.run).reason).toBe("done");
            expect(notices(t.events)).toEqual([]);
        }
        // A read-only command it runs unasked isn't one, gate or not.
        const r = turn("[[run:ls]]", { key: "f" });
        expect((await r.run).reason).toBe("done");
        expect(notices(r.events)).toEqual([]);
    });

    test("only Grok's own plan file, under its home, is taken for one: the gate lets it go in plan mode unasked; a plan.md elsewhere is refused, and one written past the gate stops the turn", async () => {
        const grokHome = realpathSync(tempDir("grok-home-"));
        process.env.GROK_HOME = grokHome;
        try {
            const a = turn("hi");
            expect((await a.run).reason).toBe("done");
            const sid = a.ids[0]!;
            const own = join(grokHome, "sessions", encodeURIComponent(cwd), sid, "plan.md");
            mkdirSync(dirname(own), { recursive: true });
            const b = turn(`[[write:${own}]]`, { mode: "plan", resumeId: sid });
            expect((await b.run).reason).toBe("done");
            // Checked against deny rules only (exempt from the mode), never asked about.
            expect(b.asked).toEqual([expect.objectContaining({ toolName: "Write", input: { file_path: own, content: "x" }, exempt: true })]);
            expect(existsSync(own)).toBe(true);
            const b2 = turn(`[[nogate:${own}]]`, { mode: "plan", resumeId: sid });
            expect((await b2.run).reason).toBe("done");
            expect(notices(b2.events)).toEqual([]);
            mkdirSync(join(cwd, "sessions", "a", sid), { recursive: true });
            // Elsewhere it's a write like any other: Cavvy decides (this host says no).
            const c = turn(`[[write:sessions/a/${sid}/plan.md]]`, { mode: "plan", resumeId: sid, answer: () => ({ allow: false, message: "Plan mode is active", stop: false }) });
            expect((await c.run).reason).toBe("done");
            expect(c.asked).toHaveLength(1);
            const d = turn(`[[nogate:sessions/a/${sid}/plan.md]]`, { mode: "plan", resumeId: sid });
            expect(await d.run).toMatchObject({ reason: "error", error: expect.stringContaining(`ran \`Write(${join(cwd, "sessions", "a", sid, "plan.md")})\` without asking Cavvy`) });
        } finally {
            delete process.env.GROK_HOME;
            rmSync(grokHome, { recursive: true, force: true });
        }
    });

    test("the tripwire stops a command it ran past the gate that failed; not an edit that failed, nor a command it says never ran", async () => {
        const a = turn("[[fail:execute]]");
        expect(await a.run).toMatchObject({ reason: "error", error: expect.stringContaining("ran `Bash(make deploy)` without asking Cavvy, so the turn was stopped") });
        for (const [kind, key] of [["edit", "s2"], ["notrun", "s3"]]) {
            const t = turn(`[[fail:${kind}]]`, { key });
            expect((await t.run).reason).toBe("done");
            expect([kind, notices(t.events)]).toEqual([kind, []]);
        }
    });

    test("Esc: aborted; the command it never ends is closed", async () => {
        const ac = new AbortController();
        const a = turn("[[slow]]", { signal: ac.signal });
        while (!a.events.some((e) => e.type === "tool_start")) await Bun.sleep(5);
        ac.abort();
        expect((await a.run).reason).toBe("aborted");
        expect(a.events.find((e) => e.type === "tool_end")).toMatchObject({ result: { isError: true, content: expect.stringContaining("Cancelled") } });
        expect((await turn("next", { resumeId: a.ids[0] }).run).text).toBe("Hello there");
    });

    test("Esc, then out of auto before the deadline, unanswered: the turn ends aborted at Esc's deadline, and the auto process is stopped", async () => {
        process.env.FAKE_ACP_IGNORE_CANCEL = "1";
        try {
            await backend.shutdown();
            backend = new AcpBackend(registry.getProvider("grok")!, { interruptMs: 1000 });
            let mode: PermissionMode = "auto";
            const ac = new AbortController();
            const a = turn("[[slow]]", { mode: "auto", now: () => mode, signal: ac.signal });
            while (!a.events.some((e) => e.type === "tool_start")) await Bun.sleep(5);
            const live = backend.pool.get("s1", "grok")!;
            const pid = live.pid!;
            const t0 = Date.now();
            ac.abort();
            await Bun.sleep(500);
            mode = "default";
            backend.setMode(mode);
            const r = await a.run;
            // At Esc's deadline, not one from the mode change.
            expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
            expect(Date.now() - t0).toBeLessThan(1400);
            expect(r).toMatchObject({ reason: "aborted" });
            // Esc's: nothing goes on under the new mode.
            expect(received().filter((m) => m.method === "session/prompt")).toHaveLength(1);
            expect(starts()).toHaveLength(1);
            for (let i = 0; i < 300 && live.state !== "dead"; i++) await Bun.sleep(10);
            expect(live.state).toBe("dead");
            expect(() => process.kill(pid, 0)).toThrow();
        } finally {
            delete process.env.FAKE_ACP_IGNORE_CANCEL;
        }
    });

    test("a slow stop: it's given time to exit on its own once its stdin closes", async () => {
        process.env.FAKE_GROK_EXIT_MS = "3000";
        expect((await turn("hi").run).reason).toBe("done");
        const t0 = Date.now();
        await backend.shutdown();
        expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
        expect(logLines().filter((l) => l.exit)).toEqual([{ exit: "stdin" }]);
        expect(logLines().filter((l) => l.signal)).toEqual([]);
    }, 15_000);

    test("an image it drops says so; a lost session is resumeFailed", async () => {
        const a = turn("[[image]]");
        expect((await a.run).reason).toBe("done");
        expect(notices(a.events)).toEqual([expect.stringMatching(/^warn: Image 1 was dropped/)]);
        const b = await turn("hi", { resumeId: "gone_1", key: "s2" }).run;
        expect(b).toMatchObject({ reason: "error", resumeFailed: true });
        expect(b.error).toMatch(/^Couldn't resume the Grok Build session: Internal error \(Path not found\.\)/);
    });

    test("status from `grok models`, without reading its sign-in; signed out, a turn says to sign in", async () => {
        expect(await acpStatus("grok")).toMatchObject({ installed: true, signedIn: true, path: fake, description: "Grok Build, signed in with grok.com", signIn: "grok login", signOut: "grok logout" });
        expect((await acpModels("grok")).map((m) => m.id)).toEqual(["grok-4.7", "grok-4.6"]);
        expect(received()).toEqual([]);
        process.env.FAKE_GROK_SIGNED_OUT = "1";
        expect(await acpStatus("grok")).toMatchObject({ installed: true, signedIn: false, description: "Grok Build, not signed in" });
        const r = await turn("hi").run;
        expect(r.reason).toBe("error");
        expect(r.error).toMatch(/Grok Build isn't signed in: Authentication required \(no auth method id provided\)\. Sign in with `grok login`, then try again\./);
        delete process.env.FAKE_GROK_SIGNED_OUT;
        const c = await turn("[[auth]]", { key: "s2" }).run;
        expect(c.error).toMatch(/Sign in with `grok login`/);
        expect((await clientFor("grok")).constructor.name).toBe("AcpBackend");
        expect(loginCommand("grok").argv).toEqual([fake, "login"]);
    });

    test("the gate: registered with every open, a resume after a restart too, and its calls held there", async () => {
        const a = turn("[[write:a.txt]]");
        expect((await a.run).reason).toBe("done");
        await backend.shutdown();
        const b = turn("[[write:b.txt]]", { resumeId: a.ids[0] });
        expect((await b.run).reason).toBe("done");
        expect(starts()).toHaveLength(2);
        expect(received().filter((m) => m.method === "session/new" || m.method === "session/resume").map((m) => [m.method, m.params._meta])).toEqual([["session/new", HOOKS], ["session/resume", HOOKS]]);
        // Request ids from 0, shared with its asks: the first hook request is id 0, and answered.
        const hooks = received().filter((m) => m.method === undefined && m.result && !m.result.outcome);
        expect(hooks.map((m) => [m.id, m.result])).toEqual([[0, {}], [0, {}]]);
        expect([...a.asked, ...b.asked].map((r) => r.input.file_path)).toEqual([join(cwd, "a.txt"), join(cwd, "b.txt")]);
        expect(logLines().filter((l) => l.hookTimeout || l.hookFailOpen)).toEqual([]);
    });

    test("auto: the gate lets everything go at once, unasked; Grok's own reviewer decides", async () => {
        const a = turn("[[run:rm -rf build]]", { mode: "auto" });
        expect((await a.run).reason).toBe("done");
        expect(a.asked).toEqual([]);
        expect(hookAnswers()).toEqual([{}]);
    });

    test("a subagent's call (its own session) is decided as the session's, labelled, with no row of its own", async () => {
        const a = turn("[[subagent:note.txt]]");
        expect((await a.run).reason).toBe("done");
        expect(a.asked.map((r) => [r.toolName, r.agentLabel ?? null, r.callId ?? null])).toEqual([["Task", null, "call-spawn"], ["Write", "Write a note", null]]);
        expect(readFileSync(join(cwd, "note.txt"), "utf-8")).toBe("x");
        expect(tools(a.events)).toEqual(["start Task Task(Write a note)", "end Task: The subagent wrote it."]);
        expect(hookAnswers()).toEqual([{}, {}]);
        // Its ask after the gate (in the subagent's session) answered yes without asking again.
        expect(answers().map((x) => x.outcome?.optionId)).toEqual(["allow-once"]);
    });

    test("no answer in time: Cavvy refuses before Grok would give up and go on, and withdraws the prompt", async () => {
        const gate = acpAgent("grok").gate!;
        gate.timeoutS = 2;
        try {
            let signal: AbortSignal | undefined;
            const t0 = Date.now();
            const a = turn("[[write:late.txt]]", { answer: (r) => ((signal = r.signal), new Promise(() => {})) });
            expect((await a.run).reason).toBe("done");
            expect(Date.now() - t0).toBeLessThan(1900);
            expect(hookAnswers()).toEqual([{ decision: "deny", reason: "No answer from Cavvy in time" }]);
            expect(logLines().filter((l) => l.hookTimeout || l.hookFailOpen)).toEqual([]);
            expect(existsSync(join(cwd, "late.txt"))).toBe(false);
            expect(signal?.aborted).toBe(true);
            expect(notices(a.events)).toEqual(["warn: Grok Build waited too long for an answer about `write`, so Cavvy refused it."]);
            expect(received().find((m) => m.method === "session/new")?.params._meta["x.ai/hooks"].PreToolUse[0].timeout).toBe(2);
        } finally {
            gate.timeoutS = 600;
        }
    });

    test("an error while deciding refuses the call, and says so", async () => {
        const a = turn("[[write:boom.txt]]", {
            answer: () => {
                throw new Error("boom");
            },
        });
        expect((await a.run).reason).toBe("done");
        expect(hookAnswers()).toEqual([{ decision: "deny", reason: "Cavvy couldn't check this call, so it was refused." }]);
        expect(existsSync(join(cwd, "boom.txt"))).toBe(false);
        expect(notices(a.events)).toEqual(["warn: Refused Grok Build's `write` call: Cavvy couldn't check it (boom)."]);
    });

    test("Esc while a call waits at the gate: it's refused, the prompt withdrawn", async () => {
        let signal: AbortSignal | undefined;
        const ac = new AbortController();
        const a = turn("[[write:esc.txt]]", { signal: ac.signal, answer: (r) => ((signal = r.signal), new Promise(() => {})) });
        while (!a.asked.length) await Bun.sleep(5);
        ac.abort();
        expect((await a.run).reason).toBe("aborted");
        for (let i = 0; i < 100 && !hookAnswers().length; i++) await Bun.sleep(10);
        expect(hookAnswers()).toEqual([{ decision: "deny", reason: "Turn stopped" }]);
        expect(signal?.aborted).toBe(true);
        expect(existsSync(join(cwd, "esc.txt"))).toBe(false);
    });
});

describe("Grok through the Agent loop and Cavvy's rules", () => {
    let cwd: string;
    beforeEach(() => {
        cwd = realpathSync(tempDir("acp-grok-agent-"));
        rmSync(LOG, { force: true });
        process.env.FAKE_LOG = LOG;
        registry.saveAgentConfig("grok", { path: fake });
        forgetClient("grok");
    });
    afterEach(async () => {
        await ((await clientFor("grok")) as any).shutdown?.();
    });

    async function makeAgent(o: { mode?: PermissionMode; settings?: any; ask?: (r: PermissionRequest) => PermissionResponse } = {}) {
        const settings = o.settings ?? {};
        const events: AgentEvent[] = [];
        const asked: PermissionRequest[] = [];
        let mode: PermissionMode = o.mode ?? "default";
        trust.trustForSession(cwd);
        const client = await clientFor("grok");
        const agent = new Agent({
            session: Session.create(cwd, { persist: false }),
            model: { provider: "grok", id: "grok-4.7" },
            client,
            settings: () => settings,
            checker: new PermissionChecker(() => settings, cwd),
            tools: BUILTIN_TOOLS,
            mode: { get: () => mode, set: (m) => (mode = m) },
            toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
            host: {
                drainQueued: () => [],
                emit: (e) => events.push(e),
                ui: {},
                askPermission: o.ask
                    ? async (req) => {
                          asked.push(req);
                          return o.ask!(req);
                      }
                    : undefined,
            },
        });
        return { events, asked, setMode: (m: PermissionMode) => (mode = m), run: (text: string) => agent.run([{ type: "text", text }], { signal: new AbortController().signal }) };
    }

    test("manual asks the user; a deny rule refuses without asking; acceptEdits approves a workspace write", async () => {
        const a = await makeAgent({ settings: { permissions: { deny: ["Write(secret.txt)"] } }, ask: () => ({ allow: true }) });
        expect(await a.run("[[write:a.txt]]")).toBe("done");
        expect(a.asked).toHaveLength(1);
        expect(await a.run("[[write:secret.txt]]")).toBe("done");
        expect(a.asked).toHaveLength(1);
        expect(existsSync(join(cwd, "secret.txt"))).toBe(false);
        a.setMode("acceptEdits");
        expect(await a.run("[[write:b.txt]]")).toBe("done");
        expect(a.asked).toHaveLength(1);
        expect(existsSync(join(cwd, "b.txt"))).toBe(true);
        // Decided at the gate; Grok's asks after a yes there are answered yes without asking again.
        expect(hookAnswers()).toEqual([{}, { decision: "deny", reason: "Denied by permission rule Write(secret.txt)" }, {}]);
        expect(answers().map((x) => x.outcome?.optionId)).toEqual(["allow-once", "allow-once"]);
    });

    test("Manual: reads, listings and read-only commands go unasked; a write and a command ask, and a no refuses them", async () => {
        writeFileSync(join(cwd, "README.txt"), "hello");
        const said: string[] = [];
        const a = await makeAgent({ ask: (r) => (said.push(r.tool.name), { allow: false }) });
        expect(await a.run("[[read:README.txt]]")).toBe("done");
        expect(await a.run("[[run:ls]]")).toBe("done");
        expect(await a.run("[[run:git status]]")).toBe("done");
        expect(said).toEqual([]);
        expect(hookAnswers()).toEqual([{}, {}, {}]);
        // A write: asked, refused (the user said no without a word: the turn ends there).
        expect(await a.run("[[write:note.txt]]")).toBe("denied");
        expect(existsSync(join(cwd, "note.txt"))).toBe(false);
        expect(await a.run("[[run:echo hi > out.txt]]")).toBe("denied");
        expect(said).toEqual(["Write", "Bash"]);
        expect(hookAnswers().slice(3)).toEqual([expect.objectContaining({ decision: "deny" }), expect.objectContaining({ decision: "deny" })]);
        // Neither reached Grok's own ask; `git status` (which Grok asks about) did, answered yes unasked.
        expect(answers().map((x) => x.outcome?.optionId)).toEqual(["allow-once"]);
        // With a word from the user, the call is refused with it, and the turn goes on.
        const b = await makeAgent({ ask: () => ({ allow: false, feedback: "Use notes/ instead." }) });
        expect(await b.run("[[write:note.txt]]")).toBe("done");
        expect(hookAnswers().at(-1)).toEqual({ decision: "deny", reason: "The user declined this tool call and said:\nUse notes/ instead." });
    });

    test("Plan: writes and commands refused at the gate without asking; Grok's own plan file goes", async () => {
        const grokHome = realpathSync(tempDir("grok-home-"));
        process.env.GROK_HOME = grokHome;
        try {
            const a = await makeAgent({ mode: "plan", ask: () => ({ allow: true }) });
            expect(await a.run("[[write:x.txt]]")).toBe("done");
            expect(await a.run("[[run:make]]")).toBe("done");
            expect(existsSync(join(cwd, "x.txt"))).toBe(false);
            expect(a.asked).toEqual([]);
            expect(hookAnswers().map((h) => h.reason)).toEqual([expect.stringMatching(/^Plan mode is active: files can't be modified/), expect.stringMatching(/^Plan mode is active: only read-only shell commands/)]);
            const sid = received().find((m) => m.method === "session/prompt")!.params.sessionId;
            const own = join(grokHome, "sessions", encodeURIComponent(cwd), sid, "plan.md");
            mkdirSync(dirname(own), { recursive: true });
            expect(await a.run(`[[write:${own}]]`)).toBe("done");
            expect(existsSync(own)).toBe(true);
            expect(a.asked).toEqual([]);
            expect(hookAnswers().at(-1)).toEqual({});
        } finally {
            delete process.env.GROK_HOME;
            rmSync(grokHome, { recursive: true, force: true });
        }
    });

    test("Bypass: only deny rules refuse, unasked; Accept edits: a workspace write goes, a command asks", async () => {
        const a = await makeAgent({ mode: "bypassPermissions", settings: { permissions: { deny: ["Write(secret.txt)", "Bash(rm *)"] } }, ask: () => ({ allow: false }) });
        expect(await a.run("[[write:secret.txt]]")).toBe("done");
        expect(await a.run("[[run:rm -f x]]")).toBe("done");
        expect(await a.run("[[write:ok.txt]]")).toBe("done");
        expect(await a.run("[[run:make]]")).toBe("done");
        expect(a.asked).toEqual([]);
        expect(existsSync(join(cwd, "secret.txt"))).toBe(false);
        expect(existsSync(join(cwd, "ok.txt"))).toBe(true);
        expect(hookAnswers().map((h) => h.decision ?? "allow")).toEqual(["deny", "deny", "allow", "allow"]);
        a.setMode("acceptEdits");
        expect(await a.run("[[write:ae.txt]]")).toBe("done");
        expect(a.asked).toEqual([]);
        expect(existsSync(join(cwd, "ae.txt"))).toBe(true);
        expect(await a.run("[[run:make]]")).toBe("denied");
        expect(a.asked.map((r) => r.tool.name)).toEqual(["Bash"]);
    });

    test("a subagent's calls come to the gate in its own session: decided as the session's, labelled as the subagent's", async () => {
        const a = await makeAgent({ ask: (r) => ({ allow: r.agentLabel === "Write a note" }) });
        expect(await a.run("[[subagent:note.txt]]")).toBe("done");
        expect(a.asked.map((r) => [r.tool.name, r.agentLabel ?? null])).toEqual([["Write", "Write a note"]]);
        expect(existsSync(join(cwd, "note.txt"))).toBe(true);
        // The spawn (a Task) goes unasked; the subagent's write was asked about, and Grok's ask after it answered yes.
        expect(hookAnswers()).toEqual([{}, {}]);
        expect(answers().map((x) => x.outcome?.optionId)).toEqual(["allow-once"]);
    });

    test("a write whose content Grok cut stays a Write, checked by its path: a Write deny rule refuses it unasked; another is asked about at the gate, and again with its content when Grok asks", async () => {
        const a = await makeAgent({ settings: { permissions: { deny: ["Write(big.txt)"] } }, ask: () => ({ allow: true }) });
        expect(await a.run("[[cutwrite:big.txt]]")).toBe("done");
        expect(a.asked).toEqual([]);
        expect(existsSync(join(cwd, "big.txt"))).toBe(false);
        expect(hookAnswers()).toEqual([{ decision: "deny", reason: "Denied by permission rule Write(big.txt)" }]);
        expect(await a.run("[[cutwrite:other.txt]]")).toBe("done");
        const other = join(cwd, "other.txt");
        expect(a.asked.map((r) => [r.tool.name, r.input])).toEqual([
            ["Write", { file_path: other }],
            ["Write", { file_path: other, content: "x... [truncated]" }],
        ]);
        expect(existsSync(other)).toBe(true);
    });

    test("a yes to a write whose content Grok cut isn't remembered: another to the same file, in another turn, is asked about too; neither offers to allow more", async () => {
        const a = await makeAgent({ ask: () => ({ allow: true }) });
        // Outside the workspace, where a yes could allow edits in its folder.
        const f = join(realpathSync(tempDir("acp-grok-out-")), "f.txt");
        const write = (content: string) => `[[changed:${encodeURIComponent(JSON.stringify({ name: "write", hook: { file_path: f, content: `${content}... [truncated]` }, ask: { file_path: f, content }, cut: true }))}]]`;
        expect(await a.run(write("one"))).toBe("done");
        expect(await a.run(write("two"))).toBe("done");
        expect(a.asked.map((r) => r.input)).toEqual([{ file_path: f }, { file_path: f, content: "one" }, { file_path: f }, { file_path: f, content: "two" }]);
        for (const r of [a.asked[0]!, a.asked[2]!]) {
            expect(r.decision.suggestions).toEqual([]);
            expect(r.decision.grant).toBeUndefined();
        }
    });

    test("Grok's own bookkeeping goes unasked in any mode, Plan too, but not past a deny rule; nor its plan file", async () => {
        const a = await makeAgent({ settings: { permissions: { deny: ["todo_write"] } }, ask: () => ({ allow: true }) });
        expect(await a.run("[[todo]]")).toBe("done");
        expect(hookAnswers()).toEqual([{ decision: "deny", reason: "Denied by permission rule todo_write" }]);
        const b = await makeAgent({ mode: "plan", ask: () => ({ allow: true }) });
        expect(await b.run("[[todo]]")).toBe("done");
        expect(hookAnswers().at(-1)).toEqual({});
        expect([...a.asked, ...b.asked]).toEqual([]);
        const grokHome = realpathSync(tempDir("grok-home-"));
        process.env.GROK_HOME = grokHome;
        try {
            const rule = `Edit(/${grokHome}/**)`;
            const c = await makeAgent({ mode: "plan", settings: { permissions: { deny: [rule] } }, ask: () => ({ allow: true }) });
            expect(await c.run("hi")).toBe("done");
            const sid = received().filter((m) => m.method === "session/prompt").at(-1).params.sessionId;
            const own = join(grokHome, "sessions", encodeURIComponent(cwd), sid, "plan.md");
            mkdirSync(dirname(own), { recursive: true });
            expect(await c.run(`[[write:${own}]]`)).toBe("done");
            expect(existsSync(own)).toBe(false);
            expect(c.asked).toEqual([]);
            expect(hookAnswers().at(-1)).toEqual({ decision: "deny", reason: `Denied by permission rule ${rule}` });
        } finally {
            delete process.env.GROK_HOME;
            rmSync(grokHome, { recursive: true, force: true });
        }
    });

    test("in its default home (a .grok folder), Grok's plan file goes in Plan, but not past a deny rule; the rest of .grok/ is still its configuration", async () => {
        const root = realpathSync(tempDir("grok-root-"));
        const grokHome = join(root, ".grok");
        process.env.GROK_HOME = grokHome;
        try {
            const a = await makeAgent({ mode: "plan", ask: () => ({ allow: true }) });
            expect(await a.run("hi")).toBe("done");
            const sid = received().filter((m) => m.method === "session/prompt").at(-1).params.sessionId;
            const own = join(grokHome, "sessions", encodeURIComponent(cwd), sid, "plan.md");
            mkdirSync(dirname(own), { recursive: true });
            expect(await a.run(`[[write:${own}]]`)).toBe("done");
            expect(existsSync(own)).toBe(true);
            expect(hookAnswers().at(-1)).toEqual({});
            // Its configuration: refused in Plan, unasked.
            const config = join(grokHome, "config.toml");
            expect(await a.run(`[[write:${config}]]`)).toBe("done");
            expect(existsSync(config)).toBe(false);
            expect(hookAnswers().at(-1)).toEqual({ decision: "deny", reason: expect.stringMatching(/^Plan mode is active/) });
            expect(a.asked).toEqual([]);
            rmSync(own);
            // A deny rule still refuses its plan file.
            const rule = `Edit(/${grokHome}/**)`;
            const b = await makeAgent({ mode: "plan", settings: { permissions: { deny: [rule] } }, ask: () => ({ allow: true }) });
            expect(await b.run("hi")).toBe("done");
            const sid2 = received().filter((m) => m.method === "session/prompt").at(-1).params.sessionId;
            const own2 = join(grokHome, "sessions", encodeURIComponent(cwd), sid2, "plan.md");
            mkdirSync(dirname(own2), { recursive: true });
            expect(await b.run(`[[write:${own2}]]`)).toBe("done");
            expect(existsSync(own2)).toBe(false);
            expect(hookAnswers().at(-1)).toEqual({ decision: "deny", reason: `Denied by permission rule ${rule}` });
            // Outside Plan, an allow rule for all of .grok/ doesn't let its configuration be changed unasked.
            const c = await makeAgent({ settings: { permissions: { allow: [`Write(/${grokHome}/**)`] } }, ask: () => ({ allow: false }) });
            expect(await c.run(`[[write:${config}]]`)).toBe("denied");
            expect(c.asked.map((r) => [r.input.file_path, r.decision.config])).toEqual([[config, true]]);
            expect(existsSync(config)).toBe(false);
        } finally {
            delete process.env.GROK_HOME;
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("Plan: Grok's plan file written with content it cut goes, though the gate's yes isn't kept: its ask after is checked as its plan file again; a deny rule still refuses that ask", async () => {
        const grokHome = realpathSync(tempDir("grok-home-"));
        process.env.GROK_HOME = grokHome;
        try {
            const a = await makeAgent({ mode: "plan", ask: () => ({ allow: true }) });
            expect(await a.run("hi")).toBe("done");
            const sid = received().filter((m) => m.method === "session/prompt").at(-1).params.sessionId;
            const own = join(grokHome, "sessions", encodeURIComponent(cwd), sid, "plan.md");
            mkdirSync(dirname(own), { recursive: true });
            expect(await a.run(`[[cutwrite:${own}]]`)).toBe("done");
            expect(existsSync(own)).toBe(true);
            expect(a.asked).toEqual([]);
            expect(hookAnswers().at(-1)).toEqual({});
            expect(answers().at(-1)).toMatchObject({ outcome: { optionId: "allow-once" } });
            // The gate lets one plan file go; Grok then asks about another of the session's, which a deny rule covers.
            const rule = `Write(/${grokHome}/sessions/b/**)`;
            const b = await makeAgent({ mode: "plan", settings: { permissions: { deny: [rule] } }, ask: () => ({ allow: true }) });
            expect(await b.run("hi")).toBe("done");
            const sid2 = received().filter((m) => m.method === "session/prompt").at(-1).params.sessionId;
            const [inA, inB] = ["a", "b"].map((d) => join(grokHome, "sessions", d, sid2, "plan.md"));
            const changed = { name: "write", hook: { file_path: inA, content: "x... [truncated]" }, ask: { file_path: inB, content: "x" }, cut: true };
            expect(await b.run(`[[changed:${encodeURIComponent(JSON.stringify(changed))}]]`)).toBe("done");
            expect(hookAnswers().at(-1)).toEqual({});
            expect(answers().at(-1)).toMatchObject({ outcome: { optionId: "reject-once" } });
            expect(b.asked).toEqual([]);
        } finally {
            delete process.env.GROK_HOME;
            rmSync(grokHome, { recursive: true, force: true });
        }
    });

    test("a protected file linked to Grok's plan file isn't taken for it: refused in Plan, asked about elsewhere as configuration", async () => {
        const grokHome = realpathSync(tempDir("grok-home-"));
        process.env.GROK_HOME = grokHome;
        try {
            const a = await makeAgent({ mode: "plan", ask: () => ({ allow: true }) });
            expect(await a.run("hi")).toBe("done");
            const sid = received().filter((m) => m.method === "session/prompt").at(-1).params.sessionId;
            const own = join(grokHome, "sessions", encodeURIComponent(cwd), sid, "plan.md");
            mkdirSync(dirname(own), { recursive: true });
            writeFileSync(own, "plan");
            mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
            const hook = join(cwd, ".git", "hooks", "pre-commit");
            symlinkSync(own, hook);
            expect(acpAgent("grok").gate!.planFile!(hook, sid)).toBe(false);
            expect(await a.run(`[[write:${hook}]]`)).toBe("done");
            expect(hookAnswers().at(-1)).toEqual({ decision: "deny", reason: expect.stringMatching(/^Plan mode is active/) });
            expect(a.asked).toEqual([]);
            // Its plan file itself still goes.
            expect(await a.run(`[[write:${own}]]`)).toBe("done");
            expect(hookAnswers().at(-1)).toEqual({});
            expect(a.asked).toEqual([]);
            const b = await makeAgent({ mode: "acceptEdits", ask: () => ({ allow: false }) });
            expect(await b.run(`[[write:${hook}]]`)).toBe("denied");
            expect(b.asked.map((r) => [r.input.file_path, r.decision.config])).toEqual([[hook, true]]);
        } finally {
            delete process.env.GROK_HOME;
            rmSync(grokHome, { recursive: true, force: true });
        }
    });

    test("a command Grok cut is refused without asking", async () => {
        const a = await makeAgent({ ask: () => ({ allow: true }) });
        expect(await a.run("[[cut:echo hi]]")).toBe("done");
        expect(a.asked).toEqual([]);
        expect(hookAnswers()).toEqual([{ decision: "deny", reason: "The command is too long for Cavvy to check in full. Do it in smaller steps." }]);
    });

    test("out of auto mid-turn, then a Stop hook's continuation: it goes on in the session opened without autoMode", async () => {
        const counter = join(cwd, "stop-hook-ran");
        const a = await makeAgent({ mode: "auto", settings: { hooks: { Stop: [{ command: `[ -e '${counter}' ] && exit 0; touch '${counter}'; echo 'keep going' >&2; exit 2` }] } } });
        const done = a.run("[[slow]]");
        while (!a.events.some((e) => e.type === "tool_start")) await Bun.sleep(5);
        a.setMode("default");
        ((await clientFor("grok")) as InstanceType<typeof AcpBackend>).setMode();
        expect(await done).toBe("done");
        expect(existsSync(counter)).toBe(true);
        const prompts = received().filter((m) => m.method === "session/prompt").map((m) => m.params.prompt[0].text);
        expect(prompts).toEqual(["[[slow]]", expect.stringContaining('switched the permission mode to "default"'), expect.stringContaining("keep going")]);
        // The continuation ran in the process the switch left: Grok wasn't reopened with autoMode while Cavvy shows Manual.
        const opens = received().filter((m) => m.method === "session/new" || m.method === "session/resume").map((m) => [m.method, m.params._meta ?? null]);
        expect(opens).toEqual([["session/new", { ...HOOKS, autoMode: true }], ["session/resume", HOOKS]]);
        expect(starts()).toHaveLength(2);
    });

    test("what the gate let go runs unasked by Grok without a word; what got past it stops the turn, and says so", async () => {
        const a = await makeAgent({ ask: () => ({ allow: true }) });
        expect(await a.run("[[noask:x.txt]]")).toBe("done");
        expect(a.asked).toHaveLength(1);
        expect(notices(a.events)).toEqual([]);
        expect(await a.run("[[nogate:y.txt]]")).toBe("error");
        expect(JSON.stringify(a.events)).toMatch(/Grok Build ran `Write\(.*y\.txt\)` without asking Cavvy, so the turn was stopped/);
    });
});
