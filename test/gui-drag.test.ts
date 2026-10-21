// Dragging an edge (lib/drag.ts): the size shows at most once a frame, and is saved once, on release.
import { expect, test } from "bun:test";
import { frameDrag } from "../gui/src/lib/drag";
import { fakeFrames } from "./helpers/frames";

function drag() {
    const frames = fakeFrames();
    const shown: number[] = [];
    const saved: (number | undefined)[] = [];
    const d = frameDrag({ show: (v) => shown.push(v), commit: (v) => saved.push(v), frames });
    return { d, frames, shown, saved };
}

test("moves within a frame show once, at the latest size, and nothing is saved meanwhile", () => {
    const { d, frames, shown, saved } = drag();
    d.move(300);
    d.move(305);
    d.move(310);
    expect(frames.pending()).toBe(1);
    expect(shown).toEqual([]);
    frames.run();
    expect(shown).toEqual([310]);
    d.move(320);
    frames.run();
    expect(shown).toEqual([310, 320]);
    expect(saved).toEqual([]);
});

test("a frame with no new size shows nothing", () => {
    const { d, frames, shown } = drag();
    d.move(300);
    frames.run();
    d.move(300);
    frames.run();
    expect(shown).toEqual([300]);
    frames.run();
    expect(frames.pending()).toBe(0);
});

test("the release saves the last size asked for at once, even one not shown yet, and cancels its frame", () => {
    const { d, frames, shown, saved } = drag();
    d.move(300);
    frames.run();
    d.move(340);
    d.end();
    expect(saved).toEqual([340]);
    expect(frames.pending()).toBe(0);
    expect(shown).toEqual([300]);
});

test("released without moving, nothing changes size (a double-click's presses)", () => {
    const { d, frames, saved } = drag();
    d.end();
    expect(saved).toEqual([undefined]);
    expect(frames.pending()).toBe(0);
});

test("after the release, moves and further releases do nothing", () => {
    const { d, frames, shown, saved } = drag();
    d.move(300);
    d.end();
    d.end();
    d.move(400);
    expect(frames.pending()).toBe(0);
    frames.run();
    expect(shown).toEqual([]);
    expect(saved).toEqual([300]);
});

test("the rail's and the inspector's edges", () => {
    // In a browser-conditions process, so Solid's renderer and signals are the same copy.
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "--conditions=browser", "test", new URL("./fixtures/gui-resize-handles.ts", import.meta.url).pathname], { timeout: 15000 });
    expect({ code: result.exitCode, output: result.stderr.toString() }).toMatchObject({ code: 0 });
});
