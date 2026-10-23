// The catch-up cursor of a native CLI session (BackendSession.synced): back on a CLI after other models answered,
// its next prompt carries what it missed, once. Nothing may move the cursor past turns the CLI never received: not
// its own compaction (#406), nor a prompt it refused before taking it (#407: a process that didn't start, Codex not
// signed in, a turn Codex wouldn't start). A prompt it took and then failed on is in its session, and isn't sent again.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
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
const { stopTiming } = await import("../src/backends/cli");
import { backendModel, type BackendResult, type BackendTurn } from "../src/backends/types";

const mock = startMockLlm({ delayMs: 0 });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));
const root = tempDir("catch-up-cursor-");
const FAKE_KEYS = ["FAKE_LOG", "FAKE_SCENARIO", "FAKE_SECOND_SCENARIO", "FAKE_CODEX_SCENARIO", "FAKE_CODEX_SCENARIOS", "FAKE_ACCOUNT", "FAKE_EXIT_AT_START", "FAKE_FAIL_TURN_START_AT", "FAKE_GOAL_ACTIVATE_FAIL", "FAKE_SLOW_TURN_START", "FAKE_CRASH_FILE", "FAKE_HANG_INIT", "FAKE_HANG_INITIALIZE", "FAKE_TRANSCRIPTS", "FAKE_CLAUDE_ENV_FILE", "FAKE_INIT_DELAY_MS", "FAKE_START_DELAY_MS", "FAKE_CANCEL_ANSWER_MS", "FAKE_SLOW_TURN_START_AT"];
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
        // A host that takes wakes: without one, Claude Code runs a process per turn whatever the setting (untilQuiet).
        host: { emit: () => {}, ui: {}, askPermission: async () => ({ allow: false }), ...(live ? { wake: () => {} } : {}) },
    });
    const run = (text: string, signal = new AbortController().signal) => agent.run([{ type: "text", text }], { signal });
    const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    /** Each prompt the CLI received (Claude Code's user messages, Codex's turn/start), as JSON. */
    const prompts = () => lines().filter((l) => l.received && (provider === "codex" ? l.received.method === "turn/start" : l.received.type === "user")).map((l) => JSON.stringify(l.received));
    /** Another model's turn: the user's message with TOKEN, and its answer. */
    const otherModel = () => {
        session.push({ role: "user", content: [{ type: "text", text: `hello ${TOKEN}` }], meta: { kind: "prompt", display: `hello ${TOKEN}` } });
        session.push({ role: "assistant", content: [{ type: "text", text: "Noted." }], provider: "mock", model: "mock-opus", stopReason: "end_turn" });
    };
    /** Each line the fake logged (what it was started with, what it received). */
    return { session, agent, run, prompts, otherModel, lines };
}

const OK = { "claude-code": { FAKE_SCENARIO: "chat" }, codex: { FAKE_CODEX_SCENARIO: "cmd", FAKE_ACCOUNT: "chatgpt" } } as const;
const CLEAR = { FAKE_SECOND_SCENARIO: undefined, FAKE_CODEX_SCENARIOS: undefined, FAKE_EXIT_AT_START: undefined, FAKE_FAIL_TURN_START_AT: undefined, FAKE_GOAL_ACTIVATE_FAIL: undefined, FAKE_SLOW_TURN_START: undefined, FAKE_CRASH_FILE: undefined, FAKE_HANG_INIT: undefined, FAKE_HANG_INITIALIZE: undefined };

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

