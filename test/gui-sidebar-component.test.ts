// Compile the actual Sidebar with Solid client reactivity; fake only rendering,
// clocks, and external services. No HTTP/WebSocket server is needed.
import { expect, mock, test } from "bun:test";
import { readFileSync } from "fs";
import { transformSync } from "../gui/node_modules/@babel/core/lib/index.js";
import solidPreset from "../gui/node_modules/babel-preset-solid/index.js";
import * as solid from "../gui/node_modules/solid-js/dist/solid.js";
import * as order from "../gui/src/lib/session-order";
import * as format from "../gui/src/lib/format";
import { rowMenuKey } from "../gui/src/lib/menu";
import { sessionStatus } from "../gui/src/lib/session-status";
import * as rail from "../gui/src/lib/rail";
import * as railSelect from "../gui/src/lib/rail-select";
import type { SessionSummary } from "../src/server/protocol";

function fixture(count = 60, o: { actionOf?: (e: KeyboardEvent, contexts: readonly string[]) => string | undefined } = {}) {
    const nodes: any[] = [];
    const menus: any[] = [];
    const frames = new Map<number, () => void>();
    const animations: any[] = [];
    let sequence = 0;
    let entryKeyReads = 0;
    let ids: string[] = [];
    const [sessions, setSessions] = solid.createSignal<SessionSummary[]>(Array.from({ length: count }, (_, i) => ({
        id: String(i), cwd: `/p/${i % 3}`, projectName: `project-${i % 3}`, title: `Session ${i}`, createdAt: 1,
        updatedAt: 100 - i, status: "idle", messages: 2, pinned: false, settled: false, archived: false, live: true,
    })));
    const [sessionsLoaded, setSessionsLoaded] = solid.createSignal(true);
    const [sessionsError, setSessionsError] = solid.createSignal(false);
    const refreshSessions = mock(async () => {});
    const reportError = mock((_e: unknown) => {});
    const [conn, setConn] = solid.createSignal("open");
    const [archived, setArchived] = solid.createSignal<SessionSummary[]>([]);
    const [activeId, setActiveId] = solid.createSignal<string>();
    const [groupBy, setGroupBy] = solid.createSignal("date");
    const [settledOpen, setSettledOpen] = solid.createSignal(true);
    const [collapsedProjects, setCollapsedProjects] = solid.createSignal<string[]>([]);
    const [motion, setMotion] = solid.createSignal("instant");
    const [settingsTab, setSettingsTab] = solid.createSignal<string>();
    const [railSelection, setRailSelection] = solid.createSignal<railSelect.RailSelection>(railSelect.NO_SELECTION);
    const bulk = { settle: mock((_ids: readonly string[], _on: boolean) => Promise.resolve([] as string[])), archive: mock((_ids: readonly string[], _on: boolean) => Promise.resolve([] as string[])), askToDelete: mock((_ids: readonly string[]) => {}) };
    let reduced = false;
    const app = { get sessions() { return sessions(); }, get archived() { return archived(); }, get activeId() { return activeId(); }, projects: [], models: [], limits: {}, providers: [], get conn() { return conn(); }, get sessionsLoaded() { return sessionsLoaded(); }, get sessionsError() { return sessionsError(); } };
    const prefs = { get groupBy() { return groupBy(); }, get settledOpen() { return settledOpen(); }, get motion() { return motion(); }, get collapsedProjects() { return collapsedProjects(); } };
    const resolve = (value: any): any => typeof value === "function" ? resolve(value()) : Array.isArray(value) ? value.map(resolve) : value;
    // A menu's children may be a Show's accessor: read through it.
    const descendants = (node: any): any[] => [node, ...[...(node.children ?? []), node.content].map(resolve).flat(Infinity).filter((child) => child && typeof child === "object" && child !== node).flatMap(descendants)];
    const renderer = {
        ...solid, effect: solid.createRenderEffect, memo: solid.createMemo, use: (fn: (el: any) => void, el: any) => fn(el),
        createElement: (tag: string) => {
            const node: any = { tag, props: {}, dataset: {}, children: [] as any[], focus() {}, select() {},
                closest: () => ["input", "textarea"].includes(tag) ? node : null,
                querySelector: () => descendants(node).find((n) => ["card-hit", "slim-hit"].includes(n.props?.class)),
                getBoundingClientRect: () => ({ top: ids.indexOf(node.dataset.sessionRow) * 100 }),
                querySelectorAll: () => ids.map((id) => nodes.findLast((n) => n.dataset.sessionRow === id)).filter(Boolean),
                animate: () => { const a = { paused: false, cancelled: false, pause() { this.paused = true; }, play() { this.paused = false; }, cancel() { this.cancelled = true; } }; animations.push(a); return a; },
            };
            nodes.push(node); return node;
        },
        createTextNode: (text: string) => ({ text }), insertNode(parent: any, child: any) { parent.children.push(child); },
        setProp: (node: any, key: string, value: any) => { node.props[key] = value; if (key === "data-session-row") node.dataset.sessionRow = value; },
        insert: (node: any, value: any) => {
            const slot: any = {};
            node.children.push(slot);
            solid.createRenderEffect(() => { slot.content = node.content = resolve(value); });
        },
    };
    const source = readFileSync(new URL("../gui/src/components/Sidebar.tsx", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
    const compiled = transformSync(source, { filename: "Sidebar.tsx", parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[solidPreset, { generate: "universal", moduleName: "test-renderer" }]], configFile: false, babelrc: false })!.code!;
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(compiled)
        .replace(/import \{ ([\w$]+) as ([\w$]+) \} from "test-renderer";/g, "const $2 = renderer.$1;");
    const icons = Object.fromEntries(["Archive", "ArchiveRestore", "Check", "CheckCheck", "ChevronsDownUp", "ChevronsUpDown", "ChevronUp", "CircleAlert", "Folder", "FolderPlus", "Hand", "Layers", "ListFilter", "MessageSquareText", "MoreHorizontal", "PanelLeft", "Pencil", "Pin", "PinOff", "Plus", "Search", "Settings", "SquarePen", "Trash2", "Undo2", "X", "ProviderIcon", "Logo"].map((name) => [name, () => null]));
    const scope = { renderer, ...solid, ...order, ...format, ...rail, ...railSelect, ...icons, sessionStatus, rowMenuKey, app, prefs,
        railSelection, setRailSelection, actionOf: o.actionOf ?? (() => undefined),
        settleSessions: bulk.settle, archiveSessions: bulk.archive, askToDelete: bulk.askToDelete,
        // Count work against layout keys, rather than timing a machine-dependent render.
        holdSidebar: (...args: Parameters<typeof order.holdSidebar>) => order.holdSidebar(...args).map((entry) => ({
            ...entry, get key() { entryKeyReads++; return entry.key; },
        })),
        setPrefs: (key: string, value: any) => key === "groupBy" ? setGroupBy(value) : key === "collapsedProjects" ? setCollapsedProjects(value) : setSettledOpen(value),
        setSidebarOrder: (value: string[] | undefined) => { ids = value ?? []; }, now: () => 100000,
        handleFor: () => undefined, isUnread: () => true, activate: setActiveId, openWaiting: setActiveId, refreshSessions, reportError,
        Menu: (p: any) => { menus.push(p); return solid.createMemo(() => p.open ? p.children : null); },
        isTauri: false, mod: "⌘", os: "macos", toggleSidebar() {}, setPaletteOpen() {}, setSettingsTab() {}, shortcut: () => "⌘+K", withShortcut: (label: string) => label,
        setDeleteRequest() {}, chooseProject() {}, newSession() {}, openProject() {}, pin() {}, rename() {}, archive() {}, settle() {},
        requestAnimationFrame: (fn: () => void) => { frames.set(++sequence, fn); return sequence; },
        cancelAnimationFrame: (id: number) => frames.delete(id),
        matchMedia: () => ({ matches: reduced }),
        settingsTab: () => settingsTab(), ResizeObserver: class { observe() {} disconnect() {} },
    };
    const render = new Function(...Object.keys(scope), `${js}; return Sidebar;`)(...Object.values(scope));
    let dispose!: () => void;
    solid.createRoot((d: () => void) => { dispose = d; render(); });
    const nav = nodes.find((n) => n.tag === "nav");
    const update = (id: string, patch: Partial<SessionSummary>) => setSessions((list) => list.map((s) => s.id === id ? { ...s, ...patch } : s));
    const flushFrames = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
    const contextMenu = (row: any) => row.props.onContextMenu({ target: row.querySelector(), currentTarget: row, button: 2, clientX: 40, clientY: 60, preventDefault() {} });
    return { railSelection, setRailSelection, bulk, setSettingsTab, collapsedProjects, setCollapsedProjects, setSessionsError, refreshSessions, reportError, setSessionsLoaded, setConn, nodes, menus, descendants, contextMenu, nav, update, setGroupBy, setSettledOpen, setActiveId, setSessions, sessions, archived, setArchived, setMotion, animations,
        resetEntryKeyReads: () => { entryKeyReads = 0; }, get entryKeyReads() { return entryKeyReads; },
        setReduced: (value: boolean) => { reduced = value; }, flushFrames, dispose, get ids() { return [...ids]; } };
}

test("actual sidebar holds hover/menu/rename; open and waiting rows appear past the page", () => {
    const f = fixture();
    try {
        expect(f.ids).toHaveLength(25);
        const initial = f.ids;
        f.nav.props.onPointerEnter();
        f.update("40", { status: "waiting", waitingKind: "permission" });
        f.setActiveId("59");
        expect(f.ids.slice(0, 25)).toEqual(initial);
        expect(f.ids.slice(-2)).toEqual(["40", "59"]);
        f.nav.props.onPointerLeave();
        expect(f.ids[0]).toBe("40");
        // Finished since last looked: a check glyph and the unread dot, not a word.
        expect(f.nodes.some((n) => n.props.class === "st done")).toBe(true);
        expect(f.nodes.some((n) => n.props.class === "unread-dot")).toBe(true);
        const card = f.nodes.findLast((n) => String(n.props.class).startsWith("card "));
        f.contextMenu(card);
        const held = f.ids;
        f.update("50", { status: "waiting" });
        expect(f.ids.slice(0, held.length)).toEqual(held);
        // Opening rename from a portaled menu must retain the hold throughout.
        const rename = f.nodes.findLast((n) => n.props.onClick?.toString().includes("p.onRename"));
        expect(rename).toBeDefined();
        rename.props.onClick();
        f.update("51", { status: "waiting" });
        expect(f.ids.slice(0, held.length)).toEqual(held);
        const input = f.nodes.findLast((n) => n.props.class === "sess-rename");
        input.props.onKeyDown({ key: "Escape" });
        expect(f.ids.slice(0, 3)).toEqual(["40", "50", "51"]);
    } finally { f.dispose(); }
});

test("actual sidebar pages projects and settled, transitions row type, and keeps active settled visible", async () => {
    const f = fixture();
    try {
        f.setGroupBy("project");
        expect(f.ids).toHaveLength(25);
        f.nav.props.onPointerEnter();
        f.nodes.findLast((n) => n.props.class === "slim more").props.onClick();
        await Promise.resolve();
        expect(f.ids).toHaveLength(50);
        const held = f.ids;
        f.update("59", { status: "waiting" });
        expect(f.ids.slice(0, 50)).toEqual(held); // Paging did not permanently release hover.
        f.nav.props.onPointerLeave();
        f.setSessions(f.sessions().map((s) => ({ ...s, settled: true, status: "idle" })));
        expect(f.ids).toHaveLength(25);
        expect(f.nodes.some((n) => String(n.props.class).startsWith("slim "))).toBe(true);
        f.setSettledOpen(false);
        expect(f.ids).toEqual([]);
        f.setActiveId("59");
        expect(f.ids).toEqual(["59"]);
        const before = f.ids;
        f.nav.props.onPointerEnter();
        solid.batch(() => { f.setArchived(f.sessions().filter((s) => s.id === "59").map((s) => ({ ...s, archived: true }))); f.setSessions(f.sessions().filter((s) => s.id !== "59")); });
        expect(f.ids).toEqual(before);
    } finally { f.dispose(); }
});

test("rail rows: needs-you rows get an amber dot and no archive; others archive on hover; headings count their sessions", () => {
    const f = fixture(6);
    const rowOf = (title: string) => f.nodes.findLast((n) => String(n.props.class).startsWith("card ") && n.querySelector()?.props.title?.startsWith(`${title}\n`));
    const buttons = (row: any) => f.descendants(row).filter((n) => n.tag === "button");
    try {
        f.update("1", { status: "waiting", waitingKind: "permission" });
        f.setActiveId("2");
        const waiting = rowOf("Session 1");
        expect(String(waiting.props.class)).toContain("waiting");
        expect(waiting.querySelector().props["aria-label"]).toBe("Session 1, Needs approval");
        expect(f.descendants(waiting).some((n) => n.props?.class === "wait-dot")).toBe(true);
        expect(f.descendants(waiting).some((n) => n.props?.class === "st waiting")).toBe(true);
        expect(buttons(waiting).some((n) => n.props.title === "Archive")).toBe(false);
        expect(buttons(waiting).some((n) => n.props.title === "More")).toBe(true);
        const idle = rowOf("Session 3");
        expect(buttons(idle).some((n) => n.props.title === "Archive")).toBe(true);
        // Rows are buttons; the open one says so.
        expect(rowOf("Session 2").querySelector().props["aria-current"]).toBe("page");
        expect(idle.querySelector().props["aria-current"]).toBeUndefined();
        f.setGroupBy("project");
        const counts = f.nodes.filter((n) => n.props.class === "n").map((n) => n.content);
        expect(counts.slice(-3)).toEqual([2, 2, 2]);
    } finally { f.dispose(); }
});

test("Needs you: waiting sessions but the open one, pinned above the list as well as in their place; keys act on the pinned row", () => {
    let next: string | undefined;
    const f = fixture(6, { actionOf: () => next });
    const group = () => f.nodes.findLast((n) => n.props.class === "needs-g");
    const pinned = () => f.nodes.filter((n) => n.props["data-needs-id"] !== undefined && f.descendants(group() ?? {}).includes(n));
    const text = (n: any) => f.descendants(n).map((c) => c.text ?? (typeof c.content === "string" || typeof c.content === "number" ? c.content : "")).join("");
    try {
        expect(group()).toBeUndefined();
        f.update("3", { status: "waiting", waitingKind: "plan", updatedAt: 50 });
        f.update("4", { status: "waiting", updatedAt: 60 });
        f.setActiveId("4");
        // The open one's request is in front of you: only 3 is pinned, saying what it asks.
        expect(pinned().map((n) => n.props["data-needs-id"])).toEqual(["3"]);
        expect(text(group())).toContain("Needs you");
        expect(text(pinned()[0])).toContain("Plan ready for review");
        // Both stay in their own places too: the list's order (⌘-cycling, ranges) has each once.
        expect(f.ids.filter((id) => id === "3")).toHaveLength(1);
        expect(f.ids.slice(0, 2).sort()).toEqual(["3", "4"]);
        // Settings covers the open one: it's pinned too.
        f.setSettingsTab("general");
        expect(pinned().map((n) => n.props["data-needs-id"]).sort()).toEqual(["3", "4"]);
        f.setSettingsTab(undefined);
        // A key on the pinned row is about its session, not the open one.
        next = "sidebar:archiveSelected";
        const row = pinned()[0];
        key(f, "a", { target: { closest: (sel: string) => (sel.includes("data-needs-id") ? { dataset: { needsId: row.props["data-needs-id"] } } : null) } });
        expect(f.bulk.archive).toHaveBeenLastCalledWith(["3"], true);
        // Clicking it opens it.
        click(f.descendants(row).find((n) => n.props.class === "card-hit needs-hit"));
        expect(f.nodes.some((n) => n.props["aria-current"] === "page" && n.props.title?.startsWith("Session 3\n"))).toBe(true);
        // Answered: the group goes.
        f.update("3", { status: "idle" });
        f.update("4", { status: "idle" });
        expect(f.ids).toHaveLength(6);
        expect(text(f.nav)).not.toContain("Needs you");
    } finally { f.dispose(); }
});

const needsGroup = (f: ReturnType<typeof fixture>) => f.nodes.findLast((n) => n.props.class === "needs-g");
const pinnedRows = (f: ReturnType<typeof fixture>) => { const g = needsGroup(f); return g ? [...new Set(f.descendants(g))].filter((n) => n.props?.["data-needs-id"] !== undefined) : []; };
const pinnedIds = (f: ReturnType<typeof fixture>) => pinnedRows(f).map((n) => n.props["data-needs-id"]);

test("Needs you's rows aren't picked: a ⌘- or Shift-click opens the session, its own place folded away or not", () => {
    const f = fixture(6);
    try {
        f.setGroupBy("project");
        f.update("3", { status: "waiting", waitingKind: "permission" });
        // Its project folded: its own row is under the heading, out of the list's order.
        f.setCollapsedProjects(["/p/0"]);
        expect(f.ids).not.toContain("3");
        expect(pinnedIds(f)).toEqual(["3"]);
        const hit = () => f.descendants(pinnedRows(f)[0]).find((n) => n.props?.class === "card-hit needs-hit");
        f.setRailSelection({ ids: ["1", "2"], anchor: "1" });
        click(hit(), { metaKey: true });
        // Opened (its project unfolds to show it), the selection gone as a plain click leaves it.
        expect(f.nodes.some((n) => n.props["aria-current"] === "page" && n.props.title?.startsWith("Session 3\n"))).toBe(true);
        expect(f.railSelection().ids).toEqual([]);
        // Shift-click too: never an empty range.
        f.setActiveId(undefined);
        f.setCollapsedProjects(["/p/0"]);
        click(hit(), { shiftKey: true });
        expect(f.railSelection().ids).toEqual([]);
        expect(f.nodes.some((n) => n.props["aria-current"] === "page" && n.props.title?.startsWith("Session 3\n"))).toBe(true);
    } finally { f.dispose(); }
});

test("Needs you while the rail holds still: rows say how they're doing now, and the group catches up once it lets go", () => {
    const f = fixture(6);
    const text = (n: any) => f.descendants(n).map((c) => c.text ?? (typeof c.content === "string" || typeof c.content === "number" ? c.content : "")).join("");
    const classes = (n: any) => String(n.props.class).split(" ");
    try {
        f.update("3", { status: "waiting", waitingKind: "plan" });
        expect(pinnedIds(f)).toEqual(["3"]);
        // The pointer on the rail: nothing moves, so the one answered stays, but not as waiting.
        f.nav.props.onPointerEnter();
        f.update("3", { status: "idle" });
        f.update("4", { status: "waiting" });
        expect(pinnedIds(f)).toEqual(["3"]);
        const row = pinnedRows(f)[0];
        expect(classes(row)).not.toContain("waiting");
        expect(text(row)).toContain("Answered");
        expect(text(row)).not.toContain("Plan ready for review");
        expect(f.descendants(row).some((n) => n.props?.class === "st waiting")).toBe(false);
        // Let go: it reconciles at once.
        f.nav.props.onPointerLeave();
        expect(pinnedIds(f)).toEqual(["4"]);
        expect(classes(pinnedRows(f)[0])).toContain("waiting");
        // Rows picked hold the list, not the group: it follows who's waiting, the order stays.
        f.setRailSelection({ ids: ["0", "1"], anchor: "0" });
        const held = f.ids;
        f.update("5", { status: "waiting", updatedAt: 500 });
        f.update("4", { status: "idle" });
        expect(pinnedIds(f)).toEqual(["5"]);
        expect(f.ids).toEqual(held);
    } finally { f.dispose(); }
});

test("FLIP respects instant/reduced motion and pauses under hover without snapping", () => {
    const f = fixture();
    try {
        f.flushFrames();
        f.update("20", { updatedAt: 300 }); f.flushFrames();
        expect(f.animations).toHaveLength(0);
        f.setMotion("quick"); f.setReduced(true);
        f.update("21", { updatedAt: 400 }); f.flushFrames();
        expect(f.animations).toHaveLength(0);
        f.setReduced(false);
        f.update("22", { updatedAt: 500 }); f.flushFrames();
        expect(f.animations.length).toBeGreaterThan(0);
        f.nav.props.onPointerEnter();
        const moving = [...f.animations];
        expect(moving.every((a) => a.paused && !a.cancelled)).toBe(true);
        f.update("59", { status: "waiting" }); f.flushFrames();
        expect(moving.every((a) => a.paused && !a.cancelled)).toBe(true);
        f.nav.props.onPointerLeave(); f.flushFrames();
        expect(moving.every((a) => a.cancelled)).toBe(true);
    } finally { f.dispose(); }
});


test("deleting a held row releases its lock without reading a removed summary", () => {
    const f = fixture();
    try {
        const card = f.nodes.findLast((n) => String(n.props.class).startsWith("card "));
        f.contextMenu(card);
        const removed = f.ids.at(-1)!;
        f.setSessions(f.sessions().filter((s) => s.id !== removed));
        expect(f.ids).not.toContain(removed);
        f.update("40", { status: "waiting" });
        expect(f.ids[0]).toBe("40");
    } finally { f.dispose(); }
});


test("archived Done leaves immediately under hover and restores the hold afterward", async () => {
    const f = fixture();
    try {
        f.setArchived(f.sessions().slice(0, 2).map((s) => ({ ...s, id: `archive-${s.id}`, archived: true })));
        f.nodes.find((n) => n.props.title === "View options").props.onClick();
        f.nodes.findLast((n) => n.props.class === "menu-item compact" && n.props.onClick?.toString().includes("setShowArchived")).props.onClick();
        expect(f.ids).toEqual(["archive-0", "archive-1"]);
        f.nav.props.onPointerEnter();
        f.nodes.findLast((n) => n.props.class === "shelf-btn" && n.props.onClick?.toString().includes("setShowArchived")).props.onClick();
        expect(f.ids).toHaveLength(25);
        expect(f.ids[0]).toBe("0");
        expect(f.ids).not.toContain("archive-0");
        await Promise.resolve();
        const held = f.ids;
        f.update("0", { updatedAt: -1000 });
        expect(f.ids).toEqual(held);
        f.nav.props.onPointerLeave();
        expect(f.ids[0]).toBe("1");
    } finally { f.dispose(); }
});

test("expanded sidebar summary updates do linear layout-key work", async () => {
    const reads: number[] = [];
    for (const count of [150, 300]) {
        const f = fixture(count);
        try {
            while (f.ids.length < count) {
                f.nodes.findLast((n) => n.props.class === "slim more").props.onClick();
                await Promise.resolve();
            }
            expect(f.ids).toHaveLength(count);
            f.resetEntryKeyReads();
            f.update("0", { title: "Updated summary" });
            expect(f.entryKeyReads).toBeGreaterThanOrEqual(count);
            expect(f.entryKeyReads).toBeLessThanOrEqual(count * 8);
            reads.push(f.entryKeyReads);
        } finally { f.dispose(); }
    }
    expect(reads[1]!).toBeLessThanOrEqual(reads[0]! * 3);
});

for (const view of ["date", "project"]) {
    test(`actual sidebar keeps run groups, labels, paging and held model cards in ${view} view`, async () => {
        const f = fixture();
        try {
            f.setGroupBy(view);
            const run = { id: "compare", cwd: "/original/project", label: "Fix the login redirect", model: "mock:a", modelName: "Model A" };
            solid.batch(() => {
                f.update("30", { run, cwd: "/worktrees/a", createdAt: 10, updatedAt: 200 });
                f.update("31", { run: { ...run, model: "mock:b", modelName: "Model B" }, cwd: "/worktrees/b", createdAt: 20, updatedAt: 300 });
            });
            expect(f.ids.slice(0, 2)).toEqual(["30", "31"]);
            expect(f.ids).toHaveLength(26); // One group consumes one slot.
            expect(f.nodes.some((n) => n.props.class === "run-group" && n.props["aria-label"] === "2 models: Fix the login redirect")).toBe(true);
            expect(f.nodes.some((n) => n.props.class === "run-head" && n.props.title === run.label)).toBe(true);
            for (const name of ["Model A", "Model B"]) expect(f.nodes.some((n) => Array.isArray(n.content) ? n.content.includes(name) : n.content === name)).toBe(true);
            const modelCard = f.nodes.findLast((n) => String(n.props.class).startsWith("card ") && n.querySelector()?.props.title?.startsWith("Session 30\n"));
            f.contextMenu(modelCard);
            const held = f.ids;
            f.update("50", { status: "waiting", waitingKind: "permission" });
            expect(f.ids.slice(0, held.length)).toEqual(held);
            const rename = f.nodes.findLast((n) => n.props.onClick?.toString().includes("p.onRename"));
            rename.props.onClick();
            f.update("31", { settled: true });
            expect(f.ids.slice(0, held.length)).toEqual(held);
            f.nodes.findLast((n) => n.props.class === "sess-rename").props.onKeyDown({ key: "Escape" });
            expect(f.ids[0]).toBe("50");
            expect(f.ids.at(-1)).toBe("31");
            f.setSessions(f.sessions().filter((s) => s.id !== "30" && s.id !== "31"));
            expect(f.ids).not.toContain("30");
            expect(f.ids).not.toContain("31");
        } finally { f.dispose(); }
    });
}

for (const layout of ["card", "settled", "archived"] as const) {
    for (const grouped of [false, true]) {
        test(`${layout} ${grouped ? "run member" : "standalone"} menus preserve keyboard targets and hold`, () => {
            const f = fixture(3);
            try {
                const run = { id: "compare", cwd: "/original", label: "Compare models", model: "mock:a", modelName: "Model A" };
                f.setSessions(f.sessions().map((s) => ({ ...s, settled: layout === "settled", ...(grouped && s.id !== "0" ? { run } : {}) })));
                if (layout === "archived") {
                    f.setArchived(f.sessions().map((s) => ({ ...s, archived: true })));
                    f.setSessions([]);
                    f.nodes.find((n) => n.props.title === "View options").props.onClick();
                    f.nodes.findLast((n) => n.props.onClick?.toString().includes("setShowArchived") && n.props.role === "menuitem").props.onClick();
                }
                const row = f.nodes.findLast((n) => String(n.props.class).startsWith(layout === "card" ? "card " : "slim ") && n.querySelector()?.props.title?.startsWith("Session 2\n"));
                expect(row).toBeDefined();
                const hit = row.querySelector();
                const more = f.descendants(row).find((n) => n.props?.["aria-haspopup"] === "menu");
                const menu = f.menus.findLast((p) => p.label === "Session actions" && p.anchor() === more);
                expect(menu).toBeDefined();
                f.contextMenu(row);
                expect(menu.point).toEqual({ x: 40, y: 60 });
                expect(menu.returnFocus()).toBe(hit);
                menu.onClose();
                for (const key of ["ContextMenu", "F10"]) {
                    let prevented = false;
                    let stopped = false;
                    row.props.onKeyDown({ key, shiftKey: key === "F10", target: hit, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
                    expect(prevented && stopped).toBe(true);
                    expect(menu.open).toBe(true);
                    expect(menu.point).toBeUndefined();
                    expect(menu.returnFocus()).toBe(hit);
                    expect(more.props["aria-expanded"]).toBe(true);
                    const held = f.ids;
                    // Reordering must wait while a standalone or grouped row menu is open.
                    if (layout === "archived") f.setArchived(f.archived().map((s) => s.id === "0" ? { ...s, updatedAt: -100 } : s));
                    else f.update("0", { updatedAt: -100 });
                    expect(f.ids).toEqual(held);
                    expect(menu.open).toBe(true);
                    menu.onClose();
                    expect(menu.open).toBe(false);
                }
                more.props.onClick();
                expect(menu.open).toBe(true);
                expect(menu.returnFocus()).toBe(more);
                expect(menu.point).toBeUndefined();
                const actions = f.descendants({ content: menu.children }).filter((n) => n.tag === "button");
                expect(actions.length).toBeGreaterThanOrEqual(5);
                expect(actions.every((n) => n.props.role === "menuitem")).toBe(true);
                menu.onClose();
                expect(f.ids[0]).not.toBe("0");
            } finally { f.dispose(); }
        });
    }
}


test("sidebar waits for the first list and retains loaded state across reconnects", () => {
    const f = fixture(0);
    const empty = () => f.nodes.findLast((n) => n.props.class === "side-empty").content;
    try {
        f.setSessionsLoaded(false);
        f.setConn("connecting");
        expect(empty()).toBe("Connecting…");
        f.setConn("open");
        expect(empty()).toBe("Loading sessions…");
        f.nodes.find((n) => n.props.title === "View options").props.onClick();
        f.nodes.findLast((n) => n.props.onClick?.toString().includes("setShowArchived") && n.props.role === "menuitem").props.onClick();
        expect(empty()).toBe("Loading sessions…");
        f.setSessionsLoaded(true);
        expect(empty()).toBe("Nothing archived.");
        f.nodes.findLast((n) => n.props.class === "shelf-btn" && n.props.onClick?.toString().includes("setShowArchived")).props.onClick();
        expect(empty()).toBe("No sessions yet. Start one from the composer.");
        for (const conn of ["connecting", "open"]) {
            f.setConn(conn);
            expect(empty()).toBe("No sessions yet. Start one from the composer.");
        }
    } finally { f.dispose(); }
});

for (const archived of [false, true]) {
    test(`sidebar shows a retryable list failure in the ${archived ? "archived" : "active"} view`, async () => {
        const f = fixture(0);
        const empty = () => f.nodes.findLast((n) => n.props.class === "side-empty");
        const contents = () => f.descendants(empty()).map((n) => n.text ?? n.content);
        const retry = () => f.descendants(empty()).find((n) => n.tag === "button" && f.descendants(n).some((child) => child.text === "Retry"));
        try {
            f.setSessionsLoaded(false);
            if (archived) {
                f.nodes.find((n) => n.props.title === "View options").props.onClick();
                f.nodes.findLast((n) => n.props.onClick?.toString().includes("setShowArchived") && n.props.role === "menuitem").props.onClick();
            }
            f.setSessionsError(true);
            expect(contents()).toContain("Couldn't load sessions.");
            expect(contents()).not.toContain("Loading sessions…");
            expect(contents()).not.toContain("No sessions yet. Start one from the composer.");
            expect(contents()).not.toContain("Nothing archived.");
            const error = new Error("Still unavailable");
            f.refreshSessions.mockRejectedValueOnce(error);
            retry().props.onClick();
            await Promise.resolve();
            expect(f.refreshSessions).toHaveBeenCalledTimes(1);
            expect(f.reportError).toHaveBeenCalledWith(error);
            expect(contents()).toContain("Couldn't load sessions.");
            f.refreshSessions.mockImplementationOnce(async () => {
                solid.batch(() => { f.setSessionsLoaded(true); f.setSessionsError(false); });
            });
            retry().props.onClick();
            await Promise.resolve();
            expect(f.refreshSessions).toHaveBeenCalledTimes(2);
            expect(empty().content).toBe(archived ? "Nothing archived." : "No sessions yet. Start one from the composer.");
            expect(contents()).not.toContain("Couldn't load sessions.");
            expect(contents()).not.toContain("Retry");
        } finally { f.dispose(); }
    });
}

// ---- Picking several sessions --------------------------------------------

const click = (hit: any, mods: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}) =>
    hit.props.onClick({ shiftKey: false, metaKey: false, ctrlKey: false, ...mods, currentTarget: hit });
const key = (f: ReturnType<typeof fixture>, k: string, extra: Record<string, unknown> = {}) => {
    const e = { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, target: { closest: () => null }, preventDefault() { this.defaultPrevented = true; }, ...extra };
    f.nav.props.onKeyDown(e);
    return e;
};
const hitOf = (f: ReturnType<typeof fixture>, id: string) => f.nodes.findLast((n) => ["card-hit", "slim-hit"].includes(n.props.class) && n.props.title?.startsWith(`Session ${id}\n`));
const rowOf = (f: ReturnType<typeof fixture>, id: string) => f.nodes.findLast((n) => n.props["data-session-id"] === id && /^(card|slim) /.test(String(n.props.class)));
// The last bar made is the one showing (one shows while two or more are selected).
const bar = (f: ReturnType<typeof fixture>) => f.nodes.findLast((n) => n.props.class === "rail-sel glass");
const barButtons = (f: ReturnType<typeof fixture>) => [...new Set(f.descendants(bar(f)).filter((n) => n.tag === "button"))].map((n) => n.props["aria-label"]).sort();

for (const view of ["date", "project"]) {
    test(`rail selection in the ${view} view: Shift-click ranges across groups, ⌘-click toggles, a plain click opens and clears`, () => {
        const f = fixture(9);
        try {
            f.setGroupBy(view);
            const order = f.ids;
            // A plain click opens the session and anchors there.
            click(hitOf(f, order[1]!));
            expect(f.railSelection()).toEqual({ ids: [], anchor: order[1] });
            click(hitOf(f, order[5]!), { shiftKey: true });
            expect(f.railSelection().ids).toEqual(order.slice(1, 6));
            if (view === "project") expect(new Set(order.slice(1, 6).map((id) => Number(id) % 3)).size).toBeGreaterThan(1); // Under more than one heading.
            // Selected rows: an accent pill with a check for the glyph, and they say so.
            expect(String(rowOf(f, order[2]!).props.class)).toContain("picked");
            expect(String(rowOf(f, order[0]!).props.class)).not.toContain("picked");
            expect(f.descendants(rowOf(f, order[2]!)).some((n) => n.props?.class === "st pick")).toBe(true);
            expect(hitOf(f, order[2]!).props["aria-label"]).toEndWith(", selected");
            // The bar: how many, and what applies.
            expect(f.descendants(bar(f)).some((n) => n.props?.class === "rail-sel-n")).toBe(true);
            expect(barButtons(f)).toEqual(["Archive 5 sessions", "Clear selection", "Delete 5 sessions…", "Settle 5 sessions"]);
            click(hitOf(f, order[3]!), { metaKey: true });
            expect(f.railSelection().ids).toEqual([order[1], order[2], order[4], order[5]]);
            click(hitOf(f, order[8]!), { metaKey: true });
            expect(f.railSelection().ids).toHaveLength(5);
            click(hitOf(f, order[7]!));
            expect(f.railSelection().ids).toEqual([]);
            expect(f.nodes.some((n) => n.props["aria-current"] === "page" && n.props.title?.startsWith(`Session ${order[7]}\n`))).toBe(true);
        } finally { f.dispose(); }
    });
}

test("picked rows hold the list still; clearing the selection lets it move", () => {
    const f = fixture(6);
    try {
        const before = f.ids;
        click(hitOf(f, before[3]!), { metaKey: true });
        f.update(before[5]!, { updatedAt: 1000 });
        expect(f.ids).toEqual(before);
        key(f, "Escape");
        expect(f.ids[0]).toBe(before[5]);
    } finally { f.dispose(); }
});

test("the selection bar and a selected row's menu act on the whole selection", () => {
    const f = fixture(6);
    try {
        const order = f.ids;
        click(hitOf(f, order[0]!));
        click(hitOf(f, order[2]!), { shiftKey: true });
        const picked = order.slice(0, 3);
        f.descendants(bar(f)).find((n) => n.props?.["aria-label"] === "Delete 3 sessions…").props.onClick();
        expect(f.bulk.askToDelete).toHaveBeenLastCalledWith(picked);
        f.descendants(bar(f)).find((n) => n.props?.["aria-label"] === "Archive 3 sessions").props.onClick();
        expect(f.bulk.archive).toHaveBeenLastCalledWith(picked, true);
        // Right-click on a selected row: the menu is about all of them.
        f.contextMenu(rowOf(f, order[1]!));
        const menu = f.menus.findLast((p) => p.open);
        expect(menu.label).toBe("Selected sessions actions");
        const items = f.descendants({ content: menu.children }).filter((n) => n.tag === "button");
        const labels = items.map((n) => f.descendants(n).map((c) => c.text ?? (typeof c.content === "string" || typeof c.content === "number" ? c.content : "")).join(""));
        expect(labels.some((l) => l.includes("Delete") && l.includes("3 sessions"))).toBe(true);
        items.find((n) => n.props.onClick?.toString().includes("settleSessions")).props.onClick();
        expect(f.bulk.settle).toHaveBeenLastCalledWith(picked, true);
        // An unselected row keeps its own menu.
        f.contextMenu(rowOf(f, order[4]!));
        expect(f.menus.findLast((p) => p.open).label).toBe("Session actions");
        // ✕ clears.
        f.descendants(bar(f)).find((n) => n.props?.["aria-label"] === "Clear selection").props.onClick();
        expect(f.railSelection().ids).toEqual([]);
    } finally { f.dispose(); }
});

test("archived rows offer Restore and Delete; switching lists clears the selection", () => {
    const f = fixture(3);
    try {
        f.setArchived(f.sessions().map((s) => ({ ...s, archived: true })));
        f.setSessions([]);
        f.nodes.find((n) => n.props.title === "View options").props.onClick();
        f.nodes.findLast((n) => n.props.onClick?.toString().includes("setShowArchived") && n.props.role === "menuitem").props.onClick();
        click(hitOf(f, "0"));
        click(hitOf(f, "2"), { shiftKey: true });
        expect(f.railSelection().ids).toEqual(["0", "1", "2"]);
        expect(barButtons(f)).toEqual(["Clear selection", "Delete 3 sessions…", "Restore 3 sessions"]);
        f.descendants(bar(f)).find((n) => n.props?.["aria-label"] === "Restore 3 sessions").props.onClick();
        expect(f.bulk.archive).toHaveBeenLastCalledWith(["0", "1", "2"], false);
        f.nodes.findLast((n) => n.props.class === "shelf-btn" && n.props.onClick?.toString().includes("setShowArchived")).props.onClick();
        expect(f.railSelection().ids).toEqual([]);
    } finally { f.dispose(); }
});

test("rail keys: select all, act on the selection (else the open row), Esc clears before it can interrupt", () => {
    let next: string | undefined;
    const f = fixture(4, { actionOf: (_e, contexts) => (expect(contexts).toEqual(["Sidebar", "Global"]), next) });
    try {
        next = "sidebar:selectAll";
        expect(key(f, "a").defaultPrevented).toBe(true);
        expect(f.railSelection().ids).toEqual(f.ids);
        next = "sidebar:settleSelected";
        key(f, "s");
        expect(f.bulk.settle).toHaveBeenLastCalledWith(f.ids, true);
        next = "sidebar:deleteSelected";
        key(f, "Backspace");
        expect(f.bulk.askToDelete).toHaveBeenLastCalledWith(f.ids);
        next = undefined;
        expect(key(f, "Escape").defaultPrevented).toBe(true);
        expect(f.railSelection().ids).toEqual([]);
        // With nothing selected, Esc is the window's again (it interrupts a working session).
        expect(key(f, "Escape").defaultPrevented).toBe(false);
        // Nothing selected: the open session, as a selection of one.
        f.setActiveId("2");
        next = "sidebar:archiveSelected";
        key(f, "a");
        expect(f.bulk.archive).toHaveBeenLastCalledWith(["2"], true);
        // Not a rail action: left for the window.
        next = "app:newSession";
        expect(key(f, "n").defaultPrevented).toBe(false);
        // Typing in a rename box keeps its keys.
        next = "sidebar:selectAll";
        key(f, "a", { target: { closest: () => ({}) } });
        expect(f.railSelection().ids).toEqual([]);
    } finally { f.dispose(); }
});

// ---- Folding a project under its heading ----------------------------------

const heading = (f: ReturnType<typeof fixture>, cwd: string) => f.nodes.findLast((n) => n.props.class === "shelf-toggle" && n.props.title === cwd);
const headRow = (f: ReturnType<typeof fixture>, cwd: string) => f.nodes.findLast((n) => String(n.props.class).startsWith("shelf project-head") && f.descendants(n).includes(heading(f, cwd)));

test("grouped by project, a heading folds and unfolds its sessions; its New session doesn't", () => {
    const f = fixture(9);
    try {
        f.setGroupBy("project");
        const inP0 = f.ids.filter((id) => Number(id) % 3 === 0);
        expect(heading(f, "/p/0").props["aria-expanded"]).toBe(true);
        heading(f, "/p/0").props.onClick();
        expect(f.collapsedProjects()).toEqual(["/p/0"]);
        expect(heading(f, "/p/0").props["aria-expanded"]).toBe(false);
        expect(String(headRow(f, "/p/0").props.class)).toContain("folded");
        for (const id of inP0) expect(f.ids).not.toContain(id);
        // Folded, it still shows how many.
        expect(f.descendants(heading(f, "/p/0")).find((n) => n.props?.class === "n").content).toBe(3);
        // The + starts a session there and leaves the fold alone.
        const add = f.descendants(headRow(f, "/p/0")).find((n) => n.props?.class === "shelf-btn add");
        add.props.onClick();
        expect(f.collapsedProjects()).toEqual(["/p/0"]);
        heading(f, "/p/0").props.onClick();
        expect(f.collapsedProjects()).toEqual([]);
        expect(f.ids).toEqual(expect.arrayContaining(inP0));
        // Listed by date nothing is folded, whatever was.
        heading(f, "/p/0").props.onClick();
        f.setGroupBy("date");
        expect(f.ids).toEqual(expect.arrayContaining(inP0));
    } finally { f.dispose(); }
});

test("a folded project with a session that needs you shows the amber dot on its heading", () => {
    const f = fixture(6);
    try {
        f.setGroupBy("project");
        f.setCollapsedProjects(["/p/1"]);
        const dot = () => f.descendants(heading(f, "/p/1")).some((n) => n.props?.class === "wait-dot");
        expect(dot()).toBe(false);
        f.update("4", { status: "waiting", waitingKind: "permission" });
        expect(dot()).toBe(true);
        expect(f.ids).not.toContain("4");
    } finally { f.dispose(); }
});

test("opening a session in a folded project (⌘K, a notification) unfolds it", () => {
    const f = fixture(6);
    try {
        f.setGroupBy("project");
        f.setCollapsedProjects(["/p/1", "/p/2"]);
        f.setActiveId("4");
        expect(f.collapsedProjects()).toEqual(["/p/2"]);
        expect(f.ids).toContain("4");
        // Folding the open session's own project afterwards is allowed.
        heading(f, "/p/1").props.onClick();
        expect(f.collapsedProjects()).toEqual(["/p/2", "/p/1"]);
        expect(f.ids).not.toContain("4");
    } finally { f.dispose(); }
});

test("Collapse all and Expand all are in the view menu while grouped by project", () => {
    const f = fixture(6);
    const item = (label: string) => f.nodes.findLast((n) => n.props.role === "menuitem" && f.descendants(n).some((c) => c.text === ` ${label}` || c.text === label));
    const openMenu = () => f.nodes.find((n) => n.props.title === "View options").props.onClick();
    try {
        openMenu();
        expect(item("Collapse all projects")).toBeUndefined();
        f.nodes.find((n) => n.props.title === "View options").props.onClick();
        f.setGroupBy("project");
        openMenu();
        item("Collapse all projects").props.onClick();
        expect([...f.collapsedProjects()].sort()).toEqual(["/p/0", "/p/1", "/p/2"]);
        expect(f.ids).toEqual([]);
        openMenu();
        item("Expand all projects").props.onClick();
        expect(f.collapsedProjects()).toEqual([]);
        expect(f.ids).toHaveLength(6);
    } finally { f.dispose(); }
});

test("selection and folds: a Shift-click range skips a folded project's rows; folding drops its rows from the selection", () => {
    const f = fixture(9);
    try {
        f.setGroupBy("project");
        const order = f.ids;
        const first = order[0]!;
        const last = order.at(-1)!;
        f.setCollapsedProjects(["/p/1"]);
        click(hitOf(f, first));
        click(hitOf(f, last), { shiftKey: true });
        expect(f.railSelection().ids).toEqual(order.filter((id) => Number(id) % 3 !== 1));
        heading(f, "/p/2").props.onClick();
        expect(f.railSelection().ids).toEqual(order.filter((id) => Number(id) % 3 === 0));
    } finally { f.dispose(); }
});
