import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { createStore, produce } from "../../gui/node_modules/solid-js/store/dist/store.js";
import { all, component, node, renderer, text, type Node } from "../helpers/gui-render";
import { boundary } from "../helpers/render-boundary";
import * as format from "../../gui/src/lib/format";
import * as toolWords from "../../gui/src/lib/tool-words";
import * as liveLine from "../../gui/src/lib/live-line";
import * as notices from "../../gui/src/lib/notices";
import * as commandRow from "../../gui/src/lib/command-row";
import { backgroundOf } from "../../gui/src/lib/background";
import * as turnPlaces from "../../gui/src/lib/turn-places";
import * as agentMarks from "../../gui/src/lib/agent-marks";
import { MarkdownRenderer } from "../../gui/src/lib/markdown";
import { createReveal } from "../../gui/src/lib/reveal";
import { applyOp } from "../../src/server/timeline";

const source = (file: string) => readFileSync(new URL(`../../gui/src/components/${file}.tsx`, import.meta.url), "utf8").replace(/^import [\s\S]*?;\n/gm, "");
// An optional historical source makes the same workload measurable before the fix.
const activity = process.env.ACTIVITY_BEFORE ? readFileSync(process.env.ACTIVITY_BEFORE, "utf8").replace(/^import [\s\S]*?;\n/gm, "") : source("blocks/Activity");
// A call that streams progress and stays in its group (commands and edits get cards of their own).
const tool = (id: string, status = "running"): any => ({ t: "tool", id, name: "Monitor", title: "Monitor", input: { description: `watch ${id}` }, status, startedAt: 1000 });
const command = (id: string, status = "running"): any => ({ t: "tool", id, name: "Bash", title: "Bash", input: { command: `echo ${id}` }, status, startedAt: 1000 });
const has = (n: Node, cls: string) => n.props.class?.split(" ").includes(cls);
const row = (root: Node, id: string) => all(root).find((n) => n.props["data-find"] === id && !has(n, "det"))!;
const liveLineOf = (root: Node) => all(root).find((n) => has(n, "live-line"));

/** `busy` false: a turn left running (no live line), whose calls under way are rows like the others. */
function setup(blocks: any[], expanded = true, agents: any[] = [], session?: string, busy = true) {
    const [view, setView] = createStore<any>({ state: { id: "session", busy, interactions: [], shells: [] }, turns: [{ id: "turn", status: "running", startedAt: 1000, blocks }], agents });
    const [clock, setClock] = solid.createSignal(2000);
    const [reveal, setReveal] = solid.createSignal<any>();
    let icons = 0, groups = 0;
    const stops: [string, string[]][] = [];
    const icon = () => { icons++; return node("icon"); };
    const scope = {
        ...format, ...toolWords, ...liveLine, ...notices, ...commandRow, ...agentMarks, ...turnPlaces, backgroundOf, app: {}, RenderBoundary: boundary(), AgentMark: icon, ProviderStack: icon, Notice: () => node("notice"),
        // The session the rows are in: its background tasks, and Stop on one (recorded).
        handleFor: () => ({ view }), stopBackground: (id: string, ids: string[]) => { stops.push([id, ids]); }, now: clock, motionMs: () => 0, prefs: { expandActivity: expanded, showThinking: true }, findReveal: reveal,
        CodeBlock: (p: any) => { const n = node("code"); solid.createRenderEffect(() => n.text = p.code); return n; },
        DiffView: (p: any) => { const n = node("diff"); solid.createRenderEffect(() => n.text = `diff ${p.diff.path}`); return n; },
        Markdown: () => node("markdown"), Spinner: icon,
        // What a Copy would copy, read when it's pressed.
        CopyButton: (p: any) => { const n = icon(); n.props.label = p.label; n.props.copy = p.text; return n; }, openReview: () => {}, openInEditor: () => {},
        ...Object.fromEntries(["AlertTriangle", "Bot", "Check", "ChevronDown", "ChevronRight", "ClipboardList", "FileDiff", "FilePen", "FilePlus2", "FileText", "FolderTree", "Globe", "Hand", "ListChecks", "MessageCircleQuestion", "Plug", "Radar", "Search", "ShieldCheck", "SquareArrowOutUpRight", "SquareTerminal", "Wrench", "X", "Brain"].map((name) => [name, icon])),
    };
    // One copy of the module, as the app has: its components share its state (the command cards' folds).
    // The live line opens a running command into the rows' block and folds (a historical source may have neither).
    const { ActivityGroup, CardFoldsProvider, groupBlocks, Thinking, LiveCommandBody, useCardFolds } = component(`${activity}\nconst moduleExports = { ActivityGroup, CardFoldsProvider, groupBlocks, Thinking, LiveCommandBody: typeof LiveCommandBody === "undefined" ? undefined : LiveCommandBody, useCardFolds: typeof useCardFolds === "undefined" ? undefined : useCardFolds };`, "moduleExports", scope);
    const { LiveLine, motionMs } = component(`${source("LiveLine")}\nconst both = { LiveLine, motionMs };`, "both", { ...scope, LiveCommandBody, useCardFolds });
    const TurnView = component(source("TurnView"), "TurnView", { ...scope, ActivityGroup, Thinking, LiveLine, motionMs, groupBlocks: (b: any) => { groups++; return groupBlocks(b); } });
    /** Draws the turn again, as a session's transcript does when it's opened (in `session`'s folds, when given). */
    const mount = (session?: string) => {
        const root = node("root");
        const turn = () => TurnView({ get turn() { return view.turns[0]; }, get state() { return view.state; }, get agents() { return view.agents; }, last: true });
        const dispose = renderer.render(() => (session ? CardFoldsProvider({ sessionId: session, get children() { return turn(); } }) : turn()), root);
        return { root, dispose };
    };
    const { root, dispose } = mount(session);
    const op = (value: any) => setView(produce((v: any) => applyOp(v, { turnId: "turn", ...value })));
    return { root, view, setView, op, dispose, mount, setClock, setReveal, icons: () => icons, groups: () => groups, stops };
}

