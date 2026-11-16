// The desktop window tells the page whether it can be seen (gui/src/lib/loops.ts stops looping motion when it can't).
// macOS reports a window behind a locked screen as visible and focused, so the lock and sleep feed it too.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const main = readFileSync(join(import.meta.dir, "../desktop-electron/src/main.ts"), "utf8");

test("a locked screen, sleep or a user switch makes the window unseen until each ends", () => {
    for (const e of ["lock-screen", "unlock-screen", "suspend", "resume", "user-did-resign-active", "user-did-become-active"]) {
        expect(main).toContain(`powerMonitor.on("${e}"`);
    }
    // Waking doesn't unlock: each reason is kept on its own.
    expect(main).toContain("why.locked || why.asleep || why.switchedOut");
    expect(main).toMatch(/const seen = !screenAway && w\.isVisible\(\) && !w\.isMinimized\(\);/);
    expect(main).toMatch(/focused: seen && w\.isFocused\(\)/);
});
