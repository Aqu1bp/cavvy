import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, type Node } from "../helpers/gui-render";
import { anchoredTop, atBottom, FAR, firstBelow, restoredShown, positionCache, TURN_PAGE } from "../../gui/src/lib/transcript-scroll";
import { GLIDE_MAX, glideFrom, heldTurns, liveLine, specialActivity } from "../../gui/src/lib/live-line";

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
/** The column's MutationObserver: mutate() is its content changing, now. */
const mutations = new Set<() => void>();
const mutate = () => mutations.forEach((fn) => fn());
/** Window listeners (a pointer's lift); pointerUp() lifts it. */
const lifts = new Map<string, Set<() => void>>();
const pointerUp = () => [...(lifts.get("pointerup") ?? [])].forEach((fn) => fn());
let restoredOpen = false;
let root = node("root");
let top = 0;
let scrollWrites = 0;
let viewportHeight = 500;
let deferSmooth = false;
let partShift = 30;
const turnHeights = new Map<string, number>();
/** A far turn (data-far) keeps the size it was skipped at, if one is set here, whatever it would be drawn at now. */
const skippedAt = new Map<string, number>();
let omitPromptPart = false;
/** The composer told the conversation its next change of the dock's height is it opening or closing its large size. */
let dockGlide = false;
/** Some streamed text is still coming out (lib/reveal.ts revealing()). */
let revealingNow = false;
const has = (n: Node, cls: string) => n.props.class?.split(" ").includes(cls);
const height = (n: Node): number => n.props["data-turn"] ? (n.props["data-far"] !== undefined ? skippedAt.get(n.props["data-turn"]) : undefined) ?? turnHeights.get(n.props["data-turn"]) ?? 200 : has(n, "earlier") ? 50 : has(n, "transcript-end") ? (n.props.style?.["--dock-h"] ? parseFloat(n.props.style["--dock-h"]) + 28 : 500) : n.children.reduce((sum, child) => sum + height(child), 0);
/** Where a running glide draws a row of the column (and what's in it): shiftNow down, if it's one the glide moves. */
const drawn = (n: Node): number => {
    for (let x: Node | undefined = n; x && !has(x, "transcript-col"); x = x.parent) if (glides.some((g) => g.el === x && g.anim.playState === "running")) return shiftNow;
    return 0;
};
const absolute = (n: Node): number => {
    if (!n.parent || has(n, "transcript-col")) return 0;
    return absolute(n.parent) + n.parent.children.slice(0, n.parent.children.indexOf(n)).reduce((sum, child) => sum + height(child), 0);
};
const matches = (n: Node, selector: string) => selector.split(", ").some((s) => {
    if (s.startsWith(".")) return has(n, s.slice(1));
    const match = s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    return !!match && n.props[match[1]!] !== undefined && (match[2] === undefined || n.props[match[1]!] === match[2]);
});
/** The glides (Transcript.tsx pin), one per row moved: where each starts, and the translate a running one is at now. */
const glides: { el: Node; from: number; duration: number; anim: { playState: string; cancel(): void } }[] = [];
/** The far-turn observer (Transcript.tsx): what it watches, how, and its callback (report() says what's near). */
const io = { targets: new Set<Node>(), options: undefined as any, cb: undefined as undefined | ((entries: any[]) => void) };
let shiftNow = 0;
/** The conversation's moves while the panels slide (Transcript.tsx hold): what each translates from, and its timing. */
const slides: { from: string; options: { duration: number; easing?: string }; anim: { playState: string; startTime?: number } }[] = [];
/** How many times a turn's box was measured, and the column searched for a turn by id. */
let turnRects = 0;
let turnSearches = 0;
const decorate = (n: Node): any => Object.assign(n, {
    animate: (keyframes: { transform: string }[], options: { duration: number; easing?: string }) => {
        const anim = { playState: "running", startTime: undefined as number | undefined, cancel() { anim.playState = "idle"; } };
        if (keyframes[0]!.transform.startsWith("translate(")) {
            slides.push({ from: keyframes[0]!.transform, options, anim });
            return anim;
        }
        glides.push({ el: n, from: Number(/translateY\((-?[\d.]+)px\)/.exec(keyframes[0]!.transform)?.[1]), duration: options.duration, anim });
        return anim;
    },
    getBoundingClientRect: () => (n.props["data-turn"] && turnRects++, { top: has(n, "transcript") ? 0 : absolute(n) - top + drawn(n), bottom: absolute(n) - top + drawn(n) + height(n), height: height(n) }),
    querySelectorAll: (selector: string) => all(n).slice(1).filter((child) => matches(child, selector)),
    querySelector: (selector: string) => (selector.startsWith("[data-turn") && turnSearches++, all(n).slice(1).find((child) => matches(child, selector))),
    scrollTo: (options: any) => { scrollBehavior = options.behavior; scrollTarget = Math.max(0, Math.min(options.top, height(n) - viewportHeight)); if (!deferSmooth || options.behavior !== "smooth") (n as any).scrollTop = options.top; },
    classList: { add() {}, remove() {}, contains: (cls: string) => has(n, cls) },
    hasAttribute: (name: string) => n.props[name] !== undefined,
    /** Its listeners (the capture phase's included), by type: listeners.click(event) dispatches one. */
    listeners: {} as Record<string, (e: any) => void>,
    addEventListener: (type: string, fn: (e: any) => void) => { (n as any).listeners[type] = fn; },
    removeEventListener: (type: string) => { delete (n as any).listeners[type]; },
    removeAttribute: (name: string) => { delete n.props[name]; },
    toggleAttribute: (name: string, force: boolean) => { if (force) n.props[name] = ""; else delete n.props[name]; return force; },
});
const elements = (n?: Node) => (n?.children ?? []).filter((c) => c.tag !== "#text");
const create = (tag: string): any => {
    const n = decorate(renderer.createElement(tag));
    Object.defineProperties(n, {
        dataset: { get: () => ({ turn: n.props["data-turn"], find: n.props["data-find"] }) },
        scrollTop: { get: () => top, set: (value) => { scrollWrites++; top = Math.max(0, Math.min(value, height(n) - viewportHeight)); } },
        scrollHeight: { get: () => height(n) }, clientHeight: { get: () => viewportHeight },
        lastElementChild: { get: () => elements(n).at(-1) ?? null },
        parentElement: { get: () => n.parent ?? null },
        isConnected: { get: () => { let x: Node = n; while (x.parent) x = x.parent; return x === root; } },
        previousElementSibling: { get: () => { const s = elements(n.parent); return s[s.indexOf(n) - 1] ?? null; } },
    });
    return n;
};
const [jump, setJump] = solid.createSignal<any>();
const [findShown, setFindShown] = solid.createSignal(false);
const [panelHold, setPanelHold] = solid.createSignal<any>();
let findProps: any;
/** Each turn's work-log toggle (TurnView's onToggleWork), by turn id. */
const workToggles = new Map<string, (el: any, toggle: () => void) => void>();
/** Each turn's onFold (TurnView calls it as its work, faded out, folds away). */
const onFolds = new Map<string, (el: any, fold: () => void) => void>();
const scope = {
    renderer: { ...solid, ...renderer, createElement: create },
    anchoredTop, atBottom, FAR, firstBelow, restoredShown, transcriptPositions: cache, PAGE: TURN_PAGE, prefs, GLIDE_MAX, glideFrom, heldTurns, liveLine, specialActivity, revealing: () => revealingNow,
    LiveLine: () => node("live-line"), Spinner: () => node("spinner"),
    getComputedStyle: (el?: any) => ({ transform: `matrix(1, 0, 0, 1, 0, ${shiftNow})`, overflowY: el?.overflowY ?? "visible" }),
    DOMMatrixReadOnly: class { m42: number; constructor(m: string) { this.m42 = Number(/, (-?[\d.]+)\)$/.exec(m)?.[1] ?? 0); } },
    motionMs: (ms: number) => (reduced || prefs.motion === "instant" ? 0 : ms),
    requestAnimationFrame: raf, cancelAnimationFrame: (id: number) => frames.delete(id),
    performance: { now: () => clock },
    MutationObserver: class {
        constructor(private cb: () => void) {}
        observe() { mutations.add(this.cb); }
        disconnect() { mutations.delete(this.cb); }
    },
    addEventListener: (type: string, fn: () => void) => { if (!lifts.has(type)) lifts.set(type, new Set()); lifts.get(type)!.add(fn); },
    removeEventListener: (type: string, fn: () => void) => lifts.get(type)?.delete(fn),
    IntersectionObserver: class {
        constructor(cb: (entries: any[]) => void, options: any) { io.cb = cb; io.options = options; }
        observe(target: Node) { io.targets.add(target); }
        unobserve(target: Node) { io.targets.delete(target); }
        // Its callback stays with it, as in WebKit, where an observer with a root outlives disconnect().
        disconnect() { io.targets.clear(); }
    },
    ResizeObserver: class {
        constructor(private cb: () => void) {}
        observe(target: Node) { if (!observers.has(this.cb)) observers.set(this.cb, new Set()); observers.get(this.cb)!.add(target); }
        disconnect() { observers.delete(this.cb); }
    },
    matchMedia: () => ({ matches: reduced }), CSS: { escape: (s: string) => s },
    jumpTarget: jump, setJumpTarget: setJump, findOpen: findShown, panelHold,
    takeDockGlide: () => { const glides = dockGlide; dockGlide = false; return glides; }, GROW_MS: 240, GROW_EASE: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    openFind() {}, setFindQuery() {}, toast() { throw new Error("unexpected toast"); },
    turnAt: (turns: any[], _seg: number, index: number) => turns[index], BAR_ROOM: 48,
    rewindTarget: { set() {} }, setRewindOpen() {}, ArrowDown: () => node("icon"), FindBar: (p: any) => { findProps = p; return node("find"); }, CardFoldsProvider: (p: any) => p.children,
    setTimeout() {},
    TurnView: (p: any) => {
        restoredOpen ||= p.workOpen;
        workToggles.set(p.turn.id, p.onToggleWork);
        const n = create("article"); n.props["data-turn"] = p.turn.id;
        p.onElement?.(n, p.turn.id);
        onFolds.set(p.turn.id, p.onFold);
        if (omitPromptPart && p.turn.id === "turn-5") return n;
        const part = create("div"); part.props["data-find"] = "prompt";
        part.getBoundingClientRect = () => ({ top: absolute(n) - top + drawn(n) + partShift, bottom: absolute(n) - top + drawn(n) + height(n), height: height(n) - partShift });
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
/** The reader scrolling (well after any write of ours: Transcript.tsx's ENGINE_MS). */
const scroll = (value: number) => { clock += 1000; (scroller() as any).scrollTop = value; scroller().props.onScroll(); };
/** The engine moving the scroll position at once, as WebKit does undoing a write of ours. */
const engineScroll = (value: number) => { (scroller() as any).scrollTop = value; scroller().props.onScroll(); };
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
        // A wheel or keys toward the end interrupt the jump too; up is a scroll away (checked with the glide below).
        scroller().props[input](input === "onWheel" ? { deltaY: 3 } : input === "onKeyDown" ? { key: "ArrowDown" } : undefined);
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
    assert.equal(top, 8050, "a session left at bottom follows new turns on return");
    assert.equal(all(root).filter((n) => n.tag === "article").length, 40, "showing its last page again, not all 120 it had shown");
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
    // While a turn runs, growth at the end is written once, in the next frame, and the column glides in from where it was.
    const live = { id: "live", view: { state: {}, turns: turns(45).map((t, i) => ({ ...t, status: i === 44 ? "running" : "done" })) } };
    dispose = mount(live);
    const bottom = () => height(scroller()) - viewportHeight;
    assert.equal(top, bottom(), "a running turn starts followed");
    const start = top;
    turnHeights.set("turn-44", 420); resize();
    assert.equal(top, start, "nothing is written until the next frame");
    let glideWrites = scrollWrites;
    flush();
    assert.equal(top, bottom(), "growth is at the end in one frame");
    assert.equal(scrollWrites, glideWrites + 1, "with one scrollTop write");
    // In sight: the end's room and the last turn (the one before is 420px above the view, more than the glide's 220).
    assert.deepEqual(glides.map((g) => g.el), [button("transcript-end"), turn("turn-44")], "and one glide, of only the rows in sight");
    assert.ok(!glides.some((g) => has(g.el, "transcript-col")), "not of the whole column: its cost doesn't grow with the conversation");
    assert.deepEqual(glides.map((g) => [g.from, g.duration]), [[220, 240], [220, 240]], "from where they were drawn, in 240ms");
    const first = glides.length;
    scroller().props.onScroll(); // Our own write's scroll event.
    assert.equal(button("jump"), undefined, "our own write keeps it pinned");
    // More growth while that glide runs: one motion, picked up where it is (drawn 100px down by now).
    shiftNow = 100;
    turnHeights.set("turn-44", 460); resize(); flush();
    assert.ok(glides.slice(0, first).every((g) => g.anim.playState === "idle"), "the running glide gives way");
    assert.equal(glides.at(-1)!.from, 140, "the next starts from where the last one was, plus the growth");
    shiftNow = 0; glides.forEach((g) => g.anim.cancel());
    scroller().props.onScroll();
    // A big jump starts no farther than 240px off.
    turnHeights.set("turn-44", 1460); resize(); flush();
    assert.equal(top, bottom());
    assert.equal(glides.at(-1)!.from, 240, "a glide never covers more than 240px");
    glides.forEach((g) => g.anim.cancel());
    scroller().props.onScroll();
    // Nothing to do: no write, no glide.
    glideWrites = scrollWrites;
    const count = glides.length;
    resize(); flush();
    assert.deepEqual([scrollWrites, glides.length], [glideWrites, count], "unchanged, nothing is written and nothing glides");
    // Scrolled away while a glide runs (Home, the scrollbar): the turn read there isn't gliding, so where it's
    // drawn is where it is, and when the glide ends nothing moves.
    turnHeights.set("turn-44", 1700); resize(); flush();
    assert.equal(glides.at(-1)!.anim.playState, "running");
    shiftNow = 100;
    scroller().props.onKeyDown({ key: "Home" });
    scroll(0);
    shiftNow = 0; glides.forEach((g) => g.anim.cancel());
    resize();
    assert.equal(top, 0, "a reading taken away from a running glide doesn't move when it ends");
    // And read within the glide's rows, its translate isn't taken for the reader's place.
    scroll(bottom()); resize(); flush(); scroller().props.onScroll();
    turnHeights.set("turn-44", 1800); resize(); flush();
    shiftNow = 60;
    scroller().props.onWheel({ deltaY: -3, deltaX: 0 });
    scroll(bottom() - 300);
    const gliding = turn("turn-44").getBoundingClientRect().top;
    shiftNow = 0; glides.forEach((g) => g.anim.cancel());
    resize();
    assert.equal(turn("turn-44").getBoundingClientRect().top, gliding - 60, "a turn read mid-glide stays where it is once the glide ends");
    scroll(bottom()); scroller().props.onScroll();
    // The reader scrolling up, however little, unpins it at once; growth below then leaves them where they are.
    scroller().props.onWheel({ deltaY: -3, deltaX: 0 });
    assert.equal(button("jump"), undefined, "all the way down still (its scroll is yet to come), there's no Latest to jump to");
    const away = top;
    turnHeights.set("turn-44", 1600); resize(); flush();
    assert.equal(top, away, "growth doesn't pull an unpinned reader down");
    turnHeights.set("turn-44", 2000); resize(); flush();
    assert.equal(top, away);
    assert.ok(button("jump"), "a scroll up, however small, unpinned it: the end grew out of view, and Latest shows");
    // A scroll up by the scrollbar or keys (no wheel): unpinned too, even within the 64px of the end.
    scroll(bottom()); assert.equal(button("jump"), undefined, "back at the end, it follows again");
    scroll(bottom() - 20);
    assert.ok(button("jump"), "a scroll away from the end unpins it, however near");
    scroll(bottom() - 10);
    assert.equal(button("jump"), undefined, "moving back down near the end pins it again");
    // Content shrinking above (a fold) pulls the scroll position up without unpinning it.
    scroll(bottom());
    turnHeights.set("turn-44", 900);
    scroll(bottom());
    assert.equal(button("jump"), undefined, "a shrink at the end isn't the reader scrolling away");
    // WebKit, mid-update: the column shorter for a moment clamps the position up, then it grows back a little.
    // The scroll event comes with the new size: the layout's doing, not the reader's, so it stays pinned.
    turnHeights.set("turn-44", 880);
    scroll(bottom() - 40);
    assert.equal(button("jump"), undefined, "a scroll up that comes with a change of size keeps it pinned");
    resize(); flush();
    assert.equal(top, bottom(), "and the next frame puts it back at the end");
    scroller().props.onScroll();
    // WebKit, just after our write: the position put back where it was (clamped to the column's old size), at
    // the same size. Not the reader: it's written again at once, before it's drawn there.
    clock += 1000;
    const beforeGrowth = top;
    turnHeights.set("turn-44", 960); resize(); flush();
    assert.equal(top, bottom());
    const rewrites = scrollWrites;
    engineScroll(beforeGrowth);
    assert.equal(button("jump"), undefined, "an engine's undoing of our write keeps it pinned");
    assert.equal(top, bottom(), "and it's back at the end at once");
    assert.equal(scrollWrites, rewrites + 2, "with one write (besides the engine's own)");
    scroller().props.onScroll();
    // Just after the content changed, at the same size (a row replaced by one as tall): the layout's too.
    clock += 1000;
    mutate();
    engineScroll(bottom() - 61);
    assert.equal(button("jump"), undefined, "a scroll up just after the content changed keeps it pinned");
    assert.equal(top, bottom(), "and it's back at the end at once");
    scroller().props.onScroll();
    // The engine's come one or two at a time (WebKit at a turn's end: two, 50ms apart).
    clock += 50; mutate();
    engineScroll(bottom() - 61);
    assert.equal(button("jump"), undefined, "a second straight after is still the engine's");
    scroller().props.onScroll();
    // A third in a row is the reader dragging the scrollbar (were its pointer not seen).
    clock += 16; mutate();
    engineScroll(bottom() - 80);
    assert.ok(button("jump"), "a run of scrolls up is the reader's");
    scroll(bottom()); assert.equal(button("jump"), undefined);
    // The same move well after any write of ours is the reader's.
    scroll(bottom() - 30);
    assert.ok(button("jump"), "later, a scroll up at the same size is the reader's");
    scroll(bottom()); assert.equal(button("jump"), undefined);
    // But the reader dragging the scrollbar up while it grows: theirs, so it unpins.
    scroller().props.onPointerDown();
    turnHeights.set("turn-44", 920);
    scroll(bottom() - 200);
    assert.ok(button("jump"), "a scroll up with a pointer down unpins it, growing or not");
    pointerUp();
    scroll(bottom()); assert.equal(button("jump"), undefined);
    // Latest goes by what's in view (#348): all the way down there's nothing to jump to, whatever stopped the following.
    // A sideways swipe (a wide code block) with a hair of upward deltaY isn't a scroll up: it keeps following.
    scroller().props.onWheel({ deltaY: -0.5, deltaX: 30 });
    turnHeights.set("turn-44", 940); resize(); flush();
    assert.equal(top, bottom(), "a sideways swipe doesn't stop following the end");
    scroller().props.onScroll();
    // Stopped following with nothing scrolled (a key the page didn't scroll for): still all the way down, no Latest.
    scroller().props.onKeyDown({ key: "ArrowUp" });
    assert.equal(button("jump"), undefined, "no Latest while scrolled all the way down");
    // The reader pushing on down at the end, where nothing scrolls and no scroll event comes: it follows the end again.
    scroller().props.onWheel({ deltaY: 4, deltaX: 0 });
    turnHeights.set("turn-44", 980); resize(); flush();
    assert.equal(top, bottom(), "a wheel down at the end follows the end again");
    scroller().props.onScroll();
    // A work log opened and shut at the end (it stops following, so the open log isn't scrolled away): no Latest.
    workToggles.get("turn-44")!(turn("turn-44"), () => {});
    assert.equal(button("jump"), undefined, "a work log toggled at the end leaves no Latest there");
    // Then the end grows out of view below the reader (streaming, the dock growing, a resize): Latest shows.
    turnHeights.set("turn-44", 1100); resize(); flush();
    assert.ok(button("jump"), "the end out of view shows Latest");
    viewportHeight = 380; resize(scroller());
    assert.ok(button("jump"), "and still after a resize that leaves it out of view");
    scroll(bottom()); assert.equal(button("jump"), undefined);
    viewportHeight = 500; resize(scroller()); flush(); scroller().props.onScroll();
    // A move down inside a box in the conversation (a command's long output, read after following stopped) is the
    // box's while it can still go down: the conversation doesn't follow the end again, so what's read there stays put.
    scroller().props.onKeyDown({ key: "ArrowUp" });
    const output = { tagName: "PRE", overflowY: "auto", scrollHeight: 600, clientHeight: 200, scrollTop: 0, parentElement: turn("turn-44") };
    scroller().props.onWheel({ deltaY: 4, deltaX: 0, target: output });
    const reading44 = top;
    turnHeights.set("turn-44", 1200); resize(); flush();
    assert.equal(top, reading44, "a wheel down taken by a box inside doesn't follow the end again");
    scroll(bottom()); scroller().props.onKeyDown({ key: "ArrowUp" });
    // Keys typed into a field in the conversation aren't the conversation's either.
    scroller().props.onKeyDown({ key: "ArrowDown", target: { tagName: "TEXTAREA", parentElement: turn("turn-44") } });
    turnHeights.set("turn-44", 1250); resize(); flush();
    assert.ok(top < bottom(), "an arrow key in a field doesn't follow the end again");
    // At the box's own end the move goes on to the conversation, which is at its end: it follows again.
    scroll(bottom()); scroller().props.onKeyDown({ key: "ArrowUp" });
    output.scrollTop = 400;
    scroller().props.onWheel({ deltaY: 4, deltaX: 0, target: output });
    turnHeights.set("turn-44", 1300); resize(); flush();
    assert.equal(top, bottom(), "a box at its end passes the move on: following the end again");
    scroller().props.onScroll();
    // The reader opening a row (a command's, a tool's) as it runs: it stays where it was clicked, nothing glides,
    // and the end isn't followed (they're reading it). Growth below then leaves it where it is.
    const toggle = turn("turn-44").children[0];
    toggle.props["aria-expanded"] = false;
    toggle.closest = (selector: string) => (selector.includes("aria-expanded") ? toggle : null);
    const click = { type: "click", target: toggle };
    const rowTop = toggle.getBoundingClientRect().top;
    const glidesThen = glides.length;
    scroller().listeners.click?.(click); // As the click starts (the capture phase).
    turnHeights.set("turn-44", 1400); // The row's own handler opened it.
    scroller().props.onClick?.(click); // And then it reaches the scroller.
    assert.equal(toggle.getBoundingClientRect().top, rowTop, "a row opened while it runs stays where it was clicked");
    assert.ok(button("jump"), "the end isn't followed while the reader reads what they opened");
    resize(); flush();
    assert.equal(glides.length, glidesThen, "opening a row doesn't glide");
    assert.equal(toggle.getBoundingClientRect().top, rowTop, "nor move it the frame after");
    turnHeights.set("turn-44", 1500); resize(); flush();
    assert.equal(toggle.getBoundingClientRect().top, rowTop, "growth below leaves the opened row where it is");
    // Enter on a button comes as a click: its keydown is let be. A row that's not a button (a command's) toggles on it.
    scroller().listeners.keydown?.({ type: "keydown", key: "Enter", target: { ...toggle, tagName: "BUTTON", closest: toggle.closest } });
    scroller().props.onKeyDown({ key: "Enter" });
    assert.equal(toggle.getBoundingClientRect().top, rowTop);
    scroll(bottom()); assert.equal(button("jump"), undefined);
    const glidesBefore = glides.length;
    reduced = true; turnHeights.set("turn-44", 1000); resize(); flush();
    assert.equal(top, bottom(), "reduced motion follows");
    assert.equal(glides.length, glidesBefore, "without a glide");
    reduced = false; live.view.turns[44]!.status = "done"; turnHeights.set("turn-44", 1100); resize();
    assert.equal(top, bottom(), "the end of a turn lands at once");
    assert.equal(glides.length, glidesBefore, "a turn's end (its work folding away) doesn't glide");
    // But the reply's last words, still coming out (lib/reveal.ts), glide in as the rest of it did.
    revealingNow = true; turnHeights.set("turn-44", 1160); resize(); flush();
    assert.equal(top, bottom(), "at the end");
    assert.deepEqual(glides.slice(glidesBefore).map((g) => g.from), [60, 60], "a reply still coming out glides to its end");
    revealingNow = false; glides.forEach((g) => g.anim.cancel());
    // The work folding into "Worked for" (TurnView's onFold): following the end, the answer stays put and what's above
    // it (the turns before, the turn's prompt) comes down by what folded away, gliding from where it was.
    viewportHeight = 1400; resize(); flush(); scroller().props.onScroll();
    const folded = turn("turn-44");
    const promptWas = folded.children[0].getBoundingClientRect().top;
    const beforeFold = glides.length;
    let ran = false;
    onFolds.get("turn-44")!(folded, () => { ran = true; turnHeights.set("turn-44", 760); });
    assert.ok(ran);
    assert.equal(top, bottom(), "at the end at once, the answer where it was");
    const foldMoves = glides.slice(beforeFold);
    assert.deepEqual(foldMoves.map((g) => g.el), [turn("turn-43"), turn("turn-42"), turn("turn-41"), folded.children[0]], "the turns above in reach and the prompt; not the turn (its answer) or the end's room");
    assert.ok(foldMoves.every((g) => g.from === -400 && g.duration === 240), "each drawn 400px up, where it was, and gliding down");
    assert.equal(folded.children[0].getBoundingClientRect().top - 400, promptWas, "the prompt drawn where it was");
    glides.forEach((g) => g.anim.cancel());
    // A fold bigger than the screen moves a screen; with reduced motion it just folds.
    turnHeights.set("turn-44", 3400); resize(); flush(); glides.forEach((g) => g.anim.cancel()); scroller().props.onScroll();
    const beforeBig = glides.length;
    onFolds.get("turn-44")!(folded, () => turnHeights.set("turn-44", 300));
    assert.ok(glides.length > beforeBig && glides.slice(beforeBig).every((g) => g.from === -1400), "no farther than a screen");
    glides.forEach((g) => g.anim.cancel());
    reduced = true;
    const beforeReduced = glides.length;
    onFolds.get("turn-44")!(folded, () => turnHeights.set("turn-44", 200));
    resize();
    assert.equal(top, bottom(), "folded at the end");
    assert.equal(glides.length, beforeReduced, "reduced motion: no glide");
    reduced = false;
    // A jump down ("Latest") near the end while a turn grows hands over to the glide: scrolling smoothly again on
    // each growth restarts the scroll every time, and never arrives while the reply streams.
    viewportHeight = 500; live.view.turns[44]!.status = "running"; turnHeights.set("turn-44", 1200); resize(); flush();
    scroller().props.onWheel({ deltaY: -100 }); scroll(bottom() - 1500);
    deferSmooth = true;
    button("jump").props.onClick();
    assert.equal(scrollBehavior, "smooth");
    scroll(bottom() - 120); // The smooth scroll, most of the way there.
    const beforeHandoff = glides.length;
    turnHeights.set("turn-44", 1240); resize(); flush();
    assert.equal(top, bottom(), "the rest of the way at once, in the next frame");
    assert.equal(glides.at(-1)?.from, 160, "drawn where it was, gliding the rest");
    assert.ok(glides.length > beforeHandoff);
    turnHeights.set("turn-44", 1280); resize(); flush();
    assert.equal(top, bottom(), "and growth after it glides as it does when following");
    deferSmooth = false; glides.forEach((g) => g.anim.cancel()); live.view.turns[44]!.status = "done";
    turnHeights.clear(); dispose();
    // A short conversation, all of it in view, still running: a row opened makes it overflow (the end isn't
    // followed while it's read); folded again, it all fits, and no scroll event can come to say the end is in
    // view. It follows the end again, as a scroll there would, and later growth is followed.
    viewportHeight = 2000;
    const short = { id: "short", view: { state: {}, turns: turns(2).map((t, i) => ({ ...t, status: i === 1 ? "running" : "done" })) } };
    dispose = mount(short);
    assert.equal(top, 0, "a short conversation fits");
    const fold = turn("turn-1").children[0];
    fold.props["aria-expanded"] = false;
    fold.closest = (selector: string) => (selector.includes("aria-expanded") ? fold : null);
    const press = (height: number) => {
        scroller().listeners.click?.({ type: "click", target: fold });
        turnHeights.set("turn-1", height);
        scroller().props.onClick?.({ type: "click", target: fold });
        resize(); flush();
    };
    press(1800);
    assert.ok(button("jump"), "opened past the view's end: not followed");
    press(200);
    assert.equal(button("jump"), undefined, "folded back with the end in view: followed again");
    turnHeights.set("turn-1", 2400); resize(); flush();
    assert.equal(top, height(scroller()) - viewportHeight, "later growth is followed");
    // The same with no toggle of ours: the column shrinking (anything folding) until it all fits.
    scroll(0);
    scroller().props.onWheel({ deltaY: -3 });
    assert.ok(button("jump"));
    turnHeights.set("turn-1", 300); resize(); flush();
    assert.equal(button("jump"), undefined, "with nothing left to scroll, the end is followed");
    viewportHeight = 500;
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

    // A turn far from the view skips its layout (transcript.css): drawn once first, it's marked far when the
    // observer says so, and when it comes near again any difference in its size above the view is the scroll's.
    dispose();
    const [farTurns, setFarTurns] = solid.createSignal(turns(90));
    const long = { id: "far", view: { state: {}, get turns() { return farTurns(); } } };
    dispose = mount(long);
    const articles = () => all(root).filter((n) => n.tag === "article");
    const report = (ids: string[], near: boolean) => io.cb!(ids.map((id) => ({ target: turn(id), isIntersecting: near })));
    assert.equal(io.targets.size, 40, "each turn drawn is watched");
    assert.deepEqual(io.options, { root: scroller(), rootMargin: "100% 0px" }, "for whether it's within a screen of the view");
    scroll(0);
    button("earlier").props.onClick();
    assert.equal(io.targets.size, 80, "a page shown earlier is watched too");
    assert.ok(articles().every((n) => n.props[FAR] === undefined), "and drawn before any of it is skipped");
    // turn-50 is at the top of the view; turn-10 to turn-45 are more than a screen above it.
    report(Array.from({ length: 36 }, (_, i) => `turn-${10 + i}`), false);
    assert.equal(articles().filter((n) => n.props[FAR] !== undefined).length, 36, "those far from the view are marked far");
    // turn-45, skipped at 200px, is drawn at 320 when it comes near: what's in view doesn't move.
    skippedAt.set("turn-45", 200); turnHeights.set("turn-45", 320);
    const reading = turn("turn-50").getBoundingClientRect().top;
    report(["turn-45"], true);
    assert.equal(turn("turn-45").props[FAR], undefined, "one near again is drawn");
    assert.equal(turn("turn-50").getBoundingClientRect().top, reading, "a turn drawn above the view at another size doesn't move what's in view");
    // Below the view, it moves nothing in view: nothing is written.
    report(["turn-60"], false); skippedAt.set("turn-60", 200); turnHeights.set("turn-60", 320);
    const belowWrites = scrollWrites;
    report(["turn-60"], true);
    assert.equal(scrollWrites, belowWrites, "a turn drawn below the view at another size writes nothing");
    const removed = turn("turn-89");
    setFarTurns(farTurns().slice(0, 89));
    assert.ok(!io.targets.has(removed) && io.targets.has(turn("turn-9")), "a turn removed is no longer watched (and one paged in is)");
    skippedAt.clear(); turnHeights.clear();
    dispose();
    assert.equal(io.targets.size, 0, "nor is any once the conversation is closed");
    const stray = create("article");
    io.cb!([{ target: stray, isIntersecting: false }]);
    assert.equal(stray.props[FAR], undefined, "and the observer's callback, which may outlive it, no longer reaches the conversation");

    // A long conversation, all shown: a scroll event measures a few turns to find where it's read (they're in order),
    // following the end it measures none, and an anchor is found by its id, not by searching the column.
    const [manyTurns] = solid.createSignal(turns(400));
    const many = { id: "many", view: { state: {}, get turns() { return manyTurns(); } } };
    dispose = mount(many);
    turnRects = 0; scroller().props.onScroll();
    assert.equal(turnRects, 0, "following the end, a scroll measures no turn");
    scroll(0);
    for (let i = 0; i < 9; i++) { scroll(0); button("earlier").props.onClick(); }
    assert.equal(articles().length, 400);
    turnRects = 0; scroll(60000);
    assert.equal(turn("turn-300").getBoundingClientRect().top, 0, "read from turn-300");
    assert.ok(turnRects <= 12, `a scroll measures a few of the 400 turns, not each one before where it's read (${turnRects})`);
    turnSearches = 0; partShift += 12; resize(); partShift -= 12; resize();
    assert.equal(turnSearches, 0, "the anchor is found by its id");
    // Opened again, it shows the pages down from where it was read, not all it had shown...
    dispose(); dispose = mount(b);
    dispose(); dispose = mount(many);
    assert.equal(articles().length, 120, "reopened, it shows the pages down from where it was read");
    assert.equal(turn("turn-300").getBoundingClientRect().top, 0, "at the same place");
    // ...and left at the end, only its last page.
    button("jump").props.onClick(); scroller().props.onScroll();
    dispose(); dispose = mount(b);
    dispose(); dispose = mount(many);
    assert.equal(articles().length, 40, "reopened after being left at the end, it shows its last page");
    dispose();

    // A conversation that fits (nothing to scroll): a wheel up there scrolls nothing, so it stops nothing, and the
    // reply growing past the view is followed.
    turnHeights.set("turn-0", 0);
    dispose = mount({ id: "fits", view: { state: {}, turns: [{ id: "turn-0", prompt: { text: "hi" }, status: "running" }] } });
    assert.equal(top, 0);
    scroller().props.onWheel({ deltaY: -3, deltaX: 0 });
    turnHeights.set("turn-0", 900); resize(); flush();
    assert.equal(top, height(scroller()) - viewportHeight, "a wheel up where nothing scrolls doesn't stop following");
    assert.equal(button("jump"), undefined);
    turnHeights.clear(); dispose();

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

    // The composer opening or closing its large size (Composer.tsx glideDock): following the end, the end stays just
    // above it, the rows in sight drawn from where they were and gliding with the composer's edge, in its time. Any
    // other change of the dock's height lands as before, without a glide.
    dispose();
    {
    const [dockG, setDockG] = solid.createSignal<number | undefined>(200);
    const short = { id: "dock-glide", view: { state: {}, turns: turns(3) } };
    top = 0; root = node("root");
    dispose = renderer.render(() => Transcript({ handle: short, get dock() { return dockG(); } }), root); flush();
    const end = () => (scroller() as any).scrollHeight - viewportHeight;
    assert.equal(top, end(), "following the end");
    let before = glides.length;
    dockGlide = true; setDockG(500);
    assert.equal(top, end(), "opened: still at the end, at once");
    let moved = glides.slice(before);
    assert.ok(moved.length > 0, "the rows in sight glide");
    assert.ok(moved.every((g) => g.from === 300 && g.duration === 240), "up from where they were, as far as the composer grew, in its time");
    assert.ok(!moved.some((g) => has(g.el, "transcript-col")), "not the whole column");
    moved.forEach((g) => g.anim.cancel());
    before = glides.length;
    dockGlide = true; setDockG(200);
    assert.equal(top, end(), "closed: still at the end");
    moved = glides.slice(before);
    assert.ok(moved.length > 0 && moved.every((g) => g.from === -300), "down from where they were");
    moved.forEach((g) => g.anim.cancel());
    before = glides.length;
    setDockG(222);
    resize();
    assert.equal(glides.length, before, "a line wrapping in the composer doesn't glide");
    assert.equal(top, end(), "it lands at the end at once");
    scroll(0);
    before = glides.length;
    dockGlide = true; setDockG(500);
    assert.equal(glides.length, before, "scrolled up, nothing moves");
    assert.equal(top, 0);
    }

    // While the panels slide open or shut (App.tsx), the conversation keeps one size, placed where it ends up and
    // drawn from where it was by a translate in step with the slide: laid out as the slide starts and as it ends,
    // and on the frames between only the compositor moves it. Its box sizes with properties that don't inherit.
    dispose(); dispose = mount(a);
    const hold = () => all(root).find((n) => has(n, "transcript-hold"))!;
    assert.equal(scroller().parent, hold(), "the scroller is in the box that holds its size");
    assert.equal(hold().props.style, undefined, "at rest the box fills the column");
    const slide = { effect: { getTiming: () => ({ duration: 160, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }) }, ready: Promise.resolve(), startTime: 1234 };
    // The inspector opening: 1092px of column to 732.
    setPanelHold({ column: { w: 732, h: 864 }, from: { w: 1092, h: 864 }, to: { w: 732, h: 864 }, sheetWidth: 1092, terminal: 0, slide });
    assert.deepEqual(hold().props.style, { width: "732px", height: "864px", top: "0px" }, "held at the width it ends at");
    assert.equal(slides.length, 1, "one move for the whole slide");
    assert.deepEqual({ from: slides[0]!.from, ...slides[0]!.options }, { from: "translate(180px, 0px)", duration: 160, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }, "drawn from the old column's centre, with the slide's timing");
    await Promise.resolve(); await Promise.resolve();
    assert.equal(slides[0]!.anim.startTime, 1234, "started with the slide");
    for (let i = 0; i < 10; i++) flush();
    assert.equal(slides.length, 1, "no layout or move of its own on the slide's frames");
    setPanelHold(undefined);
    assert.equal(hold().props.style, undefined, "back to filling the column as the slide ends");
    assert.equal(slides[0]!.anim.playState, "idle");
    button("jump")?.props.onClick(); flush();
    assert.equal(button("jump"), undefined, "following the end");
    // The terminal opening under a conversation following its end: as tall as it was, bottom on the column's new end,
    // drawn from the old end.
    setPanelHold({ column: { w: 1092, h: 864 }, from: { w: 1092, h: 864 }, to: { w: 1092, h: 604 }, sheetWidth: 1092, terminal: 260, slide: { ...slide } });
    assert.deepEqual(hold().props.style, { width: "1092px", height: "864px", top: "-260px" });
    assert.equal(slides.at(-1)!.from, "translate(0px, 260px)");
    // Scrolled up before the slide ends: the box goes back to the column's top, 260px down, and what's read stays put.
    scroller().props.onWheel({ deltaY: -100, deltaX: 0 }); scroll(5000); scroll(4900);
    assert.ok(button("jump"), "not following the end any more");
    setPanelHold(undefined);
    assert.equal(top, 4900 + 260, "scrolled by as much as the box moved");
    resize(scroller()); flush();
    assert.equal(top, 4900 + 260, "and the reading anchor, taken again, doesn't undo it");
    // The mirror: the terminal closing under a conversation read further up, then scrolled to the end mid-slide.
    // Held from the top, the box doesn't move as the hold ends: nothing to make up for, and it follows the end.
    setPanelHold({ column: { w: 1092, h: 864 }, from: { w: 1092, h: 604 }, to: { w: 1092, h: 864 }, sheetWidth: 1092, terminal: 260, slide: { ...slide } });
    assert.equal(hold().props.style.top, "0px");
    scroll(1e9);
    assert.equal(button("jump"), undefined, "following the end again");
    const end = top;
    setPanelHold(undefined); resize(scroller()); flush();
    assert.equal(top, end, "still at the end");
    // Read further up, it stays where it is: from the top, nothing to move.
    scroll(1200); scroll(1100);
    assert.ok(button("jump"), "not following the end");
    setPanelHold({ column: { w: 1092, h: 864 }, from: { w: 1092, h: 864 }, to: { w: 1092, h: 604 }, sheetWidth: 1092, terminal: 260, slide: { ...slide } });
    assert.deepEqual(hold().props.style, { width: "1092px", height: "864px", top: "0px" });
    assert.equal(slides.length, 2, "nothing to move");
    setPanelHold(undefined);
} finally { dispose(); }
