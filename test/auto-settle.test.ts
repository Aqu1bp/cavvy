import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { SessionOp, SessionState, SessionSummary, Turn } from "../src/server/protocol";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { Runtime } = await import("../src/server/runtime");
const { Session } = await import("../src/agent/session");
const { applyOp } = await import("../src/server/timeline");
const { autoSettleDays, notePlay, settleDue, DEFAULT_AUTO_SETTLE_DAYS } = await import("../src/server/auto-settle");
afterAll(() => iso.cleanup());
// Each test with its own sessions and settings.
beforeEach(() => {
    for (const f of ["gui.json", "settings.json", "projects"]) rmSync(join(process.env.CAVVY_HOME!, f), { recursive: true, force: true });
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("which are due", () => {
    const now = 100 * DAY;
    const s = (id: string, idle: number, o: Partial<Parameters<typeof settleDue>[0][number]> = {}) => ({ id, updatedAt: now - idle, status: "idle" as const, pinned: false, settled: false, archived: false, ...o });

    test("idle the days or more; never pinned, working, waiting, snoozed, kept in play, settled or archived", () => {
        const list = [
            s("old", 8 * DAY),
            s("new", 2 * DAY),
            s("pinned", 30 * DAY, { pinned: true }),
            s("running", 30 * DAY, { status: "running" }),
            s("busy", 30 * DAY, { busy: true }),
            s("waiting", 30 * DAY, { status: "waiting" }),
            s("failed", 30 * DAY, { status: "error" }),
            s("snoozed", 30 * DAY, { snoozedUntil: now + HOUR }),
            s("kept", 30 * DAY),
            s("settled", 30 * DAY, { settled: true }),
            s("archived", 30 * DAY, { archived: true }),
        ];
        const r = settleDue(list, { neverSettle: ["kept"] }, 7, now);
        expect(r.due).toEqual(["old", "failed"]);
        // The next: the one idle two days, in five.
        expect(r.next).toBe(now + 5 * DAY);
    });

    test("brought back into play, its idle time starts again; one on screen waits; off settles none", () => {
        const store = {};
        notePlay(store, "back", now - DAY);
        expect(settleDue([s("back", 30 * DAY)], store, 7, now)).toEqual({ due: [], next: now + 6 * DAY });
        expect(settleDue([s("shown", 30 * DAY, { shown: true })], {}, 7, now)).toEqual({ due: [], next: now + HOUR });
        expect(settleDue([s("old", 30 * DAY)], {}, 0, now)).toEqual({ due: [] });
    });

    test("the setting: one of its values, else a week", () => {
        expect(autoSettleDays(undefined)).toBe(DEFAULT_AUTO_SETTLE_DAYS);
        expect(DEFAULT_AUTO_SETTLE_DAYS).toBe(7);
        expect(autoSettleDays(0)).toBe(0);
        expect(autoSettleDays(14)).toBe(14);
        expect(autoSettleDays(5)).toBe(7);
        expect(autoSettleDays("3")).toBe(7);
    });

    test("old entries of when each was brought back are dropped as another is noted", () => {
        const store = { inPlay: { gone: now - 20 * DAY, kept: now - DAY } };
        notePlay(store, "new", now);
        expect(store.inPlay).toEqual({ kept: now - DAY, new: now });
    });
});

function setup() {
    let t = Date.now();
    const timers: { at: number; fn: () => void }[] = [];
    const engine = new Engine({ listModels: async () => [], now: () => t });
    const alarm = (engine as unknown as { alarm: { o: Record<string, unknown> } }).alarm;
    Object.assign(alarm.o, {
        setTimer: (fn: () => void, ms: number) => (timers.push({ at: t + ms, fn }), timers.length as unknown as ReturnType<typeof setTimeout>),
        clearTimer: (id: number) => (timers[id - 1] = { at: Infinity, fn: () => {} }),
    });
    const advance = (ms: number) => {
        const end = t + ms;
        for (;;) {
            const next = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
            if (!next) break;
            t = next.at;
            next.at = Infinity;
            next.fn();
        }
        t = end;
    };
    const rows: SessionSummary[] = [];
    const client = { subs: new Set<string>(), send: (e: { type: string; session?: SessionSummary }) => e.type === "sessions.upsert" && rows.push(e.session!) };
    engine.clients.add(client as never);
    const call = (method: string, params: unknown) => engine.handle(client as never, method as never, params);
    /** A saved session last at work `ago` ms ago. */
    const saved = (ago: number) => {
        const s = Session.create(realpathSync(tempDir()));
        s.push({ role: "user", content: [{ type: "text", text: "Saved one" }] });
        s.push({ role: "assistant", content: [{ type: "text", text: "Done." }] } as never);
        s.release();
        utimesSync(s.path, (t - ago) / 1000, (t - ago) / 1000);
        return s.meta.id;
    };
    const row = (id: string) => engine.listSessions().find((s) => s.id === id);
    const sweep = () => (engine as unknown as { sweep(): void }).sweep();
    const pending = () => timers.filter((x) => x.at !== Infinity).map((x) => x.at - t);
    return { engine, call, saved, row, rows, sweep, advance, pending, client };
}

describe("settling idle sessions", () => {
    test("by default a week idle is settled at start, in one go; pinned and kept-in-play ones stay", async () => {
        const { engine, call, saved, row, rows, sweep } = setup();
        const old = saved(8 * DAY);
        const recent = saved(2 * DAY);
        const pinned = saved(30 * DAY);
        const kept = saved(30 * DAY);
        await call("session.pin", { id: pinned, pinned: true });
        await call("session.neverSettle", { id: kept, on: true });
        expect(row(kept)?.neverSettle).toBe(true);
        sweep();
        expect(row(old)?.settled).toBe(true);
        expect(rows.findLast((r) => r.id === old)?.settled).toBe(true);
        expect([recent, pinned, kept].map((id) => row(id)?.settled)).toEqual([false, false, false]);
        await engine.stop();
    });

    test("one settled by itself and put back in play isn't settled again until it's idle that long again", async () => {
        const { engine, call, saved, row, sweep, advance } = setup();
        const id = saved(8 * DAY);
        sweep();
        expect(row(id)?.settled).toBe(true);
        await call("session.settle", { id, settled: false });
        sweep();
        expect(row(id)?.settled).toBe(false);
        advance(7 * DAY);
        expect(row(id)?.settled).toBe(true);
        await engine.stop();
    });

    test("off settles nothing; a shorter setting settles what's idle that long at once; a bad one is refused", async () => {
        const { engine, call, saved, row } = setup();
        const id = saved(4 * DAY);
        const logs: string[] = [];
        engine.log = (m: string) => void logs.push(m);
        await call("settings.update", { patch: { autoSettleDays: 0 } });
        expect(row(id)?.settled).toBe(false);
        expect(((await call("settings.get", {})) as { autoSettleDays: number }).autoSettleDays).toBe(0);
        await call("settings.update", { patch: { autoSettleDays: 3 } });
        expect(row(id)?.settled).toBe(true);
        expect(logs).toContain("Settled 1 session idle 3 days or more");
        const day = saved(2 * DAY);
        await call("settings.update", { patch: { autoSettleDays: 1 } });
        expect(row(day)?.settled).toBe(true);
        expect(logs).toContain("Settled 1 session idle 1 day or more");
        expect(call("settings.update", { patch: { autoSettleDays: 5 } })).rejects.toThrow("autoSettleDays must be one of");
        await engine.stop();
    });

    test("the one timer waits for the next due, checked again within hours when nothing is snoozed", async () => {
        const { engine, saved, sweep, pending, row, advance } = setup();
        const id = saved(6 * DAY + 23 * HOUR);
        sweep();
        expect(pending()).toEqual([HOUR]);
        advance(HOUR);
        expect(row(id)?.settled).toBe(true);
        expect(pending()).toEqual([]);
        await engine.stop();
    });

    test("a known merged pull request settles an idle session once; not a working one", async () => {
        const { engine, call, row } = setup();
        const session = Session.create(tempDir());
        session.push({ role: "user", content: [{ type: "text", text: "Open one" }] });
        const view = { state: { status: "idle", interactions: [] } as unknown as SessionState, turns: [] as Turn[], agents: [] };
        const rt = Object.assign(Object.create(Runtime.prototype), {
            engine, session, ws: { cwd: session.meta.cwd, settings: {} }, view, busy: false,
            lastActive: Date.now(), pending: new Map(), schedules: { poke() {} }, stepsDirty: new Map(), agentsDirty: new Map(), outbox: [],
            op: (op: SessionOp) => applyOp(view, op),
        });
        Object.defineProperty(rt, "idle", { get: () => !rt.busy });
        engine.runtimes.set(rt.id, rt);
        rt.busy = true;
        engine.prEnded(rt);
        expect(row(rt.id)?.settled).toBe(false);
        rt.busy = false;
        engine.prEnded(rt);
        expect(row(rt.id)?.settled).toBe(true);
        await call("session.settle", { id: rt.id, settled: false });
        engine.prEnded(rt);
        expect(row(rt.id)?.settled).toBe(false);
        await engine.stop();
    });
});
