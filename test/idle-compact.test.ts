// Idle compaction: a long conversation left idle compacts shortly before its
// prompt cache expires. The plan (when, and whether), the timer on a fake
// clock, the agent's cache bookkeeping, and the GUI server end to end against
// a mock of Anthropic's API with a prompt cache.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { startMockAnthropic } from "./helpers/mock-anthropic";
import type { Clock } from "../src/agent/idle-compact";
import type { AgentEvent } from "../src/agent/agent";
import { ProviderError, type AssistantMessage, type Usage } from "../src/providers/types";
import type { ServerEvent, SessionSnapshot } from "../src/server/protocol";

const iso = isolate();
const { idleCompactPlan, cacheTtl, idleCompactMinTokens, IdleCompactTimer, FIVE_MINUTES, ONE_HOUR } = await import("../src/agent/idle-compact");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { Engine } = await import("../src/server/engine");
const { createDemoProject } = await import("../scripts/demo-project");
const { App } = await import("../src/ui/app");
const { stripAnsi } = await import("../src/ui/ansi");

// Every request reads as 400 tokens per character: a few hundred characters make a 100K+ context.
/** How far the mock API's clock is ahead: moving it past a TTL expires its cache. */
let ahead = 0;
const mock = startMockAnthropic({ tokensPerChar: 400, now: () => Date.now() + ahead });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mockant", name: "Mock Anthropic", kind: "anthropic", baseUrl: mock.url }] }));
// Anthropic's client won't send without one.
process.env.MOCKANT_API_KEY = "mock-key";
const SETTINGS = { model: "mockant:claude-opus-5-5", smallModel: "mockant:claude-opus-5-5", idleCompaction: "always", idleCompactionMinTokens: 100_000 };
writeFileSync(join(iso.home, "settings.json"), JSON.stringify(SETTINGS));

afterAll(() => {
    mock.stop();
    iso.cleanup();
});

const T0 = 1_800_000_000_000;
const MIN = 60_000;

function fakeClock(start = T0) {
    let t = start;
    let seq = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const clock: Clock & { advance(ms: number): void; pending(): number } = {
        now: () => t,
        setTimeout: (fn, ms) => (timers.set(++seq, { at: t + ms, fn }), seq),
        clearTimeout: (h) => void timers.delete(h as number),
        advance(ms) {
            const end = t + ms;
            for (;;) {
                const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                timers.delete(next[0]);
                t = next[1].at;
                next[1].fn();
            }
            t = end;
        },
        pending: () => timers.size,
    };
    return clock;
}

describe("when to compact", () => {
    const hour = { at: T0, ttlMs: ONE_HOUR };
    const five = { at: T0, ttlMs: FIVE_MINUTES };

    test("a one-hour cache with a long conversation compacts at 54 minutes, before it expires", () => {
        expect(idleCompactPlan({ settings: {}, cache: hour, contextTokens: 250_000, now: T0 + MIN })).toEqual({ fireAt: T0 + 54 * MIN, expiresAt: T0 + 60 * MIN, contextTokens: 250_000 });
    });

    test("a five-minute cache only with \"always\", at four and a half minutes", () => {
        expect(idleCompactPlan({ settings: {}, cache: five, contextTokens: 250_000, now: T0 })).toBeNull();
        expect(idleCompactPlan({ settings: { idleCompaction: true }, cache: five, contextTokens: 250_000, now: T0 })).toBeNull();
        expect(idleCompactPlan({ settings: { idleCompaction: "always" }, cache: five, contextTokens: 250_000, now: T0 })).toMatchObject({ fireAt: T0 + 4.5 * MIN, expiresAt: T0 + 5 * MIN });
    });

    test("small contexts don't compact: 200K by default, a lower setting never under 100K", () => {
        expect(idleCompactPlan({ settings: {}, cache: hour, contextTokens: 199_999, now: T0 })).toBeNull();
        expect(idleCompactPlan({ settings: {}, cache: hour, contextTokens: 200_000, now: T0 })).not.toBeNull();
        expect(idleCompactMinTokens({ idleCompactionMinTokens: 50_000 })).toBe(100_000);
        expect(idleCompactMinTokens({ idleCompactionMinTokens: 300_000 })).toBe(300_000);
        expect(idleCompactMinTokens({ idleCompactionMinTokens: Number.NaN })).toBe(200_000);
        expect(idleCompactPlan({ settings: { idleCompactionMinTokens: 50_000 }, cache: hour, contextTokens: 99_000, now: T0 })).toBeNull();
        expect(idleCompactPlan({ settings: { idleCompactionMinTokens: 120_000 }, cache: hour, contextTokens: 130_000, now: T0 })).not.toBeNull();
    });

    test("off with idleCompaction false, or with auto-compact off", () => {
        expect(idleCompactPlan({ settings: { idleCompaction: false }, cache: hour, contextTokens: 500_000, now: T0 })).toBeNull();
        expect(idleCompactPlan({ settings: { autoCompact: false }, cache: hour, contextTokens: 500_000, now: T0 })).toBeNull();
        expect(idleCompactPlan({ settings: { autoCompact: false, idleCompaction: "always" }, cache: hour, contextTokens: 500_000, now: T0 })).toBeNull();
    });

    test("no known cache (Codex, OpenAI-compatible providers): never", () => {
        expect(idleCompactPlan({ settings: { idleCompaction: "always" }, contextTokens: 500_000, now: T0 })).toBeNull();
    });

    test("a timer that fires late (the computer slept) skips once the cache is gone or nearly", () => {
        expect(idleCompactPlan({ settings: {}, cache: hour, contextTokens: 250_000, now: T0 + 55 * MIN })).not.toBeNull();
        expect(idleCompactPlan({ settings: {}, cache: hour, contextTokens: 250_000, now: T0 + 55 * MIN + 1 })).toBeNull();
        expect(idleCompactPlan({ settings: {}, cache: hour, contextTokens: 250_000, now: T0 + 61 * MIN })).toBeNull();
        expect(idleCompactPlan({ settings: { idleCompaction: "always" }, cache: five, contextTokens: 250_000, now: T0 + 5 * MIN })).toBeNull();
    });
});

