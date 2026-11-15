// Sub-agents of turns the window wasn't sent come as their list shows them (AgentRun.partial): a page of earlier turns
// brings its own whole, and opening one's view fetches it first, so the view's first frame has all of it.
import assert from "node:assert/strict";
import { Socket } from "../helpers/gui-socket";

Object.assign(globalThis, {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {} } } }),
});

const turns = Array.from({ length: 130 }, (_, i) => ({ id: `t${i}`, status: "done", blocks: [], prompt: { text: `prompt ${i}` }, pos: { seg: 0, index: 2 * i }, startedAt: 1000 + i }));
const whole = (id: string, turnId: string) => ({ id, turnId, status: "done", description: `does ${id}`, agentType: "general-purpose", startedAt: 1, toolCount: 2, tokens: 5, prompt: "the instructions", report: "what it found", blocks: [{ t: "text", id: `${id}-b`, text: "a step" }] });
const listed = (id: string, turnId: string) => { const { blocks: _b, prompt: _p, report: _r, ...rest } = whole(id, turnId); return { ...rest, blocks: [], partial: true }; };
const asked: string[] = [];

class ServerSocket extends Socket {
    send(raw: string) {
        super.send(raw);
        const { id, method, params } = JSON.parse(raw);
        const reply = (result: unknown) => queueMicrotask(() => this.message({ id, result }));
        asked.push(method);
        if (method === "session.open") reply({ seq: 0, state: { id: params.id, cwd: "/project", busy: false, interactions: [] }, turns: turns.slice(30), agents: [listed("early", "t5"), listed("middle", "t20"), whole("late", "t120")], earlier: 30 });
        else if (method === "session.turns") reply({ turns: turns.slice(10, 30), earlier: 10, seq: 0, agents: [whole("middle", "t20")] });
        else if (method === "session.agent") reply(params.agentId === "early" ? whole("early", "t5") : null);
        else if (method === "hello" || method === "settings.get") reply({});
        else if (method === "session.close" || method === "session.shown") reply(null);
        else reply([]);
    }
}
globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };

const { start, rpc, openSession, loadEarlier, agentReady } = await import("../../gui/src/state/app");
Object.assign(rpc, { credentials: async () => ({ url: "ws://test", token: "test" }) });
try {
    start();
    await settle();
    Socket.instances.at(-1)!.open();
    await settle();
    const h = await openSession("long");
    const agent = (id: string) => h.view.agents.find((a) => a.id === id)!;
    assert.equal(agent("late").partial, undefined);
    assert.equal(agent("early").partial, true);
    assert.equal(agent("middle").blocks.length, 0);
    // A page of earlier turns brings their sub-agents whole, in their place.
    assert.ok(await loadEarlier(h, { count: 20 }));
    assert.equal(agent("middle").partial, undefined);
    assert.equal(agent("middle").report, "what it found");
    assert.equal(h.view.agents.length, 3);
    // Opening one still partial fetches it first; one whole already, nothing.
    asked.length = 0;
    await agentReady("early");
    assert.deepEqual(asked, ["session.agent"]);
    assert.equal(agent("early").prompt, "the instructions");
    assert.equal(agent("early").blocks.length, 1);
    asked.length = 0;
    await agentReady("early");
    await agentReady("late");
    assert.deepEqual(asked, []);
} catch (e) {
    console.error(e);
    process.exit(1);
}
process.exit(0);
