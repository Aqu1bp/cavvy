import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { createStore, produce } from "../../gui/node_modules/solid-js/store/dist/store.js";
import { all, component, node, renderer, text, type Node } from "../helpers/gui-render";
import { boundary } from "../helpers/render-boundary";
import * as format from "../../gui/src/lib/format";
import { MarkdownRenderer } from "../../gui/src/lib/markdown";
import { applyOp } from "../../src/server/timeline";

const source = (file: string) => readFileSync(new URL(`../../gui/src/components/${file}.tsx`, import.meta.url), "utf8").replace(/^import [\s\S]*?;\n/gm, "");
// An optional historical source makes the same workload measurable before the fix.
const activity = process.env.ACTIVITY_BEFORE ? readFileSync(process.env.ACTIVITY_BEFORE, "utf8").replace(/^import [\s\S]*?;\n/gm, "") : source("blocks/Activity");
// A call that streams progress and stays in its group (commands and edits get cards of their own).
const tool = (id: string, status = "running"): any => ({ t: "tool", id, name: "Monitor", title: "Monitor", input: { description: `watch ${id}` }, status, startedAt: 1000 });
const command = (id: string, status = "running"): any => ({ t: "tool", id, name: "Bash", title: "Bash", input: { command: `echo ${id}` }, status, startedAt: 1000 });
const has = (n: Node, cls: string) => n.props.class?.split(" ").includes(cls);
const row = (root: Node, id: string) => all(root).find((n) => n.props["data-find"] === id)!;

function setup(blocks: any[], expanded = true, agents: any[] = [], session?: string) {
    const [view, setView] = createStore<any>({ state: { id: "session", busy: true, interactions: [] }, turns: [{ id: "turn", status: "running", startedAt: 1000, blocks }], agents });
    const [clock, setClock] = solid.createSignal(2000);
    const [reveal, setReveal] = solid.createSignal<any>();
    let icons = 0, groups = 0;
    const icon = () => { icons++; return node("icon"); };
    const scope = {
        ...format, RenderBoundary: boundary(), now: clock, prefs: { expandActivity: expanded, showThinking: true }, findReveal: reveal,
        CodeBlock: (p: any) => { const n = node("code"); solid.createRenderEffect(() => n.text = p.code); return n; },
        DiffView: (p: any) => { const n = node("diff"); solid.createRenderEffect(() => n.text = `diff ${p.diff.path}`); return n; },
        Markdown: () => node("markdown"), CopyButton: icon, Spinner: icon, openReview: () => {}, openInEditor: () => {},
        ...Object.fromEntries(["AlertTriangle", "Bot", "Check", "ChevronDown", "ChevronRight", "ClipboardList", "FileDiff", "FilePen", "FilePlus2", "FileText", "FolderTree", "Globe", "Hand", "ListChecks", "MessageCircleQuestion", "Plug", "Radar", "Search", "ShieldCheck", "SquareArrowOutUpRight", "SquareTerminal", "Wrench", "X", "Brain"].map((name) => [name, icon])),
    };
    // One copy of the module, as the app has: its components share its state (the command cards' folds).
    const { ActivityGroup, CardFoldsProvider, groupBlocks } = component(`${activity}\nconst moduleExports = { ActivityGroup, CardFoldsProvider, groupBlocks };`, "moduleExports", scope);
    const TurnView = component(source("TurnView"), "TurnView", { ...scope, ActivityGroup, groupBlocks: (b: any) => { groups++; return groupBlocks(b); } });
    /** Draws the turn again, as a session's transcript does when it's opened (in `session`'s folds, when given). */
    const mount = (session?: string) => {
        const root = node("root");
        const turn = () => TurnView({ get turn() { return view.turns[0]; }, get state() { return view.state; }, get agents() { return view.agents; }, last: true });
        const dispose = renderer.render(() => (session ? CardFoldsProvider({ sessionId: session, get children() { return turn(); } }) : turn()), root);
        return { root, dispose };
    };
    const { root, dispose } = mount(session);
    const op = (value: any) => setView(produce((v: any) => applyOp(v, { turnId: "turn", ...value })));
    return { root, view, setView, op, dispose, mount, setClock, setReveal, icons: () => icons, groups: () => groups };
}

