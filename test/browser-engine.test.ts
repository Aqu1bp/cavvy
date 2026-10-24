// The browser engine without a real Chrome: the DevTools client against a scripted server, and starting, stopping and losing a
// browser, its tabs, who drives them, and what a page may load, against a stand-in that opens a DevTools endpoint the way
// Chrome does (test/helpers/fake-chrome-main.ts). What only a real Chrome can show is in test/browser.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { fakeChromeAt, fakeChromeProgram } from "./helpers/fake-chrome";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const program = fakeChromeProgram();
process.env.HARNESS_BROWSER = program;
setDefaultTimeout(30_000);

const { CdpClient, CdpError } = await import("../src/browser/cdp");
const { chromeArgs, forgetChromeLookup, launchChrome } = await import("../src/browser/chrome");
const { BrowserSession } = await import("../src/browser/session");
const { BrowserNavigateTool, BrowserSnapshotTool, BrowserActTool, BrowserScreenshotTool, BrowserEvalTool, BrowserLogsTool } = await import("../src/tools/browser-tools");
const { projectStateDir } = await import("../src/config/paths");

afterAll(iso.cleanup);

/** The ref of the first line of an outline that has this role and name. */
const refOf = (outline: string, role: string, name: string): string => {
    const m = new RegExp(`- ${role} ${JSON.stringify(name)}[^\\n]*?\\[(e\\d+)\\]`).exec(outline);
    if (!m) throw new Error(`no ${role} "${name}" in:\n${outline}`);
    return m[1]!;
};
const pidOf = (s: { [k: string]: any }): number => s.pool.pid;
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
        await Bun.sleep(20);
    }
}

// ---------------------------------------------------------------------------

