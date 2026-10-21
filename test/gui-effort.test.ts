// The effort bars: which levels a model takes, how keys and the pointer move
// along them (lib/effort.ts), and the EffortBars control itself
// (fixtures/gui-effort-bars.ts, real Solid reactivity in an in-memory DOM).
import { expect, test } from "bun:test";
import { EFFORTS, effortAt, effortKey, effortLevels, effortOf, takesEffort } from "../gui/src/lib/effort";

const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey", boolean>> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });

test("a model's levels: the ones it names, in order; none named means all five", () => {
    expect(effortLevels(undefined).map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortLevels({ effortLevels: [] }).map((e) => e.id)).toEqual(EFFORTS.map((e) => e.id));
    expect(effortLevels({ effortLevels: ["max", "low", "high"] }).map((e) => e.id)).toEqual(["low", "high", "max"]);
    expect(takesEffort(undefined)).toBe(false);
    expect(takesEffort({ supportsReasoning: false })).toBe(false);
    expect(takesEffort({ supportsReasoning: true })).toBe(true);
    expect(takesEffort({ effortLevels: ["low"] })).toBe(true);
    // The glyph fills by the level's place among all five, whatever the model takes.
    expect(effortOf("xhigh")?.lv).toBe(4);
    expect(effortOf(undefined)).toBeUndefined();
});

test("keys: arrows step and stop at the ends, Home/End jump, 1-n pick, anything else is left alone", () => {
    expect(effortKey(key("ArrowRight"), 1, 4)).toBe(2);
    expect(effortKey(key("ArrowUp"), 1, 4)).toBe(2);
    expect(effortKey(key("ArrowLeft"), 1, 4)).toBe(0);
    expect(effortKey(key("ArrowDown"), 1, 4)).toBe(0);
    expect(effortKey(key("ArrowRight"), 3, 4)).toBe(3);
    expect(effortKey(key("ArrowLeft"), 0, 4)).toBe(0);
    // Nothing picked yet (the model's default): right starts at the bottom, left at the top.
    expect(effortKey(key("ArrowRight"), -1, 4)).toBe(0);
    expect(effortKey(key("ArrowLeft"), -1, 4)).toBe(3);
    expect(effortKey(key("Home"), 2, 4)).toBe(0);
    expect(effortKey(key("End"), 0, 4)).toBe(3);
    expect(effortKey(key("1"), 3, 4)).toBe(0);
    expect(effortKey(key("4"), 0, 4)).toBe(3);
    expect(effortKey(key("5"), 0, 4)).toBeUndefined();
    expect(effortKey(key("0"), 0, 4)).toBeUndefined();
    expect(effortKey(key("Enter"), 0, 4)).toBeUndefined();
    expect(effortKey(key("a"), 0, 4)).toBeUndefined();
    // Shortcuts with modifiers (⌘1 picks a model elsewhere) aren't the bars'.
    for (const mod of ["metaKey", "ctrlKey", "altKey"] as const) expect(effortKey(key("2", { [mod]: true }), 0, 4)).toBeUndefined();
    expect(effortKey(key("ArrowRight"), 0, 0)).toBeUndefined();
});

test("the pointer: the bar under it, clamped to the row", () => {
    expect(effortAt(0, 0, 100, 4)).toBe(0);
    expect(effortAt(24.9, 0, 100, 4)).toBe(0);
    expect(effortAt(25, 0, 100, 4)).toBe(1);
    expect(effortAt(99, 0, 100, 4)).toBe(3);
    expect(effortAt(100, 0, 100, 4)).toBe(3);
    expect(effortAt(-40, 0, 100, 4)).toBe(0);
    expect(effortAt(500, 0, 100, 4)).toBe(3);
    expect(effortAt(150, 100, 100, 5)).toBe(2);
    expect(effortAt(10, 0, 0, 4)).toBe(0);
});

// Each runs its namesake in fixtures/gui-effort-bars.ts, in a browser-conditions
// process, so Solid's renderer and signals are the same copy.
const fixture = (name: string) =>
    test(name, () => {
        const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
        const result = Bun.spawnSync([process.execPath, "--no-env-file", "--conditions=browser", "test", new URL("./fixtures/gui-effort-bars.ts", import.meta.url).pathname, "-t", pattern], { timeout: 15000 });
        const output = result.stderr.toString();
        expect({ code: result.exitCode, output }).toMatchObject({ code: 0 });
        expect(output).toContain(" 1 pass");
    });

fixture("EffortBars: fills to the value, previews on hover, applies on click, drag and keys");
fixture("EffortBars: a secondary or middle press changes nothing and starts no drag");
