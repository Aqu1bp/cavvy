// Home (gui/src/components/Home.tsx, CliSessions.tsx, ComposerMeter.tsx), rendered by Cavvy (no browser):
// the composer's strip and its prefixes, the cards before the first message, the sessions from this project's
// terminal to carry on here, and the limit pill Home shows in place of the context ring.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CliSessionInfo, CliSourceInfo, PlanLimits } from "../src/server/protocol";
import { componentCode, elements, type Element } from "./gui-component-harness";
import { ago } from "../gui/src/lib/format";
import { limitAlternatives, meterOf, windowLine } from "../gui/src/lib/limits";

const node = (tag: any, props: Record<string, any> | null, ...children: any[]): any => (typeof tag === "function" ? tag({ ...(props ?? {}), children: children.length === 1 ? children[0] : children }) : { tag, props: props ?? {}, children });
// Keyed, its child gets the value; otherwise an accessor, as Solid's does.
const Show = (p: { when: unknown; keyed?: boolean; children: unknown; fallback?: unknown }) => (p.when ? (typeof p.children === "function" ? p.children(p.keyed ? p.when : () => p.when) : p.children) : p.fallback);
const For = (p: { each?: unknown[]; children: (x: unknown, i: () => number) => unknown; fallback?: unknown }) => (p.each?.length ? p.each.map((x, i) => p.children(x, () => i)) : p.fallback);
const tagged = (tag: string) => (p: Record<string, any>) => ({ tag, props: p, children: p.children === undefined ? [] : [p.children] });
const createSignal = (initial: unknown) => {
    let v = initial;
    return [() => v, (n: unknown) => void (v = typeof n === "function" ? (n as (x: unknown) => unknown)(v) : n)];
};
const text = (t: any): string => (Array.isArray(t) ? t.map(text).join("") : t && typeof t === "object" ? text(t.children) : t == null || t === false || t === true ? "" : String(t));
const byClass = (tree: unknown, tag: string, cls: string) => elements(tree, tag).filter((e) => String(e.props.class ?? "").split(" ").includes(cls));
const stub = () => undefined;

// ---- The terminal sessions ------------------------------------------------------------------------

const MIN = 60_000;
const session = (id: string, o: Partial<CliSessionInfo> = {}): CliSessionInfo => ({ source: "claude-code", id, title: `Session ${id}`, updatedAt: Date.now() - 10 * MIN, messages: 4, partial: false, recent: false, ...o });
const source = (o: Partial<CliSourceInfo> = {}): CliSourceInfo => ({ source: "claude-code", name: "Claude Code", enabled: true, more: 0, moreInCavvy: 0, ...o });

function cli(sessions: CliSessionInfo[], sources: CliSourceInfo[] = [source()], rows?: number, providers: { id: string; configured: boolean }[] = []) {
    const continued: string[] = [];
    const tabs: string[] = [];
    const shown: number[] = [];
    let refetched = 0;
    const CliSessions = componentCode("CliSessions", {
        node, Show, For, createSignal, React: { Fragment: "Fragment" },
        createEffect: (f: () => void) => f(),
        createResource: () => [() => ({ sessions, sources }), { refetch: () => void refetched++ }],
        ArrowRight: "ArrowRight",
        Dialog: tagged("Dialog"),
        ProviderIcon: tagged("ProviderIcon"),
        app: { conn: "open", providers },
        rpc: {},
        continueCliSession: async (_cwd: string, s: CliSessionInfo) => (continued.push(s.id), true),
        setSettingsTab: (t: string) => void tabs.push(t),
        ago,
        basename: (p: string) => p.split("/").pop(),
        now: () => Date.now(),
    });
    const tree = CliSessions({ cwd: "/work/cavvy", rows, onShown: (n: number) => void shown.push(n) });
    const rowsOf = () => byClass(tree, "div", "cli-row");
    return { tree, continued, tabs, shown, refetched: () => refetched, rows: rowsOf, text: text(tree) };
}