test("a call under way is the live line's; done, it's a row of its own, the same through next calls, details and find", () => {
    const h = setup([tool("a")], false);
    try {
        expect(row(h.root, "a")).toBeUndefined();
        expect(text(liveLineOf(h.root)!)).toContain("Starting monitor");
        for (let i = 0; i < 40; i++) h.op({ op: "append", blockId: "a", field: "progress", text: `line ${i}\n` });
        expect(row(h.root, "a")).toBeUndefined();
        h.op({ op: "block.patch", blockId: "a", patch: { status: "ok", durationMs: 2000 } });
        const first = row(h.root, "a");
        expect(first).toBeDefined();
        expect(has(first.parent!, "steps")).toBe(true);
        const icon = all(first).find((n) => n.tag === "icon");
        h.op({ op: "block", block: tool("b") });
        expect(row(h.root, "a")).toBe(first);
        expect(row(h.root, "b")).toBeUndefined();
        // No summary line over the rows: the turn's "Worked for" folds them all once it ends.
        expect(all(h.root).filter((n) => n.tag === "button" && has(n, "wrow") && !has(n, "tool-line"))).toHaveLength(0);
        all(first).find((n) => n.tag === "button" && has(n, "tool-line"))!.props.onClick();
        const detail = all(first).find((n) => has(n, "tool-detail"));
        expect(detail).toBeDefined();
        h.op({ op: "block.patch", blockId: "b", patch: { status: "ok" } });
        const second = row(h.root, "b");
        h.op({ op: "block", block: tool("c") });
        expect(row(h.root, "a")).toBe(first);
        expect(row(h.root, "b")).toBe(second);
        expect(all(first).find((n) => has(n, "tool-detail"))).toBe(detail);
        expect(all(first).find((n) => n.tag === "icon")).toBe(icon);
        h.setReveal({ turnId: "turn", part: "a" });
        expect(row(h.root, "a")).toBe(first);
        expect(text(h.root)).not.toContain("Couldn't render");
    } finally { h.dispose(); }
});

test("a turn left running with no live line draws its calls under way as rows, the same row through progress and completion", () => {
    const h = setup([tool("a")], false, [], undefined, false);
    try {
        expect(liveLineOf(h.root)).toBeUndefined();
        const first = row(h.root, "a");
        expect(first).toBeDefined();
        for (let i = 0; i < 40; i++) h.op({ op: "append", blockId: "a", field: "progress", text: `line ${i}\n` });
        h.op({ op: "block.patch", blockId: "a", patch: { status: "ok", durationMs: 2000 } });
        expect(row(h.root, "a")).toBe(first);
        expect(text(h.root)).not.toContain("Couldn't render");
    } finally { h.dispose(); }
});

// Count comparisons instead of using a flaky wall-time threshold. The old
// done().includes(step) executes ~n²/2 identity comparisons on each status change.
function membershipWork(run: () => void) {
    const includes = Array.prototype.includes;
    let comparisons = 0;
    Array.prototype.includes = function (value: any, from?: number) {
        if (value?.t === "tool" && this.length > 100) {
            for (let i = from ?? 0; i < this.length; i++) { comparisons++; if (this[i] === value) return true; }
            return false;
        }
        return includes.call(this, value, from);
    };
    try { run(); } finally { Array.prototype.includes = includes; }
    return comparisons;
}

