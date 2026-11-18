import { afterAll, describe, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";
import type { SessionOp, SessionState, SessionSummary, Turn } from "../src/server/protocol";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { Runtime } = await import("../src/server/runtime");
const { Session } = await import("../src/agent/session");
const { applyOp } = await import("../src/server/timeline");
const { Alarm, checkSnoozeUntil, dueWakes, nextWake, woken, MAX_SNOOZE_MS } = await import("../src/server/snooze");
afterAll(() => iso.cleanup());

const HOUR = 3_600_000;

/** A clock the test moves, and the timers set on it. */
function fakeClock(start = 1_000_000) {
    let t = start;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    let n = 0;
    return {
        now: () => t,
        setTimer: (fn: () => void, ms: number) => {
            const id = ++n;
            timers.push({ at: t + ms, fn, id });
            return id as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: (id: ReturnType<typeof setTimeout>) => {
            const i = timers.findIndex((x) => x.id === (id as unknown as number));
            if (i >= 0) timers.splice(i, 1);
        },
        pending: () => timers.map((x) => x.at),
        /** Moves the clock on, firing what comes due on the way. */
        advance(ms: number) {
            const end = t + ms;
            for (;;) {
                timers.sort((a, b) => a.at - b.at);
                const next = timers[0];
                if (!next || next.at > end) break;
                timers.shift();
                t = next.at;
                next.fn();
            }
            t = end;
        },
        /** The machine slept: the clock jumps, the timers don't move. */
        sleep(ms: number) {
            t += ms;
            for (const x of timers) x.at += ms;
        },
    };
}

describe("snooze store", () => {
    test("due and next wakes", () => {
        const store = { snoozed: { a: { until: 100 }, b: { until: 50 }, c: { until: 300 } } };
        expect(dueWakes(store, 100).sort()).toEqual(["a", "b"]);
        expect(nextWake(store)).toBe(50);
        expect(nextWake({})).toBeUndefined();
    });

    test("waking clears the snooze and marks it only when asked", () => {
        const store: { snoozed?: Record<string, { until: number }>; woke?: string[] } = { snoozed: { a: { until: 1 }, b: { until: 2 } } };
        woken(store, "a", true);
        expect(store.snoozed).toEqual({ b: { until: 2 } });
        expect(store.woke).toEqual(["a"]);
        woken(store, "a", false);
        woken(store, "b", false);
        expect(store).toEqual({ snoozed: {}, woke: [] });
    });

    test("a time to snooze until is checked", () => {
        const now = 10 * HOUR;
        expect(checkSnoozeUntil(now + HOUR, now)).toBe(now + HOUR);
        // A window a little behind: now.
        expect(checkSnoozeUntil(now - 30_000, now)).toBe(now);
        expect(checkSnoozeUntil(now - HOUR, now)).toBeUndefined();
        expect(checkSnoozeUntil(now + MAX_SNOOZE_MS + 1, now)).toBeUndefined();
        expect(checkSnoozeUntil("soon", now)).toBeUndefined();
        expect(checkSnoozeUntil(Number.NaN, now)).toBeUndefined();
    });
});

describe("the alarm", () => {
    test("one timer, for the next due, checked again at least every max delay", () => {
        const clock = fakeClock();
        const fired: number[] = [];
        const alarm = new Alarm({ now: clock.now, fire: () => fired.push(clock.now()), maxDelayMs: HOUR, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
        alarm.arm(clock.now() + 5 * HOUR);
        alarm.arm(clock.now() + 3 * HOUR);
        expect(clock.pending()).toEqual([clock.now() + HOUR]);
        clock.advance(HOUR);
        expect(fired).toHaveLength(1);
        expect(alarm.due()).toBe(false);
        alarm.arm(undefined);
        expect(clock.pending()).toEqual([]);
    });

    test("after a sleep it's due, though its timer hasn't fired", () => {
        const clock = fakeClock();
        const alarm = new Alarm({ now: clock.now, fire: () => {}, maxDelayMs: HOUR, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
        alarm.arm(clock.now() + 30 * 60_000);
        clock.sleep(2 * HOUR);
        expect(alarm.due()).toBe(true);
    });
});

/** An engine on a fake clock, its broadcast rows, and sessions on disk or open. */
function setup() {
    const clock = fakeClock(Date.now());
    const engine = new Engine({ listModels: async () => [], now: clock.now });
    // The engine's timer on the fake clock.
    const alarm = (engine as unknown as { alarm: { o: Record<string, unknown> } }).alarm;
    Object.assign(alarm.o, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    const rows: SessionSummary[] = [];
    const client = { subs: new Set<string>(), send: (e: { type: string; session?: SessionSummary }) => e.type === "sessions.upsert" && rows.push(e.session!) };
    engine.clients.add(client as never);
    const call = (method: string, params: unknown) => engine.handle(client as never, method as never, params);
    const saved = () => {
        const s = Session.create(realpathSync(tempDir()));
        s.push({ role: "user", content: [{ type: "text", text: "Saved one" }] });
        s.push({ role: "assistant", content: [{ type: "text", text: "Done." }] } as never);
        s.release();
        return s.meta.id;
    };
    const open = (busy = false) => {
        const session = Session.create(tempDir());
        session.push({ role: "user", content: [{ type: "text", text: "Open one" }] });
        const view = { state: { status: busy ? "running" : "idle", interactions: [] } as unknown as SessionState, turns: [] as Turn[], agents: [] };
        const rt = Object.assign(Object.create(Runtime.prototype), {
            engine, session, ws: { cwd: session.meta.cwd, settings: {} }, view, busy,
            lastActive: clock.now(), pending: new Map(), schedules: { poke() {} }, stepsDirty: new Map(), agentsDirty: new Map(), outbox: [],
            op: (op: SessionOp) => applyOp(view, op),
        });
        engine.runtimes.set(rt.id, rt);
        return rt as InstanceType<typeof Runtime> & { busy: boolean; view: typeof view };
    };
    const row = (id: string) => engine.listSessions().find((s) => s.id === id);
    return { clock, engine, rows, call, saved, open, row };
}

describe("snoozing sessions", () => {
    test("a snoozed session says when it wakes, and wakes then, marked until it's opened", async () => {
        const { clock, engine, call, saved, row, rows } = setup();
        const id = saved();
        await call("session.snooze", { id, until: clock.now() + 2 * HOUR });
        expect(row(id)?.snoozedUntil).toBe(clock.now() + 2 * HOUR);
        expect(rows.at(-1)).toMatchObject({ id, snoozedUntil: clock.now() + 2 * HOUR });
        clock.advance(HOUR);
        expect(row(id)?.snoozedUntil).toBeDefined();
        clock.advance(HOUR);
        expect(row(id)?.snoozedUntil).toBeUndefined();
        expect(row(id)?.woke).toBe(true);
        expect(rows.at(-1)).toMatchObject({ id, woke: true });
        await call("session.shown", { id });
        expect(row(id)?.woke).toBeUndefined();
        await engine.stop();
    });

    test("one a window shows as it wakes isn't marked", async () => {
        const { clock, engine, call, saved, row } = setup();
        const id = saved();
        await call("session.snooze", { id, until: clock.now() + HOUR });
        await call("session.shown", { id });
        clock.advance(HOUR);
        expect(row(id)?.snoozedUntil).toBeUndefined();
        expect(row(id)?.woke).toBeUndefined();
        await engine.stop();
    });

    test("Wake now: back without a mark; Undo of a snooze is the same", async () => {
        const { clock, engine, call, saved, row } = setup();
        const id = saved();
        await call("session.snooze", { id, until: clock.now() + HOUR });
        await call("session.snooze", { id, until: null });
        expect(row(id)?.snoozedUntil).toBeUndefined();
        expect(row(id)?.woke).toBeUndefined();
        await engine.stop();
    });

    test("one timer for the earliest; a far-off one is checked again after a sleep when the list is read", async () => {
        const { clock, engine, call, saved, row } = setup();
        const a = saved();
        const b = saved();
        await call("session.snooze", { id: a, until: clock.now() + 5 * HOUR });
        await call("session.snooze", { id: b, until: clock.now() + 5 * 60_000 });
        expect(clock.pending()).toHaveLength(1);
        clock.advance(5 * 60_000);
        expect(row(b)?.woke).toBe(true);
        expect(row(a)?.snoozedUntil).toBeDefined();
        expect(clock.pending()).toHaveLength(1);
        clock.sleep(6 * HOUR);
        await call("sessions.list", {});
        expect(row(a)?.woke).toBe(true);
        expect(clock.pending()).toHaveLength(0);
        await engine.stop();
    });

    test("one whose time passed while Cavvy was closed wakes as it starts", async () => {
        const first = setup();
        const id = first.saved();
        await first.call("session.snooze", { id, until: first.clock.now() + 60_000 });
        await first.engine.stop();
        const second = setup();
        second.clock.advance(2 * 60_000);
        (second.engine as unknown as { sweep(): void }).sweep();
        expect(second.row(id)?.woke).toBe(true);
        await second.engine.stop();
    });

    test("it wakes early for a question or a failure, not for a turn it didn't start in", async () => {
        const { clock, engine, call, open, row } = setup();
        const asks = open();
        const fails = open();
        const finishes = open();
        for (const rt of [asks, fails, finishes]) await call("session.snooze", { id: rt.id, until: clock.now() + 9 * HOUR });
        engine.notify(asks, "question", "Which one?");
        engine.notify(fails, "error", "Stopped with an error");
        engine.notify(finishes, "done", "Finished in 2m");
        engine.turnRunning(finishes, false);
        expect(row(asks.id)).toMatchObject({ woke: true });
        expect(row(asks.id)?.snoozedUntil).toBeUndefined();
        expect(row(fails.id)).toMatchObject({ woke: true });
        expect(row(finishes.id)?.snoozedUntil).toBeDefined();
        await engine.stop();
    });

    test("snoozed while working, it wakes when that turn ends", async () => {
        const { clock, engine, call, open, row } = setup();
        const rt = open(true);
        await call("session.snooze", { id: rt.id, until: clock.now() + 9 * HOUR });
        rt.busy = false;
        engine.turnRunning(rt, false);
        expect(row(rt.id)).toMatchObject({ woke: true });
        await engine.stop();
    });

    test("one waiting for you isn't snoozed; a bad time is refused", async () => {
        const { clock, engine, call, open } = setup();
        const rt = open();
        rt.view.state.status = "waiting";
        expect(call("session.snooze", { id: rt.id, until: clock.now() + HOUR })).rejects.toThrow("waiting for you");
        rt.view.state.status = "idle";
        expect(call("session.snooze", { id: rt.id, until: clock.now() - 2 * HOUR })).rejects.toThrow("next year");
        await engine.stop();
    });

    test("woken settled, it's back in play; sending to a snoozed one wakes it without a mark; archiving forgets it", async () => {
        const { clock, engine, call, saved, row } = setup();
        const settled = saved();
        await call("session.settle", { id: settled, settled: true });
        await call("session.snooze", { id: settled, until: clock.now() + HOUR });
        clock.advance(HOUR);
        expect(row(settled)).toMatchObject({ settled: false, woke: true });

        const archived = saved();
        await call("session.snooze", { id: archived, until: clock.now() + HOUR });
        await call("session.archive", { id: archived, archived: true });
        expect(engine.listSessions(200, true).find((s) => s.id === archived)?.snoozedUntil).toBeUndefined();
        await engine.stop();
    });
});