test("Home lists the three newest sessions not yet in Cavvy, each with its mark, messages and model", () => {
    const r = cli([
        session("old", { updatedAt: Date.now() - 3 * 1440 * MIN }),
        session("new", { updatedAt: Date.now() - 6 * MIN, messages: 5, partial: true, model: "Opus 5.5", recent: true }),
        session("mid", { source: "codex", updatedAt: Date.now() - 2 * 60 * MIN, messages: 1, model: "GPT-6" }),
        session("older", { updatedAt: Date.now() - 4 * 1440 * MIN }),
        session("here", { updatedAt: Date.now(), cavvyId: "s1" }),
    ], [source(), source({ source: "codex", name: "Codex" })]);
    // Newest first; the one already in Cavvy isn't offered here.
    expect(r.rows().map((row) => row.props["aria-label"])).toEqual(["Import “Session new” from Claude Code", "Import “Session mid” from Codex", "Import “Session old” from Claude Code"]);
    expect(r.shown).toEqual([3]);
    expect(elements(elements(r.tree, "section"), "ProviderIcon").map((i) => i.props.id)).toEqual(["claude-code", "codex", "claude-code"]);
    const [first, second] = r.rows();
    expect(text(byClass(first, "span", "cli-meta"))).toBe("Claude Code · 5+ messages · Opus 5.5 · Still open in a terminal");
    // Still open: the warning keeps saying why, in its tooltip.
    expect(byClass(first, "span", "cli-live")[0]!.props.title).toBe("This session may still be open in a terminal; using it in both places at once mixes the two.");
    expect(text(byClass(second, "span", "cli-meta"))).toBe("Codex · 1 message · GPT-6");
    expect(text(byClass(first, "span", "cli-ago"))).toBe("6m ago");
    expect(text(byClass(first, "span", "cli-go"))).toBe("Import");
    expect(text(byClass(r.tree, "div", "cli-h"))).toBe("Continue from your terminalShow all 4");
});

test("a row is a button: a click, Enter or Space imports it; one whose CLI is off goes to Settings → Providers", async () => {
    const r = cli([session("a"), session("b", { source: "codex", updatedAt: Date.now() - 20 * MIN })], [source(), source({ source: "codex", name: "Codex", enabled: false })]);
    const [a, b] = r.rows();
    expect(a!.props.role).toBe("button");
    expect(a!.props.tabIndex).toBe(0);
    let prevented = 0;
    a!.props.onKeyDown({ key: "Enter", preventDefault: () => prevented++ });
    await Bun.sleep(0);
    a!.props.onKeyDown({ key: " ", preventDefault: () => prevented++ });
    a!.props.onKeyDown({ key: "x", preventDefault: () => prevented++ });
    await Bun.sleep(0);
    expect(r.continued).toEqual(["a", "a"]);
    expect(prevented).toBe(2);
    expect(text(b)).toContain("Turn on Codex in Settings → Providers");
    expect(byClass(b, "span", "cli-go")).toHaveLength(0);
    expect(b!.props["aria-label"]).toBe("Turn on Codex in Settings → Providers to import “Session b”");
    b!.props.onClick();
    expect(r.tabs).toEqual(["providers"]);
    expect(r.continued).toEqual(["a", "a"]);
});

test("a CLI turned on in Settings while Home is up imports at once: the providers say so, not the list from before", async () => {
    const off = [source({ source: "codex", name: "Codex", enabled: false })];
    const r = cli([session("b", { source: "codex" })], off, undefined, [{ id: "codex", configured: true }]);
    const [b] = r.rows();
    expect(b!.props["aria-label"]).toBe("Import “Session b” from Codex");
    b!.props.onClick();
    await Bun.sleep(0);
    expect(r.continued).toEqual(["b"]);
    expect(r.tabs).toEqual([]);
    // Turned off there since the list came: Settings again.
    const gone = cli([session("a")], [source()], undefined, [{ id: "claude-code", configured: false }]);
    gone.rows()[0]!.props.onClick();
    expect(gone.tabs).toEqual(["providers"]);
});

test("with nothing to import the section is gone, even with sessions already in Cavvy", () => {
    const r = cli([session("here", { cavvyId: "s1" })]);
    expect(elements(r.tree, "section")).toHaveLength(0);
    // The dialog stays mounted (closed), so an open one survives the list reloading.
    expect(elements(r.tree, "Dialog").map((d) => d.props.open)).toEqual([false]);
    expect(r.shown).toEqual([0]);
    expect(elements(cli([]).tree, "section")).toHaveLength(0);
});

