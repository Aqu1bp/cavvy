// A session open but out of sight keeps only what opening it anew takes (or, left being read higher up, the pages down
// from there), as the one on screen lets go of its earlier turns once it's back at its end: one working all day out of
// sight kept every turn it did (a real run: about 190 KB a turn of sub-agent work, the window's heap climbing with it).
// The one on screen keeps what it has meanwhile, and so does the one shown just before while it's idle (parked).
import assert from "node:assert/strict";
import { Socket } from "../helpers/gui-socket";

Object.assign(globalThis, {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {} } } }),
    requestAnimationFrame: (fn: (at: number) => void) => setTimeout(() => fn(performance.now()), 0),
    cancelAnimationFrame: (n: ReturnType<typeof setTimeout>) => clearTimeout(n),
});

const turn = (sid: string, i: number) => ({ id: `${sid}-${i}`, status: "done", blocks: [{ t: "tool", id: `${sid}-${i}-b`, name: "Bash", title: "ls", category: "run", input: { command: "ls" }, status: "ok", output: "x".repeat(4000) }], prompt: { text: `prompt ${i}` }, pos: { seg: 0, index: 2 * i }, startedAt: 1000 + i });
let server: ServerSocket | undefined;
class ServerSocket extends Socket {
    send(raw: string) {
        super.send(raw);
        server = this;
        const { id, method, params } = JSON.parse(raw);
        const reply = (result: unknown) => queueMicrotask(() => this.message({ id, result }));
        if (method === "session.open") reply({ seq: 0, state: { id: params.id, cwd: "/project", busy: params.id !== "shown", interactions: [] }, turns: Array.from({ length: 10 }, (_, i) => turn(params.id, i)), agents: [] });
        else if (method === "hello" || method === "settings.get") reply({});
        else if (method === "session.close" || method === "session.shown") reply(null);
        else reply([]);
    }
}
globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };
const later = () => new Promise<void>((r) => setTimeout(r, 20));

const { start, rpc, openSession, activate, app, handleFor, OPEN_BYTES } = await import("../../gui/src/state/app");
const { transcriptPositions, TURN_PAGE } = await import("../../gui/src/lib/transcript-scroll");
/** What a session opened anew is sent of these turns (all the same size): as many as fit OPEN_BYTES, one at least. */
const KEEP = Math.ceil(OPEN_BYTES / JSON.stringify(turn("x", 99)).length);
assert.ok(KEEP > 1 && KEEP < TURN_PAGE, `${KEEP} turns`);
Object.assign(rpc, { credentials: async () => ({ url: "ws://test", token: "test" }) });
const seqs = new Map<string, number>();
/** `n` more turns done in session `sid`, one update each, as a session working through prompts sends them. */
async function work(sid: string, from: number, n: number) {
    for (let i = from; i < from + n; i++) {
        const seq = (seqs.get(sid) ?? 0) + 1;
        seqs.set(sid, seq);
        server!.message({ event: { type: "session.ops", sessionId: sid, seq, ops: [{ op: "turn", turn: turn(sid, i) }] } });
        await later();
    }
    // All in (the one on screen puts them in on its next step).
    const last = `${sid}-${from + n - 1}`;
    for (let t = Date.now(); handleFor(sid)?.view.turns.at(-1)?.id !== last; await later()) if (Date.now() - t > 5000) throw Error(`${last} never came`);
    await settle();
}
try {
    start();
    await settle();
    Socket.instances.at(-1)!.open();
    await settle();

    const shown = await openSession("shown");
    const away = await openSession("away");
    const read = await openSession("read");
    await activate("shown");
    await settle();
    assert.equal(app.activeId, "shown");

    // Out of sight, working on, left at its end: what opening it anew takes kept, the rest earlier turns (brought back as
    // it's scrolled up), not its whole last page.
    await work("away", 10, 90);
    assert.equal(away.view.turns.length, KEEP);
    assert.equal(away.view.earlier, 100 - KEEP);
    assert.equal(away.view.turns.at(-1)!.id, "away-99");

    // Left reading far up: the turns from the place read down stay.
    transcriptPositions.set("read", { bottom: false, top: 0, anchor: { turnId: "read-3", offset: 0 }, openWork: [] });
    await work("read", 10, 90);
    assert.equal(read.view.turns[0]!.id, "read-3", "the place read is kept");
    assert.equal(read.view.earlier, 3);

    // On screen: kept as it is (its view lets go of them, back at its end with nothing running).
    await work("shown", 10, 90);
    assert.equal(shown.view.turns.length, 100);
    assert.equal(shown.view.earlier, 0);

    // Switched away from: parked (Panes keeps it built out of sight, to be shown again as it was left), kept as it is.
    await activate("away");
    await settle();
    await later();
    assert.equal(shown.view.turns.length, 100);
    assert.equal(shown.view.earlier, 0);
    // The one switched to keeps what it has, and grows on screen.
    await work("away", 100, 5);
    assert.equal(away.view.turns.length, KEEP + 5);

    // Another switch: the one parked before is out of sight now, and keeps what opening it anew takes.
    await activate("read");
    await settle();
    await later();
    assert.equal(shown.view.turns.length, KEEP);
    assert.equal(shown.view.earlier, 100 - KEEP);
    // The one just left is working: Panes doesn't park it, so it's let go of at once, and as it goes on.
    assert.equal(away.view.turns.length, KEEP);
    await work("away", 105, 20);
    assert.equal(away.view.turns.length, KEEP);
    assert.equal(away.view.turns.at(-1)!.id, "away-124");
} finally {
    rpc.close();
}
process.exit(0);