test("2,000-tool streamed turn: linear membership, no finished row remounts, no whole-turn work on progress or clock ticks", () => {
    let reads = 0;
    const tools = Array.from({ length: 2000 }, (_, i) => {
        const t = tool(String(i), i === 1999 ? "running" : "ok");
        return new Proxy(t, { get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); } });
    });
    const start = performance.now();
    let h!: ReturnType<typeof setup>;
    const comparisons = membershipWork(() => { h = setup(tools); });
    const mountMs = performance.now() - start;
    try {
        const finished = row(h.root, "0");
        // Under way, the last call is the live line's, not a row.
        expect(row(h.root, "1999")).toBeUndefined();
        const icons = h.icons(), groups = h.groups();
        reads = 0;
        const deltaStart = performance.now();
        for (let i = 0; i < 100; i++) h.op({ op: "append", blockId: "1999", field: "progress", text: "progress\n" });
        const deltaMs = performance.now() - deltaStart;
        const deltaReads = reads;
        expect(h.groups()).toBe(groups);
        expect(h.icons()).toBe(icons);
        expect(deltaReads).toBeLessThan(20_000);
        reads = 0;
        for (let i = 0; i < 10; i++) h.setClock(3000 + i * 1000);
        expect(h.groups()).toBe(groups);
        expect(h.icons()).toBe(icons);
        expect(reads).toBeLessThan(1000);
        reads = 0;
        const statusStart = performance.now();
        const updateComparisons = membershipWork(() => h.op({ op: "block.patch", blockId: "1999", patch: { status: "ok" } }));
        const statusMs = performance.now() - statusStart;
        const statusReads = reads;
        console.log(JSON.stringify({ tools: 2000, mountMs, deltaMs, statusMs, comparisons, updateComparisons, deltaReads, statusReads }));
        expect(comparisons).toBeLessThan(2000 * 10);
        expect(updateComparisons).toBeLessThan(2000 * 10);
        expect(statusReads).toBeLessThan(2000 * 100);
        const last = row(h.root, "1999");
        expect(last).toBeDefined();
        h.op({ op: "block", block: tool("next") });
        expect(row(h.root, "0")).toBe(finished);
        expect(row(h.root, "1999")).toBe(last);
        expect(text(h.root)).not.toContain("Couldn't render");
    } finally { h.dispose(); }
});

test("agent membership and thinking lookahead stay linear", () => {
    let reads = 0;
    const n = 2000;
    const counted = (v: any) => new Proxy(v, { get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); } });
    const tools = Array.from({ length: n }, (_, i) => counted({ ...tool(String(i), "ok"), agent: true }));
    const agents = Array.from({ length: n }, (_, i) => counted({ id: String(i), status: "done", startedAt: 0, endedAt: 1 }));
    const h = setup(tools, false, agents);
    try {
        console.log(JSON.stringify({ agentTools: n, reads }));
        expect(reads).toBeLessThan(n * 100);
        expect(text(h.root)).not.toContain("Couldn't render");
    } finally { h.dispose(); }
});

test("thinking lookahead stays linear", () => {
    const n = 2000;
    let accesses = 0;
    const blocks = new Proxy([tool("a"), ...Array.from({ length: n }, (_, i) => ({ t: "thinking", id: `t${i}`, text: "thought" })), tool("b")], {
        get(target, key, receiver) { if (/^\d+$/.test(String(key))) accesses++; return Reflect.get(target, key, receiver); },
    });
    const group = component(activity, "groupBlocks", {});
    const result = group(blocks);
    expect(result).toHaveLength(1);
    expect(result[0].steps).toHaveLength(n + 2);
    console.log(JSON.stringify({ thinkingBlocks: n, accesses }));
    expect(accesses).toBeLessThan(n * 10);
});


test("more work after prose keeps the rows before it, as they were", () => {
    const h = setup([tool("a")], false);
    try {
        h.op({ op: "block.patch", blockId: "a", patch: { status: "ok" } });
        const first = row(h.root, "a");
        h.op({ op: "block", block: { t: "text", id: "prose", text: "Next step" } });
        h.op({ op: "block", block: tool("b") });
        expect(row(h.root, "a")).toBe(first);
        expect(first.props.hidden).not.toBe(true);
        expect(row(h.root, "b")).toBeUndefined();
        expect(text(liveLineOf(h.root)!)).toContain("Starting monitor");
    } finally { h.dispose(); }
});