test("with no room for a row, what's to import is still reachable: the heading and Show all", () => {
    const r = cli([session("a"), session("b")], [source()], 0);
    expect(elements(r.tree, "section")).toHaveLength(1);
    expect(r.rows()).toHaveLength(0);
    expect(r.text).toContain("Show all 2");
});

test("a short column shows fewer rows; Show all is there only when it lists more", () => {
    const short = cli([session("a"), session("b"), session("c")], [source()], 1);
    expect(short.rows()).toHaveLength(1);
    expect(short.shown).toEqual([1]);
    expect(short.text).toContain("Show all 3");
    expect(cli([session("a")], [source()], 0).rows()).toHaveLength(0);
    // Everything shows, and nothing is in Cavvy or left out: no Show all.
    expect(cli([session("a"), session("b")]).text).not.toContain("Show all");
    expect(cli([session("a")], [source({ more: 2 })]).text).toContain("Show all 1");
    expect(cli([session("a"), session("h", { cavvyId: "s1" })]).text).toContain("Show all 1");
});

test("Show all lists every one to import, then those already in Cavvy (Open), and what isn't listed", async () => {
    const r = cli(
        [session("a", { updatedAt: Date.now() - 30 * MIN }), session("b", { updatedAt: Date.now() - 2 * MIN }), session("h", { cavvyId: "s9", title: "Already here" })],
        [source({ more: 1, moreInCavvy: 2 }), source({ source: "codex", name: "Codex", more: 3 })],
    );
    const all = elements(r.tree, "button").find((b) => text(b) === "Show all 2")!;
    all.props.onClick();
    expect(r.refetched()).toBe(1);
    const dialog = elements(r.tree, "Dialog")[0]!;
    expect(dialog.props.title).toBe("Continue from your terminal");
    const body = text(dialog.children);
    expect(body).toStartWith("Claude Code and Codex sessions started in cavvy. Importing one opens it here on the same session.");
    const items = byClass(dialog, "button", "cl-item");
    expect(items.map((i) => text(byClass(i, "span", "cl-act")))).toEqual(["Import", "Import", "Open"]);
    expect(text(items[0]!)).toContain("Session b");
    expect(text(byClass(dialog, "div", "cl-sub"))).toBe("Already in Cavvy");
    expect(byClass(dialog, "div", "cl-note").map(text)).toEqual(["2 more already in Cavvy not shown", "1 more Claude Code session not shown", "3 more Codex sessions not shown"]);
    items[2]!.props.onClick();
    await Bun.sleep(0);
    expect(r.continued).toEqual(["h"]);
});

// ---- The strip, the placeholder and the cards ------------------------------------------------------

test("a prefix goes in where the caret is, as typing would: an @ after a word gets a space first", () => {
    const events: string[] = [];
    const inserted: string[] = [];
    let exec = false;
    const doc = { execCommand: (_c: string, _u: boolean, t: string) => (exec && inserted.push(t), exec) };
    const typeIn = componentCode("typeInComposer", { document: doc }, undefined, "Home") as (root: unknown, text: string) => void;
    const ta = { value: "fix the test", selectionStart: 3, selectionEnd: 3, focused: false, focus() { this.focused = true; }, setSelectionRange(a: number, b: number) { this.selectionStart = a; this.selectionEnd = b; }, dispatchEvent: (e: Event) => void events.push(e.type) };
    const root = { querySelector: (q: string) => (q === "textarea" ? ta : null) };
    typeIn(root, "@");
    expect(ta.value).toBe("fix @ the test");
    expect(ta.selectionStart).toBe(5);
    expect(ta.focused).toBe(true);
    expect(events).toEqual(["input"]);
    ta.value = "";
    ta.selectionStart = ta.selectionEnd = 0;
    typeIn(root, "/");
    expect(ta.value).toBe("/");
    // Where the browser can, it types it (the field's undo has it).
    exec = true;
    ta.value = "see";
    ta.selectionStart = ta.selectionEnd = 3;
    typeIn(root, "@");
    typeIn(root, "!");
    expect(inserted).toEqual([" @", "!"]);
    expect(events).toEqual(["input", "input"]);
});

