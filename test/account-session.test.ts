// Account switches exercise the Agent loop against vendor-protocol fixtures.
// Default has no selectors here, so it is ~/.claude and ~/.codex, which named accounts link into
// (account-layout.ts). Bun caches homedir at startup, so the tests run in a child with a temporary HOME.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, sep } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const child = process.env.HARNESS_TEST_SESSION_HOME;
const run = child ? test : test.skip;
if (!child) {
    test("account handoff in an isolated home", () => {
        const home = realpathSync(tempDir());
        try {
            const result = Bun.spawnSync([process.execPath, "--no-env-file", "test", import.meta.path], {
                env: { ...process.env, HOME: home, HARNESS_TEST_SESSION_HOME: home },
                timeout: 110_000,
            });
            expect({ code: result.exitCode, output: result.stderr.toString() }).toMatchObject({ code: 0 });
        } finally { rmSync(home, { recursive: true, force: true }); }
    }, 120_000);
} else {
    if (!child.startsWith(realpathSync(tmpdir()) + sep) || child !== realpathSync(homedir())) throw new Error("Expected an isolated temporary home");
    for (const dir of [".claude", ".codex"]) mkdirSync(join(child, dir));
}

const iso = isolate();
const root = tempDir("account-session-");
const { Session } = await import("../src/agent/session");
const { Agent } = await import("../src/agent/agent");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const { saveAgentConfig } = await import("../src/providers/registry");
const { addAccount, removeAccount, setDefaultAccount } = await import("../src/providers/accounts");
const { clientFor, forgetClient } = await import("../src/providers/models");
import type { AgentEvent } from "../src/agent/agent";

