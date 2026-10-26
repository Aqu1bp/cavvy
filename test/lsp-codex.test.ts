// Diagnostics after Codex's edits: Codex has no language servers of its own,
// so Cavvy checks the files it changed and steers new problems into
// its running turn (or, once that has ended, tells the user). A fake `codex`
// and a fake language server (test/fixtures); no network.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { fakeEnvFile, stopLiveCodex } from "./helpers/fake-env";

const { cleanup } = isolate();
const registry = await import("../src/providers/registry");
const { clientFor, forgetClient } = await import("../src/providers/models");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const { BUILTIN_SERVERS } = await import("../src/lsp/config");
const { LspManager } = await import("../src/lsp/manager");
const trust = await import("../src/config/trust");

type AgentEvent = import("../src/agent/agent").AgentEvent;
type ToolState = import("../src/tools/types").ToolState;

const bin = tempDir("fake-codex-lsp-");
const LOG = join(bin, "log.jsonl");
const codexBin = join(bin, "codex");
writeFileSync(codexBin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-codex.ts")}" "$@"\n`);
chmodSync(codexBin, 0o755);
const FAKE_LSP = join(import.meta.dir, "fixtures", "fake-lsp.ts");
const NO_BUILTINS = Object.fromEntries(Object.keys(BUILTIN_SERVERS).map((n) => [n, { disabled: true }]));
const fakeEnv = fakeEnvFile(bin);
const FAKE_ENV = ["FAKE_SCENARIO", "FAKE_STEER_WAKES", "FAKE_EDIT_FILE", "FAKE_EDIT_TEXT", "FAKE_EDIT_WAIT"];

let cwd: string;
let states: ToolState[] = [];
beforeEach(() => {
    // Reached through a symlink, as macOS's temp folder is: Codex names files by their real path.
    const real = tempDir("codex-lsp-proj-");
    cwd = `${real}-link`;
    symlinkSync(real, cwd);
    rmSync(LOG, { force: true });
    for (const k of FAKE_ENV) delete process.env[k];
    process.env.FAKE_LOG = LOG;
    process.env.FAKE_SCENARIO = "edit";
    process.env.FAKE_STEER_WAKES = "1";
    registry.saveAgentConfig("codex", { path: codexBin });
    forgetClient("codex");
});
afterEach(async () => {
    await stopLiveCodex();
    for (const s of states) await s.lsp?.dispose();
    states = [];
});
afterAll(() => {
    cleanup();
    rmSync(bin, { recursive: true, force: true });
    for (const k of [...FAKE_ENV, "FAKE_LOG", "FAKE_ENV_FILE"]) delete process.env[k];
});

const logLines = (): any[] => (existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const steers = () => logLines().flatMap((l) => (l.received?.method === "turn/steer" ? [l.received.params.input[0].text as string] : []));
const turnStarts = () => logLines().filter((l) => l.received?.method === "turn/start");
const notices = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "notice" ? [e.message] : []));

async function until(ok: () => boolean, ms = 5000) {
    for (const end = Date.now() + ms; !ok(); ) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(10);
    }
}

async function makeAgent(o: { lsp?: unknown; lspEnv?: Record<string, string>; untrusted?: boolean; timing?: Record<string, number> } = {}) {
    const server = { command: process.execPath, args: [FAKE_LSP], env: o.lspEnv ?? {}, extensionToLanguage: { ".ts": "typescript" } };
    const settings = { lsp: o.lsp ?? { servers: { ...NO_BUILTINS, fake: server } } } as any;
    if (o.untrusted) trust.trustForSession(cwd);
    else trust.trustFolder(cwd);
    const events: AgentEvent[] = [];
    const toolState: ToolState = { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() };
    // Shorter waits, where a test needs the edit to stop waiting first.
    if (o.timing) toolState.lsp = new LspManager({ root: cwd, settings: () => settings, trusted: () => trust.trustedByUser(cwd), ...o.timing });
    states.push(toolState);
    let mode: import("../src/permissions/modes").PermissionMode = "default";
    const agent = new Agent({
        session: Session.create(cwd, { persist: false }),
        model: { provider: "codex", id: "default" } as any,
        client: await clientFor("codex"),
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState,
        host: { drainQueued: () => [], emit: (e) => events.push(e), ui: {} },
    });
    return {
        events,
        run: (text: string) => {
            fakeEnv.write();
            return agent.run([{ type: "text", text }], { signal: new AbortController().signal });
        },
    };
}

describe("diagnostics after Codex's edits", () => {
    test("an edit that adds an error: steered into the running turn, in the format edits get, and the user is told", async () => {
        process.env.FAKE_EDIT_TEXT = "const a = 1;\nERROR: Type 'string' is not assignable to type 'number'.\n";
        const a = await makeAgent();
        expect(await a.run("fix it")).toBe("done");
        expect(steers()).toHaveLength(1);
        const note = steers()[0]!;
        expect(note).toStartWith("<system-reminder>\n<new-diagnostics>");
        expect(note).toContain("a.ts: 1 error");
        expect(note).toContain("2:1 error [fake error]: Type 'string' is not assignable to type 'number'.");
        // Codex heard it in the same turn: no second turn was started for it.
        expect(turnStarts()).toHaveLength(1);
        expect(logLines().find((l) => l.steered)?.steered).toEqual([note]);
        expect(notices(a.events)).toContain("Diagnostics: 1 error in a.ts");
    });

    test("a clean edit steers nothing and says nothing", async () => {
        process.env.FAKE_EDIT_TEXT = "const a = 1;\n";
        process.env.FAKE_EDIT_WAIT = "1000";
        const a = await makeAgent();
        expect(await a.run("tidy")).toBe("done");
        expect(steers()).toEqual([]);
        expect(notices(a.events).filter((n) => n.startsWith("Diagnostics"))).toEqual([]);
    });

    test("the turn ended before the diagnostics came: the user is told, and no turn starts for them", async () => {
        process.env.FAKE_EDIT_TEXT = "ERROR: late one\n";
        process.env.FAKE_EDIT_WAIT = "0";
        const a = await makeAgent({ lspEnv: { FAKE_LSP_DELAY: "400" } });
        expect(await a.run("go")).toBe("done");
        await until(() => notices(a.events).some((n) => n.startsWith("Diagnostics")));
        expect(notices(a.events)).toContain("Diagnostics: 1 error in a.ts");
        expect(steers()).toEqual([]);
        expect(turnStarts()).toHaveLength(1);
    });

    test("diagnostics that came after the wait gave up go with the next prompt", async () => {
        process.env.FAKE_EDIT_TEXT = "ERROR: slow to show\n";
        process.env.FAKE_EDIT_WAIT = "0";
        const a = await makeAgent({ lspEnv: { FAKE_LSP_DELAY: "700" }, timing: { coldTimeoutMs: 300 } });
        expect(await a.run("one")).toBe("done");
        expect(steers()).toEqual([]);
        await Bun.sleep(1000);
        process.env.FAKE_EDIT_FILE = "notes.txt";
        expect(await a.run("two")).toBe("done");
        const second = JSON.stringify(turnStarts()[1]!.received.params.input);
        expect(second).toContain("<new-diagnostics>");
        expect(second).toContain("slow to show");
        expect(notices(a.events)).toContain("Diagnostics: 1 error in a.ts");
    });

    test("only new problems: the same error after the next edit isn't steered again", async () => {
        process.env.FAKE_EDIT_TEXT = "ERROR: still here\n";
        const a = await makeAgent();
        await a.run("one");
        expect(steers()).toHaveLength(1);
        process.env.FAKE_EDIT_WAIT = "800";
        process.env.FAKE_EDIT_TEXT = "// touched\nERROR: still here\n";
        await a.run("two");
        expect(steers()).toHaveLength(1);
    });

    test("files no server handles and lsp off: nothing runs", async () => {
        process.env.FAKE_EDIT_WAIT = "300";
        process.env.FAKE_EDIT_FILE = "notes.txt";
        process.env.FAKE_EDIT_TEXT = "ERROR: not code\n";
        await (await makeAgent()).run("notes");
        process.env.FAKE_EDIT_FILE = "a.ts";
        await (await makeAgent({ lsp: false })).run("off");
        expect(steers()).toEqual([]);
        for (const s of states) expect(s.lsp?.status() ?? []).toEqual([]);
    });

    test("a folder the user hasn't trusted: no server runs, and the user is told why once", async () => {
        process.env.FAKE_EDIT_WAIT = "300";
        process.env.FAKE_EDIT_TEXT = "ERROR: x\n";
        const a = await makeAgent({ untrusted: true });
        await a.run("one");
        await a.run("two");
        expect(steers()).toEqual([]);
        expect(notices(a.events)).toEqual(["Diagnostics after edits are off in this folder until you trust it (/trust): language servers run the project's own code."]);
        expect(states[0]!.lsp?.status()).toEqual([]);
    });
});
