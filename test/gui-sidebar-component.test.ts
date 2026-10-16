// Compile the actual Sidebar with Solid client reactivity; fake only rendering,
// clocks, and external services. No HTTP/WebSocket server is needed.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { transformSync } from "../gui/node_modules/@babel/core/lib/index.js";
import solidPreset from "../gui/node_modules/babel-preset-solid/index.js";
import * as solid from "../gui/node_modules/solid-js/dist/solid.js";
import * as order from "../gui/src/lib/session-order";
import * as format from "../gui/src/lib/format";
import { rowMenuKey } from "../gui/src/lib/menu";
import { sessionStatus } from "../gui/src/lib/session-status";
import type { SessionSummary } from "../src/server/protocol";

function fixture(count = 60) {
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
    const [archived, setArchived] = solid.createSignal<SessionSummary[]>([]);
    const [activeId, setActiveId] = solid.createSignal<string>();
    const [groupBy, setGroupBy] = solid.createSignal("date");
    const [settledOpen, setSettledOpen] = solid.createSignal(true);
    const [motion, setMotion] = solid.createSignal("instant");
    let reduced = false;
    const app = { get sessions() { return sessions(); }, get archived() { return archived(); }, get activeId() { return activeId(); }, projects: [], models: [], conn: "open" };
    const prefs = { get groupBy() { return groupBy(); }, get settledOpen() { return settledOpen(); }, get motion() { return motion(); } };
    const resolve = (value: any): any => typeof value === "function" ? resolve(value()) : Array.isArray(value) ? value.map(resolve) : value;
    const descendants = (node: any): any[] => [node, ...[...(node.children ?? []), node.content].flat(Infinity).filter((child) => child && typeof child === "object" && child !== node).flatMap(descendants)];
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
    const icons = Object.fromEntries(["Archive", "ArchiveRestore", "Check", "CheckCheck", "ChevronUp", "FolderPlus", "Layers", "ListFilter", "MoreHorizontal", "PanelLeftClose", "Pencil", "Pin", "PinOff", "Plus", "Search", "Settings", "SquarePen", "Trash2", "Undo2", "ProviderIcon"].map((name) => [name, () => null]));
    const scope = { renderer, ...solid, ...order, ...format, ...icons, sessionStatus, rowMenuKey, app, prefs,
        // Count work against layout keys, rather than timing a machine-dependent render.
        holdSidebar: (...args: Parameters<typeof order.holdSidebar>) => order.holdSidebar(...args).map((entry) => ({
            ...entry, get key() { entryKeyReads++; return entry.key; },
        })),
        setPrefs: (key: string, value: any) => key === "groupBy" ? setGroupBy(value) : setSettledOpen(value),
        setSidebarOrder: (value: string[] | undefined) => { ids = value ?? []; }, now: () => 100000,
        handleFor: () => undefined, isUnread: () => true, activate: setActiveId,
        Menu: (p: any) => { menus.push(p); return solid.createMemo(() => p.open ? p.children : null); },
        isTauri: false, mod: "⌘", os: "macos", toggleSidebar() {}, setPaletteOpen() {}, setSettingsTab() {},
        setDeleteRequest() {}, chooseProject() {}, newSession() {}, openProject() {}, pin() {}, rename() {}, archive() {}, settle() {},
        requestAnimationFrame: (fn: () => void) => { frames.set(++sequence, fn); return sequence; },
        cancelAnimationFrame: (id: number) => frames.delete(id),
        matchMedia: () => ({ matches: reduced }),
    };
    const render = new Function(...Object.keys(scope), `${js}; return Sidebar;`)(...Object.values(scope));
    let dispose!: () => void;
    solid.createRoot((d: () => void) => { dispose = d; render(); });
    const nav = nodes.find((n) => n.tag === "nav");
    const update = (id: string, patch: Partial<SessionSummary>) => setSessions((list) => list.map((s) => s.id === id ? { ...s, ...patch } : s));
    const flushFrames = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
    const contextMenu = (row: any) => row.props.onContextMenu({ target: row.querySelector(), currentTarget: row, button: 2, clientX: 40, clientY: 60, preventDefault() {} });
    return { nodes, menus, descendants, contextMenu, nav, update, setGroupBy, setSettledOpen, setActiveId, setSessions, sessions, archived, setArchived, setMotion, animations,
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
        expect(f.nodes.some((n) => String(n.props.class).includes("st tone-muted unread"))).toBe(true);
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
