// The thumbnail worker (gui/src/lib/thumbnail.ts): started for the first job, let go of a while after the
// last one finishes, and started again for the next.

import { afterAll, expect, test } from "bun:test";

const made: FakeWorker[] = [];
class FakeWorker {
    onmessage?: (e: { data: unknown }) => void;
    onerror?: unknown;
    onmessageerror?: unknown;
    jobs: number[] = [];
    terminated = false;
    constructor() {
        made.push(this);
    }
    postMessage(m: { id: number }) {
        this.jobs.push(m.id);
    }
    terminate() {
        this.terminated = true;
    }
    answer(id: number) {
        this.onmessage?.({ data: { id, url: `data:image/png;base64,${id}` } });
    }
}

/** The worker's idle timers (a minute); each job's answer timer (3 s) is left out of them. */
const timers = new Map<number, () => void>();
let nextTimer = 0;
const saved = { Worker: globalThis.Worker, OffscreenCanvas: (globalThis as Record<string, unknown>).OffscreenCanvas, createImageBitmap: globalThis.createImageBitmap, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
Object.assign(globalThis, {
    Worker: FakeWorker,
    OffscreenCanvas: class {},
    createImageBitmap: () => undefined,
    setTimeout: (fn: () => void, ms?: number) => (++nextTimer, ms === 60_000 && timers.set(nextTimer, fn), nextTimer),
    clearTimeout: (id?: number) => void (id !== undefined && timers.delete(id)),
});
const { thumbnail } = await import("../gui/src/lib/thumbnail");
afterAll(() => Object.assign(globalThis, saved));

const runTimers = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const fn of due) fn();
};

test("the worker goes once it's idle, not while a job is out, and comes back for the next", async () => {
    // Over the size shown as it is (16 KB).
    const image = { data: "A".repeat(32_000), mediaType: "image/png" };
    const a = thumbnail(image);
    const b = thumbnail(image);
    expect(made).toHaveLength(1);
    const w = made[0]!;
    expect(timers.size).toBe(0);
    w.answer(w.jobs[0]!);
    expect(await a).toBe(`data:image/png;base64,${w.jobs[0]}`);
    // One still out: no timer.
    expect(timers.size).toBe(0);
    w.answer(w.jobs[1]!);
    await b;
    expect(timers.size).toBe(1);

    // A job before the timer fires keeps it.
    const c = thumbnail(image);
    expect(timers.size).toBe(0);
    w.answer(w.jobs[2]!);
    await c;
    expect(made).toHaveLength(1);
    runTimers();
    expect(w.terminated).toBe(true);
    expect(timers.size).toBe(0);

    // The next job starts another.
    const d = thumbnail(image);
    expect(made).toHaveLength(2);
    made[1]!.answer(made[1]!.jobs[0]!);
    expect(await d).toBeDefined();
});
