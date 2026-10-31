// A fast agent's output (#351): the live line, streamed text and step rows stay readable at any token rate.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { component, node, renderer, text, type Node } from "../helpers/gui-render";
import * as liveLine from "../../gui/src/lib/live-line";
import * as format from "../../gui/src/lib/format";
import { createReveal, LAG_MS, revealing } from "../../gui/src/lib/reveal";
import { STEP_MS } from "../../gui/src/lib/stream-clock";

const source = (file: string) => readFileSync(new URL(`../../gui/src/components/${file}.tsx`, import.meta.url), "utf8").replace(/^import [\s\S]*?;\n/gm, "");

/** Frames on demand: each flush() is the next one, 16ms on, on performance.now()'s clock. */
const frames = new Map<number, (now: number) => void>();
let seq = 0;
let clock = 1_000_000;
globalThis.requestAnimationFrame = ((fn: (now: number) => void) => (frames.set(++seq, fn), seq)) as any;
globalThis.cancelAnimationFrame = ((id: number) => frames.delete(id)) as any;
(globalThis as any).document = { hidden: false };
const realNow = performance.now.bind(performance);
performance.now = () => clock;
/** The clock's timer, on the same clock (only while the test that uses them runs). */
const timers = new Map<number, { at: number; fn: () => void }>();
const realTimers = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
const fakeTimers = () => {
    globalThis.setTimeout = ((fn: () => void, ms = 0) => (timers.set(++seq, { at: clock + ms, fn }), seq)) as any;
    globalThis.clearTimeout = ((id: number) => void timers.delete(id)) as any;
};
const flush = () => {
    clock += 16;
    for (const [id, t] of [...timers]) if (t.at <= clock) (timers.delete(id), t.fn());
    const due = [...frames.values()];
    frames.clear();
    due.forEach((fn) => fn(clock));
};

test("a block that starts while the reply streams comes out from its start, at one pace, all of it within the lag", () => {
    fakeTimers();
    solid.createRoot((dispose) => {
        const [value, setValue] = solid.createSignal("A fast model sends a whole paragraph at once, ");
        const [streaming, setStreaming] = solid.createSignal(true);
        const [shown, behind] = createReveal(value, streaming);
        // Not the chunk that arrived with it, whole: its first words at once, then word by word.
        expect(shown().length).toBeGreaterThan(0);
        expect(shown().length).toBeLessThan(value().length);
        expect(behind()).toBe(true);
        expect(revealing()).toBe(true);
        // A burst of 600 characters on top: it's all out LAG_MS after it came, at one speed (not fast, then a crawl).
        setValue(value() + "word ".repeat(120));
        const steps: number[] = [];
        let last = 0;
        const start = clock;
        while (behind() && clock - start < 2000) {
            flush();
            steps.push(shown().length - last);
            last = shown().length;
        }
        expect(shown()).toBe(value());
        expect(clock - start).toBeLessThanOrEqual(LAG_MS + STEP_MS);
        // A frame with no step due lets nothing out.
        const body = steps.filter((n) => n > 0).slice(1, -1);
        expect(Math.max(...body) - Math.min(...body)).toBeLessThanOrEqual(12);
        expect(revealing()).toBe(false);
        // More, then the stream ends mid-burst: what's left still comes out, within the lag of when it arrived.
        setValue(value() + "and the last few words of the reply.");
        flush();
        setStreaming(false);
        const end = clock;
        while (behind() && clock - end < 2000) flush();
        expect(shown()).toBe(value());
        expect(clock - end).toBeLessThanOrEqual(LAG_MS);
        dispose();
    });
    globalThis.setTimeout = realTimers.set;
    globalThis.clearTimeout = realTimers.clear;
    // Drawn again mid-reply with much already there (a session switched back to): shown at once, not replayed.
    solid.createRoot((dispose) => {
        const long = "x ".repeat(1000);
        const [shown] = createReveal(() => long, () => true);
        expect(shown()).toBe(long);
        dispose();
    });
    // Not streaming: as it is.
    solid.createRoot((dispose) => {
        const [shown, behind] = createReveal(() => "Done.", () => false);
        expect([shown(), behind()]).toEqual(["Done.", false]);
        dispose();
    });
});

function liveLineView() {
    const LiveLine = component(source("LiveLine"), "LiveLine", {
        ...liveLine, ...format, now: () => Date.now(), prefs: { motion: "quick" }, Spinner: () => node("spinner"), Clock: () => node("icon"), Hand: () => node("icon"),
        // No command here: nothing opens.
        ChevronRight: () => node("icon"), LiveCommandBody: () => node("cmd-body"), useCardFolds: () => ({ get: () => undefined, set: () => {} }),
    });
    const [state, setState] = solid.createSignal<liveLine.LiveLineState | undefined>({ key: "think", kind: "think", label: "Thinking" });
    const root = node("root");
    const dispose = renderer.render(() => LiveLine({ get state() { return state(); } }), root);
    /** What the line says (its screen reader text: the state on show). */
    const says = () => {
        const sr = (function find(n: Node): Node | undefined {
            if (n.props.class === "sr-only") return n;
            for (const c of n.children) { const f = find(c); if (f) return f; }
        })(root);
        return sr ? text(sr) : undefined;
    };
    return { setState, says, dispose };
}

