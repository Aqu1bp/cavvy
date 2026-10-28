// The composer's control row when it's tight (gui/src/lib/composer-fit.ts): the steps it takes, and the styles
// that carry them out. How it measures is checked in the browser.

import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { fewestSteps, fitWords, FIT_STEPS } from "../gui/src/lib/composer-fit";

test("the steps taken read as the attribute's words, as the column's do", () => {
    expect(fitWords(0)).toBe("");
    expect(fitWords(3)).toBe("1 2 3");
});

test("it takes the fewest steps that fit, trying each in turn, and all of them when none does", () => {
    const tried: number[] = [];
    expect(fewestSteps((n) => (tried.push(n), n >= 2))).toBe(2);
    expect(tried).toEqual([0, 1, 2]);
    expect(fewestSteps(() => true)).toBe(0);
    expect(fewestSteps(() => false)).toBe(FIT_STEPS);
});

test("the styles carry out each step, and the column's width no longer hides the pickers' labels or chevrons", () => {
    const css = readFileSync(new URL("../gui/src/styles/composer.css", import.meta.url), "utf8");
    for (const rule of ['[data-fit~="1"] .pick .lbl', '[data-fit~="2"] .pick .chev', '[data-fit~="3"] .pick-acct', '[data-fit~="4"] .pick.model:has(> svg:not(.chev), > .provider-mono) > .truncate', '[data-fit~="5"] .ctx-btn']) expect(css).toContain(`.composer-bar${rule}`);
    expect(css).not.toContain(".composer .pick .lbl");
    expect(css).not.toContain(".composer .pick .chev");
    const composer = readFileSync(new URL("../gui/src/components/Composer.tsx", import.meta.url), "utf8");
    expect(composer).toContain('<div ref={bar} class="composer-bar">');
    expect(composer).toContain("onMount(() => onCleanup(fitComposerBar(bar!)));");
});