// PR #417 review: a prompt counts as refused only when it's known not to have reached the CLI.
describe("delivered or not, as known (#417 review)", () => {
    /** The fake's processes started so far (not its `auth status` checks). */
    const runs = (h: Awaited<ReturnType<typeof harness>>) => h.lines().filter((l) => l.pid && l.argv?.[0] !== "auth").length;

    test("Codex live: turn/start answered, then making the /goal active fails: delivered, so it isn't sent again", async () => {
        setEnv({ ...CLEAR, ...OK.codex, FAKE_GOAL_ACTIVATE_FAIL: "1" });
        const h = await harness("codex", true, "cx-live-goal-activate-fails");
        try {
            expect(await h.run("first")).toBe("done");
            h.otherModel();
            const before = h.prompts().length;
            expect(await h.run("/goal the tests pass")).toBe("error");
            expect(count(h.prompts().slice(before).join("\n"), TOKEN)).toBe(1);
            setEnv({ FAKE_GOAL_ACTIVATE_FAIL: undefined });
            expect(await h.run("again?")).toBe("done");
            expect(count(h.prompts().at(-1)!, TOKEN)).toBe(0);
        } finally {
            await h.agent.dispose();
        }
    }, 30_000);

    // Unknowable: Codex may have started the turn (and recorded the prompt) before it went. Counted delivered, as only a
    // known refusal resends: a possible loss of this catch-up, in this window only.
    for (const live of [true, false])
        test(`Codex ${live ? "live" : "per run"}: gone while turn/start waited for its answer: counted delivered`, async () => {
            const crash = join(root, `crash-${live ? "live" : "run"}`);
            setEnv({ ...CLEAR, ...OK.codex });
            const h = await harness("codex", live, `cx-${live ? "live" : "run"}-gone-during-turn-start`);
            try {
                expect(await h.run("first")).toBe("done");
                h.otherModel();
                if (live) await h.agent.releaseBackends();
                setEnv({ FAKE_SLOW_TURN_START: "5000", FAKE_CRASH_FILE: crash });
                const before = h.prompts().length;
                const turn = h.run("and now?");
                await until(() => h.prompts().length > before);
                writeFileSync(crash, "");
                expect(await turn).toBe("error");
                expect(count(h.prompts().slice(before).join("\n"), TOKEN)).toBe(1);
                setEnv({ FAKE_SLOW_TURN_START: undefined, FAKE_CRASH_FILE: undefined });
                expect(await h.run("again?")).toBe("done");
                expect(count(h.prompts().at(-1)!, TOKEN)).toBe(0);
            } finally {
                await h.agent.dispose();
            }
        }, 30_000);

    // #406 through a fork in place: the live thread is shared with a fork (/fork), so readying the compaction forks it,
    // and the fork's id must reach the compaction's host, not the last turn's.
    for (const provider of ["codex", "claude-code"] as const)
        test(`${provider} live, shared with a fork, then compacted: the next prompt carries the missed turn, once`, async () => {
            setEnv({ ...CLEAR, ...OK[provider] });
            const h = await harness(provider, true, `${provider}-live-fork-compact`);
            try {
                expect(await h.run("first")).toBe("done");
                h.otherModel();
                // In memory (this session is never written): the entry is shared from now on.
                h.session.markBackendForked(provider);
                expect(h.session.backends.get(provider)?.fork).toBe(true);
                const shared = h.session.backends.get(provider)!;
                expect(await h.agent.compact({ auto: false, signal: new AbortController().signal })).toBe(true);
                // A copy now: its own id, still where the shared one was.
                expect(h.session.backends.get(provider)?.id).not.toBe(shared.id);
                expect(h.session.backends.get(provider)?.synced).toBe(shared.synced);
                expect(await h.run("and now?")).toBe("done");
                expect(count(h.prompts().at(-1)!, TOKEN)).toBe(1);
                expect(await h.run("again?")).toBe("done");
                expect(count(h.prompts().at(-1)!, TOKEN)).toBe(0);
            } finally {
                await h.agent.dispose();
            }
        }, 30_000);

    // Esc while the CLI was still starting (live: a new process; per run: before the handshake): nothing was sent.
    const stuck: { provider: "claude-code" | "codex"; live: boolean; env: Record<string, string> }[] = [
        { provider: "claude-code", live: true, env: { FAKE_HANG_INITIALIZE: "1" } },
        { provider: "codex", live: true, env: { FAKE_HANG_INIT: "1" } },
        { provider: "codex", live: false, env: { FAKE_HANG_INIT: "1" } },
    ];
    for (const c of stuck)
        test(`${c.provider} ${c.live ? "live" : "per run"}: stopped while it was starting, before the prompt went: the next prompt carries the missed turn`, async () => {
            setEnv({ ...CLEAR, ...OK[c.provider] });
            const h = await harness(c.provider, c.live, `${c.provider}-${c.live ? "live" : "run"}-stopped-starting`);
            try {
                expect(await h.run("first")).toBe("done");
                h.otherModel();
                // Set first: a live session may start its next process as soon as the last one is let go.
                setEnv(c.env);
                const started = runs(h);
                if (c.live) await h.agent.releaseBackends();
                const ac = new AbortController();
                const turn = h.run("and now?", ac.signal);
                await until(() => runs(h) > started);
                await Bun.sleep(300);
                ac.abort();
                expect(await turn).toBe("aborted");
                setEnv(Object.fromEntries(Object.keys(c.env).map((k) => [k, undefined])));
                expect(await h.run("again?")).toBe("done");
                expect(count(h.prompts().at(-1)!, TOKEN)).toBe(1);
                expect(await h.run("and after?")).toBe("done");
                expect(count(h.prompts().at(-1)!, TOKEN)).toBe(0);
            } finally {
                await h.agent.dispose();
            }
        }, 40_000);
});

