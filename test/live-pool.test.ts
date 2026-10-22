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
import type { AgentCliAdapter, CliConnection, CliEventSink, LiveClock, LiveSettings, SessionHost, SpawnConfig, SpawnSpec, TurnInput } from "../src/backends/live/types";
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
        this.send({ type: "stop_task", id });
    }
    async apply(s: Partial<LiveSettings>) {
        this.adapter.applies++;
        const held = await this.adapter.hold.apply;
        if (held) return held;
        return s.model?.id === "needs-restart" ? ("restart" as const) : ("applied" as const);
    }
    async close() {
        this.proc.end();
    }
}

class FakeAdapter implements AgentCliAdapter {
    readonly def = DEF;
    connections: FakeConnection[] = [];
    bin = process.execPath;
    /** Calls that wait for these first (a CLI slow to answer them); apply's settles with its answer. */
    hold: { open?: Promise<unknown>; prompt?: Promise<unknown>; apply?: Promise<"applied" | "restart"> } = {};
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
    const pool = new LiveCliPool(() => fake, { clock, idleMs: 1000, interruptMs: 500, stopConfirmMs: 300, stopGraceMs: 2000, ...o });
    pools.push(pool);
    return { clock, fake, pool };
}

function sink() {
    const texts: string[] = [];
    return { texts, emit: (e: AgentEvent) => void (e.type === "text" && texts.push(e.text)) };
}

async function turn(s: LiveCliSession, text: string, o: { system?: string; model?: string; signal?: AbortSignal } = {}) {
    const k = sink();
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

test("a crash ends the turn with the CLI's error, marks its tasks lost, and the next turn resumes", async () => {
    const { pool } = setup();
    const s = pool.session("a", "fake");
    const one = await turn(s, "bg t1");
    const crash = await turn(s, "crash");
    expect(crash.reason).toBe("error");
    expect(crash.error).toBe("Fake CLI stopped: fatal: boom");
    expect(s.state).toBe("dead");
    expect(s.error).toBe("Fake CLI stopped: fatal: boom");
    expect(s.tasks.get("t1")).toMatchObject({ status: "stopped", lost: true });
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
    await Bun.sleep(20);
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
    expect(await s.stopTasks(["t1"])).toEqual({ t1: "stopped" });

    let result: unknown;
    void s.stopTasks().then((r) => (result = r));
    await Bun.sleep(20);
    expect(result).toBeUndefined();
    clock.advance(300);
    await until(() => result !== undefined);
    expect(result).toEqual({ stubborn1: "timeout" });
    expect(s.tasks.get("stubborn1")?.status).toBe("running");
});

test("release stops one harness session's processes; shutdownAll stops them all, tasks and all", async () => {
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
    expect(b.tasks.get("t1")).toMatchObject({ status: "stopped", lost: true });
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
    expect(tasks.get("a")).toMatchObject({ status: "stopped", lost: true, endedAt: 5 });
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
