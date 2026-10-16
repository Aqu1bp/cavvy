import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, text, type Node } from "../helpers/gui-render";
import { duration } from "../../gui/src/lib/format";

// Compile the actual turn and activity grouping; replace only leaf widgets and
// the DOM boundary. The real Solid renderer maintains child order and removal.
const source = readFileSync(new URL("../../gui/src/components/TurnView.tsx", import.meta.url), "utf8");
const activity = readFileSync(new URL("../../gui/src/components/blocks/Activity.tsx", import.meta.url), "utf8");
const grouping = activity.slice(activity.indexOf("export function groupBlocks"), activity.indexOf("// ---------------------------------------------------------------------------"));
const [clock, setClock] = solid.createSignal(61_000);
const stub = () => node("widget");
const scope = {
    duration, now: clock, prefs: { showThinking: false }, findReveal: () => undefined,
    ActivityGroup: stub, Markdown: stub, CopyButton: stub, Spinner: stub,
    Brain: stub, ChevronRight: stub, SquareTerminal: stub, Info: stub, AlertCircle: stub, AlertTriangle: stub,
};
const TurnView = component(grouping + source.replace(/^import .*;\n/gm, ""), "TurnView", scope);
const [turn, setTurn] = solid.createSignal<any>({ id: "turn", status: "running", startedAt: 1000, blocks: [] });
const [state, setState] = solid.createSignal<any>({ id: "session", busy: true, interactions: [], activity: { label: "Thinking", since: 50_000 } });
const [last, setLast] = solid.createSignal(true);
const root = node("root");
const dispose = renderer.render(() => TurnView({ get turn() { return turn(); }, get state() { return state(); }, get last() { return last(); } }), root);
const hasClass = (n: Node, cls: string) => n.props.class?.split(" ").includes(cls);
const heads = () => all(root).filter((n) => hasClass(n, "live-head"));
const blocks = (value: any[]) => setTurn({ ...turn(), blocks: value });
const activityIs = (label?: string) => setState({ ...state(), activity: label ? { label, since: 50_000, detail: "current detail" } : undefined });
const assertTail = (label = "Thinking") => {
    const reply = all(root).find((n) => hasClass(n, "reply"))!;
    const children = reply.children.filter((n) => n.tag !== "#text");
    assert.equal(heads().length, 1, "exactly one live head");
    assert.equal(children.at(-1), heads()[0], "the live row is the last visible child");
    assert.ok(text(heads()[0]!).includes(label), `tail includes ${label}`);
    assert.ok(text(heads()[0]!).includes("1m"), "elapsed time is measured from turn start");
};
try {
    const done = { t: "tool", id: "tool", name: "Bash", title: "Bash", status: "ok" };
    blocks([done]);
    assertTail(); // #71: a finished tool used to leave the live head above the log.
    setClock(62_000);
    assert.ok(text(heads()[0]!).includes("1m 1s"), "elapsed time continues ticking");
    blocks([]);
    assertTail();
    blocks([{ t: "text", id: "text", text: "One moment" }]);
    assertTail();
    activityIs("Writing");
    assert.equal(heads().filter((n) => hasClass(n, "live-tail")).length, 0, "no tail while the last reply streams");
    assert.equal(heads().length, 1);
    activityIs("Thinking");
    blocks([{ t: "thinking", id: "thought", text: "reasoning", startedAt: 1000 }]);
    assert.equal(heads().filter((n) => hasClass(n, "live-tail")).length, 0);
    blocks([{ ...turn().blocks[0], durationMs: 20_000 }]);
    assertTail(); // Finished reasoning must not hide the fallback, even when thinking is hidden.
    for (const status of ["streaming", "running", "awaiting"]) {
        blocks([{ ...done, status }, { ...done, id: "later" }]);
        assert.equal(heads().filter((n) => hasClass(n, "live-tail")).length, 0, "a grouped live tool already supplies activity");
    }
    blocks([{ t: "shell", id: "shell", command: "sleep", running: true }]);
    assert.equal(heads().filter((n) => hasClass(n, "live-tail")).length, 0);
    blocks([done, { t: "notice", id: "notice", level: "info", text: "notice" }]);
    activityIs("Retrying");
    assertTail("Retrying");
    activityIs(undefined);
    assertTail("Working");
    setState({ ...state(), interactions: [{}] });
    assertTail("Waiting for you");
    setState({ ...state(), busy: false });
    assert.equal(heads().length, 0);
    setState({ ...state(), busy: true });
    setLast(false);
    assert.equal(heads().length, 0);
    setLast(true);
    setTurn({ ...turn(), status: "done", archived: true });
    assert.equal(heads().length, 0, "completion removes the live row");
} finally { dispose(); }
