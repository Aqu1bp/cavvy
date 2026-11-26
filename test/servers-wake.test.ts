// A Mac server stays awake while it works (src/servers/wake.ts): held from a turn's start until a while after the
// last one ends, and past that while work a turn left running goes on. What holds it here is a stand-in; the real
// one is `caffeinate`.

import { afterAll, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { WakeLock } = await import("../src/servers/wake");
const { Engine } = await import("../src/server/engine");
afterAll(() => iso.cleanup());

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What would hold the Mac awake: how many times it was taken, and whether it's held now. */
function holder() {
    const h = { taken: 0, held: false, end: undefined as (() => void) | undefined };
    const hold = () => {
        h.taken++;
        h.held = true;
        const gone = Promise.withResolvers<void>();
        h.end = () => {
            h.held = false;
            gone.resolve();
        };
        return { kill: () => void (h.held = false), gone: gone.promise };
    };
    return { h, hold };
}

test("held from a turn's start until a while after the last one ends; turns that follow one another take it once", async () => {
    const { h, hold } = holder();
    const wake = new WakeLock({ working: () => false, hold, recheckMs: 40 });
    expect(h.taken).toBe(0);
    wake.turnsRunning(true);
    expect(h).toMatchObject({ taken: 1, held: true });
    wake.turnsRunning(false);
    // The next turn starts before it's let go.
    await wait(10);
    expect(h.held).toBe(true);
    wake.turnsRunning(true);
    await wait(80);
    expect(h).toMatchObject({ taken: 1, held: true });
    wake.turnsRunning(false);
    await wait(100);
    expect(h).toMatchObject({ taken: 1, held: false });
    wake.turnsRunning(true);
    expect(h).toMatchObject({ taken: 2, held: true });
    wake.stop();
    expect(h.held).toBe(false);
});

test("work a turn left running keeps it held until it's done, looked at again by and by", async () => {
    const { h, hold } = holder();
    let building = true;
    const wake = new WakeLock({ working: () => building, hold, recheckMs: 20 });
    wake.turnsRunning(true);
    wake.turnsRunning(false);
    await wait(90);
    expect(h).toMatchObject({ taken: 1, held: true });
    building = false;
    await wait(90);
    expect(h).toMatchObject({ taken: 1, held: false });
    // Nothing looks again once it's let go.
    building = true;
    await wait(90);
    expect(h.held).toBe(false);
    wake.stop();
});

test("ended by something else, it's taken again when there's next reason to", async () => {
    const { h, hold } = holder();
    const wake = new WakeLock({ working: () => false, hold });
    wake.turnsRunning(true);
    h.end!();
    await wait(5);
    wake.turnsRunning(true);
    expect(h).toMatchObject({ taken: 2, held: true });
    wake.stop();
});

test("nothing to hold it with: turns run all the same", () => {
    const wake = new WakeLock({ working: () => false, hold: () => undefined, recheckMs: 5 });
    wake.turnsRunning(true);
    wake.turnsRunning(false);
    wake.stop();
});

test("the server says when a turn starts with none running, and when the last one ends", async () => {
    const said: boolean[] = [];
    const engine = new Engine({ listModels: async () => [], onTurns: (running) => said.push(running) });
    const rt = (id: string) => ({ id }) as unknown as Parameters<InstanceType<typeof Engine>["turnRunning"]>[0];
    engine.turnRunning(rt("a"), true);
    engine.turnRunning(rt("b"), true);
    engine.turnRunning(rt("a"), false);
    expect(said).toEqual([true]);
    engine.turnRunning(rt("b"), false);
    // One that isn't running ending again says nothing.
    engine.turnRunning(rt("b"), false);
    expect(said).toEqual([true, false]);
    engine.turnRunning(rt("a"), true);
    expect(said).toEqual([true, false, true]);
    await engine.stop();
});
