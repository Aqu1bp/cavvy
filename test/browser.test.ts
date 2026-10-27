// The browser tools against a real Chrome (CAVVY_TEST_CHROME, or one in its usual place; skipped where there is none):
// a fixture site on 127.0.0.1, and the tools and session the agent and the GUI pane use. One Chrome serves the file: its
// start is the slow part, and each test takes tabs of its own.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isolate, tempDir } from "./helpers/isolate";
import { chromePath, fixtureServer } from "./helpers/browser-fixture";

const iso = isolate();
if (chromePath) process.env.CAVVY_BROWSER = chromePath;
// GitHub's runners can't make Chrome's sandbox (AppArmor blocks user namespaces) and the first start reads Chrome's install
// from a cold disk (see test/helpers/chrome.ts): the limits are several times the slowest start measured there.
const STARTUP_MS = 90_000;
setDefaultTimeout(60_000);

const { BrowserNavigateTool, BrowserSnapshotTool, BrowserActTool, BrowserScreenshotTool, BrowserEvalTool, BrowserLogsTool } = await import("../src/tools/browser-tools");
const { BrowserSession } = await import("../src/browser/session");
const { imageSize } = await import("../src/ui/images");

const site = fixtureServer();
const root = tempDir("cavvy-browser-project-");
const state: any = { cwd: root, projectRoot: root, fileState: new Map(), todos: [], shells: new Map() };
const ctx = (signal = new AbortController().signal) => ({ state, settings: {}, signal }) as any;
let session: InstanceType<typeof BrowserSession>;

const run = async (tool: { run: (i: any, c: any) => Promise<any> }, input: Record<string, unknown>) => tool.run(input, ctx());
const nav = (input: Record<string, unknown>) => run(BrowserNavigateTool, input);
const act = (input: Record<string, unknown>) => run(BrowserActTool, input);
/** The ref of the first line of an outline that has this role and name. */
const refOf = (content: string, role: string, name: string): string => {
    const m = new RegExp(`- ${role} ${JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*?\\[(e\\d+)\\]`).exec(content);
    if (!m) throw new Error(`no ${role} "${name}" in:\n${content}`);
    return m[1]!;
};
const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000) {
    const end = Date.now() + ms;
    while (!(await check())) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(25);
    }
}
/** Opens the fixture's page in a fresh tab of the session. */
async function openMain(): Promise<{ tab: number; content: string }> {
    const r = await nav({ action: "new_tab", url: `${site.url}/` });
    expect(r.isError).toBeFalsy();
    return { tab: session.active!, content: r.content };
}

afterAll(() => {
    site.stop();
    iso.cleanup();
});

