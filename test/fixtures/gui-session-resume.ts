// A window whose connection dropped asks for its open sessions again with what it had (session.open's `since`), all at
// once: one sent only what it missed carries on where it was (its turns as they were, those paged in kept); one sent
// a snapshot starts over from it.
import assert from "node:assert/strict";
import { Socket } from "../helpers/gui-socket";

Object.assign(globalThis, {
    requestAnimationFrame: (f: (t: number) => void) => setTimeout(() => f(performance.now()), 0),
    cancelAnimationFrame: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {} } } }),
});

const asked: { method: string; params: any }[] = [];
/** How session.open answers a window coming back: what it missed, or a snapshot. */
let back: "resume" | "snapshot" = "resume";
const turn = (id: string, text: string) => ({ id, status: "done", startedAt: 1, prompt: { text: "go" }, blocks: [{ t: "text", id: `${id}-r`, text }] });

class ServerSocket extends Socket {
    send(raw: string) {
        super.send(raw);
        const { id, method, params } = JSON.parse(raw);
        const reply = (result: unknown) => queueMicrotask(() => this.message({ id, result }));
        asked.push({ method, params });
        if (method === "session.open" && params.since && back === "resume") reply({ resumed: true, seq: 6, ops: [{ op: "append", turnId: "t2", blockId: "t2-r", field: "text", text: " and more" }, { op: "state", patch: { busy: false } }] });
        else if (method === "session.open") reply({ seq: params.since ? 9 : 4, epoch: params.since ? "e2" : "e1", state: { id: params.id, cwd: "/project", busy: true, interactions: [] }, turns: [turn("t2", params.since ? "fresh" : "streaming")], agents: [], earlier: 1 });
        else if (method === "session.turns") reply({ turns: [turn("t1", "earlier")], earlier: 0, seq: 4 });
        else if (method === "hello" || method === "settings.get") reply({});
        else if (method === "session.close" || method === "session.shown") reply(null);
        else reply([]);
    }
}
globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };
const opens = () => asked.filter((a) => a.method === "session.open");

const { start, rpc, openSession } = await import("../../gui/src/state/app");
Object.assign(rpc, { credentials: async () => ({ url: "ws://test", token: "test" }) });
try {
    start();
    await settle();
    Socket.instances.at(-1)!.open();
    await settle();
    const h = await openSession("s");
    assert.equal(h.epoch, "e1");
    // Paged up: an earlier turn in the window too.
    h.set("turns", (ts) => [turn("t1", "earlier") as any, ...ts]);
    h.set("earlier", 0);
    // An op as it streams, then the connection drops.
    Socket.instances.at(-1)!.message({ event: { type: "session.ops", sessionId: "s", seq: 5, ops: [{ op: "append", turnId: "t2", blockId: "t2-r", field: "text", text: " on" }] } });
    await settle();
    const shown = h.view.turns[1];
    Socket.instances.at(-1)!.close();
    assert.equal(h.ready(), false);

    // Back: asked with what it had, and sent only what it missed.
    rpc.reconnectNow();
    await settle();
    Socket.instances.at(-1)!.open();
    await settle();
    assert.deepEqual(opens().at(-1)!.params.since, { epoch: "e1", seq: 5 });
    assert.equal(h.ready(), true);
    assert.equal(h.seq, 6);
    assert.deepEqual(h.view.turns.map((t) => [t.id, (t.blocks[0] as { text: string }).text]), [["t1", "earlier"], ["t2", "streaming on and more"]]);
    // Carried on where it was: the same turn, not one made again.
    assert.equal(h.view.turns[1], shown);
    assert.equal(h.view.state.busy, false);

    // Back again, from a server that read the session in anew: from its snapshot.
    back = "snapshot";
    Socket.instances.at(-1)!.close();
    rpc.reconnectNow();
    await settle();
    Socket.instances.at(-1)!.open();
    await settle();
    assert.deepEqual(opens().at(-1)!.params.since, { epoch: "e1", seq: 6 });
    assert.equal(h.ready(), true);
    assert.equal(h.epoch, "e2");
    assert.equal(h.seq, 9);
    assert.deepEqual(h.view.turns.map((t) => [t.id, (t.blocks[0] as { text: string }).text]), [["t2", "fresh"]]);
} catch (e) {
    console.error(e);
    process.exit(1);
}
process.exit(0);
