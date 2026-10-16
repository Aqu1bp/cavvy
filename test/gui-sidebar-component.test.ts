// Compile the actual Sidebar with Solid client reactivity; fake only rendering,
// clocks, and external services. No HTTP/WebSocket server is needed.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { transformSync } from "../gui/node_modules/@babel/core/lib/index.js";
import solidPreset from "../gui/node_modules/babel-preset-solid/index.js";
import * as solid from "../gui/node_modules/solid-js/dist/solid.js";
import * as order from "../gui/src/lib/session-order";
import * as format from "../gui/src/lib/format";
import { sessionStatus } from "../gui/src/lib/session-status";
import type { SessionSummary } from "../src/server/protocol";

function fixture() {
    const nodes: any[] = [];
    const frames = new Map<number, () => void>();
    const animations: any[] = [];
    let sequence = 0;
    let ids: string[] = [];
    const [sessions, setSessions] = solid.createSignal<SessionSummary[]>(Array.from({ length: 60 }, (_, i) => ({
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
    const renderer = {
        ...solid, effect: solid.createRenderEffect, memo: solid.createMemo, use: (fn: (el: any) => void, el: any) => fn(el),
        createElement: (tag: string) => {
            const node: any = { tag, props: {}, dataset: {}, focus() {}, select() {},
                getBoundingClientRect: () => ({ top: ids.indexOf(node.dataset.sessionRow) * 100 }),
                querySelectorAll: () => ids.map((id) => nodes.findLast((n) => n.dataset.sessionRow === id)).filter(Boolean),
                animate: () => { const a = { paused: false, cancelled: false, pause() { this.paused = true; }, play() { this.paused = false; }, cancel() { this.cancelled = true; } }; animations.push(a); return a; },
            };
            nodes.push(node); return node;
        },
        createTextNode: (text: string) => ({ text }), insertNode() {},
        setProp: (node: any, key: string, value: any) => { node.props[key] = value; if (key === "data-session-row") node.dataset.sessionRow = value; },
        insert: (_node: any, value: any) => solid.createRenderEffect(() => resolve(value)),
    };
    const source = readFileSync(new URL("../gui/src/components/Sidebar.tsx", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
    const compiled = transformSync(source, { filename: "Sidebar.tsx", parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[solidPreset, { generate: "universal", moduleName: "test-renderer" }]], configFile: false, babelrc: false })!.code!;
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(compiled)
        .replace(/import \{ ([\w$]+) as ([\w$]+) \} from "test-renderer";/g, "const $2 = renderer.$1;");
    const icons = Object.fromEntries(["Archive", "ArchiveRestore", "Check", "CheckCheck", "ChevronUp", "FolderPlus", "ListFilter", "MoreHorizontal", "PanelLeftClose", "Pencil", "Pin", "PinOff", "Plus", "Search", "Settings", "SquarePen", "Trash2", "Undo2", "ProviderIcon"].map((name) => [name, () => null]));
    const scope = { renderer, ...solid, ...order, ...format, ...icons, sessionStatus, app, prefs,
        setPrefs: (key: string, value: any) => key === "groupBy" ? setGroupBy(value) : setSettledOpen(value),
        setSidebarOrder: (value: string[] | undefined) => { ids = value ?? []; }, now: () => 100000,
        handleFor: () => undefined, isUnread: () => true, activate: setActiveId,
        Popover: (p: any) => solid.createMemo(() => p.open ? p.children : null),
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
    return { nodes, nav, update, setGroupBy, setSettledOpen, setActiveId, setSessions, sessions, setArchived, setMotion, animations,
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
        card.props.onContextMenu({ preventDefault() {} });
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
        card.props.onContextMenu({ preventDefault() {} });
        const removed = f.ids.at(-1)!;
        f.setSessions(f.sessions().filter((s) => s.id !== removed));
        expect(f.ids).not.toContain(removed);
        f.update("40", { status: "waiting" });
        expect(f.ids[0]).toBe("40");
    } finally { f.dispose(); }
});
