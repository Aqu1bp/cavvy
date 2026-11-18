// The server hands memory back once no turn has run for a while (Engine.idleNow): once, after the last turn ends or a
// session with one running is let go, and not while any turn runs.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const home = mkdtempSync(join(tmpdir(), "cavvy-shrink-"));
process.env.CAVVY_HOME = home;
const { Engine } = await import("../src/server/engine");
const real = Bun.shrink;
let shrinks = 0;
beforeAll(() => {
    (Bun as { shrink: () => void }).shrink = () => void shrinks++;
});
afterAll(() => {
    (Bun as { shrink: () => void }).shrink = real;
    rmSync(home, { recursive: true, force: true });
});

const IDLE = 40;
const rt = (id: string) => ({ id }) as unknown as Parameters<InstanceType<typeof Engine>["turnRunning"]>[0];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("memory is handed back once no turn has run for a while, not while one runs", async () => {
    const engine = new Engine({ listModels: async () => [], shrinkIdleMs: IDLE });
    const [a, b] = [rt("a"), rt("b")];
    engine.turnRunning(a, true);
    engine.turnRunning(b, true);
    engine.turnRunning(a, false);
    await wait(IDLE * 3);
    // b still runs.
    expect(shrinks).toBe(0);
    engine.turnRunning(b, false);
    await wait(IDLE * 3);
    expect(shrinks).toBe(1);
    // Once for a quiet spell, however long it lasts.
    await wait(IDLE * 3);
    expect(shrinks).toBe(1);
    // A turn starting before the wait is over puts it off.
    engine.turnRunning(a, true);
    engine.turnRunning(a, false);
    await wait(IDLE / 2);
    engine.turnRunning(a, true);
    await wait(IDLE * 3);
    expect(shrinks).toBe(1);
    engine.turnRunning(a, false);
    await wait(IDLE * 3);
    expect(shrinks).toBe(2);
    await engine.stop();
});

test("a stopping server doesn't", async () => {
    const before = shrinks;
    const engine = new Engine({ listModels: async () => [], shrinkIdleMs: IDLE });
    engine.turnRunning(rt("a"), true);
    engine.turnRunning(rt("a"), false);
    await engine.stop();
    await wait(IDLE * 3);
    expect(shrinks).toBe(before);
});