describe("how long a cache lasts", () => {
    const u = (x: Partial<Usage>): Usage => ({ inputTokens: 3, outputTokens: 10, ...x });

    test("Anthropic's default cache is five minutes; one-hour writes make it an hour", () => {
        expect(cacheTtl(u({ cacheWriteTokens: 9000 }), true)).toBe(FIVE_MINUTES);
        expect(cacheTtl(u({ cacheWriteTokens: 9000, cacheWrite1hTokens: 9000 }), false)).toBe(ONE_HOUR);
        expect(cacheTtl(u({ cacheWriteTokens: 9000, cacheWrite1hTokens: 9000 }), true)).toBe(ONE_HOUR);
    });

    test("a breakdown with no one-hour writes means five minutes (Claude Code with an API key)", () => {
        expect(cacheTtl(u({ cacheWriteTokens: 9000, cacheWrite1hTokens: 0 }), false)).toBe(FIVE_MINUTES);
    });

    test("a response that only read the cache keeps what was known; with nothing known, Anthropic's default", () => {
        expect(cacheTtl(u({ cacheReadTokens: 9000 }), false, ONE_HOUR)).toBe(ONE_HOUR);
        expect(cacheTtl(u({ cacheReadTokens: 9000 }), true)).toBe(FIVE_MINUTES);
        expect(cacheTtl(u({ cacheReadTokens: 9000 }), false)).toBeUndefined();
    });

    test("providers that say nothing of the TTL, or nothing cached: unknown", () => {
        expect(cacheTtl(u({ cacheWriteTokens: 9000 }), false)).toBeUndefined();
        expect(cacheTtl(u({}), true)).toBeUndefined();
    });
});

describe("the timer", () => {
    const plan = { fireAt: T0 + 54 * MIN, expiresAt: T0 + 60 * MIN, contextTokens: 250_000 };

    function timer(o: { plan?: () => typeof plan | null; ready?: () => boolean } = {}) {
        const clock = fakeClock();
        const runs: number[] = [];
        const t = new IdleCompactTimer({
            plan: (now) => (o.plan ? o.plan() : now <= plan.fireAt + MIN ? plan : null),
            ready: o.ready ?? (() => true),
            run: () => void runs.push(clock.now()),
        });
        t.clock = clock;
        return { t, clock, runs };
    }

    test("armed after a turn, it runs once at the planned time", () => {
        const { t, clock, runs } = timer();
        expect(t.arm()).toBe(true);
        expect(t.due).toBe(plan.fireAt);
        clock.advance(53 * MIN);
        expect(runs).toEqual([]);
        clock.advance(2 * MIN);
        expect(runs).toEqual([plan.fireAt]);
        expect(t.due).toBeUndefined();
        clock.advance(60 * MIN);
        expect(runs.length).toBe(1);
    });

    test("disarmed (a new turn, /compact, the session closing), it never runs", () => {
        const { t, clock, runs } = timer();
        t.arm();
        t.disarm();
        clock.advance(2 * ONE_HOUR);
        expect(runs).toEqual([]);
        expect(clock.pending()).toBe(0);
    });

    test("arming again replaces the timer rather than adding one", () => {
        const { t, clock, runs } = timer();
        t.arm();
        t.arm();
        expect(clock.pending()).toBe(1);
        clock.advance(ONE_HOUR);
        expect(runs.length).toBe(1);
    });

    test("not ready when it fires (a question open, a message queued, a draft being typed): it skips and doesn't come back", () => {
        const { t, clock, runs } = timer({ ready: () => false });
        t.arm();
        clock.advance(2 * ONE_HOUR);
        expect(runs).toEqual([]);
        expect(clock.pending()).toBe(0);
    });

    test("nothing to do (too small, no cache): it isn't armed", () => {
        const { t, clock } = timer({ plan: () => null });
        expect(t.arm()).toBe(false);
        expect(clock.pending()).toBe(0);
    });

    test("the plan is asked again when it fires: one gone meanwhile is skipped", () => {
        let current: typeof plan | null = plan;
        const { t, clock, runs } = timer({ plan: () => current });
        t.arm();
        current = null;
        clock.advance(ONE_HOUR);
        expect(runs).toEqual([]);
    });

    test("fired early, it waits for the rest", () => {
        const clock = fakeClock();
        const runs: number[] = [];
        const t = new IdleCompactTimer({ plan: () => plan, ready: () => true, run: () => void runs.push(clock.now()) });
        // A clock whose first timer fires a minute early.
        let early = true;
        t.clock = { ...clock, setTimeout: (fn, ms) => clock.setTimeout(fn, early ? ((early = false), ms - MIN) : ms) };
        t.arm();
        clock.advance(53 * MIN);
        expect(runs).toEqual([]);
        expect(t.due).toBe(plan.fireAt);
        clock.advance(MIN);
        expect(runs).toEqual([plan.fireAt]);
    });
});

