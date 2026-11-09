// The live CLI layer (src/backends/live) against a fake CLI that stays up across
// prompts (test/fixtures/fake-live-cli.ts). Timers run on a clock moved by hand;
// only the processes run in real time.

import { afterEach, expect, test } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import type { AgentEvent } from "../src/agent/agent";
import { JsonLinesProcess } from "../src/backends/cli";
import { agentCli, type AgentCliDef } from "../src/backends/defs";
import { LiveCliPool, type PoolOptions } from "../src/backends/live/pool";
import { EXIT_DRAIN_MS, LiveCliSession, spawnFingerprint } from "../src/backends/live/session";
import { BackgroundTasks } from "../src/backends/live/tasks";
import type { AgentCliAdapter, CliConnection, CliEvent, CliEventSink, LiveClock, LiveSettings, SessionHost, SpawnConfig, SpawnSpec, TurnInput } from "../src/backends/live/types";
import { backendModel } from "../src/backends/types";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-live-cli.ts");
const DEF: AgentCliDef = { ...agentCli("claude-code")!, id: "fake", name: "Fake CLI", account: undefined };
const model = backendModel("fake", "m");

/** Timers that fire only when the test moves time on. */
class ManualClock implements LiveClock {
    private t = 0;
    private next = 1;
    private timers = new Map<number, { at: number; fn: () => void }>();
    now() {
        return this.t;
    }
    setTimeout(fn: () => void, ms: number) {
        const id = this.next++;
        this.timers.set(id, { at: this.t + ms, fn });
        return id;
    }
    clearTimeout(h: unknown) {
        this.timers.delete(h as number);
    }
    advance(ms: number) {
        const end = this.t + ms;
        for (;;) {
            const due = [...this.timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            this.timers.delete(due[0]);
            this.t = Math.max(this.t, due[1].at);
            due[1].fn();
        }
        this.t = end;
    }
}

class FakeConnection implements CliConnection {
    caps = DEF.caps;
    done: Promise<void>;
    opens: { resumeId?: string; fork?: boolean }[] = [];
    /** The model its last settings change took. */
    model?: string;
    private opened?: (id: string) => void;
    private n = 0;

    constructor(
        readonly proc: JsonLinesProcess,
        private events: CliEventSink,
        private adapter: FakeAdapter,
    ) {
        this.done = this.read();
    }

    private async read() {
        for await (const m of this.proc.messages({ quietAfterExitMs: EXIT_DRAIN_MS })) {
            if (m.type === "opened") this.opened?.(m.session);
            else if (m.type === "started") this.events({ t: "turn_started", ref: m.id, origin: m.origin ?? "user" });
            else if (m.type === "text") this.events({ t: "turn_event", ref: m.id, event: { type: "text", text: m.text } });
            else if (m.type === "ended") this.events({ t: "turn_ended", ref: m.id, reason: m.reason });
            else if (m.type === "task") this.events({ t: "task", task: { id: m.id, provider: "fake", kind: "shell", label: m.id, startedAt: 0, status: m.status, stoppable: true }, wakeDue: m.report });
        }
    }

