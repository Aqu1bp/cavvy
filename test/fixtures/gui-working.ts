import { boundary } from "../helpers/render-boundary";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, text, type Node } from "../helpers/gui-render";
import * as format from "../../gui/src/lib/format";
import * as live from "../../gui/src/lib/live-line";
import { splitComments } from "../../gui/src/lib/review-comments";

// Compile the actual turn, its live line and activity grouping; replace only leaf widgets and
// the DOM boundary. The real Solid renderer maintains child order and removal.
const read = (file: string) => readFileSync(new URL(`../../gui/src/${file}`, import.meta.url), "utf8").replace(/^import [\s\S]*?;\n/gm, "");
const source = read("components/TurnView.tsx");
const activity = read("components/blocks/Activity.tsx");
const grouping = activity.slice(activity.indexOf("export function groupBlocks"), activity.indexOf("// ---------------------------------------------------------------------------"));
const [clock, setClock] = solid.createSignal(61_000);
const stub = () => node("widget");
const prefs = { showThinking: true, expandActivity: false, motion: "instant" };
const scope = {
    RenderBoundary: boundary(undefined, (e) => console.error(e)), splitComments,
    ...format, ...live, now: clock, prefs, findReveal: () => undefined,
    ActivityGroup: stub, Markdown: stub, CopyButton: stub, Spinner: stub, Thinking: stub,
    ...Object.fromEntries(["Brain", "ChevronRight", "SquareTerminal", "Info", "AlertCircle", "AlertTriangle", "CircleStop", "GitFork", "Hand", "Clock", "CornerDownRight", "RotateCcw", "BellRing", "MessageSquareText", "FileText"].map((n) => [n, stub])),
};
const { LiveLine, motionMs } = component(`${read("components/LiveLine.tsx")}\nconst both = { LiveLine, motionMs };`, "both", scope);
const TurnView = component(grouping + source, "TurnView", { ...scope, LiveLine, motionMs });
// Archived: no changes card (it asks the server for the turn's diff).
const [turn, setTurn] = solid.createSignal<any>({ id: "turn", status: "running", archived: true, startedAt: 1000, prompt: { text: "go" }, blocks: [] });
const [state, setState] = solid.createSignal<any>({ id: "session", busy: true, interactions: [], activity: { label: "Thinking", since: 50_000 } });
const [last, setLast] = solid.createSignal(true);
const [held, setHeld] = solid.createSignal(false);
let keepWorkOpen = false;
const openChanges: boolean[] = [];
const root = node("root");
const dispose = renderer.render(() => TurnView({ get turn() { return turn(); }, get state() { return state(); }, get last() { return last(); }, get held() { return held(); }, keepWorkOpen: () => keepWorkOpen, onWorkOpen: (open: boolean) => openChanges.push(open) }), root);
const hasClass = (n: Node, cls: string) => n.props.class?.split(" ").includes(cls);
const lines = () => all(root).filter((n) => hasClass(n, "live-line"));
const layers = () => all(root).filter((n) => hasClass(n, "layer"));
const blocks = (value: any[]) => setTurn({ ...turn(), blocks: value });
const activityIs = (label?: string, since = 50_000) => setState({ ...state(), activity: label ? { label, since, detail: "current detail" } : undefined });
/** One live line, the turn's last row, saying `label` (and only one state: no roll without motion). */
const assertLine = (label: string, time?: string) => {
    const reply = all(root).find((n) => hasClass(n, "reply"))!;
    const children = reply.children.filter((n) => n.tag !== "#text");
    assert.equal(lines().length, 1, `exactly one live line (${label})`);
    assert.equal(children.at(-1), lines()[0], `the live line is the turn's last row (${label})`);
    assert.equal(layers().length, 1, `one state on the line (${label})`);
    const said = text(layers()[0]!);
    assert.ok(said.includes(label), `the line says "${label}", not "${said}"`);
    if (time) assert.ok(said.endsWith(time), `its timer reads ${time}: "${said}"`);
};
try {
    const done = { t: "tool", id: "tool", name: "Bash", title: "Bash", status: "ok" };
    blocks([done]);
    assertLine("Thinking", "11s"); // #71: a finished tool used to leave the live head above the log.
    setClock(62_000);
    assertLine("Thinking", "12s"); // Its own timer, from when the state began.
    blocks([]);
    assertLine("Thinking");
    blocks([{ t: "text", id: "text", text: "One moment" }]);
    assertLine("Thinking");
    activityIs("Writing");
    assert.equal(lines().length, 0, "the line steps aside while the answer streams: its caret says it's working");
    activityIs("Thinking");
    prefs.showThinking = true;
    blocks([{ t: "thinking", id: "thought", text: "Checking what's merged.\nMain is at d55ddfac.", startedAt: 60_000 }]);
    assertLine("Thinking", "2s");
    assert.ok(text(layers()[0]!).includes("Main is at d55ddfac."), "the thought's latest line is on the line");
    // The thought going on is the same state, updated in place: the same row, not a new one rolled in.
    const thinking = layers()[0];
    blocks([{ ...turn().blocks[0], text: "Checking what's merged.\nMain is at d55ddfac.\nNow the tests." }]);
    assert.equal(layers()[0], thinking, "a thought's next words don't make a new state");
    assert.ok(text(layers()[0]!).includes("Now the tests."), "they show on the same row");
    blocks([{ ...turn().blocks[0], durationMs: 20_000 }]);
    assertLine("Thinking"); // Finished reasoning must not hide the line, even when thinking is hidden.
    // The step under way: the call's own words, and a command's description when it has one.
    blocks([done, { t: "tool", id: "read", name: "Read", title: "Read(src/a.ts)", input: { file_path: "src/a.ts" }, status: "running", startedAt: 58_000 }]);
    assertLine("Reading", "4s");
    assert.ok(text(layers()[0]!).includes("src/a.ts"));
    blocks([done, { t: "tool", id: "cmd", name: "Bash", title: "Bash", input: { command: "bun test", description: "Run the tests" }, status: "running", progress: "a\nb\nc\nd\n", startedAt: 60_000 }]);
    assertLine("Run the tests");
    const out = all(root).find((n) => hasClass(n, "live-out"))!;
    assert.deepEqual(out.children.map(text), ["b", "c", "d"], "a running command's last three lines, under the line");
    blocks([done, { t: "tool", id: "cmd", name: "Bash", title: "Bash", input: { command: "bun test" }, status: "awaiting", startedAt: 60_000 }]);
    assertLine("Waiting for approval");
    assert.equal(all(root).filter((n) => hasClass(n, "live-out")).length, 0, "the output window goes with its command");
    blocks([{ t: "shell", id: "shell", command: "sleep", running: true }]);
    assert.equal(lines().length, 0, "a command the user ran shows itself");
    blocks([done, { t: "notice", id: "notice", level: "info", text: "notice" }]);
    activityIs("Retrying in 5s · Stop to cancel");
    assertLine("Retrying in 5s");
    activityIs("Waiting for background command: bun test · Esc to stop it");
    assertLine("Waiting for background");
    assert.ok(text(layers()[0]!).includes("bun test"));
    activityIs(undefined);
    assertLine("Working");
    setState({ ...state(), interactions: [{ kind: "question", id: "q" }] });
    assertLine("Waiting for your answer");
    setState({ ...state(), interactions: [{ kind: "permission", id: "p", title: "Bash", command: "rm -rf build" }] });
    assertLine("Waiting for approval");
    assert.ok(text(layers()[0]!).includes("rm -rf build"));
    setState({ ...state(), interactions: [] });
    setState({ ...state(), busy: false });
    assert.equal(lines().length, 0);
    setState({ ...state(), busy: true });
    setLast(false);
    assert.equal(lines().length, 0);
    setLast(true);
    const logs = () => all(root).filter((n) => hasClass(n, "worklog"));
    const folds = () => all(root).filter((n) => hasClass(n, "worked"));
    const feet = () => all(root).filter((n) => hasClass(n, "turn-foot"));
    // Ended by a steer whose turn still runs: its work stays open, with no footer, until the chain ends.
    setHeld(true);
    setTurn({ ...turn(), status: "done", endedAt: 1341 });
    assert.equal(lines().length, 0, "completion removes the live line");
    assert.equal(logs().length, 1, "a held turn keeps its work open");
    assert.equal(folds().length, 0, "and has no Worked for");
    assert.equal(feet().length, 0, "and no footer yet");
    setHeld(false);
    assert.equal(logs().length, 0, "the chain's end folds it");
    assert.equal(feet().length, 1, "and gives it its footer");
    assert.equal(text(folds()[0]!), "Worked briefly", "under a second: never 0s");
    setTurn({ ...turn(), status: "running" });
    setTurn({ ...turn(), status: "done", endedAt: 126_000 });
    assert.equal(text(folds()[0]!), "Worked for 2m 5s");
    assert.equal(logs().length, 0, "completion at the bottom folds work");
    keepWorkOpen = true;
    setTurn({ ...turn(), status: "running" });
    assert.equal(logs().length, 1);
    const readingLog = logs()[0];
    setTurn({ ...turn(), status: "done", endedAt: 1341 });
    assert.equal(logs().length, 1, "completion away from bottom keeps the reader's work mounted");
    assert.equal(logs()[0], readingLog, "completion preserves mounted work and its nested disclosure state");
    assert.equal(openChanges.at(-1), true, "retained log is remembered for session restoration");
    const fold = folds()[0]!;
    fold.props.onClick({ currentTarget: fold });
    assert.equal(logs().length, 0, "retained work can still be folded manually");
    assert.equal(openChanges.at(-1), false);
    keepWorkOpen = false;
    setTurn({ ...turn(), status: "running" });
    setTurn({ ...turn(), status: "done" });
    assert.equal(logs().length, 0, "subsequent completion at bottom still folds");
    // Settings → Expand tool activity: finished turns keep their work open.
    prefs.expandActivity = true;
    const again = node("root");
    const disposeAgain = renderer.render(() => TurnView({ turn: { ...turn(), status: "done", endedAt: 1341 }, state: state(), last: true }), again);
    assert.equal(all(again).filter((n) => hasClass(n, "worklog")).length, 1, "expanded activity starts unfolded");
    disposeAgain();
    prefs.expandActivity = false;
    assert.equal(motionMs(260), 0, "no motion without a browser's reduced-motion query");
} finally { dispose(); }
