import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { createSignal } from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, text } from "../helpers/gui-render";
import * as background from "../../gui/src/lib/background";
import { agentStep } from "../../gui/src/lib/agent-marks";

// The Agents tab's list (BackgroundTasks.tsx WorkList) with its real reactive grouping and keyed rows.
/** Sessions whose sub-agents' list the fold asked for (loadAgentList). */
const listAsked: string[] = [];
const source = readFileSync(new URL("../../gui/src/components/BackgroundTasks.tsx", import.meta.url), "utf8");
const list = source.slice(source.indexOf("/** Rows cleared from"), source.indexOf("/** In the composer"));
const icon = () => node("icon");
const WorkList = component(list, "WorkList", {
    ...background,
    Bot: icon, ChevronRight: icon, Radar: icon, SquareTerminal: icon, Square: icon, Workflow: icon,
    AgentMark: icon,
    agentStep,
    ConfirmDialog: () => node("dialog"),
    app: { providers: [] },
    openAgents() {}, stopAgent() {}, stopBackground() {}, clearBackground() {},
    loadAgentList: (h: { id: string }) => {
        listAsked.push(h.id);
        return Promise.resolve();
    },
    shortModelRef: (ref?: string) => ref,
    duration: (ms: number) => `${ms}ms`,
    plural: (n: number, w: string) => `${n} ${w}s`,
    now: () => 0,
});

const run = (id: string, o: Record<string, unknown> = {}) => ({ id, turnId: "t", description: `Explore ${id}`, agentType: "explore", status: "running", startedAt: id.charCodeAt(0), toolCount: 0, tokens: 0, blocks: [], ...o });
const [agents, setAgents] = createSignal<any[]>([run("a"), run("b"), run("c")]);
const handle = { id: "s1", view: { state: { shells: [], backgroundTasks: [] }, get agents() { return agents(); } } };
const root = node("root");
const dispose = renderer.render(() => WorkList({ handle, tab: "agents", get rows() { return background.agentRows([], agents()); } }), root);
const rowNodes = () => all(root).filter((n) => n.props.class === "bg-row");
const rows = () => rowNodes().map((n) => text(n).match(/Explore (\w)/)![1]);
const group = () => all(root).find((n) => n.props.class === "bg-work")!;
/** The Finished group's rows: the second group's. */
const fold = () => all(root).filter((n) => n.props.class === "bg-rows")[1];
const finish = (id: string) => setAgents(agents().map((a) => (a.id === id ? { ...a, status: "done", endedAt: 100 + agents().length } : a)));

try {
    expect(rows()).toEqual(["a", "b", "c"]);
    // A row keeps its element as what it shows changes.
    const first = rowNodes()[0];
    setAgents(agents().map((a) => (a.id === "a" ? { ...a, activity: "Reading src/auth.ts" } : a)));
    expect(rowNodes()[0]).toBe(first);
    expect(text(first!)).toContain("Reading src/auth.ts");
    // The pointer is on the list, aiming at "b", as "a" finishes: nothing moves.
    group().props.onPointerEnter?.();
    finish("a");
    expect(rows()).toEqual(["a", "b", "c"]);
    expect(text(root)).not.toContain("Finished");
    // A new agent still shows up while the list is held; when that one finishes before the pointer leaves, it stays put too.
    setAgents([...agents(), run("d")]);
    expect(rows()).toEqual(["a", "b", "c", "d"]);
    finish("d");
    expect(rows()).toEqual(["a", "b", "c", "d"]);
    // Leaving the list lets it catch up: "a" and "d" go to Finished, folded while others run.
    group().props.onPointerLeave?.();
    expect(rows()).toEqual(["b", "c", "d", "a"]);
    expect(text(root)).toContain("Finished2");
    expect(fold()!.props.hidden).toBe(true);
    // The fold opens in place: its rows are the same elements, only shown now.
    const folded = rowNodes().slice(2);
    all(root).find((n) => n.props.class === "bg-fold")!.props.onClick();
    expect(fold()!.props.hidden).toBe(false);
    expect(fold()!.props.inert).toBe(false);
    expect(rowNodes().slice(2)).toEqual(folded);
    expect(rowNodes()[2]).toBe(folded[0]);
    // Without the pointer on it, a finished agent moves at once.
    finish("b");
    expect(rows()).toEqual(["c", "b", "d", "a"]);
    expect(text(root)).toContain("Finished3");
    expect(listAsked).toEqual([]);
} finally {
    dispose();
}

// Finished sub-agents the window was only told the number of (agentsMore): counted in the fold, and asked for as
// it's shown, not before.
{
    const [more, setMore] = createSignal<{ count: number; failed: number } | undefined>({ count: 5, failed: 2 });
    const [list, setList] = createSignal<any[]>([run("x")]);
    const later = { id: "s2", view: { state: { shells: [], backgroundTasks: [] }, get agents() { return list(); }, get agentsMore() { return more(); } } };
    const root2 = node("root");
    const dispose2 = renderer.render(() => WorkList({ handle: later, tab: "agents", get rows() { return background.agentRows([], list()); } }), root2);
    try {
        // One running: the fold starts folded, and nothing is asked for.
        expect(text(root2)).toContain("Finished5");
        expect(text(root2)).toContain("2 failed");
        expect(listAsked).toEqual([]);
        all(root2).find((n) => n.props.class === "bg-fold")!.props.onClick();
        expect(listAsked).toEqual(["s2"]);
        // They come: rows instead of a count.
        setList([run("x"), ...["p", "q", "r", "s", "u"].map((id, i) => run(id, { status: i < 2 ? "failed" : "done", endedAt: 50 + i, partial: true }))]);
        setMore(undefined);
        expect(text(root2)).toContain("Finished5");
        expect(text(root2)).toContain("2 failed");
        expect(listAsked).toEqual(["s2"]);
    } finally {
        dispose2();
    }
    // With nothing running, the fold is open from the start: they're asked for at once.
    listAsked.length = 0;
    const idle = { id: "s3", view: { state: { shells: [], backgroundTasks: [] }, agents: [], agentsMore: { count: 3, failed: 0 } } };
    const root3 = node("root");
    const dispose3 = renderer.render(() => WorkList({ handle: idle, tab: "agents", rows: [] }), root3);
    try {
        expect(text(root3)).toContain("Finished3");
        expect(listAsked).toEqual(["s3"]);
    } finally {
        dispose3();
    }
}
