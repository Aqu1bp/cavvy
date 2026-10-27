// The ACP layer (src/backends/acp): its JSON-RPC, the recorded OpenCode sessions
// (test/fixtures/protocol/opencode-1.19.4-*.jsonl) replayed through a connection,
// OpenCode's spawn, and the backend on the live pool against a fake agent
// (test/fixtures/fake-acp.ts). The real OpenCode is never run here.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { cleanup } = isolate();
const registry = await import("../src/providers/registry");
const { forgetClient, clientFor } = await import("../src/providers/models");
const { AcpRpc, AcpError } = await import("../src/backends/acp/rpc");
const { AcpConnection, permissionFor } = await import("../src/backends/acp/connection");
const { AcpBackend, acpStatus, acpModels } = await import("../src/backends/acp/backend");
const { acpAgent, opencodeEnv } = await import("../src/backends/acp/agents");
const { agentCli } = await import("../src/backends/defs");
const { JsonLinesProcess } = await import("../src/backends/cli");
const { backendModel } = await import("../src/backends/types");
const { checkAgentCli } = await import("../src/backends/index");
type AgentEvent = import("../src/agent/agent").AgentEvent;
type CliEvent = import("../src/backends/live/types").CliEvent;
type SessionHost = import("../src/backends/types").SessionHost;
type BackendPermission = import("../src/backends/types").BackendPermission;
type PermissionAnswer = import("../src/backends/types").PermissionAnswer;
type PermissionMode = import("../src/permissions/modes").PermissionMode;
type Usage = import("../src/providers/types").Usage;

