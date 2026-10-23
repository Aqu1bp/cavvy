// The catch-up cursor of a native CLI session (BackendSession.synced): back on a CLI after other models answered,
// its next prompt carries what it missed, once. Nothing may move the cursor past turns the CLI never received: not
// its own compaction (#406), nor a prompt it refused before taking it (#407: a process that didn't start, Codex not
// signed in, a turn Codex wouldn't start). A prompt it took and then failed on is in its session, and isn't sent again.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
const { Session } = await import("../src/agent/session");
const { Agent } = await import("../src/agent/agent");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const { readAgentConfig, saveAgentConfig } = await import("../src/providers/registry");
const { clientFor, forgetClient } = await import("../src/providers/models");
import { backendModel, type BackendResult, type BackendTurn } from "../src/backends/types";

const mock = startMockLlm({ delayMs: 0 });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));
const root = tempDir("catch-up-cursor-");
const FAKE_KEYS = ["FAKE_LOG", "FAKE_SCENARIO", "FAKE_SECOND_SCENARIO", "FAKE_CODEX_SCENARIO", "FAKE_CODEX_SCENARIOS", "FAKE_ACCOUNT", "FAKE_EXIT_AT_START", "FAKE_FAIL_TURN_START_AT"];
const prior = Object.fromEntries(FAKE_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
    setEnv(prior);
    mock.stop();
    rmSync(root, { recursive: true, force: true });
    iso.cleanup();
});

const TOKEN = "otter-kettle-55";
const count = (s: string, sub: string) => s.split(sub).length - 1;

function setEnv(env: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
}

async function until(pred: () => boolean, ms = 10_000) {
    const end = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(20);
    }
}

