// Antigravity's CLI (agy) through the real Agent loop and Cavvy's permission checks, with a fake `agy`
// (test/fixtures/fake-agy.ts) that runs the gate's hook as agy does. Nothing here runs the real agy.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { cleanup } = isolate();
const registry = await import("../src/providers/registry");
const { clientFor, forgetClient } = await import("../src/providers/models");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const trust = await import("../src/config/trust");
const gate = await import("../src/backends/agy/gate");
const { agyStatus, agyModels } = await import("../src/backends/agy/backend");
type AgentEvent = import("../src/agent/agent").AgentEvent;
type PermissionRequest = import("../src/agent/agent").PermissionRequest;
type PermissionResponse = import("../src/agent/agent").PermissionResponse;
type PermissionMode = import("../src/permissions/modes").PermissionMode;

const bin = tempDir("fake-agy-");
const LOG = join(bin, "log.jsonl");
const fake = join(bin, "agy");
writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-agy.ts")}" "$@"\n`);
chmodSync(fake, 0o755);
const gateRoot = realpathSync(tempDir("agy-gate-root-"));
gate.gateRoot.dir = () => gateRoot;

afterAll(() => {
    gate.stopGateServer();
    cleanup();
    rmSync(bin, { recursive: true, force: true });
    rmSync(gateRoot, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

const logLines = (): any[] => (existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
/** What the gate answered agy's PreToolUse hook, in order. */
const decisions = () => logLines().flatMap((l) => (l.hook === "PreToolUse" ? l.answers.map((a: any) => a.decision) : []));
const spawns = () => logLines().flatMap((l) => (l.argv && l.argv[0] !== "models" ? [l.argv as string[]] : []));

let cwd: string;
beforeEach(() => {
    cwd = realpathSync(tempDir("agy-proj-"));
    rmSync(LOG, { force: true });
    process.env.FAKE_LOG = LOG;
    delete process.env.FAKE_AGY_SIGNED_OUT;
    registry.saveAgentConfig("antigravity", { path: fake });
    forgetClient("antigravity");
});
afterEach(async () => {
    const c = await clientFor("antigravity");
    await (c as any).shutdown?.();
});

async function makeAgent(o: { untrusted?: boolean; mode?: PermissionMode; settings?: any; ask?: (r: PermissionRequest) => PermissionResponse | Promise<PermissionResponse>; queued?: string[] } = {}) {
    const settings = o.settings ?? {};
    const events: AgentEvent[] = [];
    const asked: PermissionRequest[] = [];
    let mode: PermissionMode = o.mode ?? "default";
    if (!o.untrusted) trust.trustForSession(cwd);
    const client = await clientFor("antigravity");
    const session = Session.create(cwd, { persist: false });
    const agent = new Agent({
        session,
        model: { provider: "antigravity", id: "gemini-4-argon-high" },
        client,
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        host: {
            drainQueued: () => o.queued?.splice(0) ?? [],
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
    const run = (text: string, signal = new AbortController().signal) => agent.run([{ type: "text", text }], { signal });
    return { agent, events, asked, session, run, setMode: (m: PermissionMode) => (mode = m) };
}
const notices = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "notice" ? [`${e.level}: ${e.message}`] : []));
const ends = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "tool_end" ? [e] : []));
const said = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "assistant" ? [e.message.content.map((c: any) => c.text).join("")] : []));

describe("the gate, by Cavvy's mode", () => {
    test("a folder with hooks of its own: it runs only once the folder is trusted", async () => {
        mkdirSync(join(cwd, ".agents"));
        writeFileSync(join(cwd, ".agents", "hooks.json"), "{}");
        expect(trust.projectConfigSummary(cwd)).toContain(".agents/hooks.json");
        const a = await makeAgent({ untrusted: true });
        expect(await a.run("hi")).not.toBe("done");
        expect(JSON.stringify(a.events)).toContain("runs here only once you trust the folder");
        expect(spawns()).toEqual([]);
        trust.trustFolder(cwd);
        expect(await (await makeAgent()).run("hi")).toBe("done");
        expect(spawns()).toHaveLength(1);
    });

    test("Manual: a write asks, with its content; a yes runs it, and its row shows what it wrote", async () => {
        const a = await makeAgent({ ask: () => ({ allow: true }) });
        expect(await a.run("[[write:a.txt]]")).toBe("done");
        expect(a.asked).toHaveLength(1);
        expect(a.asked[0]).toMatchObject({ tool: { name: "Write" }, input: { file_path: join(cwd, "a.txt"), content: "x" } });
        expect(decisions()).toEqual(["auto_approve"]);
        expect(readFileSync(join(cwd, "a.txt"), "utf-8")).toBe("x");
        const end = ends(a.events)[0]!;
        expect(end).toMatchObject({ call: { name: "Write", input: { file_path: join(cwd, "a.txt") } }, result: { isError: false, display: { diff: { path: "a.txt", before: "", after: "x" } } } });
        // The session goes on in the same conversation.
        expect(a.session.backends.get("antigravity")?.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    test("a no refuses it, and the model reads why", async () => {
        const a = await makeAgent({ ask: () => ({ allow: false, feedback: "use b.txt instead" }) });
        await a.run("[[write:a.txt]]");
        expect(decisions()).toEqual(["deny"]);
        expect(existsSync(join(cwd, "a.txt"))).toBe(false);
        expect(said(a.events).join("")).toContain("tool call denied by pre-tool hook");
        expect(said(a.events).join("")).toContain("use b.txt instead");
    });

    test("a read-only command runs unasked; another asks; with no one to ask, it's refused", async () => {
        const a = await makeAgent({ ask: () => ({ allow: false, feedback: "not now" }) });
        await a.run("[[run:ls]]");
        expect(a.asked).toEqual([]);
        await a.run("[[run:rm -rf build]]");
        expect(a.asked).toHaveLength(1);
        expect(a.asked[0]).toMatchObject({ tool: { name: "Bash" }, input: { command: "rm -rf build" } });
        const b = await makeAgent();
        await b.run("[[run:make]]");
        expect(decisions()).toEqual(["auto_approve", "deny", "deny"]);
    });

    test("a no without a word refuses the call and stops the turn", async () => {
        const a = await makeAgent({ ask: () => ({ allow: false }) });
        expect(await a.run("[[run:rm -rf build]]")).toBe("denied");
        expect(logLines().some((l) => l.signal === "SIGINT")).toBe(true);
        // The next message goes on in the same conversation.
        const id = a.session.backends.get("antigravity")?.id;
        expect(await a.run("hello")).toBe("done");
        expect(spawns()[1]).toContain(id!);
    });

    test("Plan refuses a write without asking; Bypass runs it unasked, but a deny rule still refuses", async () => {
        const a = await makeAgent({ mode: "plan", ask: () => ({ allow: true }) });
        await a.run("[[write:p.txt]]");
        expect(a.asked).toEqual([]);
        // It has no ExitPlanMode: the reason it reads says what it can do.
        expect(logLines().find((l) => l.hook === "PreToolUse").answers[0].reason).toBe("Plan mode is active: files can't be modified. Present your plan in your reply: the user leaves Plan mode when it's ready.");
        expect(existsSync(join(cwd, "p.txt"))).toBe(false);
        const b = await makeAgent({ mode: "bypassPermissions", settings: { permissions: { deny: ["Bash(curl:*)"] } }, ask: () => ({ allow: true }) });
        await b.run("[[run:make build]]");
        await b.run("[[run:curl https://x.test]]");
        expect(b.asked).toEqual([]);
        expect(decisions()).toEqual(["deny", "auto_approve", "deny"]);
    });

    test("a tool of its own Cavvy has none for is asked about as Antigravity's", async () => {
        const a = await makeAgent({ ask: () => ({ allow: true }) });
        await a.run("[[tool:generate_image]]");
        expect(a.asked[0]).toMatchObject({ tool: { name: "Antigravity" } });
        expect(decisions()).toEqual(["auto_approve"]);
    });

    test("a write into the gate's own folder is refused without asking", async () => {
        const a = await makeAgent({ ask: () => ({ allow: true }) });
        await a.run(`[[write:${join(gate.gateDir(), "x.txt")}]]`);
        expect(a.asked).toEqual([]);
        expect(decisions()).toEqual(["deny"]);
        expect(existsSync(join(gate.gateDir(), "x.txt"))).toBe(false);
    });

    test("a new conversation is told its folder; the hook gets the gate's address only through agy's environment", async () => {
        const a = await makeAgent();
        await a.run("hello");
        const start = logLines().find((l) => l.hook === "SessionStart");
        expect(start.answers[0].injectSteps[0].ephemeralMessage).toContain(`Your working folder is ${cwd}`);
        expect(logLines().find((l) => l.argv)?.gateEnv).toBe(true);
        const args = spawns()[0]!;
        expect(args.slice(args.indexOf("--add-dir"), args.indexOf("--add-dir") + 2)).toEqual(["--add-dir", gate.gateDir()]);
        expect(args.at(-1)).toBe("-p=");
    });
});

describe("the tripwire", () => {
    test("a command that ran without the gate stops the turn and says so", async () => {
        const a = await makeAgent({ ask: () => ({ allow: true }) });
        const r = await a.run("[[unasked]]");
        expect(r).toBe("error");
        expect(notices(a.events).join("\n")).toContain("without Cavvy's permission check");
    });
});

describe("turns and the conversation", () => {
    test("Esc stops it with SIGINT; the next message resumes the same conversation in a new process", async () => {
        const a = await makeAgent({ ask: () => ({ allow: true }) });
        await a.run("hello");
        const id = a.session.backends.get("antigravity")?.id;
        const ac = new AbortController();
        const run = a.run("[[hang]]", ac.signal);
        while (!logLines().some((l) => l.hook === "PreToolUse")) await Bun.sleep(10);
        ac.abort();
        expect(await run).toBe("aborted");
        expect(logLines().some((l) => l.signal === "SIGINT")).toBe(true);
        expect(await a.run("again")).toBe("done");
        const s = spawns();
        expect(s).toHaveLength(2);
        expect(s[1]!.slice(s[1]!.indexOf("--conversation"), s[1]!.indexOf("--conversation") + 2)).toEqual(["--conversation", id!]);
        expect(a.session.backends.get("antigravity")?.id).toBe(id);
    });

    test("a model change restarts it on the same conversation", async () => {
        const a = await makeAgent();
        await a.run("hello");
        const id = a.session.backends.get("antigravity")?.id;
        a.agent.model = { provider: "antigravity", id: "gemini-3.8-flash-low" };
        await a.run("again");
        const s = spawns();
        expect(s.map((x) => x[x.indexOf("--model") + 1])).toEqual(["gemini-4-argon-high", "gemini-3.8-flash-low"]);
        expect(s[1]).toContain(id!);
    });

    test("an image and a PDF go as files of Cavvy's it reads, without asking; they're gone with its process", async () => {
        const a = await makeAgent({ ask: () => ({ allow: false, feedback: "no" }) });
        const png = Buffer.from("iVBORw0KGgo=", "base64");
        const r = await a.agent.run(
            [
                { type: "text", text: "look" },
                { type: "image", mediaType: "image/png", data: png.toString("base64") },
                { type: "file", kind: "pdf", name: "spec sheet.pdf", size: 4, mediaType: "application/pdf", data: Buffer.from("%PDF").toString("base64") },
            ] as any,
            { signal: new AbortController().signal },
        );
        expect(r).toBe("done");
        const sent: string = logLines().find((l) => l.input)!.input.message.content;
        const files = [...sent.matchAll(/\[(?:Image|PDF) attached: (\S+)\. Read it with read_file to see it\.\]/g)].map((m) => m[1]!);
        expect(sent.startsWith("look\n\n")).toBe(true);
        expect(files).toHaveLength(2);
        expect(files[0]).toMatch(/image-1\.png$/);
        expect(files[1]).toMatch(/spec_sheet\.pdf$/);
        expect(files.every((f) => f.startsWith(`${gate.gateDir()}-files/`))).toBe(true);
        expect(decisions()).toEqual(["auto_approve", "auto_approve"]);
        expect(a.asked).toEqual([]);
        expect(said(a.events).join("")).toContain(`read ${png.length} bytes; read 4 bytes`);
        // Their rows name the attachment, not Cavvy's file.
        expect(ends(a.events).map((e) => e.call.input.file_path)).toEqual(["image-1.png", "spec sheet.pdf"]);
        // Another file outside the folder is asked about as any read is.
        await a.run(`[Image attached: ${join(tempDir("agy-other-"), "x.png")}. Read it]`);
        expect(a.asked).toHaveLength(1);
        const c = await clientFor("antigravity");
        await (c as any).shutdown();
        expect(files.some((f) => existsSync(f))).toBe(false);
    });

    test("a message sent mid-turn joins it at its next model call, after the tool running", async () => {
        const queued: string[] = [];
        const a = await makeAgent({ ask: () => ({ allow: true }), queued });
        const run = a.run("[[slow]]");
        while (!logLines().some((l) => l.hook === "PreToolUse")) await Bun.sleep(10);
        queued.push("also say banana");
        expect(await run).toBe("done");
        expect(logLines().filter((l) => l.injected).map((l) => l.injected)).toEqual(["also say banana"]);
        expect(said(a.events).join("")).toContain("(heard: also say banana)");
        expect(queued).toEqual([]);
        expect(spawns()).toHaveLength(1);
    });
});

describe("its sign-in and models, from `agy models`", () => {
    test("signed in: its models, by id and name", async () => {
        const s = await agyStatus("antigravity");
        expect(s).toMatchObject({ installed: true, signedIn: true, path: fake });
        expect((await agyModels("antigravity")).map((m) => [m.id, m.name])).toEqual([
            ["gemini-4-argon-high", "Gemini 4 Argon (High)"],
            ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
        ]);
    });

    test("signed out: it says so, and a turn says how to sign in instead of waiting", async () => {
        process.env.FAKE_AGY_SIGNED_OUT = "1";
        expect(await agyStatus("antigravity")).toMatchObject({ installed: true, signedIn: false });
        const a = await makeAgent();
        expect(await a.run("hello")).toBe("error");
        expect(notices(a.events).join("\n")).toContain("isn't signed in. Run `agy`");
    });
});

describe("the gate folder", () => {
    test("is only the user's, and holds the hook agy runs", () => {
        const dir = gate.gateDir();
        expect(dir.startsWith(gateRoot)).toBe(true);
        expect(statSync(dir).mode & 0o077).toBe(0);
        const hooks = JSON.parse(readFileSync(join(dir, ".agents", "hooks.json"), "utf8"));
        expect(hooks["cavvy-gate"].PreToolUse[0]).toMatchObject({ matcher: "*", hooks: [{ type: "command", command: `'${join(dir, "gate.sh")}' pre`, timeout: gate.HOOK_TIMEOUT_S }] });
        // Changed by someone else, it's written back.
        writeFileSync(join(dir, "gate.sh"), "#!/bin/sh\necho '{\"decision\":\"auto_approve\"}'\n");
        gate.gateDir();
        expect(readFileSync(join(dir, "gate.sh"), "utf8")).toContain("curl");
    });

    test("the hook refuses a call when there's no gate to ask", async () => {
        const p = Bun.spawn(["sh", join(gate.gateDir(), "gate.sh"), "pre"], { stdin: new Blob(["{}"]), stdout: "pipe", env: { PATH: process.env.PATH ?? "" } });
        expect(JSON.parse(await new Response(p.stdout).text())).toMatchObject({ decision: "deny" });
    });
});

describe("agyTool", () => {
    const t = (name: string, args: Record<string, unknown>) => gate.agyTool(name, args, "/w", "/g");
    test("its tools as Cavvy's", () => {
        expect(t("run_command", { CommandLine: "ls", toolSummary: "List" })).toEqual({ toolName: "Bash", input: { command: "ls", description: "List" } });
        expect(t("run_command", { CommandLine: "ls", Cwd: "/elsewhere" })).toMatchObject({ toolName: "Bash", elsewhere: true });
        expect(t("write_file", { Path: "a.txt", Content: "x" })).toMatchObject({ toolName: "Write", input: { file_path: "/w/a.txt", content: "x" } });
        expect(t("edit_file", { Path: "/w/a.txt", Target: "a", Replacement: "b" })).toMatchObject({ toolName: "Edit", input: { file_path: "/w/a.txt", old_string: "a", new_string: "b" }, diff: { before: "a", after: "b" } });
        expect(t("read_file", { Path: "a.txt" })).toEqual({ toolName: "Read", input: { file_path: "/w/a.txt" } });
        expect(t("search_web", { query: "q" })).toEqual({ toolName: "WebSearch", input: { query: "q" } });
        expect(t("read_url_content", { Url: "https://x.test" })).toEqual({ toolName: "WebFetch", input: { url: "https://x.test" } });
        expect(t("call_mcp_tool", { ServerName: "gh", ToolName: "issue", Arguments: { n: 1 } })).toEqual({ toolName: "mcp__gh__issue", input: { n: 1 } });
        expect(t("command_status", {})).toMatchObject({ free: true });
        expect(t("write_file", { Path: "/g/x" })).toMatchObject({ refuse: expect.stringContaining("permission hook") });
        expect(t("generate_image", {})).toBeUndefined();
        expect(t("write_file", {})).toBeUndefined();
    });
});

test("agyTool: a real path inside a symlinked folder is spelled as the session spells it", () => {
    const real = realpathSync(tempDir("agy-real-"));
    const link = join(tempDir("agy-link-"), "proj");
    symlinkSync(real, link);
    expect(gate.agyTool("write_file", { Path: join(real, "a.txt"), Content: "x" }, link)).toMatchObject({ input: { file_path: join(link, "a.txt") } });
});