// #424: Esc in each window of a live prompt's way to the CLI. Whether the CLI's thread got the stopped message decides
// what the next prompt carries: in total (its transcript, FAKE_TRANSCRIPTS), the thread has it once, and the turn the
// other model answered (TOKEN) once.
describe("#424: Esc on a live prompt, in each window of its delivery: the CLI's thread has the message once", () => {
    type Provider = "claude-code" | "codex";
    type H = Awaited<ReturnType<typeof harness>>;
    /** The fake's processes started so far (not its `auth status` checks). */
    const runs = (h: H) => h.lines().filter((l) => l.pid && l.argv?.[0] !== "auth").length;
    /** Each thread's transcript: what its model was sent since `since`, by file. */
    function threads(provider: Provider, since: number): Map<string, string[]> {
        const home = provider === "codex" ? join(process.env.CODEX_HOME!, "sessions") : join(process.env.CLAUDE_CONFIG_DIR!, "projects");
        const out = new Map<string, string[]>();
        if (!existsSync(home)) return out;
        const dirs = provider === "codex" ? [home] : readdirSync(home).map((d) => join(home, d)).filter((d) => statSync(d).isDirectory());
        for (const d of dirs)
            for (const f of readdirSync(d).filter((f) => f.endsWith(".jsonl"))) {
                const lines = readFileSync(join(d, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
                const sent = lines.filter((l) => l.type === "fake-sent" && l.at >= since).map((l) => String(l.text));
                if (sent.length) out.set(join(d, f), sent);
            }
        return out;
    }
    const envFile = join(root, "fake-claude-env.json");
    /** Claude Code's settings for its next prompt: a live process reads them again with each (FAKE_CLAUDE_ENV_FILE); a new one starts with them. */
    function claudeEnv(env: Record<string, string>) {
        const all = { FAKE_TRANSCRIPTS: "1", ...OK["claude-code"], ...env };
        setEnv({ FAKE_SCENARIO: undefined, FAKE_INIT_DELAY_MS: undefined, FAKE_START_DELAY_MS: undefined, FAKE_CANCEL_ANSWER_MS: undefined, FAKE_HANG_INITIALIZE: undefined, ...all });
        writeFileSync(envFile, JSON.stringify(all));
    }

    /**
     * A window: the CLI's settings for the stopped prompt (`env`), when Esc comes (`at`), and whether the thread got
     * the prompt: taken (it's in its transcript, so the next prompt doesn't bring it again) or not (the next brings it).
     * `deadlineMs`: the stop's deadline (stopTiming.interruptMs), shortened so the CLI's answer comes after it.
     * `carried`: whether the next prompt brings it, when that isn't `!taken`.
     */
    type Window = {
        name: string;
        env: Record<string, string>;
        at: (h: H, text: string, since: number, started: number) => Promise<void>;
        taken: boolean;
        deadlineMs?: number;
        carried?: (fresh: boolean) => boolean;
    };
    const inTranscript = (provider: Provider) => (_h: H, text: string, since: number) => until(() => [...threads(provider, since).values()].some((s) => s.some((x) => x.includes(text))));
    const windows: Record<Provider, Window[]> = {
        "claude-code": [
            // Its process still starting (initialize unanswered): nothing was written to it.
            {
                name: "before the prompt is written (Claude Code still starting)",
                env: { FAKE_HANG_INITIALIZE: "1" },
                at: async (h, _t, _s, started) => {
                    await until(() => runs(h) > started);
                    await Bun.sleep(300);
                },
                taken: false,
            },
            // Written, and waiting in Claude Code's queue: withdrawn (cancel_async_message answers cancelled: true).
            {
                name: "written, still in Claude Code's queue",
                env: { FAKE_START_DELAY_MS: "1500" },
                at: async (h, text) => {
                    await until(() => h.prompts().some((p) => p.includes(text)));
                    await Bun.sleep(150);
                },
                taken: false,
            },
            // In the queue; Claude Code says at once it dropped it (command_lifecycle cancelled), but doesn't answer the
            // withdrawal before the stop's deadline (#435 review): dropped, so refused.
            {
                name: "written, in Claude Code's queue, said dropped but the withdrawal unanswered",
                env: { FAKE_START_DELAY_MS: "3000", FAKE_CANCEL_ANSWER_MS: "never" },
                at: async (h, text) => {
                    await until(() => h.prompts().some((p) => p.includes(text)));
                    await Bun.sleep(150);
                },
                taken: false,
                deadlineMs: 1500,
            },
            // Started (command_lifecycle), in its transcript, its system/init not out yet: the issue's window.
            { name: "started, before its system/init", env: { FAKE_SCENARIO: "hang", FAKE_INIT_DELAY_MS: "800" }, at: inTranscript("claude-code"), taken: true },
            // The same, its system/init only after the stop's deadline (#435 review). A new session's process, whose
            // session isn't known yet, goes: the next prompt starts a new thread, with the stopped message in its
            // catch-up. A known thread's process stays, and its thread has the message already.
            {
                name: "started, its system/init after the stop's deadline",
                env: { FAKE_SCENARIO: "hang", FAKE_INIT_DELAY_MS: "2500" },
                at: inTranscript("claude-code"),
                taken: true,
                deadlineMs: 800,
                carried: (fresh) => fresh,
            },
            {
                name: "after its system/init",
                env: { FAKE_SCENARIO: "hang" },
                at: async (h, text, since) => {
                    await inTranscript("claude-code")(h, text, since);
                    await Bun.sleep(300);
                },
                taken: true,
            },
        ],
        codex: [
            // turn/start sent (Codex has the prompt), its answer not back yet.
            { name: "turn/start sent, before its answer", env: {}, at: inTranscript("codex"), taken: true },
            {
                name: "after turn/start's answer",
                env: {},
                at: async (h, text, since) => {
                    await inTranscript("codex")(h, text, since);
                    await Bun.sleep(300);
                },
                taken: true,
            },
        ],
    };

    for (const provider of ["claude-code", "codex"] as const)
        for (const w of windows[provider])
            for (const fresh of [true, false])
                test(`${provider}: Esc ${w.name}, ${fresh ? "on a new session's first prompt" : "on a thread that missed another model's turn"}: ${w.taken ? "taken, so not sent again" : "not taken, so it goes with the next prompt"}`, async () => {
                    const stop = `stop-me-${provider === "codex" ? "cx" : "cc"}-${fresh ? "new" : "old"}-${w.name.replace(/\W+/g, "-")}`;
                    const since = Date.now();
                    if (provider === "claude-code") {
                        setEnv({ ...CLEAR, FAKE_CLAUDE_ENV_FILE: envFile });
                        claudeEnv(fresh ? w.env : {});
                    } else {
                        // The stopped prompt's turn hangs until Esc; a slow turn/start is its (the process's first, or second).
                        const slow = w.name.startsWith("turn/start sent") ? { FAKE_SLOW_TURN_START_AT: `${fresh ? 1 : 2}:1500` } : {};
                        setEnv({ ...CLEAR, ...OK.codex, FAKE_TRANSCRIPTS: "1", FAKE_CODEX_SCENARIOS: fresh ? "hang,cmd" : "cmd,hang,cmd", ...slow });
                    }
                    const deadline = stopTiming.interruptMs;
                    if (w.deadlineMs) stopTiming.interruptMs = w.deadlineMs;
                    const h = await harness(provider, true, `424-${stop}`);
                    try {
                        if (!fresh) {
                            expect(await h.run("first")).toBe("done");
                            h.otherModel();
                            if (provider === "claude-code") claudeEnv(w.env);
                            // Before the prompt is written: a new process, stuck starting.
                            if (w.env.FAKE_HANG_INITIALIZE) await h.agent.releaseBackends();
                        }
                        const started = runs(h);
                        const ac = new AbortController();
                        const turn = h.run(stop, ac.signal);
                        await w.at(h, stop, since, started);
                        const esc = Date.now();
                        ac.abort();
                        expect(await turn).toBe("aborted");
                        // Ended by the CLI's answer (or at once), not by the stop's deadline.
                        expect(Date.now() - esc).toBeLessThan(5000);
                        if (provider === "claude-code") claudeEnv({});
                        expect(await h.run("and now?")).toBe("done");
                        expect(await h.run("and after?")).toBe("done");
                        // No thread has it twice; the one the session goes on in has it once, and the missed turn once.
                        const all = threads(provider, since);
                        for (const sent of all.values()) expect(count(sent.join("\n"), stop)).toBeLessThanOrEqual(1);
                        const current = [...all.values()].filter((s) => s.some((x) => x.includes("and after?")));
                        expect(current.length).toBe(1);
                        expect(count(current[0]!.join("\n"), stop)).toBe(1);
                        if (!fresh) expect(count(current[0]!.join("\n"), TOKEN)).toBe(1);
                        // Where it came from: its own prompt (taken), or the next prompt's catch-up.
                        expect(count(h.prompts().at(-2)!, stop)).toBe((w.carried?.(fresh) ?? !w.taken) ? 1 : 0);
                        expect(count(h.prompts().at(-1)!, stop)).toBe(0);
                    } finally {
                        stopTiming.interruptMs = deadline;
                        await h.agent.dispose();
                        setEnv({ FAKE_TRANSCRIPTS: undefined, FAKE_CLAUDE_ENV_FILE: undefined });
                    }
                }, 40_000);
});
