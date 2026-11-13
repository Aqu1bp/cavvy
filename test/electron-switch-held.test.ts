// Going to another machine loads the window again. Left to itself that's a window gone black and then filled in
// piece by piece (measured in the packed app: about 90 ms black, then 270 ms with the conversation missing). The
// desktop app keeps the window's picture on screen until the new page has what it was sent for
// (desktop-electron/src/preload.ts showHeld). What's checked here is that the three sides still say the same things;
// how it looks is checked in the app, frame by frame.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const preload = read("desktop-electron/src/preload.ts");
const main = read("desktop-electron/src/main.ts");
const machines = read("gui/src/lib/machines.ts");

test("the window asks the desktop app to load it again with its picture held; in a browser it just loads again", () => {
    expect(machines).toContain("if (electron?.reloadHeld) electron.reloadHeld();\n    else location.reload();");
    expect(read("gui/src/lib/platform.ts")).toContain("reloadHeld?(): void;");
    expect(preload).toContain("reloadHeld: () => {");
});

test("the picture is taken before the window loads again, given once to the page that comes, and not kept", () => {
    // Taken by the page that's leaving (which the app knows is its own); a slow picture doesn't hold the switch up.
    expect(main).toMatch(/ipcMain\.handle\("hold_frame", async \(e\) => \{\s+if \(!fromGui\(e\) \|\| !win\) return;/);
    expect(preload).toContain('Promise.race([ipcRenderer.invoke("hold_frame"), new Promise((r) => setTimeout(r, 250))]).then(go, go)');
    // Given to the main window's own page only, once, and only while it's fresh.
    expect(main).toMatch(/ipcMain\.on\("held_frame", \(e\) => \{\s+e\.returnValue = fromGui\(e\) && held && Date\.now\(\) - held\.at < HELD_MS \? held\.picture : null;\s+held = undefined;\s+holding\+\+;/);
    expect(preload).toContain('picture = ipcRenderer.sendSync("held_frame");');
    // A picture that's ready only after the page it was for has asked isn't kept for the next switch.
    expect(main).toMatch(/held = undefined;\s+const mine = \+\+holding;\s+const shot = await win\.webContents\.capturePage\(\);\s+if \(mine === holding && !shot\.isEmpty\(\)\) held = /);
    // It never leaves the preload: nothing of it is exposed to the page.
    const bridge = preload.indexOf('contextBridge.exposeInMainWorld("cavvyDesktop"');
    expect(bridge).toBeGreaterThan(0);
    expect(preload.slice(bridge)).not.toContain("held_frame");
});

test("a page that wasn't loaded for a switch asks for nothing, and the picture goes when what it was sent for is there, or after a moment", () => {
    // Only a load marked by the switch looks for a picture: an ordinary start costs nothing.
    expect(preload).toMatch(/if \(!sessionStorage\.getItem\(HELD\)\) return;\s+sessionStorage\.removeItem\(HELD\);/);
    // It goes when the page says its first screen is drawn (as it tells the desktop app on any load), or before that
    // when the machine can't be reached or has a question; or after a moment.
    expect(preload).toMatch(/windowReady: \(\) => \{\s+ipcRenderer\.send\("window_ready"\);\s+shown\?\.\(\);\s+\},/);
    expect(preload).toMatch(/const soon = \(\) => requestAnimationFrame\(\(\) => requestAnimationFrame\(end\)\);\s+shown = soon;/);
    expect(preload).toContain('const ASKS = ".server-asks";');
    expect(preload).toContain("if (document.querySelector(ASKS)) soon();");
    expect(preload).toContain("const timer = setTimeout(end, HELD_MS);");
    expect(read("gui/src/components/Servers.tsx")).toContain('<div class="server-cover" classList={{ "server-asks": asks() }}>');
    // The page says so once what it was sent for is there: its sessions, projects and settings, and the session open.
    expect(read("gui/src/lib/platform.ts")).toMatch(/export function showWindow\(\) \{\s+if \(windowShown\) return;\s+windowShown = true;\s+if \(electron\) return electron\.windowReady\(\);/);
    expect(read("gui/src/state/app.ts")).toMatch(/await restoreActiveSession\(\);[^]*?\/\/ The first screen is drawn, with what it shows: the window comes up on it\.\s+showWindow\(\);/);
    // The page under the picture isn't drawn, but is there: the message box takes the keyboard as on any load
    // (hidden, it couldn't, and nothing gives it the keyboard later).
    expect(preload).toContain('style.setProperty("opacity", on ? "0" : "")');
    expect(preload).not.toContain('"visibility"');
    // Where the window goes is written before the picture is taken: what the page that's leaving writes over it
    // meanwhile is put back.
    expect(preload).toMatch(/sent = sessionStorage\.getItem\(NAVIGATION\);[^]*?const go = \(\) => \{[^]*?if \(sent === null\) sessionStorage\.removeItem\(NAVIGATION\);\s+else if \(sent !== undefined\) sessionStorage\.setItem\(NAVIGATION, sent\);[^]*?location\.reload\(\);/);
    expect(read("gui/src/state/app.ts")).toContain('const NAVIGATION_KEY = "cavvy.navigation"');
    // Of two switches asked for one after the other, the last loads the window.
    expect(preload).toMatch(/const mine = \+\+leaving;[^]*?const go = \(\) => \{[^]*?if \(mine !== leaving\) return;/);
});
