// Account switches exercise the Agent loop against vendor-protocol fixtures.
// Default has no selectors here, so it is ~/.claude and ~/.codex, which named accounts link into
// (account-layout.ts). Bun caches homedir at startup, so the tests run in a child with a temporary HOME.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
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
const { readAgentConfig, saveAgentConfig } = await import("../src/providers/registry");
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

/** A fake CLI for the provider, and an Agent on a new session in `root`: on live CLI sessions, or a process per turn. */
async function harness(provider: "claude-code" | "codex", live: boolean, log: string) {
    const binary = join(root, provider);
    const fixture = join(import.meta.dir, "fixtures", provider === "codex" ? "fake-codex.ts" : "fake-claude.ts");
    writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${fixture}" "$@"\n`);
    chmodSync(binary, 0o755);
    saveAgentConfig(provider, { ...readAgentConfig(provider), path: binary });
    forgetClient(provider);
    rmSync(log, { force: true });
    process.env.FAKE_LOG = log;
    process.env.FAKE_SCENARIO = "silent";
    process.env.FAKE_CODEX_SCENARIO = "cmd";
    const session = Session.create(root, { persist: false });
    session.setModel(`${provider}:default`);
    const events: AgentEvent[] = [];
    const agent = new Agent({
        session, model: { provider, id: "default", effortLevels: ["low", "high"] }, client: await clientFor(provider),
        settings: () => ({ effort: "high", delegation: false, ...(live ? {} : { agentCli: { liveSessions: false } }) }),
        checker: new PermissionChecker(() => ({}), root), tools: BUILTIN_TOOLS,
        mode: { get: () => "plan", set: () => {} },
        toolState: { cwd: root, projectRoot: root, fileState: new Map(), todos: [], shells: new Map() },
        host: { emit: (e) => events.push(e), ui: {}, askPermission: async () => ({ allow: false }) },
    });
    const run = (text: string) => agent.run([{ type: "text", text }], { signal: new AbortController().signal });
    const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    const starts = () => lines().filter((l) => l.argv && l.argv[0] !== "auth");
    const received = () => lines().filter((l) => l.received).map((l) => l.received);
    /** What each start (Claude Code) or thread request (Codex) opened: "new", or the id it resumed. */
    const opened = () => provider === "claude-code"
        ? starts().map((l) => { const i = l.argv.indexOf("--resume"); return i < 0 ? "new" : l.argv[i + 1]; })
        : received().filter((m) => m.method === "thread/start" || m.method === "thread/resume").map((m) => (m.method === "thread/start" ? "new" : m.params.threadId));
    /** The home each CLI process was started with (undefined: Default's). */
    const homes = () => starts().map((l) => l[provider === "codex" ? "codexHome" : "claudeConfigDir"] as string | undefined);
    /** The last prompt sent to the CLI, as JSON. */
    const lastPrompt = () => JSON.stringify(received().filter((m) => (provider === "codex" ? m.method === "turn/start" : m.type === "user")).at(-1));
    const notices = () => events.flatMap((e) => (e.type === "notice" ? [e.message] : []));
    return { session, agent, run, starts, opened, homes, lastPrompt, notices };
}

const count = (s: string, sub: string) => s.split(sub).length - 1;

/** A native session's transcript in Default's history (FAKE_TRANSCRIPTS). */
function transcriptOf(provider: string, id: string): string {
    if (provider === "codex") return join(homedir(), ".codex", "sessions", `${id}.jsonl`);
    const projects = join(homedir(), ".claude", "projects");
    const found = readdirSync(projects).map((d) => join(projects, d, `${id}.jsonl`)).find((f) => existsSync(f));
    if (!found) throw new Error(`no transcript for ${id}`);
    return found;
}

