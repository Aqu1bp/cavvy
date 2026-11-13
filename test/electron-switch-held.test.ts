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
    // Sent to a session: its conversation, or that it couldn't be opened. Otherwise the new-session screen. Either
    // way, a machine that can't be reached or has a question ends the wait.
    expect(preload).toContain(`const READY = { session: '.turn, .session-opening [role="alert"], .server-asks', home: ".home:not([aria-busy]), .server-asks" };`);
    // The new-session screen waits for what the machine has (it's drawn before that, with no project or model yet).
    expect(read("gui/src/components/Home.tsx")).toContain('<div class="home" aria-busy={!app.sessionsLoaded || undefined} ');
    expect(preload).toContain('watch.observe(document, { childList: true, subtree: true, attributeFilter: ["aria-busy"] });');
    expect(machines).toContain('sessionStorage.setItem("cavvy.navigation", JSON.stringify(session ? { activeId: session } : { homeCwd: folder }));');
    expect(preload).toContain('if (/"activeId"/.test(sessionStorage.getItem("cavvy.navigation") ?? "")) ready = READY.session;');
    expect(preload).toContain("const timer = setTimeout(end, HELD_MS);");
    // The classes it waits for are the ones the window draws.
    expect(read("gui/src/components/Home.tsx")).toContain('<div class="home"');
    expect(read("gui/src/components/TurnView.tsx")).toMatch(/class=\{?[`"]turn[ "`]/);
    expect(read("gui/src/App.tsx")).toMatch(/<div class="session-opening"[^]*?<p role="alert"/);
    expect(read("gui/src/components/Servers.tsx")).toContain('<div class="server-cover" classList={{ "server-asks": asks() }}>');
    // The page under the picture isn't drawn, but is there: the message box takes the keyboard as on any load
    // (hidden, it couldn't, and nothing gives it the keyboard later).
    expect(preload).toContain('style.setProperty("opacity", on ? "0" : "")');
    expect(preload).not.toContain('"visibility"');
    // Where the window goes is written before the picture is taken: what the page that's leaving writes over it
    // meanwhile is put back.
    expect(preload).toMatch(/sent = sessionStorage\.getItem\(NAVIGATION\);[^]*?const go = \(\) => \{[^]*?if \(sent === null\) sessionStorage\.removeItem\(NAVIGATION\);\s+else if \(sent !== undefined\) sessionStorage\.setItem\(NAVIGATION, sent\);[^]*?location\.reload\(\);/);
    expect(read("gui/src/state/app.ts")).toContain('const NAVIGATION_KEY = "cavvy.navigation"');
});
