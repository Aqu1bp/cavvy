import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const settings = readFileSync(new URL("../gui/src/styles/settings.css", import.meta.url), "utf8");
const page = settings.match(/\n\.settings-main \{([^}]+)\}/)?.[1] ?? "";
// The page is glass like the rest of the window: the session it covers, kept mounted under it, isn't drawn (shell.css).
const sheet = settings.match(/\n\.settings-sheet \{([^}]+)\}/)?.[1] ?? "";
const shell = readFileSync(new URL("../gui/src/styles/shell.css", import.meta.url), "utf8");
const kit = readFileSync(new URL("../gui/src/styles/kit.css", import.meta.url), "utf8");

test("opening Settings fades in (the design's 0.14s), whatever the Panel animations pref", () => {
    // A fixed duration: --dur and --dur-panel are 0ms under Panel animations → Instant.
    expect(page).toMatch(/animation: fade-in 0\.14s;/);
    expect(page).not.toMatch(/--dur/);
    expect(kit).toMatch(/@keyframes fade-in \{\s*from \{\s*opacity: 0;/);
    // The page doesn't wait for the animation to take clicks.
    expect(page).not.toMatch(/pointer-events/);
    expect(sheet).not.toMatch(/animation|opacity|background/);
    // What it covers is gone from the first frame, by opacity: nothing inside is restyled for it.
    expect(shell).toMatch(/\.main > \.keep\[data-covered\],\s*\.insp\[data-covered\] \{\s*opacity: 0;/);
});

test("the system's reduced-motion setting turns the Settings animation off", () => {
    expect(settings).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.settings-main \{\s*animation: none;/);
});
