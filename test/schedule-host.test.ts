import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MAX_RESUMES, noteScheduleIndex, readScheduleIndex, RESUME_DELAY_MS, RESUME_PROMPT, SessionSchedules } from "../src/agent/schedule-host";
import { createSchedule, deleteSchedule, listSchedules, scheduleServerTools, CronCreateTool, CronListTool } from "../src/agent/schedule-tools";
import { Session } from "../src/agent/session";
import type { Clock, ScheduledJob } from "../src/agent/schedule";
import type { Settings } from "../src/config/settings";

let home: string;
let prevHome: string | undefined;
let prevTz: string | undefined;
beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "cavvy-sched-"));
    prevHome = process.env.CAVVY_HOME;
    process.env.CAVVY_HOME = home;
    prevTz = process.env.TZ;
    process.env.TZ = "America/New_York";
});
afterAll(() => {
    if (prevHome === undefined) delete process.env.CAVVY_HOME;
    else process.env.CAVVY_HOME = prevHome;
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
    rmSync(home, { recursive: true, force: true });
});

const MIN = 60_000;
const HOUR = 60 * MIN;

class FakeClock implements Clock {
    timers = new Map<number, { at: number; fn: () => void }>();
    private seq = 0;
    constructor(public t: number) {}
    now = () => this.t;
    setTimeout = (fn: () => void, ms: number) => {
        this.timers.set(++this.seq, { at: this.t + ms, fn });
        return this.seq;
    };
    clearTimeout = (h: unknown) => void this.timers.delete(h as number);
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
}

function host(opts: { settings?: Settings; session?: Session; busy?: boolean } = {}) {
    const clock = new FakeClock(new Date(2026, 9, 20, 9, 0).getTime());
    let session = opts.session ?? Session.create(mkdtempSync(join(home, "proj-")), { persist: false });
    const runs: { prompt: string; label: string }[] = [];
    const notices: string[] = [];
    let busy = opts.busy ?? false;
    // Which account and model the session is on (what a resume is tied to).
    let identity = "claude-code:a|acct-1";
    const h = new SessionSchedules({
        identity: () => identity,
        session: () => session,
        settings: () => opts.settings ?? {},
        idle: () => !busy,
        run: (prompt, _job, label) => void runs.push({ prompt, label }),
        notice: (t) => notices.push(t),
        clock,
        index: false,
    });
    return {
        h,
        clock,
        runs,
        notices,
        setBusy(b: boolean) {
            busy = b;
            if (!b) h.poke();
        },
        setIdentity(x: string) {
            identity = x;
        },
        setSession(s: Session) {
            session = s;
        },
    };
}

describe("/loop", () => {
    test("runs now, then every interval, labelled", () => {
        const { h, clock, runs } = host();
        const r = h.loop("5m check the deploy");
        expect(r.text).toMatch(/Looping every 5m: check the deploy/);
        expect(runs).toEqual([]);
        clock.advance(0);
        expect(runs).toEqual([{ prompt: "check the deploy", label: "Scheduled (every 5m)" }]);
        clock.advance(5 * MIN);
        expect(runs.length).toBe(2);
    });

    test("a slash command as the prompt", () => {
        const { h, clock, runs } = host();
        h.loop("30m /review");
        clock.advance(0);
        expect(runs[0]!.prompt).toBe("/review");
    });

    test("can't loop /loop", () => {
        const { h } = host();
        expect(h.loop("5m /loop 1m x")).toMatchObject({ level: "error" });
    });

    test("while busy: added, runs once the turn ends", () => {
        const { h, runs, setBusy } = host({ busy: true });
        h.loop("5m x");
        expect(runs.length).toBe(0);
        setBusy(false);
        expect(runs.length).toBe(1);
    });

    test("stop, and listing", () => {
        const { h } = host();
        expect(h.loop("").text).toMatch(/Usage/);
        h.loop("5m a");
        h.loop("1h b");
        expect(h.loop("").text).toMatch(/every 5m: a[\s\S]*every 1h: b/);
        expect(h.loop("stop").text).toBe("Stopped 2 loops.");
        expect(h.loop("stop").text).toBe("No loops are running.");
    });

    test("errors are the user's to read", () => {
        const { h } = host();
        expect(h.loop("5m").level).toBe("error");
        expect(h.loop("9d x").text).toMatch(/longest interval/);
    });
});

