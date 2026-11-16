// What the server sends on a socket goes out in order, and none of it is dropped (src/server/ws-send.ts): Bun drops a
// message sent while the socket holds more than it will take.
import { expect, test } from "bun:test";
import { orderedSender } from "../src/server/ws-send";

/** A socket that takes `room` more sends, then drops (0) until drained. */
function sink(room: number) {
    const got: string[] = [];
    let closed: string | undefined;
    const ws = {
        room,
        send(d: string | Uint8Array) {
            if (this.room <= 0) return 0;
            this.room--;
            got.push(String(d));
            return 1;
        },
        close(_code?: number, reason?: string) { closed = reason; },
    };
    return { ws, got, closed: () => closed };
}

test("what the socket won't take waits, and everything after it, then goes in order as it drains", () => {
    const s = sink(1);
    const out = orderedSender(s.ws);
    out.send("big");
    out.send("reply");
    out.send("ops");
    expect(s.got).toEqual(["big"]);
    expect(out.queued).toBe("reply".length + "ops".length);
    s.ws.room = 1;
    out.drain();
    expect(s.got).toEqual(["big", "reply"]);
    // Something new while one still waits: after it, never before.
    out.send("later");
    expect(s.got).toEqual(["big", "reply"]);
    s.ws.room = 5;
    out.drain();
    expect(s.got).toEqual(["big", "reply", "ops", "later"]);
    expect(out.queued).toBe(0);
});

test("a socket so far behind that what waits passes the bound is closed, rather than this growing", () => {
    const s = sink(0);
    const out = orderedSender(s.ws, 10);
    out.send("12345");
    out.send("67890");
    expect(s.closed()).toBeUndefined();
    out.send("x");
    expect(s.closed()).toBe("Too far behind; reconnect");
    expect(out.queued).toBe(0);
    s.ws.room = 5;
    out.send("after");
    out.drain();
    expect(s.got).toEqual([]);
});

test("through a real socket, a small message sent right after a big one arrives, after it", async () => {
    let out: ReturnType<typeof orderedSender> | undefined;
    const big = "x".repeat(30 * 1024 * 1024);
    const srv = Bun.serve({
        port: 0,
        fetch: (req, s) => (s.upgrade(req) ? undefined : new Response()),
        websocket: {
            maxPayloadLength: 48 * 1024 * 1024,
            open(ws) {
                out = orderedSender(ws);
                out.send(big);
                out.send("small-after");
            },
            drain() { out?.drain(); },
            message() {},
        },
    });
    try {
        const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
        const got: number[] = [];
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`only ${got.length} arrived`)), 20_000);
            ws.onmessage = (m) => {
                got.push(String(m.data).length);
                if (String(m.data) === "small-after") (clearTimeout(timer), resolve());
            };
        });
        expect(got).toEqual([big.length, "small-after".length]);
        ws.close();
    } finally {
        srv.stop(true);
    }
}, 30_000);

test("streamed text for another machine goes in fewer messages, in order, and nothing else waits", async () => {
    const { streamCoalescer } = await import("../src/server/ws-send");
    const sent: any[] = [];
    const c = streamCoalescer((ev) => sent.push(ev), 40, 30);
    const text = (seq: number, t: string, blockId = "b1") => ({ type: "session.ops", sessionId: "s", seq, ops: [{ op: "append", turnId: "t", blockId, field: "text", text: t }] });
    // The first words after a quiet spell go at once.
    c.send(text(1, "Hello"));
    expect(sent.map((e) => e.seq)).toEqual([1]);
    // Then held, a block's text as one append, with the last seq.
    c.send(text(2, " wor"));
    c.send(text(3, "ld"));
    expect(sent).toHaveLength(1);
    await Bun.sleep(60);
    expect(sent[1]).toEqual({ type: "session.ops", sessionId: "s", seq: 3, ops: [{ op: "append", turnId: "t", blockId: "b1", field: "text", text: " world" }] });
    // Enough held goes at once.
    c.send(text(4, "x".repeat(10)));
    c.send(text(5, "y".repeat(25)));
    expect(sent[2]).toMatchObject({ seq: 5, ops: [{ text: "x".repeat(10) + "y".repeat(25) }] });
    // Anything that isn't text (a status, a question) goes at once, after what's held: never before it.
    c.send(text(6, "!", "b2"));
    c.send({ type: "session.ops", sessionId: "s", seq: 7, ops: [{ op: "state", patch: { status: "idle" } }] });
    expect(sent.slice(3).map((e) => e.seq)).toEqual([6, 7]);
    // A reply to a request: what's held first (the server calls flush before it).
    c.send(text(8, "a"));
    c.send(text(9, "b"));
    c.flush();
    expect(sent.at(-1)).toMatchObject({ seq: 9, ops: [{ text: "ab" }] });
    await Bun.sleep(60);
    expect(sent.at(-1).seq).toBe(9);
});
