// A finished turn's thought comes without its text (ThinkingBlock.omitted): its row asks for it (session.block) as
// the pointer comes to it or it's opened, and it's put in its place. And a turn sent with its work folded
// (Turn.folded) is filled in where it is when it's asked for whole (session.turn), its sub-agents with it: asked for as
// the pointer or focus comes to its "Worked for", and a click before it's come shows its rows at once.
import assert from "node:assert/strict";
import { tip } from "../../gui/src/lib/tip";
import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { Socket } from "../helpers/gui-socket";
import { boundary } from "../helpers/render-boundary";
import { all, component, node, renderer, text } from "../helpers/gui-render";
import * as format from "../../gui/src/lib/format";
import * as live from "../../gui/src/lib/live-line";
import * as notices from "../../gui/src/lib/notices";
import * as cards from "../../gui/src/lib/cards";
import { splitComments } from "../../gui/src/lib/review-comments";

Object.assign(globalThis, {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {} } } }),
});

const asked: { method: string; params: any }[] = [];
/** Session "g"'s turn, answered when the test says (a slow link). */
let answerG: (() => void) | undefined;
const foldedTurn = (id: string) => ({ id, status: "done", startedAt: 1, endedAt: 9001, folded: true, prompt: { text: "run it" }, blocks: [{ t: "tool", id: "c", name: "Bash", title: "Bash", status: "ok", input: { command: "npm test" } }] });
const wholeTurn = (id: string) => ({ id, status: "done", startedAt: 1, endedAt: 9001, prompt: { text: "run it" }, blocks: [{ t: "tool", id: "c", name: "Bash", title: "Bash", status: "ok", input: { command: "npm test" }, output: "12 pass" }] });
const thought = { t: "thinking", id: "th", text: "", omitted: true, durationMs: 4000 };

class ServerSocket extends Socket {
    send(raw: string) {
        super.send(raw);
        const { id, method, params } = JSON.parse(raw);
        const reply = (result: unknown) => queueMicrotask(() => this.message({ id, result }));
        asked.push({ method, params });
        if (method === "session.open" && (params.id === "h" || params.id === "g")) reply({ seq: 0, state: { id: params.id, cwd: "/project", busy: false, interactions: [] }, turns: [foldedTurn("w")], agents: [] });
        else if (method === "session.turn" && params.id === "h") reply({ turn: wholeTurn("w"), agents: [] });
        else if (method === "session.turn" && params.id === "g") answerG = () => this.message({ id, result: { turn: wholeTurn("w"), agents: [] } });
        else if (method === "session.open" && params.id === "f") reply({ seq: 0, state: { id: "f", cwd: "/project", busy: false, interactions: [] }, turns: [{ id: "w", status: "done", startedAt: 1, folded: true, prompt: { text: "run it" }, blocks: [{ t: "tool", id: "c", name: "Bash", title: "Bash", status: "ok", input: { command: "npm test" } }] }], agents: [{ id: "a", turnId: "w", status: "done", description: "helper", agentType: "general-purpose", startedAt: 1, toolCount: 1, tokens: 1, blocks: [], partial: true }] });
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

const { start, rpc, openSession, loadBlock, loadTurn, handleFor } = await import("../../gui/src/state/app");

// The turn as the transcript draws it (TurnView.tsx), with the real loadTurn; its rows say each call and its output.
const read = (file: string) => readFileSync(new URL(`../../gui/src/${file}`, import.meta.url), "utf8").replace(/^import [\s\S]*?;\n/gm, "");
const activitySource = read("components/blocks/Activity.tsx");
const grouping = activitySource.slice(activitySource.indexOf("export function groupBlocks"), activitySource.indexOf("// ---------------------------------------------------------------------------"));
const stub = () => node("widget");
const rows = (p: any) => {
    const n = node("rows");
    solid.createRenderEffect(() => (n.text = p.tools.map((t: any) => `${t.title}: ${t.output ?? ""}`).join("; ")));
    return n;
};
const TurnView = component(grouping + read("components/TurnView.tsx"), "TurnView", {
    RenderBoundary: boundary(undefined, (e) => console.error(e)), splitComments, ...format, ...live, ...notices, ...cards,
    now: () => 10_000, prefs: { showThinking: true, expandActivity: false, motion: "instant" }, findReveal: () => undefined, dwellLeft: () => 0,
    ActivityGroup: rows, Markdown: stub, CopyButton: stub, Spinner: stub, Thinking: stub, Notice: stub, LiveLine: stub, motionMs: () => 0,
    // The drawn tooltips (lib/tip.ts), and the app with no server hello (no home folder to name files from).
    tip, app: {},
    WorkRun: (p: any) => p.children, useCardFolds: () => ({ get: () => undefined, set() {} }), loadTurn, handleFor,
    ...Object.fromEntries(["Brain", "ChevronRight", "SquareTerminal", "Info", "AlertCircle", "AlertTriangle", "Square", "GitFork", "Hand", "Clock", "CornerDownRight", "RotateCcw", "BellRing", "MessageSquareText", "FileText"].map((n) => [n, stub])),
});
/** Session `id`'s one turn drawn; its "Worked for" button, and what the turn shows. */
function drawn(h: { view: { turns: any[]; state: any } }) {
    const root = node("root");
    // Archived: no changes card (it asks the server for the turn's diff).
    const dispose = renderer.render(() => TurnView({ get turn() { return { ...h.view.turns[0], archived: true }; }, get state() { return h.view.state; }, last: true }), root);
    const worked = () => all(root).find((n) => n.props.class?.includes("worked"))!;
    return { root, worked, dispose };
}
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
        // A plain copy: the store's proxy isn't deep-equal to an object on every Bun (1.3.14).
        assert.deepEqual({ ...block() }, { t: "thinking", id: "th", text: "the reasons, at length", durationMs: 4000 });
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

    // Its "Worked for" pointed at, or reached by the keyboard: asked for then, once; opened after, nothing more asked.
    const h2 = await openSession("h");
    const hTurn = drawn(h2);
    try {
        assert.match(text(hTurn.root), /Worked for 9s/);
        assert.equal(calls("session.turn").length, 1);
        hTurn.worked().props.onPointerEnter();
        hTurn.worked().props.onFocus();
        await settle();
        assert.deepEqual(calls("session.turn").map((a) => a.params.id), ["f", "h"]);
        hTurn.worked().props.onClick({ currentTarget: hTurn.worked() });
        await settle();
        assert.match(text(hTurn.root), /Bash: 12 pass/);
        assert.equal(calls("session.turn").length, 2);
    } finally {
        hTurn.dispose();
    }

    // Opened before it's come (a touch, a slow link): its rows at once, their output filled in as it comes.
    const g = await openSession("g");
    const gTurn = drawn(g);
    try {
        gTurn.worked().props.onClick({ currentTarget: gTurn.worked() });
        await settle();
        assert.deepEqual(calls("session.turn").map((a) => a.params.id), ["f", "h", "g"]);
        assert.match(text(gTurn.root), /Bash: (?!12)/);
        answerG!();
        await settle();
        assert.match(text(gTurn.root), /Bash: 12 pass/);
        assert.equal(calls("session.turn").length, 3);
    } finally {
        gTurn.dispose();
    }
} catch (e) {
    console.error(e);
    process.exit(1);
}
process.exit(0);
