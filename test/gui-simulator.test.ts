// The Simulator pane's arithmetic (gui/src/lib/simulator.ts): where the screen is drawn, where a pointer lands on it,
// and what the pane says in place of the screen; and when the agent's use of it is news (gui/src/state/simulator.ts).
import { expect, test } from "bun:test";
import { cornerRadius, deviceDetail, paneNote, placeScreen, SCREEN_MARGIN, screenFraction, takenNote, wheelPaced, wheelStart, wheelSwipesAgain, wheelTurn } from "../gui/src/lib/simulator";
import { adoptSimulatorState, setSimulatorShown, simulatorUnseen } from "../gui/src/state/simulator";
import type { SimulatorDevice, SimulatorState } from "../src/server/protocol";

const IPHONE: SimulatorDevice = { udid: "U", name: "iPhone 17", runtime: "iOS 27.0", state: "booted", kind: "iphone" };

test("the screen fits the pane with a margin, centered, and never past the device's size in points", () => {
    const r = placeScreen({ width: 400, height: 800 }, { width: 1206, height: 2622 }, 3);
    expect(r.height).toBeLessThanOrEqual(800 - 2 * SCREEN_MARGIN);
    expect(r.width / r.height).toBeCloseTo(1206 / 2622, 2);
    expect(r.x).toBe(Math.round((400 - r.width) / 2));
    // A large pane: 402×874 points, not blown up.
    expect(placeScreen({ width: 2000, height: 2000 }, { width: 1206, height: 2622 }, 3)).toMatchObject({ width: 402, height: 874 });
    expect(placeScreen({ width: 100, height: 100 }, { width: 0, height: 0 }, 3).width).toBe(0);
});

test("a pointer lands as a fraction of the screen; off it, nothing, unless clamped to the edge", () => {
    const at = { x: 10, y: 20, width: 200, height: 400 };
    expect(screenFraction({ x: 110, y: 220 }, at)).toEqual({ x: 0.5, y: 0.5 });
    expect(screenFraction({ x: 5, y: 220 }, at)).toBeUndefined();
    expect(screenFraction({ x: 500, y: 0 }, at, true)).toEqual({ x: 1, y: 0 });
});

test("the pane says what the device is doing when its screen isn't showing", () => {
    expect(paneNote({ status: "ready", devices: [IPHONE], device: IPHONE })).toBeUndefined();
    expect(paneNote({ status: "off", devices: [], device: { ...IPHONE, state: "shutdown" } })).toEqual({ title: "iPhone 17 is off", start: true });
    expect(paneNote({ status: "off", devices: [] })).toEqual({ title: "No simulators", detail: "Add one in Xcode." });
    expect(paneNote({ status: "booting", devices: [], device: IPHONE })).toMatchObject({ title: "Starting iPhone 17…", busy: true });
    expect(paneNote({ status: "error", devices: [], device: IPHONE, error: "SimulatorKit has changed" })).toMatchObject({ title: "Can't show iPhone 17", detail: "SimulatorKit has changed", retry: true });
    expect(paneNote(undefined)).toMatchObject({ busy: true });
});

test("the device menu says which run; iPads are drawn less round than iPhones", () => {
    expect(deviceDetail(IPHONE)).toBe("iOS 27.0 · Running");
    expect(deviceDetail({ ...IPHONE, state: "shutdown" })).toBe("iOS 27.0");
    expect(cornerRadius("ipad", 400)).toBeLessThan(cornerRadius("iphone", 400));
});