describe("the agent's cache", () => {
    const reply = (usage: Usage): AssistantMessage => ({ role: "assistant", provider: "anthropic", model: "claude-opus-5-5", stopReason: "end_turn", content: [{ type: "text", text: "done" }], usage });
    const big: Usage = { inputTokens: 3, outputTokens: 50, cacheWriteTokens: 240_000 };

    function setup(o: { provider?: string; usage?: Usage; subagent?: boolean; settings?: Record<string, unknown>; fail?: boolean; before?: (call: number, onEvent: (e: any) => void) => void } = {}) {
        const proj = tempDir("idle-agent-");
        const session = Session.create(proj, { system: "test system" });
        const settings = { idleCompaction: "always", ...o.settings } as any;
        const events: AgentEvent[] = [];
        const requests: { messages: unknown[] }[] = [];
        const agent = new Agent({
            session,
            model: { provider: o.provider ?? "anthropic", id: "claude-opus-5-5", contextWindow: 1_000_000 },
            client: {
                async stream(req: { messages: unknown[]; signal?: AbortSignal }, onEvent: (e: any) => void) {
                    requests.push(req);
                    o.before?.(requests.length, onEvent);
                    if (o.fail) throw new Error("overloaded");
                    return reply(o.usage ?? big);
                },
                async listModels() {
                    return [];
                },
            } as any,
            settings: () => settings,
            checker: new PermissionChecker(() => settings, proj),
            tools: [],
            mode: { get: () => "default", set: () => {} },
            toolState: { cwd: proj, projectRoot: proj, fileState: new Map(), todos: [], shells: new Map() },
            host: { emit: (e) => void events.push(e), ui: {} },
            isSubagent: o.subagent,
        });
        const run = (text: string, signal = new AbortController().signal) => agent.run([{ type: "text", text }], { signal, display: text });
        return { agent, session, events, requests, run, settings };
    }

    test("after a finished turn on Anthropic, it plans from when the request was sent", async () => {
        const { agent, run } = setup();
        const before = Date.now();
        expect(await run("review everything")).toBe("done");
        const plan = agent.idleCompactPlan()!;
        expect(plan.contextTokens).toBe(240_053);
        expect(plan.expiresAt - FIVE_MINUTES).toBeGreaterThanOrEqual(before);
        expect(plan.expiresAt - FIVE_MINUTES).toBeLessThanOrEqual(Date.now());
        expect(plan.fireAt).toBe(plan.expiresAt - 30_000);
    });

    test("after retries, it plans from the request that was answered, not the first attempt", async () => {
        const realNow = Date.now;
        let shift = 0;
        Date.now = () => realNow() + shift;
        try {
            const { agent, run } = setup({
                before: (call) => {
                    if (call > 1) return;
                    // The first attempt is refused, and the retries take ten minutes.
                    shift = 10 * MIN;
                    throw new ProviderError("overloaded", 529, true, 1);
                },
            });
            const started = Date.now();
            expect(await run("review everything")).toBe("done");
            const plan = agent.idleCompactPlan()!;
            expect(plan).not.toBeNull();
            expect(plan.expiresAt - FIVE_MINUTES).toBeGreaterThanOrEqual(started + 10 * MIN);
        } finally {
            Date.now = realNow;
        }
    });

    test("a request the provider sent again itself (malformed tool JSON, say) dates the cache from then", async () => {
        const realNow = Date.now;
        let shift = 0;
        Date.now = () => realNow() + shift;
        try {
            const { agent, run } = setup({
                before: (_call, onEvent) => {
                    shift = 10 * MIN;
                    onEvent({ type: "notice", message: "Tool input arrived malformed; re-issuing the request.", resent: true });
                },
            });
            const started = realNow();
            await run("review everything");
            expect(agent.idleCompactPlan()!.expiresAt - FIVE_MINUTES).toBeGreaterThanOrEqual(started + 10 * MIN);
        } finally {
            Date.now = realNow;
        }
    });

    test("an idle compaction tried once (failed or cancelled) isn't planned again until the next request", async () => {
        let failing = false;
        const { agent, run } = setup({
            before: () => {
                if (failing) throw new Error("overloaded");
            },
        });
        await run("review everything");
        expect(agent.idleCompactPlan()).not.toBeNull();
        failing = true;
        await expect(agent.compact({ auto: true, idle: true, signal: new AbortController().signal })).rejects.toThrow();
        expect(agent.idleCompactPlan()).toBeNull();
        // Usage reported again for the same request (Claude Code's cancelled /compact) is the same cache.
        (agent as any).noteCache(big, (agent as any).cache.at);
        expect(agent.idleCompactPlan()).toBeNull();
        failing = false;
        await run("one more thing");
        expect(agent.idleCompactPlan()).not.toBeNull();
    });

    test("not for a sub-agent, a provider with no known TTL, a small context, or a turn that didn't finish", async () => {
        const sub = setup({ subagent: true });
        await sub.run("x");
        expect(sub.agent.idleCompactPlan()).toBeNull();

        const other = setup({ provider: "openai" });
        await other.run("x");
        expect(other.agent.idleCompactPlan()).toBeNull();

        const small = setup({ usage: { inputTokens: 3, outputTokens: 5, cacheWriteTokens: 20_000 } });
        await small.run("x");
        expect(small.agent.idleCompactPlan()).toBeNull();

        const failed = setup({ fail: true });
        expect(await failed.run("x")).toBe("error");
        expect(failed.agent.idleCompactPlan()).toBeNull();

        const stopped = setup();
        const ac = new AbortController();
        ac.abort();
        await stopped.run("x", ac.signal);
        expect(stopped.agent.idleCompactPlan()).toBeNull();
    });

    test("an idle compaction is marked as one, in its events and the session file, and plans nothing more", async () => {
        const { agent, session, events, run } = setup();
        await run("review everything");
        expect(await agent.compact({ auto: true, idle: true, signal: new AbortController().signal })).toBe(true);
        expect(events.find((e) => e.type === "compact_start")).toEqual({ type: "compact_start", auto: true, idle: true });
        expect(events.find((e) => e.type === "compact_end")).toMatchObject({ type: "compact_end", idle: true });
        const record = readFileSync(session.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.t === "compact");
        expect(record).toMatchObject({ t: "compact", idle: true });
        // Once per idle spell: the next plan waits for the next turn.
        expect(agent.idleCompactPlan()).toBeNull();
        // The summary doesn't tell the model to carry on by itself: the user is away.
        expect(JSON.stringify(session.messages)).not.toContain("without asking the user any further questions");
    });

    test("a manual /compact's record is unchanged", async () => {
        const { agent, session, run } = setup();
        await run("review everything");
        await agent.compact({ auto: false, signal: new AbortController().signal });
        const record = readFileSync(session.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.t === "compact");
        expect(record).toEqual({ t: "compact", summary: "done" });
    });

    test("switching models forgets the cache: the new model hasn't read the history", async () => {
        const { agent, run } = setup();
        await run("review everything");
        expect(agent.idleCompactPlan()).not.toBeNull();
        agent.setModel({ provider: "anthropic", id: "claude-sonnet-5-5", contextWindow: 1_000_000 }, agent.client);
        expect(agent.idleCompactPlan()).toBeNull();
    });

    test("turned off in settings after the turn: nothing planned", async () => {
        const { agent, run, settings } = setup();
        await run("review everything");
        settings.idleCompaction = false;
        expect(agent.idleCompactPlan()).toBeNull();
    });
});

