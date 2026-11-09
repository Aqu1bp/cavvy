import { expect, test } from "bun:test";
import { offStep, onStep } from "../gui/src/lib/stream-clock";

test("a step whose callback throws still runs the others, and the clock keeps stepping", () => {
    const real = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame, timeout: globalThis.setTimeout, clear: globalThis.clearTimeout, now: performance.now, error: console.error };
    let now = 1000, frame: ((t: number) => void) | undefined, id = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const logged: string[] = [];
    globalThis.requestAnimationFrame = ((fn: (t: number) => void) => { frame = fn; return 1; }) as any;
    globalThis.cancelAnimationFrame = (() => { frame = undefined; }) as any;
    globalThis.setTimeout = ((fn: () => void, ms = 0) => { timers.set(++id, { at: now + ms, fn }); return id; }) as any;
    globalThis.clearTimeout = ((t: number) => { timers.delete(t); }) as any;
    performance.now = () => now;
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    let steps = 0, escaped = 0;
    const broken = () => { throw new Error("broken step"); };
    // Something streaming: it asks for the next step at each one.
    const streaming = () => { steps++; onStep(streaming); };
    try {
        onStep(broken);
        onStep(streaming);
        // A quarter of a second of a 120 Hz display.
        for (const end = now + 250; now < end; now += 1000 / 120) {
            for (const [t, { at, fn }] of timers) if (at <= now) { timers.delete(t); fn(); }
            const f = frame;
            frame = undefined;
            try { f?.(now); } catch { escaped++; }
        }
    } finally {
        offStep(broken);
        offStep(streaming);
        Object.assign(globalThis, { requestAnimationFrame: real.raf, cancelAnimationFrame: real.caf, setTimeout: real.timeout, clearTimeout: real.clear });
        performance.now = real.now;
        console.error = real.error;
    }
    // About one step every 50 ms, the first one included.
    expect(steps).toBeGreaterThanOrEqual(4);
    expect(escaped).toBe(0);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("broken step");
});
