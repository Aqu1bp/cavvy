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

interface ReplayOptions {
    slow?: boolean;
    mode?: PermissionMode;
    answer?: (r: BackendPermission) => PermissionAnswer | Promise<PermissionAnswer>;
    orchestrator?: { name: string; url: string; authorization: string; tools: string[]; checksItself?: string[] };
    files?: AttachedFiles;
    readOnly?: boolean;
    model?: string;
}

/** A connection to a recorded agy session, opened in a mode with Gemini 4 Neon at medium effort (what the probes set). */
async function replay(name: string, o: ReplayOptions = {}) {
    const rec = new (o.slow ? SlowReplay : Replay)(`agy-1.5.17-acp-${name}`);
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

    test("a no without words stops the turn: session/cancel after the Deny", async () => {
        const r = await replay("mode-default", { slow: true, answer: (q) => (q.toolName === "Bash" ? { allow: false, message: "no", stop: true } : { allow: true }) });
        const end = await r.turn("Do these three steps");
        expect(r.replies()).toEqual(["allow", "deny"]);
        expect(r.rec.sent.some((m) => m.method === "session/cancel")).toBe(true);
        expect(end.reason).not.toBe("error");
    });

    test("Cavvy's MCP server over HTTP with its header; asks about a tool of it that checks its calls itself are let go", async () => {
        const o = { name: "probe", url: "http://127.0.0.1:1/mcp", authorization: "Bearer probe-token", tools: ["probe_ping"], checksItself: ["probe_ping"] };
        const r = await replay("mcp-http", { orchestrator: o });
        expect(r.rec.sent.find((m) => m.method === "session/new")?.params.mcpServers).toEqual([{ type: "http", name: "probe", url: o.url, headers: [{ name: "Authorization", value: o.authorization }] }]);
        await r.turn("Call the probe_ping tool");
        expect(r.asked).toEqual([]);
        expect(r.replies()).toEqual(["allow"]);
        expect(texts(r.agentEvents())).toBe("pong-from-mcp");
        // One that doesn't (delegate, schedules): its ask is the user's, named as Cavvy's tool.
        const asks = await replay("mcp-http", { orchestrator: { ...o, checksItself: [] } });
        await asks.turn("Call the probe_ping tool");
        expect(asks.asked).toEqual([expect.objectContaining({ native: true, toolName: "mcp__probe__probe_ping", input: {} })]);
        expect(asks.asked[0]!.title).toBeUndefined();
        // Another server's tool is the user's to answer.
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