describe("the GUI server, against a cached Anthropic API", () => {
    async function engineWithSession() {
        const engine = new Engine();
        const events: ServerEvent[] = [];
        const c = { subs: new Set<string>(), send: (e: ServerEvent) => void events.push(e) };
        engine.clients.add(c as never);
        const cwd = createDemoProject(tempDir("idle-proj-"), { git: false });
        const snap = (await engine.handle(c as never, "session.create", { cwd })) as SessionSnapshot;
        const id = snap.state.id;
        const rt = engine.runtimes.get(id)!;
        return { engine, c: c as never, events, id, rt };
    }

    async function until(pred: () => boolean, ms = 10_000) {
        const end = Date.now() + ms;
        while (!pred()) {
            if (Date.now() > end) throw new Error("timed out");
            await Bun.sleep(10);
        }
    }

    /** A turn long enough (×400 tokens a character) to be worth compacting. */
    const LONG = "Review the whole payments module and list every problem you find. " + "x".repeat(1500);

    async function longTurn(engine: InstanceType<typeof Engine>, c: never, id: string, rt: any) {
        await engine.handle(c, "session.send", { id, text: LONG });
        await until(() => rt.idle && rt.session.messages.length >= 2 && rt.idleCompact.due !== undefined);
    }

    /** Fires the armed timer now, as it would at its time. */
    function fire(rt: any) {
        const due = rt.idleCompact.due as number;
        rt.idleCompact.clock = { ...rt.idleCompact.clock, now: () => due };
        rt.idleCompact.fire();
    }

    test("a long idle conversation compacts before the cache expires, shown as an idle compaction; the next turn is small", async () => {
        const { engine, c, id, rt } = await engineWithSession();
        try {
            await longTurn(engine, c, id, rt);
            const turnReq = mock.requests.at(-1)!;
            const due = rt.idleCompact.due as number;
            // 90% into the five-minute cache of the turn's request.
            expect(due - turnReq.at).toBeGreaterThanOrEqual(4.5 * MIN - 50);
            expect(due - turnReq.at).toBeLessThanOrEqual(4.5 * MIN + 50);

            const n = mock.requests.length;
            const lastActive = rt.lastActive;
            fire(rt);
            expect(rt.snapshot().state.activity?.label).toBe("Compacting while idle");
            // Not "Working" in the sidebar: nothing the user started.
            expect(rt.snapshot().state.status).not.toBe("running");
            await until(() => rt.idle && rt.session.summary !== undefined);
            // Not the user's doing: the session keeps its place in the sidebar.
            expect(rt.lastActive).toBe(lastActive);
            const compaction = mock.requests[n]!;
            expect(compaction.compaction).toBe(true);
            // While the cache was warm, the history was read from it.
            expect(compaction.usage.cache_read_input_tokens).toBeGreaterThan(100_000);

            const snap = rt.snapshot();
            const block = snap.turns.flatMap((t: any) => t.blocks).find((b: any) => b.t === "compact");
            expect(block).toMatchObject({ t: "compact", idle: true });
            expect(snap.state.contextTokens).toBe(0);
            expect(rt.session.messages.length).toBe(1);

            // Back after the cache expired: the next turn sends the summary, not the history.
            ahead = 6 * MIN;
            try {
                await engine.handle(c, "session.send", { id, text: "carry on" });
                await until(() => rt.idle && rt.session.messages.length >= 3);
            } finally {
                ahead = 0;
            }
            const next = mock.requests.filter((r) => !r.compaction).at(-1)!;
            expect(next.usage.cache_read_input_tokens).toBe(0);
            const sent = next.usage.input_tokens + next.usage.cache_creation_input_tokens;
            expect(sent).toBeLessThan(turnReq.usage.cache_creation_input_tokens / 2);

            // Reopened, the transcript still says it was an idle compaction.
            const reopened = (await engine.handle(c, "session.open", { id })) as SessionSnapshot;
            expect(reopened.turns.flatMap((t) => t.blocks).find((b) => b.t === "compact")).toMatchObject({ idle: true });
        } finally {
            await engine.stop();
        }
    });

    test("a message sent while it compacts cancels it and runs on the warm cache; the history is unchanged", async () => {
        const { engine, c, id, rt } = await engineWithSession();
        // The compaction takes a while to answer.
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        mock.hold = (r) => (r.compaction ? gate : undefined);
        try {
            await longTurn(engine, c, id, rt);
            const history = rt.session.messages.length;
            fire(rt);
            await until(() => rt.snapshot().state.activity?.label === "Compacting while idle");
            // Marked as one: the GUI leaves the controls that take over from it enabled. A retry (Claude Code's) keeps the mark.
            expect(rt.snapshot().state.activity.idle).toBe(true);
            rt.activity("Retrying in 2s", "overloaded (attempt 1)");
            expect(rt.snapshot().state.activity).toMatchObject({ label: "Retrying in 2s", idle: true });
            const sent = (await engine.handle(c, "session.send", { id, text: "one more thing" })) as { queued: boolean };
            expect(sent.queued).toBe(true);
            await until(() => rt.idle && rt.session.messages.length === history + 2);
            expect(rt.session.summary).toBeUndefined();
            const last = mock.requests.filter((r) => !r.compaction).at(-1)!;
            expect(last.usage.cache_read_input_tokens).toBeGreaterThan(100_000);
            // Nothing said it failed; the message didn't go back to the input box.
            const notices = rt.snapshot().turns.flatMap((t: any) => t.blocks).filter((b: any) => b.t === "notice");
            expect(notices.map((b: any) => b.text).join("\n")).not.toMatch(/compact/i);
            expect(rt.snapshot().state.queued ?? []).toEqual([]);
        } finally {
            release();
            mock.hold = undefined;
            await engine.stop();
        }
    });

    test("the user's own /compact takes over from an idle one rather than being refused", async () => {
        const { engine, c, id, rt } = await engineWithSession();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        mock.hold = (r) => (r.compaction && !r.messages.some((m) => JSON.stringify(m.content).includes("keep the plan")) ? gate : undefined);
        try {
            await longTurn(engine, c, id, rt);
            fire(rt);
            await until(() => rt.snapshot().state.activity?.label === "Compacting while idle");
            await engine.handle(c, "session.compact", { id, instructions: "keep the plan" });
            expect(rt.session.summary).toBeDefined();
            const block = rt.snapshot().turns.flatMap((t: any) => t.blocks).find((b: any) => b.t === "compact");
            expect(block.idle).toBeUndefined();
        } finally {
            release();
            mock.hold = undefined;
            await engine.stop();
        }
    });

    test("a failed compaction says so quietly and leaves the conversation as it was", async () => {
        const { engine, c, id, rt } = await engineWithSession();
        const reply = mock.reply;
        mock.reply = (r) => (r.compaction ? 500 : reply(r));
        try {
            await longTurn(engine, c, id, rt);
            const history = JSON.stringify(rt.session.messages);
            const compactions = mock.requests.filter((r) => r.compaction).length;
            fire(rt);
            await until(() => rt.idle && rt.snapshot().turns.flatMap((t: any) => t.blocks).some((b: any) => b.t === "notice" && /compact while idle/.test(b.text)));
            const notice = rt.snapshot().turns.flatMap((t: any) => t.blocks).find((b: any) => b.t === "notice" && /compact while idle/.test(b.text));
            expect(notice).toMatchObject({ level: "warn" });
            expect(notice.text).toContain("The conversation is unchanged.");
            expect(JSON.stringify(rt.session.messages)).toBe(history);
            // Not tried again until the next turn: not after a !command, nor a draft cleared.
            expect(rt.idleCompact.due).toBeUndefined();
            await engine.handle(c, "session.send", { id, text: "!true" });
            await until(() => rt.idle);
            await engine.handle(c, "session.draft", { id, present: true });
            await engine.handle(c, "session.draft", { id, present: false });
            expect(rt.idleCompact.due).toBeUndefined();
            await Bun.sleep(50);
            expect(mock.requests.filter((r) => r.compaction).length).toBe(compactions + 1);
            // The next turn plans afresh.
            await longTurn(engine, c, id, rt);
            expect(rt.idleCompact.due).toBeDefined();
        } finally {
            mock.reply = reply;
            await engine.stop();
        }
    });

    test("it waits for nothing: a message queued or a question open when it fires means the user is there", async () => {
        const { engine, c, id, rt } = await engineWithSession();
        try {
            await longTurn(engine, c, id, rt);
            const n = mock.requests.length;
            rt.pending.set("q", {});
            fire(rt);
            rt.pending.delete("q");
            rt.queued.push({ id: 99, text: "waiting" });
            fire(rt);
            rt.queued.length = 0;
            // One held since a restart, waiting for the user to send it, too.
            rt.queued.push({ id: 98, text: "held", held: true });
            fire(rt);
            rt.queued.length = 0;
            await Bun.sleep(50);
            expect(mock.requests.length).toBe(n);
            expect(rt.session.summary).toBeUndefined();
        } finally {
            await engine.stop();
        }
    });

    test("not while a window has a message being written; cleared, or the window gone, it compacts as planned", async () => {
        const { engine, c, id, rt } = await engineWithSession();
        try {
            await longTurn(engine, c, id, rt);
            const compactions = () => mock.requests.filter((r) => r.compaction).length;
            const n = compactions();
            await engine.handle(c, "session.draft", { id, present: true });
            fire(rt);
            await Bun.sleep(50);
            expect(compactions()).toBe(n);
            expect(rt.session.summary).toBeUndefined();
            // The draft cleared without sending: armed again, it compacts at its time.
            await engine.handle(c, "session.draft", { id, present: false });
            expect(rt.idleCompact.due).toBeDefined();
            // The Rewind dialog open holds it off too, whatever the message box does.
            await engine.handle(c, "session.draft", { id, present: true, dialog: true });
            await engine.handle(c, "session.draft", { id, present: true });
            await engine.handle(c, "session.draft", { id, present: false });
            fire(rt);
            await Bun.sleep(50);
            expect(compactions()).toBe(n);
            await engine.handle(c, "session.draft", { id, present: false, dialog: true });
            expect(rt.idleCompact.due).toBeDefined();
            // So does a window that goes away with a draft in it, or the dialog open.
            await engine.handle(c, "session.draft", { id, present: true, dialog: true });
            await engine.handle(c, "session.draft", { id, present: true });
            engine.dropClient(c);
            expect(rt.idleCompact.due).toBeDefined();
            fire(rt);
            await until(() => rt.idle && rt.session.summary !== undefined);
            expect(compactions()).toBe(n + 1);
        } finally {
            await engine.stop();
        }
    });

    test("switching models (or deleting the session) takes over from an idle compaction rather than being refused", async () => {
        const { engine, c, id, rt } = await engineWithSession();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        mock.hold = (r) => (r.compaction ? gate : undefined);
        try {
            await longTurn(engine, c, id, rt);
            fire(rt);
            await until(() => rt.snapshot().state.activity?.label === "Compacting while idle");
            await engine.handle(c, "session.setModel", { id, ref: SETTINGS.model });
            expect(rt.session.summary).toBeUndefined();
            expect(rt.snapshot().state.activity).toBeUndefined();
            // The new model hasn't read the history: nothing planned until it has.
            await until(() => rt.idle);
            expect(rt.idleCompact.due).toBeUndefined();
            await longTurn(engine, c, id, rt);
            fire(rt);
            await until(() => rt.snapshot().state.activity?.label === "Compacting while idle");
            await engine.handle(c, "session.delete", { id });
            expect(engine.runtimes.has(id)).toBe(false);
        } finally {
            release();
            mock.hold = undefined;
            await engine.stop();
        }
    });

    test("a schedule that comes due while it compacts takes over: the compaction stops and the prompt runs on the warm cache", async () => {
        const { engine, c, id, rt } = await engineWithSession();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        mock.hold = (r) => (r.compaction ? gate : undefined);
        try {
            await longTurn(engine, c, id, rt);
            const history = rt.session.messages.length;
            fire(rt);
            await until(() => rt.snapshot().state.activity?.label === "Compacting while idle");
            rt.schedules.scheduler.add({ kind: "loop", prompt: "check the build", everyMs: 60 * MIN, runNow: true });
            await until(() => rt.idle && rt.session.messages.length === history + 2);
            expect(rt.session.summary).toBeUndefined();
            expect(JSON.stringify(rt.session.messages.at(-2))).toContain("check the build");
            const last = mock.requests.filter((r) => !r.compaction).at(-1)!;
            expect(last.usage.cache_read_input_tokens).toBeGreaterThan(100_000);
            const notices = rt.snapshot().turns.flatMap((t: any) => t.blocks).filter((b: any) => b.t === "notice");
            expect(notices.map((b: any) => b.text).join("\n")).not.toMatch(/compact|cancel/i);
            // Idle again after it: planned afresh from the scheduled turn's cache.
            expect(rt.idleCompact.due).toBeDefined();
        } finally {
            release();
            mock.hold = undefined;
            await engine.stop();
        }
    });

    test("opening Rewind (or picking a prompt in it) stops an idle compaction already running", async () => {
        const { engine, c, id, rt } = await engineWithSession();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        mock.hold = (r) => (r.compaction ? gate : undefined);
        try {
            // Opening the dialog.
            await longTurn(engine, c, id, rt);
            fire(rt);
            await until(() => rt.snapshot().state.activity?.label === "Compacting while idle");
            const targets = (await engine.handle(c, "session.rewindTargets", { id })) as any[];
            expect(rt.compactingWhileIdle).toBe(false);
            expect(rt.session.summary).toBeUndefined();
            expect(targets.length).toBeGreaterThan(0);
            // A prompt picked in a dialog opened before it started.
            await longTurn(engine, c, id, rt);
            const shown = (await engine.handle(c, "session.rewindTargets", { id })) as any[];
            fire(rt);
            await until(() => rt.snapshot().state.activity?.label === "Compacting while idle");
            const plan = await engine.handle(c, "session.rewindPlan", { id, index: shown.at(-1).index });
            expect(plan).toBeDefined();
            expect(rt.compactingWhileIdle).toBe(false);
            expect(rt.session.summary).toBeUndefined();
        } finally {
            release();
            mock.hold = undefined;
            await engine.stop();
        }
    });

    test("a watched PR's event while it compacts takes over: the compaction stops and the wake runs on the warm cache", async () => {
        const { engine, c, id, rt } = await engineWithSession();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        mock.hold = (r) => (r.compaction ? gate : undefined);
        try {
            await longTurn(engine, c, id, rt);
            const history = rt.session.messages.length;
            fire(rt);
            await until(() => rt.snapshot().state.activity?.label === "Compacting while idle");
            rt.toolState.wakes.push({ source: "pull-request", label: "PR #12: checks failed", text: "PR #12's checks failed." });
            await until(() => rt.idle && rt.session.messages.length === history + 2);
            expect(rt.session.summary).toBeUndefined();
            expect(JSON.stringify(rt.session.messages.at(-2))).toContain("checks failed");
            const last = mock.requests.filter((r) => !r.compaction).at(-1)!;
            expect(last.usage.cache_read_input_tokens).toBeGreaterThan(100_000);
        } finally {
            release();
            mock.hold = undefined;
            await engine.stop();
        }
    });

    test("a new turn disarms it, and so does closing the session", async () => {
        const { engine, c, id, rt } = await engineWithSession();
        try {
            await longTurn(engine, c, id, rt);
            expect(rt.idleCompact.due).toBeDefined();
            const done = engine.handle(c, "session.send", { id, text: "short" });
            expect(rt.idleCompact.due).toBeUndefined();
            await done;
            await until(() => rt.idle && rt.idleCompact.due !== undefined);
            await rt.close();
            expect(rt.idleCompact.due).toBeUndefined();
        } finally {
            await engine.stop();
        }
    });

    test("the setting round-trips through the GUI's settings", async () => {
        const { engine, c } = await engineWithSession();
        try {
            expect(((await engine.handle(c, "settings.update", { patch: { idleCompaction: false } })) as any).idleCompaction).toBe(false);
            expect(((await engine.handle(c, "settings.update", { patch: { idleCompaction: true } })) as any).idleCompaction).toBeUndefined();
            expect(((await engine.handle(c, "settings.update", { patch: { idleCompaction: "always" } })) as any).idleCompaction).toBe("always");
            expect(((await engine.handle(c, "settings.update", { patch: { idleCompaction: "sometimes" } })) as any).idleCompaction).toBeUndefined();
        } finally {
            writeFileSync(join(iso.home, "settings.json"), JSON.stringify(SETTINGS));
            await engine.stop();
        }
    });
});

