// The "Up next" tray (QueueTab) rendered with real Solid reactivity in an in-memory DOM
// (run by gui-queue.test.ts): live numbering while a row is held, the others sliding out
// of its way, a click that stays a click, ↑/↓, reduced motion, and the move landing.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { createRenderer } from "../../gui/node_modules/solid-js/universal/dist/universal.js";
import { component, text } from "../helpers/gui-render";
import { clampDrag, dragTarget, joiningRow, moved, movedAnnouncement, queueRow, settleMs, slotOf, stepTarget } from "../../gui/src/lib/queue";
import { splitComments } from "../../gui/src/lib/review-comments";
import { plural } from "../../gui/src/lib/format";

type Node = {
    tag: string;
    props: Record<string, any>;
    children: Node[];
    parent?: Node;
    text?: string;
    offsetHeight: number;
    listeners: Record<string, ((e: any) => void)[]>;
    focus(): void;
    animate(): void;
    setPointerCapture(): void;
    addEventListener(type: string, fn: (e: any) => void): void;
    removeEventListener(type: string, fn: (e: any) => void): void;
    querySelector(selector: string): Node | undefined;
};
let focused: Node | undefined;
const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)];
const node = (tag: string): Node => {
    const n: Node = {
        tag, props: {}, children: [], offsetHeight: 34, listeners: {},
        focus() { focused = n; },
        animate() {},
        setPointerCapture() {},
        addEventListener(type, fn) { (n.listeners[type] ??= []).push(fn); },
        removeEventListener(type, fn) { n.listeners[type] = (n.listeners[type] ?? []).filter((f) => f !== fn); },
        // Only what the tray asks for: a row by its message's id.
        querySelector(selector) {
            const id = /data-qid="(\d+)"/.exec(selector)?.[1];
            return all(n).find((c) => c !== n && String(c.props["data-qid"]) === id);
        },
    };
    return n;
};
const renderer = createRenderer<Node>({
    createElement: node,
    createTextNode: (t) => ({ ...node("#text"), text: t }),
    isTextNode: (n) => n.tag === "#text",
    replaceText: (n, t) => { n.text = t; },
    setProperty: (n, key, value) => { n.props[key] = value; },
    insertNode: (parent, n, anchor) => {
        if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
        parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, n);
        n.parent = parent;
    },
    removeNode: (parent, n) => { parent.children.splice(parent.children.indexOf(n), 1); n.parent = undefined; },
    getParentNode: (n) => n.parent,
    getFirstChild: (n) => n.children[0],
    getNextSibling: (n) => n.parent?.children[n.parent.children.indexOf(n) + 1],
});

