import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, type Node } from "../helpers/gui-render";
import { anchoredTop, atBottom, restoredShown, positionCache, TURN_PAGE } from "../../gui/src/lib/transcript-scroll";

// Real Solid effects/reconciliation; deterministic layout and browser scheduling
// at the DOM boundary let these regressions run without listening on a socket.
const frames = new Map<number, () => void>();
let sequence = 0;
const observers = new Map<() => void, Set<Node>>();
const raf = (fn: (now: number) => void) => { frames.set(++sequence, fn); return sequence; };
// Each flush is the next frame, 16ms on (performance.now()'s clock, as in a browser).
let clock = performance.now();
const flush = () => { const pending = [...frames.values()]; frames.clear(); clock = Math.max(clock + 16, performance.now()); pending.forEach((fn) => fn(clock)); };
const resize = (target?: Node) => observers.forEach((targets, fn) => { if (!target || targets.has(target)) fn(); });
const cache = positionCache();
let reduced = false;
const prefs = { motion: "smooth" };
let scrollBehavior: string | undefined;
let scrollTarget = 0;
let restoredOpen = false;
let root = node("root");
let top = 0;
let scrollWrites = 0;
let viewportHeight = 500;
let deferSmooth = false;
let partShift = 30;
const turnHeights = new Map<string, number>();
let omitPromptPart = false;
const has = (n: Node, cls: string) => n.props.class?.split(" ").includes(cls);
const height = (n: Node): number => n.props["data-turn"] ? turnHeights.get(n.props["data-turn"]) ?? 200 : has(n, "earlier") ? 50 : has(n, "transcript-end") ? 500 : n.children.reduce((sum, child) => sum + height(child), 0);
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
    getBoundingClientRect: () => ({ top: has(n, "transcript") ? 0 : absolute(n) - top, bottom: absolute(n) - top + height(n), height: height(n) }),
    querySelectorAll: (selector: string) => all(n).slice(1).filter((child) => matches(child, selector)),
    querySelector: (selector: string) => all(n).slice(1).find((child) => matches(child, selector)),
    scrollTo: (options: any) => { scrollBehavior = options.behavior; scrollTarget = Math.max(0, Math.min(options.top, height(n) - viewportHeight)); if (!deferSmooth || options.behavior !== "smooth") (n as any).scrollTop = options.top; },
    classList: { add() {}, remove() {} },
});
const create = (tag: string): any => {
    const n = decorate(renderer.createElement(tag));
    Object.defineProperties(n, {
        dataset: { get: () => ({ turn: n.props["data-turn"], find: n.props["data-find"] }) },
        scrollTop: { get: () => top, set: (value) => { scrollWrites++; top = Math.max(0, Math.min(value, height(n) - viewportHeight)); } },
        scrollHeight: { get: () => height(n) }, clientHeight: { get: () => viewportHeight },
    });
    return n;
};
const [jump, setJump] = solid.createSignal<any>();
const [findShown, setFindShown] = solid.createSignal(false);
let findProps: any;
const scope = {
    renderer: { ...solid, ...renderer, createElement: create },
    anchoredTop, atBottom, restoredShown, transcriptPositions: cache, PAGE: TURN_PAGE, prefs,
    requestAnimationFrame: raf, cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class {
        constructor(private cb: () => void) {}
        observe(target: Node) { if (!observers.has(this.cb)) observers.set(this.cb, new Set()); observers.get(this.cb)!.add(target); }
        disconnect() { observers.delete(this.cb); }
    },
    matchMedia: () => ({ matches: reduced }), CSS: { escape: (s: string) => s },
    jumpTarget: jump, setJumpTarget: setJump, findOpen: findShown,
    openFind() {}, setFindQuery() {}, toast() { throw new Error("unexpected toast"); },
    turnAt: (turns: any[], _seg: number, index: number) => turns[index], BAR_ROOM: 48,
    rewindTarget: { set() {} }, setRewindOpen() {}, ArrowDown: () => node("icon"), FindBar: (p: any) => { findProps = p; return node("find"); }, CardFoldsProvider: (p: any) => p.children,
    setTimeout() {},
    TurnView: (p: any) => {
        restoredOpen ||= p.workOpen;
        const n = create("article"); n.props["data-turn"] = p.turn.id;
        if (omitPromptPart && p.turn.id === "turn-5") return n;
        const part = create("div"); part.props["data-find"] = "prompt";
        part.getBoundingClientRect = () => ({ top: absolute(n) - top + partShift, bottom: absolute(n) - top + height(n), height: height(n) - partShift });
        renderer.insert(n, part);
        return n;
    },
};
const Transcript = component(readFileSync(new URL("../../gui/src/components/Transcript.tsx", import.meta.url), "utf8").replace(/^import .*;\n/gm, ""), "Transcript", scope);
const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `turn-${i}`, prompt: { text: `prompt ${i}` } }));
const [aTurns, setATurns] = solid.createSignal(turns(45));
const a = { id: "a", view: { state: {}, get turns() { return aTurns(); } } };
const b = { id: "b", view: { state: {}, turns: turns(90) } };
const mount = (handle: any, runFrame = true) => { top = 0; root = node("root"); const dispose = renderer.render(() => Transcript({ handle }), root); if (runFrame) flush(); return dispose; };
const scroller = () => all(root).find((n) => has(n, "transcript"))!;
const scroll = (value: number) => { (scroller() as any).scrollTop = value; scroller().props.onScroll(); };
const button = (cls: string) => all(root).find((n) => has(n, cls))!;
const turn = (id: string) => all(root).find((n) => n.props["data-turn"] === id) as any;
let dispose = mount(a);
try {
    assert.equal(all(root).filter((n) => n.tag === "article").length, 40);
    assert.equal(top, 8050, "first visits follow the bottom");
    const pinnedWrites = scrollWrites;
    for (let i = 0; i < 20; i++) resize(scroller());
    assert.equal(scrollWrites, pinnedWrites, "unchanged pinned geometry must not write scroll position again");
    viewportHeight = 240; resize(scroller());
    assert.equal(top, 8310, "a pinned transcript follows a shorter scroller without content resizing");
    assert.equal(button("jump"), undefined);
    scroller().props.onScroll();
    viewportHeight = 500; resize(scroller());
    assert.equal(top, 8050, "a pinned transcript follows a taller scroller");
    scroll(1200);
    const anchorTop = turn("turn-10").getBoundingClientRect().top;
    viewportHeight = 240; resize(scroller());
    assert.equal(turn("turn-10").getBoundingClientRect().top, anchorTop, "resizing preserves an unstuck reader's anchor");
    assert.ok(button("jump"), "observing the scroller must not enable following");
    const anchorPartTop = turn("turn-10").children[0].getBoundingClientRect().top;
    partShift += 12; resize(scroller());
    assert.equal(turn("turn-10").children[0].getBoundingClientRect().top, anchorPartTop, "scroller resize restores the reading block after reflow");
    partShift -= 12; viewportHeight = 500; resize(scroller());
    deferSmooth = true;
    button("jump").props.onClick();
    assert.equal(scrollBehavior, "smooth");
    const pendingWrites = scrollWrites;
    viewportHeight = 240; resize(scroller());
    assert.equal(scrollBehavior, "smooth", "resizing before the first scroll event keeps the jump smooth");
    assert.equal(scrollWrites, pendingWrites);
    scroll(1600); // A browser scroll event midway through the smooth jump.
    const smoothWrites = scrollWrites;
    viewportHeight = 180; resize(scroller());
    assert.equal(scrollWrites, smoothWrites, "scroller resize must not cancel an in-flight smooth jump");
    assert.equal(scrollTarget, 8370, "a jump retargets the new bottom when the scroller shrinks mid-flight");
    scroll(scrollTarget - 30);
    const nearBottomWrites = scrollWrites;
    resize(scroller());
    assert.equal(scrollBehavior, "smooth", "entering the following threshold must not snap the jump to its end");
    assert.equal(scrollWrites, nearBottomWrites);
    scroll(scrollTarget); resize(scroller());
    assert.equal(button("jump"), undefined, "reaching the bottom resumes following");
    deferSmooth = false;
    viewportHeight = 500; resize(scroller());
    assert.equal(scrollBehavior, "instant", "ordinary following resumes after the jump completes");
    for (const input of ["onWheel", "onTouchStart", "onPointerDown", "onKeyDown"]) {
        scroll(1200); deferSmooth = true;
        button("jump").props.onClick();
        scroller().props[input]();
        const pendingInterruptedWrites = scrollWrites;
        viewportHeight = 240; resize(scroller());
        assert.equal(scrollWrites, pendingInterruptedWrites, `${input} cancels following before the first scroll event`);
        scroll(1000);
        const interruptedWrites = scrollWrites;
        viewportHeight = 240; resize(scroller());
        assert.equal(scrollWrites, interruptedWrites, `${input} interrupts the jump without resize pulling the reader back down`);
        assert.ok(button("jump"));
        viewportHeight = 500; resize(scroller());
        deferSmooth = false;
    }
    scroll(0);
    resize(scroller());
    assert.equal(top, 0, "a user scroll wins over following on resize");
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
    prefs.motion = "smooth"; deferSmooth = true;
    button("jump").props.onClick();
    setJump({ sessionId: "a", index: 2, seg: 0, query: "prompt", role: "user" });
    flush(); resize(); scroller().props.onScroll();
    assert.equal(turn("turn-2").getBoundingClientRect().top, 48, "explicit search navigation wins over saved position");
    deferSmooth = false;
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
    // While a turn runs, growth at the end glides into view over a few frames and stays followed.
    const live = { id: "live", view: { state: {}, turns: turns(45).map((t, i) => ({ ...t, status: i === 44 ? "running" : "done" })) } };
    dispose = mount(live);
    const bottom = () => height(scroller()) - viewportHeight;
    assert.equal(top, bottom(), "a running turn starts followed");
    turnHeights.set("turn-44", 420); resize();
    assert.ok(top < bottom(), "growth doesn't jump: it glides");
    flush();
    assert.ok(top > bottom() - 220 && top < bottom(), "the first frame moves part of the way");
    scroller().props.onScroll(); // The glide's own scroll event, still more than 64px from the end.
    assert.equal(button("jump"), undefined, "a glide on its way down stays stuck to the end");
    let glideFrames = 1;
    while (frames.size && glideFrames < 60) { flush(); glideFrames++; }
    assert.equal(top, bottom(), "the glide reaches the end");
    assert.ok(glideFrames > 3, "over several frames");
    turnHeights.set("turn-44", 620); resize(); flush();
    scroller().props.onWheel();
    assert.equal(frames.size, 0, "the reader scrolling stops a glide");
    scroller().props.onScroll();
    assert.ok(button("jump"), "and where they leave it decides whether it follows");
    scroll(bottom()); assert.equal(button("jump"), undefined);
    reduced = true; turnHeights.set("turn-44", 740); resize();
    assert.equal(top, bottom(), "reduced motion follows at once");
    reduced = false; live.view.turns[44]!.status = "done"; turnHeights.set("turn-44", 780); resize();
    assert.equal(top, bottom(), "the end of a turn lands at once");
    turnHeights.clear(); dispose();
    const running = { id: "background", view: { state: {}, turns: turns(45).map((t) => ({ ...t, status: "running" })) } };
    dispose = mount(running); scroll(0); dispose();
    running.view.turns.forEach((t) => { t.status = "done"; });
    restoredOpen = false; dispose = mount(running);
    assert.ok(restoredOpen, "work that completed while unmounted restores open for an off-bottom reader");
    for (const missingPart of [false, true]) {
        dispose();
        const promptSession = { id: `long-prompt-${missingPart}`, view: { state: {}, turns: turns(45) } };
        turnHeights.set("turn-5", 2000); // An expanded long prompt.
        dispose = mount(promptSession);
        scroll(1250); // Read deep inside turn 5, beyond its eventual clamped height.
        const firstVisible = () => all(root).find((n) => n.props["data-turn"] && (n as any).getBoundingClientRect().bottom > 0)?.props["data-turn"];
        assert.equal(firstVisible(), "turn-5");
        dispose(); dispose = mount(b);
        assert.equal(cache.get(promptSession.id)?.anchor?.part, "prompt");
        turnHeights.set("turn-5", 200); // UserPrompt reclamps on remount.
        omitPromptPart = missingPart; // Also cover fallback to a shortened turn.
        dispose(); dispose = mount(promptSession);
        assert.equal(firstVisible(), "turn-5", "a shortened anchor must not restore several turns past the prompt");
        resize(); scroller().props.onScroll();
        assert.equal(firstVisible(), "turn-5", "resize and scroll must not re-anchor on a later turn");
        dispose(); dispose = mount(b);
        assert.equal(cache.get(promptSession.id)?.anchor?.turnId, "turn-5", "the corrected anchor survives another switch");
        omitPromptPart = false;
        turnHeights.clear();
    }

    // The composer dock's height (SessionView's dock prop) is set on the two boxes that keep room for it, and find
    // keeps a match above it: --dock-h isn't inherited, and WebKit keeps an inherited one stale.
    dispose();
    const [dockH, setDockH] = solid.createSignal<number | undefined>(244);
    top = 0; root = node("root");
    dispose = renderer.render(() => Transcript({ handle: a, get dock() { return dockH(); } }), root); flush();
    scroll(0); setFindShown(true);
    const box = (cls: string) => all(root).find((n) => has(n, cls))!;
    const dockOf = (n: Node) => n.props.style?.["--dock-h"];
    assert.equal(dockOf(box("transcript-end")), "244px", "the transcript's end has the dock's height");
    assert.equal(dockOf(box("jump")), "244px", "the Latest pill has the dock's height");
    assert.equal(findProps?.dock(), 244, "find keeps a match above the dock");
    setDockH(300);
    assert.equal(dockOf(box("transcript-end")), "300px", "the end follows the dock as it grows");
    assert.equal(findProps.dock(), 300, "find follows the dock as it grows");
    setDockH(undefined);
    assert.equal(dockOf(box("transcript-end")), undefined, "unmeasured, the end has --dock-h's initial value");
    setFindShown(false);
} finally { dispose(); }