describe.skipIf(!chromePath)("the browser tools, with Chrome", () => {
    beforeAll(async () => {
        state.browser = session = new BrowserSession({ root, settings: () => ({}), pool: { startupMs: STARTUP_MS } });
        await session.page();
    }, STARTUP_MS + 10_000);

    afterAll(async () => {
        await session?.dispose();
    });

    test("opening a page returns its outline: roles, names, states, refs, link targets, and the password masked", async () => {
        const { content } = await openMain();
        expect(content).toContain(`Opened ${site.url}/.`);
        expect(content).toContain('"Fixture shop"');
        expect(content).toContain("— loaded");
        expect(content).toContain('- heading "Fixture shop" [e');
        expect(content).toContain("level=1");
        expect(content).toContain('text "Welcome to the shop. Everything is fake."');
        expect(content).toMatch(/- link "Other page" \[e\d+\] -> \/other/);
        expect(content).toMatch(/- checkbox "I agree" \[e\d+\] unchecked/);
        expect(content).toMatch(/- combobox "Size" \[e\d+\] collapsed value="Small"/);
        expect(content).toMatch(/- option "Large" \[e\d+\]/);
        expect(content).toMatch(/- textbox "Password" \[e\d+\] value="\[hidden\]"/);
        expect(content).not.toContain("hunter2");
        expect(content).not.toContain("•");
        await nav({ action: "close_tab", tab: session.active });
    });

    test("click, type with submit and select act with real events, and answer with what changed", async () => {
        const { tab, content } = await openMain();
        const clicked = await act({ action: "click", ref: refOf(content, "button", "Click me") });
        expect(clicked.isError).toBeFalsy();
        expect(clicked.content).toContain('Clicked button "Click me"');
        expect(clicked.content).toContain("Changed since the last snapshot");
        expect(clicked.content).toContain('+   - button "Clicked 1"');

        const typed = await act({ action: "type", ref: refOf(content, "textbox", "Search"), text: "red shoes", submit: true });
        expect(typed.isError).toBeFalsy();
        expect(typed.content).toContain("pressed Enter");
        expect(typed.content).toContain('text "Searched: red shoes"');
        // clear replaces what was there
        const again = await act({ action: "type", ref: refOf(content, "textbox", "Search"), text: "blue", clear: true, submit: true });
        expect(again.content).toContain('text "Searched: blue"');

        const chosen = await act({ action: "select", ref: refOf(content, "combobox", "Size"), value: "Large" });
        expect(chosen.isError).toBeFalsy();
        expect(chosen.content).toContain('Selected "Large"');
        expect(chosen.content).toContain('text "Size: l"');
        const nope = await act({ action: "select", ref: refOf(content, "combobox", "Size"), value: "Huge" });
        expect(nope.isError).toBe(true);
        expect(nope.content).toContain('"Small", "Medium", "Large"');

        const box = await act({ action: "click", ref: refOf(content, "checkbox", "I agree") });
        expect(box.content).toMatch(/checkbox "I agree" \[e\d+\] checked/);
        expect((await run(BrowserEvalTool, { expression: "document.getElementById('agree').checked" })).content).toBe("true");
        await nav({ action: "close_tab", tab });
    });

    test("press sends real keys, with modifiers; scroll and wait follow the page", async () => {
        const { tab, content } = await openMain();
        await act({ action: "type", ref: refOf(content, "textbox", "Search"), text: "abc" });
        const pressed = await act({ action: "press", key: "Control+A" });
        expect(pressed.content).toContain("Pressed Control+A");
        expect((await run(BrowserEvalTool, { expression: "document.getElementById('q').selectionStart + '-' + document.getElementById('q').selectionEnd" })).content).toBe('"0-3"');
        const bad = await act({ action: "press", key: "Banana" });
        expect(bad.isError).toBe(true);
        expect(bad.content).toContain("isn't a key I know");

        const scrolled = await act({ action: "scroll", deltaY: 1500 });
        expect(scrolled.content).toContain("Scrolled the page 1500px down");
        expect(Number((await run(BrowserEvalTool, { expression: "window.scrollY" })).content)).toBeGreaterThan(1000);

        await act({ action: "click", ref: refOf(content, "button", "Later") });
        const waited = await act({ action: "wait", text: "arrived" });
        expect(waited.content).toContain('Found the text "arrived"');
        const missing = await act({ action: "wait", selector: "#never", timeoutMs: 200 });
        expect(missing.content).toContain("Timed out after 200 ms");
        const invalid = await act({ action: "wait", selector: "!!", timeoutMs: 200 });
        expect(invalid.isError).toBe(true);
        expect(invalid.content).toContain("isn't valid");
        const settled = await act({ action: "wait" });
        expect(settled.content).toContain("The page has settled.");
        await nav({ action: "close_tab", tab });
    });

    test("console errors, uncaught exceptions and failed requests are kept, counted in the next report, and clearable", async () => {
        const { tab, content } = await openMain();
        const boom = await act({ action: "click", ref: refOf(content, "button", "Break") });
        expect(boom.content).toMatch(/2 new console errors/);
        const fetched = await act({ action: "click", ref: refOf(content, "button", "Fetch") });
        expect(fetched.content).toMatch(/new console error/);
        const logs = await run(BrowserLogsTool, {});
        expect(logs.content).toContain("error: boom happened");
        expect(logs.content).toContain("exception: Error: late failure");
        expect(logs.content).toMatch(/GET 404 \S+\/missing\.json \(Fetch\)/);
        expect(logs.content).toMatch(/GET FAILED net::ERR_\w+ http:\/\/127\.0\.0\.1:1\/x/);
        expect(logs.content).not.toContain("favicon");
        const only = await run(BrowserLogsTool, { kind: "network", clear: true });
        expect(only.content).not.toContain("Console (");
        expect((await run(BrowserLogsTool, {})).content).toContain("(nothing)");
        await nav({ action: "close_tab", tab });
    });

    test("an alert is accepted and noted; a confirm waits for the agent's answer without hanging anything", async () => {
        const { tab, content } = await openMain();
        const alerted = await act({ action: "click", ref: refOf(content, "button", "Alert") });
        expect(alerted.content).toContain('text "alerted"');
        expect((await run(BrowserLogsTool, { kind: "console" })).content).toContain("dialog: alert: heads up");

        const started = Date.now();
        const asked = await act({ action: "click", ref: refOf(content, "button", "Ask") });
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(asked.content).toContain("A JavaScript confirm dialog is waiting");
        expect(asked.content).toContain('"Really?"');
        // reading still answers; acting says why it can't
        expect((await run(BrowserSnapshotTool, {})).content).toContain("waiting");
        const blocked = await act({ action: "click", ref: refOf(content, "button", "Click me") });
        expect(blocked.isError).toBe(true);
        expect(blocked.content).toContain("Answer it with BrowserAct action=dialog");
        const answered = await act({ action: "dialog", accept: false });
        expect(answered.content).toContain("Dismissed the dialog");
        expect(answered.content).toContain('text "confirm:false"');
        expect((await act({ action: "dialog", accept: true })).content).toContain("No JavaScript dialog is open");
        await nav({ action: "close_tab", tab });
    });

    test("tabs: a popup joins the session's tabs, tabs switch and close, and a missing tab is named", async () => {
        const before = session.tabCount;
        const { tab: first, content } = await openMain();
        const popped = await act({ action: "click", ref: refOf(content, "button", "Popup") });
        expect(popped.content).toContain("Tabs:");
        await until(() => session.tabCount === before + 2, "the popup's tab");
        // The current tab stays the one the agent was on.
        expect(session.active).toBe(first);
        const listed = await nav({ action: "list_tabs" });
        expect(listed.content).toContain("/other");
        const second = session.state().tabs.find((t) => t.url.endsWith("/other"))!;
        const switched = await nav({ action: "switch_tab", tab: second.id });
        await until(() => session.state().tabs.find((t) => t.id === second.id)!.title === "Other page", "the popup's title");
        expect(switched.content).toContain(`Tab [${second.id}]`);
        expect((await run(BrowserEvalTool, { expression: "location.pathname" })).content).toBe('"/other"');
        expect((await run(BrowserEvalTool, { expression: "location.pathname", tab: first })).content).toBe('"/"');
        const closed = await nav({ action: "close_tab", tab: second.id });
        expect(closed.content).toContain(`Closed tab ${second.id}`);
        expect(session.active).toBe(first);
        const gone = await run(BrowserSnapshotTool, { tab: second.id });
        expect(gone.isError).toBe(true);
        expect(gone.content).toContain(`There is no tab ${second.id}`);
        await nav({ action: "close_tab", tab: first });
    });

    test("screenshots are PNGs of the viewport's size, the whole page, or one element", async () => {
        const { tab, content } = await openMain();
        const shot = await run(BrowserScreenshotTool, {});
        expect(shot.images).toHaveLength(1);
        expect(shot.images[0].mediaType).toBe("image/png");
        expect(imageSize(Buffer.from(shot.images[0].data, "base64"))).toEqual({ width: 1280, height: 800 });
        const full = await run(BrowserScreenshotTool, { fullPage: true });
        const size = imageSize(Buffer.from(full.images[0].data, "base64"))!;
        expect(size.width).toBe(1280);
        expect(size.height).toBeGreaterThan(3000);
        const el = await run(BrowserScreenshotTool, { ref: refOf(content, "button", "Click me") });
        const small = imageSize(Buffer.from(el.images[0].data, "base64"))!;
        expect(small.width).toBeLessThan(200);
        expect(small.height).toBeLessThan(60);
        const snap = await run(BrowserSnapshotTool, { screenshot: true });
        expect(snap.images).toHaveLength(1);
        expect((await run(BrowserSnapshotTool, {})).images).toBeUndefined();
        const sized = await nav({ action: "resize", width: 900, height: 500 });
        expect(sized.content).toContain("Resized the viewport to 900×500");
        expect(imageSize(Buffer.from((await run(BrowserScreenshotTool, {})).images[0].data, "base64"))).toEqual({ width: 900, height: 500 });
        await nav({ action: "close_tab", tab });
    });

    test("evaluate returns JSON, describes what JSON can't carry, and reports what throws", async () => {
        const { tab } = await openMain();
        expect((await run(BrowserEvalTool, { expression: "({a: [1, 2], b: 'x'})" })).content).toBe(JSON.stringify({ a: [1, 2], b: "x" }, null, 2));
        expect((await run(BrowserEvalTool, { expression: "Promise.resolve(41 + 1)" })).content).toBe("42");
        expect((await run(BrowserEvalTool, { expression: "undefined" })).content).toBe("undefined");
        expect((await run(BrowserEvalTool, { expression: "[document.body, window, () => 1, 5n]" })).content.replace(/\s/g, "")).toBe('["<body>","[window]","[function]","5n"]');
        const threw = await run(BrowserEvalTool, { expression: "nothingDefined()" });
        expect(threw.isError).toBe(true);
        expect(threw.content).toContain("ReferenceError");
        const big = await run(BrowserEvalTool, { expression: "'x'.repeat(50000)" });
        expect(big.content.length).toBeLessThan(10_200);
        expect(big.content).toContain("more characters");
        await nav({ action: "close_tab", tab });
    });

    test("refs end when the page navigates; an unknown ref and a ref of an element that's gone say what to do", async () => {
        const { tab, content } = await openMain();
        const link = refOf(content, "link", "Other page");
        const bad = await act({ action: "click", ref: "e999" });
        expect(bad.isError).toBe(true);
        expect(bad.content).toContain("Take a new snapshot");
        expect((await act({ action: "click", ref: "banana" })).content).toContain("isn't a ref");
        const went = await act({ action: "click", ref: link });
        expect(went.content).toContain("/other");
        expect(went.content).toContain('- heading "The other page"');
        const stale = await act({ action: "click", ref: link });
        expect(stale.isError).toBe(true);
        expect(stale.content).toContain("stale");
        // an element removed after the snapshot
        await run(BrowserEvalTool, { expression: "document.querySelector('a').remove()" });
        const back = await nav({ action: "back" });
        expect(back.content).toContain("Went back.");
        const fresh = refOf(back.content, "button", "Bottom button");
        await run(BrowserEvalTool, { expression: "document.getElementById('bottom').remove()" });
        const removed = await act({ action: "click", ref: fresh });
        expect(removed.isError).toBe(true);
        expect(removed.content).toContain("no longer on the page");
        const fwd = await nav({ action: "forward" });
        expect(fwd.content).toContain("Went forward.");
        expect((await nav({ action: "forward" })).content).toContain("no later page");
        await nav({ action: "close_tab", tab });
    });

    test("the URL policy: the browser opens nothing but http(s), about:blank and files in the project, even when a page goes there itself", async () => {
        expect(await BrowserNavigateTool.validate!({ url: "chrome://version" }, ctx())).toContain("aren't allowed");
        expect(await BrowserNavigateTool.validate!({ url: "javascript:alert(1)" }, ctx())).toContain("aren't allowed");
        expect(await BrowserNavigateTool.validate!({ url: "data:text/html,hi" }, ctx())).toContain("aren't allowed");
        expect(await BrowserNavigateTool.validate!({ url: "file:///etc/hosts" }, ctx())).toContain("outside it");
        const { tab } = await openMain();
        const page = await session.page(tab);
        // Past the tool's own check: the browser itself refuses a file outside the project, and sends itself away from chrome:.
        await expect(page.goto("file:///etc/hosts")).rejects.toThrow(/doesn't open that kind of address/);
        await page.goto("chrome://version");
        expect(page.url).toBe("about:blank");
        expect(page.console.entries.some((e) => e.text.includes("was blocked"))).toBe(true);
        const read = await run(BrowserSnapshotTool, {});
        expect(read.isError).toBeFalsy();
        await nav({ action: "close_tab", tab });
        // a file inside the project opens
        await Bun.write(`${root}/page.html`, "<title>Local</title><h1>From the project</h1>");
        const local = await nav({ url: `file://${root}/page.html` });
        expect(local.content).toContain('"Local"');
        expect(local.content).toContain("From the project");
        await nav({ action: "close_tab", tab: session.active });
    });

    test("an image or script a page reads from a file outside the project doesn't load, one inside does", async () => {
        const outside = tempDir("cavvy-browser-outside-");
        // 1x1 PNG
        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
        await Bun.write(`${outside}/secret.png`, png);
        await Bun.write(`${root}/inside.png`, png);
        await Bun.write(`${outside}/secret.js`, "window.leaked = true;");
        await Bun.write(`${root}/images.html`, `<title>Images</title><img id="in" src="inside.png"><img id="out" src="file://${outside}/secret.png"><script src="file://${outside}/secret.js"></script>`);
        const r = await nav({ url: `file://${root}/images.html` });
        expect(r.isError, r.content).toBeFalsy();
        const seen = JSON.parse((await run(BrowserEvalTool, { expression: `(async () => { await Promise.all([...document.images].map((i) => i.decode().catch(() => undefined))); return { inside: document.getElementById("in").naturalWidth, outside: document.getElementById("out").naturalWidth, leaked: window.leaked === true }; })()` })).content);
        expect(seen).toEqual({ inside: 1, outside: 0, leaked: false });
        const logs = (await run(BrowserLogsTool, {})).content;
        expect(logs).toContain("Blocked a load of file://");
        await nav({ action: "close_tab", tab: session.active });
    });

    test("a page that is sent to a host a deny rule names doesn't get there, and the console says why", async () => {
        const guarded = new BrowserSession({ root, settings: () => ({}), refuse: (url) => (new URL(url).hostname === "localhost" ? "Denied by permission rule WebFetch(domain:localhost)" : undefined), pool: { startupMs: STARTUP_MS } });
        try {
            const page = await guarded.openTab("agent");
            // fine on its own address; the redirect to another name for the same server is what's refused
            await page.goto(`${site.url}/other`);
            expect(page.url).toBe(`${site.url}/other`);
            await page.goto(`${site.url}/bounce`).catch(() => undefined);
            await until(() => page.console.entries.some((e) => e.text.includes("Denied by permission rule WebFetch(domain:localhost)")), "the console to say why");
            expect(page.url).not.toContain("localhost");
            expect(page.console.entries.some((e) => e.level === "error" && e.text.startsWith("Blocked a load of http://localhost:"))).toBe(true);
        } finally {
            await guarded.dispose();
        }
    });

    test("a failed load says why, and a download is refused and noted", async () => {
        const { tab } = await openMain();
        const refused = await nav({ url: "http://127.0.0.1:9/" });
        expect(refused.isError).toBe(true);
        expect(refused.content).toMatch(/Couldn't load http:\/\/127\.0\.0\.1:9\/: /);
        const missing = await nav({ url: `${site.url}/nothing-here` });
        expect(missing.content).toContain("The page answered HTTP 404.");
        const download = await nav({ url: `${site.url}/download` });
        expect(download.isError).toBe(true);
        expect(download.content).toContain("downloads are blocked");
        await until(() => session.state().tabs.length > 0, "the tab");
        await nav({ action: "close_tab", tab });
    });

    test("when the user uses a tab the agent isn't kept out: its refs still work, and it's told once", async () => {
        const { tab, content } = await openMain();
        const button = refOf(content, "button", "Click me");
        const states: number[] = [];
        const stop = session.onChange(() => states.push(Date.now()));
        // Moving the pointer isn't using the tab.
        await session.input({ kind: "mouse", type: "move", x: 40, y: 40 }, tab);
        expect(session.state().tabs.find((t) => t.id === tab)!.owner).toBe("agent");
        // A click is, and it reaches the page.
        const box = JSON.parse((await run(BrowserEvalTool, { expression: "(() => { const r = document.getElementById('count').getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()" })).content);
        await session.input({ kind: "mouse", type: "down", ...box, button: "left", buttons: 1, clickCount: 1 }, tab);
        await session.input({ kind: "mouse", type: "up", ...box, button: "left", buttons: 0, clickCount: 1 }, tab);
        await until(() => states.length > 0, "the state announcement");
        stop();
        expect(session.state().tabs.find((t) => t.id === tab)!.owner).toBe("human");
        // the agent's ref from before their click still names the button, and it hears the user was there
        const clicked = await act({ action: "click", ref: button });
        expect(clicked.isError).toBeFalsy();
        expect(clicked.content).toContain("The user has used this tab since you last read it");
        expect(session.state().tabs.find((t) => t.id === tab)!.owner).toBe("agent");
        const read = await run(BrowserSnapshotTool, {});
        expect(read.content).toContain('button "Clicked 2"');
        expect(read.content).not.toContain("The user has used this tab");
        // typing in the pane is using it too
        await session.input({ kind: "key", type: "down", key: "a", code: "KeyA", modifiers: 0 }, tab);
        expect(session.state().tabs.find((t) => t.id === tab)!.owner).toBe("human");
        await session.input({ kind: "key", type: "up", key: "a", code: "KeyA", modifiers: 0 }, tab);
        await nav({ action: "close_tab", tab });
    });

    test("the pane drives the page: text, keys, the address bar and the dialog", async () => {
        const { tab } = await openMain();
        const q = JSON.parse((await run(BrowserEvalTool, { expression: "(() => { const r = document.getElementById('q').getBoundingClientRect(); return {x: r.x + 10, y: r.y + 5}; })()" })).content);
        await session.input({ kind: "mouse", type: "down", ...q, button: "left", buttons: 1, clickCount: 1 }, tab);
        await session.input({ kind: "mouse", type: "up", ...q, button: "left", buttons: 0, clickCount: 1 }, tab);
        await session.input({ kind: "key", type: "down", key: "h", code: "KeyH", modifiers: 0 }, tab);
        await session.input({ kind: "key", type: "up", key: "h", code: "KeyH", modifiers: 0 }, tab);
        await session.input({ kind: "text", text: "ello" }, tab);
        expect((await run(BrowserEvalTool, { expression: "document.getElementById('q').value" })).content).toContain('"hello"');
        await session.input({ kind: "wheel", x: 100, y: 100, deltaX: 0, deltaY: 400 }, tab);
        const shown = await session.page(tab);
        await until(async () => (await shown.send("Runtime.evaluate", { expression: "scrollY" })).result.value === 400, "the page to scroll");
        // a confirm opened by the page, answered from the pane
        const asked = await act({ action: "click", ref: refOf((await run(BrowserSnapshotTool, {})).content, "button", "Ask") });
        expect(asked.content).toContain("confirm dialog is waiting");
        expect(session.state().tabs.find((t) => t.id === tab)!.dialog?.type).toBe("confirm");
        await session.answerDialog(true, undefined, tab);
        await until(() => session.state().tabs.find((t) => t.id === tab)!.dialog === undefined, "the dialog to close");
        expect((await run(BrowserEvalTool, { expression: "document.getElementById('out').textContent" })).content).toBe('"confirm:true"');
        // the address bar: a person's input is checked like the agent's
        await session.command({ command: "goto", url: `${site.url}/other`, tab });
        expect(session.state().tabs.find((t) => t.id === tab)!.url).toBe(`${site.url}/other`);
        await expect(session.command({ command: "goto", url: "chrome://version", tab })).rejects.toThrow();
        await expect(session.command({ command: "goto", url: "not an address", tab })).rejects.toThrow("isn't an address");
        await session.command({ command: "back", tab });
        expect(session.state().tabs.find((t) => t.id === tab)!.url).toBe(`${site.url}/`);
        expect(session.state().tabs.find((t) => t.id === tab)!.canGoForward).toBe(true);
        await nav({ action: "close_tab", tab });
        // a tab the person opens is theirs to begin with; the agent can still act in it
        await session.command({ command: "new_tab", url: `${site.url}/other` });
        const theirs = session.state().tabs.find((t) => t.id === session.active)!;
        expect(theirs.owner).toBe("human");
        expect((await act({ action: "press", key: "Tab" })).isError).toBeFalsy();
        expect(session.state().tabs.find((t) => t.id === theirs.id)!.owner).toBe("agent");
        await session.command({ command: "close_tab", tab: theirs.id });
    });

    test("frames of the current tab stream to a watching pane one at a time, at its size, and stop when it leaves", async () => {
        const { tab } = await openMain();
        const frames: { width: number; height: number; data: string; tab: number; frameId: string }[] = [];
        const key = {};
        let acking = false;
        session.watch(
            key,
            (f, frameId) => {
                frames.push({ ...f, frameId });
                if (acking) queueMicrotask(() => session.ack(key, frameId));
            },
            { width: 700, height: 500, scale: 2 },
        );
        await until(() => frames.length >= 1, "the first frame");
        expect(frames[0]!.width).toBe(700);
        expect(frames[0]!.height).toBe(500);
        expect(frames[0]!.tab).toBe(tab);
        const jpeg = Buffer.from(frames[0]!.data, "base64");
        expect(jpeg.subarray(0, 3).toString("hex")).toBe("ffd8ff");
        expect(imageSize(jpeg)).toEqual({ width: 1400, height: 1000 });
        // the page follows the pane's size
        expect((await run(BrowserEvalTool, { expression: "[innerWidth, innerHeight]" })).content.replace(/\s/g, "")).toBe("[700,500]");
        // nothing more is sent until the pane has taken this one; then the latest waits for it
        const before = frames.length;
        await run(BrowserEvalTool, { expression: "document.body.style.background = 'red'" });
        await Bun.sleep(300);
        expect(frames.length).toBe(before);
        session.ack(key, frames.at(-1)!.frameId);
        await until(() => frames.length > before, "the frame that waited");
        // a screenshot is the same size whatever the pane's scale
        const shot = await run(BrowserScreenshotTool, {});
        expect(imageSize(Buffer.from(shot.images[0].data, "base64"))).toEqual({ width: 700, height: 500 });
        // resizing the pane resizes the page
        acking = true;
        session.ack(key, frames.at(-1)!.frameId);
        session.resize({ width: 640, height: 400, scale: 1 });
        await until(() => frames.at(-1)!.width === 640, "a frame at the new size");
        session.unwatch(key);
        // with nobody watching, the page is back at the agent's size
        await until(() => (session as any).tabs.get(tab).viewport.width === 1280, "the agent's size");
        expect((await run(BrowserEvalTool, { expression: "[innerWidth, innerHeight]" })).content.replace(/\s/g, "")).toBe("[1280,800]");
        await nav({ action: "close_tab", tab });
    });

    test("sessions of one project share a browser, and each has its own tabs", async () => {
        const other = new BrowserSession({ root, settings: () => ({}), pool: { startupMs: STARTUP_MS } });
        try {
            const mine = await session.page();
            const theirs = await other.page();
            const pid = (s: typeof session) => (s as any).pool.pid as number;
            expect(pid(other)).toBe(pid(session));
            expect(other.tabCount).toBe(1);
            await other.dispose();
            // the other session leaving closes its tab only
            expect(alive(pid(session))).toBe(true);
            expect(session.tabCount).toBeGreaterThan(0);
            expect(mine.closed).toBe(false);
            expect(theirs.closed).toBe(true);
        } finally {
            await other.dispose();
        }
    });
});

describe.skipIf(!chromePath)("the browser's life", () => {
    test("it starts with the first page and ends with the last session: no process is left", async () => {
        const mine = new BrowserSession({ root: tempDir("cavvy-browser-life-"), settings: () => ({}), pool: { startupMs: STARTUP_MS } });
        expect(mine.state().status).toBe("idle");
        await mine.page();
        expect(mine.state().status).toBe("ready");
        const pid = (mine as any).pool.pid as number;
        expect(alive(pid)).toBe(true);
        // Driven over its pipe: Chrome opened no port for anything else on the machine to drive it by (it writes this file when it does).
        if (process.platform !== "win32") expect(existsSync(join((mine as any).pool.chrome.profile, "DevToolsActivePort"))).toBe(false);
        await mine.dispose();
        await until(() => !alive(pid), "the browser to end");
    }, STARTUP_MS + 10_000);

    test("it ends after sitting idle, says so, and starts again with the next page", async () => {
        const mine = new BrowserSession({ root: tempDir("cavvy-browser-idle-"), settings: () => ({}), pool: { startupMs: STARTUP_MS, idleMs: 2000 } });
        try {
            await mine.page();
            const pid = (mine as any).pool.pid as number;
            await until(() => !alive(pid), "the idle browser to end");
            expect(mine.tabCount).toBe(0);
            const gone = await mine.page(1).catch((e: Error) => e);
            expect((gone as Error).message).toContain("closed after sitting idle");
            await mine.page(undefined, { open: true });
            expect(mine.state().status).toBe("ready");
            expect(alive((mine as any).pool.pid)).toBe(true);
        } finally {
            await mine.dispose();
        }
    }, STARTUP_MS + 20_000);

    test("a browser that dies is reported as a tool error and starts again with the next call", async () => {
        const dir = tempDir("cavvy-browser-crash-");
        const mine = new BrowserSession({ root: dir, settings: () => ({}), pool: { startupMs: STARTUP_MS } });
        const crashState: any = { cwd: dir, projectRoot: dir, fileState: new Map(), todos: [], shells: new Map(), browser: mine };
        const call = (tool: any, input: Record<string, unknown>) => tool.run(input, { state: crashState, settings: {}, signal: new AbortController().signal });
        try {
            const opened = await call(BrowserNavigateTool, { url: `${site.url}/` });
            expect(opened.isError, opened.content).toBeFalsy();
            const pid = (mine as any).pool.pid as number;
            process.kill(-pid, "SIGKILL");
            await until(() => mine.state().status === "crashed", "the crash to be noticed");
            expect(mine.tabCount).toBe(0);
            const lost = await call(BrowserSnapshotTool, { tab: 1 });
            expect(lost.isError).toBe(true);
            expect(lost.content).toContain("stopped unexpectedly");
            const again = await call(BrowserNavigateTool, { url: `${site.url}/other` });
            expect(again.isError).toBeFalsy();
            expect(again.content).toContain("The other page");
            expect((mine as any).pool.pid).not.toBe(pid);
        } finally {
            await mine.dispose();
        }
    }, STARTUP_MS + 20_000);
});
