// One shared ticking clock for elapsed times and "2m ago" labels, so a page
// full of them updates in one pass instead of one timer each.

import { createRoot, createSignal } from "solid-js";

const [tick, setTick] = createRoot(() => createSignal(Date.now()));

setInterval(() => setTick(Date.now()), 1000);

export const now = tick;