test("streaming Markdown retains code host, highlights finished lines at a bounded rate and preserves finished segments", async () => {
    let mounts = 0, highlights = 0;
    const highlighted: string[] = [];
    const Code = component(source("blocks/CodeBlock"), "CodeBlock", {
        RenderBoundary: boundary(), CopyButton: () => node("copy"),
        highlight: async (code: string) => { highlights++; highlighted.push(code); return "highlighted"; },
    });
    // The DOM side (lib/stream-dom.ts) is a browser's: here a block just records what it was given.
    const painted: { html: string; live: boolean; caret: boolean }[] = [];
    const Markdown = component(source("blocks/Markdown"), "Markdown", {
        RenderBoundary: boundary(), MarkdownRenderer, createReveal,
        paint: (el: Node, html: string, live: boolean, caret: boolean) => { el.props.innerHTML = html; painted.push({ html, live, caret }); },
        CodeBlock: (p: any) => { mounts++; return Code(p); },
    });
    const [value, setValue] = solid.createSignal("Finished paragraph.\n\n```ts\nconst a = 1;\n");
    const [streaming, setStreaming] = solid.createSignal(true);
    const root = node("root");
    const dispose = renderer.render(() => Markdown({ get text() { return value(); }, get streaming() { return streaming(); } }), root);
    try {
        const code = all(root).find((n) => has(n, "code"));
        const paragraph = all(root).find((n) => has(n, "md-block"));
        for (let i = 0; i < 100; i++) setValue(value() + `const v${i} = ${i};\n`);
        expect(mounts).toBe(1);
        expect(highlights).toBe(0);
        expect(all(root).find((n) => has(n, "code"))).toBe(code);
        expect(all(root).find((n) => has(n, "md-block"))).toBe(paragraph);
        expect(text(root)).toContain("const v99 = 99;");
        // A finished paragraph above the code was painted once, live, without the writing mark.
        expect(painted).toEqual([{ html: "<p>Finished paragraph.</p>\n", live: true, caret: false }]);
        // While it's written, the finished lines are highlighted once the interval has passed, in one go (the last
        // line may still be being typed: marked drops an open block's final newline).
        await Bun.sleep(300);
        expect(highlights).toBe(1);
        expect(highlighted[0]!.endsWith("const v98 = 98;")).toBe(true);
        const lit = all(root).find((n) => has(n, "code-lit"));
        expect(lit?.props.innerHTML).toBe("highlighted\n");
        highlights = 0;
        setValue(value() + "```\n\nAfter code.");
        setStreaming(false);
        await Promise.resolve();
        expect(mounts).toBe(1);
        expect(highlights).toBe(1);
        expect(all(root).find((n) => has(n, "code"))).toBe(code);
        expect(text(root)).not.toContain("Couldn't render");
    } finally { dispose(); }
});


test("a group's sub-agents card follows its rows", () => {
    const h = setup([tool("a", "ok")], true, [{ id: "agent", status: "done", startedAt: 0, endedAt: 1, blocks: [] }]);
    try {
        const first = row(h.root, "a");
        h.op({ op: "block", block: { ...tool("agent", "ok"), agent: true } });
        expect(row(h.root, "a")).toBe(first);
        const list = all(h.root).find((n) => has(n, "steps"))!;
        const agents = all(h.root).find((n) => has(n, "subagents"))!;
        expect(list.children.indexOf(first)).toBeLessThan(list.children.indexOf(agents));
        h.op({ op: "block", block: tool("b") });
        expect(row(h.root, "b")).toBeUndefined();
        h.op({ op: "block.patch", blockId: "b", patch: { status: "ok" } });
        expect(list.children.indexOf(row(h.root, "b"))).toBeLessThan(list.children.indexOf(agents));
        expect(row(h.root, "a")).toBe(first);
    } finally { h.dispose(); }
});

