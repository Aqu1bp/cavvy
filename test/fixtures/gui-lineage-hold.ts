import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { createSignal } from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, text } from "../helpers/gui-render";

// Lineage with its real reactive grouping; rows are stubs that show the agent's id.
const source = readFileSync(new URL("../../gui/src/components/RightPanel.tsx", import.meta.url), "utf8");
const lineage = source.slice(source.indexOf("/** The sub-agents: live ones on top"), source.indexOf("export function RightPanel("));
const live = (a: any) => a.status === "running" || a.status === "waiting";
const Lineage = component(lineage, "Lineage", {
    live,
    AgentRow: (p: any) => {
        const row = node("row");
        row.props.id = p.a.id;
        return row;
    },
    ChevronRight: () => node("icon"),
});

const [agents, setAgents] = createSignal([
    { id: "a", description: "Explore terminal panel wiring", status: "running" },
    { id: "b", description: "Explore protocol, engine, store", status: "running" },
    { id: "c", description: "Explore the GUI", status: "running" },
]);
const root = node("root");
const dispose = renderer.render(() => Lineage({ handle: { view: { get agents() { return agents(); } } } }), root);
const rows = () => all(root).filter((n) => n.tag === "row").map((n) => n.props.id);
const section = all(root).find((n) => n.props.class === "sec")!;
const finish = (id: string) => setAgents(agents().map((a) => (a.id === id ? { ...a, status: "done" } : a)));

try {
    expect(rows()).toEqual(["a", "b", "c"]);
    // The pointer is on the list, aiming at "b", as "a" finishes: nothing moves.
    section.props.onPointerEnter?.();
    finish("a");
    expect(rows()).toEqual(["a", "b", "c"]);
    expect(text(root)).not.toContain("Previous agents");
    // A new agent still shows up while the list is held.
    setAgents([...agents(), { id: "d", description: "Explore tests", status: "running" }]);
    expect(rows()).toEqual(["a", "b", "c", "d"]);
    // Leaving the list lets it catch up: "a" folds into Previous agents.
    section.props.onPointerLeave?.();
    expect(rows()).toEqual(["b", "c", "d"]);
    expect(text(root)).toContain("Previous agents (1)");
    // Without the pointer on it, a finished agent moves at once, as before.
    finish("b");
    expect(rows()).toEqual(["c", "d"]);
    expect(text(root)).toContain("Previous agents (2)");
} finally {
    dispose();
}
