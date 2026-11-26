// Git drafts (commit message, pull request text, branch names) and Regenerate title on a session that runs on an agent
// CLI: the small model set in Settings is used whichever provider it's on, else the session's provider's small default
// (as titles have it), and only a model that can't answer at all says what to change.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { Message } from "../src/providers/types";

const iso = isolate();
const { startMockLlm } = await import("../scripts/mock-llm");
const { Engine } = await import("../src/server/engine");
const { gitArgv, gitEnv } = await import("../src/util/git");
const { getProvider, saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
const mock = startMockLlm({ delayMs: 0 });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus" }));
const ANSWER = "Add the selected file";
const log = join(tempDir(), "cli.log");

function fake(name: "claude" | "codex"): string {
    const bin = tempDir("cavvy-drafts-cli-");
    writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", `fake-${name}.ts`)}" "$@"\n`);
    chmodSync(join(bin, name), 0o755);
    return join(bin, name);
}

beforeAll(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    process.env.FAKE_ONEOFF_ANSWER = ANSWER;
    process.env.FAKE_LOG = log;
    saveAgentConfig("codex", { path: fake("codex") });
    saveAgentConfig("claude-code", { path: fake("claude") });
});
afterAll(() => {
    delete process.env.FAKE_ONEOFF_ANSWER;
    delete process.env.FAKE_LOG;
    removeAgentConfig("codex");
    removeAgentConfig("claude-code");
    mock.stop();
    iso.cleanup();
});

/** Which CLI answered one-offs since `from` (the log's length then). */
const asked = (from: number) => {
    const text = existsSync(log) ? readFileSync(log, "utf8").slice(from) : "";
    return { codex: text.includes('"oneOffPrompt"'), claude: text.includes('"oneOff"') };
};
const logged = () => (existsSync(log) ? readFileSync(log, "utf8").length : 0);

function repo(): string {
    const cwd = realpathSync(tempDir());
    const git = (...args: string[]) => {
        const r = Bun.spawnSync(gitArgv(args), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
        if (r.exitCode) throw new Error(r.stderr.toString());
        return r.stdout.toString();
    };
    writeFileSync(join(cwd, "README.md"), "# demo\n");
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Cavvy Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("add", "-A");
    git("commit", "-q", "-m", "feat: initial project");
    git("switch", "-q", "-c", "feat/selected");
    writeFileSync(join(cwd, "selected.txt"), "selected\n");
    git("add", "-A");
    git("commit", "-q", "-m", "Add the selected file");
    writeFileSync(join(cwd, "selected.txt"), "selected, changed\n");
    return cwd;
}

// Codex lists its light model here, so "the provider's small default" has one to find.
const listModels = async () => [
    { provider: getProvider("mock")!, status: "ok" as const, models: [{ provider: "mock", id: "mock-opus" }, { provider: "mock", id: "mock-haiku" }] },
    { provider: getProvider("codex")!, status: "ok" as const, models: [{ provider: "codex", id: "gpt-test" }, { provider: "codex", id: "gpt-6-luna" }] },
    { provider: getProvider("claude-code")!, status: "ok" as const, models: [{ provider: "claude-code", id: "default" }, { provider: "claude-code", id: "haiku" }] },
];

async function codexSession(smallModel: string | undefined) {
    const engine = new Engine({ listModels });
    const c = { subs: new Set<string>(), send() {} };
    engine.clients.add(c as never);
    const call = (method: string, params: unknown) => engine.handle(c as never, method as never, params) as Promise<any>;
    await call("models.list", { refresh: true });
    const cwd = repo();
    const id = (await call("session.create", { cwd })).state.id as string;
    await call("session.setModel", { id, ref: "codex:gpt-test", persist: false });
    const rt = engine.runtimes.get(id)!;
    await rt.ready;
    rt.ws.settings = { ...rt.ws.settings, smallModel };
    // Something to name it after.
    rt.session.push({ role: "user", content: [{ type: "text", text: "Add the selected file" }] } as Message);
    return { engine, call, id, cwd, rt };
}

/** Each feature that drafts on the small model, and the model it said it used. */
async function draftAll(call: (m: string, p: unknown) => Promise<any>, id: string, cwd: string) {
    const commit = await call("session.gitCommitMessage", { id, paths: ["selected.txt"] });
    const pr = await call("session.gitPrText", { id, base: "main" });
    const branch = await call("session.gitBranchName", { id, text: "Add the selected file" });
    const home = await call("projects.suggestBranch", { path: cwd, text: "Add the selected file" });
    const title = await call("session.regenerateTitle", { id });
    return { commit, pr, branch, home, title };
}

describe("drafts on a Codex session", () => {
    test("a small model set on an API provider is used", async () => {
        const { engine, call, id, cwd } = await codexSession("mock:mock-haiku");
        try {
            const from = logged();
            const r = await draftAll(call, id, cwd);
            expect([r.commit.model, r.pr.model, r.branch.model, r.home.model]).toEqual(Array(4).fill("mock:mock-haiku"));
            expect(r.title.title).toBeTruthy();
            expect(asked(from)).toEqual({ codex: false, claude: false });
        } finally {
            await engine.stop();
        }
    }, 60_000);

    test("with none set, Codex's own small model answers, as titles do", async () => {
        const { engine, call, id, cwd } = await codexSession(undefined);
        try {
            const from = logged();
            const r = await draftAll(call, id, cwd);
            expect(r.commit).toEqual({ message: ANSWER, model: "codex:gpt-6-luna" });
            expect([r.pr.title, r.pr.model]).toEqual([ANSWER, "codex:gpt-6-luna"]);
            expect(r.branch.model).toBe("codex:gpt-6-luna");
            expect(r.branch.branch).toBe("cavvy/add-the-selected-file");
            expect(r.title).toEqual({ title: ANSWER });
            expect(asked(from)).toEqual({ codex: true, claude: false });
        } finally {
            await engine.stop();
        }
    }, 60_000);

    test("a small model set on Claude Code is used, on Claude Code", async () => {
        const { engine, call, id, cwd } = await codexSession("claude-code:haiku");
        try {
            const from = logged();
            const r = await draftAll(call, id, cwd);
            expect([r.commit.model, r.pr.model, r.branch.model, r.home.model]).toEqual(Array(4).fill("claude-code:haiku"));
            expect(r.title).toEqual({ title: ANSWER });
            expect(asked(from)).toEqual({ codex: false, claude: true });
        } finally {
            await engine.stop();
        }
    }, 60_000);

    test("a small model set on a Codex model is used", async () => {
        const { engine, call, id, cwd } = await codexSession("codex:gpt-other");
        try {
            const commit = await call("session.gitCommitMessage", { id, paths: ["selected.txt"] });
            expect(commit).toEqual({ message: ANSWER, model: "codex:gpt-other" });
        } finally {
            await engine.stop();
        }
    }, 60_000);

    test("a model that runs whole turns only says to choose a small model", async () => {
        const { engine, call, id, rt } = await codexSession(undefined);
        const { WholeTurnsOnly } = await import("../src/backends/one-off");
        const refuse = async () => {
            throw new WholeTurnsOnly("Codex");
        };
        try {
            const target = { model: { provider: "codex", id: "gpt-6-luna" }, client: { stream: refuse, agentBackend: true } };
            (rt as any).smallTarget = async () => target;
            await expect(call("session.gitCommitMessage", { id, paths: ["selected.txt"] })).rejects.toMatchObject({ code: "no_model", message: "Codex can't generate messages. Choose a small model in Settings." });
            await expect(call("session.gitPrText", { id })).rejects.toMatchObject({ code: "no_model", message: "Codex can't generate pull request text. Choose a small model in Settings." });
            await expect(call("session.regenerateTitle", { id })).rejects.toMatchObject({ message: "Codex can't make a title. Choose a small model in Settings." });
            // The one set is the one that can't: another is asked for.
            rt.ws.settings = { ...rt.ws.settings, smallModel: "codex:gpt-6-luna" };
            await expect(call("session.gitBranchName", { id, text: "Add it" })).rejects.toMatchObject({ code: "no_model", message: "Codex can't suggest branch names. Choose another small model in Settings." });
        } finally {
            await engine.stop();
        }
    }, 60_000);
});
