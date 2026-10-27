// Steering an ACP agent's running turn (src/backends/acp): a message the user sends mid-turn joins it at its next
// step, OpenCode's as a second session/prompt it folds into the running one, Grok's by _x.ai/interject. The recorded
// sessions (test/fixtures/protocol/{opencode-1.19.4,grok-1.0.70}-steer*.jsonl) replayed through a connection, then
// the backend on the live pool against the fake agents (test/fixtures/fake-acp.ts). No real agent runs here.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { Replay } from "./helpers/acp-replay";

const { cleanup } = isolate();
const registry = await import("../src/providers/registry");
const { forgetClient } = await import("../src/providers/models");
const { AcpConnection } = await import("../src/backends/acp/connection");
const { AcpBackend } = await import("../src/backends/acp/backend");
const { acpAgent } = await import("../src/backends/acp/agents");
const { agentCli } = await import("../src/backends/defs");
const { backendModel } = await import("../src/backends/types");
type AgentEvent = import("../src/agent/agent").AgentEvent;
type CliEvent = import("../src/backends/live/types").CliEvent;
type SessionHost = import("../src/backends/types").SessionHost;
type SteerSource = import("../src/backends/acp/connection").SteerSource;
type SteerMessage = import("../src/backends/types").SteerMessage;
type TurnSink = import("../src/backends/types").TurnSink;
type Usage = import("../src/providers/types").Usage;

const bin = tempDir("fake-acp-steer-");
const LOG = join(bin, "log.jsonl");
const FAKE = join(import.meta.dir, "fixtures", "fake-acp.ts");
for (const [name, env] of [["opencode", ""], ["grok", "FAKE_ACP_FLAVOR=grok "]] as const) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${env}exec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(join(bin, name), 0o755);
}