test("commands and edits are cards of their own, kept through output, completion and the next call", async () => {
    const h = setup([tool("read", "ok"), command("cmd")], false);
    try {
        // Running, it's the live line's: "Running" and the command, and no box under it until it's opened (#388).
        expect(row(h.root, "cmd")).toBeUndefined();
        for (let i = 0; i < 40; i++) h.op({ op: "append", blockId: "cmd", field: "progress", text: `line ${i}\n` });
        const line = () => liveLineOf(h.root)!;
        const stack = () => all(line()).find((n) => has(n, "live-stack"))!;
        const opened = () => all(line()).find((n) => has(n, "cmd-body"));
        expect(text(line())).toContain("Running");
        expect(text(line())).toContain("echo cmd");
        expect(all(line()).some((n) => has(n, "live-out"))).toBe(false);
        expect(opened()).toBeUndefined();
        // The line is a button: it opens to the block its row opens to, the command over its output as it comes.
        expect(stack().props.role).toBe("button");
        expect(stack().props.tabindex).toBe(0);
        expect(stack().props["aria-expanded"]).toBe(false);
        stack().props.onClick();
        expect(stack().props["aria-expanded"]).toBe(true);
        expect(text(all(opened()!).find((n) => has(n, "cmd-in"))!)).toContain("echo cmd");
        expect(text(opened()!)).toContain("line 39");
        expect(text(all(opened()!).find((n) => has(n, "cmd-foot"))!)).toContain("Running");
        // Enter or Space folds it again, and opens it.
        const key = (k: string) => stack().props.onKeyDown({ key: k, target: stack(), currentTarget: stack(), preventDefault() {} });
        key("Enter");
        expect(opened()).toBeUndefined();
        key(" ");
        expect(opened()).toBeDefined();
        // A roll to another state takes it away; back on the command, it's open as it was, and follows the output.
        h.setView("state", "activity", { label: "Retrying in 5s · Stop to cancel", since: 1000 });
        expect(text(line())).toContain("Retrying");
        expect(opened()).toBeUndefined();
        expect(stack().props.role).toBeUndefined();
        h.setView("state", "activity", undefined);
        // (The retry shows at once; the line moves on from it once it's been read: DWELL_MS.)
        await Bun.sleep(liveLine.DWELL_MS + 50);
        expect(text(line())).toContain("echo cmd");
        expect(stack().props["aria-expanded"]).toBe(true);
        h.op({ op: "append", blockId: "cmd", field: "progress", text: "line 40\n" });
        expect(text(opened()!)).toContain("line 40");
        // Done, it commits as its row, open as the reader left it; the line has no block of it any more.
        h.op({ op: "block.patch", blockId: "cmd", patch: { status: "ok", durationMs: 2000, output: "ok\n 14 pass\n 0 fail\n" } });
        const card = row(h.root, "cmd");
        expect(head(card).props["aria-expanded"]).toBe(true);
        expect(text(body(card)!)).toContain("14 pass");
        expect(!liveLineOf(h.root) || !opened()).toBe(true);
        expect(has(card, "tcard")).toBe(true);
        expect(has(card, "cmd-card")).toBe(true);
        // Its group is the command alone: the call before it keeps its own group.
        expect(all(h.root).filter((n) => has(n, "steps"))).toHaveLength(1);
        expect(text(card)).toContain("14 pass");
        const diff = { path: "src/a.ts", status: "modified", added: 2, removed: 1, hunks: [] };
        h.op({ op: "block", block: { t: "tool", id: "edit", name: "Edit", title: "Edit src/a.ts", input: { file_path: "/p/src/a.ts" }, status: "ok", diff } });
        expect(row(h.root, "cmd")).toBe(card);
        const edit = row(h.root, "edit");
        expect(has(edit, "edit-card")).toBe(true);
        expect(text(edit)).toContain("diff src/a.ts");
        // Folding the card hides the change; the header stays.
        all(edit).find((n) => n.tag === "button" && n.props["aria-expanded"] === true)!.props.onClick();
        expect(text(edit)).not.toContain("diff src/a.ts");
        expect(text(edit)).toContain("+2");
        // Find opens it again.
        h.setReveal({ turnId: "turn", part: "edit" });
        expect(text(edit)).toContain("diff src/a.ts");
        expect(text(h.root)).not.toContain("Couldn't render");
    } finally { h.dispose(); }
});

test("an edit with no diff still offers its input and output, as its row did", () => {
    // Claude Code builds diffs only for Write and Edit: a notebook edit or a MultiEdit comes back without one.
    const notebook = { t: "tool", id: "nb", name: "NotebookEdit", title: "NotebookEdit", input: { notebook_path: "/p/a.ipynb", new_source: "print('kiwi')" }, status: "ok", output: "Updated cell kiwi", outputTruncated: true };
    const multi = { t: "tool", id: "multi", name: "MultiEdit", title: "MultiEdit", input: { file_path: "/p/b.ts", edits: [{ old_string: "a", new_string: "mango" }] }, status: "ok", output: "Applied 1 edit to b.ts" };
    const h = setup([notebook, multi], false);
    try {
        for (const [id, input, output] of [["nb", "print('kiwi')", "Updated cell kiwi"], ["multi", "mango", "Applied 1 edit to b.ts"]] as const) {
            const card = row(h.root, id);
            expect(has(card, "edit-card")).toBe(true);
            // Folded at first, as the row was; its button opens the details.
            const toggle = all(card).find((n) => n.tag === "button" && n.props["aria-expanded"] !== undefined);
            expect(toggle).toBeDefined();
            if (!toggle!.props["aria-expanded"]) toggle!.props.onClick();
            expect(text(card)).toContain(input);
            expect(text(card)).toContain(output);
        }
        expect(text(row(h.root, "nb"))).toContain("Show full output");
        expect(text(h.root)).not.toContain("Couldn't render");
    } finally { h.dispose(); }
});


// A command: one quiet row until it's opened.
const head = (card: Node) => all(card).find((n) => has(n, "cmd-h"))!;
const body = (card: Node) => all(card).find((n) => has(n, "cmd-body"));
const tailOf = (card: Node) => all(card).find((n) => has(n, "cmd-tail"));
const finished = (id: string, status = "ok", output = "kiwi output\n 14 pass\n") => ({ ...command(id, status), durationMs: 2000, output });

