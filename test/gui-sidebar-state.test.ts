import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { app, refreshSessions, rpc, setApp, start } from "../gui/src/state/app";
import type { ServerEvent, SessionSummary } from "../src/server/protocol";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {} } });
Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {} } });
let event!: (e: ServerEvent) => void;
const onEvent = spyOn(rpc, "onEvent").mockImplementation((fn) => { event = fn; return () => {}; });
const onState = spyOn(rpc, "onState").mockImplementation(() => () => {});
const onSlow = spyOn(rpc, "onSlow").mockImplementation(() => () => {});
const connect = spyOn(rpc, "connect").mockResolvedValue(undefined);
start();
for (const spy of [onEvent, onState, onSlow, connect]) spy.mockRestore();
if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
else Reflect.deleteProperty(globalThis, "document");
if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
else Reflect.deleteProperty(globalThis, "window");

const original = { conn: app.conn, sessionsError: app.sessionsError, sessionsLoaded: app.sessionsLoaded, sessions: [...app.sessions], archived: [...app.archived], activeId: app.activeId, seen: { ...app.seen } };
afterEach(() => setApp({ conn: original.conn, sessionsError: false, sessionsLoaded: false, sessions: [], archived: [], activeId: undefined, seen: {} }));
afterAll(() => setApp(original));
const s = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({ id, cwd: "/project", projectName: "project", title: id,
    createdAt: 1, updatedAt: 1, messages: 2, status: "idle", pinned: false, settled: false, archived: false, live: true, ...patch });

test("real upserts sort activity/status, clear omitted optional fields, and move between lists", () => {
    event({ type: "sessions.upsert", session: s("new", { updatedAt: 10 }) });
    event({ type: "sessions.upsert", session: s("old") });
    expect(app.sessions.map((s) => s.id)).toEqual(["new", "old"]);
    event({ type: "sessions.upsert", session: s("old", { status: "waiting", waitingKind: "plan", turnStartedAt: 50 }) });
    expect(app.sessions.map((s) => s.id)).toEqual(["old", "new"]);
    event({ type: "sessions.upsert", session: s("old") });
    expect(app.sessions.map((s) => s.id)).toEqual(["new", "old"]);
    expect(app.sessions[1]!.waitingKind).toBeUndefined();
    expect(app.sessions[1]!.turnStartedAt).toBeUndefined();
    event({ type: "sessions.upsert", session: s("old", { archived: true }) });
    expect(app.sessions.map((s) => s.id)).toEqual(["new"]);
    expect(app.archived.map((s) => s.id)).toEqual(["old"]);
});

test("refresh retains an open summary outside the server window but respects deletion", async () => {
    setApp({ sessions: [s("open")], activeId: "open", seen: { open: 1 } });
    const call = spyOn(rpc, "call").mockImplementation(async (_method: any, params: any) => params.archived ? [] : [s("new", { updatedAt: 10 })]);
    try {
        await refreshSessions();
        expect(app.sessions.map((s) => s.id)).toEqual(["new", "open"]);
        event({ type: "sessions.remove", id: "open" });
        await refreshSessions();
        expect(app.sessions.map((s) => s.id)).toEqual(["new"]);
    } finally { call.mockRestore(); }
});

test("sessions become loaded only after both lists apply and stay loaded while refreshing", async () => {
    setApp("sessionsLoaded", false);
    const pending: Array<(rows: SessionSummary[]) => void> = [];
    const call = spyOn(rpc, "call").mockImplementation(() => new Promise((resolve) => pending.push(resolve)) as any);
    try {
        const first = refreshSessions();
        expect(app.sessionsLoaded).toBe(false);
        pending[0]!([s("existing")]);
        await Promise.resolve();
        expect(app.sessionsLoaded).toBe(false);
        pending[1]!([]);
        await first;
        expect(app.sessionsLoaded).toBe(true);
        expect(app.sessions.map((s) => s.id)).toEqual(["existing"]);
        const reconnect = refreshSessions();
        expect(app.sessionsLoaded).toBe(true);
        expect(app.sessions.map((s) => s.id)).toEqual(["existing"]);
        pending[2]!([]);
        pending[3]!([]);
        await reconnect;
        expect(app.sessionsLoaded).toBe(true);
        expect(app.sessions).toEqual([]);
    } finally { call.mockRestore(); }
});

for (const archived of [false, true]) {
    test(`failure of the ${archived ? "archived" : "active"} list is recorded and a successful retry clears it`, async () => {
        setApp("conn", "open");
        let fail = true;
        const error = new Error("List failed");
        const call = spyOn(rpc, "call").mockImplementation(async (_method: any, params: any) => {
            if (fail && !!params.archived === archived) throw error;
            return [s(params.archived ? "archived" : "active", { archived: !!params.archived })];
        });
        try {
            await expect(refreshSessions()).rejects.toBe(error);
            expect(app.conn).toBe("open");
            expect(app.sessionsLoaded).toBe(false);
            expect(app.sessionsError).toBe(true);
            expect(app.sessions).toEqual([]);
            expect(app.archived).toEqual([]);
            fail = false;
            await refreshSessions();
            expect(app.sessionsLoaded).toBe(true);
            expect(app.sessionsError).toBe(false);
            expect(app.sessions.map((s) => s.id)).toEqual(["active"]);
            expect(app.archived.map((s) => s.id)).toEqual(["archived"]);
            fail = true;
            await expect(refreshSessions()).rejects.toBe(error);
            expect(app.sessionsLoaded).toBe(true);
            expect(app.sessionsError).toBe(true);
            expect(app.sessions.map((s) => s.id)).toEqual(["active"]);
            expect(app.archived.map((s) => s.id)).toEqual(["archived"]);
        } finally { call.mockRestore(); }
    });
}
