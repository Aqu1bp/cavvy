// Sub-agents of turns the window wasn't sent are counted (agentsMore), or come as their list shows them when they're a
// background task (AgentRun.partial): a page of earlier turns brings its own whole, the Agents list's fold asks for the
// rest as they're listed, and opening one's view fetches it first, so the view's first frame has all of it.
import assert from "node:assert/strict";
import { Socket } from "../helpers/gui-socket";

Object.assign(globalThis, {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {} } } }),
});

const turns = Array.from({ length: 130 }, (_, i) => ({ id: `t${i}`, status: "done", blocks: [], prompt: { text: `prompt ${i}` }, pos: { seg: 0, index: 2 * i }, startedAt: 1000 + i }));
const whole = (id: string, turnId: string, status = "done") => ({ id, turnId, status, description: `does ${id}`, agentType: "general-purpose", startedAt: 1, toolCount: 2, tokens: 5, prompt: "the instructions", report: "what it found", blocks: [{ t: "text", id: `${id}-b`, text: "a step" }] });
const listed = (id: string, turnId: string, status = "done") => { const { blocks: _b, prompt: _p, report: _r, ...rest } = whole(id, turnId, status); return { ...rest, blocks: [], partial: true }; };
const asked: string[] = [];

class ServerSocket extends Socket {
    send(raw: string) {
        super.send(raw);
        const { id, method, params } = JSON.parse(raw);
        const reply = (result: unknown) => queueMicrotask(() => this.message({ id, result }));
        asked.push(method);
        if (method === "session.open") reply({ seq: 0, state: { id: params.id, cwd: "/project", busy: false, interactions: [] }, turns: turns.slice(30), agents: [{ ...listed("task", "t3"), taskId: "task-1" }, whole("late", "t120")], earlier: 30, agentsMore: { count: 3, failed: 1 } });
        else if (method === "session.turns") reply({ turns: turns.slice(10, 30), earlier: 10, seq: 0, agents: [whole("middle", "t20", "failed")] });
        else if (method === "session.agentList") reply([listed("early", "t5"), listed("broke", "t6"), { ...listed("task", "t3"), taskId: "task-1" }, listed("middle", "t20", "failed"), listed("late", "t120")]);
        else if (method === "session.agent") reply(params.agentId === "early" ? whole("early", "t5") : null);
        else if (method === "hello" || method === "settings.get") reply({});
        else if (method === "session.close" || method === "session.shown") reply(null);
        else reply([]);
    }
}
globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };

const { start, rpc, openSession, loadEarlier, agentReady, loadAgentList } = await import("../../gui/src/state/app");
Object.assign(rpc, { credentials: async () => ({ url: "ws://test", token: "test" }) });
try {
    start();
    await settle();
    Socket.instances.at(-1)!.open();
    await settle();
    const h = await openSession("long");
    const agent = (id: string) => h.view.agents.find((a) => a.id === id)!;
    assert.equal(agent("late").partial, undefined);
    assert.equal(agent("task").partial, true);
    assert.deepEqual(h.view.agentsMore, { count: 3, failed: 1 });
    // A page of earlier turns brings their sub-agents whole, one fewer counted (a failed one: one fewer failed).
    assert.ok(await loadEarlier(h, { count: 20 }));
    assert.equal(agent("middle").partial, undefined);
    assert.equal(agent("middle").report, "what it found");
    assert.deepEqual(h.view.agentsMore, { count: 2, failed: 0 });
    // The list asked for: the rest as they're listed, none counted; those here already stay as they are.
    asked.length = 0;
    await Promise.all([loadAgentList(h), loadAgentList(h)]);
    assert.deepEqual(asked, ["session.agentList"]);
    assert.equal(h.view.agentsMore, undefined);
    assert.deepEqual(h.view.agents.map((a) => a.id), ["task", "late", "middle", "early", "broke"]);
    assert.equal(agent("middle").report, "what it found");
    assert.equal(agent("early").partial, true);
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