const source = readFileSync(new URL("../../gui/src/components/QueueTab.tsx", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
const icon = () => undefined;

function setup(opts: { reduced?: boolean; settle?: string; moved?: boolean | "error" } = {}) {
    const calls: { method: string; params: any }[] = [];
    const toasts: string[] = [];
    const errors: unknown[] = [];
    let frames: (() => void)[] = [];
    const [ids, setIds] = solid.createSignal([10, 20, 30]);
    const texts: Record<number, string> = { 10: "also move copy out of the bubble", 20: "then bump the patch version", 30: "before that, add a changelog entry" };
    const kinds: Record<number, string> = { 10: "steer", 20: "queue", 30: "queue" };
    const state = {
        get queueIds() { return ids(); },
        get queued() { return ids().map((id) => texts[id]); },
        get queuedModes() { return ids().map((id) => kinds[id]); },
        busy: true,
    };
    const rpc = {
        call: async (method: string, params: any) => {
            calls.push({ method, params });
            if (opts.moved === "error") throw new Error("gone");
            return { moved: opts.moved ?? true, sent: true };
        },
    };
    const QueueTab = component(source, "QueueTab", {
        renderer: { ...solid, ...renderer },
        CirclePause: icon, CornerDownRight: icon, GripVertical: icon, ListEnd: icon, Paperclip: icon, Pencil: icon, X: icon,
        reportError: (e: unknown) => errors.push(e), rpc, toast: (m: string) => toasts.push(m),
        clampDrag, dragTarget, joiningRow, moved, movedAnnouncement, queueRow, settleMs, slotOf, stepTarget, splitComments, plural,
        matchMedia: () => ({ matches: !!opts.reduced }),
        getComputedStyle: () => ({ rowGap: "2px", getPropertyValue: (k: string) => (k === "--dur-settle" ? (opts.settle ?? "0ms") : "") }),
        requestAnimationFrame: (fn: () => void) => frames.push(fn),
        document: { get activeElement() { return focused; } },
    });
    const root = node("root");
    const dispose = renderer.render(() => QueueTab({ sessionId: "s", state, dequeue: () => {} }), root);
    const list = all(root).find((n) => n.props.role === "list")!;
    const rows = () => list.children.filter((n) => n.props.role === "listitem");
    const row = (id: number) => rows().find((r) => r.props["data-qid"] === id)!;
    const number = (id: number) => text(all(row(id)).find((n) => n.tag === "b")!);
    const transform = (id: number) => row(id).props.style?.transform;
    const cls = (id: number) => Object.entries(row(id).props.classList ?? {}).filter(([, on]) => on).map(([k]) => k);
    const status = () => text(all(root).find((n) => n.props.role === "status")!);
    const press = (id: number, key: string) => {
        const r = row(id);
        const e = { key, target: r, currentTarget: r, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
        r.props.onKeyDown(e);
        return e.prevented;
    };
    const target = (button = false) => ({ closest: (s: string) => (button && s === "button" ? {} : null) });
    const down = (id: number, y: number, button = false) => row(id).props.onPointerDown({ button: 0, clientY: y, pointerId: 1, currentTarget: row(id), target: target(button) });
    const fire = (id: number, type: string, y = 0) => [...(row(id).listeners[type] ?? [])].forEach((fn) => fn({ clientY: y, pointerId: 1 }));
    const tick = () => { const f = frames; frames = []; f.forEach((fn) => fn()); };
    /** The settle (0ms here), the rpc, and its reply. */
    const settle = () => Bun.sleep(5);
    return { list, rows, row, number, transform, cls, status, press, down, fire, tick, settle, calls, toasts, errors, setIds, dispose };
}

test("tray: numbered rows, a hint each, the first steer pulses, Steer on a queued one", () => {
    const t = setup();
    try {
        expect(t.rows().map((r) => r.props["data-qid"])).toEqual([10, 20, 30]);
        expect([10, 20, 30].map(t.number)).toEqual(["1", "2", "3"]);
        expect(t.list.props["aria-label"]).toBe("Up next: 3 messages");
        expect(t.row(10).props["aria-label"]).toBe("1 of 3: also move copy out of the bubble. Next step");
        expect(t.row(20).props["aria-label"]).toBe("2 of 3: then bump the patch version. After this turn");
        expect(t.row(20).props.tabIndex).toBe(0);
        const joining = (id: number) => all(t.row(id)).some((n) => n.props.classList?.joining);
        expect([10, 20, 30].map(joining)).toEqual([true, false, false]);
        const buttons = (id: number) => all(t.row(id)).filter((n) => n.tag === "button").map((b) => text(b) || b.props["aria-label"]);
        expect(buttons(10)).toEqual(["Edit queued message", "Remove from the queue"]);
        expect(buttons(20)).toEqual(["Steer", "Edit queued message", "Remove from the queue"]);
    } finally {
        t.dispose();
    }
});

test("tray: ↑ moves the focused row one place, the others slide, the numbers follow, and it lands without a jump", async () => {
    const t = setup();
    try {
        expect(t.press(30, "ArrowUp")).toBe(true);
        // Settling into slot 2: it rises one row, the one it passes drops one, numbers follow the new order.
        expect(t.transform(30)).toBe("translateY(-36px)");
        expect(t.transform(20)).toBe("translateY(36px)");
        expect(t.transform(10)).toBeUndefined();
        expect([10, 20, 30].map(t.number)).toEqual(["1", "3", "2"]);
        expect(t.cls(30)).toContain("settling");
        expect(t.list.props.class).toContain("sorting");
        await t.settle();
        expect(t.calls).toEqual([{ method: "session.moveQueued", params: { id: "s", queueId: 30, to: 1 } }]);
        // Waiting on the queue: still drawn in the new order, with transitions off.
        expect(t.list.props.class).toContain("still");
        expect(t.transform(30)).toBe("translateY(-36px)");
        t.setIds([10, 30, 20]);
        // In its new place: every transform gone at once, transitions still off for this frame.
        expect(t.rows().map((r) => r.props["data-qid"])).toEqual([10, 30, 20]);
        expect([10, 20, 30].map(t.transform)).toEqual([undefined, undefined, undefined]);
        expect([10, 30, 20].map(t.number)).toEqual(["1", "2", "3"]);
        expect(t.list.props.class).toContain("still");
        expect(t.status()).toBe("Moved to position 2 of 3");
        t.tick();
        expect(t.list.props.class).not.toContain("still");
        expect(t.list.props.class).not.toContain("sorting");
        expect(focused).toBe(t.row(30));
        // At the top end, ↑ does nothing.
        t.setIds([30, 10, 20]);
        t.press(30, "ArrowUp");
        await t.settle();
        expect(t.calls).toHaveLength(1);
    } finally {
        t.dispose();
    }
});

test("tray: ↑↑ pressed fast moves the same message twice", async () => {
    const t = setup();
    try {
        t.press(30, "ArrowUp");
        t.press(30, "ArrowUp");
        await t.settle();
        t.setIds([10, 30, 20]);
        t.tick();
        await t.settle();
        expect(t.calls.map((c) => c.params)).toEqual([{ id: "s", queueId: 30, to: 1 }, { id: "s", queueId: 30, to: 0 }]);
    } finally {
        t.dispose();
    }
});

test("tray: a drag from the row lifts it after 3px, follows the pointer within the list, and drops where it's held", async () => {
    const t = setup();
    try {
        t.down(10, 100);
        t.fire(10, "pointermove", 102);
        expect(t.transform(10)).toBeUndefined();
        expect(t.cls(10)).not.toContain("lifted");
        t.fire(10, "pointermove", 140);
        expect(t.cls(10)).toContain("lifted");
        expect(t.transform(10)).toBe("translateY(40px) scale(1.02)");
        // Over slot 2: the second row has slid up into slot 1, and the numbers say so.
        expect(t.transform(20)).toBe("translateY(-36px)");
        expect([10, 20, 30].map(t.number)).toEqual(["2", "1", "3"]);
        // Far past the end: held at the list's end, 6px over.
        t.fire(10, "pointermove", 900);
        expect(t.transform(10)).toBe("translateY(78px) scale(1.02)");
        expect([10, 20, 30].map(t.number)).toEqual(["3", "1", "2"]);
        t.fire(10, "pointerup", 900);
        expect(t.cls(10)).toContain("settling");
        expect(t.transform(10)).toBe("translateY(72px)");
        await t.settle();
        expect(t.calls).toEqual([{ method: "session.moveQueued", params: { id: "s", queueId: 10, to: 2 } }]);
        t.setIds([20, 30, 10]);
        expect([10, 20, 30].map(t.transform)).toEqual([undefined, undefined, undefined]);
        expect(t.status()).toBe("Moved to position 3 of 3");
    } finally {
        t.dispose();
    }
});

test("tray: a click stays a click, a press on a button starts no drag, and a drop back in place asks nothing", async () => {
    const t = setup();
    try {
        t.down(20, 100);
        t.fire(20, "pointermove", 102);
        t.fire(20, "pointerup", 102);
        expect(t.cls(20)).not.toContain("lifted");
        t.down(20, 100, true);
        expect(t.row(20).listeners.pointermove ?? []).toHaveLength(0);
        t.down(20, 100);
        t.fire(20, "pointermove", 110);
        t.fire(20, "pointermove", 101);
        t.fire(20, "pointerup", 101);
        await t.settle();
        expect(t.calls).toEqual([]);
        expect(t.transform(20)).toBeUndefined();
    } finally {
        t.dispose();
    }
});

test("tray: with reduced motion the move goes at once, whatever --dur-settle says", async () => {
    const slow = setup({ settle: "220ms" });
    const reduced = setup({ settle: "220ms", reduced: true });
    try {
        slow.press(10, "ArrowDown");
        reduced.press(10, "ArrowDown");
        await Bun.sleep(5);
        expect(slow.calls).toEqual([]);
        expect(reduced.calls).toEqual([{ method: "session.moveQueued", params: { id: "s", queueId: 10, to: 1 } }]);
        await Bun.sleep(260);
        expect(slow.calls).toHaveLength(1);
    } finally {
        slow.dispose();
        reduced.dispose();
    }
});

test("tray: a message already sent says so and the rows go back; a queue that changes mid-drag lets go", async () => {
    const t = setup({ moved: false });
    try {
        t.press(20, "ArrowDown");
        await t.settle();
        expect(t.toasts).toEqual(["That message has already been sent"]);
        expect([10, 20, 30].map(t.transform)).toEqual([undefined, undefined, undefined]);
        expect(t.list.props.class).not.toContain("still");

        t.down(30, 100);
        t.fire(30, "pointermove", 60);
        expect(t.cls(30)).toContain("lifted");
        // The steer went into the turn meanwhile.
        t.setIds([20, 30]);
        expect(t.cls(30)).not.toContain("lifted");
        expect(t.transform(30)).toBeUndefined();
        t.fire(30, "pointermove", 20);
        t.fire(30, "pointerup", 20);
        await t.settle();
        expect(t.calls).toHaveLength(1);
    } finally {
        t.dispose();
    }
});
