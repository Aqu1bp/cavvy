import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { backgroundOf, kindName, runnerName, runningCount, stopOutcome, taskMeta } from "../gui/src/lib/background";
import type { BackgroundTaskInfo } from "../src/server/protocol";
import { componentCode, elements } from "./gui-component-harness";
import { plural } from "../gui/src/lib/format";

// Render the actual LiveHead branches without a browser or a listening socket.
const source = readFileSync(new URL("../gui/src/components/TurnView.tsx", import.meta.url), "utf8");
const liveHead = source.slice(source.indexOf("const SPECIAL"), source.indexOf("type Changed"));
const code = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "node", jsxFragmentFactory: "Fragment" } } }).transformSync(liveHead).replace("export function LiveHead", "function LiveHead");
const node = (tag: string, props: any, ...children: any[]): any => {
    if (tag === "Show") return props.when ? children.map((child) => typeof child === "function" ? child(() => props.when) : child) : props.fallback;
    return children;
};
const render = new Function("node", "Show", "Fragment", "now", "duration", `${code}; return LiveHead;`)(node, "Show", "Fragment", () => 1000, () => "1s");
const text = (tree: any): string => Array.isArray(tree) ? tree.map(text).join("") : tree == null ? "" : String(tree);

for (const kind of ["command", "monitor", "sub-agent"]) test(`GUI shows the actual background ${kind} wait, not the generic working label`, () => {
    const label = `Waiting for background ${kind}: Run checks · Esc to stop it`;
    const displayed = text(render({ state: { activity: { label, since: 0 } } }));
    expect(displayed).toContain(label);
    expect(displayed).not.toContain("Working for");
    expect(displayed.match(/Esc/g)).toHaveLength(1);
});

test("ordinary work and approval waiting keep their existing labels", () => {
    expect(text(render({ state: { activity: { label: "Thinking", since: 0 } } }))).toContain("Working for");
    expect(text(render({ state: {}, waiting: true }))).toContain("Waiting for you");
});

// ---------------------------------------------------------------------------
// The Background panel (gui/src/lib/background.ts): what it lists and says.


