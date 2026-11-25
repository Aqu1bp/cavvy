// Antigravity's CLI over ACP (`agy acp`, its hooks in src/backends/acp/agents.ts): the recorded sessions
// (test/fixtures/protocol/agy-1.5.17-acp-*.jsonl) replayed through a connection. The real agy is never run here.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { Replay } from "./helpers/acp-replay";

const { cleanup } = isolate();
const { AcpConnection } = await import("../src/backends/acp/connection");
const { acpAgent, agyModels } = await import("../src/backends/acp/agents");
const { agentCli } = await import("../src/backends/defs");
const { backendModel } = await import("../src/backends/types");
const { cliRunsSkill, cliRunsSkills } = await import("../src/backends/native-skills");
type AgentEvent = import("../src/agent/agent").AgentEvent;
type CliEvent = import("../src/backends/live/types").CliEvent;
type SessionHost = import("../src/backends/types").SessionHost;
type BackendPermission = import("../src/backends/types").BackendPermission;
type PermissionAnswer = import("../src/backends/types").PermissionAnswer;
type PermissionMode = import("../src/permissions/modes").PermissionMode;
type AttachedFiles = import("../src/backends/acp/connection").AttachedFiles;

const AGY = agentCli("antigravity")!;
const bin = tempDir("fake-agy-");

afterAll(() => {
    cleanup();
    rmSync(bin, { recursive: true, force: true });
});

const texts = (es: AgentEvent[]) => es.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
const notices = (es: AgentEvent[]) => es.flatMap((e) => (e.type === "notice" ? [`${e.level}: ${e.message}`] : []));
const tools = (es: AgentEvent[]) => es.flatMap((e) => (e.type === "tool_start" ? [`start ${e.call.name} ${e.title}`] : e.type === "tool_end" ? [`end ${e.call.name}${e.result.isError ? " error" : ""}`] : []));

/** A recording whose agent takes a moment after each answer to its asks, as a real one does (its next step is a model call). */
class SlowReplay extends Replay {
    override async send(m: any): Promise<boolean> {
        if (m.method === undefined && m.result?.outcome) await Bun.sleep(30);
        return super.send(m);
    }
}

/** A recording that stays open once played to its end, as a live agent does: what's sent after it is answered ({}). */
class OpenReplay extends Replay {
    override end() {}
}

