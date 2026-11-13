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
    expect(preload).toMatch(/const held = sessionStorage\.getItem\(HELD\);\s+if \(!held\) return;\s+sessionStorage\.removeItem\(HELD\);/);
    // It goes when the page says its first screen is drawn (as it tells the desktop app on any load), or before that
    // when the machine can't be reached or has a question; or after a moment.
    expect(preload).toMatch(/windowReady: \(\) => \{\s+ipcRenderer\.send\("window_ready"\);\s+shown\?\.\(\);\s+\},/);
    expect(preload).toContain("const soon = (then: () => void) => requestAnimationFrame(() => requestAnimationFrame(then));");
    expect(preload).toContain('const ASKS = ".server-asks";');
    expect(preload).toMatch(/if \(revealing \|\| !\(ready \|\| document\.querySelector\(ASKS\)\)\) return;\s+revealing = true;\s+soon\(reveal\);/);
    expect(preload).toMatch(/shown = \(\) => \{\s+ready = true;\s+settled\(\);\s+\};/);
    expect(read("gui/src/components/Servers.tsx")).toContain('<div class="server-cover" classList={{ "server-asks": asks() }}>');
    // A side panel still fetching what it shows doesn't keep the conversation waiting, and isn't shown as a spinner:
    // where it stands where it stood before the switch, the picture stays over it alone until its content is in.
    expect(preload).toContain('const PANEL = "aside.panel";');
    expect(preload).toContain('const PANEL_BUSY = `${PANEL} [aria-busy="true"]`;');
    // (However else that markup changes: what's needed is an aside of class panel, and aria-busy="true" in it.)
    expect(read("gui/src/components/RightPanel.tsx")).toMatch(/<aside\b[^>]*\bclass="panel\b/);
    expect(read("gui/src/components/RightPanel.tsx")).toMatch(/<div\b[^>]*\baria-busy="true"/);
    expect(preload).toContain('sessionStorage.setItem(HELD, place(document.querySelector(PANEL)) || "1");');
    expect(preload).toMatch(/if \(!panel \|\| !panelWas \|\| place\(panel\) !== panelWas \|\| !document\.querySelector\(PANEL_BUSY\)\) return end\(\);\s+up = "panel";/);
    expect(preload).toMatch(/img\.style\.clipPath = `inset\(\$\{r\.top\}px \$\{innerWidth - r\.right\}px \$\{innerHeight - r\.bottom\}px \$\{r\.left\}px\)`;\s+img\.style\.pointerEvents = "none";\s+hide\(false\);\s+clearTimeout\(timer\);\s+timer = setTimeout\(end, PANEL_MS\);/);
    expect(preload).toContain('if (up === "panel") return void ((document.querySelector(PANEL_BUSY) && place(document.querySelector(PANEL)) === panelWas) || soon(end));');
    expect(preload).toContain('addEventListener("resize", end, { once: true });');
    // Nothing slides into place under the picture (a panel that was open would be seen sliding in again), and what
    // changes after it moves as ever.
    expect(preload).toContain('const STILL = "*,*::before,*::after{transition:none!important}";');
    expect(preload).toMatch(/for \(const a of document\.getAnimations\(\)\) \{\s+try \{\s+if \(a\.timeline === document\.timeline && a\.effect\?\.getComputedTiming\(\)\.endTime !== Infinity\) a\.finish\(\);/);
    expect(preload).toMatch(/img\.remove\(\);\s+\/\/[^\n]*\n\s+requestAnimationFrame\(\(\) => still\.remove\(\)\);/);
    expect(preload).toContain("let timer = setTimeout(end, HELD_MS);");
    // The page says so through the same call as on any load, and after a second whatever it has: the picture's own
    // limit is that second.
    expect(read("gui/src/lib/platform.ts")).toContain("electron.windowReady()");
    expect(read("gui/src/state/app.ts")).toContain("const SHOW_WINDOW_MS = 1000;");
    expect(preload).toContain("const HELD_MS = 1000;");
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
