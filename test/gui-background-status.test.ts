import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { agentRows, backgroundOf, clearKey, combineEnded, commandRows, endedAllCleared, finishedOf, kindName, noticeRoute, rowLive, rowMeta, rowProvider, rowTone, runnerName, runningCount, stopAllOf, stopOutcome, stopTarget, stopTasks, taskMeta, workSection, type WorkTab } from "../gui/src/lib/background";
import { tagId } from "../gui/src/lib/platform";
import type { AgentRun, BackgroundTaskInfo } from "../src/server/protocol";
import { componentCode, elements } from "./gui-component-harness";
import { liveLine } from "../gui/src/lib/live-line";
import { plural } from "../gui/src/lib/format";
import { agentStep } from "../gui/src/lib/agent-marks";

const text = (tree: any): string => Array.isArray(tree) ? tree.map(text).join("") : tree == null ? "" : String(tree);

// What the running turn's live line says (gui/src/lib/live-line.ts) while Claude Code waits on its background work.
const said = (activity?: { label: string; since: number }, interactions: any[] = []) => liveLine({ blocks: [], activity, interactions, showThinking: true });

for (const kind of ["command", "monitor", "sub-agent"]) test(`GUI shows the actual background ${kind} wait, not the generic working label`, () => {
    const label = `Waiting for background ${kind}: Run checks · Esc to stop it`;
    const line = said({ label, since: 0 })!;
    expect([line.kind, line.label, line.detail]).toEqual(["bg", "Waiting for background", "Run checks"]);
    // The whole label on hover; "Esc" isn't repeated on the line (the stop button has it beside it).
    expect(line.title).toBe(label);
    expect(`${line.label} ${line.detail}`).not.toContain("Esc");
});

test("several background waits name each; the goal's wait has no names", () => {
    expect(said({ label: "Waiting for background command: bun test; background sub-agent: Map auth · Esc to stop them", since: 0 })?.detail).toBe("bun test, Map auth");
    expect(said({ label: "Waiting for background tasks", since: 0 })).toMatchObject({ kind: "bg", label: "Waiting for background" });
});

test("ordinary work and approval waiting keep their existing labels", () => {
    expect(said({ label: "Thinking", since: 0 })).toMatchObject({ kind: "think", label: "Thinking" });
    expect(said(undefined, [{ kind: "permission", id: "p", title: "Bash" }])).toMatchObject({ kind: "wait", label: "Waiting for approval" });
});

// ---------------------------------------------------------------------------
// The Background panel (gui/src/lib/background.ts): what it lists and says.