/** Open, and its answers to prompts after the recording's own wait until `release` (a model still at work on them). */
class HeldReplay extends OpenReplay {
    readonly held: number[] = [];
    override async send(m: any): Promise<boolean> {
        if (m.method !== "session/prompt" || !this.sent.some((x) => x.method === "session/prompt")) return super.send(m);
        this.sent.push(m);
        this.extra.push(m);
        this.held.push(m.id);
        return true;
    }
    release() {
        for (const id of this.held.splice(0)) (this as any).push({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }
}

interface ReplayOptions {
    slow?: boolean;
    open?: boolean;
    held?: boolean;
    mode?: PermissionMode;
    answer?: (r: BackendPermission) => PermissionAnswer | Promise<PermissionAnswer>;
    orchestrator?: { name: string; url: string; authorization: string; tools: string[]; checksItself?: string[]; inputKeys?: Record<string, string[]> };
    files?: AttachedFiles;
    readOnly?: boolean;
    model?: string;
}

/** A connection to a recorded agy session, opened in a mode with Gemini 4 Neon at medium effort (what the probes set). */
async function replay(name: string, o: ReplayOptions = {}) {
    const rec = new (o.slow ? SlowReplay : o.held ? HeldReplay : o.open ? OpenReplay : Replay)(`agy-1.5.17-acp-${name}`);
    const events: CliEvent[] = [];
    const asked: BackendPermission[] = [];
    let mode: PermissionMode = o.mode ?? "default";
    const h: SessionHost = {
        mode: () => mode,
        permission: async (r) => {
            asked.push(r);
            return o.answer ? o.answer(r) : { allow: true };
        },
        askQuestions: async () => undefined,
        approvePlan: async () => ({ approved: false }),
        setMode: () => {},
        usage: () => {},
        sessionId: () => {},
    };
    const conn = new AcpConnection(
        rec as any,
        (e) => events.push(e),
        h,
        AGY,
        acpAgent("antigravity"),
        "/tmp/acp-agy",
        () => undefined,
        () => o.orchestrator as any,
        () => Boolean(o.readOnly),
        () => o.files,
    );
    await conn.initialize();
    await conn.open({ settings: { model: backendModel("antigravity", o.model ?? "gemini-4-neon-medium"), mode, effort: "medium" } });
    const ended = () => events.filter((e): e is Extract<CliEvent, { t: "turn_ended" }> => e.t === "turn_ended");
    const turn = async (text: string, extra: { documents?: any[] } = {}) => {
        const before = ended().length;
        const { ref } = await conn.prompt({ text, images: [], ...extra });
        for (let i = 0; i < 500 && ended().length === before; i++) await Bun.sleep(5);
        const end = ended()[before];
        expect(end?.ref).toBe(ref);
        return end!;
    };
    const agentEvents = () => events.flatMap((e) => (e.t === "turn_event" ? [e.event] : []));
    /** The answers sent to its asks, by its own option ids. */
    const replies = () => rec.sent.filter((m) => m.method === undefined && m.result?.outcome).map((m) => m.result.outcome.optionId ?? m.result.outcome.outcome);
    return { rec, conn, events, agentEvents, asked, turn, replies, setMode: (m: PermissionMode) => (mode = m) };
}

describe("Antigravity 1.5.17 over ACP, recorded", () => {
    test("a text prompt: the model by its id with effort (no effort of its own); no set_mode when it's in the mode already", async () => {
        const r = await replay("pong");
        const end = await r.turn("Reply with the single word: pong");
        expect(end.reason).toBe("done");
        expect(texts(r.agentEvents())).toBe("pong");
        const set = r.rec.sent.filter((m) => m.method === "session/set_config_option").map((m) => [m.params.configId, m.params.value]);
        expect(set).toEqual([["model", "gemini-4-neon-medium"]]);
        expect(r.rec.sent.some((m) => m.method === "session/set_mode")).toBe(false);
        expect(notices(r.agentEvents())).toEqual([]);
    });

    test("its commands and skills go to Cavvy's menus, once, when they change", async () => {
        const r = await replay("pong");
        await r.turn("Reply with the single word: pong");
        const lists = r.agentEvents().filter((e): e is Extract<AgentEvent, { type: "cli_commands" }> => e.type === "cli_commands");
        expect(lists).toHaveLength(1);
        expect(lists[0]!.provider).toBe("antigravity");
        expect(lists[0]!.names).toEqual(expect.arrayContaining(["goal", "compact"]));
    });

    test("Manual (its default): each ask goes to the user as its own, Allow and Deny only, shown as Cavvy's tools", async () => {
        const answers: PermissionAnswer[] = [{ allow: true }, { allow: false, message: "no", stop: false }];
        const r = await replay("mode-default", { answer: () => answers.shift()! });
        expect((await r.turn("Do these three steps")).reason).toBe("done");
        expect(r.asked).toEqual([
            expect.objectContaining({ native: true, toolName: "Write", input: { file_path: "/tmp/acp-agy/a.txt", content: "a" }, callId: expect.stringMatching(/^call_/) }),
            expect.objectContaining({ native: true, toolName: "Bash", input: { command: "echo b > b.txt" } }),
        ]);
        expect(r.replies()).toEqual(["allow", "deny"]);
        // No tripwire, and no notice: it decides what it asks about.
        expect(notices(r.agentEvents())).toEqual([]);
        expect(tools(r.agentEvents())).toEqual(expect.arrayContaining(["start Write Write(/tmp/acp-agy/a.txt)", "start Bash Bash(echo b > b.txt)"]));
    });

    test("each of Cavvy's modes is its own: Accept edits, Auto and Plan by session/set_mode", async () => {
        for (const [mode, own, fixture] of [
            ["acceptEdits", "accept-edits", "mode-accept-edits"],
            ["auto", "auto", "mode-auto"],
            ["plan", "plan", "mode-plan"],
        ] as const) {
            const r = await replay(fixture, { mode });
            expect(r.rec.sent.filter((m) => m.method === "session/set_mode").map((m) => m.params.modeId)).toEqual([own]);
            await r.turn("Do these three steps");
            // Auto: its reviewer let all three go.
            if (mode === "auto") expect(r.asked).toEqual([]);
            else expect(r.asked.every((a) => a.native && a.toolName === "Bash")).toBe(true);
        }
    });

    test("a read-only agent of Cavvy's runs in its plan mode, whatever the session's", async () => {
        const r = await replay("mode-plan", { mode: "acceptEdits", readOnly: true });
        expect(r.rec.sent.filter((m) => m.method === "session/set_mode").map((m) => m.params.modeId)).toEqual(["plan"]);
    });

    test("Bypass: its own flag, so it asks nothing; and an ask that comes anyway (before its restart) is let go", async () => {
        const g = acpAgent("antigravity");
        expect(g.spawn({ cwd: "/w", mode: "bypassPermissions" } as any).args).toEqual(["--dangerously-skip-permissions"]);
        expect(g.spawn({ cwd: "/w", mode: "default" } as any).args).toEqual([]);
        expect(g.spawn({ cwd: "/w", mode: "bypassPermissions", readOnly: true } as any).args).toEqual([]);
        expect(g.spawn({ cwd: "/w", mode: "auto", additionalDirectories: ["/a", "../b", "/a"] } as any).args).toEqual(["--add-dir", "/a", "--add-dir", "/b"]);
        const r = await replay("mode-bypass", { mode: "bypassPermissions" });
        await r.turn("Do these three steps");
        expect(r.asked).toEqual([]);
        // In a session started without the flag, Bypass answers its asks yes.
        const before = await replay("mode-default", { mode: "bypassPermissions" });
        await before.turn("Do these three steps");
        expect(before.asked).toEqual([]);
        expect(before.replies()).toEqual(["allow", "allow"]);
    });

    test("a mode its session doesn't list runs as Manual, and the user is told with the next turn", async () => {
        const r = await replay("pong", { mode: "auto" });
        // The recording's session listed auto; one without it is as this account's would be.
        (r.conn as any).modesListed = ["default", "accept-edits", "plan"];
        (r.conn as any).modeId = "plan";
        const before = r.rec.extra.length;
        await r.conn.apply({ mode: "auto" });
        expect(r.rec.extra.slice(before).filter((m) => m.method === "session/set_mode").map((m) => m.params.modeId)).toEqual(["default"]);
        await r.turn("Reply with the single word: pong");
        expect(notices(r.agentEvents())).toEqual(["warn: Antigravity has no Auto here. Using Manual."]);
    });

    test("a no with words: Deny, then the words go to it as a message steering the turn", async () => {
        const r = await replay("mode-default", {
            slow: true,
            answer: (q) => (q.toolName === "Bash" ? { allow: false, message: "The user declined this tool call and said:\nuse printf", stop: false, fromUser: true } : { allow: true }),
        });
        await r.turn("Do these three steps");
        expect(r.replies()).toEqual(["allow", "deny"]);
        expect(notices(r.agentEvents())).toEqual([]);
        const prompts = r.rec.sent.filter((m) => m.method === "session/prompt").map((m) => m.params.prompt[0].text);
        expect(prompts.at(-1)).toBe("The user declined this tool call and said:\nuse printf");
    });

    test("a no with words, when it ends its prompt at once (as recorded, 5 ms after the Deny): the turn waits, and the words go as a prompt of its own", async () => {
        const r = await replay("mode-default", {
            open: true,
            answer: (q) => (q.toolName === "Bash" ? { allow: false, message: "The user declined this tool call and said:\nuse printf", stop: false, fromUser: true } : { allow: true }),
        });
        const end = await r.turn("Do these three steps");
        expect(end.reason).toBe("done");
        expect(notices(r.agentEvents())).toEqual([]);
        // Sent after its prompt answered, and answered before the turn ended.
        expect(r.rec.extra.map((m) => [m.method, m.params?.prompt?.[0]?.text])).toEqual([["session/prompt", "The user declined this tool call and said:\nuse printf"]]);
    });

    test("a no's words sent as a prompt of their own (its prompt had ended): it can be steered while it works on them", async () => {
        const r = await replay("mode-default", {
            held: true,
            answer: (q) => (q.toolName === "Bash" ? { allow: false, message: "The user declined this tool call and said:\nuse printf", stop: false, fromUser: true } : { allow: true }),
        });
        const rec = r.rec as HeldReplay;
        const { ref } = await r.conn.prompt({ text: "Do these three steps", images: [] });
        while (!rec.held.length) await Bun.sleep(1);
        expect(await r.conn.steer(ref, { text: "And say kiwi.", images: [] })).toBe(true);
        expect(rec.extra.map((m) => m.params.prompt[0].text)).toEqual(["The user declined this tool call and said:\nuse printf", "And say kiwi."]);
        rec.release();
        for (let i = 0; i < 500 && !r.events.some((e) => e.t === "turn_ended"); i++) await Bun.sleep(5);
        expect(r.events.find((e) => e.t === "turn_ended")).toMatchObject({ ref, reason: "done" });
    });

    test("a question still waiting when the turn stops is withdrawn", async () => {
        const r = await replay("cancel", { answer: () => new Promise<PermissionAnswer>(() => {}) });
        const { ref } = await r.conn.prompt({ text: "sleep 20", images: [] });
        while (!r.asked.length) await Bun.sleep(5);
        expect(r.asked[0]!.signal?.aborted).toBe(false);
        await r.conn.interrupt(ref);
        for (let i = 0; i < 500 && !r.events.some((e) => e.t === "turn_ended"); i++) await Bun.sleep(5);
        expect(r.asked[0]!.signal?.aborted).toBe(true);
    });

    test("a no without words stops the turn: session/cancel after the Deny", async () => {
        const r = await replay("mode-default", { slow: true, answer: (q) => (q.toolName === "Bash" ? { allow: false, message: "no", stop: true } : { allow: true }) });
        const end = await r.turn("Do these three steps");
        expect(r.replies()).toEqual(["allow", "deny"]);
        expect(r.rec.sent.some((m) => m.method === "session/cancel")).toBe(true);
        expect(end.reason).not.toBe("error");
    });

    test("Cavvy's MCP server over HTTP with its header; asks about a tool of it that checks its calls itself are let go", async () => {
        const o = { name: "probe", url: "http://127.0.0.1:1/mcp", authorization: "Bearer probe-token", tools: ["probe_echo"], checksItself: ["probe_echo"], inputKeys: { probe_echo: ["word"] } };
        const r = await replay("mcp-http", { orchestrator: o });
        expect(r.rec.sent.find((m) => m.method === "session/new")?.params.mcpServers).toEqual([{ type: "http", name: "probe", url: o.url, headers: [{ name: "Authorization", value: o.authorization }] }]);
        await r.turn("Call the probe_echo tool");
        expect(r.asked).toEqual([]);
        expect(r.replies()).toEqual(["allow"]);
        expect(texts(r.agentEvents())).toBe("echo-kiwi");
        // Its row is the tool's, with the arguments the server got ({"word":"kiwi"}, as recorded), not agy's toolSummary:
        // so a session tool's call is known to be the main agent's (servedSessionCaller).
        const starts = r.agentEvents().filter((e): e is Extract<AgentEvent, { type: "tool_start" }> => e.type === "tool_start");
        expect(starts.map((e) => [e.call.name, e.call.input])).toEqual([["mcp__probe__probe_echo", { word: "kiwi" }]]);
        // One that doesn't (delegate, schedules): its ask is the user's, named as Cavvy's tool, with its arguments.
        const asks = await replay("mcp-http", { orchestrator: { ...o, checksItself: [] } });
        await asks.turn("Call the probe_echo tool");
        expect(asks.asked).toEqual([expect.objectContaining({ native: true, toolName: "mcp__probe__probe_echo", input: { word: "kiwi" } })]);
        expect(asks.asked[0]!.title).toBeUndefined();
        // Another server's tool is the user's to answer, whatever its input says (another agent's way of naming Cavvy's).
        const theirs = await replay("mcp-http", { orchestrator: { ...o, tools: ["probe_echo", "theme_list"], checksItself: ["theme_list"], inputKeys: { ...o.inputKeys, theme_list: [] } }, answer: () => ({ allow: false, message: "no", stop: false }) });
        const fake = { tools: new Map(), waiting: new Set() };
        const options = [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }];
        const call = { kind: "other", title: "Run mcp_github_create_issue", rawInput: { tool_name: "mcp__cavvy__theme_list", tool_input: {} } };
        expect(await (theirs.conn as any).ownAsk(fake, call, options, "")).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
        expect(theirs.asked).toEqual([expect.objectContaining({ native: true, toolName: "Antigravity" })]);
        const other = acpAgent("antigravity").mcpTool!;
        expect(other({ kind: "other", title: "Run mcp_probe_probe_ping" }, "probe")).toBe("probe_ping");
        expect(other({ kind: "other", title: "Run mcp_github_create_issue" }, "probe")).toBeUndefined();
        expect(other({ kind: "execute", title: "Run mcp_probe_x" }, "probe")).toBeUndefined();
    });

    test("a PDF goes as a link to a file of the user's; its read of that file is let go, another read is asked about", async () => {
        const dir = tempDir("agy-attach-");
        const files: AttachedFiles = { dir: join(dir, "files"), paths: new Set(["/tmp/acp-agy-attach/linked.pdf"]), count: 0 };
        const r = await replay("pdf", { files, answer: () => ({ allow: false, message: "no", stop: false }) });
        await r.turn("What is the secret word in the attached PDF?", { documents: [{ type: "pdf", name: "../secret report.pdf", data: Buffer.from("%PDF-1.4").toString("base64") }] });
        const link = r.rec.sent.filter((m) => m.method === "session/prompt")[0].params.prompt[1];
        expect(link).toMatchObject({ type: "resource_link", name: "../secret report.pdf", mimeType: "application/pdf" });
        const path = decodeURIComponent(new URL(link.uri).pathname);
        expect(path).toBe(join(files.dir, "1-secret_report.pdf"));
        expect(readFileSync(path, "utf-8")).toBe("%PDF-1.4");
        expect(files.paths.has(path)).toBe(true);
        // The recording's ls was asked about.
        expect(r.asked.map((a) => a.toolName)).toEqual(["Bash"]);
        await r.turn("What is the secret word in the attached notes.txt?");
        await r.turn("What is the secret word in the attached PDF?");
        // The read of the attached file: let go, unasked.
        expect(r.asked.map((a) => a.toolName)).toEqual(["Bash"]);
        expect(r.replies()).toEqual(["deny", "allow"]);
        rmSync(dir, { recursive: true, force: true });
        expect(existsSync(path)).toBe(false);
    });

    test("a PDF it can't write: the prompt is refused with why, and the next one runs", async () => {
        const files: AttachedFiles = { dir: "/dev/null/agy-files", paths: new Set(), count: 0 };
        const r = await replay("pong", { files });
        const pdf = { type: "pdf", name: "a.pdf", data: Buffer.from("%PDF-1.4").toString("base64") };
        await expect(r.conn.prompt({ text: "Read it", images: [], documents: [pdf] } as any)).rejects.toThrow(/^Couldn't attach the files: /);
        expect(r.rec.sent.some((m) => m.method === "session/prompt")).toBe(false);
        expect((await r.turn("Reply with the single word: pong")).reason).toBe("done");
    });

    test("steering: a second session/prompt; the first answers while its ask waits, and the turn goes on to the end", async () => {
        const r = await replay("steer");
        const { ref } = await r.conn.prompt({ text: "Run these three shell commands", images: [] });
        while (!r.agentEvents().some((e) => e.type === "tool_start")) await Bun.sleep(5);
        expect(await r.conn.steer(ref, { text: "Also, end your final reply with the word banana.", images: [] })).toBe(true);
        for (let i = 0; i < 500 && !r.events.some((e) => e.t === "turn_ended"); i++) await Bun.sleep(5);
        expect(r.events.find((e) => e.t === "turn_ended")).toMatchObject({ ref, reason: "done" });
        expect(r.replies()).toEqual(["allow", "allow", "allow"]);
        expect(texts(r.agentEvents())).toContain("banana");
    });

    test("steering again: the first prompt's answer (it ended at the steer) doesn't end the turn's steering", async () => {
        const r = await replay("steer", { slow: true });
        const { ref } = await r.conn.prompt({ text: "Run these three shell commands", images: [] });
        while (!r.agentEvents().some((e) => e.type === "tool_start")) await Bun.sleep(1);
        expect(await r.conn.steer(ref, { text: "Also, end your final reply with the word banana.", images: [] })).toBe(true);
        // The recording answers the first prompt 3 ms after the steer, as its next ask comes.
        while (!(r.conn as any).turn?.answers.length) await Bun.sleep(1);
        expect(await r.conn.steer(ref, { text: "And say kiwi.", images: [] })).toBe(true);
        for (let i = 0; i < 500 && !r.events.some((e) => e.t === "turn_ended"); i++) await Bun.sleep(5);
        expect(r.events.find((e) => e.t === "turn_ended")).toMatchObject({ ref, reason: "done" });
        expect(r.rec.extra.map((m) => m.params?.prompt?.[0]?.text)).toEqual(["And say kiwi."]);
    });

    test("Esc: session/cancel ends the turn at once; the next one runs", async () => {
        const r = await replay("cancel");
        const { ref } = await r.conn.prompt({ text: "sleep 20", images: [] });
        while (!r.asked.length) await Bun.sleep(5);
        await r.conn.interrupt(ref);
        for (let i = 0; i < 500 && !r.events.some((e) => e.t === "turn_ended"); i++) await Bun.sleep(5);
        expect(r.events.find((e) => e.t === "turn_ended")).toMatchObject({ reason: "aborted" });
        expect(r.rec.sent.some((m) => m.method === "session/cancel")).toBe(true);
    });
});

describe("Antigravity's hooks", () => {
    test("its def: over `agy acp`, skills of its own, effort in its model ids", () => {
        expect(AGY).toMatchObject({ protocol: "acp", acpArgs: ["acp"], caps: { skills: "own", live: { model: true, effort: false, mode: "per-turn" }, pdfs: true } });
        // Cavvy's skills are pasted for it, but one of a name it lists is its own, and goes as typed.
        expect(cliRunsSkills("antigravity")).toBe(false);
        expect(cliRunsSkill("antigravity", "grill-me", new Set(["grill-me"]))).toBe(true);
        expect(cliRunsSkill("antigravity", "mine", new Set(["grill-me"]))).toBe(false);
        expect(cliRunsSkill("antigravity", "mine", undefined)).toBe(false);
        expect(cliRunsSkill("opencode", "grill-me", new Set(["grill-me"]))).toBe(false);
        expect(cliRunsSkill("claude-code", "mine", undefined)).toBe(true);
        expect(cliRunsSkills("codex")).toBe(true);
        expect(cliRunsSkills(undefined)).toBe(false);
        // Only its Gemini models read a PDF (with Claude Sonnet 5.5 its read_file refused one, by hand in the app).
        const reads = acpAgent("antigravity").readsPdf!;
        expect(["gemini-4-neon-medium", "gemini-3.8-flash-low", "claude-sonnet-5-5-low", "gpt-oss-120b-medium"].map(reads)).toEqual([true, true, false, false]);
    });

    test("whether a model reads PDFs, listed or not, or cached from before it was said", async () => {
        const { resolveModelInfo } = await import("../src/providers/models");
        const { paths } = await import("../src/config/paths");
        const { mkdirSync } = await import("fs");
        const { dirname } = await import("path");
        expect(resolveModelInfo("antigravity:claude-sonnet-5-5-low")).toMatchObject({ supportsPdf: false, supportsReasoning: false });
        expect(resolveModelInfo("antigravity:gemini-4-neon-medium")).toMatchObject({ supportsPdf: true });
        mkdirSync(dirname(paths.modelCache()), { recursive: true });
        const cached = (extra: object) => ({ version: 3, providers: { antigravity: { fetchedAt: Date.now(), fp: "x", models: [{ provider: "antigravity", id: "claude-sonnet-5-5-low", name: "Cached", ...extra }] } } });
        writeFileSync(paths.modelCache(), JSON.stringify(cached({})));
        expect(resolveModelInfo("antigravity:claude-sonnet-5-5-low")).toMatchObject({ supportsPdf: false, name: "Cached" });
        writeFileSync(paths.modelCache(), JSON.stringify(cached({ supportsPdf: false })));
        expect(resolveModelInfo("antigravity:claude-sonnet-5-5-low")).toMatchObject({ supportsPdf: false, name: "Cached" });
        rmSync(paths.modelCache(), { force: true });
    });

    test("`agy models`: its ids and names; signed out, none", async () => {
        const fake = join(bin, "agy");
        const out = join(bin, "out.txt");
        writeFileSync(fake, `#!/bin/sh\ncat "${out}"\n`);
        chmodSync(fake, 0o755);
        writeFileSync(out, "gemini-4-neon-medium\tGemini 4 Neon (Medium)\ngemini-4-carbon-low\tGemini 4 Carbon (Low)\n\nnot a model line\n");
        expect(await agyModels(fake)).toEqual({ signedIn: true, models: [{ id: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" }, { id: "gemini-4-carbon-low", name: "Gemini 4 Carbon (Low)" }] });
        writeFileSync(out, "Please sign in to view available models. Launch the CLI without arguments to sign in.\n");
        expect(await agyModels(fake)).toEqual({ signedIn: false, models: [] });
    });
});
