import { expect, test } from "bun:test";
import {
    clampInspectorWidth, clampTerminalHeight, closesOnShrink, floatBottom, floatShort, inspectorMode, railMode,
    requestCloses, reviewWidth, sheetSize, terminalHeight, windowLayout,
} from "../gui/src/lib/layout";

const base = {
    win: { w: 1360, h: 880 }, rail: true, railOpen: false, railWidth: 260, panel: false, review: false, split: false,
    reviewBase: 720, inspectorWidth: 360, terminalShown: false, terminalPreferred: 260, terminalMax: false, dock: 140,
};

test("the rail docks from a 900px window and is a drawer below it", () => {
    expect(railMode(900)).toBe("dock");
    expect(railMode(899)).toBe("overlay");
    expect(windowLayout({ ...base, win: { w: 1024, h: 700 } }).railShown).toBe(true);
    // Docked, the preference decides; as a drawer, whether it's open (the preference doesn't).
    expect(windowLayout({ ...base, rail: false }).railShown).toBe(false);
    expect(windowLayout({ ...base, win: { w: 720, h: 480 } }).railShown).toBe(false);
    expect(windowLayout({ ...base, win: { w: 720, h: 480 }, rail: false, railOpen: true }).railShown).toBe(true);
    expect(windowLayout({ ...base, railOpen: true, rail: false }).railShown).toBe(false);
});

test("the sheet is the window less its 8px inset, and less the rail only while it's docked and on", () => {
    expect(sheetSize({ w: 1360, h: 880 }, true, 260)).toEqual({ w: 1092, h: 864 });
    expect(sheetSize({ w: 1360, h: 880 }, false, 260)).toEqual({ w: 1344, h: 864 });
    expect(windowLayout({ ...base, win: { w: 720, h: 480 } }).sheet).toEqual({ w: 704, h: 464 });
    expect(windowLayout({ ...base, rail: false }).sheet.w).toBe(1344);
});

test("the inspector docks while the conversation keeps 480px, else floats", () => {
    expect(inspectorMode(840, 360)).toBe("dock");
    expect(inspectorMode(839, 360)).toBe("float");
    // 1024 wide with the rail: 756px of sheet, so a 360px panel floats.
    expect(windowLayout({ ...base, win: { w: 1024, h: 700 }, panel: true }).inspector.mode).toBe("float");
    expect(windowLayout({ ...base, panel: true }).inspector).toMatchObject({ open: true, mode: "dock", width: 360 });
    // Hiding the rail can give it room to dock.
    expect(windowLayout({ ...base, win: { w: 1100, h: 700 }, panel: true }).inspector.mode).toBe("float");
    expect(windowLayout({ ...base, win: { w: 1100, h: 700 }, panel: true, rail: false }).inspector.mode).toBe("dock");
});

test("the diff reader widens the inspector: 55% of the sheet up to 860px, 68% up to 1120px side by side", () => {
    expect(reviewWidth(360, 1000, false)).toBe(550);
    expect(reviewWidth(360, 2000, false)).toBe(860);
    expect(reviewWidth(360, 1000, true)).toBe(680);
    expect(reviewWidth(360, 2000, true)).toBe(1120);
    // Never narrower than the width it was given (its own resize handle), even past the cap.
    expect(reviewWidth(720, 1000, false)).toBe(720);
    expect(reviewWidth(900, 2000, false)).toBe(900);
    const l = windowLayout({ ...base, review: true, reviewBase: 420 });
    expect(l.inspector).toMatchObject({ open: true, width: 601, mode: "dock" });
    expect(windowLayout({ ...base, review: true, split: true, reviewBase: 420 }).inspector).toMatchObject({ width: 743, mode: "float" });
});

test("the inspector's resizer stays within 280-620px and keeps it docked", () => {
    expect(clampInspectorWidth(100, 1200)).toBe(280);
    expect(clampInspectorWidth(900, 1200)).toBe(620);
    expect(clampInspectorWidth(600, 1000)).toBe(520);
    // A sheet too narrow to dock even at the minimum: the minimum.
    expect(clampInspectorWidth(500, 600)).toBe(280);
    // A width saved on a bigger window is held to the bounds, not the window.
    expect(windowLayout({ ...base, inspectorWidth: 2000, panel: true }).inspector.width).toBe(620);
});

