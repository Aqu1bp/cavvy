// This machine's connection to one server's Cavvy for the sessions there (src/servers/watch.ts), against a server
// that sends what it likes: a server is the user's, but what runs on it may not be. Whatever it sends, only so much
// is kept and passed on, in the shapes the list expects.

import { afterEach, expect, test } from "bun:test";
import { openBoundedSocket } from "../src/servers/bounded-socket";
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
        for (let i = 0; i < 500; i++) send({ event: { type: "notify", sessionId: "s1", kind: "done", title: i ? 42 : "T".repeat(5000), body: ["x"] } });
        send({ event: { type: "sessions.upsert", session: { id: "end", title: "", status: "idle", updatedAt: 1 } } });
    });
    await until("everything to be heard", () => watch.overview().sessions.some((s) => s.id === "end"));
    expect(notices.length).toBe(6);
    expect(notices[0]).toEqual({ sessionId: "s1", kind: "done", title: `${"T".repeat(119)}…`, body: "" });
    expect(notices[1]).toEqual({ sessionId: "s1", kind: "done", title: "", body: "" });
});

test("turns ending don't use up what's kept for sessions that ask; past that, it's said once that more need the user", async () => {
    const { watch, notices } = serverSaying([], (send) => {
        // A run of sessions finishing together, then one that asks: the asking is passed on.
        for (let i = 0; i < 40; i++) send({ event: { type: "notify", sessionId: `done${i}`, kind: "done", title: "Finished", body: "" } });
        send({ event: { type: "notify", sessionId: "asks", kind: "permission", title: "Deploy", body: "Wants to run a command" } });
        // And a server that asks without end: a dozen, then one notice for all the rest.
        for (let i = 0; i < 300; i++) send({ event: { type: "notify", sessionId: `more${i}`, kind: "question", title: "Q", body: "" } });
        send({ event: { type: "sessions.upsert", session: { id: "end", title: "", status: "idle", updatedAt: 1 } } });
    });
    await until("everything to be heard", () => watch.overview().sessions.some((s) => s.id === "end"));
    expect(notices.filter((n) => n.kind === "done").length).toBe(6);
    expect(notices.find((n) => n.sessionId === "asks")).toEqual({ sessionId: "asks", kind: "permission", title: "Deploy", body: "Wants to run a command" });
    const asks = notices.filter((n) => n.kind !== "done");
    expect(asks.length).toBe(13);
    expect(asks.at(-1)).toEqual({ sessionId: "", kind: "question", title: "More sessions need you", body: "" });
});

test("nothing a server sends brings this machine's Cavvy down: what isn't a message is passed over", async () => {
    const { watch } = serverSaying([{ id: "s1", title: "one", status: "idle", updatedAt: 1 }], (send, raw) => {
        for (const text of ["null", "42", '"text"', "[]", "{", '{"event":null}', '{"event":7}', '{"event":{"type":"sessions.upsert","session":null}}', '{"event":{"type":"notify"}}', '{"id":1,"result":[{"id":"again"}]}']) raw(text);
        send({ event: { type: "sessions.upsert", session: { id: "s2", title: "two", status: "idle", updatedAt: 2 } } });
    });
    await until("what came after to be heard", () => watch.overview().sessions.length === 2);
    // The list is taken once: a second answer to it isn't a way to replace what's shown.
    expect(watch.overview().sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
});

test("a message bigger than a list of sessions ever is ends the connection before it's taken in, and it isn't made again for a while", async () => {
    const { watch, changes } = serverSaying([{ id: "s1", title: "one", status: "idle", updatedAt: 1 }], (_send, raw) => raw(JSON.stringify({ event: { type: "sessions.upsert", session: { id: "s2", title: "x".repeat(60 * 1024 * 1024) } } })));
    await until("it to be given up", () => watch.overview().state === "unreachable");
    const n = changes();
    await Bun.sleep(300);
    // Not at once again, as after a connection that just dropped (50 ms here). And nothing is shown of a server that
    // isn't heard from: what it last said of its sessions may no longer be so.
    expect([watch.overview().state, changes(), watch.overview().sessions]).toEqual(["unreachable", n, []]);
});

test("the size of a message is read from its first bytes: one over the limit is never taken in", async () => {
    const big = "x".repeat(64 * 1024 * 1024);
    const srv = Bun.serve({ port: 0, fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")), websocket: { message: (ws) => void ws.send(big) } });
    const closed = Promise.withResolvers<string>();
    const got: string[] = [];
    const s = openBoundedSocket({ port: srv.port!, path: "/ws", protocols: ["cavvy.v1"], maxMessage: 1024 * 1024, onOpen: () => s.send("go"), onMessage: (t) => void got.push(t), onClose: (why) => closed.resolve(why) });
    stops.push(() => void srv.stop(true));
    expect(await closed.promise).toBe("too-much");
    expect(got).toEqual([]);
    // What reached this end before it hung up: a few network buffers of a 64 MB message, not the message.
    expect(s.bytesIn).toBeLessThan(8 * 1024 * 1024);
});

test("an ordinary exchange over it: messages both ways, in pieces and whole, and a clean end", async () => {
    const heard: string[] = [];
    const srv = Bun.serve({
        port: 0,
        fetch: (req, s) => (s.upgrade(req, { headers: { "Sec-WebSocket-Protocol": "cavvy.v1" } }) ? undefined : new Response("no")),
        websocket: {
            message(ws, m) {
                heard.push(String(m));
                if (String(m) === "bye") return void ws.close();
                ws.send(`you said ${String(m).length} bytes`);
                ws.send("é".repeat(100_000));
            },
        },
    });
    stops.push(() => void srv.stop(true));
    const got: string[] = [];
    const closed = Promise.withResolvers<string>();
    const s = openBoundedSocket({ port: srv.port!, path: "/ws", protocols: ["cavvy.v1", "auth.t"], maxMessage: 1024 * 1024, onOpen: () => s.send("h".repeat(70_000)), onMessage: (t) => void (got.push(t), got.length === 2 && s.send("bye")), onClose: (why) => closed.resolve(why) });
    expect(await closed.promise).toBe("closed");
    expect([heard[0]!.length, heard[1], got[0], got[1]!.length]).toEqual([70_000, "bye", "you said 70000 bytes", 100_000]);
    // Nowhere to connect to: said, not thrown.
    const none = Promise.withResolvers<string>();
    openBoundedSocket({ port: 1, path: "/ws", protocols: [], maxMessage: 1024, onOpen: () => {}, onMessage: () => {}, onClose: (why) => none.resolve(why) });
    expect(await none.promise).toBe("failed");
});
