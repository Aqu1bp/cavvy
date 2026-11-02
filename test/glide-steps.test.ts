// The conversation's glides in steps (gui/src/lib/glide-steps.ts): the same curve, held between steps GLIDE_HZ a
// second apart, and where a running one draws its rows read the same way.
import { expect, test } from "bun:test";
import { cubicBezier, GLIDE_HZ, glideKeyframes, glideOffset } from "../gui/src/lib/glide-steps";

const curve = cubicBezier(0.2, 0.8, 0.2, 1);

test("the curve is CSS's: ends fixed, and the standard ease at its middle", () => {
    expect(curve(0)).toBe(0);
    expect(curve(1)).toBe(1);
    // CSS's `ease` (0.25, 0.1, 0.25, 1) is 0.8024 at half its time.
    expect(cubicBezier(0.25, 0.1, 0.25, 1)(0.5)).toBeCloseTo(0.8024, 3);
    // Ever further along.
    let last = 0;
    for (let t = 0.05; t <= 1; t += 0.05) {
        expect(curve(t)).toBeGreaterThanOrEqual(last);
        last = curve(t);
    }
});

test("a glide is drawn in steps GLIDE_HZ a second apart, from its start to its place", () => {
    const frames = glideKeyframes(-40, 240, curve);
    expect(frames).toHaveLength(Math.round((240 * GLIDE_HZ) / 1000) + 1);
    expect(frames[0]).toMatchObject({ offset: 0, transform: "translateY(-40px)", easing: "step-end" });
    expect(frames.at(-1)).toMatchObject({ offset: 1, transform: "none" });
    // Each step closer than the one before.
    const ys = frames.slice(0, -1).map((f) => Number(/(-?[\d.]+)px/.exec(String(f.transform))![1]));
    for (let i = 1; i < ys.length; i++) expect(Math.abs(ys[i]!)).toBeLessThan(Math.abs(ys[i - 1]!));
    // A glide shorter than a step is one step.
    expect(glideKeyframes(10, 5, curve)).toHaveLength(2);
});

test("where a running glide draws its rows is the step it's on", () => {
    const frames = glideKeyframes(-40, 240, curve);
    const n = frames.length - 1;
    for (let k = 0; k < n; k++) {
        const y = Number(/(-?[\d.]+)px/.exec(String(frames[k]!.transform))![1]);
        // Anywhere within step k: that step's place.
        expect(glideOffset(-40, 240, (k + 0.5) / n, curve)).toBeCloseTo(y, 6);
    }
    expect(glideOffset(-40, 240, 1, curve)).toBeCloseTo(0, 6);
});