describe("the DevTools client", () => {
    type Msg = { id: number; method: string; params: any; sessionId?: string };
    const received: Msg[] = [];
    let replyLater: (() => void)[] = [];
    const server = Bun.serve<undefined>({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
        websocket: {
            message(ws, raw) {
                const m = JSON.parse(String(raw)) as Msg;
                received.push(m);
                const reply = (body: object) => ws.send(JSON.stringify({ id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), ...body }));
                switch (m.method) {
                    case "Hold":
                        // answered when the test says, in any order
                        replyLater.push(() => reply({ result: { held: m.params.name } }));
                        return;
                    case "Fail":
                        return reply({ error: { code: -32000, message: "No such thing" } });
                    case "Silence":
                        return;
                    case "Events":
                        ws.send(JSON.stringify({ method: "Page.loadEventFired", params: { n: 1 }, sessionId: "S1" }));
                        ws.send(JSON.stringify({ method: "Page.loadEventFired", params: { n: 2 } }));
                        ws.send(JSON.stringify({ method: "Other.thing", params: {} }));
                        return reply({ result: {} });
                    case "Bye":
                        reply({ result: {} });
                        return ws.close();
                    default:
                        // a result with nothing in it is {}
                        return reply(m.method === "Empty" ? {} : { result: { echo: m.params } });
                }
            },
        },
    });
    const url = `ws://127.0.0.1:${server.port}/`;
    afterAll(() => void server.stop(true));
    afterEach(() => {
        received.length = 0;
        replyLater = [];
    });

    test("answers go to the command they are for, in whatever order they arrive", async () => {
        const c = await CdpClient.connect(url);
        const a = c.send("Hold", { name: "a" });
        const b = c.send("Hold", { name: "b" });
        const plain = await c.send("Echo", { x: 1 });
        expect(plain).toEqual({ echo: { x: 1 } });
        await until(() => replyLater.length === 2, "both commands to arrive");
        replyLater[1]!();
        expect(await b).toEqual({ held: "b" });
        replyLater[0]!();
        expect(await a).toEqual({ held: "a" });
        expect(await c.send("Empty")).toEqual({});
        c.close();
    });

    test("a command for a page carries its session", async () => {
        const c = await CdpClient.connect(url);
        await c.send("Echo", {}, "S9");
        await c.send("Echo", {});
        expect(received.map((m) => m.sessionId)).toEqual(["S9", undefined]);
        expect(received[0]!.id).not.toBe(received[1]!.id);
        c.close();
    });

    test("a refused command rejects with the browser's message and code", async () => {
        const c = await CdpClient.connect(url);
        const e = (await c.send("Fail").catch((x) => x)) as InstanceType<typeof CdpError>;
        expect(e).toBeInstanceOf(CdpError);
        expect(e.message).toBe("Fail: No such thing");
        expect(e.code).toBe(-32000);
        // and the connection is as good as before
        expect(await c.send("Echo", { ok: true })).toEqual({ echo: { ok: true } });
        c.close();
    });

    test("a command that is never answered gives up after its time, and a late answer harms nothing", async () => {
        const c = await CdpClient.connect(url);
        const e = (await c.send("Silence", {}, undefined, 60).catch((x) => x)) as Error;
        expect(e.message).toBe("Silence timed out after 60 ms");
        const slow = c.send("Hold", { name: "late" }, undefined, 60).catch((x) => x as Error);
        expect((await slow).message).toContain("timed out");
        await until(() => replyLater.length === 1, "the held command");
        replyLater[0]!();
        expect(await c.send("Echo", { fine: 1 })).toEqual({ echo: { fine: 1 } });
        c.close();
    });

    test("events reach whoever listens to them by name, with the page they came from, until they stop", async () => {
        const c = await CdpClient.connect(url);
        const seen: [unknown, string | undefined][] = [];
        const off = c.on("Page.loadEventFired", (p, s) => seen.push([p, s]));
        const second: unknown[] = [];
        c.on("Page.loadEventFired", (p) => second.push(p));
        await c.send("Events");
        expect(seen).toEqual([[{ n: 1 }, "S1"], [{ n: 2 }, undefined]]);
        expect(second).toHaveLength(2);
        off();
        await c.send("Events");
        expect(seen).toHaveLength(2);
        expect(second).toHaveLength(4);
        c.close();
    });

    test("a listener that throws doesn't keep the others from hearing", async () => {
        const quiet = spyOn(console, "error").mockImplementation(() => undefined);
        try {
            const c = await CdpClient.connect(url);
            const heard: unknown[] = [];
            c.on("Page.loadEventFired", () => {
                throw new Error("bad listener");
            });
            c.on("Page.loadEventFired", (p) => heard.push(p));
            await c.send("Events");
            expect(heard).toHaveLength(2);
            expect(quiet).toHaveBeenCalled();
            c.close();
        } finally {
            quiet.mockRestore();
        }
    });

    test("closing it fails what's waiting, once, and says why to whoever asked", async () => {
        const c = await CdpClient.connect(url);
        const waiting = c.send("Silence").catch((x) => x as Error);
        const why: string[] = [];
        c.onClose((r) => why.push(r));
        c.close();
        expect((await waiting).message).toBe("The browser is closed");
        c.close();
        expect(why).toEqual(["The browser is closed"]);
        expect(c.closed).toBe(true);
        expect(((await c.send("Echo").catch((x) => x)) as Error).message).toBe("The browser is closed");
        // asking after it is gone is told at once
        const late: string[] = [];
        c.onClose((r) => late.push(r));
        expect(late).toEqual(["The browser is closed"]);
    });

    test("the other end closing it is told as the connection having closed", async () => {
        const c = await CdpClient.connect(url);
        const why = new Promise<string>((resolve) => c.onClose(resolve));
        await c.send("Bye");
        expect(await why).toBe("The connection to the browser closed");
        expect(c.closed).toBe(true);
    });

    test("opening fails with a reason when nothing is there, nothing answers, or the caller gives up", async () => {
        const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
        const deadUrl = `ws://127.0.0.1:${dead.port}/`;
        dead.stop(true);
        expect(((await CdpClient.connect(deadUrl).catch((x) => x)) as Error).message).toBe("Couldn't connect to the browser");
        // a port that accepts and says nothing
        const mute = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
        try {
            const slow = (await CdpClient.connect(`ws://127.0.0.1:${mute.port}/`, { timeoutMs: 100 }).catch((x) => x)) as Error;
            expect(slow.message).toBe("The browser didn't accept a connection within 100 ms");
            const stop = new AbortController();
            const cancelled = CdpClient.connect(`ws://127.0.0.1:${mute.port}/`, { signal: stop.signal }).catch((x) => x as Error);
            stop.abort();
            expect((await cancelled).message).toBe("Connecting to the browser was cancelled");
            expect(((await CdpClient.connect(url, { signal: AbortSignal.abort() }).catch((x) => x)) as Error).message).toBe("Connecting to the browser was cancelled");
        } finally {
            mute.stop(true);
        }
    });
});

// ---------------------------------------------------------------------------