test("a command is one quiet row by default: no card, no Done pill", () => {
    const h = setup([finished("cmd")], false);
    try {
        const card = row(h.root, "cmd");
        expect(has(card, "cmd-row")).toBe(true);
        expect(head(card).props.role).toBe("button");
        expect(head(card).props.tabindex).toBe(0);
        expect(head(card).props["aria-expanded"]).toBe(false);
        // Built only when it's opened.
        expect(body(card)).toBeUndefined();
        // The command, how it went (a test run's tally) and how long it took; not what it printed, nor "Done".
        expect(text(head(card))).toContain("echo cmd");
        expect(text(head(card))).toContain("14 pass");
        expect(text(head(card))).toContain("2s");
        expect(text(card)).not.toContain("Done");
        expect(text(card)).not.toContain("kiwi output");
        expect(tailOf(card)).toBeUndefined();
        // A multi-line command shows its first line (CSS adds " …"); the whole of it is in the body.
        h.op({ op: "block", block: { ...finished("multi"), input: { command: "cd app\nmake all" } } });
        const multi = row(h.root, "multi");
        expect(text(multi)).toContain("cd app");
        expect(text(multi)).not.toContain("make all");
        expect(all(multi).some((n) => has(n, "cmd-l") && has(n, "solo") && has(n, "more"))).toBe(true);
        head(multi).props.onClick();
        expect(text(body(multi)!)).toContain("cd app\nmake all");
        // Even with nothing printed, it opens: the whole command, "No output", and how it ended.
        h.op({ op: "block", block: { ...finished("quiet", "ok", ""), summary: "(no output)" } });
        const quiet = row(h.root, "quiet");
        expect(text(head(quiet))).toContain("(no output)");
        head(quiet).props.onKeyDown({ key: "Enter", target: head(quiet), currentTarget: head(quiet), preventDefault() {} });
        expect(head(quiet).props["aria-expanded"]).toBe(true);
        expect(text(body(quiet)!)).toContain("No output");
        expect(text(all(quiet).find((n) => has(n, "cmd-foot"))!)).toContain("Exit 0");
        head(quiet).props.onKeyDown({ key: " ", target: head(quiet), currentTarget: head(quiet), preventDefault() {} });
        expect(head(quiet).props["aria-expanded"]).toBe(false);
        expect(text(h.root)).not.toContain("Couldn't render");
    } finally { h.dispose(); }
});

test("folded, a command's row says only its description; without one (Codex) the command is the label, shortened", () => {
    const h = setup([
        { ...finished("desc"), input: { command: "bun test ./test/a.test.ts", description: "Run the transcript tests" } },
        { ...finished("codex"), input: { command: "cd '/Users/me/my repo' && bun run typecheck\nbun test" } },
    ], false);
    try {
        const desc = row(h.root, "desc");
        expect(text(all(desc).find((n) => has(n, "cmd-l"))!)).toBe("Run the transcript tests");
        // Not the command, faint, beside it: that's in the row opened.
        expect(text(head(desc))).not.toContain("bun test");
        head(desc).props.onClick();
        expect(text(body(desc)!)).toContain("bun test ./test/a.test.ts");
        const codex = row(h.root, "codex");
        const label = all(codex).find((n) => has(n, "cmd-l"))!;
        expect(text(label)).toBe("bun run typecheck");
        expect(has(label, "solo")).toBe(true);
        expect(has(label, "more")).toBe(true);
        // The whole of it is in the row opened (and Copy), not a native tooltip: a long one made a wall of one (#389).
        expect(all(codex).some((n) => typeof n.props.title === "string" && n.props.title.includes("bun test"))).toBe(false);
        head(codex).props.onClick();
        expect(text(body(codex)!)).toContain("cd '/Users/me/my repo' && bun run typecheck\nbun test");
    } finally { h.dispose(); }
});

test("every command row has the same columns, in order, whatever it shows: so a run of them lines up (transcript.css)", () => {
    const h = setup([
        { ...finished("tally"), sandboxed: true },
        { ...finished("quiet", "ok", ""), summary: "(no output)" },
        { ...finished("failed", "error", "error: kiwi\nExit code: 1") },
        { ...command("denied", "denied"), summary: "Declined" },
        { ...finished("bg"), input: { command: "make serve", run_in_background: true }, summary: "Running in background as bash_1" },
    ], false, [], undefined, false);
    try {
        const cells = (id: string) => head(row(h.root, id)).children.filter((n) => n.tag !== "#text").map((n) => n.props.class?.split(" ")[0]);
        for (const id of ["tally", "quiet", "failed", "denied", "bg"]) expect(cells(id)).toEqual(["cmd-what", "cmd-tags", "cmd-res", "cmd-time", "chev-w"]);
        const cell = (id: string, cls: string) => text(all(head(row(h.root, id))).find((n) => has(n, cls))!);
        expect(cell("tally", "cmd-tags")).toContain("sandbox");
        expect(cell("tally", "cmd-res")).toBe("14 pass");
        expect(cell("tally", "cmd-time")).toBe("2s");
        // What it came to is one column: a summary, an exit, a tally.
        expect(cell("quiet", "cmd-res")).toBe("(no output)");
        expect(cell("quiet", "cmd-tags")).toBe("");
        expect(cell("failed", "cmd-res")).toBe("Exit 1");
        expect(cell("denied", "cmd-res")).toBe("Declined");
        expect(cell("bg", "cmd-tags")).toBe("Started in the background");
    } finally { h.dispose(); }
});