function home(o: { cwd?: string; needsTrust?: string[]; models?: unknown[]; providers?: unknown[]; height?: number; width?: number } = {}) {
    const trusts: unknown[] = [];
    const connected: string[] = [];
    const tabs: string[] = [];
    const cliProps: Record<string, any>[] = [];
    const Home = componentCode("Home", {
        node, Show, For, createSignal, onCleanup: stub, onMount: stub, React: { Fragment: "Fragment" },
        createResource: () => [() => ({ needsTrust: o.needsTrust ?? [], git: true, branch: "main" }), { refetch: stub }],
        ChevronDown: "ChevronDown", Folder: "Folder", FolderGit2: "FolderGit2", FolderOpen: "FolderOpen", KeyRound: "KeyRound", Plug: "Plug", ShieldAlert: "ShieldAlert",
        app: { conn: "open", homeCwd: o.cwd === undefined ? "/work/cavvy" : o.cwd || undefined, providers: o.providers ?? [], projects: [], models: o.models ?? [{ models: [{}] }], modelsLoaded: true, modelsLoading: false },
        refreshProjects: stub, reportError: stub, rpc: {}, chooseProject: stub,
        connectCli: async (pr: { id: string }) => (connected.push(pr.id), true),
        openProject: stub,
        trustAndContinue: async (...args: unknown[]) => void trusts.push(args),
        requestComposerFocus: stub, setSettingsTab: (t: string) => void tabs.push(t),
        columnHeight: () => "800px", shellLayout: () => ({ column: { w: o.width ?? 900, h: o.height ?? 800 } }), sp: (n: number) => n,
        ago: stub, basename: (p: string) => p.split("/").pop(), tildify: (p: string) => p, now: stub, isWindowShown: () => true,
        document: { execCommand: () => false },
        CliSessions: (p: Record<string, any>) => (cliProps.push(p), { tag: "CliSessions", props: p, children: [] }),
        Composer: tagged("Composer"), ErrorCards: tagged("ErrorCards"), Menu: tagged("Menu"), ProviderIcon: tagged("ProviderIcon"), WorktreePicker: tagged("WorktreePicker"),
    }) as () => Element;
    const tree = Home();
    const composer = elements(tree, "Composer")[0]!;
    return { tree, composer, strip: composer.props.strip, trusts, connected, tabs, cliProps };
}