describe("starting the browser", () => {
    const stops: (() => Promise<void>)[] = [];
    afterEach(async () => {
        delete process.env.FAKE_CHROME;
        for (const stop of stops.splice(0)) await stop();
    });

    test("is chosen to run headless with a private profile, no first-run pages, and Chrome's sandbox only where it can't be had", () => {
        const base = { profile: "/p", headless: true };
        const mac = chromeArgs({ ...base, platform: "darwin", uid: 501 });
        expect(mac[0]).toBe("--headless=new");
        expect(mac).toContain("--remote-debugging-port=0");
        expect(mac).toContain("--user-data-dir=/p");
        expect(mac).toContain("--use-mock-keychain");
        expect(mac).not.toContain("--no-sandbox");
        expect(mac.at(-1)).toBe("about:blank");
        expect(chromeArgs({ ...base, platform: "linux", uid: 1000 })).toContain("--password-store=basic");
        // root can't have it, nor can a CI runner; and a window is for watching it work
        expect(chromeArgs({ ...base, platform: "linux", uid: 0 })).toEqual(expect.arrayContaining(["--no-sandbox", "--disable-dev-shm-usage"]));
        expect(chromeArgs({ ...base, platform: "darwin", uid: 501, ci: true })).toContain("--no-sandbox");
        expect(chromeArgs({ ...base, platform: "win32", ci: true })).not.toContain("--disable-dev-shm-usage");
        expect(chromeArgs({ ...base, headless: false, platform: "linux", uid: 1000 })).not.toContain("--headless=new");
    });

    test("waits for its endpoint, checks it is that browser's, and stops with its whole process group", async () => {
        const profile = join(tempDir("harness-browser-profile-"), "p");
        const chrome = await launchChrome({ executable: program, profile, startupMs: 20_000 });
        stops.push(() => chrome.stop());
        expect(chrome.profile).toBe(profile);
        expect(chrome.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/fake$/);
        expect(alive(chrome.pid)).toBe(true);
        // it leads a group of its own, so its helpers end with it
        expect(() => process.kill(-chrome.pid, 0)).not.toThrow();
        const cdp = await CdpClient.connect(chrome.wsUrl);
        expect(await cdp.send("Target.setDiscoverTargets", { discover: true })).toEqual({});
        cdp.close();
        await chrome.stop();
        expect(alive(chrome.pid)).toBe(false);
        // stopping a stopped one is nothing
        await chrome.stop();
    });

    test("is told why when it exits first, with what it said", async () => {
        process.env.FAKE_CHROME = "exit";
        const profile = join(tempDir("harness-browser-profile-"), "p");
        const e = (await launchChrome({ executable: program, profile, startupMs: 20_000 }).catch((x) => x)) as Error;
        expect(e.message).toContain("The browser exited before opening its DevTools endpoint (21)");
        expect(e.message).toContain("The browser said:\nfake chrome: refusing to start");
    });

    test("gives up on one that never opens its endpoint, and leaves nothing running", async () => {
        process.env.FAKE_CHROME = "silent";
        const profile = join(tempDir("harness-browser-profile-"), "p");
        const started = Date.now();
        const e = (await launchChrome({ executable: program, profile, startupMs: 400 }).catch((x) => x)) as Error;
        expect(e.message).toContain("The browser didn't open its DevTools endpoint within 400 ms");
        expect(Date.now() - started).toBeLessThan(10_000);
        const cancelled = new AbortController();
        const pending = launchChrome({ executable: program, profile: join(tempDir("harness-browser-profile-"), "p"), startupMs: 20_000, signal: cancelled.signal }).catch((x) => x as Error);
        await Bun.sleep(150);
        cancelled.abort();
        expect((await pending).message).toContain("Starting the browser was cancelled");
    });

    test("a program that isn't there is an error, not a hang", async () => {
        const profile = join(tempDir("harness-browser-profile-"), "p");
        await expect(launchChrome({ executable: join(profile, "nope"), profile, startupMs: 2000 })).rejects.toThrow();
    });

    test("a stale endpoint file from an earlier browser isn't believed", async () => {
        const profile = join(tempDir("harness-browser-profile-"), "p");
        mkdirSync(profile, { recursive: true });
        // names a port nothing listens on
        writeFileSync(join(profile, "DevToolsActivePort"), "1\n/devtools/browser/old");
        process.env.FAKE_CHROME = "silent";
        const e = (await launchChrome({ executable: program, profile, startupMs: 300 }).catch((x) => x)) as Error;
        expect(e.message).toContain("didn't open its DevTools endpoint");
    });
});

// ---------------------------------------------------------------------------

