import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const settings = readFileSync(new URL("../gui/src/styles/settings.css", import.meta.url), "utf8");
const page = settings.match(/\n\.settings-page > \.set-in \{([^}]+)\}/)?.[1] ?? "";
// The page is glass like the rest of the window: the session it covers, kept mounted under it, isn't drawn (shell.css).
const sheet = settings.match(/\n\.settings-page \{([^}]+)\}/)?.[1] ?? "";
const shell = readFileSync(new URL("../gui/src/styles/shell.css", import.meta.url), "utf8");

test("opening Settings fades and rises in at 280ms, whatever the Panel animations pref", () => {
    // A fixed duration: --dur and --dur-panel are 0ms under Panel animations → Instant.
    expect(page).toMatch(/animation: settings-in 280ms var\(--ease\);/);
    expect(page).not.toMatch(/--dur/);
    const frames = settings.match(/@keyframes settings-in \{([\s\S]+?)\n\}/)?.[1] ?? "";
    expect(frames).toMatch(/from \{[^}]*opacity: 0;[^}]*transform: translateY\(4px\);/);
    // The page doesn't wait for the animation to take clicks.
    expect(page).not.toMatch(/pointer-events/);
    expect(sheet).not.toMatch(/animation|opacity|background/);
    // What it covers is gone from the first frame, by opacity: nothing inside is restyled for it.
    expect(shell).toMatch(/\.main > \.keep\[data-covered\],\s*\.insp\[data-covered\] \{\s*opacity: 0;/);
});

test("the system's reduced-motion setting turns the Settings animation off", () => {
    expect(settings).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.settings-page > \.set-in \{\s*animation: none;/);
});