test("Home is the question, then the composer with the project, its worktree and the three prefixes in the strip under it", () => {
    const h = home();
    expect(text(elements(h.tree, "h1"))).toBe("What should we work on?");
    expect(elements(h.tree, "Logo")).toHaveLength(0);
    expect(h.composer.props.placeholder).toBe("Describe a task or ask a question");
    expect(h.composer.props.variant).toBe("home");
    const chip = byClass(h.strip, "button", "strip-ctl")[0]!;
    expect(text(chip)).toBe("cavvy");
    expect(elements(h.strip, "WorktreePicker")[0]!.props).toMatchObject({ cwd: "/work/cavvy", branch: "main" });
    const hints = elements(byClass(h.strip, "span", "strip-hints"), "button");
    expect(hints.map((b) => [text(elements(b, "kbd")), text(b)])).toEqual([["/", "/commands"], ["@", "@files"], ["!", "!shell"]]);
    // Pressing one leaves the caret in the composer.
    let prevented = false;
    hints[0]!.props.onMouseDown({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    // No cards when there's nothing to ask.
    expect(byClass(h.tree, "div", "hcard")).toHaveLength(0);
    expect(h.cliProps[0]).toMatchObject({ cwd: "/work/cavvy", rows: 3 });
});

test("/ and ! type only into an empty composer, as it is when clicked, whatever filled or cleared it; @ goes anywhere", () => {
    const h = home();
    const ta = { value: "", selectionStart: 0, selectionEnd: 0, focused: 0, focus() { this.focused++; }, setSelectionRange(a: number, b: number) { this.selectionStart = a; this.selectionEnd = b; }, dispatchEvent: stub };
    byClass(h.tree, "div", "home-composer")[0]!.props.ref({ querySelector: (q: string) => (q === "textarea" ? ta : null) });
    const [slash, at, bang] = elements(byClass(h.strip, "span", "strip-hints"), "button");
    // History recalled into the box, with no input event: / and ! only focus it.
    ta.value = "earlier message";
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    slash!.props.onClick();
    bang!.props.onClick();
    expect(ta.value).toBe("earlier message");
    expect(ta.focused).toBe(2);
    at!.props.onClick();
    expect(ta.value).toBe("earlier message @");
    // A send cleared it (no input event either): / types again.
    ta.value = "";
    ta.selectionStart = ta.selectionEnd = 0;
    slash!.props.onClick();
    expect(ta.value).toBe("/");
    // The dimmed state follows every change the composer makes to its text.
    expect(typeof h.composer.props.onText).toBe("function");
    const composer = readFileSync(new URL("../gui/src/components/Composer.tsx", import.meta.url), "utf8");
    expect(composer).toContain("createEffect(() => p.onText?.(text()));");
});

test("with no folder Home asks for one, and the strip has no prefixes", () => {
    const h = home({ cwd: "" });
    expect(text(elements(h.tree, "h1"))).toBe("Choose a project to start");
    expect(h.composer.props.placeholder).toBe("Choose a project folder to start");
    expect(text(byClass(h.strip, "button", "strip-ctl")[0]!)).toBe("Choose a project");
    expect(byClass(h.strip, "span", "strip-hints")).toHaveLength(0);
    expect(elements(h.tree, "CliSessions")).toHaveLength(0);
});

test("the trust card lists the folder's files and keeps both answers", async () => {
    const h = home({ needsTrust: [".mcp.json", ".claude/settings.json"] });
    const card = byClass(h.tree, "div", "trust")[0]!;
    expect(card.props.class).toBe("hcard glass trust");
    expect(text(byClass(card, "span", "ask-title"))).toBe("Do you trust this folder?");
    expect(elements(card, "code").map(text)).toEqual([".mcp.json", ".claude/settings.json"]);
    const [skip, trust] = elements(byClass(card, "div", "ask-row"), "button");
    expect([text(skip), text(trust)]).toEqual(["Open without them", "Trust this folder"]);
    expect(trust!.props.class).toBe("pbtn primary");
    await skip!.props.onClick();
    await trust!.props.onClick();
    expect(h.trusts).toEqual([["/work/cavvy", false], ["/work/cavvy", true]]);
    // A card above the composer leaves less room for terminal rows.
    expect(home({ needsTrust: [".mcp.json"], height: 600 }).cliProps[0]!.rows).toBeLessThan(home({ height: 600 }).cliProps[0]!.rows);
});

test("with no model the connect card offers the user's own plan and a key, and the composer says to connect one", async () => {
    const h = home({ models: [{ models: [] }], providers: [{ id: "claude-code", name: "Claude Code", configured: false, agentCli: { installed: true, plan: "Claude subscription" } }] });
    expect(h.composer.props.placeholder).toBe("Connect a model to start");
    const card = byClass(h.tree, "div", "connect")[0]!;
    expect(text(byClass(card, "span", "ask-title"))).toBe("Connect a model to start");
    expect(text(elements(card, "p"))).toStartWith("Use the Claude subscription you already have through Claude Code, or add an API key");
    const [key, plan] = elements(card, "button");
    expect(text(key)).toBe("Add an API key");
    expect(text(plan)).toBe("Use my Claude subscription");
    expect(plan!.props.class).toBe("pbtn primary");
    expect(elements(plan, "ProviderIcon")[0]!.props.id).toBe("claude-code");
    await plan!.props.onClick();
    key!.props.onClick();
    expect(h.connected).toEqual(["claude-code"]);
    expect(h.tabs).toEqual(["providers"]);
    // No CLI to use: the key is the way.
    const keyOnly = home({ models: [] });
    expect(elements(byClass(keyOnly.tree, "div", "connect"), "button").map((b) => [text(b), b.props.class])).toEqual([["Add an API key", "pbtn primary"]]);
});

test("a short column shows fewer terminal rows, down to none, and a card in a narrow one takes more room", () => {
    const rows = (o: Parameters<typeof home>[0]) => home(o).cliProps[0]!.rows;
    // 1024×700 and 720×480 windows, and shorter.
    expect(rows({ height: 640 })).toBe(3);
    expect(rows({ height: 464, width: 700 })).toBe(2);
    expect(rows({ height: 400 })).toBe(1);
    expect(rows({ height: 330 })).toBe(0);
    expect(rows({ height: 700, needsTrust: [".mcp.json"], width: 900 })).toBe(3);
    expect(rows({ height: 700, needsTrust: [".mcp.json"], width: 500 })).toBe(2);
});

test("Home shows the error cards above the trust and connect cards", () => {
    const source = readFileSync(new URL("../gui/src/components/Home.tsx", import.meta.url), "utf8");
    const at = source.indexOf('<ErrorCards place="home" />');
    expect(at).toBeGreaterThan(source.indexOf('<div class="home-composer"'));
    expect(at).toBeLessThan(source.indexOf("<Show when={needsTrust().length}>"));
});

// ---- The worktree picker ----------------------------------------------------------------------------

function picker(cwd: string, listed: { path: string; worktrees: unknown[] } | undefined, loading: boolean) {
    const opened: string[] = [];
    const WorktreePicker = componentCode("WorktreePicker", {
        node, Show, For, createSignal, React: { Fragment: "Fragment" },
        createResource: () => [Object.assign(() => listed, { loading }), { refetch: stub }],
        Check: "Check", ChevronDown: "ChevronDown", FolderGit2: "FolderGit2", GitBranch: "GitBranch", Plus: "Plus", Trash2: "Trash2",
        app: { conn: "open" }, rpc: {},
        openProject: async (path: string) => void opened.push(path),
        requestComposerFocus: stub, tildify: (p: string) => p,
        Popover: tagged("Popover"), NewWorktreeDialog: tagged("NewWorktreeDialog"), RemoveWorktreeDialog: tagged("RemoveWorktreeDialog"),
    }) as (p: { cwd: string; branch?: string }) => Element;
    return { tree: WorktreePicker({ cwd, branch: "main" }), opened };
}

test("the worktree picker never offers another project's worktrees while this one's load", () => {
    const a = { path: "/work/a", worktrees: [{ path: "/work/a", branch: "main", main: true, current: true, exists: true }, { path: "/work/a-wt", branch: "fix", managed: true, exists: true }] };
    // Switched from A to B, B's listing not back yet: loading, nothing of A's to pick or branch from.
    const switched = picker("/work/b", a, true);
    const popover = elements(switched.tree, "Popover")[0]!;
    expect(text(popover)).toContain("Loading worktrees…");
    expect(elements(popover, "button")).toHaveLength(0);
    // This folder's own, kept while it lists them again: still there.
    const same = picker("/work/a", a, true);
    const items = byClass(elements(same.tree, "Popover"), "button", "menu-item");
    expect(items.map(text)).toEqual(["main/work/a · main checkout", "fix/work/a-wt", "New worktree…"]);
});

// ---- The limit pill ---------------------------------------------------------------------------------

const nearLimit = componentCode("nearLimit", {}, undefined, "ComposerMeter") as (m: ReturnType<typeof meterOf>, l?: PlanLimits, at?: number) => { pct: number; window?: string } | undefined;
const limits = (windows: PlanLimits["windows"], o: Partial<PlanLimits> = {}): PlanLimits => ({ at: Date.now(), windows, ...o }) as PlanLimits;

test("Home's limit pill shows from 80%, naming the fullest window (or the reached one)", () => {
    const at = (l: PlanLimits) => nearLimit(meterOf(l, Date.now()));
    expect(nearLimit(undefined)).toBeUndefined();
    expect(at(limits([{ label: "5-hour", usedPercent: 79 }, { label: "Weekly", usedPercent: 40 }]))).toBeUndefined();
    expect(at(limits([{ label: "5-hour", usedPercent: 80 }]))).toEqual({ pct: 80, window: "5-hour" });
    expect(at(limits([{ label: "5-hour", usedPercent: 62 }, { label: "Weekly", usedPercent: 94 }]))).toEqual({ pct: 94, window: "weekly" });
    expect(at(limits([{ label: "GPT-5 5-hour", usedPercent: 91 }]))).toEqual({ pct: 91, window: "GPT-5 5-hour" });
    expect(at(limits([{ label: "5-hour", usedPercent: 97 }, { label: "Weekly Opus", reached: true }]))).toEqual({ pct: 100, window: "weekly Opus" });
    expect(at(limits([], { reached: true }))).toEqual({ pct: 100, window: undefined });
    // A plain rate-limit stop with no window reached is the plan's limit, not whichever window is fullest.
    expect(at(limits([{ label: "5-hour", usedPercent: 40 }], { reached: true }))).toStrictEqual({ pct: 100 });
    expect(at(limits([{ label: "5-hour" }, { label: "Weekly", usedPercent: 95 }], { reached: true }))).toStrictEqual({ pct: 100 });
    // A window that has reset since the report doesn't count, however full it was.
    const lapsed = limits([{ label: "5-hour", usedPercent: 95, resetsAt: Date.now() - 60_000 }, { label: "Weekly", usedPercent: 40 }]);
    expect(nearLimit(meterOf(lapsed, Date.now()), lapsed, Date.now())).toBeUndefined();
});

function meter(home: boolean, used?: number, sessionId?: string) {
    const provider = "claude-code";
    const planLimitKey = (p: string, a = "default") => JSON.stringify([p, a]);
    const ComposerMeter = componentCode("ComposerMeter", {
        node, Show, For, createSignal, React: { Fragment: "Fragment" },
        createEffect: stub, createMemo: (f: () => unknown) => f, createUniqueId: () => "u", on: stub, onCleanup: stub,
        planLimitKey,
        app: { providers: [{ id: provider, name: "Claude Code", agentCli: { plan: "Claude subscription" } }], limits: used === undefined ? {} : { [planLimitKey(provider)]: limits([{ label: "5-hour", usedPercent: used }]) }, settings: {} },
        handleFor: () => (sessionId ? { view: { state: { model: { provider }, cost: 0, tokensIn: 0, tokensOut: 0 } } } : undefined),
        reportError: stub, rpc: {}, toast: stub,
        contextCardOpen: () => false, setContextCardOpen: stub, setSettingsTab: stub,
        now: () => Date.now(), limitAlternatives, meterOf, windowLine,
        contextView: () => ({ pct: 0.3, line: "30k of 100k" }),
        cost: () => "$0", tokens: () => "0",
        Gauge: "Gauge", Ring: "Ring", Popover: tagged("Popover"),
    }) as (p: { provider?: string; sessionId?: string; home?: boolean }) => unknown;
    const tree = ComposerMeter({ provider, sessionId, home });
    return { tree, trigger: elements(tree, "button")[0] };
}

test("on Home the ring gives way to the limit pill, which opens the same card; a session keeps its ring", () => {
    // A new session has no context: below 80% Home shows nothing there.
    expect(meter(true, 60).trigger).toBeUndefined();
    const pill = meter(true, 94);
    expect(pill.trigger!.props.class).toStartWith("ctx-limit");
    expect(elements(pill.trigger, "Ring")).toHaveLength(0);
    expect(elements(pill.trigger, "Gauge")).toHaveLength(1);
    expect(text(pill.trigger)).toBe("94%of 5-hour limit");
    expect(text(byClass(pill.trigger, "span", "lbl"))).toBe("of 5-hour limit");
    expect(pill.trigger!.props["aria-label"]).toBe("Claude subscription · Default usage: 5-hour 94%");
    expect(pill.trigger!.props["aria-haspopup"]).toBe("dialog");
    expect(elements(pill.tree, "Popover")).toHaveLength(1);
    // A session's composer: the ring, at any usage.
    const ring = meter(false, 94, "s1");
    expect(ring.trigger!.props.class).toStartWith("ctx-btn");
    expect(elements(ring.trigger, "Ring")).toHaveLength(1);
    expect(elements(meter(false, 10, "s1").trigger, "Ring")).toHaveLength(1);
});