test("one row and icon survive progress, completion, next calls, folding and find", () => {
    const h = setup([tool("a")], false);
    try {
        const first = row(h.root, "a");
        expect(first).toBeDefined();
        const icon = all(first).find((n) => n.tag === "icon");
        for (let i = 0; i < 40; i++) h.op({ op: "append", blockId: "a", field: "progress", text: `line ${i}\n` });
        expect(row(h.root, "a")).toBe(first);
        expect(all(first).find((n) => n.tag === "icon")).toBe(icon);
        h.op({ op: "block.patch", blockId: "a", patch: { status: "ok", durationMs: 2000 } });
        expect(row(h.root, "a")).toBe(first);
        expect(first.parent?.props.hidden).not.toBe(true);
        h.op({ op: "block", block: tool("b") });
        expect(row(h.root, "a")).toBe(first);
        const second = row(h.root, "b");
        const summary = all(h.root).find((n) => n.tag === "button" && has(n, "wrow") && !has(n, "tool-line"))!;
        summary.props.onClick();
        const detail = all(first).find((n) => has(n, "tool-detail"));
        expect(detail).toBeDefined();
        h.op({ op: "block.patch", blockId: "b", patch: { status: "ok" } });
        h.op({ op: "block", block: tool("c") });
        expect(row(h.root, "a")).toBe(first);
        expect(row(h.root, "b")).toBe(second);
        expect(all(first).find((n) => has(n, "tool-detail"))).toBe(detail);
        summary.props.onClick();
        expect(row(h.root, "a")).toBe(first);
        h.setReveal({ turnId: "turn", part: "a" });
        expect(first.parent?.props.hidden).not.toBe(true);
        expect(row(h.root, "a")).toBe(first);
        expect(all(first).find((n) => has(n, "tool-head"))?.props.style?.display).not.toBe("none");
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
        const running = row(h.root, "1999");
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
        h.op({ op: "block", block: tool("next") });
        expect(row(h.root, "0")).toBe(finished);
        expect(row(h.root, "1999")).toBe(running);
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


test("more work after prose folds the old group tail without remounting it", () => {
    const h = setup([tool("a")], false);
    try {
        const first = row(h.root, "a");
        h.op({ op: "block.patch", blockId: "a", patch: { status: "ok" } });
        expect(first.parent?.props.hidden).not.toBe(true);
        h.op({ op: "block", block: { t: "text", id: "prose", text: "Next step" } });
        h.op({ op: "block", block: tool("b") });
        expect(row(h.root, "a")).toBe(first);
        expect(first.parent?.props.hidden).toBe(true);
        expect(row(h.root, "b").parent?.props.hidden).not.toBe(true);
    } finally { h.dispose(); }
});

test("streaming Markdown retains code host, defers highlighting until closed and preserves finished segments", async () => {
    let mounts = 0, highlights = 0;
    const Code = component(source("blocks/CodeBlock"), "CodeBlock", {
        RenderBoundary: boundary(), CopyButton: () => node("copy"),
        highlight: async () => { highlights++; return "highlighted"; },
    });
    const Markdown = component(source("blocks/Markdown"), "Markdown", {
        RenderBoundary: boundary(), MarkdownRenderer,
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
        setValue(value() + "```\n\nAfter code.");
        setStreaming(false);
        await Promise.resolve();
        expect(mounts).toBe(1);
        expect(highlights).toBe(1);
        expect(all(root).find((n) => has(n, "code"))).toBe(code);
        expect(text(root)).not.toContain("Couldn't render");
    } finally { dispose(); }
});


test("agent activity follows finished rows and displaces a retained plain tail", () => {
    const h = setup([tool("a", "ok")], true, [{ id: "agent", status: "done", startedAt: 0, endedAt: 1, blocks: [] }]);
    try {
        const first = row(h.root, "a");
        h.op({ op: "block", block: { ...tool("agent", "ok"), agent: true } });
        expect(row(h.root, "a")).toBe(first);
        expect(has(first.parent!, "current")).not.toBe(true);
        const list = all(h.root).find((n) => has(n, "activity-steps"))!;
        const agents = all(h.root).find((n) => has(n, "subagents"))!;
        expect(list.children.indexOf(first.parent!)).toBeLessThan(list.children.indexOf(agents));
        h.op({ op: "block", block: tool("b") });
        expect(list.children.indexOf(agents)).toBeLessThan(list.children.indexOf(row(h.root, "b").parent!));
    } finally { h.dispose(); }
});

test("commands and edits are cards of their own, kept through output, completion and the next call", () => {
    const h = setup([tool("read", "ok"), command("cmd")], false);
    try {
        const card = row(h.root, "cmd");
        expect(has(card, "tcard")).toBe(true);
        expect(has(card, "cmd-card")).toBe(true);
        // Its group is the command alone: the call before it keeps its own group.
        expect(all(h.root).filter((n) => has(n, "acts"))).toHaveLength(1);
        for (let i = 0; i < 40; i++) h.op({ op: "append", blockId: "cmd", field: "progress", text: `line ${i}\n` });
        expect(row(h.root, "cmd")).toBe(card);
        expect(text(card)).toContain("line 39");
        expect(text(card)).toContain("Running");
        h.op({ op: "block.patch", blockId: "cmd", patch: { status: "ok", durationMs: 2000, output: "ok\n 14 pass\n 0 fail\n" } });
        expect(row(h.root, "cmd")).toBe(card);
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


// A command card: one line until it's opened.
const head = (card: Node) => all(card).find((n) => n.tag === "button" && has(n, "cmd-h"))!;
const body = (card: Node) => all(card).find((n) => has(n, "tcard-body"));
const finished = (id: string, status = "ok", output = "kiwi output\n 14 pass\n") => ({ ...command(id, status), durationMs: 2000, output });

test("a command card is folded to its header line by default", () => {
    const h = setup([finished("cmd")], false);
    try {
        const card = row(h.root, "cmd");
        expect(head(card).props["aria-expanded"]).toBe(false);
        expect(body(card)).toBeUndefined();
        // The command, how long it took and how it went; not what it printed.
        expect(text(head(card))).toContain("echo cmd");
        expect(text(head(card))).toContain("2s");
        expect(text(head(card))).toContain("14 pass");
        expect(text(card)).not.toContain("kiwi output");
        expect(all(card).some((n) => has(n, "tcard-tail"))).toBe(false);
        // A multi-line command shows its first line; the whole of it is in the body.
        h.op({ op: "block", block: { ...finished("multi"), input: { command: "cd app\nmake all" } } });
        const multi = row(h.root, "multi");
        expect(head(multi).props["aria-expanded"]).toBe(false);
        expect(text(multi)).toContain("cd app");
        expect(text(multi)).not.toContain("make all");
        // With nothing to open, there's no chevron and nothing to toggle.
        h.op({ op: "block", block: { ...finished("quiet", "ok", ""), summary: "(no output)" } });
        const quiet = row(h.root, "quiet");
        expect(head(quiet).props.disabled).toBe(true);
        expect(head(quiet).props["aria-expanded"]).toBeUndefined();
        expect(text(h.root)).not.toContain("Couldn't render");
    } finally { h.dispose(); }
});

test("a running command shows its last line folded; a failed one stays folded on its last line of output", () => {
    const h = setup([command("cmd")], false);
    try {
        const card = row(h.root, "cmd");
        for (let i = 0; i < 5; i++) h.op({ op: "append", blockId: "cmd", field: "progress", text: `line ${i}\n` });
        expect(body(card)).toBeUndefined();
        const tail = () => all(card).find((n) => has(n, "tcard-tail"));
        expect(text(tail()!)).toBe("line 4");
        expect(tail()!.props["data-find-skip"]).toBe(true);
        expect(text(card)).not.toContain("line 3");
        expect(text(card)).toContain("Running");
        h.op({ op: "block.patch", blockId: "cmd", patch: { status: "error", durationMs: 2000, output: "Compiling\nerror: kiwi is undefined\n\nExit code: 1" } });
        expect(row(h.root, "cmd")).toBe(card);
        expect(body(card)).toBeUndefined();
        expect(text(tail()!)).toBe("error: kiwi is undefined");
        expect(has(tail()!, "err")).toBe(true);
        expect(text(card)).toContain("Failed");
        expect(text(card)).not.toContain("Compiling");
        // Opened, the output is in the body and the header's glimpse goes.
        head(card).props.onClick();
        expect(text(body(card)!)).toContain("Compiling");
        expect(tail()).toBeUndefined();
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
