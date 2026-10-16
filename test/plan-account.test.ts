// Real plan RPC, Git worktree and fake Codex process, without listening sockets.
import { afterAll, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";
import type { ImplementPlanResult } from "../src/server/protocol";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { Runtime } = await import("../src/server/runtime");
const { Session } = await import("../src/agent/session");
const { addAccount, setDefaultAccount } = await import("../src/providers/accounts");
const { saveAgentConfig, getProvider } = await import("../src/providers/registry");
const { forgetClient } = await import("../src/providers/models");
const { gitArgv, gitEnv } = await import("../src/util/git");

const binary = join(iso.home, "fake-codex");
writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${join(import.meta.dir, "fixtures/fake-codex.ts")}" "$@"\n`);
chmodSync(binary, 0o700);
saveAgentConfig("codex", { path: binary });
const personal = addAccount("codex", { id: "personal", name: "Personal" });
const work = addAccount("codex", { id: "work", name: "Work" });
const claudeWork = addAccount("claude-code", { id: "work", name: "Work" });
setDefaultAccount("codex", personal.id);
setDefaultAccount("claude-code", claudeWork.id);
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ delegation: false }));
const prior = { FAKE_LOG: process.env.FAKE_LOG, FAKE_CODEX_SCENARIO: process.env.FAKE_CODEX_SCENARIO };
afterAll(() => {
    for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    forgetClient("codex");
    iso.cleanup();
});

for (const selected of [work.id, "default"]) test(`plan implementation keeps Codex ${selected} and starts a fresh thread in its home`, async () => {
    const cwd = join(realpathSync(iso.home), `project-${selected}`);
    mkdirSync(cwd);
    const git = (...args: string[]) => {
        const result = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe", timeout: 5000 });
        if (result.exitCode) throw new Error(result.stderr.toString());
    };
    git("init", "-q", "-b", "main");
    git("commit", "--allow-empty", "-qm", "initial");
    const log = join(iso.home, `${selected}.jsonl`);
    process.env.FAKE_LOG = log;
    process.env.FAKE_CODEX_SCENARIO = "web";
    const engine = new Engine({ listModels: async () => [] });
    engine.listings = [{ provider: getProvider("codex")!, status: "ok", models: [{ provider: "codex", id: "gpt-test", contextWindow: 400000 }] }];
    const client = { subs: new Set<string>(), send() {} };
    engine.clients.add(client);
    const source = await engine.createSession(cwd, { mode: "plan" });
    source.setAccount("codex", selected);
    // Also preserve an implicit Default selection for the inactive provider.
    source.setAccount("claude-code", "default");
    source.session.setBackendSession("codex", "source-codex-thread", 0);
    source.session.setBackendSession("claude-code", "source-claude-thread", 0);
    source.session.addPlan("plan", "# Account regression\nImplement this plan in the worktree.");
    const modelSetup: { accountId: string; claudeAccountId: string; backends: number }[] = [];
    const setModel = Runtime.prototype.setModel;
    const modelSpy = spyOn(Runtime.prototype, "setModel").mockImplementation(function (this: InstanceType<typeof Runtime>, ...args) {
        if (this.id !== source.id) modelSetup.push({ accountId: this.session.accountId("codex"), claudeAccountId: this.session.accountId("claude-code"), backends: this.session.backends.size });
        return setModel.apply(this, args);
    });
    const create = engine.createSession.bind(engine);
    engine.createSession = async (...args) => {
        const next = await create(...args);
        // This test needs no secret/delegation MCP listener or title-generation turn.
        next.toolState.secrets = undefined;
        next.session.setTitle("Implementation");
        next.session.meta.system = "Test plan implementation";
        return next;
    };
    try {
        const result = await engine.handle(client, "session.implementPlan", { id: source.id, branch: "implementation", mode: "acceptEdits" }) as ImplementPlanResult;
        expect(result.failed).toBeUndefined();
        const next = engine.runtimes.get(result.sessionId!)!;
        expect(next.session.accountId("codex")).toBe(selected);
        expect(next.session.accountId("claude-code")).toBe("default");
        expect(next.snapshot().state.accounts).toEqual({ codex: selected, "claude-code": "default" });
        expect(modelSetup.length).toBeGreaterThan(0);
        expect(modelSetup.every((s) => s.accountId === selected && s.claudeAccountId === "default" && s.backends === 0)).toBe(true);
        const deadline = Date.now() + 5000;
        while (!next.idle && Date.now() < deadline) await Bun.sleep(10);
        expect(next.idle).toBe(true);
        expect(next.snapshot().turns[0]?.status).toBe("done");
        const lines = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        const starts = lines.filter((line) => line.argv);
        expect(starts).toHaveLength(1);
        expect(starts[0].codexHome).toBe(selected === "default" ? process.env.CODEX_HOME : work.folder);
        const requests = lines.filter((line) => line.received).map((line) => line.received);
        expect(requests.filter((r) => r.method === "thread/resume")).toHaveLength(0);
        expect(requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
        const turns = requests.filter((r) => r.method === "turn/start");
        expect(turns).toHaveLength(1);
        expect(JSON.stringify(turns[0])).toContain("# Account regression");
        expect(source.session.backends.get("codex")?.id).toBe("source-codex-thread");
        expect(source.session.backends.get("claude-code")?.id).toBe("source-claude-thread");
        expect(next.session.backends.has("claude-code")).toBe(false);
        // The copied selections must survive closing and reopening, too.
        const path = next.session.path;
        await engine.stop();
        const reopened = Session.load(path);
        try {
            expect(reopened.accountId("codex")).toBe(selected);
            expect(reopened.accountId("claude-code")).toBe("default");
        } finally { reopened.release(); }
    } finally {
        modelSpy.mockRestore();
        await engine.stop();
    }
}, 15_000);
