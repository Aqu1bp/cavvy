import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { describeJob, intervalText, MAX_JOBS, parseInterval, parseLoopArgs, Scheduler, validJob, type Clock, type ScheduledJob } from "../src/agent/schedule";

let tz: string | undefined;
beforeAll(() => {
    tz = process.env.TZ;
    process.env.TZ = "America/New_York";
});
afterAll(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A clock the test moves by hand; timers fire as it passes them. */
class FakeClock implements Clock {
    t: number;
    timers = new Map<number, { at: number; fn: () => void }>();
    private seq = 0;
    constructor(start: number) {
        this.t = start;
    }
    now = () => this.t;
    setTimeout = (fn: () => void, ms: number) => {
        const id = ++this.seq;
        this.timers.set(id, { at: this.t + ms, fn });
        return id;
    };
    clearTimeout = (h: unknown) => {
        this.timers.delete(h as number);
    };
    /** Moves time forward, firing timers in order as their time comes. */
    advance(ms: number) {
        const end = this.t + ms;
        while (true) {
            const due = [...this.timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            this.timers.delete(due[0]);
            this.t = Math.max(this.t, due[1].at);
            due[1].fn();
        }
        this.t = end;
    }
    /** Jumps forward without firing anything in between (a laptop asleep), then lets the timers run. */
    sleep(ms: number) {
        this.t += ms;
        this.advance(0);
    }
}

function setup(start = new Date(2026, 9, 20, 9, 0).getTime()) {
    const clock = new FakeClock(start);
    const fired: ScheduledJob[] = [];
    const notices: string[] = [];
    const saved: ScheduledJob[][] = [];
    let busy = false;
    const s = new Scheduler(
        {
            idle: () => !busy,
            fire: (j) => fired.push(j),
            changed: (jobs) => saved.push(jobs),
            notice: (t) => notices.push(t),
        },
        clock,
    );
    return {
        s,
        clock,
        fired,
        notices,
        saved,
        setBusy(b: boolean) {
            busy = b;
            if (!b) s.poke();
        },
    };
}

describe("intervals", () => {
    test("parseInterval", () => {
        expect(parseInterval("5m")).toBe(5 * MIN);
        expect(parseInterval("2h")).toBe(2 * HOUR);
        expect(parseInterval("1d")).toBe(DAY);
        expect(parseInterval("90s")).toBe(2 * MIN);
        expect(parseInterval("30 minutes")).toBe(30 * MIN);
        expect(parseInterval("1.5h")).toBe(90 * MIN);
        expect(parseInterval("10")).toBeUndefined();
        expect(parseInterval("0m")).toBeUndefined();
        expect(parseInterval("soon")).toBeUndefined();
    });

    test("parseLoopArgs: leading, trailing, default, bounds", () => {
        expect(parseLoopArgs("5m check the deploy")).toEqual({ everyMs: 5 * MIN, prompt: "check the deploy" });
        expect(parseLoopArgs("check the deploy every 20m")).toEqual({ everyMs: 20 * MIN, prompt: "check the deploy" });
        expect(parseLoopArgs("check the deploy every 2 hours")).toEqual({ everyMs: 2 * HOUR, prompt: "check the deploy" });
        expect(parseLoopArgs("/review")).toEqual({ everyMs: 10 * MIN, prompt: "/review" });
        expect(parseLoopArgs("30m /review")).toEqual({ everyMs: 30 * MIN, prompt: "/review" });
        expect(parseLoopArgs("10s ping")).toEqual({ everyMs: MIN, prompt: "ping" });
        expect(parseLoopArgs("")).toHaveProperty("error");
        expect(parseLoopArgs("5m")).toHaveProperty("error");
        expect((parseLoopArgs("8d run it") as { error: string }).error).toMatch(/longest interval is 7d/);
        // "every" inside the prompt that isn't an interval stays in the prompt.
        expect(parseLoopArgs("check every file")).toEqual({ everyMs: 10 * MIN, prompt: "check every file" });
    });

    test("intervalText", () => {
        expect(intervalText(5 * MIN)).toBe("5m");
        expect(intervalText(90 * MIN)).toBe("1h 30m");
        expect(intervalText(2 * HOUR)).toBe("2h");
        expect(intervalText(DAY)).toBe("1d");
    });
});

describe("Scheduler", () => {
    test("no timer at all without jobs", () => {
        const { s, clock } = setup();
        expect(clock.timers.size).toBe(0);
        const j = s.add({ kind: "loop", prompt: "x", everyMs: 5 * MIN });
        expect(clock.timers.size).toBe(1);
        s.remove(j.id);
        expect(clock.timers.size).toBe(0);
    });

    test("a loop runs now when asked, then every interval", () => {
        const { s, clock, fired } = setup();
        s.add({ kind: "loop", prompt: "check", everyMs: 5 * MIN, runNow: true });
        // Not from inside add(): the caller gets to say what it added first.
        expect(fired.length).toBe(0);
        clock.advance(0);
        expect(fired.map((j) => j.prompt)).toEqual(["check"]);
        clock.advance(4 * MIN);
        expect(fired.length).toBe(1);
        clock.advance(MIN);
        expect(fired.length).toBe(2);
        clock.advance(10 * MIN);
        expect(fired.length).toBe(4);
    });

    test("due while busy: runs once when idle, no pile-up; the interval counts from that run", () => {
        const { s, clock, fired, setBusy } = setup();
        s.add({ kind: "loop", prompt: "check", everyMs: 5 * MIN });
        setBusy(true);
        clock.advance(23 * MIN);
        expect(fired.length).toBe(0);
        expect(s.list()[0]!.due).toBe(true);
        setBusy(false);
        expect(fired.length).toBe(1);
        clock.advance(4 * MIN);
        expect(fired.length).toBe(1);
        clock.advance(MIN);
        expect(fired.length).toBe(2);
    });

    test("several due together: one at a time, in the order they came due", () => {
        const { s, clock, fired, setBusy } = setup();
        setBusy(true);
        s.add({ kind: "loop", prompt: "b", everyMs: 10 * MIN });
        s.add({ kind: "loop", prompt: "a", everyMs: 5 * MIN });
        clock.advance(10 * MIN);
        setBusy(false);
        // poke() fired one; the host is busy with it until its turn ends.
        expect(fired.map((j) => j.prompt)).toEqual(["a"]);
        setBusy(true);
        setBusy(false);
        expect(fired.map((j) => j.prompt)).toEqual(["a", "b"]);
    });

    test("a host that never pokes still gets the due job within a minute", () => {
        let busy = true;
        const clock = new FakeClock(Date.now());
        const fired: string[] = [];
        const s = new Scheduler({ idle: () => !busy, fire: (j) => fired.push(j.prompt) }, clock);
        s.add({ kind: "loop", prompt: "x", everyMs: 5 * MIN });
        clock.advance(6 * MIN);
        busy = false;
        expect(fired).toEqual([]);
        clock.advance(MIN);
        expect(fired).toEqual(["x"]);
    });

    test("cron: next run from the expression; one-shots run once and are removed", () => {
        const { s, clock, fired } = setup(new Date(2026, 9, 20, 8, 0).getTime());
        const daily = s.add({ kind: "cron", prompt: "standup", cron: "0 9 * * *" });
        expect(new Date(daily.nextAt!).getHours()).toBe(9);
        const once = s.add({ kind: "cron", prompt: "remind", cron: "30 8 20 10 *", recurring: false });
        clock.advance(30 * MIN);
        expect(fired.map((j) => j.prompt)).toEqual(["remind"]);
        expect(s.get(once.id)).toBeUndefined();
        clock.advance(30 * MIN);
        expect(fired.map((j) => j.prompt)).toEqual(["remind", "standup"]);
        clock.advance(DAY);
        expect(fired.length).toBe(3);
    });

    test("invalid cron is refused with the reason", () => {
        const { s } = setup();
        expect(() => s.add({ kind: "cron", prompt: "x", cron: "61 * * * *" })).toThrow(/minute 61 is out of range/);
        expect(() => s.add({ kind: "cron", prompt: "x", cron: "0 0 30 2 *" })).toThrow(/never runs/);
        expect(s.size).toBe(0);
    });

    test("empty or huge prompts are refused", () => {
        const { s } = setup();
        expect(() => s.add({ kind: "loop", prompt: "   ", everyMs: 5 * MIN })).toThrow(/empty/);
        expect(() => s.add({ kind: "loop", prompt: "x".repeat(20_001), everyMs: 5 * MIN })).toThrow(/too long/);
    });

    test("pause and resume: nothing while paused, no burst after", () => {
        const { s, clock, fired } = setup();
        const j = s.add({ kind: "loop", prompt: "x", everyMs: 5 * MIN });
        s.setPaused(j.id, true);
        expect(clock.timers.size).toBe(0);
        clock.advance(HOUR);
        expect(fired.length).toBe(0);
        s.setPaused(j.id, false);
        expect(fired.length).toBe(0);
        clock.advance(5 * MIN);
        expect(fired.length).toBe(1);
    });

    test("run now while busy: waits for the turn, without spinning a timer", () => {
        const { s, clock, fired, setBusy } = setup();
        const j = s.add({ kind: "loop", prompt: "x", everyMs: HOUR });
        setBusy(true);
        s.runNow(j.id);
        clock.advance(0);
        expect(fired.length).toBe(0);
        expect([...clock.timers.values()].every((t) => t.at - clock.t >= MIN)).toBe(true);
        setBusy(false);
        expect(fired.length).toBe(1);
    });

    test("run now runs it (even paused) and keeps its schedule", () => {
        const { s, clock, fired } = setup();
        const j = s.add({ kind: "cron", prompt: "x", cron: "0 9 * * 1-5" });
        s.setPaused(j.id, true);
        s.runNow(j.id);
        expect(fired.length).toBe(0);
        clock.advance(0);
        expect(fired.length).toBe(1);
        expect(s.get(j.id)?.paused).toBe(true);
    });

    test("recurring jobs expire after 7 days, with a last run", () => {
        const { s, clock, fired, notices } = setup();
        s.add({ kind: "loop", prompt: "x", everyMs: DAY });
        clock.advance(7 * DAY + MIN);
        expect(fired.length).toBe(7);
        expect(s.size).toBe(0);
        expect(notices.some((n) => /7-day limit|expired/.test(n))).toBe(true);
        expect(clock.timers.size).toBe(0);
    });

    test("at most 50 jobs", () => {
        const { s } = setup();
        for (let i = 0; i < MAX_JOBS; i++) s.add({ kind: "loop", prompt: `x${i}`, everyMs: HOUR });
        expect(() => s.add({ kind: "loop", prompt: "one more", everyMs: HOUR })).toThrow(/already has 50/);
    });

    test("sleep (the clock jumps): one catch-up run, not one per missed slot", () => {
        const { s, clock, fired } = setup();
        s.add({ kind: "loop", prompt: "x", everyMs: 5 * MIN });
        clock.sleep(3 * HOUR);
        expect(fired.length).toBe(1);
        clock.advance(5 * MIN);
        expect(fired.length).toBe(2);
    });

    test("the timer never sleeps more than a minute", () => {
        const { s, clock } = setup();
        s.add({ kind: "cron", prompt: "x", cron: "0 9 1 1 *" });
        const [t] = [...clock.timers.values()];
        expect(t!.at - clock.t).toBe(MIN);
    });

    test("a resume job replaces the previous one", () => {
        const { s, clock } = setup();
        s.add({ kind: "resume", prompt: "continue", at: clock.t + HOUR });
        s.add({ kind: "resume", prompt: "continue", at: clock.t + 2 * HOUR });
        expect(s.list().filter((j) => j.kind === "resume").length).toBe(1);
        expect(s.list()[0]!.nextAt).toBe(clock.t + 2 * HOUR);
        expect(describeJob(s.list()[0]!)).toBe("when your usage limit resets");
    });

    test("changed() gets every change, durable or not", () => {
        const { s, saved } = setup();
        const j = s.add({ kind: "cron", prompt: "x", cron: "0 9 * * *", durable: true });
        s.setPaused(j.id, true);
        s.remove(j.id);
        expect(saved.length).toBeGreaterThanOrEqual(3);
        expect(saved.at(-1)).toEqual([]);
    });

    test("ids are case-insensitive and trimmed", () => {
        const { s } = setup();
        const j = s.add({ kind: "loop", prompt: "x", everyMs: HOUR });
        expect(s.remove(` ${j.id.toUpperCase()} `)?.id).toBe(j.id);
    });

    test("dispose stops the timer and refuses new jobs", () => {
        const { s, clock } = setup();
        s.add({ kind: "loop", prompt: "x", everyMs: HOUR });
        s.dispose();
        expect(clock.timers.size).toBe(0);
        expect(() => s.add({ kind: "loop", prompt: "x", everyMs: HOUR })).toThrow(/closed/);
    });
});

describe("restore (durable jobs, the app was closed)", () => {
    function savedJob(over: Partial<ScheduledJob>): ScheduledJob {
        return { id: "abcd1234", kind: "cron", prompt: "standup", cron: "0 9 * * *", recurring: true, durable: true, createdAt: 0, runs: 0, ...over };
    }

    test("a recurring job skips what it missed and says so", () => {
        const start = new Date(2026, 9, 20, 12, 0).getTime();
        const { s, fired, notices } = setup(start);
        s.restore([savedJob({ createdAt: start - 3 * DAY, expiresAt: start + 4 * DAY, nextAt: new Date(2026, 9, 18, 9, 0).getTime() })]);
        expect(fired.length).toBe(0);
        expect(notices[0]).toMatch(/missed 3 runs/);
        expect(new Date(s.list()[0]!.nextAt!).getDate()).toBe(21);
    });

    test("a one-shot under a day late runs now; over a day late is dropped", () => {
        const start = new Date(2026, 9, 20, 12, 0).getTime();
        const a = setup(start);
        a.s.restore([savedJob({ recurring: false, cron: "0 9 20 10 *", nextAt: start - 3 * HOUR })]);
        expect(a.fired.map((j) => j.prompt)).toEqual(["standup"]);
        expect(a.notices[0]).toMatch(/running it now/);
        const b = setup(start);
        b.s.restore([savedJob({ recurring: false, cron: "0 9 18 10 *", nextAt: start - 2 * DAY })]);
        expect(b.fired.length).toBe(0);
        expect(b.s.size).toBe(0);
        expect(b.notices[0]).toMatch(/dropped/);
    });

    test("expired while closed: removed", () => {
        const start = new Date(2026, 9, 20, 12, 0).getTime();
        const { s, notices } = setup(start);
        s.restore([savedJob({ expiresAt: start - HOUR, nextAt: start - HOUR })]);
        expect(s.size).toBe(0);
        expect(notices[0]).toMatch(/expired/);
    });

    test("session-only and malformed jobs aren't restored", () => {
        const { s } = setup();
        s.restore([savedJob({ durable: undefined }), { ...savedJob({ id: "ffff0000" }), cron: "nope" }, { junk: true } as never, savedJob({ id: "../x" })]);
        expect(s.size).toBe(0);
    });

    test("a paused job stays paused and quiet", () => {
        const start = new Date(2026, 9, 20, 12, 0).getTime();
        const { s, fired, notices } = setup(start);
        s.restore([savedJob({ paused: true, nextAt: start - DAY, expiresAt: start + DAY })]);
        expect(fired.length).toBe(0);
        expect(notices.length).toBe(0);
        expect(s.list()[0]!.paused).toBe(true);
    });
});

describe("validJob", () => {
    test("keeps the fields it knows, drops the rest", () => {
        const j = validJob({ id: "abcd", kind: "loop", prompt: "x", everyMs: 5 * MIN, recurring: true, createdAt: 1, runs: 2, evil: "y" });
        expect(j).toBeDefined();
        expect(j as unknown as Record<string, unknown>).not.toHaveProperty("evil");
        expect(validJob({ id: "abcd", kind: "loop", prompt: "x", everyMs: 5, createdAt: 1 })).toBeUndefined();
        expect(validJob({ id: "abcd", kind: "shell", prompt: "x", createdAt: 1 })).toBeUndefined();
    });
});

describe("idle cost", () => {
    test("50 jobs, a simulated week: few wakes, little work", () => {
        const { s, clock } = setup();
        for (let i = 0; i < 50; i++) s.add({ kind: "cron", prompt: `job ${i}`, cron: `${i} 9 * * 1-5` });
        const t0 = performance.now();
        clock.advance(7 * DAY);
        const ms = performance.now() - t0;
        // A wake a minute at most (one a minute while waiting for a far-off job).
        expect(s.wakes).toBeLessThanOrEqual(7 * 24 * 60 + 300);
        // Well under a millisecond per wake.
        expect(ms / s.wakes).toBeLessThan(1);
    });
});