// In the GUI's Engine: a CLI turn, then the API model (the mock) answers, then back on the CLI.
describe("a CLI backend, back after another model answered (the Engine, a scripted CLI)", () => {
    /** A turn's plan: `announce` its session id (default "cli-1"; false: none), then answer, or end with `result`. */
    type Plan = { announce?: string | false; result?: BackendResult };

    function backend(turns: BackendTurn[], plans: Plan[], compactId: string) {
        return {
            agentBackend: true as const,
            adoptsTurns: true,
            setMode() {},
            listModels: async () => [],
            stream: async () => {
                throw new Error("not used");
            },
            // As a CLI's own compaction reports its session: the same id, or a new one.
            compact: async (t: BackendTurn) => {
                t.session.sessionId(compactId);
                return { reason: "done" as const, text: "", actions: [] };
            },
            runTurn: async (t: BackendTurn) => {
                turns.push(t);
                const p = plans.shift() ?? {};
                if (p.announce !== false) t.session.sessionId(p.announce ?? "cli-1");
                if (p.result) return p.result;
                t.sink.emit({ type: "text", text: "ok." });
                return { reason: "done" as const, text: "ok.", actions: [] };
            },
        };
    }

    /** The CLI's session has seen "first"; then the mock answers a message with TOKEN; then the CLI is back. */
    async function setup(plans: Plan[], compactId = "cli-1") {
        const engine = new Engine();
        const c = { subs: new Set<string>(), send() {} } as never;
        engine.clients.add(c);
        const cwd = createDemoProject(tempDir("catch-up-proj-"), { git: false });
        const snap = (await engine.handle(c, "session.create", { cwd })) as { state: { id: string } };
        const id = snap.state.id;
        const rt = engine.runtimes.get(id)!;
        await rt.ready;
        const agent = rt.agent!;
        const realModel = agent.model;
        const realClient = agent.client;
        const turns: BackendTurn[] = [];
        const cli = backend(turns, plans, compactId);
        agent.setModel(backendModel("fake-cli", "x"), cli as never);
        await engine.handle(c, "session.send", { id, text: "first" });
        await until(() => turns.length === 1 && rt.idle);
        agent.setModel(realModel, realClient);
        await engine.handle(c, "session.send", { id, text: `hello ${TOKEN}` });
        await until(() => rt.idle && rt.session.messages.filter((m) => m.role === "assistant").length >= 2);
        agent.setModel(backendModel("fake-cli", "x"), cli as never);
        const send = async (text: string) => {
            const n = turns.length + 1;
            await engine.handle(c, "session.send", { id, text });
            await until(() => turns.length === n && rt.idle);
            return turns[n - 1]!.prompt;
        };
        return { engine, rt, turns, send };
    }

    test("the missed turn goes with the next prompt, once", async () => {
        const s = await setup([{}]);
        try {
            expect(count(await s.send("and now?"), TOKEN)).toBe(1);
            expect(count(await s.send("again?"), TOKEN)).toBe(0);
        } finally {
            await s.engine.stop();
        }
    });

    describe("#407: a prompt the CLI refused before taking it leaves the cursor where it was", () => {
        const failed = (error: string, refused: boolean): BackendResult => ({ reason: "error", text: "", actions: [], error, ...(refused ? { refused } : {}) });

        test("refused before it said its session id (Codex not signed in): the retry carries the missed turn, once", async () => {
            const s = await setup([{}, { announce: false, result: failed("Codex isn't signed in.", true) }]);
            try {
                expect(count(await s.send("and now?"), TOKEN)).toBe(1);
                expect(count(await s.send("again?"), TOKEN)).toBe(1);
                expect(count(await s.send("and after?"), TOKEN)).toBe(0);
            } finally {
                await s.engine.stop();
            }
        });

        test("refused after it said its session id (a live process started, then turn/start refused): the retry carries it", async () => {
            const s = await setup([{}, { result: failed("Codex couldn't start the turn", true) }]);
            try {
                expect(count(await s.send("and now?"), TOKEN)).toBe(1);
                expect(count(await s.send("again?"), TOKEN)).toBe(1);
                expect(count(await s.send("and after?"), TOKEN)).toBe(0);
            } finally {
                await s.engine.stop();
            }
        });

        test("refused after it made a new thread for the turn: the thread is kept, and the retry carries it", async () => {
            const s = await setup([{}, { announce: "cli-2", result: failed("Codex couldn't start the turn", true) }]);
            try {
                await s.send("and now?");
                expect(s.rt.session.backends.get("fake-cli")?.id).toBe("cli-2");
                expect(count(await s.send("again?"), TOKEN)).toBe(1);
                expect(count(await s.send("and after?"), TOKEN)).toBe(0);
            } finally {
                await s.engine.stop();
            }
        });

        // Guard: as Claude Code 2.1.304 and Codex 0.163 do (checked against a local stub API), a prompt the CLI took
        // and then failed on (signed out, at its limit) is in its session, and goes to the model again on resume.
        test("taken, then failed (signed out, at its limit): delivered, so the retry doesn't send it again", async () => {
            const s = await setup([{}, { result: failed("Claude Code isn't signed in.", false) }]);
            try {
                expect(count(await s.send("and now?"), TOKEN)).toBe(1);
                expect(count(await s.send("again?"), TOKEN)).toBe(0);
            } finally {
                await s.engine.stop();
            }
        });
    });

    describe("#406: the CLI's own compaction before the next prompt leaves the cursor where it was", () => {
        for (const id of ["cli-1", "cli-compacted"])
            test(`/compact (the CLI reports ${id}): the next prompt carries the missed turn, once; the one after, nothing`, async () => {
                const s = await setup([{}], id);
                try {
                    await s.rt.compact();
                    expect(s.rt.session.backends.get("fake-cli")?.id).toBe(id);
                    expect(count(await s.send("and now?"), TOKEN)).toBe(1);
                    expect(count(await s.send("again?"), TOKEN)).toBe(0);
                } finally {
                    await s.engine.stop();
                }
            });

        test("an idle compaction: the next prompt carries the missed turn, once", async () => {
            const s = await setup([{}], "cli-compacted");
            try {
                await s.rt.compact(undefined, { idle: true });
                expect(count(await s.send("and now?"), TOKEN)).toBe(1);
                expect(count(await s.send("again?"), TOKEN)).toBe(0);
            } finally {
                await s.engine.stop();
            }
        });
    });
});