const OPENCODE = agentCli("opencode")!;
const FIXTURES = join(import.meta.dir, "fixtures", "protocol");
const bin = tempDir("fake-acp-");
const LOG = join(bin, "log.jsonl");
const fake = join(bin, "opencode");
writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-acp.ts")}" "$@"\n`);
chmodSync(fake, 0o755);

afterAll(() => {
    cleanup();
    rmSync(bin, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

const logLines = (): any[] => (existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const received = () => logLines().flatMap((l) => (l.received ? [l.received] : []));

/** A host that answers asks as told and records what it's told. */
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

describe("JSON-RPC", () => {
    const script = `
        const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
        out({ jsonrpc: "2.0", method: "hello", params: { n: 1 } });
        out({ jsonrpc: "2.0", id: 7, method: "agent/ask", params: { q: 1 } });
        out({ jsonrpc: "2.0", id: 8, method: "agent/unknown", params: {} });
        out({ id: 99, result: "no jsonrpc: ignored" });
        let buf = "";
        for await (const c of Bun.stdin.stream()) {
            buf += new TextDecoder().decode(c);
            let i;
            while ((i = buf.indexOf("\\n")) >= 0) {
                const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
                if (m.method === "ping") out({ jsonrpc: "2.0", id: m.id, result: { pong: m.params, jsonrpc: m.jsonrpc } });
                else if (m.method === "fail") out({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "bad", data: { x: 1 } } });
                else if (m.method === "die") process.exit(0);
                else if (m.method === undefined) out({ jsonrpc: "2.0", method: "answered", params: m });
            }
        }`;

    test("requests, answers, notifications and the agent's requests, all framed as JSON-RPC 2.0", async () => {
        const proc = new JsonLinesProcess(process.execPath, ["-e", script], { cwd: bin });
        const notes: [string, any][] = [];
        const rpc = new AcpRpc(
            proc,
            (m, p) => notes.push([m, p]),
            async (m, p) => {
                if (m === "agent/ask") return { got: p.q };
                throw new AcpError(`no ${m}`, -32601);
            },
        );
        expect(await rpc.request("ping", { a: 1 })).toEqual({ pong: { a: 1 }, jsonrpc: "2.0" });
        const err = await rpc.request("fail", {}).catch((e) => e);
        expect(err).toBeInstanceOf(AcpError);
        expect(err).toMatchObject({ code: -32602, message: "bad", data: { x: 1 } });
        while (notes.filter(([m]) => m === "answered").length < 2) await Bun.sleep(10);
        expect(notes[0]).toEqual(["hello", { n: 1 }]);
        const answers = notes.filter(([m]) => m === "answered").map(([, p]) => p);
        expect(answers).toContainEqual({ jsonrpc: "2.0", id: 7, result: { got: 1 } });
        expect(answers).toContainEqual({ jsonrpc: "2.0", id: 8, error: { code: -32601, message: "no agent/unknown" } });
        // Requests still waiting when its output ends are answered with an error, not left hanging.
        const pending = rpc.request("die", {});
        await expect(pending).rejects.toThrow(/output ended/);
        await rpc.done;
        await expect(rpc.request("ping", {})).rejects.toThrow(/output had ended/);
    });
});

/** A recorded session, played back to a connection: its answers and updates, in their order, to what the connection sends. */
class Replay {
    private frames: { dir: "in" | "out"; frame: any }[];
    private pos = 0;
    private queue: Record<string, any>[] = [];
    private wake?: () => void;
    private closed = false;
    private ids = new Map<number, number>();
    /** What the connection sent that the recording didn't (answered {} when it's a request). */
    readonly extra: any[] = [];
    readonly sent: any[] = [];
    readonly pid = 0;

    constructor(name: string) {
        this.frames = readFileSync(join(FIXTURES, `opencode-1.19.4-${name}.jsonl`), "utf-8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l))
            .filter((l) => (l.dir === "in" || l.dir === "out") && typeof l.frame === "object");
        this.flush();
    }

    private push(m: Record<string, any>) {
        this.queue.push(m);
        this.wake?.();
    }

    /** The agent's frames up to the next one the client sent. */
    private flush() {
        while (this.pos < this.frames.length && this.frames[this.pos]!.dir === "in") {
            const f = { ...this.frames[this.pos++]!.frame };
            // An answer to one of the client's requests: under the id it used.
            if (f.method === undefined && this.ids.has(f.id)) f.id = this.ids.get(f.id);
            this.push(f);
        }
        if (this.pos >= this.frames.length) this.end();
    }

    async send(m: any): Promise<boolean> {
        this.sent.push(m);
        const isMatch = (f: any) => (m.method === undefined ? f.method === undefined && f.id === m.id : f.method === m.method);
        let j = this.pos;
        while (j < this.frames.length && !(this.frames[j]!.dir === "out" && isMatch(this.frames[j]!.frame))) j++;
        if (j >= this.frames.length) {
            this.extra.push(m);
            if (m.method !== undefined && m.id !== undefined) this.push({ jsonrpc: "2.0", id: m.id, result: {} });
            return true;
        }
        // What the client didn't send (a request the probe made that this connection doesn't), and its answers, are skipped.
        if (m.id !== undefined && m.method !== undefined) this.ids.set(this.frames[j]!.frame.id, m.id);
        this.pos = j + 1;
        this.flush();
        return true;
    }

    end() {
        this.closed = true;
        this.wake?.();
    }

    async *messages(): AsyncGenerator<Record<string, any>> {
        for (;;) {
            if (this.queue.length) {
                yield this.queue.shift()!;
                continue;
            }
            if (this.closed) return;
            await new Promise<void>((r) => (this.wake = r));
            this.wake = undefined;
        }
    }

    stderr() {
        return "";
    }
}

/** A connection to a recorded session: its events, the session open, a prompt sent. */
async function replay(name: string, o: { mode?: PermissionMode; model?: string; effort?: "low"; answer?: (r: BackendPermission) => PermissionAnswer | Promise<PermissionAnswer>; images?: boolean } = {}) {
    const rec = new Replay(name);
    const events: CliEvent[] = [];
    const { h, asked, usage } = host({ mode: () => o.mode ?? "default", answer: o.answer });
    const conn = new AcpConnection(rec as any, (e) => events.push(e), h, OPENCODE, acpAgent("opencode"), "/tmp/acp-opencode");
    await conn.initialize();
    const { sessionId } = await conn.open({ settings: { model: backendModel("opencode", o.model ?? "opencode/big-pickle"), mode: o.mode ?? "default", effort: o.effort } });
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
    return { rec, conn, events, agentEvents, asked, usage, sessionId, turn };
}

const texts = (es: AgentEvent[]) => es.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
const said = (es: AgentEvent[]) => es.flatMap((e) => (e.type === "assistant" ? e.message.content.map((c) => (c.type === "text" ? c.text : "")) : []));
const tools = (es: AgentEvent[]) => es.flatMap((e) => (e.type === "tool_start" ? [`start ${e.call.name} ${e.title}`] : e.type === "tool_end" ? [`end ${e.call.name}${e.result.isError ? " error" : ""}: ${e.result.content}`] : []));

describe("OpenCode 1.19.4, recorded", () => {
    test("a text prompt: no file system or terminal offered, its words, its tokens, and its cost in USD", async () => {
        const r = await replay("prompt-text");
        const init = r.rec.sent.find((m) => m.method === "initialize");
        expect(init).toMatchObject({ jsonrpc: "2.0", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } });
        expect(r.sessionId).toMatch(/^<session-1>$/);
        expect(r.conn.caps.images).toBe(true);
        const end = await r.turn("Reply with the single word: pong");
        expect(end.reason).toBe("done");
        expect(said(r.agentEvents()).join("")).toBe(texts(r.agentEvents()));
        expect(texts(r.agentEvents()).length).toBeGreaterThan(0);
        expect(r.usage).toHaveLength(1);
        expect(r.usage[0]!.u).toMatchObject({ cost: 0 });
        expect(r.usage[0]!.u.inputTokens).toBeGreaterThan(0);
        expect(r.usage[0]!.o.contextWindow).toBe(200000);
        // Nothing the recording didn't have: the model and mode were OpenCode's already.
        expect(r.rec.extra).toEqual([]);
    });

    test("a read it doesn't ask about shows as Cavvy's Read, and trips nothing", async () => {
        const r = await replay("read-file");
        const end = await r.turn("Read the file README.txt");
        expect(end).toMatchObject({ reason: "done" });
        expect(tools(r.agentEvents())).toEqual(["start Read Read(/tmp/acp-opencode/README.txt)", "end Read: The secret word is: marmalade."]);
        expect(r.asked).toEqual([]);
    });

    test("asks: a command as Bash, a write as Write with its diff; allow_once, reject_once, and a turn that's stopped answers cancelled", async () => {
        const answers: PermissionAnswer[] = [{ allow: true }, { allow: false, message: "no", stop: false }];
        const r = await replay("permissions-ask", { answer: async (q) => answers.shift() ?? new Promise(() => {}) });
        expect((await r.turn("echo hi > out.txt")).reason).toBe("done");
        expect(r.asked[0]).toMatchObject({ toolName: "Bash", input: { command: "echo hi > out.txt" }, asksAlways: true, callId: expect.stringMatching(/^call_/) });
        expect(r.asked[0]!.hooksOnly).toBeUndefined();
        expect((await r.turn("Create a file named b.txt")).reason).toBe("done");
        expect(r.asked[1]).toMatchObject({ toolName: "Write", input: { file_path: "/tmp/acp-opencode/b.txt" }, preview: { diff: { path: "b.txt", before: "", after: "b" } } });
        const answered = r.rec.sent.filter((m) => m.method === undefined && m.result?.outcome).map((m) => m.result.outcome);
        expect(answered).toEqual([{ outcome: "selected", optionId: "once" }, { outcome: "selected", optionId: "reject" }]);
        // The third ask waits; Esc: the ask is answered cancelled, and session/cancel goes.
        const third = r.conn.prompt({ text: "echo hi > out2.txt", images: [] });
        const { ref } = await third;
        while (r.asked.length < 3) await Bun.sleep(5);
        await r.conn.interrupt(ref);
        while (!r.events.some((e) => e.t === "turn_ended" && e.ref === ref)) await Bun.sleep(5);
        expect(r.rec.sent.filter((m) => m.method === undefined && m.result?.outcome).at(-1).result.outcome).toEqual({ outcome: "cancelled" });
        expect(r.rec.extra.map((m) => m.method)).toEqual(["session/cancel"]);
        const ends = tools(r.agentEvents()).filter((t) => t.startsWith("end"));
        expect(ends).toEqual(["end Bash: (no output)", "end Write error: The user rejected permission to use this specific tool call.", "end Bash error: The user rejected permission to use this specific tool call."]);
    });

    test("OpenCode's fs/write_text_file after its own write is a yes when the file holds it, else method-not-found", async () => {
        const r = await replay("ask-check");
        expect((await r.turn("Create a file named hello.txt")).reason).toBe("done");
        // No /tmp/acp-opencode/hello.txt here: it isn't written for it.
        const fs = r.rec.sent.find((m) => m.id === 1 && m.method === undefined);
        expect(fs.error.code).toBe(-32601);
        expect(existsSync("/tmp/acp-opencode/hello.txt")).toBe(false);
    });

    test("the tripwire: an edit it made without asking stops the turn, in any mode but bypass", async () => {
        const r = await replay("default-noask");
        const end = await r.turn("Create a file named hello.txt");
        expect(end.reason).toBe("error");
        expect(end.error).toMatch(/^OpenCode ran `Write\(\/tmp\/acp-opencode\/hello.txt\)` without asking Cavvy, so the turn was stopped\. Its own permission settings may be overriding Cavvy's\.$/);
        expect(r.rec.extra.map((m) => m.method)).toEqual(["session/cancel"]);
        const bypass = await replay("default-noask", { mode: "bypassPermissions" });
        expect((await bypass.turn("Create a file named hello.txt")).reason).toBe("done");
        expect(bypass.rec.extra).toEqual([]);
    });

    test("Esc: session/cancel, the turn ends aborted, the process stays for the next", async () => {
        const r = await replay("cancel");
        const { ref } = await r.conn.prompt({ text: "sleep 20", images: [] });
        while (!r.asked.length) await Bun.sleep(5);
        await Bun.sleep(20);
        await r.conn.interrupt(ref);
        while (!r.events.some((e) => e.t === "turn_ended")) await Bun.sleep(5);
        expect(r.events.find((e) => e.t === "turn_ended")).toMatchObject({ reason: "aborted" });
        expect((await r.turn("Reply with the single word: after")).reason).toBe("done");
        expect(r.rec.extra).toEqual([]);
    });

    test("Cavvy's plan mode sets OpenCode's own (set_config_option mode=plan)", async () => {
        const r = await replay("plan-mode", { mode: "plan" });
        expect(r.rec.sent.find((m) => m.method === "session/set_config_option")?.params).toMatchObject({ configId: "mode", value: "plan" });
        expect((await r.turn("Create a file named plan-test.txt")).reason).toBe("done");
        expect(r.rec.extra).toEqual([]);
    });

    test("a model by its option, then an effort it offers; an image as an image block", async () => {
        const r = await replay("set-model", { model: "opencode/deepseek-v4.1-flash-free", effort: "low" });
        expect(r.rec.sent.filter((m) => m.method === "session/set_config_option").map((m) => [m.params.configId, m.params.value])).toEqual([["model", "opencode/deepseek-v4.1-flash-free"]]);
        expect((await r.turn("Reply with the single word: model")).reason).toBe("done");
        const img = await replay("image", { model: "opencode/nemotron-3.5-super-vl-free" });
        await img.turn("What is the color?", [{ type: "image", mediaType: "image/png", data: "AAAA" }]);
        expect(img.rec.sent.find((m) => m.method === "session/prompt").params.prompt[1]).toEqual({ type: "image", mimeType: "image/png", data: "AAAA" });
    });
});

describe("permissions, as Cavvy's", () => {
    const cwd = "/w";
    test("each kind as Cavvy's tool, fail-closed when it can't be checked", () => {
        expect(permissionFor(OPENCODE, { kind: "execute", rawInput: { command: "ls" } }, undefined, cwd)).toMatchObject({ toolName: "Bash", input: { command: "ls" } });
        expect(permissionFor(OPENCODE, { kind: "execute", rawInput: {} }, undefined, cwd)).toBeUndefined();
        expect(permissionFor(OPENCODE, { kind: "edit", rawInput: { filepath: "a.ts" }, locations: [{ path: "/w/b.ts" }] }, undefined, cwd)).toMatchObject({ toolName: "Edit", input: { file_path: "/w/a.ts" }, otherPaths: ["/w/b.ts"] });
        expect(permissionFor(OPENCODE, { kind: "move", rawInput: { source: "/w/a", destination: "/etc/x" } }, undefined, cwd)).toMatchObject({ toolName: "Edit", input: { file_path: "/w/a", operation: "move" }, otherPaths: ["/etc/x"] });
        expect(permissionFor(OPENCODE, { kind: "delete", locations: [{ path: "/w/a" }] }, undefined, cwd)).toMatchObject({ toolName: "Edit", input: { file_path: "/w/a", operation: "delete" }, preview: { summary: "Deletes the file" } });
        // Its whole new content (a diff's newText, Grok's rawInput.content): a Write of it, its diff the preview.
        expect(permissionFor(OPENCODE, { kind: "edit", locations: [{ path: "/w/a" }], content: [{ type: "diff", path: "/w/a", oldText: "x", newText: "y" }] }, undefined, cwd)).toEqual({ toolName: "Write", input: { file_path: "/w/a", content: "y" }, title: undefined, otherPaths: [], preview: { diff: { path: "a", before: "x", after: "y" } } });
        expect(permissionFor(OPENCODE, { kind: "edit", rawInput: { file_path: "/w/a", content: "y" } }, undefined, cwd)).toMatchObject({ toolName: "Write", input: { file_path: "/w/a", content: "y" } });
        expect(permissionFor(OPENCODE, { kind: "edit", rawInput: { file_path: "/w/a", old_string: "x", new_string: "y" } }, undefined, cwd)?.input).toEqual({ file_path: "/w/a" });
        expect(permissionFor(OPENCODE, { kind: "edit", rawInput: {} }, undefined, cwd)).toBeUndefined();
        // What the updates said before the ask fills in what it leaves out.
        expect(permissionFor(OPENCODE, { kind: "edit" }, { kind: "edit", locations: [{ path: "/w/c" }] }, cwd)).toMatchObject({ input: { file_path: "/w/c" } });
        expect(permissionFor(OPENCODE, { kind: "fetch", rawInput: { url: "https://x.test" } }, undefined, cwd)).toMatchObject({ toolName: "WebFetch", input: { url: "https://x.test" } });
        expect(permissionFor(OPENCODE, { kind: "fetch", rawInput: {} }, undefined, cwd)).toBeUndefined();
        expect(permissionFor(OPENCODE, { kind: "other", title: "task", rawInput: { prompt: "p" } }, undefined, cwd)).toMatchObject({ toolName: "OpenCode", title: "task", input: { prompt: "p" } });
        expect(permissionFor(OPENCODE, undefined, undefined, cwd)).toBeUndefined();
    });
});

describe("OpenCode's spawn", () => {
    test("asks about every change, in every agent; plan's own edit deny stands; an untrusted folder's config stays out", () => {
        const env = opencodeEnv(false);
        expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
        expect(opencodeEnv(true).OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined();
        const c = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
        const set = { "*": "ask", edit: "ask", bash: "ask", webfetch: "ask", websearch: "ask", external_directory: "ask", task: "ask", read: "allow", glob: "allow", grep: "allow", list: "allow", todowrite: "allow", todoread: "allow" };
        expect(c.permission).toEqual(set);
        for (const a of ["build", "general", "explore"]) expect(c.agent[a].permission).toEqual(set);
        const plan = c.agent.plan.permission;
        expect(Object.keys(plan).at(-1)).toBe("edit");
        expect(plan.edit).toEqual({ "*": "deny", ".opencode/plans/*.md": "ask" });
        expect(plan.bash).toBe("ask");
        const spec = acpAgent("opencode").spawn({ cwd: "/w", trusted: true } as any);
        expect(spec.args).toEqual(["--cwd", "/w"]);
    });
});

describe("the backend, on the live pool, against a fake agent", () => {
    let cwd: string;
    let backend: InstanceType<typeof AcpBackend>;
    beforeEach(() => {
        cwd = realpathSync(tempDir("acp-proj-"));
        rmSync(LOG, { force: true });
        process.env.FAKE_LOG = LOG;
        delete process.env.FAKE_ACP_INIT;
        delete process.env.FAKE_ACP_RESUME;
        delete process.env.FAKE_ACP_IMAGES;
        delete process.env.FAKE_ACP_IGNORE_CANCEL;
        registry.saveAgentConfig("opencode", { path: fake });
        forgetClient("opencode");
        backend = new AcpBackend(registry.getProvider("opencode")!);
    });
    afterEach(async () => {
        await backend.shutdown();
    });

    function turn(prompt: string, o: { mode?: PermissionMode; resumeId?: string; model?: string; key?: string; answer?: (r: BackendPermission) => PermissionAnswer | Promise<PermissionAnswer>; signal?: AbortSignal; fork?: boolean } = {}) {
        const events: AgentEvent[] = [];
        const ids: string[] = [];
        const { h, asked, usage } = host({ mode: () => o.mode ?? "default", answer: o.answer });
        h.sessionId = (id) => ids.push(id);
        const run = backend.runTurn({
            prompt,
            images: [],
            cwd,
            model: backendModel("opencode", o.model ?? "opencode/big-pickle"),
            mode: o.mode ?? "default",
            additionalDirectories: [],
            trusted: false,
            rules: { deny: [], ask: [], root: cwd },
            signal: o.signal ?? new AbortController().signal,
            sessionKey: o.key ?? "s1",
            resumeId: o.resumeId,
            forkSession: o.fork,
            session: h,
            sink: { emit: (e) => events.push(e), drainQueued: () => [] },
        });
        return { run, events, asked, usage, ids };
    }
    const starts = () => logLines().filter((l) => l.argv);

    test("turns share one process; settings change on it; the spawn is OpenCode's", async () => {
        const a = turn("hi");
        const r1 = await a.run;
        expect(r1).toMatchObject({ reason: "done", text: "Hello there" });
        expect(a.ids[0]).toMatch(/^ses_fake1_/);
        expect(a.events.filter((e) => e.type === "thinking")).toHaveLength(1);
        expect(a.usage[0]!.u).toMatchObject({ inputTokens: 100, outputTokens: 7, cacheReadTokens: 1000, cost: 0 });
        const b = turn("[[cost:0.25]] again", { mode: "plan", model: "opencode/gpt-5-nano", resumeId: a.ids[0] });
        expect((await b.run).reason).toBe("done");
        expect(b.usage[0]!.u.cost).toBe(0.25);
        expect(starts()).toHaveLength(1);
        expect(starts()[0]).toMatchObject({ argv: ["acp", "--cwd", cwd], cwd, env: { OPENCODE_DISABLE_PROJECT_CONFIG: "1" } });
        expect(JSON.parse(starts()[0].env.OPENCODE_CONFIG_CONTENT).permission["*"]).toBe("ask");
        const sets = received().filter((m) => m.method === "session/set_config_option").map((m) => [m.params.configId, m.params.value]);
        expect(sets).toEqual([["model", "opencode/gpt-5-nano"], ["mode", "plan"]]);
        // Out of plan mode: back to build.
        expect((await turn("x", { resumeId: a.ids[0], model: "opencode/gpt-5-nano" }).run).reason).toBe("done");
        expect(received().filter((m) => m.method === "session/set_config_option").at(-1).params).toMatchObject({ configId: "mode", value: "build" });
    });

    test("a model it doesn't have is a clear error", async () => {
        const r = await turn("hi", { model: "opencode/nope" }).run;
        expect(r.reason).toBe("error");
        expect(r.error).toMatch(/model not found: opencode\/nope/);
    });

    test("asks go to Cavvy; a no that stops ends the turn; bypass is hooksOnly", async () => {
        const a = turn("[[run:echo hi]]", { answer: () => ({ allow: false, message: "no", stop: true }) });
        const r = await a.run;
        expect(r.reason).toBe("aborted");
        expect(a.asked[0]).toMatchObject({ toolName: "Bash", input: { command: "echo hi" }, asksAlways: true });
        const b = turn("[[run:echo hi]]", { mode: "bypassPermissions", resumeId: undefined, key: "s2" });
        expect((await b.run).reason).toBe("done");
        expect(b.asked[0]).toMatchObject({ hooksOnly: true });
        expect(logLines().filter((l) => l.permissionAnswer).at(-1).permissionAnswer).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    });

    test("a hook's rewrite of an approved ask: refused, as the agent can only run what it asked; the same input approved goes", async () => {
        const a = turn("[[run:make build]]", { answer: () => ({ allow: true, updatedInput: { command: "make test" } }) });
        expect((await a.run).reason).toBe("done");
        expect(logLines().find((l) => l.permissionAnswer).permissionAnswer).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
        expect(a.events.filter((e) => e.type === "notice").map((e: any) => e.message)).toEqual(["Refused OpenCode's `make build`: A hook rewrote this call, and OpenCode can only run the call as it asked, so neither the rewrite nor the original ran."]);
        const b = turn("[[run:make build]]", { key: "s2", answer: (r) => ({ allow: true, updatedInput: { ...r.input } }) });
        expect((await b.run).reason).toBe("done");
        expect(logLines().filter((l) => l.permissionAnswer).at(-1).permissionAnswer).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    });

    test("an ask it can't check is refused without asking; fs/write_text_file of what it wrote is a yes", async () => {
        const a = turn("[[malformed]]");
        await a.run;
        expect(a.asked).toEqual([]);
        expect(logLines().find((l) => l.permissionAnswer).permissionAnswer).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
        expect(a.events.some((e) => e.type === "notice" && /can't tell what it would do/.test(e.message))).toBe(true);
        const b = turn("[[write:a.txt]]", { key: "s2" });
        expect((await b.run).reason).toBe("done");
        expect(readFileSync(join(cwd, "a.txt"), "utf-8")).toBe("x");
        expect(logLines().find((l) => l.fsWrite).fsWrite).toEqual({});
    });

    test("the tripwire, and reads it may do without asking", async () => {
        const a = turn("[[noask:x.txt]]");
        const r = await a.run;
        expect(r).toMatchObject({ reason: "error", error: expect.stringContaining("without asking Cavvy") });
        const b = turn("[[noask-read]]", { key: "s2" });
        expect((await b.run).reason).toBe("done");
    });

    test("the tripwire: a command it ran unasked that failed stops the turn; an edit that failed, or a command refused unrun, doesn't", async () => {
        const a = await turn("[[fail:execute]]").run;
        expect(a).toMatchObject({ reason: "error", error: expect.stringMatching(/^OpenCode ran `Bash\(make deploy\)` without asking Cavvy, so the turn was stopped/) });
        for (const [kind, key] of [["edit", "s2"], ["notrun", "s3"]]) {
            const r = await turn(`[[fail:${kind}]]`, { key }).run;
            expect([kind, r.reason, r.error]).toEqual([kind, "done", undefined]);
        }
        expect(received().filter((m) => m.method === "session/cancel")).toHaveLength(1);
    });

    test("a stop of Cavvy's own that it doesn't answer: the turn ends at the deadline with why, and the process is stopped", async () => {
        process.env.FAKE_ACP_IGNORE_CANCEL = "1";
        await backend.shutdown();
        backend = new AcpBackend(registry.getProvider("opencode")!, { interruptMs: 300 });
        const t0 = Date.now();
        const a = turn("[[noask:x.txt]]");
        while (!a.events.some((e) => e.type === "tool_start")) await Bun.sleep(5);
        const live = backend.pool.get("s1", "opencode")!;
        const pid = live.pid!;
        const r = await a.run;
        // The fake answers on its own after 3 s: the deadline ended it first.
        expect(Date.now() - t0).toBeLessThan(2500);
        expect(r).toMatchObject({ reason: "error", error: expect.stringMatching(/^OpenCode ran `Write\(.*x\.txt\)` without asking Cavvy, so the turn was stopped/) });
        // What it said before the deadline is kept, and the command it had started is closed.
        expect(r.text).toBe("Now building");
        expect(a.events.filter((e) => e.type === "assistant")).toHaveLength(1);
        expect(tools(a.events)).toEqual([expect.stringMatching(/^start Write /), expect.stringMatching(/^end Write: /), "start Bash Bash(make)", "end Bash error: Cancelled: the turn ended before it finished."]);
        expect(received().filter((m) => m.method === "session/cancel")).toHaveLength(1);
        while (live.state !== "dead") await Bun.sleep(10);
        expect(() => process.kill(pid, 0)).toThrow();
        // The next turn starts it again.
        expect((await turn("again").run).reason).toBe("done");
        expect(starts()).toHaveLength(2);
    });

    test("Esc ends the turn aborted, closing its open tool; updates after a turn's answer go nowhere", async () => {
        const ac = new AbortController();
        const a = turn("[[slow]]", { signal: ac.signal });
        while (!a.events.some((e) => e.type === "tool_start")) await Bun.sleep(5);
        ac.abort();
        const r = await a.run;
        expect(r.reason).toBe("aborted");
        expect(a.events.find((e) => e.type === "tool_end")).toMatchObject({ result: { isError: true, content: expect.stringContaining("Cancelled") } });
        const b = turn("[[late]]", { key: "s2" });
        expect((await b.run).text).toBe("Hello there");
        await Bun.sleep(50);
        const c = turn("next", { key: "s2", resumeId: b.ids[0] });
        expect((await c.run).text).toBe("Hello there");
        expect(starts()).toHaveLength(2);
        expect(c.events.some((e) => e.type === "text" && e.text === "late words")).toBe(false);
    });

    test("a crash mid-turn is an error with its stderr, and the next turn starts it again", async () => {
        const a = turn("[[crash]]");
        const r = await a.run;
        expect(r.reason).toBe("error");
        expect(r.error).toMatch(/OpenCode stopped: fatal: boom/);
        // What it said before it went is kept, and the command it had started is closed.
        expect(r.text).toBe("about to");
        expect(a.events.filter((e) => e.type === "assistant")).toHaveLength(1);
        expect(tools(a.events)).toEqual(["start Bash Bash(make)", "end Bash error: Cancelled: OpenCode stopped before it finished."]);
        expect((await turn("again").run).reason).toBe("done");
    });

    test("not signed in, and a model it won't serve, say so", async () => {
        const a = await turn("[[auth]]").run;
        expect(a.error).toMatch(/OpenCode isn't signed in: Authentication required\. Sign in with `opencode auth login`/);
        const b = await turn("[[disabled]]").run;
        expect(b.error).toBe("OpenCode: Model access is disabled");
    });

    test("a start that fails says why", async () => {
        process.env.FAKE_ACP_INIT = "fail";
        const r = await turn("hi").run;
        expect(r).toMatchObject({ reason: "error", refused: true });
        expect(r.error).toMatch(/fatal: can't start/);
    });

    test("resume: session/resume, else session/load with its replay dropped; a lost one is resumeFailed; a fork starts its own", async () => {
        const a = turn("hi", { resumeId: "ses_old" });
        expect((await a.run).text).toBe("Hello there");
        expect(received().find((m) => m.method === "session/resume")?.params).toMatchObject({ sessionId: "ses_old", cwd });
        await backend.shutdown();
        process.env.FAKE_ACP_RESUME = "load";
        const b = turn("hi", { resumeId: "ses_old" });
        const rb = await b.run;
        expect(rb.text).toBe("Hello there");
        expect(b.events.some((e) => e.type === "text" && e.text.includes("earlier"))).toBe(false);
        const c = await turn("hi", { resumeId: "gone_1", key: "s3" }).run;
        expect(c).toMatchObject({ reason: "error", resumeFailed: true });
        expect(c.error).toMatch(/^Couldn't resume the OpenCode session: .*session not found/);
        const d = await turn("hi", { resumeId: "ses_old", key: "s4", fork: true }).run;
        expect(d).toMatchObject({ reason: "error", resumeFailed: true, refused: true });
    });

    test("compaction isn't supported, and one-offs aren't answered", async () => {
        expect((await backend.compact()).error).toMatch(/isn't supported for OpenCode/);
        await expect(backend.stream({ messages: [] } as any)).rejects.toThrow(/runs whole turns only/);
    });

    test("status from initialize, models from `opencode models`, through clientFor", async () => {
        expect(await acpStatus("opencode")).toMatchObject({ installed: true, signedIn: true, path: fake, description: "OpenCode 0.0.0-fake, answering over ACP", signIn: "opencode auth login", signOut: "opencode auth logout" });
        expect(await checkAgentCli("opencode")).toMatchObject({ signedIn: true });
        expect((await acpModels("opencode")).map((m) => m.id)).toEqual(["opencode/big-pickle", "opencode/gpt-5-nano", "anthropic/claude-x"]);
        expect(received().some((m) => m.method === "session/new")).toBe(false);
        process.env.FAKE_ACP_INIT = "fail";
        expect(await acpStatus("opencode")).toMatchObject({ installed: true, signedIn: false, description: expect.stringContaining("can't start") });
        registry.saveAgentConfig("opencode", { path: join(bin, "nope") });
        expect(await acpStatus("opencode")).toMatchObject({ installed: false });
        registry.saveAgentConfig("opencode", { path: fake });
        expect((await clientFor("opencode")).constructor.name).toBe("AcpBackend");
    });
});