const task = (o: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo => ({ id: "t1", provider: "claude-code", kind: "agent", label: "Map auth", startedAt: 0, status: "running", stoppable: true, ...o });

test("the Background panel lists what the server keeps: running tasks, then the finished ones, most recent first", () => {
    const tasks = [task(), task({ id: "t2", status: "done", endedAt: 50 }), task({ id: "t3", status: "stopped", lost: true, endedAt: 10 }), task({ id: "t4", status: "failed", endedAt: 90 })];
    const listed = backgroundOf({ backgroundTasks: tasks, shells: [] });
    expect(listed.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(runningCount(listed)).toBe(1);
    expect(finishedOf(listed).map((t) => t.id)).toEqual(["t4", "t2", "t3"]);
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
    // A finished one: how it ended, and after how long.
    expect(taskMeta(task({ status: "done", startedAt: 1000, endedAt: 4000 }), [], 9000, dur)).toBe("Done · 3s");
    expect(taskMeta(task({ status: "failed", startedAt: 1000, endedAt: 2000 }), [], 9000, dur)).toBe("Failed · 1s");
    expect(taskMeta(task({ status: "stopped", startedAt: 1000, endedAt: 3000 }), [], 9000, dur)).toBe("Stopped · 2s");
    const shells = [{ id: "monitor_1", command: "x", running: true, exitCode: null, startedAt: 0, monitor: { description: "d", events: 0, expiresAt: 125_000 } }];
    expect(taskMeta(task({ id: "monitor_1", kind: "monitor" }), shells, 5000, dur)).toBe("2m left");
});

test("a task's end is a toast in its session's view, a desktop notification otherwise (if they're on), once", () => {
    const route = (o: Partial<Parameters<typeof noticeRoute>[0]>) => noticeRoute({ focused: true, active: true, notifications: true, seen: false, ...o });
    expect(route({})).toBe("toast");
    // Another session open, or the window in the background: a notification, as for a turn's notices.
    expect(route({ active: false })).toBe("desktop");
    expect(route({ focused: false })).toBe("desktop");
    expect(route({ focused: false, notifications: false })).toBe("none");
    // The toast doesn't depend on the notifications setting.
    expect(route({ notifications: false })).toBe("toast");
    // Told already (another window, or the event again): nothing.
    expect(route({ seen: true })).toBe("none");
    // Each task's notification has an id of its own, the same each time.
    expect(tagId("background:s1:bash_1:5")).toBe(tagId("background:s1:bash_1:5"));
    expect(tagId("background:s1:bash_1:5")).not.toBe(tagId("background:s1:bash_2:5"));
    expect(Number.isInteger(tagId("x".repeat(500))) && Math.abs(tagId("x".repeat(500))) < 2 ** 31).toBe(true);
    // The app sends these through that route.
    const appSrc = readFileSync(new URL("../gui/src/state/app.ts", import.meta.url), "utf8");
    expect(appSrc).toContain('if (ev.kind === "background") return backgroundEnded(ev);');
    expect(appSrc).toContain("else desktopEnded(ev.sessionId, ev.title, ev.body, tag, reveal);");
});

test("a stop's toast says what stopped and what couldn't be", () => {
    expect(stopOutcome({})).toEqual({ message: "Nothing was running", level: "info" });
    expect(stopOutcome({ a: "stopped" })).toEqual({ message: "Stopped 1 task", level: "success" });
    expect(stopOutcome({ a: "stopped", b: "stopped", c: "not_stoppable", d: "timeout" })).toEqual({ message: "Stopped 2 tasks; 1 didn't confirm yet; 1 couldn't be stopped on its own", level: "warn" });
    // Ended on its own before the stop could (the list was a moment old): said so, not as a refusal.
    expect(stopOutcome({ a: "ended" })).toEqual({ message: "1 had already ended", level: "info" });
    expect(stopOutcome({ a: "stopped", b: "ended" })).toEqual({ message: "Stopped 1 task; 1 had already ended", level: "success" });
});

test("the side panel lists background work in its Agents and Commands tabs, and the composer has its count", () => {
    const panel = readFileSync(new URL("../gui/src/components/RightPanel.tsx", import.meta.url), "utf8");
    expect(panel).toContain('<WorkList handle={p.handle} tab="agents" rows={p.rows} />');
    expect(panel).toContain('<WorkList handle={p.handle} tab="commands" rows={p.rows} />');
    expect(panel).not.toContain("function Lineage(");
    const composer = readFileSync(new URL("../gui/src/components/Composer.tsx", import.meta.url), "utf8");
    expect(composer).toContain("<BackgroundChip sessionId={p.sessionId} />");
    const list = readFileSync(new URL("../gui/src/components/BackgroundTasks.tsx", import.meta.url), "utf8");
    // Stop all asks first; each row stops its own tasks, or its delegated run, as before.
    expect(list).toContain("title={`Stop all background ${what()}s?`}");
    expect(list).toContain("await stopBackground(p.handle.id, t.tasks)");
    expect(list).toContain("await stopAgent(p.handle.id, t.agent)");
});

// A tab's list itself, rendered by the harness (no browser): its rows, Stop on each, and Stop all behind a confirm.

function renderList(tasks: BackgroundTaskInfo[], agents: AgentRun[] = [], tab: WorkTab = "agents") {
    const stops: { id: string; ids?: string[] }[] = [];
    const agentStops: { id: string; agent?: string }[] = [];
    const cleared: string[] = [];
    const sets: unknown[] = [];
    const opened: string[] = [];
    const node = (tag: any, props: Record<string, any> | null, ...children: any[]): any => (typeof tag === "function" ? tag({ ...(props ?? {}), children: children.length === 1 ? children[0] : children }) : { tag, props: props ?? {}, children });
    const state = { backgroundTasks: tasks, shells: [] as never[], model: { provider: "claude-code" } };
    const List = componentCode("WorkList", {
        createSignal: (initial: unknown) => [() => initial, (v: unknown) => void sets.push(v)],
        createMemo: (f: () => unknown) => f,
        For: (p: { each: unknown[]; children: (x: unknown) => unknown }) => p.each.map((x) => p.children(x)),
        Show: (p: { when: unknown; children: unknown; fallback?: unknown }) => (p.when ? (typeof p.children === "function" ? p.children(() => p.when) : p.children) : p.fallback),
        ConfirmDialog: (p: Record<string, any>) => ({ tag: "ConfirmDialog", props: p, children: [p.children] }),
        Bot: "Bot", ChevronRight: "ChevronRight", Layers: "Layers", Radar: "Radar", Terminal: "Terminal", Workflow: "Workflow",
        AgentMark: (p: { provider?: string }) => ({ tag: "AgentMark", props: p, children: [] }),
        agentStep,
        app: { providers: [{ id: "claude-code", name: "Claude Code" }] },
        handleFor: () => undefined,
        openAgents: (id: string) => void opened.push(id),
        openBackground() {},
        stopBackground: async (id: string, ids?: string[]) => void stops.push({ id, ids }),
        stopAgent: async (id: string, agent?: string) => void agentStops.push({ id, agent }),
        clearBackground: async (id: string) => void cleared.push(id),
        agentRows, backgroundOf, clearKey, commandRows, endedAllCleared, kindName, rowLive, rowMeta, rowProvider, rowTone, runnerName, runningCount, stopAllOf, stopTarget, workSection,
        shortModelRef: (ref?: string) => ref?.slice(ref.indexOf(":") + 1),
        duration: (ms: number) => `${Math.round(ms / 1000)}s`,
        plural,
        now: () => 10_000,
        React: { Fragment: "Fragment" },
        node,
    }, undefined, "BackgroundTasks");
    const handle = { id: "s1", view: { state, agents } };
    const rows = tab === "agents" ? agentRows(tasks, agents) : commandRows(tasks);
    const tree = List({ handle, tab, rows });
    const text = (t: any): string => (Array.isArray(t) ? t.map(text).join("") : t && typeof t === "object" ? text(t.children) : t == null || t === false ? "" : String(t));
    return { tree, stops, agentStops, cleared, sets, opened, text: text(tree), buttons: elements(tree, "button") };
}

const stopsOf = (r: ReturnType<typeof renderList>) => r.buttons.filter((b) => String(b.props["aria-label"] ?? "").startsWith("Stop "));

test("the Agents tab: a row per agent with its runner and time, Stop on each that can stop, and Stop all behind a confirm", async () => {
    const r = renderList([task({ startedAt: 4000, toolUseId: "toolu_1" }), task({ id: "t9", kind: "other", label: "Unstoppable", stoppable: false })], [{ id: "toolu_1", turnId: "x", description: "Map auth", agentType: "general-purpose", status: "running", startedAt: 4000, toolCount: 0, tokens: 0, blocks: [], activity: "Reading src/auth.ts" }, { id: "call_d", turnId: "x", taskId: "task-1", description: "Review", agentType: "general-purpose", model: "gemini:gemini-3-pro", status: "running", startedAt: 9000, toolCount: 0, tokens: 0, blocks: [] }]);
    expect(r.text).toContain("Running3");
    // The sub-agent and its background task: one row, with what it's doing now.
    expect(r.text.match(/Map auth/g)).toHaveLength(1);
    expect(r.text).toContain("Reading src/auth.ts");
    expect(r.text).toContain("Task · Claude Code");
    expect(r.text).toContain("6s");
    expect(stopsOf(r).map((b) => b.props["aria-label"])).toEqual(["Stop sub-agent: Map auth", "Stop sub-agent: Review"]);
    stopsOf(r)[0]!.props.onClick();
    stopsOf(r)[1]!.props.onClick();
    await Bun.sleep(0);
    expect(r.stops).toEqual([{ id: "s1", ids: ["t1"] }]);
    expect(r.agentStops).toEqual([{ id: "s1", agent: "call_d" }]);
    // Stop all asks first; confirming stops the tab's, by id.
    const all = r.buttons.find((b) => text(b.children) === "Stop all")!;
    all.props.onClick();
    expect(r.sets).toContain(true);
    const confirm = elements(r.tree, "ConfirmDialog")[0]!;
    expect(confirm.props.title).toBe("Stop all background agents?");
    expect(text(confirm.children)).toContain("2 agents will stop");
    await confirm.props.onConfirm();
    expect(r.stops.at(-1)).toEqual({ id: "s1", ids: ["t1"] });
    expect(r.agentStops.at(-1)).toEqual({ id: "s1", agent: "call_d" });
});

test("a sub-agent resumed with SendMessage is its run's row, which opens it; a task with no run to open doesn't look like it opens (#458)", () => {
    const row = (r: ReturnType<typeof renderList>) => elements(r.tree, "div").filter((d) => String(d.props.class).startsWith("task "));
    const hits = (r: ReturnType<typeof renderList>) => r.buttons.filter((b) => b.props.class === "task-hit");
    // As the server has it once Claude Code resumes the agent: the task it ran with, running again, named by its Agent call.
    const run: AgentRun = { id: "toolu_agent", turnId: "x", description: "Map auth", agentType: "general-purpose", status: "running", startedAt: 1000, toolCount: 2, tokens: 0, blocks: [], turnAfter: "b3" };
    const resumed = renderList([task({ id: "agent-1", toolUseId: "toolu_agent", startedAt: 8000 })], [run]);
    expect(resumed.text).toContain("Running1");
    expect(row(resumed).map((d) => String(d.props.class).split(" ").includes("click"))).toEqual([true]);
    expect(hits(resumed).map((b) => b.props["aria-label"])).toEqual(["Open Map auth"]);
    hits(resumed)[0]!.props.onClick();
    expect(resumed.opened).toEqual(["toolu_agent"]);
    // A task no run is known for (as a resume showed before #458): it can stop, but nothing opens, and it isn't styled as if it did.
    const loose = renderList([task({ id: "agent-1", toolUseId: "toolu_send" })], [{ ...run, status: "done", endedAt: 2000 }]);
    const looseRow = row(loose).find((d) => !String(d.props.class).split(" ").includes("gone"))!;
    expect(String(looseRow.props.class).split(" ")).not.toContain("click");
    expect(hits(loose).filter((b) => b.props["aria-label"] === "Open Map auth")).toHaveLength(1);
    expect(stopsOf(loose).map((b) => b.props["aria-label"])).toEqual(["Stop sub-agent: Map auth"]);
    const css = readFileSync(new URL("../gui/src/styles/panel.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const hovered = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, sel, body]) => /background:/.test(body!) && /:hover/.test(sel!)).flatMap(([, sel]) => sel!.split(",").map((x) => x.trim()));
    expect(hovered.filter((s) => s.startsWith(".task.") && s.endsWith(":hover"))).toEqual([".task.click:hover"]);
});

test("no row has a tooltip that says what it shows", () => {
    const r = renderList([task({ id: "bash_1", provider: "harness", kind: "shell", label: "npm run dev" })], [], "commands");
    expect(r.text).toContain("Shell · Harness");
    const titled = (t: any): string[] => (Array.isArray(t) ? t.flatMap(titled) : t && typeof t === "object" ? [...(t.props?.title ? [String(t.props.title)] : []), ...titled(t.children)] : []);
    expect(titled(elements(r.tree, "div").filter((d) => String(d.props.class).startsWith("task ")))).toEqual(["Stop"]);
});

test("with one task there's no Stop all, and one lost when Harness quit says so and has no Stop", () => {
    const one = renderList([task()]);
    expect(one.buttons.some((b) => text(b.children) === "Stop all")).toBe(false);
    const lost = renderList([task({ status: "stopped", lost: true })]);
    expect(lost.text).toContain("Stopped when Harness quit");
    expect(stopsOf(lost)).toEqual([]);
    expect(renderList([]).text).toBe("");
});

test("finished ones stay under the running ones, in a fold closed while something runs, with how they ended, and can be cleared", async () => {
    const finished = [task({ id: "d1", label: "Write docs", status: "done", startedAt: 1000, endedAt: 4000 }), task({ id: "f1", label: "Lint", kind: "shell", provider: "harness", status: "failed", startedAt: 1000, endedAt: 2000 })];
    const folded = renderList([task({ id: "sh", kind: "shell", provider: "harness" }), ...finished], [], "commands");
    expect(folded.text).toContain("Finished1");
    expect(folded.text).toContain("1 failed");
    // In the DOM, folded: the fold opens in place rather than being drawn when opened.
    const fold = (r: ReturnType<typeof renderList>) => elements(r.tree, "div").find((d) => String(d.props.class).startsWith("fold-b"))!;
    expect(fold(folded).props.class).toBe("fold-b ");
    expect(fold(folded).props.inert).toBe(true);
    expect(folded.text).toContain("Lint");
    const divi = folded.buttons.find((b) => b.props.class === "divi")!;
    expect(divi.props["aria-expanded"]).toBe(false);
    divi.props.onClick();
    expect(folded.sets).toContain(true);
    // With nothing running it's open, each with its outcome and no Stop; Clear clears them.
    const open = renderList(finished, [], "agents");
    expect(fold(open).props.class).toBe("fold-b open");
    expect(open.text).toContain("Write docs");
    expect(open.text).toContain("Done · 3s");
    expect(stopsOf(open)).toEqual([]);
    open.buttons.find((b) => text(b.children) === "Clear finished")!.props.onClick();
    await Bun.sleep(0);
    // Agents' fold cleared, Commands' still shows its failure: the server's list stays.
    expect(open.cleared).toEqual([]);
    const both = renderList([finished[0]!], [], "agents");
    both.buttons.find((b) => text(b.children) === "Clear finished")!.props.onClick();
    await Bun.sleep(0);
    expect(both.cleared).toEqual(["s1"]);
});

test("Stop and Stop all against a server without backgroundTasks stop its shells with session.killShell (#282 review 8)", async () => {
    const calls: [string, any][] = [];
    const call = (async (method: string, params: any) => {
        calls.push([method, params]);
        if (method === "session.stopBackground") return { results: Object.fromEntries((params.ids ?? ["all"]).map((id: string) => [id, "stopped"])) };
        if (params.shellId === "bash_9") throw new Error("No background shell bash_9");
        return null;
    }) as never;
    const shells = [
        { id: "bash_1", command: "npm run dev", running: true, exitCode: null, startedAt: 5 },
        { id: "bash_2", command: "ls", running: false, exitCode: 0, startedAt: 6 },
        { id: "monitor_1", command: "tail -f log", running: true, exitCode: null, startedAt: 7, monitor: { description: "Watch the log", events: 2, expiresAt: 100_000 } },
    ];
    const old = { shells };
    expect(await stopTasks(call, "s1", old, ["bash_1"])).toEqual({ bash_1: "stopped" });
    expect(await stopTasks(call, "s1", old)).toEqual({ bash_1: "stopped", monitor_1: "stopped" });
    expect(await stopTasks(call, "s1", old, ["bash_9"])).toEqual({ bash_9: "failed" });
    expect(calls.map(([m, p]) => [m, p.shellId])).toEqual([
        ["session.killShell", "bash_1"],
        ["session.killShell", "bash_1"],
        ["session.killShell", "monitor_1"],
        ["session.killShell", "bash_9"],
    ]);
    // A current server: session.stopBackground, by id or for all.
    calls.length = 0;
    expect(await stopTasks(call, "s1", { shells, backgroundTasks: [task()] }, ["t1"])).toEqual({ t1: "stopped" });
    await stopTasks(call, "s1", { shells, backgroundTasks: [task()] });
    expect(calls).toEqual([
        ["session.stopBackground", { id: "s1", ids: ["t1"] }],
        ["session.stopBackground", { id: "s1", ids: undefined }],
    ]);
    // The panel's Stop goes through it.
    const actions = readFileSync(new URL("../gui/src/state/actions.ts", import.meta.url), "utf8");
    expect(actions).toContain("await stopTasks(rpc.call.bind(rpc) as never, sessionId, handleFor(sessionId)?.view.state, ids)");
});

test("task endings close together go as one desktop notification, since the desktop app's can't replace one another on macOS", () => {
    expect(combineEnded(["Background command finished: npm test (3s)"])).toBe("Background command finished: npm test (3s)");
    expect(combineEnded(["A", "B"])).toBe("2 background tasks ended:\nA\nB");
    expect(combineEnded(["A", "B", "C", "D", "E"])).toBe("5 background tasks ended:\nA\nB\nC\nand 2 more");
    const appSrc = readFileSync(new URL("../gui/src/state/app.ts", import.meta.url), "utf8");
    expect(appSrc).toContain("void notify(batch.title, combineEnded(batch.bodies), reveal, { tag: batch.tags.length === 1 ? batch.tags[0] : `background:${sessionId}` });");
});