describe("/schedules with arguments", () => {
    test("pause, resume, run, delete, clear, bad input", () => {
        const { h, clock, runs } = host();
        h.loop("1h x");
        clock.advance(0);
        const id = h.scheduler.list()[0]!.id;
        expect(h.manage("")).toBeUndefined();
        expect(h.manage(`pause ${id}`)!.text).toMatch(/^Paused every 1h: x/);
        expect(h.manage(`resume ${id}`)!.text).toMatch(/^Resumed every 1h: x; next/);
        expect(h.manage(`run ${id}`)!.text).toMatch(/^Running every 1h: x$/);
        clock.advance(0);
        expect(runs.length).toBe(2);
        expect(h.manage(`delete ${id}`)!.text).toMatch(/^Deleted/);
        expect(h.manage(`delete ${id}`)!.level).toBe("error");
        expect(h.manage("frobnicate")!.level).toBe("error");
        h.loop("1h y");
        expect(h.manage("clear")!.text).toBe("Deleted 1 schedule.");
    });
});

describe("auto-resume after a usage limit", () => {
    test("schedules a resume a minute after the reset, and runs it", () => {
        const { h, clock, runs, notices } = host();
        const reset = clock.t + 2 * HOUR;
        h.turnEnded("error", { resetsAt: reset });
        const job = h.scheduler.list()[0]!;
        expect(job.kind).toBe("resume");
        expect(job.nextAt).toBe(reset + RESUME_DELAY_MS);
        expect(notices.at(-1)).toMatch(/continues by itself at .* \(in 2h 1m\)/);
        clock.advance(2 * HOUR);
        expect(runs.length).toBe(0);
        clock.advance(MIN);
        expect(runs).toEqual([{ prompt: RESUME_PROMPT, label: "Resuming after the usage limit reset" }]);
        expect(h.scheduler.size).toBe(0);
    });

    test("waits for the session to be idle", () => {
        const { h, clock, runs, setBusy } = host({ busy: true });
        h.turnEnded("error", { resetsAt: clock.t + HOUR });
        clock.advance(2 * HOUR);
        expect(runs.length).toBe(0);
        setBusy(false);
        expect(runs.length).toBe(1);
    });

    test("off with autoResume: false", () => {
        const { h } = host({ settings: { autoResume: false } });
        h.turnEnded("error", { resetsAt: Date.now() + HOUR });
        expect(h.scheduler.size).toBe(0);
    });

    test("unknown or past reset: no job, and a notice says so", () => {
        const { h, clock, notices } = host();
        h.turnEnded("error", {});
        h.turnEnded("error", { resetsAt: clock.t - MIN });
        expect(h.scheduler.size).toBe(0);
        expect(notices[0]).toMatch(/reset time isn't known/);
        expect(notices[1]).toMatch(/still reached after the time it was to reset/);
    });

    test("other errors and finished turns schedule nothing", () => {
        const { h, clock } = host();
        h.turnEnded("error", undefined);
        h.turnEnded("done", { resetsAt: clock.t + HOUR });
        h.turnEnded("aborted", { resetsAt: clock.t + HOUR });
        expect(h.scheduler.size).toBe(0);
    });

    test("the user sending a message cancels it", () => {
        const { h, clock, notices } = host();
        h.turnEnded("error", { resetsAt: clock.t + HOUR });
        h.userSent();
        expect(h.scheduler.size).toBe(0);
        expect(notices.at(-1)).toMatch(/cancelled: you sent a message/);
        // Nothing to cancel: no notice.
        const n = notices.length;
        h.userSent();
        expect(notices.length).toBe(n);
    });

    test("a newer limit replaces the waiting resume", () => {
        const { h, clock } = host();
        h.turnEnded("error", { resetsAt: clock.t + HOUR });
        h.turnEnded("error", { resetsAt: clock.t + 3 * HOUR });
        expect(h.scheduler.list().map((j) => j.nextAt)).toEqual([clock.t + 3 * HOUR + RESUME_DELAY_MS]);
    });

    test(`gives up after ${MAX_RESUMES} resumes that hit the limit again; a finished turn resets that`, () => {
        const { h, clock, runs, notices } = host();
        for (let i = 0; i < MAX_RESUMES; i++) {
            h.turnEnded("error", { resetsAt: clock.t + HOUR });
            clock.advance(HOUR + MIN);
        }
        expect(runs.length).toBe(MAX_RESUMES);
        h.turnEnded("error", { resetsAt: clock.t + HOUR });
        expect(h.scheduler.size).toBe(0);
        expect(notices.at(-1)).toMatch(/already tried 3 times/);
        h.turnEnded("done", undefined);
        h.turnEnded("error", { resetsAt: clock.t + HOUR });
        expect(h.scheduler.size).toBe(1);
    });

    test("other schedules keep running alongside", () => {
        const { h, clock, runs } = host();
        h.loop("30m x");
        h.turnEnded("error", { resetsAt: clock.t + HOUR });
        expect(h.scheduler.size).toBe(2);
        clock.advance(HOUR + MIN);
        // The loop at 0, 30 and 60 minutes; the resume a minute after the reset.
        expect(runs.map((r) => r.prompt)).toEqual(["x", "x", "x", RESUME_PROMPT]);
    });
});

describe("a switched account or model and the waiting resume (#411)", () => {
    test("switching the account or the model cancels it, and says so; switching to the same one doesn't", () => {
        const { h, clock, runs, notices, setIdentity } = host();
        h.turnEnded("error", { resetsAt: clock.t + HOUR });
        expect(h.scheduler.size).toBe(1);
        // Nothing changed (the same account picked again, or the same model): it stays.
        h.cancelLimitResume("account");
        h.cancelLimitResume("model");
        expect(h.scheduler.size).toBe(1);
        setIdentity("claude-code:a|acct-2");
        h.cancelLimitResume("account");
        expect(h.scheduler.size).toBe(0);
        expect(notices.at(-1)).toBe("The automatic resume is cancelled: you switched the account.");
        // Again, then the model.
        setIdentity("claude-code:a|acct-2");
        h.turnEnded("error", { resetsAt: clock.t + HOUR });
        expect(h.scheduler.size).toBe(1);
        setIdentity("codex:b|acct-2");
        h.cancelLimitResume("model");
        expect(h.scheduler.size).toBe(0);
        expect(notices.at(-1)).toBe("The automatic resume is cancelled: you switched the model.");
        clock.advance(3 * HOUR);
        expect(runs).toEqual([]);
        // Nothing waiting: no notice.
        const n = notices.length;
        h.cancelLimitResume("model");
        expect(notices.length).toBe(n);
    });

    test("other schedules stay when the resume is cancelled", () => {
        const { h, clock, setIdentity } = host();
        h.loop("30m x");
        h.turnEnded("error", { resetsAt: clock.t + HOUR });
        setIdentity("other");
        h.cancelLimitResume("model");
        expect(h.scheduler.list().map((j) => j.kind)).toEqual(["loop"]);
    });

    test("when it fires on another account or model than the one that hit the limit, it is skipped", () => {
        const { h, clock, runs, notices, setIdentity } = host();
        h.turnEnded("error", { resetsAt: clock.t + HOUR });
        // Switched without anyone telling the host.
        setIdentity("claude-code:a|acct-2");
        clock.advance(HOUR + MIN);
        expect(runs).toEqual([]);
        expect(h.scheduler.size).toBe(0);
        expect(notices.at(-1)).toMatch(/skipped: the account or model is not the one that reached the limit/);
        // A skipped resume isn't counted against the retries.
        setIdentity("claude-code:a|acct-1");
        for (let i = 0; i < MAX_RESUMES; i++) {
            h.turnEnded("error", { resetsAt: clock.t + HOUR });
            clock.advance(HOUR + MIN);
        }
        expect(runs.length).toBe(MAX_RESUMES);
    });

    test("on the same account and model it fires as before", () => {
        const { h, clock, runs } = host();
        h.turnEnded("error", { resetsAt: clock.t + HOUR });
        clock.advance(HOUR + MIN);
        expect(runs.map((r) => r.prompt)).toEqual([RESUME_PROMPT]);
    });
});

describe("saved with the session", () => {
    test("durable jobs round-trip through the session file; session-only ones don't", () => {
        const cwd = mkdtempSync(join(home, "proj-"));
        const session = Session.create(cwd);
        session.push({ role: "user", content: [{ type: "text", text: "hi" }] });
        const a = host({ session });
        createSchedule(a.h.scheduler, { cron: "0 9 * * 1-5", prompt: "standup", durable: true });
        createSchedule(a.h.scheduler, { cron: "0 10 * * *", prompt: "not kept" });
        a.h.loop("5m also not kept");
        const file = session.path;
        session.release();
        const lines = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
        const last = lines.filter((l) => l.t === "schedules").at(-1);
        expect(last.jobs.map((j: ScheduledJob) => j.prompt)).toEqual(["standup"]);

        const reopened = Session.load(file);
        expect(reopened.schedules.map((j) => j.prompt)).toEqual(["standup"]);
        const b = host({ session: reopened });
        b.h.restore();
        expect(b.h.scheduler.list().map((j) => j.prompt)).toEqual(["standup"]);
        reopened.release();
    });

    test("switching sessions stops this one's schedules without unsaving them", () => {
        const cwd = mkdtempSync(join(home, "proj-"));
        const first = Session.create(cwd);
        first.push({ role: "user", content: [{ type: "text", text: "hi" }] });
        const x = host({ session: first });
        createSchedule(x.h.scheduler, { cron: "0 9 * * *", prompt: "kept", durable: true });
        const second = Session.create(cwd, { persist: false });
        x.setSession(second);
        x.h.switchSession();
        expect(x.h.scheduler.size).toBe(0);
        expect(first.schedules.map((j) => j.prompt)).toEqual(["kept"]);
        first.release();
    });

    test("a fork doesn't take them", async () => {
        const cwd = mkdtempSync(join(home, "proj-"));
        const s = Session.create(cwd);
        s.push({ role: "user", content: [{ type: "text", text: "hi" }] });
        s.setSchedules([{ id: "abcd", kind: "cron", cron: "0 9 * * *", prompt: "p", recurring: true, durable: true, createdAt: 1, runs: 0 }]);
        const f = s.fork();
        expect(f.schedules).toEqual([]);
        s.release();
        f.release();
    });
});

describe("scheduled runs never overlap", () => {
    test("the next due job waits for the first one's run to settle, even before the host is busy", async () => {
        const clock = new FakeClock(Date.now());
        const started: string[] = [];
        let finish!: () => void;
        const h = new SessionSchedules({
            session: () => Session.create(home, { persist: false }),
            settings: () => ({}),
            // The host never says it's busy: only the scheduler's own guard holds the second one back.
            idle: () => true,
            run: (prompt) => {
                started.push(prompt);
                return new Promise<void>((r) => (finish = r));
            },
            notice: () => {},
            clock,
            index: false,
        });
        h.loop("5m a");
        h.loop("5m b");
        clock.advance(0);
        clock.advance(0);
        expect(started).toEqual(["a"]);
        finish();
        await Promise.resolve();
        await Promise.resolve();
        expect(started).toEqual(["a", "b"]);
        h.dispose();
    });
});

describe("the session file", () => {
    test("a line when a schedule changes, not every time one runs", () => {
        const cwd = mkdtempSync(join(home, "proj-"));
        const session = Session.create(cwd);
        session.push({ role: "user", content: [{ type: "text", text: "hi" }] });
        const x = host({ session });
        createSchedule(x.h.scheduler, { cron: "* * * * *", prompt: "tick", durable: true });
        const count = () => readFileSync(session.path, "utf-8").split("\n").filter((l) => l.includes('"t":"schedules"')).length;
        const before = count();
        x.clock.advance(30 * MIN);
        expect(x.runs.length).toBe(30);
        expect(count()).toBe(before);
        x.h.manage(`pause ${x.h.scheduler.list()[0]!.id}`);
        expect(count()).toBe(before + 1);
        session.release();
    });
});

describe("index of sessions with saved schedules", () => {
    test("note and forget", () => {
        noteScheduleIndex("20261020-090000-abcdef", "/tmp/x", true);
        expect(readScheduleIndex()["20261020-090000-abcdef"]?.cwd).toBe("/tmp/x");
        noteScheduleIndex("20261020-090000-abcdef", "/tmp/x", false);
        expect(readScheduleIndex()["20261020-090000-abcdef"]).toBeUndefined();
    });
});

describe("the model's tools", () => {
    test("create, list, delete", () => {
        const { h } = host();
        const c = createSchedule(h.scheduler, { cron: "57 8 * * 1-5", prompt: "run the tests" });
        expect(c.isError).toBeUndefined();
        expect(c.text).toMatch(/^Scheduled [0-9a-f]{8}: weekdays at 8:57 AM\. Next run: .*7 days/);
        const id = h.scheduler.list()[0]!.id;
        expect(listSchedules(h.scheduler).text).toContain(`${id}  weekdays at 8:57 AM (57 8 * * 1-5): next`);
        expect(deleteSchedule(h.scheduler, { id }).text).toMatch(/^Deleted/);
        expect(deleteSchedule(h.scheduler, { id }).isError).toBe(true);
        expect(listSchedules(h.scheduler).text).toBe("No schedules in this session.");
    });

    test("one-shot", () => {
        const { h } = host();
        const c = createSchedule(h.scheduler, { cron: "30 14 21 10 *", prompt: "check", recurring: false });
        expect(c.text).toMatch(/once, .*2:30/);
        expect(c.text).not.toMatch(/7 days/);
    });

    test("bad input comes back as an error the model can fix", () => {
        const { h } = host();
        expect(createSchedule(h.scheduler, { cron: "every day", prompt: "x" })).toMatchObject({ isError: true, text: expect.stringMatching(/^Invalid cron: A cron expression has 5 fields/) });
        expect(createSchedule(h.scheduler, { cron: "0 9 * * *", prompt: "" }).isError).toBe(true);
        expect(createSchedule(undefined, { cron: "0 9 * * *", prompt: "x" }).text).toMatch(/isn't available/);
        expect(deleteSchedule(h.scheduler, {}).isError).toBe(true);
    });

    test("cavvy tools read the session's scheduler from the tool state", async () => {
        const { h } = host();
        const ctx = { state: { scheduler: h.scheduler } } as never;
        const r = await CronCreateTool.run({ cron: "*/5 * * * *", prompt: "x" }, ctx);
        expect(r.isError).toBeUndefined();
        expect((await CronListTool.run({}, ctx)).display?.summary).toBe("1 schedule");
    });

    test("MCP tools for Claude Code and Codex do the same", async () => {
        const { h } = host();
        const tools = scheduleServerTools(() => h.scheduler);
        expect(tools.map((t) => t.name)).toEqual(["schedule_create", "schedule_list", "schedule_delete"]);
        expect(tools[0]!.description).not.toContain("CronDelete");
        const r = await tools[0]!.call({ cron: "0 9 * * *", prompt: "x" }, { signal: new AbortController().signal, meta: {} });
        expect(r.isError).toBeUndefined();
        expect((await tools[1]!.call({}, { signal: new AbortController().signal, meta: {} })).text).toContain("daily at 9:00 AM");
    });
});
