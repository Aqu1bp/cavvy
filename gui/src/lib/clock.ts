// One shared ticking clock for elapsed times and "2m ago" labels, so a page
// full of them updates in one pass instead of one timer each.
//
// Each change of a label is a frame drawn (on a Mac, a turn waiting with Cavvy behind another app: 20.7 ms/s against 6.7
// idle, its "Thinking · 12s" the most of the rest). So it ticks each second while Cavvy has the focus, each minute while it
// hasn't, and not at all while the window can't be seen (minimized, hidden); back, it ticks at once.

import { createRoot, createSignal } from "solid-js";
import { onSight } from "./loops";

const [tick, setTick] = createRoot(() => createSignal(Date.now()));

let timer: ReturnType<typeof setInterval> | 0 = 0;
let every = 0;
const set = () => setTick(Date.now());

onSight((seen, focused) => {
    const ms = seen ? (focused ? 1000 : 60_000) : 0;
    if (ms === every) return;
    clearInterval(timer);
    if (ms && (!every || ms < every)) set();
    every = ms;
    timer = ms && setInterval(set, ms);
});

export const now = tick;
