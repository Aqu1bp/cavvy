// Where the desktop app's window opens (desktop-electron/src/window-state.ts): where it was, if a display still
// shows it; otherwise at its size, centred.
import { expect, test } from "bun:test";
import { DEFAULT_SIZE, MIN_SIZE, restorable } from "../desktop-electron/src/window-state";

const laptop = { x: 0, y: 25, width: 1512, height: 920 };
const external = { x: 1512, y: 0, width: 2560, height: 1415 };

test("nothing saved, or not a state: the default size, centred", () => {
    expect(restorable(undefined, [laptop])).toEqual({ ...DEFAULT_SIZE });
    expect(restorable("junk", [laptop])).toEqual({ ...DEFAULT_SIZE });
    expect(restorable({ width: "wide", x: null }, [laptop])).toEqual({ ...DEFAULT_SIZE });
});

test("where it was, on a display that's there", () => {
    expect(restorable({ x: 1700, y: 100, width: 1400, height: 900, maximized: true }, [laptop, external])).toEqual({ x: 1700, y: 100, width: 1400, height: 900, maximized: true });
});

test("on a display that's gone, or with its top strip off every display: centred, at its size", () => {
    expect(restorable({ x: 1700, y: 100, width: 1400, height: 900 }, [laptop])).toEqual({ width: 1400, height: 900 });
    // Only its bottom edge shows: the strip it's dragged by doesn't.
    expect(restorable({ x: 100, y: -880, width: 1200, height: 900 }, [laptop])).toEqual({ width: 1200, height: 900 });
});

test("a size it can't open at is brought within the window's minimum and the largest display", () => {
    expect(restorable({ width: 100, height: 100 }, [laptop])).toEqual({ ...MIN_SIZE });
    expect(restorable({ width: 9000, height: 9000 }, [laptop, external])).toEqual({ width: 2560, height: 1415 });
});
