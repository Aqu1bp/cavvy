// How late the server's one thread runs what's due, measured from inside it: a timer every TICK_MS, and how much later
// than asked each fires. For benches (scripts/bench-ramp.ts): a round trip from another process on a busy machine also
// counts that process's own wait for a core, this doesn't. Runs only once asked for (server.lag), and stops a while
// after it was last read, so a server nobody measures has no timer waking it.

import type { LoopLag } from "./protocol";

const TICK_MS = 10;
/** Stops this long after its last read. */
const IDLE_STOP_MS = 10 * 60_000;
/** The most delays kept (about 3 minutes of ticks): the percentiles are over these. */
const KEPT = 20_000;
const WORST = 8;

let timer: ReturnType<typeof setTimeout> | undefined;
let due = 0;
let lastRead = 0;
let since = 0;
let delays: number[] = [];
let worst: { at: number; ms: number }[] = [];

function tick() {
    const now = performance.now();
    const late = Math.max(0, now - due);
    delays.push(late);
    if (delays.length > KEPT) delays = delays.slice(-KEPT / 2);
    if (worst.length < WORST || late > worst.at(-1)!.ms) {
        worst.push({ at: Date.now(), ms: late });
        worst.sort((a, b) => b.ms - a.ms);
        worst.length = Math.min(worst.length, WORST);
    }
    if (now - lastRead > IDLE_STOP_MS) {
        timer = undefined;
        return;
    }
    due = now + TICK_MS;
    timer = setTimeout(tick, TICK_MS);
}

/** What's been measured since it started (or was last reset), and it started if it wasn't. */
export function loopLag(o: { reset?: boolean } = {}): LoopLag {
    lastRead = performance.now();
    if (o.reset || timer === undefined) {
        delays = [];
        worst = [];
        since = Date.now();
    }
    if (timer === undefined) {
        due = performance.now() + TICK_MS;
        timer = setTimeout(tick, TICK_MS);
    }
    const sorted = [...delays].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! * 10) / 10 : 0);
    return {
        since,
        samples: sorted.length,
        p50: pct(0.5),
        p95: pct(0.95),
        p99: pct(0.99),
        max: pct(1),
        worst: worst.map((w) => ({ at: w.at, ms: Math.round(w.ms * 10) / 10 })),
    };
}