// Harness-made accounts link Default's history (account-layout.ts): their CLI finds the same transcripts, so a
// switch among them and Default goes on with the same native session (#377). The fakes keep transcripts in each
// home's history folder (FAKE_TRANSCRIPTS) and resume only what they find there, as the CLIs do.
for (const provider of ["claude-code", "codex"] as const) for (const live of [true, false]) describe(`${provider} account switch, ${live ? "live CLI sessions" : "a process per turn"}`, () => {
    const tag = `${provider === "codex" ? "cx" : "cc"}-${live ? "live" : "run"}`;
    const made: { id: string; folder: string }[] = [];
    afterAll(() => { for (const a of made.splice(0)) removeAccount(provider, a.id, a.folder, [root]); });
    const add = (name: string, folder?: string) => {
        const a = addAccount(provider, { id: `${tag}-${name}`, name, ...(folder ? { folder } : {}) }, [root]);
        made.push(a);
        return a;
    };
    const real = (folder: string | undefined) => (folder === undefined ? undefined : realpathSync(folder));
    async function withHarness(name: string, body: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>) {
        // Codex's threads with ids of their own, as Claude Code's sessions have: a round trip tells them apart.
        process.env.FAKE_TRANSCRIPTS = process.env.FAKE_UNIQUE_THREADS = "1";
        const h = await harness(provider, live, join(root, `${tag}-${name}.jsonl`));
        try { await body(h); } finally {
            await h.agent.dispose();
            delete process.env.FAKE_TRANSCRIPTS;
            delete process.env.FAKE_UNIQUE_THREADS;
        }
    }

    run("Default → a Harness-made account: the native session goes on there, sent only the new message", async () => {
        const work = add("work");
        await withHarness("default-managed", async (h) => {
            expect(await h.run("Remember the word teal")).toBe("done");
            const id = h.session.backends.get(provider)!.id;
            expect(h.session.setAccount(provider, work.id)).toBe(true);
            // Kept: the next turn resumes it on the new account.
            expect(h.session.backends.get(provider)?.id).toBe(id);
            expect(await h.run("Which word?")).toBe("done");
            expect(h.opened()).toEqual(["new", id]);
            // Not the old process: a new one, signed in as the new account.
            expect(h.homes().map(real)).toEqual([undefined, realpathSync(work.folder)]);
            expect(h.lastPrompt()).toContain("Which word?");
            expect(h.lastPrompt()).not.toContain("conversation-so-far");
            expect(h.notices().join("\n")).not.toMatch(/Starting a new|account folder changed/);
            expect(h.session.backends.get(provider)?.id).toBe(id);
            expect(h.session.messages.filter((m) => m.role === "user")).toHaveLength(2);
        });
    }, 30_000);

    run("one Harness-made account → another, then Default: the same native session throughout", async () => {
        const a = add("alpha");
        const b = add("beta");
        await withHarness("managed-managed", async (h) => {
            h.session.setAccount(provider, a.id);
            expect(await h.run("On alpha")).toBe("done");
            const id = h.session.backends.get(provider)!.id;
            expect(h.session.setAccount(provider, b.id)).toBe(true);
            expect(await h.run("On beta")).toBe("done");
            expect(h.session.setAccount(provider, "default")).toBe(true);
            expect(await h.run("On Default")).toBe("done");
            expect(h.opened()).toEqual(["new", id, id]);
            expect(h.homes().map(real)).toEqual([realpathSync(a.folder), realpathSync(b.folder), undefined]);
            expect(h.lastPrompt()).not.toContain("conversation-so-far");
        });
    }, 30_000);

    run("a Harness-made account → an existing-folder account: a new native session, handed the conversation", async () => {
        const a = add("own");
        const custom = add("custom", join(iso.home, `${tag}-custom`));
        await withHarness("managed-custom", async (h) => {
            h.session.setAccount(provider, a.id);
            expect(await h.run("Before the switch")).toBe("done");
            expect(h.session.setAccount(provider, custom.id)).toBe(true);
            expect(h.session.backends.has(provider)).toBe(false);
            expect(await h.run("After the switch")).toBe("done");
            expect(h.opened()).toEqual(["new", "new"]);
            expect(h.homes().map(real)).toEqual([realpathSync(a.folder), realpathSync(custom.folder)]);
            expect(h.lastPrompt()).toContain("conversation-so-far");
            expect(h.lastPrompt()).toContain("Before the switch");
        });
    }, 30_000);

    run("the new account can't resume the native session: a new one, handed the conversation once, with the notice", async () => {
        const work = add("lost");
        await withHarness("resume-fails", async (h) => {
            expect(await h.run("Earlier on Default")).toBe("done");
            const id = h.session.backends.get(provider)!.id;
            // Gone from the shared history: the CLI won't find it on the new account.
            rmSync(transcriptOf(provider, id));
            expect(h.session.setAccount(provider, work.id)).toBe(true);
            const before = structuredClone(h.session.messages);
            expect(await h.run("Go on")).toBe("done");
            expect(h.opened()).toEqual(["new", id, "new"]);
            expect(real(h.homes().at(-1))).toBe(realpathSync(work.folder));
            expect(h.notices().join("\n")).toMatch(/Couldn't resume.*Starting a new one with this conversation as context/s);
            expect(h.lastPrompt()).toContain("conversation-so-far");
            expect(h.lastPrompt()).toContain("Earlier on Default");
            // Nothing lost or doubled: the earlier messages as they were, and the new one once.
            expect(h.session.messages.slice(0, before.length)).toEqual(before);
            expect(h.session.messages.filter((m) => m.role === "user" && JSON.stringify(m.content).includes("Go on"))).toHaveLength(1);
            expect(h.session.backends.has(provider)).toBe(true);
        });
    }, 30_000);

    // One native thread per history location (#413): a round trip through an account with its own history goes back
    // to the thread the session had there, sent only what it missed, once, rather than a third thread with everything.
    run("Default → an existing-folder account → Default → back: each goes on with its own native thread, sent only the turns it missed, once", async () => {
        const custom = add("trip", join(iso.home, `${tag}-trip`));
        await withHarness("round-trip", async (h) => {
            expect(await h.run("alpha on Default")).toBe("done");
            const d = h.session.backends.get(provider)!.id;
            expect(h.session.setAccount(provider, custom.id)).toBe(true);
            expect(await h.run("bravo on custom")).toBe("done");
            const c = h.session.backends.get(provider)!.id;
            expect(c).not.toBe(d);
            expect(count(h.lastPrompt(), "alpha on Default")).toBe(1);
            expect(h.session.setAccount(provider, "default")).toBe(true);
            // Taken up again before any turn: the switch's note can say so.
            expect(h.session.backends.get(provider)?.id).toBe(d);
            expect(await h.run("charlie on Default")).toBe("done");
            expect(h.opened()).toEqual(["new", "new", d]);
            expect(h.homes().map(real)).toEqual([undefined, realpathSync(custom.folder), undefined]);
            // What it missed (custom's turn), once; nothing it had.
            expect(count(h.lastPrompt(), "bravo on custom")).toBe(1);
            expect(h.lastPrompt()).not.toContain("alpha on Default");
            expect(h.notices().join("\n")).not.toMatch(/Starting a new|account folder changed|Couldn't/);
            expect(await h.run("delta on Default")).toBe("done");
            expect(h.lastPrompt()).not.toContain("conversation-so-far");
            // And custom's thread, the other way: Default's two turns since it last answered.
            expect(h.session.setAccount(provider, custom.id)).toBe(true);
            expect(h.session.backends.get(provider)?.id).toBe(c);
            expect(await h.run("echo on custom")).toBe("done");
            expect(h.opened().at(-1)).toBe(c);
            expect(h.opened().filter((o) => o === "new")).toHaveLength(2);
            expect(real(h.homes().at(-1))).toBe(realpathSync(custom.folder));
            for (const missed of ["charlie on Default", "delta on Default"]) expect(count(h.lastPrompt(), missed)).toBe(1);
            for (const had of ["alpha on Default", "bravo on custom"]) expect(h.lastPrompt()).not.toContain(had);
            expect(h.session.parkedBackends(provider).map((p) => p.session.id)).toEqual([d]);
        });
    }, 30_000);

    run("back on Default when its earlier thread can't be resumed: a new one, handed the whole conversation once", async () => {
        const custom = add("gone", join(iso.home, `${tag}-gone`));
        await withHarness("round-trip-gone", async (h) => {
            expect(await h.run("alpha on Default")).toBe("done");
            const d = h.session.backends.get(provider)!.id;
            h.session.setAccount(provider, custom.id);
            expect(await h.run("bravo on custom")).toBe("done");
            const c = h.session.backends.get(provider)!.id;
            // Gone from Default's history while the session was away.
            rmSync(transcriptOf(provider, d));
            h.session.setAccount(provider, "default");
            expect(await h.run("charlie on Default")).toBe("done");
            expect(h.opened().slice(-2)).toEqual([d, "new"]);
            expect(h.homes().at(-1)).toBeUndefined();
            expect(h.notices().join("\n")).toMatch(/Couldn't resume.*Starting a new one with this conversation as context/s);
            for (const said of ["alpha on Default", "bravo on custom", "charlie on Default"]) expect(count(h.lastPrompt(), said)).toBe(1);
            expect(h.session.backends.get(provider)?.id).not.toBe(d);
            expect(await h.run("delta on Default")).toBe("done");
            expect(h.lastPrompt()).not.toContain("conversation-so-far");
            // Custom's own thread is still kept for it.
            expect(h.session.parkedBackends(provider).map((p) => p.session.id)).toEqual([c]);
        });
    }, 30_000);

    run("rewound past the existing-folder account's turns: its thread goes, and Default's is sent only the kept turns it missed", async () => {
        const custom = add("rewind", join(iso.home, `${tag}-rewind`));
        await withHarness("round-trip-rewind", async (h) => {
            expect(await h.run("alpha on Default")).toBe("done");
            const d = h.session.backends.get(provider)!.id;
            h.session.setAccount(provider, custom.id);
            expect(await h.run("bravo on custom")).toBe("done");
            const kept = h.session.messages.length;
            expect(await h.run("charlie on custom")).toBe("done");
            // Custom's thread saw "charlie", which the rewind takes away; Default's saw only "alpha".
            h.session.rewind(kept);
            h.session.setAccount(provider, "default");
            expect(h.session.backends.get(provider)?.id).toBe(d);
            expect(await h.run("delta on Default")).toBe("done");
            expect(h.opened().at(-1)).toBe(d);
            expect(count(h.lastPrompt(), "bravo on custom")).toBe(1);
            expect(h.lastPrompt()).not.toContain("charlie on custom");
            expect(h.lastPrompt()).not.toContain("alpha on Default");
            // Custom starts over: a new thread with the conversation as it is now.
            h.session.setAccount(provider, custom.id);
            expect(h.session.backends.has(provider)).toBe(false);
            expect(await h.run("echo on custom")).toBe("done");
            expect(h.opened().at(-1)).toBe("new");
            for (const said of ["alpha on Default", "bravo on custom", "delta on Default"]) expect(count(h.lastPrompt(), said)).toBe(1);
            expect(h.lastPrompt()).not.toContain("charlie on custom");
        });
    }, 30_000);
});

for (const provider of ["claude-code", "codex"] as const) describe(`${provider} account handoff`, () => {
    run("new home never receives the old resume id; conversation and controls survive", async () => {
        const binary = join(root, provider);
        const fixture = join(import.meta.dir, "fixtures", provider === "codex" ? "fake-codex.ts" : "fake-claude.ts");
        writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${fixture}" "$@"\n`);
        chmodSync(binary, 0o755);
        saveAgentConfig(provider, { path: binary });
        // An existing folder: its CLI keeps a history of its own, so it can't continue Default's sessions.
        const selected = addAccount(provider, { id: "personal", name: "Personal", folder: join(iso.home, `${provider}-personal`) }, [root]);
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
            const defaultThread = session.backends.get(provider)?.id;
            expect(defaultThread).toBeDefined();
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
            // Default's own thread from the first turn is kept for it (#413): back there, it's taken up again.
            expect(session.setAccount(provider, "default")).toBe(true);
            expect(session.backends.get(provider)?.id).toBe(defaultThread);
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
        session, busy: false, model: { provider: "codex" }, customCommands: [], adopts: [], releasing: new Map(), schedules: { cancelLimitResume() {} },
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
    // Default's earlier thread, kept for it (#413), is taken up again.
    expect(session.backends.get("codex")?.id).toBe("default-thread");
    expect(session.notices.at(-1)?.text).toMatch(/^Continuing on Codex · Default: the earlier Codex thread this account finds goes on/);
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
