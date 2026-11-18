// An IntersectionObserver let go of while nothing scrolls or changes size (gui/src/lib/settling-observer.ts): while one
// has targets, Chromium draws every frame of every animation on the main thread.
import { afterEach, expect, test } from "bun:test";
import { settlingObserver } from "../gui/src/lib/settling-observer";

class Observer {
    targets = new Set<unknown>();
    records: unknown[] = [];
    constructor(public callback: (entries: any[], observer: Observer) => void) {}
    observe(el: unknown) { this.targets.add(el); }
    unobserve(el: unknown) { this.targets.delete(el); }
    disconnect() { this.targets.clear(); }
    takeRecords() { const r = this.records; this.records = []; return r; }
    emit(entries: any[]) { this.callback(entries, this); }
}
let io: Observer, ro: Observer;
const original = { io: globalThis.IntersectionObserver, ro: globalThis.ResizeObserver };
afterEach(() => Object.assign(globalThis, { IntersectionObserver: original.io, ResizeObserver: original.ro }));

function fixture() {
    (globalThis as any).IntersectionObserver = class extends Observer { constructor(cb: any) { super(cb); io = this; } };
    (globalThis as any).ResizeObserver = class extends Observer { constructor(cb: any) { super(cb); ro = this; } };
    const listeners = new Set<() => void>();
    const root = { addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) };
    const seen: unknown[][] = [];
    const obs = settlingObserver((entries) => seen.push(entries.map((e) => e.target)), { root: root as any }, [], 20);
    return { obs, seen, scroll: () => listeners.forEach((fn) => fn()), listeners };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("targets are watched until it has said where they are and nothing has moved for a while, then let go of", async () => {
    const f = fixture();
    f.obs.observe("a");
    f.obs.observe("b");
    expect([...io.targets]).toEqual(["a", "b"]);
    // No frame yet to say where they are: still watched.
    await sleep(50);
    expect(io.targets.size).toBe(2);
    io.emit([{ target: "a" }, { target: "b" }]);
    io.records = [{ target: "b" }];
    await sleep(50);
    expect(io.targets.size).toBe(0);
    // What it had seen and not said yet was said as it let go.
    expect(f.seen).toEqual([["a", "b"], ["b"]]);
    f.obs.disconnect();
});

test("a scroll, a change in size, or a new target watches all of them again", async () => {
    const f = fixture();
    f.obs.observe("a");
    io.emit([{ target: "a" }]);
    await sleep(50);
    expect(io.targets.size).toBe(0);
    f.scroll();
    expect([...io.targets]).toEqual(["a"]);
    io.emit([{ target: "a" }]);
    await sleep(50);
    expect(io.targets.size).toBe(0);
    ro.emit([]);
    expect([...io.targets]).toEqual(["a"]);
    io.emit([{ target: "a" }]);
    await sleep(50);
    f.obs.observe("b");
    expect([...io.targets]).toEqual(["a", "b"]);
    // One no longer wanted isn't watched again.
    f.obs.unobserve("a");
    io.emit([{ target: "b" }]);
    await sleep(50);
    f.obs.wake();
    expect([...io.targets]).toEqual(["b"]);
    f.obs.disconnect();
});

test("once disconnected, nothing wakes it and it stops listening", async () => {
    const f = fixture();
    f.obs.observe("a");
    f.obs.disconnect();
    expect(f.listeners.size).toBe(0);
    expect(ro.targets.size).toBe(0);
    f.obs.wake();
    f.obs.observe("b");
    expect(io.targets.size).toBe(0);
    await sleep(50);
    expect(f.seen).toEqual([]);
});
