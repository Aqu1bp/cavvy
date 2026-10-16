import { expect, jest, test } from "bun:test";
import { DelayedPending } from "../gui/src/lib/delayed-pending";

test("pending starts at 400ms, stays visible for 400ms, and cancellation releases old waits", async () => {
    jest.useFakeTimers();
    let now = 0;
    let shown = 0;
    const pending = new DelayedPending(() => shown++, () => now);
    const advance = (ms: number) => { now += ms; jest.advanceTimersByTime(ms); };
    try {
        pending.start();
        advance(399);
        expect(shown).toBe(0);
        await pending.finish();
        advance(1000);
        expect(shown).toBe(0); // Fast opens never flash a loading state.
        pending.start();
        advance(400);
        expect(shown).toBe(1);
        advance(50);
        let finished = false;
        const done = pending.finish().then(() => { finished = true; });
        advance(349);
        await Promise.resolve();
        expect(finished).toBe(false);
        advance(1);
        await done;
        expect(finished).toBe(true);
        pending.start();
        advance(400);
        const superseded = pending.finish();
        pending.start();
        await superseded;
        advance(399);
        expect(shown).toBe(2);
        pending.cancel();
        advance(1000);
        expect(shown).toBe(2);
    } finally { pending.cancel(); jest.useRealTimers(); }
});
