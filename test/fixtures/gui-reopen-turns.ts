// A long session read with "Show earlier", opened again: on a reconnect, a reload, and after the window let it go.
import assert from "node:assert/strict";
import { Socket } from "../helpers/gui-socket";

Object.assign(globalThis, {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {} } } }),
});

/** Each session's turn count on the server. */
const sessions = new Map<string, number>([["long", 130]]);
const turnsOf = (id: string) => Array.from({ length: sessions.get(id) ?? 0 }, (_, i) => ({ id: `${id}-${i}`, status: "done", blocks: [] }));
/** What each session.open asked for. */
const opens: { id: string; last?: number }[] = [];
let server: ServerSocket | undefined;

class ServerSocket extends Socket {
    send(raw: string) {
        super.send(raw);
        server = this;
        const { id, method, params } = JSON.parse(raw);
        const reply = (result: unknown) => queueMicrotask(() => this.message({ id, result }));
        if (method === "session.open") {
            opens.push({ id: params.id, last: params.last });
            const all = turnsOf(params.id);
            const from = Math.max(0, all.length - (params.last ?? all.length));
            reply({ seq: 0, state: { id: params.id, cwd: "/project", busy: false, interactions: [] }, turns: all.slice(from), agents: [], ...(from ? { earlier: from } : {}) });
        } else if (method === "session.turns") {
            const all = turnsOf(params.id);
            const at = all.findIndex((t) => t.id === params.before);
            const from = params.all ? 0 : Math.max(0, at - (params.count ?? 40));
            reply({ turns: all.slice(from, at), earlier: from, seq: 0 });
        } else if (method === "hello" || method === "settings.get") reply({});
        else if (method === "session.close" || method === "session.shown") reply(null);
        else reply([]);
    }
}
globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };

const { start, rpc, openSession, loadEarlier, loadEarlierTo, handleFor } = await import("../../gui/src/state/app");
Object.assign(rpc, { credentials: async () => ({ url: "ws://test", token: "test" }) });
const lastOpen = () => opens.filter((o) => o.id === "long").at(-1)!;
try {
    start();
    await settle();
    Socket.instances.at(-1)!.open();
    await settle();

    // Opened: its last 100 turns. Read back to its first with "Show earlier".
    const h = await openSession("long");
    assert.equal(lastOpen().last, 100);
    assert.equal(h.view.turns.length, 100);
    assert.equal(h.view.earlier, 30);
    assert.ok(await loadEarlier(h, { count: 40 }));
    assert.equal(h.view.turns.length, 130);
    assert.equal(h.view.earlier, 0);

    // The connection drops and comes back: the session comes again with every turn the window had.
    Socket.instances.at(-1)!.close();
    rpc.reconnectNow();
    await settle();
    Socket.instances.at(-1)!.open();
    await settle();
    assert.equal(opens.filter((o) => o.id === "long").length, 2, "opened again on the reconnect");
    assert.ok(lastOpen().last! >= 130, `a reconnect asks for the turns the window had, not ${lastOpen().last}`);
    assert.equal(h.view.turns.length, 130);
    assert.equal(h.view.turns[0]!.id, "long-0", "the turns read with Show earlier are still there");

    // Reloaded by the server (a failed delete closed it): the same.
    server!.message({ event: { type: "session.reload", sessionId: "long" } });
    await settle();
    assert.equal(opens.filter((o) => o.id === "long").length, 3);
    assert.ok(lastOpen().last! >= 130, `a reload asks for the turns the window had, not ${lastOpen().last}`);
    assert.equal(h.view.turns[0]!.id, "long-0");

    // Eight other sessions opened since: the window lets it go. Three turns come meanwhile.
    h.lastUsed = 0;
    for (let i = 0; i < 8; i++) {
        sessions.set(`other-${i}`, 3);
        await openSession(`other-${i}`);
    }
    await settle();
    assert.equal(handleFor("long"), undefined, "let go of");
    sessions.set("long", 133);
    const again = await openSession("long");
    assert.ok(lastOpen().last! >= 130, `picked again, it's asked for the turns the window had, not ${lastOpen().last}`);
    assert.equal(again.view.turns.length, 130);
    // The place read was in a turn the new ones pushed out: brought back first.
    assert.ok(!again.view.turns.some((t) => t.id === "long-1"));
    assert.ok(await loadEarlierTo(again, "long-1"));
    assert.ok(again.view.turns.some((t) => t.id === "long-1"));
    assert.equal(again.view.turns[0]!.id, "long-0");
    // One that isn't there at all: false, not a loop.
    assert.equal(await loadEarlierTo(again, "gone"), false);
} finally {
    rpc.close();
}
process.exit(0);