test("the agent's use is told (a dot on the tab) when it's new, also in a session the window hadn't loaded", () => {
    const ready = (agentAt?: number): SimulatorState => ({ status: "ready", device: IPHONE, devices: [IPHONE], ...(agentAt ? { agentAt } : {}) });
    // Not loaded before: used just now is news, used long ago isn't.
    adoptSimulatorState("fresh", ready(Date.now()));
    expect(simulatorUnseen("fresh")).toBe(true);
    adoptSimulatorState("stale", ready(Date.now() - 60_000));
    expect(simulatorUnseen("stale")).toBe(false);
    // Loaded: any use since is news, until the pane shows.
    adoptSimulatorState("known", ready(1));
    adoptSimulatorState("known", ready(2));
    expect(simulatorUnseen("known")).toBe(true);
    setSimulatorShown("known", true);
    expect(simulatorUnseen("known")).toBe(false);
    setSimulatorShown("known", false);
});

test("what another app took of the device's input is named: all of it is its input", () => {
    expect(takenNote(undefined)).toBeUndefined();
    expect(takenNote([])).toBeUndefined();
    expect(takenNote(["keyboard"])).toBe("Another app took this device's keyboard");
    expect(takenNote(["touch", "buttons"])).toBe("Another app took this device's touch screen and buttons");
    expect(takenNote(["touch", "keyboard", "buttons"])).toBe("Another app took this device's input");
    // Taken over, and what it took couldn't be read: it may have it.
    expect(takenNote(undefined, true)).toBe("Another app may have this device's input");
    expect(takenNote(["keyboard"], true)).toBe("Another app took this device's keyboard");
});

test("a wheel's notch moves the finger at a pace, and stops where it was going", () => {
    const to = { x: 0.5, y: 0.2 };
    const p = wheelPaced({ x: 0.5, y: 0.5 }, to, 100);
    expect(p.x).toBe(0.5);
    expect(p.y).toBeCloseTo(0.445, 3);
    expect(wheelPaced({ x: 0.5, y: 0.21 }, to, 100)).toEqual(to);
});

const wheelRun = (sizes: number[], atEdge = -1) => {
    let s = wheelStart(sizes[0]!);
    let lifted = -1;
    sizes.slice(1).forEach((size, i) => {
        s = wheelTurn(s, size, i + 1 === atEdge);
        if (s.coasting && lifted < 0) lifted = i + 1;
    });
    return { s, lifted };
};

test("a finger reaching the screen's edge lifts", () => {
    expect(wheelRun([10, 12, 14, 16], 2).lifted).toBe(2);
});

test("turns dying down lift the finger, while it's still moving", () => {
    const { lifted } = wheelRun([20, 40, 37, 34, 31, 28, 25, 22, 20, 18, 16]);
    expect(lifted).toBe(7);
});

test("fingers moving on, at any steady pace, keep the finger down", () => {
    expect(wheelRun([30, 30, 30, 30, 30, 30, 30, 30, 30]).lifted).toBe(-1);
    // Slowed well below the swipe's fastest, and then steady.
    expect(wheelRun([40, 10, 10, 10, 10, 10, 10, 10, 10, 10]).lifted).toBe(-1);
    // Uneven, as fingers are: never five turns in a row.
    expect(wheelRun([40, 20, 18, 16, 19, 17, 15, 18, 16, 14, 17]).lifted).toBe(-1);
});

test("once lifted it stays lifted, whatever the turns, until a new swipe", () => {
    const { s } = wheelRun([20, 40, 37, 34, 31, 28, 25, 22, 20]);
    expect(s.coasting).toBe(true);
    expect(wheelTurn(s, 1, false).coasting).toBe(true);
});

test("a turn much larger than the last, while coasting, is a new swipe", () => {
    const coast = { ...wheelStart(40), coasting: true, last: 6 };
    expect(wheelSwipesAgain(coast, 5)).toBe(false);
    expect(wheelSwipesAgain(coast, 8)).toBe(false);
    expect(wheelSwipesAgain(coast, 12)).toBe(true);
    expect(wheelSwipesAgain({ ...coast, coasting: false }, 12)).toBe(false);
    // The last turns of a coast are small: going from 1 to 2 isn't fingers coming back.
    expect(wheelSwipesAgain({ ...coast, last: 1 }, 2)).toBe(false);
});