const task = (o: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo => ({ id: "t1", provider: "claude-code", kind: "agent", label: "Map auth", startedAt: 0, status: "running", stoppable: true, ...o });

test("the Background panel lists running tasks and those that stopped when Harness quit, not ended ones", () => {
    const tasks = [task(), task({ id: "t2", status: "done" }), task({ id: "t3", status: "stopped", lost: true }), task({ id: "t4", status: "stopped" })];
    expect(backgroundOf({ backgroundTasks: tasks, shells: [] }).map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(runningCount(backgroundOf({ backgroundTasks: tasks, shells: [] }))).toBe(1);
    expect(backgroundOf(undefined)).toEqual([]);
});

test("from a server without backgroundTasks, the panel lists its running shells and monitors", () => {
    const shells = [
        { id: "bash_1", command: "npm run dev", running: true, exitCode: null, startedAt: 5 },
        { id: "bash_2", command: "ls", running: false, exitCode: 0, startedAt: 6 },
        { id: "monitor_1", command: "tail -f log", running: true, exitCode: null, startedAt: 7, monitor: { description: "Watch the log", events: 2, expiresAt: 100_000 } },
    ];
    expect(backgroundOf({ shells })).toEqual([
        { id: "bash_1", provider: "harness", kind: "shell", label: "npm run dev", startedAt: 5, status: "running", stoppable: true },
        { id: "monitor_1", provider: "harness", kind: "monitor", label: "Watch the log", startedAt: 7, status: "running", stoppable: true },
    ]);
});

test("a task's row says its kind, who runs it, and how long it's run (a monitor's time left; a lost one's fate)", () => {
    const providers = [{ id: "claude-code", name: "Claude Code" }, { id: "gemini", name: "Gemini" }];
    expect(kindName(task())).toBe("Sub-agent");
    expect(kindName(task({ kind: "shell" }))).toBe("Shell");
    expect(kindName(task({ kind: "other" }))).toBe("Task");
    expect(runnerName(task(), providers)).toBe("Claude Code");
    expect(runnerName(task({ provider: "gemini" }), providers)).toBe("Gemini");
    expect(runnerName(task({ provider: "harness" }), providers)).toBe("Harness");
    const dur = (ms: number) => `${ms / 1000}s`;
    expect(taskMeta(task({ startedAt: 1000 }), [], 6000, dur)).toBe("5s");
    expect(taskMeta(task({ status: "stopped", lost: true }), [], 6000, dur)).toBe("Stopped when Harness quit");
    const shells = [{ id: "monitor_1", command: "x", running: true, exitCode: null, startedAt: 0, monitor: { description: "d", events: 0, expiresAt: 125_000 } }];
    expect(taskMeta(task({ id: "monitor_1", kind: "monitor" }), shells, 5000, dur)).toBe("2m left");
});

test("a stop's toast says what stopped and what couldn't be", () => {
    expect(stopOutcome({})).toEqual({ message: "Nothing was running", level: "info" });
    expect(stopOutcome({ a: "stopped" })).toEqual({ message: "Stopped 1 task", level: "success" });
    expect(stopOutcome({ a: "stopped", b: "stopped", c: "not_stoppable", d: "timeout" })).toEqual({ message: "Stopped 2 tasks; 1 didn't confirm yet; 1 couldn't be stopped on its own", level: "warn" });
});

test("the side panel draws the Background section in place of the separate shell and monitor lists, and the composer has its count", () => {
    const panel = readFileSync(new URL("../gui/src/components/RightPanel.tsx", import.meta.url), "utf8");
    expect(panel).toContain("<BackgroundTasks handle={p.handle} />");
    expect(panel).not.toContain("function Shells(");
    expect(panel).not.toContain("function Monitors(");
    const composer = readFileSync(new URL("../gui/src/components/Composer.tsx", import.meta.url), "utf8");
    expect(composer).toContain("<BackgroundChip sessionId={p.sessionId} />");
    const section = readFileSync(new URL("../gui/src/components/BackgroundTasks.tsx", import.meta.url), "utf8");
    // Stop all asks first; each row stops its own task.
    expect(section).toContain('title="Stop all background work?"');
    expect(section).toContain("stopBackground(p.handle.id, [p.t.id])");
});

// The section itself, rendered by the harness (no browser): its rows, Stop on each, and Stop all behind a confirm.

function renderSection(tasks: BackgroundTaskInfo[]) {
    const stops: { id: string; ids?: string[] }[] = [];
    const sets: unknown[] = [];
    const node = (tag: any, props: Record<string, any> | null, ...children: any[]): any => (typeof tag === "function" ? tag({ ...(props ?? {}), children: children.length === 1 ? children[0] : children }) : { tag, props: props ?? {}, children });
    const Section = componentCode("BackgroundTasks", {
        createSignal: (initial: unknown) => [() => initial, (v: unknown) => void sets.push(v)],
        For: (p: { each: unknown[]; children: (x: unknown) => unknown }) => p.each.map((x) => p.children(x)),
        Show: (p: { when: unknown; children: unknown; fallback?: unknown }) => (p.when ? p.children : p.fallback),
        ConfirmDialog: (p: Record<string, any>) => ({ tag: "ConfirmDialog", props: p, children: [p.children] }),
        Bot: "Bot", Layers: "Layers", Radar: "Radar", Terminal: "Terminal", Workflow: "Workflow",
        app: { providers: [{ id: "claude-code", name: "Claude Code" }] },
        handleFor: () => undefined,
        openBackground() {},
        stopBackground: async (id: string, ids?: string[]) => void stops.push({ id, ids }),
        backgroundOf, kindName, runnerName, runningCount, taskMeta,
        duration: (ms: number) => `${Math.round(ms / 1000)}s`,
        plural,
        now: () => 10_000,
        React: { Fragment: "Fragment" },
        node,
    });
    const tree = Section({ handle: { id: "s1", view: { state: { backgroundTasks: tasks, shells: [] } } } });
    const text = (t: any): string => (Array.isArray(t) ? t.map(text).join("") : t && typeof t === "object" ? text(t.children) : t == null || t === false ? "" : String(t));
    return { tree, stops, sets, text: text(tree), buttons: elements(tree, "button") };
}

test("the Background section: a row per task with its kind, runner and time, Stop on each that can stop, and Stop all behind a confirm", async () => {
    const r = renderSection([task({ startedAt: 4000 }), task({ id: "bash_1", provider: "harness", kind: "shell", label: "npm run dev", startedAt: 9000 }), task({ id: "t9", kind: "other", label: "Unstoppable", stoppable: false })]);
    expect(r.text).toContain("Background· 3 running");
    expect(r.text).toContain("Map auth");
    expect(r.text).toContain("Sub-agent · Claude Code");
    expect(r.text).toContain("Shell · Harness");
    expect(r.text).toContain("6s");
    const stopButtons = r.buttons.filter((b) => String(b.props["aria-label"] ?? "").startsWith("Stop "));
    expect(stopButtons.map((b) => b.props["aria-label"])).toEqual(["Stop sub-agent: Map auth", "Stop shell: npm run dev"]);
    stopButtons[1]!.props.onClick();
    await Bun.sleep(0);
    expect(r.stops).toEqual([{ id: "s1", ids: ["bash_1"] }]);
    // Stop all asks first; confirming stops every one.
    const all = r.buttons.find((b) => text(b.children) === "Stop all")!;
    all.props.onClick();
    expect(r.sets).toContain(true);
    const confirm = elements(r.tree, "ConfirmDialog")[0]!;
    expect(confirm.props.title).toBe("Stop all background work?");
    expect(text(confirm.children)).toContain("2 tasks will stop");
    await confirm.props.onConfirm();
    expect(r.stops.at(-1)).toEqual({ id: "s1", ids: undefined });
});

test("with one task there's no Stop all, and one lost when Harness quit says so and has no Stop", () => {
    const one = renderSection([task()]);
    expect(one.buttons.some((b) => text(b.children) === "Stop all")).toBe(false);
    const lost = renderSection([task({ status: "stopped", lost: true })]);
    expect(lost.text).toContain("Stopped when Harness quit");
    expect(lost.buttons.filter((b) => String(b.props["aria-label"] ?? "").startsWith("Stop "))).toEqual([]);
    expect(renderSection([]).text).toBe("");
});