const tool = (id: string, label: string): liveLine.LiveLineState => ({ key: `tool:${id}:running`, kind: "tool", label, detail: `src/${id}.ts`, toolId: id });

test("the page says words are flowing while they come out, through a gap between chunks, and not once they've stopped", () => {
    fakeTimers();
    const marks = new Set<string>();
    (document as any).documentElement = { setAttribute: (name: string) => marks.add(name), removeAttribute: (name: string) => marks.delete(name) };
    const run = (ms: number) => { const start = clock; while (clock - start < ms) flush(); };
    run(500); // What the last test let out is over.
    solid.createRoot((dispose) => {
        const [value, setValue] = solid.createSignal("Some words, ");
        const [, behind] = createReveal(value, () => true);
        expect(marks.has("data-flowing")).toBe(true);
        run(200);
        expect(behind()).toBe(false);
        expect(marks.has("data-flowing")).toBe(true);
        setValue(value() + "and some more of them, ");
        run(200);
        expect(behind()).toBe(false);
        expect(marks.has("data-flowing")).toBe(true);
        run(400);
        expect(marks.has("data-flowing")).toBe(false);
        // A new start after a wait marks it again.
        setValue(value() + "then the rest.");
        expect(marks.has("data-flowing")).toBe(true);
        dispose();
        run(500);
        expect(marks.has("data-flowing")).toBe(false);
    });
    delete (document as any).documentElement;
    globalThis.setTimeout = realTimers.set;
    globalThis.clearTimeout = realTimers.clear;
});

test("the live line shows each state long enough to read it: one that comes too soon waits, and those in between are skipped", async () => {
    performance.now = realNow;
    const v = liveLineView();
    try {
        expect(v.says()).toBe("Thinking");
        // A fast agent's next states, 20ms apart: the line stays on Thinking until it has been read.
        await Bun.sleep(20);
        v.setState(tool("a", "Reading"));
        await Bun.sleep(20);
        v.setState(tool("b", "Searching"));
        expect(v.says()).toBe("Thinking");
        await Bun.sleep(liveLine.DWELL_MS);
        // Then straight to the latest: Reading came and went unseen.
        expect(v.says()).toBe("Searching");
        // Back to the state on show before it moves on: it stays, without a roll.
        v.setState(tool("c", "Writing"));
        v.setState(tool("b", "Searching"));
        await Bun.sleep(liveLine.DWELL_MS + 20);
        expect(v.says()).toBe("Searching");
        // Stepping aside for the answer is at once, and the line comes back at once.
        v.setState(tool("d", "Running"));
        v.setState(undefined);
        expect(v.says()).toBeUndefined();
        v.setState(tool("e", "Editing"));
        expect(v.says()).toBe("Editing");
    } finally { v.dispose(); }
});

test("a state the user must act on, or a retry or a stop, shows at once, however soon it comes", async () => {
    performance.now = realNow;
    const v = liveLineView();
    try {
        await Bun.sleep(20);
        v.setState({ key: "wait:p1", kind: "wait", label: "Waiting for approval", detail: "rm -rf build", mono: true });
        expect(v.says()).toBe("Waiting for approval");
        // A question the same way, straight after.
        v.setState({ key: "wait:q1", kind: "wait", label: "Waiting for your answer" });
        expect(v.says()).toBe("Waiting for your answer");
        // A step under way right after still waits for that to be read.
        v.setState(tool("a", "Reading"));
        expect(v.says()).toBe("Waiting for your answer");
        // A retry or a stop doesn't.
        v.setState({ key: "special:Interrupting", kind: "special", label: "Interrupting" });
        expect(v.says()).toBe("Interrupting");
        v.setState({ key: "special:Retrying", kind: "special", label: "Retrying in 5s" });
        expect(v.says()).toBe("Retrying in 5s");
    } finally { v.dispose(); }
});

test("rows that land together come in one after another, never long after they landed, and only in a running turn", () => {
    const at = 5_000_000;
    expect([0, 1, 2, 3, 4, 5].map(() => liveLine.staggerDelay(at))).toEqual([0, 50, 100, 150, 200, 200]);
    // One that lands a while later doesn't wait.
    expect(liveLine.staggerDelay(at + 1000)).toBe(0);
    // No motion: none waits.
    expect([liveLine.staggerDelay(at + 2000, 0), liveLine.staggerDelay(at + 2000, 0)]).toEqual([0, 0]);
    // A row placed in a running turn gets its wait as --enter (transcript.css); one in a finished turn doesn't.
    const row = (busy: boolean) => {
        const props: Record<string, string> = {};
        return { el: { closest: (s: string) => (busy && s === '.turn[aria-busy="true"]' ? {} : null), style: { setProperty: (k: string, v: string) => (props[k] = v) } } as any, props };
    };
    performance.now = () => at + 10_000;
    const rows = [row(true), row(true), row(true), row(false)];
    for (const r of rows) liveLine.enterRow(r.el, 50);
    return Promise.resolve().then(() => {
        expect(rows.map((r) => r.props["--enter"])).toEqual([undefined, "50ms", "100ms", undefined]);
        const still = row(true);
        liveLine.enterRow(still.el, 0);
        return Promise.resolve().then(() => expect(still.props).toEqual({}));
    });
});