    send(o: Record<string, unknown>) {
        this.proc.send(o);
    }
    /** As if the connection read this from the CLI. */
    inject(e: CliEvent) {
        this.events(e);
    }
    async open(o: { resumeId?: string; fork?: boolean }) {
        await this.adapter.hold.open;
        this.opens.push({ resumeId: o.resumeId, fork: o.fork });
        const opened = new Promise<string>((resolve) => (this.opened = resolve));
        this.send({ type: "open", resume: o.resumeId });
        return { sessionId: await opened };
    }
    async prompt(input: TurnInput) {
        await this.adapter.hold.prompt;
        const ref = `p${++this.n}`;
        this.send({ type: "prompt", id: ref, text: input.text });
        return { ref };
    }
    async interrupt(ref: string) {
        this.send({ type: "interrupt", id: ref });
    }
    async stopTask(id: string) {
        // Held: the CLI hasn't answered yet (and refuses it if the hold rejects).
        await this.adapter.hold.stop;
        this.send({ type: "stop_task", id });
    }
    async apply(s: Partial<LiveSettings>) {
        this.adapter.applies++;
        const held = await this.adapter.hold.apply;
        if (held === "restart") return held;
        if (s.model) this.model = s.model.id;
        return held ?? (s.model?.id === "needs-restart" ? ("restart" as const) : ("applied" as const));
    }
    async close() {
        await this.adapter.hold.close;
        this.proc.end();
    }
}

class FakeAdapter implements AgentCliAdapter {
    readonly def = DEF;
    connections: FakeConnection[] = [];
    bin = process.execPath;
    /** Calls that wait for these first (a CLI slow to answer them); apply's settles with its answer. */
    hold: { open?: Promise<unknown>; prompt?: Promise<unknown>; apply?: Promise<"applied" | "restart">; close?: Promise<unknown>; stop?: Promise<unknown> } = {};
    applies = 0;
    spawn(cfg: SpawnConfig): SpawnSpec {
        return { bin: this.bin, args: [FIXTURE], cwd: cfg.cwd, fingerprint: spawnFingerprint({ system: cfg.appendSystemPrompt }) };
    }
    async connect(proc: JsonLinesProcess, events: CliEventSink) {
        const c = new FakeConnection(proc, events, this);
        this.connections.push(c);
        return c;
    }
    async status(): Promise<never> {
        throw new Error("not used");
    }
    async listModels() {
        return [];
    }
    /** The connection of a session's running process. */
    of(s: LiveCliSession): FakeConnection {
        const c = this.connections.find((c) => c.proc.pid === s.pid);
        if (!c) throw new Error("no process");
        return c;
    }
}

const sessionIds: string[] = [];
const host: SessionHost = {
    permission: async () => ({ allow: false, message: "no", stop: false }),
    askQuestions: async () => undefined,
    approvePlan: async () => ({ approved: false }),
    setMode() {},
    usage() {},
    sessionId: (id) => void sessionIds.push(id),
};

const pools: LiveCliPool[] = [];
afterEach(async () => {
    await Promise.all(pools.splice(0).map((p) => p.shutdownAll()));
});

function setup(o: PoolOptions = {}) {
    const clock = new ManualClock();
    const fake = new FakeAdapter();
    const pool = new LiveCliPool(() => fake, { clock, idleMs: 1000, interruptMs: 500, stopConfirmMs: 300, stopGraceMs: 2000, keepRecentMs: 0, memoryShort: () => false, ...o });
    pools.push(pool);
    return { clock, fake, pool };
}

function sink() {
    const texts: string[] = [];
    return { texts, emit: (e: AgentEvent) => void (e.type === "text" && texts.push(e.text)) };
}

async function turn(s: LiveCliSession, text: string, o: { system?: string; model?: string; signal?: AbortSignal; sink?: ReturnType<typeof sink> } = {}) {
    const k = o.sink ?? sink();
    const spawn: SpawnConfig = { cwd: tmpdir(), model, mode: "default", additionalDirectories: [], trusted: true, rules: { deny: [], ask: [], root: tmpdir() }, appendSystemPrompt: o.system };
    const settings: LiveSettings = { model: o.model ? backendModel("fake", o.model) : model, mode: "default" };
    const r = await s.runTurn({ text, images: [] }, k, o.signal ?? new AbortController().signal, { spawn, settings, host });
    return { ...r, texts: k.texts, pid: pidOf(k.texts[0] ?? "") };
}

const pidOf = (text: string) => Number(/pid (\d+)/.exec(text)?.[1]);

async function until(cond: () => boolean, step?: () => void) {
    const end = Date.now() + 5000;
    while (!cond()) {
        if (Date.now() > end) throw new Error("timed out");
        step?.();
        await Bun.sleep(5);
    }
}

function alive(pid: number | undefined): boolean {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

test("nothing starts until the first turn, then one process serves every turn", async () => {
    const { fake, pool } = setup();
    const s = pool.session("a", "fake");
    expect(s.state).toBe("dead");
    expect(fake.connections).toHaveLength(0);
    const one = await turn(s, "one");
    const two = await turn(s, "two");
    expect(one.reason).toBe("done");
    expect(one.texts).toEqual([`echo one (pid ${s.pid})`]);
    expect(two.texts).toEqual([`echo two (pid ${s.pid})`]);
    expect(two.pid).toBe(one.pid);
    expect(fake.connections).toHaveLength(1);
    expect(s.state).toBe("idle");
    expect(s.sessionId).toBe(`s-${one.pid}`);
    expect(pool.session("a", "fake")).toBe(s);
    expect(pool.session("b", "fake")).not.toBe(s);
});

test("an idle process is reaped after idleMs, and the next turn resumes its session in a new one", async () => {
    const { clock, fake, pool } = setup();
    const s = pool.session("a", "fake");
    const first = await turn(s, "one");
    clock.advance(999);
    expect(s.state).toBe("idle");
    clock.advance(1);
    await until(() => s.state === "dead");
    await until(() => !alive(first.pid));
    const second = await turn(s, "two");
    expect(second.pid).not.toBe(first.pid);
    expect(fake.connections[1]!.opens).toEqual([{ resumeId: `s-${first.pid}`, fork: false }]);
});

test("past maxIdle idle processes, the least recently used go; background work pins one and doesn't count", async () => {
    const { clock, fake, pool } = setup({ maxIdle: 2 });
    const [a, b, c, d] = ["a", "b", "c", "d"].map((k) => pool.session(k, "fake")) as [LiveCliSession, LiveCliSession, LiveCliSession, LiveCliSession];
    await turn(d, "bg t1");
    for (const s of [a, b, c]) {
        clock.advance(10);
        await turn(s, "hi");
    }
    await until(() => a.state === "dead");
    expect([b.state, c.state, d.state]).toEqual(["idle", "idle", "idle"]);

    // Long past idleMs: the idle ones go, the one with a task stays.
    clock.advance(60_000);
    await until(() => b.state === "dead" && c.state === "dead");
    expect(d.state).toBe("idle");
    expect(d.tasks.running().map((t) => t.id)).toEqual(["t1"]);

    // Once its task is done (and its report turn over), it's reaped like any other.
    fake.of(d).send({ type: "finish", task: "t1" });
    await until(() => d.quiet());
    clock.advance(1000);
    await until(() => d.state === "dead");
});

test("past maxIdle, a process is stopped only once it's been idle a while: sessions in use aren't restarted between turns", async () => {
    const { clock, pool } = setup({ maxIdle: 1, keepRecentMs: 60_000, idleMs: 10 * 60_000 });
    const [a, b, c] = ["a", "b", "c"].map((k) => pool.session(k, "fake")) as [LiveCliSession, LiveCliSession, LiveCliSession];
    for (const s of [a, b, c]) {
        clock.advance(10_000);
        await turn(s, "hi");
    }
    // Three idle, one allowed: none has been idle a minute, so all stay.
    clock.advance(30_000);
    expect([a.state, b.state, c.state]).toEqual(["idle", "idle", "idle"]);
    // A minute after its turn, the oldest goes; then the next; the last is the one kept.
    clock.advance(15_000);
    await until(() => a.state === "dead");
    expect([b.state, c.state]).toEqual(["idle", "idle"]);
    clock.advance(10_000);
    await until(() => b.state === "dead");
    clock.advance(60_000);
    expect(c.state).toBe("idle");
});

test("past maxIdle, with the machine short of memory, the cap doesn't wait", async () => {
    const { clock, pool } = setup({ maxIdle: 1, keepRecentMs: 60_000, idleMs: 10 * 60_000, memoryShort: () => true });
    const [a, b] = ["a", "b"].map((k) => pool.session(k, "fake")) as [LiveCliSession, LiveCliSession];
    await turn(a, "hi");
    clock.advance(10);
    await turn(b, "hi");
    await until(() => a.state === "dead");
    expect(b.state).toBe("idle");
});

test("new spawn settings restart an idle process, and wait while background work runs", async () => {
    const { fake, pool } = setup();
    const s = pool.session("a", "fake");
    const one = await turn(s, "one", { system: "v1" });
    const two = await turn(s, "two", { system: "v2" });
    expect(two.pid).not.toBe(one.pid);
    expect(two.deferred).toBeUndefined();
    expect(fake.connections[1]!.opens[0]!.resumeId).toBe(`s-${one.pid}`);

    await turn(s, "bg t1", { system: "v2" });
    const three = await turn(s, "three", { system: "v3" });
    expect(three.pid).toBe(two.pid);
    expect(three.deferred).toEqual({ tasks: 1 });
    expect(s.staleConfig).toBe(true);
    expect(s.tasks.get("t1")?.status).toBe("running");

    fake.of(s).send({ type: "finish", task: "t1" });
    await until(() => s.quiet());
    const four = await turn(s, "four", { system: "v3" });
    expect(four.pid).not.toBe(two.pid);
    expect(four.deferred).toBeUndefined();
    expect(s.staleConfig).toBe(false);
});

test("a setting the process can't take live restarts it when nothing runs in the background", async () => {
    const { pool } = setup();
    const s = pool.session("a", "fake");
    const one = await turn(s, "one");
    const same = await turn(s, "two", { model: "other" });
    expect(same.pid).toBe(one.pid);
    const restarted = await turn(s, "three", { model: "needs-restart" });
    expect(restarted.pid).not.toBe(one.pid);
});

test("a crash ends the turn with the CLI's error, marks its tasks stopped with the process, and the next turn resumes", async () => {
    const { pool } = setup();
    const s = pool.session("a", "fake");
    const one = await turn(s, "bg t1");
    const crash = await turn(s, "crash");
    expect(crash.reason).toBe("error");
    expect(crash.error).toBe("Fake CLI stopped: fatal: boom");
    expect(s.state).toBe("dead");
    expect(s.error).toBe("Fake CLI stopped: fatal: boom");
    expect(s.tasks.get("t1")).toMatchObject({ status: "stopped", withProcess: true });
    expect(s.quiet()).toBe(true);
    const again = await turn(s, "again");
    expect(again.reason).toBe("done");
    expect(again.pid).not.toBe(one.pid);
    expect(s.error).toBeUndefined();
});

test("whenQuiet waits for background tasks and the turns the CLI starts for them", async () => {
    const { fake, pool } = setup();
    const s = pool.session("a", "fake");
    const wakes: string[] = [];
    s.onWake((w) => wakes.push(`${w.origin}:${w.ref}`));
    await turn(s, "bg t1");
    let quiet: boolean | undefined;
    void s.whenQuiet().then((q) => (quiet = q));
    await Bun.sleep(20);
    expect(quiet).toBeUndefined();

    // The task ends; the CLI's report turn is still going, so it isn't quiet yet.
    fake.of(s).send({ type: "finish", task: "t1", hold: true });
    await until(() => wakes.length === 1);
    expect(wakes).toEqual(["wake:wake-t1"]);
    expect(s.tasks.get("t1")?.status).toBe("done");
    // Its text has come in, held until it's adopted.
    const held = () => (s as unknown as { wakes: Map<string, { held: unknown[] }> }).wakes.get("wake-t1")?.held.length;
    await until(() => held() === 1);
    expect(quiet).toBeUndefined();

    // Adopted, its events so far come first; interrupting it ends it, and then it's quiet.
    const k = sink();
    const stop = new AbortController();
    const adopted = s.adopt("wake-t1", k, stop.signal);
    expect(k.texts).toEqual(["t1 finished"]);
    stop.abort();
    expect((await adopted).reason).toBe("aborted");
    await until(() => quiet !== undefined);
    expect(quiet).toBe(true);

    // Aborting the wait ends it with false.
    await turn(s, "bg t2");
    const abort = new AbortController();
    const waiting = s.whenQuiet(abort.signal);
    abort.abort();
    expect(await waiting).toBe(false);
});

test("a wake that ended before anyone took it is still delivered whole", async () => {
    const { fake, pool } = setup();
    const s = pool.session("a", "fake");
    await turn(s, "bg t1");
    fake.of(s).send({ type: "finish", task: "t1" });
    await until(() => s.quiet() && s.tasks.get("t1")?.status === "done");
    const wakes: string[] = [];
    s.onWake((w) => wakes.push(w.ref));
    expect(wakes).toEqual(["wake-t1"]);
    const k = sink();
    const r = await s.adopt("wake-t1", k, new AbortController().signal);
    expect(r).toMatchObject({ ref: "wake-t1", reason: "done" });
    expect(k.texts).toEqual(["t1 finished"]);
});

test("interrupting a turn leaves the process and its background tasks running", async () => {
    const { clock, pool } = setup();
    const s = pool.session("a", "fake");
    const one = await turn(s, "bg t1");
    const esc = new AbortController();
    const hung = turn(s, "hang", { signal: esc.signal });
    await until(() => s.state === "busy");
    esc.abort();
    const r = await hung;
    expect(r.reason).toBe("aborted");
    expect(r.unanswered).toBeUndefined();
    expect(alive(one.pid)).toBe(true);
    expect(s.tasks.get("t1")?.status).toBe("running");
    expect((await turn(s, "after")).pid).toBe(one.pid);

    // A CLI that never answers the interrupt: the turn ends here after interruptMs, and the process stays.
    const esc2 = new AbortController();
    let done = false;
    const deaf = turn(s, "deaf", { signal: esc2.signal }).finally(() => (done = true));
    await until(() => s.state === "busy");
    esc2.abort();
    await until(() => done, () => clock.advance(100));
    expect(await deaf).toMatchObject({ reason: "aborted", unanswered: true });
    expect(s.unresponsive).toBe(true);
    expect(s.state).toBe("idle");
    expect((await turn(s, "still")).pid).toBe(one.pid);
    expect(s.tasks.get("t1")?.status).toBe("running");
});

test("stopping a task counts once the CLI confirms it, and times out when it doesn't", async () => {
    const { clock, pool } = setup();
    const s = pool.session("a", "fake");
    await turn(s, "bg t1");
    await turn(s, "bg stubborn1");
    expect(await s.stopTasks(["t1", "nope"])).toEqual({ t1: "stopped", nope: "unknown" });
    expect(s.tasks.get("t1")?.status).toBe("stopped");
    // Already over: the stop isn't what ended it.
    expect(await s.stopTasks(["t1"])).toEqual({ t1: "ended" });

    let result: unknown;
    void s.stopTasks().then((r) => (result = r));
    await Bun.sleep(20);
    expect(result).toBeUndefined();
    clock.advance(300);
    await until(() => result !== undefined);
    expect(result).toEqual({ stubborn1: "timeout" });
    expect(s.tasks.get("stubborn1")?.status).toBe("running");
});

test("an end of the task's own while its stop is asked: it ended by itself (ended), however the CLI answers; the process gone, its own end stands", async () => {
    const { pool, fake } = setup();
    const s = pool.session("a", "fake");
    await turn(s, "bg stubborn1");
    await turn(s, "bg stubborn2");
    await turn(s, "bg stubborn3");
    const conn = fake.connections[0]!;
    const ended = (id: string, status: "done" | "failed") => conn.inject({ t: "task", task: { ...s.tasks.get(id)!, status } });
    const asked = (id: string) => {
        let refuse!: (e: Error) => void;
        let take!: () => void;
        fake.hold.stop = new Promise<void>((resolve, reject) => ((take = resolve), (refuse = reject)));
        let result: unknown;
        void s.stopTasks([id]).then((r) => (result = r[id]));
        return { result: () => result, refuse, take };
    };

    // It finished as the stop went out (the CLI then refuses the stop): it ended by itself.
    const one = asked("stubborn1");
    await Bun.sleep(10);
    ended("stubborn1", "done");
    await until(() => one.result() !== undefined);
    one.refuse(new Error("no such task"));
    expect(one.result()).toBe("ended");
    expect(s.tasks.get("stubborn1")?.status).toBe("done");

    // The same, but the CLI answered the stop success: its own end says it ended by itself (a CLI's success
    // doesn't say the stop took; Claude Code answers so for a task it no longer runs, #295 review).
    const two = asked("stubborn2");
    await Bun.sleep(10);
    ended("stubborn2", "done");
    two.take();
    await until(() => two.result() !== undefined);
    expect(two.result()).toBe("ended");

    // No answer, then the process goes: the end it said stands (not taken for a stop).
    const three = asked("stubborn3");
    await Bun.sleep(10);
    ended("stubborn3", "failed");
    await s.restart();
    await until(() => three.result() !== undefined);
    expect(three.result()).toBe("ended");
    expect(s.tasks.get("stubborn3")?.status).toBe("failed");
});

test("release stops one Cavvy session's processes; shutdownAll stops them all, tasks and all", async () => {
    const { pool } = setup();
    const a = pool.session("a", "fake");
    const b = pool.session("b", "fake");
    const c = pool.session("c", "fake");
    const pa = (await turn(a, "one")).pid;
    const pb = (await turn(b, "bg t1")).pid;
    const pc = (await turn(c, "hi")).pid;

    await pool.release("a");
    expect(a.state).toBe("dead");
    expect(pool.get("a", "fake")).toBeUndefined();
    await until(() => !alive(pa));
    expect(alive(pb) && alive(pc)).toBe(true);
    await expect(turn(a, "again")).rejects.toThrow("closed");

    await pool.shutdownAll();
    expect([b.state, c.state]).toEqual(["dead", "dead"]);
    expect(pool.list()).toEqual([]);
    expect(b.tasks.get("t1")).toMatchObject({ status: "stopped", withProcess: true });
    await until(() => !alive(pb) && !alive(pc));
});

test("a task list's snapshot restores with its running tasks lost", () => {
    const clock = new ManualClock();
    const tasks = new BackgroundTasks(clock, 100);
    tasks.report({ id: "a", provider: "fake", kind: "agent", label: "Map auth", startedAt: 1, status: "running", stoppable: true });
    tasks.report({ id: "b", provider: "fake", kind: "shell", label: "npm test", startedAt: 2, status: "running", stoppable: false });
    clock.advance(5);
    tasks.end("b", "done");
    const snapshot = JSON.parse(JSON.stringify(tasks.snapshot()));
    expect(snapshot.map((t: any) => [t.id, t.status, t.endedAt])).toEqual([["a", "running", undefined], ["b", "done", 5]]);

    const reopened = new BackgroundTasks(clock, 100);
    reopened.restore(snapshot);
    expect(reopened.get("a")).toMatchObject({ status: "stopped", lost: true, endedAt: 5 });
    expect(reopened.get("b")).toMatchObject({ status: "done", endedAt: 5 });
    expect(reopened.running()).toEqual([]);
});

test("a task that can't be stopped on its own says so", async () => {
    const tasks = new BackgroundTasks(new ManualClock(), 100);
    tasks.report({ id: "b", provider: "fake", kind: "shell", label: "npm test", startedAt: 0, status: "running", stoppable: false });
    expect(await tasks.stop("b", async () => {})).toBe("not_stoppable");
    expect(await tasks.stop("missing", async () => {})).toBe("unknown");
});

test("a task id that runs again starts a new occurrence, without the last one's end", () => {
    const clock = new ManualClock();
    const tasks = new BackgroundTasks(clock, 100);
    const t = { id: "a", provider: "fake", kind: "shell", label: "npm test", startedAt: 1, status: "running", stoppable: true } as const;
    tasks.report(t);
    clock.advance(5);
    tasks.lose();
    expect(tasks.get("a")).toMatchObject({ status: "stopped", withProcess: true, endedAt: 5 });
    tasks.report({ ...t, startedAt: 7 });
    expect(tasks.get("a")).toEqual({ ...t, startedAt: 7 });
    tasks.report({ ...t, startedAt: 7, status: "done" });
    expect(tasks.get("a")).toEqual({ ...t, startedAt: 7, status: "done", endedAt: 5 });
});

test("a whenQuiet that ends lets go of its waiter and its abort listener", async () => {
    const { fake, pool } = setup();
    const s = pool.session("a", "fake");
    const waiters = () => (s as unknown as { quietWaiters: Set<unknown> }).quietWaiters.size;
    await turn(s, "bg t1");
    for (let i = 0; i < 3; i++) {
        const abort = new AbortController();
        const waiting = s.whenQuiet(abort.signal);
        abort.abort();
        expect(await waiting).toBe(false);
    }
    expect(waiters()).toBe(0);

    const abort = new AbortController();
    let listeners = 0;
    const add = abort.signal.addEventListener.bind(abort.signal);
    const remove = abort.signal.removeEventListener.bind(abort.signal);
    abort.signal.addEventListener = ((...a: Parameters<typeof add>) => (listeners++, add(...a))) as typeof add;
    abort.signal.removeEventListener = ((...a: Parameters<typeof remove>) => (listeners--, remove(...a))) as typeof remove;
    const waiting = s.whenQuiet(abort.signal);
    fake.of(s).send({ type: "finish", task: "t1" });
    expect(await waiting).toBe(true);
    expect(listeners).toBe(0);
    expect(waiters()).toBe(0);
});

test("a report turn that starts isn't reaped as it starts, even with no idle process allowed", async () => {
    const { fake, pool } = setup({ maxIdle: 0 });
    const s = pool.session("a", "fake");
    const wakes: string[] = [];
    s.onWake((w) => wakes.push(w.ref));
    await turn(s, "bg t1");
    expect(s.state).toBe("idle");
    fake.of(s).send({ type: "finish", task: "t1" });
    await until(() => wakes.length === 1);
    const k = sink();
    const adopted = s.adopt("wake-t1", k, new AbortController().signal);
    await until(() => s.quiet());
    expect(await adopted).toMatchObject({ ref: "wake-t1", reason: "done" });
    expect(k.texts).toEqual(["t1 finished"]);
    // Once it's over, the cap takes the process.
    await until(() => s.state === "dead");
});

test("a report the CLI said it will make holds new settings back like a running task", async () => {
    const { fake, pool } = setup();
    const s = pool.session("a", "fake");
    const one = await turn(s, "bg t1", { system: "v1" });
    fake.of(s).send({ type: "finish", task: "t1", later: true });
    await until(() => s.tasks.get("t1")?.status === "done");
    expect(s.quiet()).toBe(false);
    const respawn = await turn(s, "two", { system: "v2" });
    expect(respawn.pid).toBe(one.pid);
    expect(respawn.deferred).toEqual({ tasks: 1 });

    // The same for a setting the process can't take live (this turn takes v2: nothing's due now).
    const two = await turn(s, "bg t2", { system: "v2" });
    fake.of(s).send({ type: "finish", task: "t2", later: true });
    await until(() => s.tasks.get("t2")?.status === "done");
    const live = await turn(s, "three", { system: "v2", model: "needs-restart" });
    expect(live.pid).toBe(two.pid);
    expect(live.deferred).toEqual({ tasks: 1 });
});

test("a process whose interrupt went unanswered isn't reaped until the CLI ends that turn", async () => {
    const { clock, fake, pool } = setup({ maxIdle: 0 });
    const s = pool.session("a", "fake");
    const one = await turn(s, "one");
    await until(() => s.state === "dead");
    const esc = new AbortController();
    let done = false;
    const deaf = turn(s, "deaf", { signal: esc.signal }).finally(() => (done = true));
    await until(() => s.state === "busy");
    const pid = s.pid;
    expect(pid).not.toBe(one.pid);
    esc.abort();
    await until(() => done, () => clock.advance(100));
    expect(await deaf).toMatchObject({ reason: "aborted", unanswered: true });
    clock.advance(60_000);
    expect(s.state).toBe("idle");
    expect(s.unresponsive).toBe(true);
    expect(s.pid).toBe(pid);
    expect(alive(pid)).toBe(true);

    // The CLI ends it at last: now it's idle like any other, and the cap takes it.
    fake.of(s).send({ type: "end", id: "p1" });
    await until(() => !s.unresponsive);
    await until(() => s.state === "dead");
});

test("closing while a turn waits on its settings starts nothing after; a restart then starts afresh", async () => {
    const { fake, pool } = setup();
    const s = pool.session("a", "fake");
    const one = await turn(s, "one");
    let answer!: (r: "applied" | "restart") => void;
    fake.hold.apply = new Promise((r) => (answer = r));
    const two = turn(s, "two", { model: "other" });
    await until(() => fake.applies === 1);
    await pool.shutdownAll();
    answer("restart");
    expect(await two).toMatchObject({ reason: "aborted" });
    expect(fake.connections).toHaveLength(1);
    expect(s.state).toBe("dead");
    expect(s.pid).toBeUndefined();
    await until(() => !alive(one.pid));

    // A user's restart meanwhile: the turn runs on a new process, not on the one that went.
    const t = pool.session("b", "fake");
    const first = await turn(t, "one");
    fake.hold.apply = new Promise((r) => (answer = r));
    const second = turn(t, "two", { model: "other" });
    await until(() => fake.applies === 2);
    await t.restart();
    answer("applied");
    fake.hold.apply = undefined;
    const r = await second;
    expect(r.reason).toBe("done");
    expect(r.pid).not.toBe(first.pid);
    expect(r.pid).toBe(t.pid!);
});

test("aborting a turn while its process starts, or while it takes new settings, ends it at once", async () => {
    const { fake, pool } = setup();
    const s = pool.session("a", "fake");
    fake.hold.open = new Promise(() => {});
    const esc = new AbortController();
    const starting = turn(s, "one", { signal: esc.signal });
    await until(() => fake.connections.length === 1);
    const pid = fake.connections[0]!.proc.pid;
    esc.abort();
    expect(await starting).toMatchObject({ reason: "aborted" });
    expect(s.state).toBe("dead");
    await until(() => !alive(pid));
    fake.hold.open = undefined;
    const one = await turn(s, "one");
    expect(one.reason).toBe("done");

    // A CLI slow to answer a settings change: the turn ends, the process stays, and the next turn waits for
    // that answer, then sends them all again.
    let answer!: (r: "applied") => void;
    fake.hold.apply = new Promise((r) => (answer = r));
    const esc2 = new AbortController();
    const applying = turn(s, "two", { model: "other", signal: esc2.signal });
    await until(() => fake.applies === 1);
    esc2.abort();
    expect(await applying).toMatchObject({ reason: "aborted" });
    fake.hold.apply = undefined;
    const three = turn(s, "three", { model: "other" });
    answer("applied");
    expect((await three).pid).toBe(one.pid);
    expect(fake.applies).toBe(2);
});

test("an interrupt's deadline runs while the prompt is still being taken", async () => {
    const { clock, fake, pool } = setup();
    const s = pool.session("a", "fake");
    const one = await turn(s, "one");
    let take!: () => void;
    fake.hold.prompt = new Promise<void>((r) => (take = r));
    const esc = new AbortController();
    let done = false;
    const two = turn(s, "two", { signal: esc.signal }).finally(() => (done = true));
    await until(() => s.state === "busy");
    esc.abort();
    await until(() => done, () => clock.advance(100));
    expect(await two).toMatchObject({ reason: "aborted", unanswered: true });
    expect(s.unresponsive).toBe(true);
    expect(s.state).toBe("idle");

    // The CLI takes the prompt at last and ends its turn: it answered after all.
    fake.hold.prompt = undefined;
    take();
    await until(() => !s.unresponsive);
    expect((await turn(s, "three")).pid).toBe(one.pid);
});

test("a CLI that can't be spawned ends the turn with the error and leaves the session dead", async () => {
    const { fake, pool } = setup();
    const s = pool.session("a", "fake");
    fake.bin = "/nonexistent/fake-cli";
    const r = await turn(s, "one");
    expect(r.reason).toBe("error");
    expect(r.error).toContain("ENOENT");
    expect(s.state).toBe("dead");
    fake.bin = process.execPath;
    expect((await turn(s, "two")).reason).toBe("done");
});

test("shutdown waits for a restart for new spawn settings to finish stopping the old process", async () => {
    const { fake, pool } = setup({ stopGraceMs: 200 });
    const s = pool.session("a", "fake");
    const one = await turn(s, "one", { system: "v1" });
    fake.hold.close = new Promise(() => {});
    const two = turn(s, "two", { system: "v2" });
    await until(() => s.state === "stopping");
    await pool.shutdownAll();
    expect(s.state).toBe("dead");
    expect(alive(one.pid)).toBe(false);
    expect(await two).toMatchObject({ reason: "aborted" });
    expect(fake.connections).toHaveLength(1);
});

test("a settings change the CLI answers late isn't overtaken by a newer one", async () => {
    const { fake, pool } = setup();
    const s = pool.session("a", "fake");
    await turn(s, "one");
    let answerB!: (r: "applied") => void;
    fake.hold.apply = new Promise((r) => (answerB = r));
    const esc = new AbortController();
    const b = turn(s, "two", { model: "B", signal: esc.signal });
    await until(() => fake.applies === 1);
    esc.abort();
    expect(await b).toMatchObject({ reason: "aborted" });

    fake.hold.apply = undefined;
    const c = turn(s, "three", { model: "C" });
    // Time for C's change to overtake B's, if it may.
    await Bun.sleep(20);
    answerB("applied");
    expect((await c).reason).toBe("done");
    expect((await turn(s, "four", { model: "C" })).reason).toBe("done");
    expect(fake.of(s).model).toBe("C");
});

test("events held for a prompt the CLI took late stay that turn's", async () => {
    const { clock, fake, pool } = setup();
    const s = pool.session("a", "fake");
    await turn(s, "one");
    let take!: () => void;
    fake.hold.prompt = new Promise<void>((r) => (take = r));
    const esc = new AbortController();
    const k = sink();
    let done = false;
    const old = turn(s, "two", { signal: esc.signal, sink: k }).finally(() => (done = true));
    await until(() => s.state === "busy");
    fake.of(s).inject({ t: "turn_event", event: { type: "text", text: "OLD TURN TEXT" } });
    esc.abort();
    await until(() => done, () => clock.advance(100));
    expect(await old).toMatchObject({ reason: "aborted", unanswered: true });

    fake.hold.prompt = undefined;
    const esc2 = new AbortController();
    const k2 = sink();
    const next = turn(s, "hang", { signal: esc2.signal, sink: k2 });
    await until(() => k2.texts.length === 1);
    take();
    await until(() => !s.unresponsive);
    esc2.abort();
    expect((await next).reason).toBe("aborted");
    expect(k2.texts).toEqual([`echo hang (pid ${s.pid})`]);
    expect(k.texts).toEqual([]);
});

test("a wake isn't held back by a prompt the CLI refuses, or never takes", async () => {
    const { clock, fake, pool } = setup();
    const s = pool.session("a", "fake");
    const wakes: string[] = [];
    s.onWake((w) => wakes.push(w.ref));
    await turn(s, "bg t1");
    await turn(s, "bg t2");
    let refuse!: (e: Error) => void;
    fake.hold.prompt = new Promise((_, reject) => (refuse = reject));
    const refused = turn(s, "two");
    await until(() => s.state === "busy");
    fake.of(s).send({ type: "finish", task: "t1" });
    await until(() => wakes.length === 1);
    refuse(new Error("refused"));
    expect(await refused).toMatchObject({ reason: "error", error: "refused" });
    expect(await s.adopt("wake-t1", sink(), new AbortController().signal)).toMatchObject({ reason: "done" });

    fake.hold.prompt = new Promise(() => {});
    const esc = new AbortController();
    let done = false;
    const untaken = turn(s, "three", { signal: esc.signal }).finally(() => (done = true));
    await until(() => s.state === "busy");
    fake.of(s).send({ type: "finish", task: "t2" });
    await until(() => wakes.length === 2);
    esc.abort();
    await until(() => done, () => clock.advance(100));
    expect(await untaken).toMatchObject({ unanswered: true });
    expect(await s.adopt("wake-t2", sink(), new AbortController().signal)).toMatchObject({ reason: "done" });
    await until(() => s.tasks.running().length === 0 && s.quiet());
});

test("which turns a process ended doesn't carry over to the next process", async () => {
    const { clock, fake, pool } = setup();
    const s = pool.session("a", "fake");
    await turn(s, "one");
    // The old process ends a "p1" that's no turn here.
    fake.of(s).inject({ t: "turn_ended", ref: "p1", reason: "done" });
    await s.restart();

    // The new process numbers its prompts afresh: its p1 is the deaf turn below.
    let take!: () => void;
    fake.hold.prompt = new Promise<void>((r) => (take = r));
    const esc = new AbortController();
    let done = false;
    const deaf = turn(s, "deaf", { signal: esc.signal }).finally(() => (done = true));
    await until(() => s.state === "busy");
    esc.abort();
    await until(() => done, () => clock.advance(100));
    expect(await deaf).toMatchObject({ unanswered: true });
    let seen = false;
    s.onEvent((e) => void (e.t === "turn_event" && e.ref === "p1" && (seen = true)));
    take();
    await until(() => seen);
    expect(s.unresponsive).toBe(true);
});
