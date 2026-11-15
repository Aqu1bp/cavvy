// A finished turn's thought comes without its text (ThinkingBlock.omitted): its row asks for it (session.block) as
// the pointer comes to it or it's opened, and it's put in its place. And a turn sent with its work folded
// (Turn.folded) is filled in where it is when it's asked for whole (session.turn), its sub-agents with it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Socket } from "../helpers/gui-socket";
import { all, component, node, renderer, text } from "../helpers/gui-render";

Object.assign(globalThis, {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {} } } }),
});

const asked: { method: string; params: any }[] = [];
const thought = { t: "thinking", id: "th", text: "", omitted: true, durationMs: 4000 };

class ServerSocket extends Socket {
    send(raw: string) {
        super.send(raw);
        const { id, method, params } = JSON.parse(raw);
        const reply = (result: unknown) => queueMicrotask(() => this.message({ id, result }));
        asked.push({ method, params });
        if (method === "session.open" && params.id === "f") reply({ seq: 0, state: { id: "f", cwd: "/project", busy: false, interactions: [] }, turns: [{ id: "w", status: "done", startedAt: 1, folded: true, prompt: { text: "run it" }, blocks: [{ t: "tool", id: "c", name: "Bash", title: "Bash", status: "ok", input: { command: "npm test" } }] }], agents: [{ id: "a", turnId: "w", status: "done", description: "helper", agentType: "general-purpose", startedAt: 1, toolCount: 1, tokens: 1, blocks: [], partial: true }] });
        else if (method === "session.turn") reply({ turn: { id: "w", status: "done", startedAt: 1, prompt: { text: "run it" }, blocks: [{ t: "tool", id: "c", name: "Bash", title: "Bash", status: "ok", input: { command: "npm test" }, output: "12 pass" }] }, agents: [{ id: "a", turnId: "w", status: "done", description: "helper", agentType: "general-purpose", startedAt: 1, toolCount: 1, tokens: 1, report: "found it", blocks: [{ t: "text", id: "ab", text: "a step" }] }] });
        else if (method === "session.open") reply({ seq: 0, state: { id: params.id, cwd: "/project", busy: false, interactions: [] }, turns: [{ id: "t1", status: "done", startedAt: 1, prompt: { text: "why?" }, blocks: [thought, { t: "text", id: "r", text: "because" }] }], agents: [] });
        else if (method === "session.block") reply({ t: "thinking", id: "th", text: "the reasons, at length", durationMs: 4000 });
        else if (method === "hello" || method === "settings.get") reply({});
        else if (method === "session.close" || method === "session.shown") reply(null);
        else reply([]);
    }
}
globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };
const calls = (m: string) => asked.filter((a) => a.method === m);

const { start, rpc, openSession, loadBlock, loadTurn } = await import("../../gui/src/state/app");
Object.assign(rpc, { credentials: async () => ({ url: "ws://test", token: "test" }) });
try {
    start();
    await settle();
    Socket.instances.at(-1)!.open();
    await settle();
    const h = await openSession("s");
    const block = () => h.view.turns[0]!.blocks[0] as { text: string; omitted?: true };

    // Its row (Activity.tsx Thinking), with the real loadBlock.
    const source = readFileSync(new URL("../../gui/src/components/blocks/Activity.tsx", import.meta.url), "utf8");
    const icon = () => node("icon");
    const Thinking = component(source.slice(source.indexOf("/**\n * The model's reasoning"), source.indexOf("/** A run of calls in a turn's work")), "Thinking", {
        ChevronRight: icon,
        prefs: { showThinking: true },
        enterRow() {},
        motionMs: () => 0,
        STAGGER_MS: 0,
        duration: (ms: number) => `${ms / 1000}s`,
        useCardFolds: () => ({ sessionId: "s" }),
        loadBlock,
    });
    const root = node("root");
    const dispose = renderer.render(() => Thinking({ get block() { return h.view.turns[0]!.blocks[0]; }, live: false }), root);
    try {
        // Shown folded: how long it took, and nothing asked for.
        assert.match(text(root), /Thought for 4s/);
        assert.equal(calls("session.block").length, 0);
        const button = all(root).find((n) => n.props["aria-expanded"] !== undefined)!;
        // The pointer comes to it: asked for once, however often it comes.
        button.props.onPointerEnter();
        button.props.onPointerEnter();
        await settle();
        assert.deepEqual(calls("session.block").map((a) => a.params), [{ id: "s", turnId: "t1", blockId: "th" }]);
        assert.deepEqual(block(), { t: "thinking", id: "th", text: "the reasons, at length", durationMs: 4000 });
        // Opened: its text, and nothing more asked for.
        button.props.onClick();
        await settle();
        assert.match(text(root), /the reasons, at length/);
        assert.equal(calls("session.block").length, 1);
    } finally {
        dispose();
    }
    // Whole already: nothing asked for.
    await loadBlock("s", "th");
    await loadBlock("s", "r");
    assert.equal(calls("session.block").length, 1);

    // A turn with its work folded, asked for whole twice at once: once, filled in where it is.
    const f = await openSession("f");
    const turn = f.view.turns[0]!;
    await Promise.all([loadTurn(f, "w"), loadTurn(f, "w")]);
    assert.equal(calls("session.turn").length, 1);
    assert.equal(f.view.turns[0], turn);
    assert.equal(turn.folded, undefined);
    assert.equal((turn.blocks[0] as { output?: string }).output, "12 pass");
    // Its sub-agent whole (it was listed).
    assert.equal(f.view.agents[0]!.partial, undefined);
    assert.equal(f.view.agents[0]!.report, "found it");
    // Whole now: nothing asked for.
    await loadTurn(f, "w");
    assert.equal(calls("session.turn").length, 1);
} catch (e) {
    console.error(e);
    process.exit(1);
}
process.exit(0);
