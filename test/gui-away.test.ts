// A theme's scene stops when nobody's at the window and carries on at the next touch (gui/src/lib/away.ts).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as solid from "../gui/node_modules/solid-js/dist/solid.js";

/** The module run against a window, a document and a clock of the test's own. */
function load() {
    let now = 0;
    const timers = new Map<number, { at: number; run: () => void }>();
    let ids = 0;
    const listeners = new Map<string, Set<() => void>>();
    const target = (prefix: string) => ({
        addEventListener: (e: string, f: () => void) => { const k = prefix + e; if (!listeners.has(k)) listeners.set(k, new Set()); listeners.get(k)!.add(f); },
        removeEventListener: (e: string, f: () => void) => listeners.get(prefix + e)?.delete(f),
    });
    const doc = { hidden: false, ...target("doc:") };
    const env = {
        window: target(""),
        document: doc,
        performance: { now: () => now },
        setTimeout: (run: () => void, ms: number) => { timers.set(++ids, { at: now + ms, run }); return ids; },
        clearTimeout: (id?: number) => id !== undefined && timers.delete(id),
    };
    const source = readFileSync(new URL("../gui/src/lib/away.ts", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    const mod = new Function("createEffect", "createSignal", "onCleanup", "untrack", ...Object.keys(env), `${code}\nreturn { away, AWAY_MS };`)(solid.createEffect, solid.createSignal, solid.onCleanup, solid.untrack, ...Object.values(env));
    const fire = (e: string) => { for (const f of [...(listeners.get(e) ?? [])]) f(); };
    /** Moves the clock on, running the timers that come due. */
    const wait = (ms: number) => {
        const end = now + ms;
        for (;;) {
            const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (!next || next[1].at > end) break;
            timers.delete(next[0]);
            now = next[1].at;
            next[1].run();
        }
        now = end;
    };
    return { ...mod, fire, wait, doc, timers, listeners } as { away: (w: () => boolean) => () => boolean; AWAY_MS: number; fire: (e: string) => void; wait: (ms: number) => void; doc: { hidden: boolean }; timers: Map<number, unknown>; listeners: Map<string, Set<() => void>> };
}

test("stops after AWAY_MS with no touch, and carries on at the next", () => {
    const w = load();
    const [watch, setWatch] = solid.createSignal(true);
    let isAway!: () => boolean;
    const dispose = solid.createRoot((d: () => void) => { isAway = w.away(watch); return d; });
    w.wait(w.AWAY_MS - 1000);
    expect(isAway()).toBe(false);
    // A touch puts the time off; the timer looks again rather than being set again for each one.
    w.fire("pointermove");
    w.fire("pointermove");
    expect(w.timers.size).toBe(1);
    w.wait(w.AWAY_MS - 1000);
    expect(isAway()).toBe(false);
    w.wait(1000);
    expect(isAway()).toBe(true);
    // Nothing waits while it's away.
    expect(w.timers.size).toBe(0);
    w.fire("keydown");
    expect(isAway()).toBe(false);
    expect(w.timers.size).toBe(1);
    // Coming back to a window that was hidden counts as a touch; hiding it doesn't.
    w.wait(w.AWAY_MS);
    expect(isAway()).toBe(true);
    w.doc.hidden = true;
    w.fire("doc:visibilitychange");
    expect(isAway()).toBe(true);
    w.doc.hidden = false;
    w.fire("doc:visibilitychange");
    expect(isAway()).toBe(false);
    // Not watched (no moving scene, or Animate off): never away, and nothing listens or waits.
    setWatch(false);
    expect(isAway()).toBe(false);
    expect(w.timers.size).toBe(0);
    expect([...w.listeners.values()].every((s) => s.size === 0)).toBe(true);
    w.wait(w.AWAY_MS * 3);
    expect(isAway()).toBe(false);
    setWatch(true);
    w.wait(w.AWAY_MS);
    expect(isAway()).toBe(true);
    dispose();
    expect(w.timers.size).toBe(0);
    expect([...w.listeners.values()].every((s) => s.size === 0)).toBe(true);
});