test("the terminal keeps the conversation 300px and is at least 120px; maximized it's the whole sheet", () => {
    expect(terminalHeight(260, 864, false)).toBe(260);
    expect(terminalHeight(800, 864, false)).toBe(564);
    expect(terminalHeight(50, 864, false)).toBe(120);
    expect(terminalHeight(260, 400, false)).toBe(120);
    expect(terminalHeight(260, 864, true)).toBe(864);
    expect(clampTerminalHeight(900, 864)).toBe(564);
    expect(clampTerminalHeight(40, 864)).toBe(120);
    expect(clampTerminalHeight(300, 300)).toBe(120);
    const shown = windowLayout({ ...base, terminalShown: true, terminalMax: true });
    expect(shown.terminal).toEqual({ shown: true, height: 864, maximized: true, most: 564 });
    // Hidden, it takes no row, maximized or not.
    expect(windowLayout({ ...base, terminalMax: true }).terminal).toMatchObject({ height: 0, maximized: false });
});

test("a floating inspector ends above the dock, or takes the full height when that leaves under 260px", () => {
    // 864 - 0 - 54 - 140 - 8 = 662: room.
    expect(floatShort(864, 0, 140)).toBe(false);
    expect(floatBottom(0, 140, false)).toBe(148);
    // 464 tall (720×480) with a request card: short, so it ends just above the terminal row.
    expect(floatShort(464, 0, 300)).toBe(true);
    expect(floatBottom(120, 300, true)).toBe(128);
    expect(floatShort(54 + 140 + 8 + 260, 0, 140)).toBe(false);
    expect(floatShort(54 + 140 + 8 + 259, 0, 140)).toBe(true);
    const l = windowLayout({ ...base, win: { w: 720, h: 480 }, panel: true, terminalShown: true, dock: 140 });
    // The terminal gets 164px there (the conversation keeps 300), so it ends 8px above it.
    expect(l.inspector).toMatchObject({ mode: "float", short: true, bottom: 172 });
});

test("shrinking past the docking point closes a docked inspector, unless the diff reader is open", () => {
    expect(closesOnShrink("dock", "float", true, false)).toBe(true);
    expect(closesOnShrink("dock", "float", true, true)).toBe(false);
    expect(closesOnShrink("dock", "float", false, false)).toBe(false);
    // Opening it on a narrow window floats it; the first layout closes nothing.
    expect(closesOnShrink("float", "float", true, false)).toBe(false);
    expect(closesOnShrink(undefined, "float", true, false)).toBe(false);
    expect(closesOnShrink("float", "dock", true, false)).toBe(false);
});

test("a request arriving closes a short floating inspector once, not one opened while it shows", () => {
    const short = { mode: "float" as const, short: true };
    // Open, then a request arrives: it closes, once.
    let s = requestCloses(undefined, true, { ...short, open: true });
    expect(s.close).toBe(false);
    s = requestCloses(s.cleared, true, { ...short, request: "a:1", open: true });
    expect(s).toEqual({ close: true, cleared: "a:1" });
    // Opened again while that request still shows: it stays open.
    s = requestCloses(s.cleared, false, { ...short, request: "a:1", open: true });
    expect(s.close).toBe(false);
    // A second request does close it.
    s = requestCloses(s.cleared, true, { ...short, request: "a:1,2", open: true });
    expect(s.close).toBe(true);
    // Opened while a request already showed: that one doesn't close it.
    expect(requestCloses(undefined, false, { ...short, request: "b:1", open: true }).close).toBe(false);
    // Only when floating and short.
    expect(requestCloses(undefined, true, { mode: "dock", short: true, request: "c:1", open: true }).close).toBe(false);
    expect(requestCloses(undefined, true, { mode: "float", short: false, request: "c:1", open: true }).close).toBe(false);
    expect(requestCloses(undefined, false, { ...short, request: "c:1", open: false }).close).toBe(false);
});
