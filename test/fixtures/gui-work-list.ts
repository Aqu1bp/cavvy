import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { createSignal } from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, text } from "../helpers/gui-render";
import * as background from "../../gui/src/lib/background";

// The Agents tab's list (BackgroundTasks.tsx WorkList) with its real reactive grouping and keyed rows.
const source = readFileSync(new URL("../../gui/src/components/BackgroundTasks.tsx", import.meta.url), "utf8");
const list = source.slice(source.indexOf("/** Rows cleared from"), source.indexOf("/** In the composer"));
const icon = () => node("icon");
const WorkList = component(list, "WorkList", {
    ...background,
    Bot: icon, ChevronRight: icon, Radar: icon, Terminal: icon, Workflow: icon,
    ProviderIcon: icon,
    hasProviderIcon: () => true,
    ConfirmDialog: () => node("dialog"),
    app: { providers: [] },
    openAgents() {}, stopAgent() {}, stopBackground() {}, clearBackground() {},
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
const rowNodes = () => all(root).filter((n) => String(n.props.class ?? "").startsWith("task "));
const rows = () => rowNodes().map((n) => text(n).match(/Explore (\w)/)![1]);
const group = () => all(root).find((n) => n.props.class === "work")!;
const fold = () => all(root).find((n) => String(n.props.class ?? "").startsWith("fold-b"));
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
    expect(fold()!.props.class).toBe("fold-b ");
    // The fold opens in place: its rows are the same elements, only its class changes.
    const folded = rowNodes().slice(2);
    all(root).find((n) => n.props.class === "divi")!.props.onClick();
    expect(fold()!.props.class).toBe("fold-b open");
    expect(fold()!.props.inert).toBe(false);
    expect(rowNodes().slice(2)).toEqual(folded);
    expect(rowNodes()[2]).toBe(folded[0]);
    // Without the pointer on it, a finished agent moves at once.
    finish("b");
    expect(rows()).toEqual(["c", "b", "d", "a"]);
    expect(text(root)).toContain("Finished3");
} finally {
    dispose();
}