describe("the TUI", () => {
    const big = { inputTokens: 3, outputTokens: 50, cacheWriteTokens: 240_000 };
    const isCompaction = (req: any) => JSON.stringify(req.messages.at(-1)).includes("write a detailed summary of the conversation");

    function testApp(o: { hold?: boolean } = {}) {
        const app = new App({ cwd: tempDir("idle-tui-"), trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
        const printed: string[] = [];
        const print = (l: string | string[] | ((cols: number) => string[])) => (printed.push(...(typeof l === "function" ? l(100) : Array.isArray(l) ? l : [l])), {});
        (app as any).screen = { print, replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop() {}, clearScreen() {} };
        (app as any).renderLive = () => {};
        app.session = Session.create(app.cwd, { persist: false });
        const requests: any[] = [];
        app.model = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", contextWindow: 1_000_000 } as any;
        app.client = {
            stream: async (req: any) => {
                requests.push(req);
                if (o.hold && isCompaction(req)) await new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
                return { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", stopReason: "end_turn", content: [{ type: "text", text: isCompaction(req) ? "Summary of the review" : "ok" }], usage: big } as AssistantMessage;
            },
            listModels: async () => [],
        } as any;
        app.makeAgent();
        return { app, requests, text: () => printed.map(stripAnsi).join("\n") };
    }

    const fire = (app: any) => {
        const due = app.idleCompact.due as number;
        app.idleCompact.clock = { ...app.idleCompact.clock, now: () => due };
        app.idleCompact.fire();
    };

    test("left idle after a long turn, it compacts and says so in one muted line", async () => {
        const { app, text } = testApp();
        await app.startTurn("review everything");
        expect((app as any).idleCompact.due).toBeDefined();
        fire(app);
        const until = Date.now() + 5000;
        while (app.session.summary === undefined && Date.now() < until) await Bun.sleep(5);
        while (app.busy && Date.now() < until) await Bun.sleep(5);
        expect(app.session.summary).toBe("Summary of the review");
        expect(text()).toContain("✻ Compacted while idle, before the prompt cache expired · /summary to view · /config to turn off");
        expect(text()).not.toContain("Cancelled");
    });

    test("a message sent while it compacts cancels it and runs; nothing is compacted or handed back", async () => {
        const { app, requests, text } = testApp({ hold: true });
        await app.startTurn("review everything");
        fire(app);
        const until = Date.now() + 5000;
        while (!requests.some(isCompaction) && Date.now() < until) await Bun.sleep(5);
        expect(app.busy).toBe(true);
        await app.submitText("one more thing");
        while ((app.busy || !app.session.messages.some((m) => JSON.stringify(m).includes("one more thing"))) && Date.now() < until) await Bun.sleep(5);
        while (app.busy && Date.now() < until) await Bun.sleep(5);
        expect(app.session.summary).toBeUndefined();
        expect(app.session.messages.filter((m) => m.role === "assistant").length).toBe(2);
        expect(text()).not.toContain("Cancelled");
        expect(app.editor.value()).toBe("");
    });

    test("a command while it compacts: the compaction gives way and the command runs", async () => {
        const { app, requests, text } = testApp({ hold: true });
        await app.startTurn("review everything");
        fire(app);
        const until = Date.now() + 5000;
        while (!requests.some(isCompaction) && Date.now() < until) await Bun.sleep(5);
        await app.submitText("/effort high");
        expect(text()).not.toContain("isn't available while");
        expect(text()).not.toContain("Cancelled");
        expect(app.busy).toBe(false);
        expect(app.session.summary).toBeUndefined();
    });

    test("a schedule that comes due while it compacts takes over: the compaction stops and the prompt runs", async () => {
        const { app, requests, text } = testApp({ hold: true });
        (app as any).modelReady = true;
        await app.startTurn("review everything");
        fire(app);
        const until = Date.now() + 5000;
        while (!requests.some(isCompaction) && Date.now() < until) await Bun.sleep(5);
        expect(app.busy).toBe(true);
        app.schedules.scheduler.add({ kind: "loop", prompt: "check the build", everyMs: 60 * MIN, runNow: true });
        while (!app.session.messages.some((m) => JSON.stringify(m).includes("check the build")) && Date.now() < until) await Bun.sleep(5);
        while (app.busy && Date.now() < until) await Bun.sleep(5);
        expect(app.session.summary).toBeUndefined();
        expect(app.session.messages.filter((m) => m.role === "assistant").length).toBe(2);
        expect(text()).not.toContain("Cancelled");
        app.schedules.scheduler.clear();
    });

    test("a watched PR's event while it compacts takes over: the compaction stops and the wake runs", async () => {
        const { app, requests, text } = testApp({ hold: true });
        (app as any).modelReady = true;
        await app.startTurn("review everything");
        fire(app);
        const until = Date.now() + 5000;
        while (!requests.some(isCompaction) && Date.now() < until) await Bun.sleep(5);
        expect(app.busy).toBe(true);
        (app as any).toolState.wakes.push({ source: "pull-request", label: "PR #12: checks failed", text: "PR #12's checks failed." });
        while (!app.session.messages.some((m) => JSON.stringify(m).includes("checks failed")) && Date.now() < until) await Bun.sleep(5);
        while (app.busy && Date.now() < until) await Bun.sleep(5);
        expect(app.session.summary).toBeUndefined();
        expect(app.session.messages.filter((m) => m.role === "assistant").length).toBe(2);
        expect(text()).not.toContain("Cancelled");
    });

    test("quitting disarms it: it can't start during the exit hooks", async () => {
        const { app } = testApp();
        await app.startTurn("review everything");
        expect((app as any).idleCompact.due).toBeDefined();
        (app as any).screen.stop = () => {};
        const exit = process.exit;
        process.exit = (() => undefined) as never;
        let due: number | undefined;
        try {
            const done = app.exit(0);
            due = (app as any).idleCompact.due;
            await done;
        } finally {
            // Only once exit() is over: it ends by calling process.exit.
            process.exit = exit;
        }
        expect(due).toBeUndefined();
    });

    test("not while a draft is being typed: the user is back", async () => {
        const { app, requests } = testApp();
        await app.startTurn("review everything");
        app.editor.insert("half a thought");
        const n = requests.length;
        fire(app);
        await Bun.sleep(20);
        expect(requests.length).toBe(n);
        expect(app.busy).toBe(false);
    });
});
