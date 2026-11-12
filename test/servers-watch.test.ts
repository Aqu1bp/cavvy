// This machine's connection to one server's Cavvy for the sessions there (src/servers/watch.ts), against a server
// that sends what it likes: a server is the user's, but what runs on it may not be. Whatever it sends, only so much
// is kept and passed on, in the shapes the list expects.

import { afterEach, expect, test } from "bun:test";
import { heardSession, MachineWatch, type MachineNotice } from "../src/servers/watch";

type Sent = (send: (v: unknown) => void, raw: (text: string) => void) => void;
const stops: (() => void)[] = [];
afterEach(() => {
    for (const stop of stops.splice(0)) stop();
});

/** A stand-in for a server's Cavvy: answers the list with `list`, then does `then`. */
function serverSaying(list: unknown, then: Sent = () => {}) {
    const srv = Bun.serve({
        port: 0,
        fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
        websocket: {
            message(ws, raw) {
                const m = JSON.parse(String(raw));
                if (m.method !== "sessions.list") return;
                ws.send(JSON.stringify({ id: m.id, result: list }));
                then((v) => ws.send(JSON.stringify(v)), (text) => ws.send(text));
            },
        },
    });
    const notices: MachineNotice[] = [];
    let changes = 0;
    const watch = new MachineWatch("box", { reach: async () => ({ status: "connected", url: `ws://127.0.0.1:${srv.port}/ws`, token: "t" }), changed: () => changes++, notice: (n) => notices.push(n), retryMs: [50], idleRetryMs: 60_000 });
    stops.push(() => {
        watch.stop();
        void srv.stop(true);
    });
    watch.start();
    return { watch, notices, changes: () => changes };
}

async function until(what: string, ok: () => boolean, ms = 10_000) {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (ok()) return;
    throw new Error(`timed out waiting for ${what}`);
}

test("a session a server describes is taken apart and put together again: its own fields, cut to size", () => {
    expect(heardSession({ id: "20261113-101010-abc123", title: "Fix it", cwd: "/srv/app", projectName: "app", status: "waiting", updatedAt: 5, createdAt: 1, messages: 2, archived: false, settled: false, live: true, pinned: true, model: "x:y", extra: { big: "x".repeat(1000) } })).toEqual({
        id: "20261113-101010-abc123",
        title: "Fix it",
        cwd: "/srv/app",
        projectName: "app",
        status: "waiting",
        updatedAt: 5,
        createdAt: 1,
        messages: 2,
        archived: false,
        settled: false,
        live: true,
        // This machine's own marks aren't a server's to set.
        pinned: false,
    });
    const odd = heardSession({ id: "s1", title: "x".repeat(5000), cwd: 7, status: "made-up", updatedAt: "now" })!;
    expect([odd.title.length, odd.cwd, odd.status, odd.updatedAt]).toEqual([200, "", "idle", 0]);
    for (const not of [null, "s1", {}, { id: 5 }, { id: "../x" }, { id: "a b" }, { id: "x".repeat(121) }]) expect(heardSession(not)).toBeUndefined();
});

test("however many sessions a server lists or sends later, and however long their words, only so much is kept and shown", async () => {
    const big = "x".repeat(100_000);
    const { watch } = serverSaying(
        // Fifty times what was asked for, in one answer that's still small enough to be read.
        Array.from({ length: 5000 }, (_, i) => ({ id: `s${i}`, title: "x".repeat(300), status: "idle", updatedAt: i })),
        (send) => {
            for (let i = 0; i < 40; i++) send({ event: { type: "sessions.upsert", session: { id: `late${i}`, title: big, cwd: big, status: "waiting", updatedAt: 10_000 + i } } });
            send({ event: { type: "sessions.upsert", session: { id: "last", title: "The last one", status: "waiting", updatedAt: 99_999 } } });
        },
    );
    await until("the last one to be heard", () => watch.overview().sessions[0]?.id === "last");
    const o = watch.overview();
    expect(o.sessions.length).toBe(20);
    // Those not shown are counted, up to what's kept: never more than a few hundred sessions in all.
    expect(o.sessions.length + o.more!).toBe(300);
    expect(JSON.stringify(o).length).toBeLessThan(20_000);
});

test("what a server's sessions have to say is passed on a few times a minute at most, and only when it's a notice", async () => {
    const { watch, notices } = serverSaying([], (send) => {
        // Not ones: no session, a kind nobody knows, a background task's.
        send({ event: { type: "notify", sessionId: { not: "a string" }, kind: "done", title: "t", body: "b" } });
        send({ event: { type: "notify", sessionId: "s1", kind: "anything", title: "t", body: "b" } });
        send({ event: { type: "notify", sessionId: "s1", kind: "background", title: "t", body: "b" } });
        for (let i = 0; i < 500; i++) send({ event: { type: "notify", sessionId: "s1", kind: "permission", title: i ? 42 : "T".repeat(5000), body: ["x"] } });
        send({ event: { type: "sessions.upsert", session: { id: "end", title: "", status: "idle", updatedAt: 1 } } });
    });
    await until("everything to be heard", () => watch.overview().sessions.some((s) => s.id === "end"));
    expect(notices.length).toBe(6);
    expect(notices[0]).toEqual({ sessionId: "s1", kind: "permission", title: `${"T".repeat(119)}…`, body: "" });
    expect(notices[1]).toEqual({ sessionId: "s1", kind: "permission", title: "", body: "" });
});

test("a message bigger than a list of sessions ever is ends the connection, which isn't made again for a while", async () => {
    const { watch, changes } = serverSaying([{ id: "s1", title: "one", status: "idle", updatedAt: 1 }], (_send, raw) => raw(JSON.stringify({ event: { type: "sessions.upsert", session: { id: "s2", title: "x".repeat(5 * 1024 * 1024) } } })));
    await until("it to be given up", () => watch.overview().state === "unreachable");
    const n = changes();
    await Bun.sleep(300);
    // Not at once again, as after a connection that just dropped (50 ms here). And nothing is shown of a server that
    // isn't heard from: what it last said of its sessions may no longer be so.
    expect([watch.overview().state, changes(), watch.overview().sessions]).toEqual(["unreachable", n, []]);
});