test("opened: the whole command after $, highlighted, over its output (failures red, passes green), each with Copy; a footer with exit and time", () => {
    const h = setup([{ ...finished("cmd", "ok", "\x1b[32m✓ renders\x1b[0m\nerror: one\nplain\n"), input: { command: "FOO=1 bun test --bail 'a b' | tee out.txt # go" } }], false);
    try {
        const card = row(h.root, "cmd");
        head(card).props.onClick();
        const b = body(card)!;
        const cin = all(b).find((n) => has(n, "cmd-in"))!;
        expect(text(cin)).toContain("$");
        expect(text(cin)).toContain("FOO=1 bun test --bail 'a b' | tee out.txt # go");
        const kind = (cls: string) => all(cin).filter((n) => has(n, cls)).map(text);
        expect(kind("f")).toEqual(["bun", "tee"]);
        expect(kind("t")).toEqual([" --bail"]);
        expect(kind("s")).toEqual(["'a b'"]);
        expect(kind("k")).toEqual(["|"]);
        expect(kind("c")).toEqual(["# go"]);
        const out = all(b).find((n) => has(n, "cmd-out"))!;
        expect(all(out).filter((n) => has(n, "ok")).map(text)).toEqual(["✓ renders"]);
        expect(all(out).filter((n) => has(n, "er")).map(text)).toEqual(["error: one"]);
        // A Copy for the command on the row, and one each for the command and the output in the body.
        const copies = all(card).filter((n) => n.props.copy).map((n) => [n.props.label, n.props.copy()]);
        expect(copies).toEqual([
            ["Copy command", "FOO=1 bun test --bail 'a b' | tee out.txt # go"],
            ["Copy command", "FOO=1 bun test --bail 'a b' | tee out.txt # go"],
            ["Copy output", "✓ renders\nerror: one\nplain"],
        ]);
        const foot = all(b).find((n) => has(n, "cmd-foot"))!;
        expect(text(foot)).toContain("Exit 0");
        expect(text(foot)).toContain("2s");
        expect(foot.props["data-find-skip"]).toBe(true);
    } finally { h.dispose(); }
});

test("a running command shows its last line under the row; a failed one says Exit N in red, its last line of output under it", () => {
    // With no live line (a turn left running): a running command is a row like the others.
    const h = setup([command("cmd")], false, [], undefined, false);
    try {
        const card = row(h.root, "cmd");
        for (let i = 0; i < 5; i++) h.op({ op: "append", blockId: "cmd", field: "progress", text: `line ${i}\n` });
        expect(body(card)).toBeUndefined();
        expect(text(tailOf(card)!)).toBe("line 4");
        expect(tailOf(card)!.props["data-find-skip"]).toBe(true);
        expect(text(card)).not.toContain("line 3");
        h.op({ op: "block.patch", blockId: "cmd", patch: { status: "error", durationMs: 2000, output: "Compiling\nerror: kiwi is undefined\n\nExit code: 1" } });
        expect(row(h.root, "cmd")).toBe(card);
        expect(has(card, "fail")).toBe(true);
        expect(body(card)).toBeUndefined();
        expect(text(tailOf(card)!)).toBe("error: kiwi is undefined");
        expect(has(tailOf(card)!, "err")).toBe(true);
        expect(text(all(card).find((n) => has(n, "exit"))!)).toBe("Exit 1");
        expect(text(card)).not.toContain("Compiling");
        // Opened, the output is in the body, its error line red, and the last line under the row goes.
        head(card).props.onClick();
        expect(text(body(card)!)).toContain("Compiling");
        expect(all(body(card)!).filter((n) => has(n, "er")).map(text)).toContain("error: kiwi is undefined");
        expect(text(all(card).find((n) => has(n, "cmd-foot"))!)).toContain("Exit 1");
        expect(tailOf(card)).toBeUndefined();
    } finally { h.dispose(); }
});

