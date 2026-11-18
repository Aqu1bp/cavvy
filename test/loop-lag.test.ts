import { expect, test } from "bun:test";
import { loopLag } from "../src/server/loop-lag";

const ticks = () => new Promise((r) => setTimeout(r, 60));

// A stall says whether the server was working through it or waiting: what the ramp's slowest moments need to be read.
test("a stall says whether the server was working or waiting through it", async () => {
    loopLag({ reset: true });
    await ticks();
    const busyUntil = performance.now() + 150;
    while (performance.now() < busyUntil);
    await ticks();
    const busy = loopLag().worst[0]!;
    expect(busy.ms).toBeGreaterThan(100);

    loopLag({ reset: true });
    await ticks();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    await ticks();
    const idle = loopLag().worst[0]!;
    expect(idle.ms).toBeGreaterThan(100);
    expect(idle.cpuMs!).toBeLessThan(idle.ms * 0.3);
    expect(idle.waits! + idle.preempted!).toBeGreaterThan(0);
    // Working through it, it used the CPU it got: on a busy machine (other tests running) that's less than half of
    // the stall, but well over what waiting used.
    expect(busy.cpuMs!).toBeGreaterThan(Math.max(10, idle.cpuMs! * 3));
});
