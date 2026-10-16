import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, type Node } from "../helpers/gui-render";
import { anchoredTop, atBottom, restoredShown, positionCache, TURN_PAGE } from "../../gui/src/lib/transcript-scroll";

// Real Solid effects/reconciliation; deterministic layout and browser scheduling
// at the DOM boundary let these regressions run without listening on a socket.
const frames = new Map<number, () => void>();
let sequence = 0;
const observers = new Set<() => void>();
const raf = (fn: () => void) => { frames.set(++sequence, fn); return sequence; };
const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); };
const resize = () => observers.forEach((fn) => fn());
const cache = positionCache();
let reduced = false;
const prefs = { motion: "smooth" };
let scrollBehavior: string | undefined;
let restoredOpen = false;
let root = node("root");
let top = 0;
let scrollWrites = 0;
let partShift = 30;
const has = (n: Node, cls: string) => n.props.class?.split(" ").includes(cls);
const height = (n: Node): number => n.props["data-turn"] ? 200 : has(n, "earlier") ? 50 : has(n, "transcript-end") ? 500 : n.children.reduce((sum, child) => sum + height(child), 0);
const absolute = (n: Node): number => {
    if (!n.parent || has(n, "transcript-col")) return 0;
    return absolute(n.parent) + n.parent.children.slice(0, n.parent.children.indexOf(n)).reduce((sum, child) => sum + height(child), 0);
};
const matches = (n: Node, selector: string) => selector.split(", ").some((s) => {
    if (s.startsWith(".")) return has(n, s.slice(1));
    const match = s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    return !!match && n.props[match[1]!] !== undefined && (match[2] === undefined || n.props[match[1]!] === match[2]);
});
const decorate = (n: Node): any => Object.assign(n, {
    getBoundingClientRect: () => ({ top: has(n, "transcript") ? 0 : absolute(n) - top, bottom: absolute(n) - top + height(n) }),
    querySelectorAll: (selector: string) => all(n).slice(1).filter((child) => matches(child, selector)),
    querySelector: (selector: string) => all(n).slice(1).find((child) => matches(child, selector)),
    scrollTo: (options: any) => { scrollBehavior = options.behavior; (n as any).scrollTop = options.top; },
    classList: { add() {}, remove() {} },
});
const create = (tag: string): any => {
    const n = decorate(renderer.createElement(tag));
    Object.defineProperties(n, {
        dataset: { get: () => ({ turn: n.props["data-turn"], find: n.props["data-find"] }) },
        scrollTop: { get: () => top, set: (value) => { scrollWrites++; top = Math.max(0, Math.min(value, height(n) - 500)); } },
        scrollHeight: { get: () => height(n) }, clientHeight: { get: () => 500 },
    });
    return n;
};
const [jump, setJump] = solid.createSignal<any>();
const scope = {
    renderer: { ...solid, ...renderer, createElement: create },
    anchoredTop, atBottom, restoredShown, transcriptPositions: cache, PAGE: TURN_PAGE, prefs,
    requestAnimationFrame: raf, cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class { constructor(private cb: () => void) {} observe() { observers.add(this.cb); } disconnect() { observers.delete(this.cb); } },
    matchMedia: () => ({ matches: reduced }), CSS: { escape: (s: string) => s },
    jumpTarget: jump, setJumpTarget: setJump, findOpen: () => false,
    openFind() {}, setFindQuery() {}, toast() { throw new Error("unexpected toast"); },
    turnAt: (turns: any[], _seg: number, index: number) => turns[index], BAR_ROOM: 48,
    rewindTarget: { set() {} }, setRewindOpen() {}, ArrowDown: () => node("icon"), FindBar: () => node("find"),
    setTimeout() {},
    TurnView: (p: any) => {
        restoredOpen ||= p.workOpen;
        const n = create("article"); n.props["data-turn"] = p.turn.id;
        const part = create("div"); part.props["data-find"] = "body";
        part.getBoundingClientRect = () => ({ top: absolute(n) - top + partShift, bottom: absolute(n) - top + 200 });
        renderer.insert(n, part);
        return n;
    },
};
const Transcript = component(readFileSync(new URL("../../gui/src/components/Transcript.tsx", import.meta.url), "utf8").replace(/^import .*;\n/gm, ""), "Transcript", scope);
const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `turn-${i}`, prompt: { text: `prompt ${i}` } }));
const [aTurns, setATurns] = solid.createSignal(turns(45));
const a = { id: "a", view: { get turns() { return aTurns(); } } };
const b = { id: "b", view: { turns: turns(90) } };
const mount = (handle: any, runFrame = true) => { top = 0; root = node("root"); const dispose = renderer.render(() => Transcript({ handle }), root); if (runFrame) flush(); return dispose; };
const scroller = () => all(root).find((n) => has(n, "transcript"))!;
const scroll = (value: number) => { (scroller() as any).scrollTop = value; scroller().props.onScroll(); };
const button = (cls: string) => all(root).find((n) => has(n, cls))!;
const turn = (id: string) => all(root).find((n) => n.props["data-turn"] === id) as any;
let dispose = mount(a);
try {
    assert.equal(all(root).filter((n) => n.tag === "article").length, 40);
    assert.equal(top, 8050, "first visits follow the bottom");
    scroll(0);
    const before = turn("turn-5").getBoundingClientRect().top;
    button("earlier").props.onClick();
    assert.equal(turn("turn-5").getBoundingClientRect().top, before, "paging including button removal preserves the old turn");
    resize();
    assert.equal(turn("turn-5").getBoundingClientRect().top, before, "resize does not fight the paging correction");
    scroller().props.onScroll();
    const writes = scrollWrites;
    resize();
    assert.equal(scrollWrites, writes, "no-op resize corrections must not cancel smooth scrolling");
    const partTop = turn("turn-5").children[0].getBoundingClientRect().top;
    partShift += 12; resize();
    assert.equal(turn("turn-5").children[0].getBoundingClientRect().top, partTop, "a work-log block stays put when the live head changes height");
    partShift -= 12; resize(); scroller().props.onScroll();
    const savedTop = top;
    dispose(); dispose = mount(b);
    assert.equal(top, 8050, "another session starts at its bottom");
    dispose(); dispose = mount(a);
    assert.equal(top, savedTop);
    assert.equal(all(root).filter((n) => n.tag === "article").length, 45, "page count restored across a keyed remount");
    dispose();
    setATurns(turns(125));
    dispose = mount(a);
    assert.equal(turn("turn-5").getBoundingClientRect().top, before, "background turns cannot page out the reading anchor");
    button("jump").props.onClick();
    assert.equal(scrollBehavior, "smooth");
    scroller().props.onScroll();
    dispose(); setATurns(turns(130)); dispose = mount(a);
    assert.equal(top, 26000, "a session left at bottom follows new turns on return");
    scroll(0); reduced = true;
    button("jump").props.onClick();
    assert.equal(scrollBehavior, "instant", "OS reduced motion prevents smooth jumps");
    scroll(0); reduced = false; prefs.motion = "instant";
    button("jump").props.onClick();
    assert.equal(scrollBehavior, "instant", "app motion preference prevents smooth jumps");
    scroll(0);
    setJump({ sessionId: "a", index: 2, seg: 0, query: "prompt", role: "user" });
    flush(); resize(); scroller().props.onScroll();
    assert.equal(turn("turn-2").getBoundingClientRect().top, 48, "explicit search navigation wins over saved position");
    resize();
    assert.equal(turn("turn-2").getBoundingClientRect().top, 48);
    scroll(0); setATurns(turns(131));
    assert.ok(frames.size > 0, "sending schedules a bottom jump");
    dispose();
    assert.equal(frames.size, 0, "disposing cancels stale frame work");
    assert.equal(observers.size, 0);
    dispose = mount(a, false);
    setATurns(turns(132)); flush(); scroll(0);
    assert.ok(button("jump"), "a send before initial restoration still enables scroll tracking");
    dispose();
    const running = { id: "background", view: { turns: turns(45).map((t) => ({ ...t, status: "running" })) } };
    dispose = mount(running); scroll(0); dispose();
    running.view.turns.forEach((t) => { t.status = "done"; });
    restoredOpen = false; dispose = mount(running);
    assert.ok(restoredOpen, "work that completed while unmounted restores open for an off-bottom reader");
} finally { dispose(); }