describe("a session's browser", () => {
    const root = tempDir("harness-browser-engine-project-");
    const profile = join(projectStateDir(root), "browser");
    const sessions: InstanceType<typeof BrowserSession>[] = [];
    const refused: string[] = [];
    const ctx = (state: any, signal = new AbortController().signal) => ({ state, settings: {}, signal }) as any;

    /** A session with its tool state, as the agent and the pane see it. */
    function open(over: { refuse?: (url: string) => string | undefined; dir?: string; pool?: { idleMs?: number; startupMs?: number } } = {}) {
        const dir = over.dir ?? root;
        const session = new BrowserSession({ root: dir, settings: () => ({}), refuse: over.refuse, pool: { startupMs: 20_000, ...over.pool } });
        sessions.push(session);
        const state: any = { cwd: dir, projectRoot: dir, fileState: new Map(), todos: [], shells: new Map(), browser: session };
        const run = (tool: { run: (i: any, c: any) => Promise<any> }, input: Record<string, unknown>, signal?: AbortSignal) => tool.run(input, ctx(state, signal));
        return { session, state, run, nav: (input: Record<string, unknown>, signal?: AbortSignal) => run(BrowserNavigateTool, input, signal), act: (input: Record<string, unknown>, signal?: AbortSignal) => run(BrowserActTool, input, signal) };
    }

    beforeAll(() => forgetChromeLookup());
    afterEach(async () => {
        refused.length = 0;
        for (const s of sessions.splice(0)) await s.dispose();
        delete process.env.FAKE_CHROME;
    });

    test("starts with the first page: nothing runs before, and the page is read as an outline with refs", async () => {
        const { session, nav } = open();
        expect(session.state().status).toBe("idle");
        const r = await nav({ url: "http://localhost:4000/shop" });
        expect(r.isError, r.content).toBeFalsy();
        expect(r.content).toContain('Opened http://localhost:4000/shop.');
        expect(r.content).toContain('Tab [1] "Page at http://localhost:4000/shop" http://localhost:4000/shop — loaded');
        expect(r.content).toContain('- button "Click me" [e5]');
        expect(r.content).toContain('value="[hidden]"');
        expect(session.state()).toMatchObject({ status: "ready", active: 1, tabs: [{ id: 1, owner: "agent", url: "http://localhost:4000/shop", loading: false }] });
    });

    test("refuses an address the policy doesn't allow before anything is asked of the browser", async () => {
        const { session, nav } = open();
        for (const url of ["javascript:alert(1)", "chrome://settings", "file:///etc/passwd", "data:text/html,x"]) {
            const checked = BrowserNavigateTool.validate!({ url }, ctx({ projectRoot: root }));
            expect(checked, url).toBeTruthy();
            const r = await nav({ url });
            expect(r.isError, url).toBe(true);
        }
        expect(session.state().status).toBe("idle");
    });

    test("the agent's clicks, typing, selecting and keys go to the page as real input, and what it held on the page is let go of", async () => {
        const { session, nav, act } = open();
        await nav({ url: "http://localhost:4000/" });
        const fake = await fakeChromeAt(profile);
        const click = await act({ action: "click", ref: "e5" });
        expect(click.isError, click.content).toBeFalsy();
        expect(click.content).toMatch(/^Clicked button "Click me" \[e5\]/);
        const mouse = (await fake.sent("Input.dispatchMouseEvent")).map((c) => [c.params.type, c.params.x, c.params.y, c.params.clickCount]);
        // the middle of the box, moved to, pressed and released
        expect(mouse).toEqual([["mouseMoved", 60, 25, undefined], ["mousePressed", 60, 25, 1], ["mouseReleased", 60, 25, 1]]);

        const typed = await act({ action: "type", ref: "e6", text: "shoes", clear: true, submit: true });
        expect(typed.isError, typed.content).toBeFalsy();
        expect(typed.content).toContain('Replaced the text of textbox "Search" [e6] and pressed Enter');
        expect((await fake.sent("Input.insertText")).map((c) => c.params.text)).toEqual(["shoes"]);
        expect((await fake.sent("Input.dispatchKeyEvent")).map((c) => [c.params.type, c.params.key])).toEqual([["keyDown", "Enter"], ["keyUp", "Enter"]]);
        const selected = await act({ action: "select", ref: "e9", value: "Small" });
        expect(selected.isError, selected.content).toBeFalsy();
        const pressed = await act({ action: "press", key: "Control+a" });
        expect(pressed.content).toContain("Pressed Control+a");
        // the handles to the field, the select and the focused element go back in the browser's hands
        const released = (await fake.sent("Runtime.releaseObjectGroup")).map((c) => c.params.objectGroup);
        expect(released.filter((g) => g === "harness-act")).toHaveLength(2);
        const made = (await fake.log()).filter((c) => (c.method === "DOM.resolveNode" || c.method === "Runtime.evaluate") && (c.params.objectGroup === "harness-act"));
        expect(made.length).toBeGreaterThanOrEqual(2);
        // everything made in the action's group (nothing is left in the page's default one)
        expect((await fake.sent("DOM.resolveNode")).every((c) => c.params.objectGroup === "harness-act")).toBe(true);
        expect(session.tabCount).toBe(1);
    });

    test("typing into the focused element works without a ref, and releases that handle too", async () => {
        const { nav, act } = open();
        await nav({ url: "http://localhost:4000/" });
        const fake = await fakeChromeAt(profile);
        const r = await act({ action: "type", text: "hello" });
        expect(r.isError, r.content).toBeFalsy();
        expect(r.content).toContain("Typed into the focused element");
        const active = (await fake.sent("Runtime.evaluate")).filter((c) => c.params.expression === "document.activeElement");
        expect(active.every((c) => c.params.objectGroup === "harness-act")).toBe(true);
        expect((await fake.sent("Runtime.releaseObjectGroup")).some((c) => c.params.objectGroup === "harness-act")).toBe(true);
    });

    test("a stale or unknown ref says to take a new snapshot, and nothing was sent to the page", async () => {
        const { nav, act } = open();
        await nav({ url: "http://localhost:4000/" });
        const fake = await fakeChromeAt(profile);
        const unknown = await act({ action: "click", ref: "e999" });
        expect(unknown.isError).toBe(true);
        expect(unknown.content).toContain("Unknown ref e999");
        await nav({ url: "http://localhost:4000/other" });
        const stale = await act({ action: "click", ref: "e5" });
        expect(stale.isError).toBe(true);
        expect(stale.content).toContain("stale");
        expect(stale.content).toContain("BrowserSnapshot");
        expect(await fake.sent("Input.dispatchMouseEvent")).toEqual([]);
    });

    test("when the user takes a tab the agent is refused, reading still works, and handing it back restores it", async () => {
        const { session, nav, act, run } = open();
        await nav({ url: "http://localhost:4000/" });
        const fake = await fakeChromeAt(profile);
        await session.input({ kind: "mouse", type: "down", x: 5, y: 5, button: "left", buttons: 1, clickCount: 1 });
        expect(session.state().tabs[0]!.owner).toBe("human");
        // the person's click reached the page
        expect((await fake.sent("Input.dispatchMouseEvent")).map((c) => c.params.type)).toEqual(["mousePressed"]);
        for (const attempt of [() => act({ action: "click", ref: "e5" }), () => act({ action: "hover", ref: "e5" }), () => act({ action: "scroll", deltaY: 100 }), () => act({ action: "type", text: "x" }), () => act({ action: "press", key: "a" }), () => nav({ url: "http://localhost:4000/other" }), () => nav({ action: "reload" }), () => run(BrowserEvalTool, { expression: "1" }), () => run(BrowserScreenshotTool, { ref: "e5" })]) {
            const r = await attempt();
            expect(r.isError).toBe(true);
            expect(r.content).toContain("taken control");
        }
        // nothing but the person's click got through
        expect((await fake.sent("Input.dispatchMouseEvent")).map((c) => c.params.type)).toEqual(["mousePressed"]);
        expect(await fake.sent("Input.insertText")).toEqual([]);
        // waiting and reading are not acting
        expect((await act({ action: "wait" })).isError).toBeFalsy();
        const read = await run(BrowserSnapshotTool, {});
        expect(read.isError).toBeFalsy();
        expect(read.content).toContain("The user has control of this tab");
        expect((await run(BrowserScreenshotTool, {})).images).toHaveLength(1);
        expect((await run(BrowserLogsTool, {})).isError).toBeFalsy();
        // refs from before their click mean nothing now: after handing back, the old ones are stale
        session.handBack();
        expect(session.state().tabs[0]!.owner).toBe("agent");
        const old = await act({ action: "click", ref: "e5" });
        expect(old.content).toContain("stale");
        const fresh = await run(BrowserSnapshotTool, {});
        expect((await act({ action: "click", ref: refOf(fresh.content, "button", "Click me") })).isError).toBeFalsy();
    });

    test("a click queued behind another call doesn't land if the user took the tab, or the call was cancelled, meanwhile", async () => {
        const { session, nav, act } = open();
        await nav({ url: "http://localhost:4000/" });
        const fake = await fakeChromeAt(profile);
        const page = await session.page();
        // the tab is busy with something else; the click waits its turn
        let release!: () => void;
        const busy = page.exclusive(() => new Promise<void>((resolve) => (release = resolve)));
        const queued = act({ action: "click", ref: "e5" });
        const cancel = new AbortController();
        const cancelled = act({ action: "click", ref: "e5" }, cancel.signal);
        await Bun.sleep(50);
        cancel.abort();
        await session.input({ kind: "key", type: "down", key: "a", code: "KeyA" });
        release();
        await busy;
        const taken = await queued;
        expect(taken.isError).toBe(true);
        expect(taken.content).toContain("taken control");
        expect((await cancelled).content).toMatch(/Interrupted by user|taken control/);
        expect(await fake.sent("Input.dispatchMouseEvent")).toEqual([]);
    });

    test("the user taking the tab part-way through a click stops the rest of it", async () => {
        const { session, nav } = open();
        await nav({ url: "http://localhost:4000/" });
        const fake = await fakeChromeAt(profile);
        const page = await session.page();
        const { click } = await import("../src/browser/interact");
        // after the pointer has moved to the element, the person takes the tab
        const original = page.agentInput.bind(page);
        let sent = 0;
        page.agentInput = (method: string, params: Record<string, unknown>, signal?: AbortSignal) => {
            const result = original(method, params, signal);
            if (++sent === 1) void session.input({ kind: "key", type: "down", key: "a", code: "KeyA" });
            return result;
        };
        const e = await click(page, { ref: "e5" }).catch((x) => x as Error);
        expect(e.message).toContain("taken control");
        expect((await fake.sent("Input.dispatchMouseEvent")).map((c) => c.params.type)).toEqual(["mouseMoved"]);
    });

    test("an address bar opens a tab as the user's own, and its address is checked like any other", async () => {
        const { session } = open();
        await session.command({ command: "new_tab", url: "localhost:4000/app" });
        expect(session.state().tabs).toMatchObject([{ id: 1, owner: "human", url: "http://localhost:4000/app" }]);
        await expect(session.command({ command: "goto", url: "javascript:alert(1)" })).rejects.toThrow("javascript:");
        await expect(session.command({ command: "goto", url: "two words" })).rejects.toThrow("isn't an address");
        await expect(session.command({ command: "explode" })).rejects.toThrow("Unknown browser command");
    });

    test("and so are the rules: an address a deny rule names isn't opened from the bar either, and the user is told", async () => {
        const { session } = open({ refuse: (url) => (new URL(url).hostname === "blocked.example" ? "Denied by permission rule WebFetch(domain:blocked.example)" : undefined) });
        await session.command({ command: "new_tab" });
        await expect(session.command({ command: "goto", url: "blocked.example/x" })).rejects.toThrow("https://blocked.example/x can't be opened: Denied by permission rule WebFetch(domain:blocked.example)");
        await session.command({ command: "goto", url: "allowed.example/x" });
        expect(session.state().tabs[0]!.url).toBe("https://allowed.example/x");
    });

    test("at most MAX_TABS tabs, counting the ones being opened and the ones pages open themselves", async () => {
        const { session, nav } = open();
        const { MAX_TABS } = await import("../src/browser/session");
        // all at once: each takes a slot before the browser is asked
        const results = await Promise.all(Array.from({ length: MAX_TABS + 4 }, () => nav({ action: "new_tab" })));
        expect(results.filter((r) => !r.isError)).toHaveLength(MAX_TABS);
        const over = results.find((r) => r.isError)!;
        expect(over.content).toContain(`already has ${MAX_TABS} tabs`);
        expect(session.tabCount).toBe(MAX_TABS);
        // a popup past the limit is closed, and the page that opened it hears so
        const fake = await fakeChromeAt(profile);
        const opener = "T1";
        const popup = await fake.popup(opener);
        await until(async () => (await fake.sent("Target.closeTarget")).some((c) => c.params.targetId === popup), "the popup to be closed");
        expect(session.tabCount).toBe(MAX_TABS);
        // under the limit, one is a tab of the session
        await nav({ action: "close_tab", tab: 2 });
        const adopted = await fake.popup(opener);
        await until(() => session.tabCount === MAX_TABS, "the popup to join");
        expect((await fake.sent("Target.closeTarget")).some((c) => c.params.targetId === adopted)).toBe(false);
    });

    test("tabs belong to their session: two sessions of a project share one browser and see only their own", async () => {
        const first = open();
        const second = open();
        await first.nav({ url: "http://localhost:4000/a" });
        await second.nav({ url: "http://localhost:4000/b" });
        expect(first.session.state().tabs.map((t) => t.url)).toEqual(["http://localhost:4000/a"]);
        expect(second.session.state().tabs.map((t) => t.url)).toEqual(["http://localhost:4000/b"]);
        expect(pidOf(first.session)).toBeDefined();
        expect(pidOf(first.session)).toBe(pidOf(second.session));
        const missing = await first.nav({ action: "switch_tab", tab: 99 });
        expect(missing.isError).toBe(true);
        expect(missing.content).toContain("There is no tab 99");
        const pid = pidOf(first.session)!;
        // it stays while one session has it, and goes with the last
        await first.session.dispose();
        expect(alive(pid)).toBe(true);
        expect(second.session.state().tabs).toHaveLength(1);
        await second.session.dispose();
        await until(() => !alive(pid), "the browser to end with its last session");
    });

    test("ends after sitting idle, says so, and starts again with the next page", async () => {
        const { session, nav } = open({ pool: { idleMs: 300 } });
        await nav({ url: "http://localhost:4000/" });
        const pid = pidOf(session);
        await until(() => !alive(pid), "the idle browser to end", 15_000);
        expect(session.state().tabs).toEqual([]);
        const stale = await nav({ action: "list_tabs" });
        expect(stale.content).toBe("No tabs are open.");
        const lostTab = await nav({ action: "switch_tab", tab: 1 });
        expect(lostTab.content).toContain("The browser was closed after sitting idle, so its tabs are gone.");
        const again = await nav({ url: "http://localhost:4000/" });
        expect(again.isError, again.content).toBeFalsy();
        expect(pidOf(session)).not.toBe(pid);
    });

    test("a call in progress keeps it from idling, however long it takes", async () => {
        const { session, nav } = open({ pool: { idleMs: 200 } });
        await nav({ url: "http://localhost:4000/" });
        const pid = pidOf(session);
        // a call that takes far longer than the idle time
        await session.run(() => Bun.sleep(900));
        expect(alive(pid)).toBe(true);
        await until(() => !alive(pid), "it to end once the call was done", 15_000);
    });

    test("a window watching keeps it from idling", async () => {
        const { session, nav } = open({ pool: { idleMs: 300 } });
        await nav({ url: "http://localhost:4000/" });
        const pid = pidOf(session);
        const key = {};
        session.watch(key, () => undefined, { width: 600, height: 400, scale: 1 });
        // several idle periods
        await Bun.sleep(1200);
        expect(alive(pid)).toBe(true);
        session.unwatch(key);
        await until(() => !alive(pid), "it to end once nobody watched", 15_000);
    });

    test("a browser that dies is a tool error, and the next call starts another", async () => {
        const { session, nav, act } = open();
        await nav({ url: "http://localhost:4000/" });
        const pid = pidOf(session);
        process.kill(-pid, "SIGKILL");
        await until(() => session.state().status === "crashed", "the crash to be noticed");
        expect(session.state().error).toContain("stopped unexpectedly");
        expect(session.state().tabs).toEqual([]);
        const r = await act({ action: "click", ref: "e5" });
        expect(r.isError).toBe(true);
        expect(r.content).toContain("stopped unexpectedly");
        const again = await nav({ url: "http://localhost:4000/" });
        expect(again.isError, again.content).toBeFalsy();
        expect(session.state().status).toBe("ready");
        expect(pidOf(session)).not.toBe(pid);
    });

    test("one that won't start is told as an error with what it said, and doesn't wedge the session", async () => {
        process.env.FAKE_CHROME = "exit";
        const { session, nav } = open();
        const r = await nav({ url: "http://localhost:4000/" });
        expect(r.isError).toBe(true);
        expect(r.content).toContain("The browser didn't start");
        expect(r.content).toContain("fake chrome: refusing to start");
        expect(session.state().tabs).toEqual([]);
        delete process.env.FAKE_CHROME;
        expect((await nav({ url: "http://localhost:4000/" })).isError).toBeFalsy();
    });

    test("without a browser the tools say how to get one, and the pane is told", async () => {
        const saved = process.env.HARNESS_BROWSER;
        process.env.HARNESS_BROWSER = join(root, "none");
        forgetChromeLookup();
        try {
            const { session, nav } = open();
            expect(session.state()).toMatchObject({ status: "unavailable", tabs: [] });
            const r = await nav({ url: "http://localhost:4000/" });
            expect(r.isError).toBe(true);
            expect(r.content).toContain("isn't an installed browser");
        } finally {
            process.env.HARNESS_BROWSER = saved;
            forgetChromeLookup();
        }
    });

    test("closing the session closes its tabs and ends the browser; nothing is left running", async () => {
        const { session, nav } = open();
        await nav({ url: "http://localhost:4000/" });
        await nav({ action: "new_tab" });
        const pid = pidOf(session);
        await session.dispose();
        await until(() => !alive(pid), "the browser to end");
        const r = await nav({ url: "http://localhost:4000/" });
        expect(r.isError).toBe(true);
        expect(r.content).toContain("browser was closed");
    });

    test("a page that is held by a dialog says so to everything but the answer", async () => {
        const { session, nav, act } = open();
        await nav({ url: "http://localhost:4000/" });
        const fake = await fakeChromeAt(profile);
        const page = await session.page();
        await fake.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Really?" }, page.sessionId);
        await until(() => page.dialog !== undefined, "the dialog");
        expect(session.state().tabs[0]!.dialog).toMatchObject({ type: "confirm", message: "Really?" });
        const blocked = await act({ action: "click", ref: "e5" });
        expect(blocked.isError).toBe(true);
        expect(blocked.content).toContain("dialog is open");
        const answered = await act({ action: "dialog", accept: true });
        expect(answered.isError, answered.content).toBeFalsy();
        expect((await fake.sent("Page.handleJavaScriptDialog")).map((c) => c.params.accept)).toEqual([true]);
        // an alert is accepted by the browser itself and noted
        await fake.emit("Page.javascriptDialogOpening", { type: "alert", message: "heads up" }, page.sessionId);
        await until(async () => (await fake.sent("Page.handleJavaScriptDialog")).length === 2, "the alert to be accepted");
        expect(page.dialog).toBeUndefined();
        expect(page.console.entries.some((e) => e.level === "dialog" && e.text === "alert: heads up")).toBe(true);
    });
});