test("a command running in the background says so, with Stop for its task; finished, it says that", () => {
    const h = setup([{ ...finished("bg", "ok", "Command running in background with ID: bash_1"), input: { command: "npm run dev", run_in_background: true } }], false, [], "session-bg");
    try {
        h.setView("state", "backgroundTasks", [{ id: "bash_1", provider: "harness", kind: "shell", label: "npm run dev", toolUseId: "bg", startedAt: 1000, status: "running", stoppable: true }]);
        const card = row(h.root, "bg");
        expect(has(card, "bg")).toBe(true);
        expect(text(head(card))).toContain("In the background");
        // Its tag doesn't repeat the command as a tooltip.
        expect(all(card).some((n) => typeof n.props.title === "string" && n.props.title.includes("npm run dev"))).toBe(false);
        // No tally while it runs, and its time is the task's.
        expect(text(head(card))).toContain("1s");
        const stop = all(card).find((n) => n.tag === "button" && has(n, "stop"))!;
        expect(stop.props["aria-label"]).toContain("npm run dev");
        stop.props.onClick({ stopPropagation() {} });
        expect(h.stops).toEqual([["session-bg", ["bash_1"]]]);
        h.setView("state", "backgroundTasks", 0, { status: "done", endedAt: 1500 });
        expect(text(head(card))).toContain("Finished");
        expect(all(card).some((n) => n.tag === "button" && has(n, "stop"))).toBe(false);
        // How long the task ran, not the call that started it; opened, the footer says how it ended.
        expect(text(head(card))).toContain("500ms");
        head(card).props.onClick();
        expect(text(all(card).find((n) => has(n, "cmd-foot"))!)).toContain("Finished");
        head(card).props.onClick();
        // Cleared from the session's list: it says only where it was started.
        h.setView("state", "backgroundTasks", []);
        expect(has(card, "bg")).toBe(false);
        expect(text(head(card))).toContain("Started in the background");
        // A Harness shell isn't linked to its call: its result names it, and its summary isn't said twice.
        h.op({ op: "block", block: { ...finished("shell", "ok", "Started background shell bash_2 (pid 7)."), summary: "Running in background as bash_2", input: { command: "tail -f log", run_in_background: true } } });
        h.setView("state", "backgroundTasks", [{ id: "bash_2", provider: "harness", kind: "shell", label: "tail -f log", startedAt: 1000, status: "running", stoppable: true }]);
        const shell = row(h.root, "shell");
        expect(text(head(shell))).toContain("In the background");
        expect(text(head(shell))).not.toContain("Running in background as");
        all(shell).find((n) => n.tag === "button" && has(n, "stop"))!.props.onClick({ stopPropagation() {} });
        expect(h.stops.at(-1)).toEqual(["session-bg", ["bash_2"]]);
    } finally { h.dispose(); }
});

test("a command card opens on click and stays open when it's drawn again", () => {
    const h = setup([finished("cmd"), finished("other")], false);
    try {
        const card = row(h.root, "cmd");
        head(card).props.onClick();
        expect(head(card).props["aria-expanded"]).toBe(true);
        expect(text(body(card)!)).toContain("kiwi output");
        // Its neighbour is still folded.
        expect(body(row(h.root, "other"))).toBeUndefined();
        // The turn ends: the work folds away under "Worked for", the cards with it; opened again, they're drawn anew.
        h.setView("turns", 0, { status: "done", endedAt: 5000 });
        h.setView("state", "busy", false);
        expect(row(h.root, "cmd")).toBeUndefined();
        all(h.root).find((n) => n.tag === "button" && has(n, "fold"))!.props.onClick();
        const again = row(h.root, "cmd");
        expect(again).toBeDefined();
        expect(again).not.toBe(card);
        expect(head(again).props["aria-expanded"]).toBe(true);
        expect(text(body(again)!)).toContain("kiwi output");
        expect(body(row(h.root, "other"))).toBeUndefined();
        // Folded again, it stays folded.
        head(again).props.onClick();
        all(h.root).find((n) => n.tag === "button" && has(n, "fold"))!.props.onClick();
        all(h.root).find((n) => n.tag === "button" && has(n, "fold"))!.props.onClick();
        expect(body(row(h.root, "cmd"))).toBeUndefined();
        expect(text(h.root)).not.toContain("Couldn't render");
    } finally { h.dispose(); }
});

test("a session's command cards stay as they were left when the session is drawn again, and only in that session", () => {
    const h = setup([finished("cmd")], false, [], "session-a");
    head(row(h.root, "cmd")).props.onClick();
    // Another session is opened: this one's transcript goes.
    h.dispose();
    {
        const back = h.mount("session-a");
        try {
            expect(head(row(back.root, "cmd")).props["aria-expanded"]).toBe(true);
            expect(text(body(row(back.root, "cmd"))!)).toContain("kiwi output");
        } finally { back.dispose(); }
        // A fork has the same calls, under another session: folded there.
        const fork = h.mount("session-b");
        try {
            expect(head(row(fork.root, "cmd")).props["aria-expanded"]).toBe(false);
            expect(body(row(fork.root, "cmd"))).toBeUndefined();
        } finally { fork.dispose(); }
    }
});

test("find opens a folded command card, and it stays open", () => {
    const h = setup([finished("cmd")], false);
    try {
        const card = row(h.root, "cmd");
        expect(body(card)).toBeUndefined();
        h.setReveal({ turnId: "turn", part: "cmd" });
        expect(head(card).props["aria-expanded"]).toBe(true);
        expect(text(body(card)!)).toContain("kiwi output");
        h.setReveal(undefined);
        expect(text(body(card)!)).toContain("kiwi output");
    } finally { h.dispose(); }
});

test("with tool activity set to open, a command card starts open", () => {
    const h = setup([finished("cmd")], true);
    try {
        expect(head(row(h.root, "cmd")).props["aria-expanded"]).toBe(true);
        expect(text(row(h.root, "cmd"))).toContain("kiwi output");
    } finally { h.dispose(); }
});