const prior = { log: process.env.FAKE_LOG, scenario: process.env.FAKE_SCENARIO, codexScenario: process.env.FAKE_CODEX_SCENARIO, claudeHome: process.env.CLAUDE_CONFIG_DIR, codexHome: process.env.CODEX_HOME };
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
afterAll(() => {
    for (const [key, value] of [["FAKE_LOG", prior.log], ["FAKE_SCENARIO", prior.scenario], ["FAKE_CODEX_SCENARIO", prior.codexScenario], ["CLAUDE_CONFIG_DIR", prior.claudeHome], ["CODEX_HOME", prior.codexHome]]) {
        if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    rmSync(root, { recursive: true, force: true });
    iso.cleanup();
});

for (const provider of ["claude-code", "codex"] as const) describe(`${provider} account handoff`, () => {
    run("new home never receives the old resume id; conversation and controls survive", async () => {
        const binary = join(root, provider);
        const fixture = join(import.meta.dir, "fixtures", provider === "codex" ? "fake-codex.ts" : "fake-claude.ts");
        writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${fixture}" "$@"\n`);
        chmodSync(binary, 0o755);
        saveAgentConfig(provider, { path: binary });
        const selected = addAccount(provider, { id: "personal", name: "Personal" }, [root]);
        forgetClient(provider);
        const log = join(root, `${provider}.jsonl`);
        process.env.FAKE_LOG = log;
        process.env.FAKE_SCENARIO = "silent";
        process.env.FAKE_CODEX_SCENARIO = "cmd";
        const session = Session.create(root, { persist: false });
        session.setModel(`${provider}:default`);
        const events: AgentEvent[] = [];
        const agent = new Agent({
            session, model: { provider, id: "default", effortLevels: ["low", "high"] }, client: await clientFor(provider),
            settings: () => ({ effort: "high", delegation: false }),
            checker: new PermissionChecker(() => ({}), root), tools: BUILTIN_TOOLS,
            mode: { get: () => "plan", set: () => {} },
            toolState: { cwd: root, projectRoot: root, fileState: new Map(), todos: [], shells: new Map() },
            host: { emit: (e) => events.push(e), ui: {}, askPermission: async () => ({ allow: false }) },
        });
        try {
            const run = (text: string) => agent.run([{ type: "text", text }], { signal: new AbortController().signal });
            await run("Earlier conversation");
            expect(session.backends.has(provider)).toBe(true);
            const before = structuredClone(session.messages);
            expect(session.setAccount(provider, selected.id)).toBe(true);
            expect(session.backends.has(provider)).toBe(false);
            await run("Continue on Personal");
            expect(session.messages.slice(0, before.length)).toEqual(before);
            expect(session.model).toBe(`${provider}:default`);
            const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
            const starts = lines.filter((l) => l.argv);
            expect(starts[0].claudeConfigDir).toBeUndefined();
            expect(starts[0].codexHome).toBeUndefined();
            const received = lines.filter((l) => l.received).map((l) => l.received);
            if (provider === "claude-code") {
                expect(starts.at(-1).claudeConfigDir).toBe(selected.folder);
                expect(starts.at(-1).codexHome).toBeUndefined();
                expect(starts.at(-1).argv).not.toContain("--resume");
                expect(starts.at(-1).argv).toEqual(expect.arrayContaining(["--permission-mode", "plan", "--effort", "high"]));
            } else {
                expect(starts.at(-1).codexHome).toBe(selected.folder);
                expect(starts.at(-1).claudeConfigDir).toBeUndefined();
                expect(received.filter((m) => m.method === "thread/resume")).toHaveLength(0);
                expect(received.filter((m) => m.method === "thread/start")).toHaveLength(2);
                const turns = received.filter((m) => m.method === "turn/start");
                expect(JSON.stringify(turns.at(-1))).toContain("high");
            }
            const wire = JSON.stringify(received);
            expect(wire).toContain("conversation-so-far");
            expect(wire).toContain("Earlier conversation");
            removeAccount(provider, selected.id, selected.folder, [root]);
            addAccount(provider, { id: selected.id, name: selected.name, folder: join(iso.home, `${provider}-replacement`) }, [root]);
            await run("Continue after replacing the account folder");
            expect(events.some((e) => e.type === "notice" && /account folder changed/.test(e.message))).toBe(true);
            const after = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
            if (provider === "claude-code") expect(after.filter((l) => l.argv).at(-1).argv).not.toContain("--resume");
            else expect(after.some((l) => l.received?.method === "thread/resume")).toBe(false);
            expect(session.setAccount(provider, "default")).toBe(true);
            expect(session.backends.has(provider)).toBe(false);
        } finally { await agent.dispose(); }
    }, 30_000);
});


run("new sessions freeze each configured default and reopening does not replace it", () => {
    setDefaultAccount("codex", "personal");
    const fresh = Session.create(root);
    expect(fresh.accountId("codex")).toBe("personal");
    fresh.push({ role: "user", content: [{ type: "text", text: "Save the selection" }] });
    fresh.release();
    setDefaultAccount("codex", "default");
    const reopened = Session.load(fresh.path);
    expect(reopened.accountId("codex")).toBe("personal");
    expect(reopened.messages).toEqual(fresh.messages);
    reopened.release();
    expect(Session.create(root, { persist: false }).accountId("codex")).toBe("default");
});

run("terminal /account switches with the same handoff and refuses changes during a turn", async () => {
    const { App } = await import("../src/ui/app");
    const { runCommand } = await import("../src/commands/index");
    const session = Session.create(root, { persist: false });
    session.push({ role: "user", content: [{ type: "text", text: "Keep this conversation" }] });
    session.setBackendSession("codex", "default-thread", 1);
    const notices: string[] = [];
    const app: any = {
        session, busy: false, model: { provider: "codex" }, customCommands: [],
        print() {}, renderLive() {}, notice: (text: string) => notices.push(text),
    };
    app.setAccount = App.prototype.setAccount.bind(app);
    await runCommand(app, "/account codex personal");
    expect(session.accountId("codex")).toBe("personal");
    expect(session.backends.has("codex")).toBe(false);
    expect(session.notices.at(-1)?.text).toMatch(/Continuing on Codex · Personal: starting a new/);
    app.busy = true;
    await runCommand(app, "/account default");
    expect(session.accountId("codex")).toBe("personal");
    expect(notices.at(-1)).toContain("isn't available while");
    app.busy = false;
    await runCommand(app, "/account codex ../bad");
    expect(session.accountId("codex")).toBe("personal");
    expect(notices.at(-1)).toBe("Invalid account id");
    await runCommand(app, "/account default");
    expect(session.accountId("codex")).toBe("default");
});

run("terminal add-account cancellation and invalid input never launch a login", async () => {
    const { runCommand } = await import("../src/commands/index");
    const notices: string[] = [];
    let launched = false;
    let values: (string | undefined)[] = [undefined];
    const app: any = {
        cwd: root, busy: false, customCommands: [], print() {}, renderLive() {}, yieldIdleCompaction: async () => {},
        notice: (text: string) => notices.push(text), showDialog: async () => values.shift(),
        screen: { suspend: () => { launched = true; } },
    };
    await runCommand(app, "/login codex add");
    expect(launched).toBe(false);
    values = ["../bad", "Bad", ""];
    await runCommand(app, "/login claude-code add");
    expect(launched).toBe(false);
    expect(notices.at(-1)).toBe("Invalid account id");
});

run("CLI imports stay on Default when new chats default to another account", async () => {
    const { writeImportedSession } = await import("../src/server/cli-import");
    const { findSession } = await import("../src/agent/session");
    setDefaultAccount("codex", "personal");
    try {
        const id = writeImportedSession({
            cwd: root, model: "codex:default", title: "Imported",
            entry: { source: "codex", id: "native-default-thread", file: "unused", cwd: root, title: "Imported", named: false, updatedAt: 0, size: 0, messages: 1, partial: false },
            transcript: { turns: [{ prompt: "From Default", replies: [], actions: [] }], omitted: 0 },
        });
        const imported = Session.load(findSession(root, id)!);
        expect(imported.accountId("codex")).toBe("default");
        expect(imported.backends.get("codex")?.id).toBe("native-default-thread");
        imported.release();
    } finally { setDefaultAccount("codex", "default"); }
});