// ---------------------------------------------------------------------------

describe("what a page may load", () => {
    const root = tempDir("harness-browser-load-project-");
    const outside = tempDir("harness-browser-load-outside-");
    mkdirSync(join(root, "private"));
    writeFileSync(join(root, "page.html"), "<img src=a.png>");
    const sessions: InstanceType<typeof BrowserSession>[] = [];
    afterEach(async () => {
        for (const s of sessions.splice(0)) await s.dispose();
    });

    async function paused(refuse?: (url: string) => string | undefined) {
        const session = new BrowserSession({ root, settings: () => ({}), refuse, pool: { startupMs: 20_000 } });
        sessions.push(session);
        const page = await session.page();
        const fake = await fakeChromeAt(join(projectStateDir(root), "browser"));
        let n = 0;
        return {
            page,
            fake,
            session,
            /** The browser pausing a request: what it was told to do with it. */
            async request(url: string, type = "Document") {
                const requestId = `R${++n}`;
                await fake.emit("Fetch.requestPaused", { requestId, resourceType: type, request: { url } }, page.sessionId);
                await until(async () => (await fake.log()).some((c) => c.params?.requestId === requestId && c.method.startsWith("Fetch.")), "the answer");
                const answer = (await fake.log()).find((c) => c.params?.requestId === requestId && c.method.startsWith("Fetch."))!;
                return answer.method === "Fetch.continueRequest" ? "continued" : (answer.params.errorReason as string);
            },
        };
    }

    test("it asks to be told of documents, and of everything a page reads from a file", async () => {
        const { fake } = await paused();
        const [enable] = await fake.sent("Fetch.enable");
        expect(enable!.params.patterns).toEqual(expect.arrayContaining([expect.objectContaining({ resourceType: "Document" }), expect.objectContaining({ urlPattern: "file:*" })]));
    });

    test("the policy holds for documents a page loads itself, however it got there", async () => {
        const { request, page } = await paused();
        expect(await request("https://example.com/next")).toBe("continued");
        expect(await request("http://localhost:3000/")).toBe("continued");
        for (const url of ["javascript:alert(1)", "data:text/html,x", "chrome://settings", `file://${join(outside, "secret.html")}`, "file:///etc/passwd"]) expect(await request(url), url).toBe("BlockedByClient");
        expect(await request(`file://${join(root, "page.html")}`)).toBe("continued");
        // the agent is told, in the page's console
        const errors = page.console.entries.filter((e) => e.level === "error").map((e) => e.text);
        expect(errors.some((e) => e.startsWith("Blocked a load of file:///etc/passwd:"))).toBe(true);
    });

    test("an image or script a page reads from a file outside the project doesn't load, one inside does", async () => {
        const { request } = await paused();
        expect(await request(`file://${join(outside, "secret.png")}`, "Image")).toBe("BlockedByClient");
        expect(await request("file:///etc/hosts", "Script")).toBe("BlockedByClient");
        expect(await request(`file://${join(root, "a.png")}`, "Image")).toBe("continued");
    });

    test("a deny rule for a host holds against a page that goes there by itself, with the reason in the console", async () => {
        const { request, page } = await paused((url) => (new URL(url).hostname === "blocked.example" ? "Denied by permission rule WebFetch(domain:blocked.example)" : undefined));
        expect(await request("https://blocked.example/x")).toBe("BlockedByClient");
        expect(await request("https://allowed.example/x")).toBe("continued");
        expect(page.console.entries.some((e) => e.level === "error" && e.text.includes("blocked.example/x") && e.text.includes("Denied by permission rule WebFetch(domain:blocked.example)"))).toBe(true);
        expect(page.console.unseenErrors).toBe(1);
    });

    test("a page that has navigated somewhere refused is sent back to a blank page", async () => {
        const { page, fake } = await paused((url) => (url.includes("blocked.example") ? "Denied by permission rule WebFetch(domain:blocked.example)" : undefined));
        await fake.emit("Page.frameNavigated", { frame: { id: "T1", url: "https://blocked.example/landed", loaderId: "Lx" } }, page.sessionId);
        await until(async () => (await fake.sent("Page.navigate")).some((c) => c.params.url === "about:blank"), "the page to be sent back");
        expect(page.console.entries.some((e) => e.text.includes("Navigation to https://blocked.example/landed was blocked: Denied by permission rule"))).toBe(true);
        // the browser's own error page is not refused
        await fake.emit("Page.frameNavigated", { frame: { id: "T1", url: "chrome-error://chromewebdata/", loaderId: "Ly" } }, page.sessionId);
        await Bun.sleep(100);
        expect((await fake.sent("Page.navigate")).filter((c) => c.params.url === "about:blank")).toHaveLength(1);
    });

    test("downloads are refused by the browser and told to the tab", async () => {
        const { fake, page } = await paused();
        expect((await fake.sent("Browser.setDownloadBehavior")).map((c) => c.params.behavior)).toEqual(["deny"]);
        await fake.emit("Browser.downloadWillBegin", { frameId: "T1", url: "http://x.test/f.bin", suggestedFilename: "f.bin" });
        await until(() => page.console.entries.some((e) => e.level === "download"), "the note");
        expect(page.console.entries.at(-1)!.text).toContain("f.bin");
    });
});
