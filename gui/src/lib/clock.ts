// One shared ticking clock for elapsed times and "2m ago" labels, so a page
// full of them updates in one pass instead of one timer each.
//
// Each change of a label is a frame drawn (on a Mac, a turn waiting with Cavvy behind another app: 20.7 ms/s against 6.7
// idle, its "Thinking · 12s" the most of the rest). So it ticks each second while Cavvy has the focus, each minute while it
// hasn't, and not at all while the window can't be seen (minimized, hidden); back, it ticks at once.

import { createRoot, createSignal } from "solid-js";
import { onSight } from "./loops";

const [tick, setTick] = createRoot(() => createSignal(Date.now()));

let timer: ReturnType<typeof setInterval> | undefined;
let every = 0;

function pace(ms: number) {
    if (ms === every) return;
    const sooner = ms > 0 && (every === 0 || ms < every);
    clearInterval(timer);
    every = ms;
    timer = ms ? setInterval(() => setTick(Date.now()), ms) : undefined;
    if (sooner) setTick(Date.now());
}

onSight((s) => pace(!s.seen ? 0 : s.focused ? 1000 : 60_000));

export const now = tick;