// The real backends against the fake CLIs (test/fixtures), on live CLI sessions and with a process per turn.
/** A fake CLI for the provider, and an Agent on a new session: on live CLI sessions, or a process per turn. */
async function harness(provider: "claude-code" | "codex", live: boolean, name: string) {
    const binary = join(root, provider);
    const fixture = join(import.meta.dir, "fixtures", provider === "codex" ? "fake-codex.ts" : "fake-claude.ts");
    // FAKE_EXIT_AT_START=1: the CLI exits as it starts, before it reads anything (a crash at launch).
    writeFileSync(binary, `#!/bin/sh\n[ -n "$FAKE_EXIT_AT_START" ] && { echo "crashed at start" >&2; exit 3; }\nexec "${process.execPath}" --no-env-file "${fixture}" "$@"\n`);
    chmodSync(binary, 0o755);
    saveAgentConfig(provider, { ...readAgentConfig(provider), path: binary });
    forgetClient(provider);
    const log = join(root, `${name}.jsonl`);
    rmSync(log, { force: true });
    process.env.FAKE_LOG = log;
    const session = Session.create(root, { persist: false });
    session.setModel(`${provider}:default`);
    const agent = new Agent({
        session,
        model: { provider, id: "default", effortLevels: ["low", "high"] },
        client: await clientFor(provider),
        settings: () => ({ effort: "high", delegation: false, ...(live ? {} : { agentCli: { liveSessions: false } }) }),
        checker: new PermissionChecker(() => ({}), root),
        tools: BUILTIN_TOOLS,
        mode: { get: () => "plan", set: () => {} },
        toolState: { cwd: root, projectRoot: root, fileState: new Map(), todos: [], shells: new Map() },
        host: { emit: () => {}, ui: {}, askPermission: async () => ({ allow: false }) },
    });
    const run = (text: string) => agent.run([{ type: "text", text }], { signal: new AbortController().signal });
    const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    /** Each prompt the CLI received (Claude Code's user messages, Codex's turn/start), as JSON. */
    const prompts = () => lines().filter((l) => l.received && (provider === "codex" ? l.received.method === "turn/start" : l.received.type === "user")).map((l) => JSON.stringify(l.received));
    /** Another model's turn: the user's message with TOKEN, and its answer. */
    const otherModel = () => {
        session.push({ role: "user", content: [{ type: "text", text: `hello ${TOKEN}` }], meta: { kind: "prompt", display: `hello ${TOKEN}` } });
        session.push({ role: "assistant", content: [{ type: "text", text: "Noted." }], provider: "mock", model: "mock-opus", stopReason: "end_turn" });
    };
    return { session, agent, run, prompts, otherModel };
}

const OK = { "claude-code": { FAKE_SCENARIO: "chat" }, codex: { FAKE_CODEX_SCENARIO: "cmd", FAKE_ACCOUNT: "chatgpt" } } as const;
const CLEAR = { FAKE_SECOND_SCENARIO: undefined, FAKE_CODEX_SCENARIOS: undefined, FAKE_EXIT_AT_START: undefined, FAKE_FAIL_TURN_START_AT: undefined };