afterAll(() => {
    cleanup();
    rmSync(bin, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

const logLines = (): any[] => (existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const received = () => logLines().flatMap((l) => (l.received ? [l.received] : []));
const sentPrompts = () => received().filter((m) => m.method === "session/prompt");
const texts = (es: AgentEvent[]) => es.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
const notices = (es: AgentEvent[]) => es.flatMap((e) => (e.type === "notice" ? [e.message] : []));
const until = async (f: () => boolean, ms = 5000) => {
    for (let i = 0; i < ms / 5 && !f(); i++) await Bun.sleep(5);
    expect(f()).toBe(true);
};
const RED = { type: "image" as const, mediaType: "image/png", data: "iVBORw0KGgo=" };

function host() {
    const usage: { u: Usage; o: { contextTokens?: number; contextWindow?: number } }[] = [];
    const h: SessionHost = {
        mode: () => "default",
        permission: async () => ({ allow: true }),
        askQuestions: async () => undefined,
        approvePlan: async () => ({ approved: false }),
        setMode: () => {},
        usage: (u, x) => usage.push({ u, o: x }),
        sessionId: () => {},
    };
    return { h, usage };
}

/** A recorded session played to a connection; its turn's prompt sent. */
async function replay(stem: string, cli: "opencode" | "grok", model: string) {
    const rec = new Replay(stem);
    const events: CliEvent[] = [];
    const { h, usage } = host();
    const conn = new AcpConnection(rec as any, (e) => events.push(e), h, agentCli(cli)!, acpAgent(cli), `/tmp/acp-${cli}`);
    await conn.initialize();
    await conn.open({ settings: { model: backendModel(cli, model), mode: "default" } });
    const agentEvents = () => events.flatMap((e) => (e.t === "turn_event" ? [e.event] : []));
    const ended = () => events.find((e): e is Extract<CliEvent, { t: "turn_ended" }> => e.t === "turn_ended");
    return { rec, conn, events, agentEvents, ended, usage };
}

/**
 * A recording whose second prompt's answer (a steer folded into the first) is held once the first has answered, until
 * a third prompt is sent: then it goes, and the third is answered as the first was.
 */
class HeldSteer extends Replay {
    private prompts: number[] = [];
    private first: unknown;
    holding = false;
    private release!: () => void;
    private released = new Promise<void>((r) => (this.release = r));

    override async send(m: any): Promise<boolean> {
        if (m.method === "session/prompt" && this.prompts.push(m.id) > 2) {
            this.sent.push(m);
            this.release();
            return true;
        }
        return super.send(m);
    }

    override async *messages(): AsyncGenerator<Record<string, any>> {
        for await (const f of super.messages()) {
            if (f.method === undefined && f.id === this.prompts[0]) this.first = f.result;
            if (f.method === undefined && f.id === this.prompts[1]) {
                this.holding = true;
                await this.released;
                yield f;
                yield { jsonrpc: "2.0", id: this.prompts[2], result: this.first };
                continue;
            }
            yield f;
        }
    }
}

describe("recorded: OpenCode 1.19.4", () => {
    test("a steer mid-turn is a second session/prompt; it's folded in, both answer together, the tokens count once", async () => {
        const r = await replay("opencode-1.19.4-steer", "opencode", "opencode/big-pickle");
        const { ref } = await r.conn.prompt({ text: "Run these three shell commands", images: [] });
        await until(() => r.agentEvents().some((e) => e.type === "tool_start"));
        expect(await r.conn.steer(ref, { text: "Also, end your final reply with the word banana.", images: [] })).toBe(true);
        await until(() => Boolean(r.ended()));
        expect(r.ended()).toMatchObject({ ref, reason: "done" });
        expect(r.rec.sent.filter((m) => m.method === "session/prompt").map((m) => m.params.prompt[0].text)).toEqual(["Run these three shell commands", "Also, end your final reply with the word banana."]);
        expect(texts(r.agentEvents())).toMatch(/banana$/);
        expect(r.usage).toHaveLength(1);
        expect(r.usage[0]!.u).toMatchObject({ inputTokens: 11, outputTokens: 11, cacheReadTokens: 9997, reasoningTokens: 28 });
    });

    test("one taken as the turn's prompt answers, before the steer folded into it has: a prompt of its own, whose tokens count too", async () => {
        const rec = new HeldSteer("opencode-1.19.4-steer");
        const events: CliEvent[] = [];
        const { h, usage } = host();
        // Taken while the turn could still be steered (its hooks ran meanwhile), it goes once the prompt has answered.
        const source: SteerSource = {
            drain: async () => {
                await until(() => rec.holding, 10_000);
                return [{ text: "late", images: [], documents: [] }];
            },
            undelivered: () => {},
        };
        const conn = new AcpConnection(rec as any, (e) => events.push(e), h, agentCli("opencode")!, acpAgent("opencode"), "/tmp/acp-opencode", () => source);
        await conn.initialize();
        await conn.open({ settings: { model: backendModel("opencode", "opencode/big-pickle"), mode: "default" } });
        const { ref } = await conn.prompt({ text: "Run these three shell commands", images: [] });
        await until(() => events.some((e) => e.t === "turn_event" && e.event.type === "tool_start"));
        expect(await conn.steer(ref, { text: "Also, end your final reply with the word banana.", images: [] })).toBe(true);
        await until(() => events.some((e) => e.t === "turn_ended"), 10_000);
        expect(events.find((e) => e.t === "turn_ended")).toMatchObject({ ref, reason: "done" });
        expect(rec.sent.filter((m) => m.method === "session/prompt").map((m) => m.params.prompt[0].text)).toEqual(["Run these three shell commands", "Also, end your final reply with the word banana.", "late"]);
        // The first two folded together (counted once), the third run apart, though its tokens are the same.
        expect(usage).toHaveLength(1);
        expect(usage[0]!.u).toMatchObject({ inputTokens: 22, outputTokens: 22, cacheReadTokens: 19994 });
    });

    test("one sent as its answer is being written, with an image: it takes another step for it", async () => {
        const r = await replay("opencode-1.19.4-steer-late", "opencode", "opencode/big-pickle");
        const { ref } = await r.conn.prompt({ text: "Reply with the single word: alpha", images: [] });
        await until(() => r.agentEvents().some((e) => e.type === "text"));
        expect(await r.conn.steer(ref, { text: "Also, the colour", images: [RED] })).toBe(true);
        await until(() => Boolean(r.ended()));
        expect(r.ended()!.reason).toBe("done");
        expect(r.rec.sent.filter((m) => m.method === "session/prompt")[1].params.prompt.map((b: any) => b.type)).toEqual(["text", "image"]);
        expect(texts(r.agentEvents())).toMatch(/red/i);
        expect(r.usage).toHaveLength(1);
    });

    test("Esc after a steer: both answer cancelled, the turn is aborted once", async () => {
        const r = await replay("opencode-1.19.4-steer-cancel", "opencode", "opencode/big-pickle");
        const { ref } = await r.conn.prompt({ text: "Run these three shell commands", images: [] });
        await until(() => r.agentEvents().some((e) => e.type === "tool_start"));
        expect(await r.conn.steer(ref, { text: "banana", images: [] })).toBe(true);
        await r.conn.interrupt(ref);
        await until(() => Boolean(r.ended()));
        expect(r.ended()!.reason).toBe("aborted");
        expect(r.events.filter((e) => e.t === "turn_ended")).toHaveLength(1);
        expect(r.rec.sent.filter((m) => m.method === "session/cancel")).toHaveLength(1);
    });

    test("an error answers both alike: the turn fails once, with the error, and no word about the steer", async () => {
        const r = await replay("opencode-1.19.4-steer-error", "opencode", "opencode/big-pickle");
        const { ref } = await r.conn.prompt({ text: "Run the shell command `sleep 2` three times", images: [] });
        await until(() => r.agentEvents().some((e) => e.type === "tool_start"));
        expect(await r.conn.steer(ref, { text: "banana", images: [] })).toBe(true);
        await until(() => Boolean(r.ended()));
        expect(r.ended()).toMatchObject({ reason: "error", error: expect.stringContaining("rejected permission") });
        expect(notices(r.agentEvents()).filter((n) => /steer/.test(n))).toEqual([]);
    });
});

describe("recorded: Grok 1.0.70", () => {
    test("a steer mid-turn is _x.ai/interject; its prompt answers once for all of it, the tokens count once", async () => {
        const r = await replay("grok-1.0.70-steer", "grok", "grok-4.7");
        const { ref } = await r.conn.prompt({ text: "Run the shell command `sleep 2` three times", images: [] });
        // Its first tool_call says little (no row yet): what came before the steer, played.
        await Bun.sleep(50);
        expect(await r.conn.steer(ref, { text: "Also, end your final reply with the word banana.", images: [] })).toBe(true);
        expect(r.rec.sent.find((m) => m.method === "_x.ai/interject")?.params).toEqual({ sessionId: "<session-1>", text: "Also, end your final reply with the word banana." });
        await until(() => Boolean(r.ended()));
        expect(r.ended()).toMatchObject({ ref, reason: "done" });
        expect(r.rec.sent.filter((m) => m.method === "session/prompt")).toHaveLength(1);
        expect(texts(r.agentEvents())).toMatch(/banana$/);
        expect(r.usage).toHaveLength(1);
        expect(r.usage[0]!.u).toMatchObject({ inputTokens: 66564 - 51200, outputTokens: 294 });
    });

    test("one sent as its answer is being written joins it; one with an image isn't sent", async () => {
        const r = await replay("grok-1.0.70-steer-late", "grok", "grok-4.7");
        const { ref } = await r.conn.prompt({ text: "Reply with the single word: alpha", images: [] });
        await until(() => r.agentEvents().some((e) => e.type === "text"));
        expect(await r.conn.steer(ref, { text: "x", images: [RED] })).toBe(false);
        expect(await r.conn.steer(ref, { text: "Also, end your final reply with the word banana.", images: [] })).toBe(true);
        await until(() => Boolean(r.ended()));
        expect(r.ended()!.reason).toBe("done");
        expect(texts(r.agentEvents())).toMatch(/alpha\s*banana/);
        expect(r.rec.sent.filter((m) => m.method === "_x.ai/interject")).toHaveLength(1);
    });

    test("Esc after an interjection: aborted; it isn't run after", async () => {
        const r = await replay("grok-1.0.70-steer-cancel", "grok", "grok-4.7");
        const { ref } = await r.conn.prompt({ text: "Run the shell command `sleep 2` three times", images: [] });
        await Bun.sleep(50);
        expect(await r.conn.steer(ref, { text: "Also, end your final reply with the word banana.", images: [] })).toBe(true);
        await r.conn.interrupt(ref);
        await until(() => Boolean(r.ended()));
        expect(r.ended()!.reason).toBe("aborted");
        expect(r.conn.steer(ref, { text: "late", images: [] })).resolves.toBe(false);
    });
});

/** A turn sink with a queue of messages to steer with, as the Agent's: taken (and recorded) when drained. */
function queueSink(events: AgentEvent[], o: { holdMs?: number; liveAfterHold?: boolean } = {}) {
    const queue: SteerMessage[] = [];
    const listeners = new Set<() => void>();
    const taken: string[] = [];
    const undelivered: SteerMessage[] = [];
    const sink: TurnSink = {
        emit: (e) => events.push(e),
        onQueued: (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        // Hooks run first (holdMs), then whether the turn still takes them; `liveAfterHold: false`: checked first.
        drainQueued: async (_progress, live) => {
            if (!queue.length) return [];
            if (o.liveAfterHold === false && live && !live()) return [];
            if (o.liveAfterHold === false && queue.length) {
                const out = queue.splice(0);
                taken.push(...out.map((m) => m.text));
                if (o.holdMs) await Bun.sleep(o.holdMs);
                return out;
            }
            if (o.holdMs) await Bun.sleep(o.holdMs);
            if (live && !live()) return [];
            const out = queue.splice(0);
            taken.push(...out.map((m) => m.text));
            return out;
        },
        undelivered: (m) => undelivered.push(...m),
    };
    const send = (m: Partial<SteerMessage> & { text: string }) => {
        queue.push({ images: [], documents: [], ...m });
        for (const l of [...listeners]) l();
    };
    return { sink, queue, taken, undelivered, send, listening: () => listeners.size > 0 };
}

for (const cli of ["opencode", "grok"] as const) {
    describe(`the backend against a fake ${cli}`, () => {
        let cwd: string;
        let backend: InstanceType<typeof AcpBackend>;
        beforeEach(() => {
            cwd = realpathSync(tempDir("acp-steer-proj-"));
            rmSync(LOG, { force: true });
            process.env.FAKE_LOG = LOG;
            delete process.env.FAKE_ACP_STEP_MS;
            // Where the fake Grok keeps its record of each session, as Grok's own (its updates.jsonl).
            process.env.GROK_HOME = tempDir("acp-steer-grok-home-");
            registry.saveAgentConfig(cli, { path: join(bin, cli) });
            forgetClient(cli);
            backend = new AcpBackend(registry.getProvider(cli)!);
        });
        afterEach(async () => {
            await backend.shutdown();
            delete process.env.GROK_HOME;
            for (const k of ["FAKE_GROK_STEPS_DROP", "FAKE_GROK_CANCEL_TAKES", "FAKE_GROK_RECORD_MS", "FAKE_GROK_NO_MARKER", "FAKE_GROK_ANSWER_MS", "FAKE_GROK_EXIT_AFTER_CANCEL_MS"]) delete process.env[k];
        });

        function turn(prompt: string, o: { holdMs?: number; liveAfterHold?: boolean; signal?: AbortSignal } = {}) {
            const events: AgentEvent[] = [];
            const { h, usage } = host();
            const q = queueSink(events, o);
            const run = backend.runTurn({
                prompt,
                images: [],
                cwd,
                model: backendModel(cli, cli === "grok" ? "grok-4.7" : "opencode/big-pickle"),
                mode: "default",
                additionalDirectories: [],
                trusted: false,
                rules: { deny: [], ask: [], root: cwd },
                signal: o.signal ?? new AbortController().signal,
                sessionKey: "s1",
                session: h,
                sink: q.sink,
            });
            return { run, events, usage, ...q };
        }
        const started = (events: AgentEvent[]) => () => events.some((e) => e.type === "tool_start");
        /** How the steer reached it: a second session/prompt (OpenCode), or _x.ai/interject (Grok). */
        const steersSent = () => (cli === "grok" ? received().filter((m) => m.method === "_x.ai/interject").map((m) => m.params.text) : sentPrompts().slice(1).map((m) => m.params.prompt[0].text));

        test("a steer goes the moment it's queued, joins the running turn at its next step; one turn, the tokens once", async () => {
            const a = turn("[[steps:4]]");
            await until(started(a.events));
            a.send({ text: "banana" });
            // Taken from the queue at once (recorded as the transcript's), not at the turn's end.
            await until(() => a.taken.length === 1 && steersSent().length === 1, 1000);
            expect(a.queue).toEqual([]);
            const r = await a.run;
            expect(r).toMatchObject({ reason: "done" });
            expect(r.text).toContain("(also: banana)");
            expect(steersSent()).toEqual(["banana"]);
            expect(sentPrompts()).toHaveLength(cli === "grok" ? 1 : 2);
            if (cli === "opencode") expect(logLines().filter((l) => l.folded !== undefined)).toHaveLength(1);
            expect(a.usage).toHaveLength(1);
            // Folded into its prompt (OpenCode's answer both alike): counted once.
            expect(a.usage[0]!.u).toMatchObject({ inputTokens: cli === "grok" ? 400 : 100 });
            expect(a.undelivered).toEqual([]);
            expect(a.listening()).toBe(false);
        });

        test("one with attachments goes where the agent takes them, and is the queue's until it has", async () => {
            const a = turn("[[steps:4]]");
            await until(started(a.events));
            const settled: boolean[] = [];
            a.send({ text: "look", images: [RED], settle: async (sent) => void settled.push(sent) });
            await until(() => settled.length === 1);
            const r = await a.run;
            expect(r.reason).toBe("done");
            if (cli === "opencode") {
                expect(settled).toEqual([true]);
                expect(sentPrompts()[1].params.prompt.map((b: any) => b.type)).toEqual(["text", "image"]);
            } else {
                // Grok's interjection takes text only: it stays queued, whole, for its own turn.
                expect(settled).toEqual([false]);
                expect(steersSent()).toEqual([]);
            }
        });

        test("one queued once the turn has ended stays queued for the next turn", async () => {
            const a = turn("hi");
            await a.run;
            a.send({ text: "next" });
            await Bun.sleep(50);
            expect(a.queue.map((m) => m.text)).toEqual(["next"]);
            expect(steersSent()).toEqual([]);
            expect(a.taken).toEqual([]);
        });

        test("one whose hooks are still running as the turn ends isn't taken: it stays queued, never sent", async () => {
            process.env.FAKE_ACP_STEP_MS = "100";
            const a = turn("[[steps:1]]", { holdMs: 300 });
            await until(started(a.events));
            a.send({ text: "late" });
            const r = await a.run;
            expect(r.reason).toBe("done");
            expect(a.queue.map((m) => m.text)).toEqual(["late"]);
            expect(a.taken).toEqual([]);
            expect(steersSent()).toEqual([]);
            expect(a.undelivered).toEqual([]);
        });

        test("one taken just as the turn's prompt answers goes as a prompt of its own, in the same turn", async () => {
            process.env.FAKE_ACP_STEP_MS = "100";
            const a = turn("[[steps:1]]", { holdMs: 300, liveAfterHold: false });
            await until(started(a.events));
            a.send({ text: "late" });
            const r = await a.run;
            expect(r.reason).toBe("done");
            expect(a.taken).toEqual(["late"]);
            expect(sentPrompts().map((m) => m.params.prompt[0].text)).toEqual(["[[steps:1]]", "late"]);
            // Its words are this turn's.
            expect(texts(a.events)).toContain("Hello there");
            // Run apart from the first, it counts too, though its tokens are the same.
            expect(a.usage[0]!.u).toMatchObject(cli === "grok" ? { inputTokens: 800, outputTokens: 28 } : { inputTokens: 200, outputTokens: 14 });
            expect(a.undelivered).toEqual([]);
            expect(a.queue).toEqual([]);
        });

        test("Esc with a steer still being taken: it isn't sent; one taken goes with the next turn, one with attachments stays queued", async () => {
            const stop = new AbortController();
            const a = turn("[[steps:20]]", { holdMs: 200, liveAfterHold: false, signal: stop.signal });
            await until(started(a.events));
            const settled: boolean[] = [];
            a.send({ text: "taken" });
            await until(() => a.taken.length === 1);
            stop.abort();
            const r = await a.run;
            expect(r.reason).toBe("aborted");
            expect(steersSent()).toEqual([]);
            expect(a.undelivered.map((m) => m.text)).toEqual(["taken"]);
            // With attachments: the queue's, kept.
            const stop2 = new AbortController();
            const b = turn("[[steps:20]]", { holdMs: 200, liveAfterHold: false, signal: stop2.signal });
            await until(started(b.events));
            b.send({ text: "with a file", settle: async (sent) => void settled.push(sent) });
            await until(() => b.taken.length === 1);
            stop2.abort();
            expect((await b.run).reason).toBe("aborted");
            expect(settled).toEqual([false]);
            expect(b.undelivered).toEqual([]);
        });

        test("Esc after a steer went: aborted once; nothing runs after it", async () => {
            const stop = new AbortController();
            const a = turn("[[steps:20]]", { signal: stop.signal });
            await until(started(a.events));
            a.send({ text: "banana" });
            await until(() => steersSent().length === 1);
            stop.abort();
            const r = await a.run;
            expect(r.reason).toBe("aborted");
            await Bun.sleep(100);
            expect(texts(a.events)).not.toContain("banana");
            expect(texts(a.events)).not.toContain("Fallback");
        });

        if (cli === "grok")
            test("an interjection that comes as its prompt ends runs as Grok's own prompt: the turn waits for it, and counts its tokens", async () => {
                const a = turn("[[requeue]]");
                await until(() => sentPrompts().length === 1);
                await Bun.sleep(50);
                a.send({ text: "banana" });
                const r = await a.run;
                expect(r.reason).toBe("done");
                expect(texts(a.events)).toContain("Fallback: banana");
                expect(a.usage).toHaveLength(1);
                // Its prompt's (400 input, 14 output) and the one it ran of its own (50, 5).
                expect(a.usage[0]!.u).toMatchObject({ inputTokens: 450, outputTokens: 19 });
                // The next turn is a turn of its own: nothing of that one in it.
                const b = turn("hi");
                expect((await b.run).text).toBe("Hello there");
            });

        // Grok says nothing live when it takes an interjection, and a stop drops one it hadn't (grok-1.0.70-steer-taken.jsonl).
        if (cli === "grok")
            test("Esc before Grok took an interjection: it goes with the next turn, once", async () => {
                process.env.FAKE_ACP_STEP_MS = "2000";
                const stop = new AbortController();
                const a = turn("[[steps:3]]", { signal: stop.signal });
                await until(started(a.events));
                // Marked as the agent marks a drained message: the same one comes back, not a copy of its words.
                a.send({ text: "hello", id: 7 } as any);
                await until(() => steersSent().length === 1);
                await Bun.sleep(50);
                stop.abort();
                const r = await a.run;
                expect(r.reason).toBe("aborted");
                expect(a.taken).toEqual(["hello"]);
                expect(a.undelivered.map((m) => m.text)).toEqual(["hello"]);
                expect((a.undelivered[0] as any).id).toBe(7);
                expect(steersSent()).toEqual(["hello"]);
            });

        if (cli === "grok")
            test("Esc after Grok took one: only the one it hadn't taken yet goes with the next turn, though their words are the same", async () => {
                process.env.FAKE_ACP_STEP_MS = "400";
                const stop = new AbortController();
                const a = turn("[[steps:20]]", { signal: stop.signal });
                await until(started(a.events));
                const tools = () => a.events.filter((e) => e.type === "tool_start").length;
                a.send({ text: "again" });
                await until(() => steersSent().length === 1);
                // Its next step has begun (it thinks first): it has the first.
                const at = tools();
                await until(() => tools() > at);
                a.send({ text: "again" });
                await until(() => steersSent().length === 2);
                await Bun.sleep(50);
                stop.abort();
                const r = await a.run;
                expect(r.reason).toBe("aborted");
                expect(a.taken).toEqual(["again", "again"]);
                expect(a.undelivered.map((m) => m.text)).toEqual(["again"]);
            });

        // What Grok took, its own record says (its updates.jsonl): read once it says the stopped prompt ended.
        const thought = (events: AgentEvent[], text: string) => () => events.some((e) => e.type === "thinking" && e.text === text);
        const tools = (events: AgentEvent[]) => events.filter((e) => e.type === "tool_start").length;
        const recordFile = () => {
            const root = join(process.env.GROK_HOME!, "sessions");
            const dir = readdirSync(root)[0]!;
            return join(root, dir, readdirSync(join(root, dir))[0]!, "updates.jsonl");
        };
        /** Esc once Grok took "hello" into another model call, with no tool between: what's handed back. */
        async function takenLate(before?: () => void) {
            const stop = new AbortController();
            const a = turn("[[take-late]]", { signal: stop.signal });
            await until(() => texts(a.events).includes("alpha"));
            a.send({ text: "hello" });
            await until(thought(a.events, "and then"));
            before?.();
            const t0 = Date.now();
            stop.abort();
            const r = await a.run;
            expect(r.reason).toBe("aborted");
            expect(a.taken).toEqual(["hello"]);
            return { a, ms: Date.now() - t0 };
        }

        if (cli === "grok")
            test("Esc after Grok took an interjection into another model call, no tool between: its record says so, it isn't handed back", async () => {
                expect((await takenLate()).a.undelivered).toEqual([]);
            });

        if (cli === "grok")
            test("Esc after Grok dropped one, though a tool ended and it spoke since: its record has no line, it's handed back once", async () => {
                process.env.FAKE_GROK_STEPS_DROP = "1";
                process.env.FAKE_ACP_STEP_MS = "400";
                const stop = new AbortController();
                const a = turn("[[steps:20]]", { signal: stop.signal });
                await until(started(a.events));
                a.send({ text: "hello" });
                await until(() => steersSent().length === 1);
                const at = tools(a.events);
                await until(() => tools(a.events) > at);
                stop.abort();
                expect((await a.run).reason).toBe("aborted");
                expect(a.undelivered.map((m) => m.text)).toEqual(["hello"]);
            });

        if (cli === "grok")
            test("one Grok took as it stopped, its line written after its answer but before the prompt's end: not handed back", async () => {
                process.env.FAKE_GROK_CANCEL_TAKES = "1";
                process.env.FAKE_GROK_RECORD_MS = "300";
                process.env.FAKE_ACP_STEP_MS = "2000";
                const stop = new AbortController();
                const a = turn("[[steps:3]]", { signal: stop.signal });
                await until(started(a.events));
                a.send({ text: "hello" });
                await until(() => steersSent().length === 1);
                await Bun.sleep(50);
                stop.abort();
                expect((await a.run).reason).toBe("aborted");
                expect(a.undelivered).toEqual([]);
            });

        for (const broken of ["garbled", "gone", "never says the prompt ended"] as const)
            if (cli === "grok")
                test(`its record ${broken}: what it took is guessed, as before`, async () => {
                    if (broken === "never says the prompt ended") process.env.FAKE_GROK_NO_MARKER = "1";
                    const { a, ms } = await takenLate(() => {
                        if (broken === "garbled") appendFileSync(recordFile(), "not json\n");
                        // Cavvy looks for it elsewhere from now on.
                        if (broken === "gone") process.env.GROK_HOME = tempDir("acp-steer-grok-empty-");
                    });
                    // No tool ended since it went: guessed not taken.
                    expect(a.undelivered.map((m) => m.text)).toEqual(["hello"]);
                    // Waited (a second at most) for it to say so.
                    if (broken === "never says the prompt ended") expect(ms).toBeGreaterThanOrEqual(900);
                });

        if (cli === "grok")
            test("Esc, its answer past the deadline, its record saying the prompt ended: the one it took isn't handed back, then or later", async () => {
                process.env.FAKE_GROK_ANSWER_MS = "800";
                await backend.shutdown();
                backend = new AcpBackend(registry.getProvider(cli)!, { interruptMs: 300 });
                const { a } = await takenLate();
                expect(a.undelivered).toEqual([]);
                await Bun.sleep(1000);
                expect(a.undelivered).toEqual([]);
            });

        if (cli === "grok")
            test("Grok answers Esc, then exits while its record is awaited: the one it dropped is handed back, once", async () => {
                process.env.FAKE_GROK_NO_MARKER = "1";
                process.env.FAKE_GROK_EXIT_AFTER_CANCEL_MS = "100";
                process.env.FAKE_ACP_STEP_MS = "2000";
                const stop = new AbortController();
                const a = turn("[[steps:3]]", { signal: stop.signal });
                await until(started(a.events));
                a.send({ text: "hello" });
                await until(() => steersSent().length === 1);
                await Bun.sleep(50);
                stop.abort();
                await a.run;
                await Bun.sleep(1200);
                expect(a.undelivered.map((m) => m.text)).toEqual(["hello"]);
            });

        if (cli === "grok")
            test("the same words twice, the first taken, the second dropped: handed back once", async () => {
                const stop = new AbortController();
                const a = turn("[[take-late]]", { signal: stop.signal });
                await until(() => texts(a.events).includes("alpha"));
                a.send({ text: "again" });
                await until(thought(a.events, "and then"));
                a.send({ text: "again" });
                await until(() => steersSent().length === 2);
                await Bun.sleep(50);
                stop.abort();
                expect((await a.run).reason).toBe("aborted");
                expect(a.taken).toEqual(["again", "again"]);
                expect(a.undelivered.map((m) => m.text)).toEqual(["again"]);
            });

        if (cli === "grok")
            test("one taken in an earlier turn, the same words dropped in this one: handed back", async () => {
                process.env.FAKE_GROK_STEPS_DROP = "1";
                process.env.FAKE_ACP_STEP_MS = "400";
                const a = turn("[[take-late:100]]");
                await until(() => texts(a.events).includes("alpha"));
                a.send({ text: "hello" });
                expect((await a.run).reason).toBe("done");
                expect(a.undelivered).toEqual([]);
                const stop = new AbortController();
                const b = turn("[[steps:20]]", { signal: stop.signal });
                await until(started(b.events));
                b.send({ text: "hello" });
                await until(() => steersSent().length === 2);
                const at = tools(b.events);
                await until(() => tools(b.events) > at);
                stop.abort();
                expect((await b.run).reason).toBe("aborted");
                expect(b.undelivered.map((m) => m.text)).toEqual(["hello"]);
            });

        // Its cancelled answer comes after the stop's deadline: the turn is ended here first, its steering gone with it.
        for (const late of ["the cancel's answer", "the interjection's answer too"])
            if (cli === "grok")
                test(`Esc before Grok took an interjection, ${late} past the deadline: it goes with the next turn, once`, async () => {
                    process.env.FAKE_ACP_STEP_MS = "1500";
                    process.env.FAKE_ACP_IGNORE_CANCEL = "1";
                    if (late !== "the cancel's answer") process.env.FAKE_GROK_INTERJECT_MS = "800";
                    try {
                        await backend.shutdown();
                        backend = new AcpBackend(registry.getProvider(cli)!, { interruptMs: 300 });
                        const stop = new AbortController();
                        const a = turn("[[steps:1]]", { signal: stop.signal });
                        await until(started(a.events));
                        a.send({ text: "hello" });
                        await until(() => steersSent().length === 1);
                        await Bun.sleep(50);
                        stop.abort();
                        const r = await a.run;
                        expect(r.reason).toBe("aborted");
                        expect(a.undelivered.map((m) => m.text)).toEqual(["hello"]);
                        // Its answers, come late, hand it back no more.
                        await Bun.sleep(1800);
                        expect(a.undelivered.map((m) => m.text)).toEqual(["hello"]);
                    } finally {
                        delete process.env.FAKE_ACP_IGNORE_CANCEL;
                        delete process.env.FAKE_GROK_INTERJECT_MS;
                    }
                });

        if (cli === "grok")
            test("an interjection Grok answers only after the turn's prompt answered, past the watch: the turn waits for its answer, then for the prompt it runs of its own", async () => {
                process.env.FAKE_GROK_INTERJECT_MS = "800";
                try {
                    const a = turn("[[steps:2]]");
                    await until(started(a.events));
                    a.send({ text: "banana" });
                    const r = await a.run;
                    expect(r.reason).toBe("done");
                    expect(texts(a.events)).toContain("Fallback: banana");
                    expect(a.usage[0]!.u).toMatchObject({ inputTokens: 450, outputTokens: 19 });
                    const b = turn("hi");
                    expect((await b.run).text).toBe("Hello there");
                    expect(texts(b.events)).not.toContain("Fallback");
                } finally {
                    delete process.env.FAKE_GROK_INTERJECT_MS;
                }
            });
    });
}