for (const provider of ["claude-code", "codex"] as const)
    for (const live of [true, false])
        describe(`${provider}, ${live ? "a live CLI session" : "a process per turn"}`, () => {
            const tag = `${provider === "codex" ? "cx" : "cc"}-${live ? "live" : "run"}`;
            /**
             * The environment for the turn that fails, and for the turns after. Live, the process is let go after the
             * other model's turn (as an account switch does, #399), so the failing turn starts a new one, whose first
             * prompt fails; the turns after answer, in that process (FAKE_SECOND_SCENARIO) or a new one. `refused`:
             * the CLI never took the prompt (the retry carries the missed turn); otherwise it took it, then failed.
             */
            const failures: { name: string; fail: Record<string, string | undefined>; after: Record<string, string | undefined>; refused: boolean }[] =
                provider === "claude-code"
                    ? [
                          { name: "exits before taking the prompt", fail: { FAKE_EXIT_AT_START: "1" }, after: { FAKE_EXIT_AT_START: undefined }, refused: true },
                          { name: "not signed in (auth-failed)", fail: { FAKE_SCENARIO: "auth-failed", FAKE_SECOND_SCENARIO: "chat" }, after: { FAKE_SCENARIO: "chat" }, refused: false },
                          { name: "usage limit (rate-limit)", fail: { FAKE_SCENARIO: "rate-limit", FAKE_SECOND_SCENARIO: "chat" }, after: { FAKE_SCENARIO: "chat" }, refused: false },
                      ]
                    : [
                          { name: "not signed in", fail: { FAKE_ACCOUNT: "none" }, after: { FAKE_ACCOUNT: "chatgpt" }, refused: true },
                          { name: "turn/start refused", fail: { FAKE_FAIL_TURN_START_AT: "1" }, after: live ? {} : { FAKE_FAIL_TURN_START_AT: undefined }, refused: true },
                          live
                              ? { name: "usage limit", fail: { FAKE_CODEX_SCENARIOS: "usage-limit,cmd" }, after: {}, refused: false }
                              : { name: "usage limit", fail: { FAKE_CODEX_SCENARIO: "usage-limit" }, after: { FAKE_CODEX_SCENARIO: "cmd" }, refused: false },
                      ];

            for (const f of failures)
                test(`#407 ${f.name}: the missed turn reaches the CLI once (${f.refused ? "with the retry" : "with the failed prompt, which it kept"})`, async () => {
                    setEnv({ ...CLEAR, ...OK[provider] });
                    const h = await harness(provider, live, `${tag}-${f.name.replace(/\W+/g, "-")}`);
                    try {
                        expect(await h.run("first")).toBe("done");
                        h.otherModel();
                        if (live) await h.agent.releaseBackends();
                        setEnv(f.fail);
                        const before = h.prompts().length;
                        expect(await h.run("and now?")).toBe("error");
                        // Taken: the failed prompt carried it.
                        if (!f.refused) expect(count(h.prompts().slice(before).join("\n"), TOKEN)).toBe(1);
                        setEnv(f.after);
                        expect(await h.run("again?")).toBe("done");
                        expect(count(h.prompts().at(-1)!, TOKEN)).toBe(f.refused ? 1 : 0);
                        expect(await h.run("and after?")).toBe("done");
                        expect(count(h.prompts().at(-1)!, TOKEN)).toBe(0);
                    } finally {
                        await h.agent.dispose();
                    }
                }, 30_000);

            for (const idle of [false, true])
                test(`#406 ${idle ? "an idle compaction" : "/compact"} before the next prompt: that prompt carries the missed turn, once`, async () => {
                    setEnv({ ...CLEAR, ...OK[provider] });
                    const h = await harness(provider, live, `${tag}-compact-${idle ? "idle" : "manual"}`);
                    try {
                        expect(await h.run("first")).toBe("done");
                        h.otherModel();
                        // Live, a new process (an account switch, a reopen): it reports the session it resumed.
                        if (live) await h.agent.releaseBackends();
                        expect(await h.agent.compact({ auto: idle, idle, signal: new AbortController().signal })).toBe(true);
                        expect(await h.run("and now?")).toBe("done");
                        expect(count(h.prompts().at(-1)!, TOKEN)).toBe(1);
                        expect(await h.run("again?")).toBe("done");
                        expect(count(h.prompts().at(-1)!, TOKEN)).toBe(0);
                    } finally {
                        await h.agent.dispose();
                    }
                }, 30_000);
        });
