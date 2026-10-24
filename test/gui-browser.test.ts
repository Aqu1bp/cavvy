// The GUI's Browser pane through the server: a session's browser state and the frames of its tab, the pane's size,
// a person's input and handing the tab back, and the browser ending with the session. Without a Chrome (see
// test/helpers/browser-fixture.ts) only what needs none runs.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { chromePath, fixtureServer } from "./helpers/browser-fixture";
import { fakeChromeProgram } from "./helpers/fake-chrome";

const iso = isolate();
const offBrowser = process.env.HARNESS_BROWSER;
const { Engine } = await import("../src/server/engine");
const { startServer } = await import("../src/server/server");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
const { startDemoSite } = await import("../scripts/demo-site");
const { forgetChromeLookup } = await import("../src/browser/chrome");
const { BrowserNavigateTool } = await import("../src/tools/browser-tools");
import type { BrowserState, ServerEvent, SessionSnapshot } from "../src/server/protocol";

setDefaultTimeout(60_000);
const mock = startMockLlm({ delayMs: 0 });
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));

const site = fixtureServer();
/** A window of the engine: what it was sent. */
function window() {
    const events: ServerEvent[] = [];
    return { subs: new Set<string>(), send: (e: ServerEvent) => void events.push(e), events };
}
const frames = (w: ReturnType<typeof window>) => w.events.filter((e): e is Extract<ServerEvent, { type: "browser.frame" }> => e.type === "browser.frame");
const states = (w: ReturnType<typeof window>) => w.events.filter((e): e is Extract<ServerEvent, { type: "browser.state" }> => e.type === "browser.state");
async function until(check: () => boolean, what: string, ms = 15_000) {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(25);
    }
}
const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

const engine = new Engine();
const me = window();
engine.clients.add(me);
const call = (method: string, params: Record<string, unknown> = {}, as = me) => engine.handle(as, method as never, params as never) as Promise<any>;
let cwd: string;
let id: string;

beforeAll(async () => {
    cwd = realpathSync(createDemoProject(tempDir("harness-browser-gui-"), { git: false }));
    const snap = (await call("session.create", { cwd })) as SessionSnapshot;
    id = snap.state.id;
    me.subs.add(id);
});

afterAll(async () => {
    await engine.stop();
    site.stop();
    mock.stop();
    iso.cleanup();
});

describe("without a browser", () => {
    test("the pane is told there is none to run, and how to fix it", async () => {
        const state: BrowserState = await call("browser.state", { id });
        expect(state.status).toBe("unavailable");
        expect(state.error).toContain("isn't an installed browser");
        expect(state.tabs).toEqual([]);
        // opening a page from the address bar says the same
        await expect(call("browser.command", { id, command: "new_tab", url: "localhost:3000" })).rejects.toMatchObject({ code: "browser" });
    });

    test("turning the browser off in Settings says so, and turning it on again undoes it", async () => {
        process.env.HARNESS_BROWSER = chromePath ?? process.env.HARNESS_BROWSER;
        try {
            expect((await call("settings.update", { patch: { browser: false } })).browser).toBe(false);
            const off: BrowserState = await call("browser.state", { id });
            expect(off).toMatchObject({ status: "unavailable", tabs: [] });
            expect(off.error).toContain("turned off");
            await expect(call("browser.command", { id, command: "new_tab" })).rejects.toMatchObject({ code: "browser" });
            expect((await call("settings.update", { patch: { browser: true } })).browser).toBeUndefined();
            expect(JSON.parse(readFileSync(join(iso.home, "settings.json"), "utf8")).browser).toBeUndefined();
            if (chromePath) expect((await call("browser.state", { id })).status).toBe("idle");
        } finally {
            process.env.HARNESS_BROWSER = offBrowser;
            await call("settings.update", { patch: { browser: true } });
        }
    });

    test("what the pane sends is checked: an unknown session, a command, an input that isn't one", async () => {
        await expect(call("browser.state", { id: "nope" })).rejects.toMatchObject({ code: "not_open" });
        await expect(call("browser.command", { id, command: "explode" })).rejects.toMatchObject({ code: "browser" });
        expect(await call("browser.input", { id, input: { kind: "mouse", type: "down", x: "left", y: 1 } })).toBeNull();
        expect(await call("browser.input", { id, input: "click" })).toBeNull();
        await expect(call("browser.dialog", { id, accept: "yes" })).rejects.toThrow("accept must be a boolean");
        // nothing to hand back or answer
        await expect(call("browser.handBack", { id })).rejects.toMatchObject({ code: "browser" });
    });
});

describe("the demo (bun run gui:demo)", () => {
    const demo = startDemoSite();
    afterAll(() => demo.stop());

    test("serves a page with a button first, a form, and a second page", async () => {
        const home = await (await fetch(demo.url)).text();
        expect(home).toContain("<title>Acme status</title>");
        expect(home.indexOf("<button")).toBeLessThan(home.indexOf("<form"));
        expect(home).toContain("Subscribe to updates");
        expect(await (await fetch(`${demo.url}incidents`)).text()).toContain("No incidents");
        expect((await fetch(`${demo.url}nothing`)).status).toBe(404);
    });

    test("a prompt about the browser has the agent open the page and click its first button, and the pane hears of it", async () => {
        const saved = process.env.HARNESS_BROWSER;
        // the stand-in for Chrome answers with its own page; what's shown here is the agent's path through the tools, permissions and the pane
        process.env.HARNESS_BROWSER = fakeChromeProgram();
        forgetChromeLookup();
        const fresh = realpathSync(createDemoProject(tempDir("harness-browser-demo-"), { git: false }));
        const demoId = ((await call("session.create", { cwd: fresh })) as SessionSnapshot).state.id;
        me.subs.add(demoId);
        const rt = (engine as any).runtimes.get(demoId);
        try {
            await call("session.send", { id: demoId, text: `check the app in the browser ${demo.url}` });
            // opening a local page asks nothing; the click asks
            await until(() => rt.snapshot().state.interactions.length > 0, "the click's approval");
            const [ask] = rt.snapshot().state.interactions;
            expect(ask).toMatchObject({ kind: "permission", heading: "Act on a page in the browser", description: "Browser: click e5" });
            await call("session.respond", { id: demoId, interactionId: ask.id, response: { kind: "permission", choice: "yes" } });
            await until(() => !rt.snapshot().state.busy, "the turn to end");
            const said = JSON.stringify(rt.session.messages);
            expect(said).toContain("I'll open the app in the browser");
            expect(said).toContain("The page loads and the button works");
            expect(said).toContain("Clicked button");
            expect(states(me).some((e) => e.sessionId === demoId && e.state.tabs.some((t) => t.owner === "agent"))).toBe(true);
        } finally {
            process.env.HARNESS_BROWSER = saved;
            forgetChromeLookup();
        }
    });
});

/** What the pane's transport is run against: a stand-in that opens a DevTools endpoint as Chrome does (always), and the real thing (where there is one). */
const browsers = [
    { name: "a stand-in for Chrome", program: () => fakeChromeProgram(), titles: { main: (url: string) => `Page at ${url}`, other: (url: string) => `Page at ${url}` }, run: true },
    { name: "Chrome", program: () => chromePath!, titles: { main: () => "Fixture shop", other: () => "Other page" }, run: Boolean(chromePath) },
];

for (const browser of browsers) {
    describe.skipIf(!browser.run)(`with ${browser.name}`, () => {
        beforeAll(() => {
            process.env.HARNESS_BROWSER = browser.program();
            forgetChromeLookup();
        });
        afterAll(() => {
            process.env.HARNESS_BROWSER = offBrowser;
            forgetChromeLookup();
        });

        test("the agent opening a page is told to the windows with the session open; the pane's size sizes the page and frames stream, one at a time", async () => {
            // a window and a session of its own
            const me = window();
            engine.clients.add(me);
            const call = (method: string, params: Record<string, unknown> = {}) => engine.handle(me, method as never, params as never) as Promise<any>;
            const id = ((await call("session.create", { cwd: realpathSync(createDemoProject(tempDir("harness-browser-gui-"), { git: false })) })) as SessionSnapshot).state.id;
            me.subs.add(id);
            const idle: BrowserState = await call("browser.state", { id });
            expect(idle.status).toBe("idle");
            const rt = (engine as any).runtimes.get(id);
            const other = window();
            engine.clients.add(other);
            other.subs.add("some other session");
            const opened = await BrowserNavigateTool.run({ url: `${site.url}/` }, { state: rt.toolState, settings: {}, signal: new AbortController().signal } as any);
            expect(opened.isError, opened.content).toBeFalsy();
            await until(() => states(me).some((e) => e.state.status === "ready" && e.state.tabs.length === 1), "the state event");
            const told = states(me).at(-1)!.state;
            expect(told.tabs[0]).toMatchObject({ owner: "agent", url: `${site.url}/`, title: browser.titles.main(`${site.url}/`) });
            // a window without the session open isn't told
            expect(states(other)).toEqual([]);

            const watched: BrowserState = await call("browser.watch", { id, width: 600, height: 420, scale: 2 });
            expect(watched.active).toBe(told.active);
            await until(() => frames(me).length >= 1, "the first frame");
            const first = frames(me)[0]!;
            expect(first).toMatchObject({ sessionId: id, tab: told.active, width: 600, height: 420 });
            expect(Buffer.from(first.data, "base64").subarray(0, 3).toString("hex")).toBe("ffd8ff");
            // no more until it's acknowledged
            const sent = frames(me).length;
            const pid = (rt.browser as any).pool.pid as number;
            await rt.browser.page().then((page: any) => page.evaluate("document.body.style.background = 'teal'"));
            await Bun.sleep(300);
            expect(frames(me).length).toBe(sent);
            await call("browser.ack", { id });
            await until(() => frames(me).length > sent, "the frame that waited");
            // another window is sent nothing it didn't ask for
            expect(frames(other)).toEqual([]);

            // a new size
            await call("browser.ack", { id });
            await call("browser.watch", { id, width: 500, height: 300, scale: 1 });
            await until(() => frames(me).at(-1)!.width === 500, "a frame at the new size");

            // a person clicks in the pane: the tab is theirs, and the window is told
            await call("browser.input", { id, input: { kind: "mouse", type: "down", x: 10, y: 10, button: "left", buttons: 1, clickCount: 1 } });
            await until(() => states(me).at(-1)!.state.tabs[0]!.owner === "human", "the takeover");
            const refused = await BrowserNavigateTool.run({ url: `${site.url}/other` }, { state: rt.toolState, settings: {}, signal: new AbortController().signal } as any);
            expect(refused.isError).toBe(true);
            expect(refused.content).toContain("taken control");
            await call("browser.input", { id, input: { kind: "mouse", type: "up", x: 10, y: 10, button: "left", buttons: 0, clickCount: 1 } });
            await call("browser.handBack", { id });
            await until(() => states(me).at(-1)!.state.tabs[0]!.owner === "agent", "the hand back");

            // address bar and tabs
            const navigated: BrowserState = await call("browser.command", { id, command: "goto", url: `${site.url}/other` });
            expect(navigated.tabs[0]!.owner).toBe("human");
            await until(() => states(me).at(-1)!.state.tabs[0]!.title === browser.titles.other(`${site.url}/other`), "the new page's title");
            await call("browser.command", { id, command: "back" });
            await until(() => states(me).at(-1)!.state.tabs[0]!.url === `${site.url}/`, "the page before");

            // the window going away stops the stream; the session closing ends the browser
            await call("browser.ack", { id });
            engine.dropClient(me);
            await Bun.sleep(100);
            const after = frames(me).length;
            await rt.browser.page().then((page: any) => page.evaluate("document.body.style.background = 'red'"));
            await Bun.sleep(400);
            expect(frames(me).length).toBe(after);
            expect(alive(pid)).toBe(true);
            await rt.close();
            await until(() => !alive(pid), "the browser to end with its session");
        });
    });
}

describe("over the server's socket", () => {
    test("frames go only to the authenticated connection that watches", async () => {
        process.env.HARNESS_BROWSER = fakeChromeProgram();
        forgetChromeLookup();
        const server = await startServer({ token: "browser-token-0123456789" });
        const events: any[] = [];
        const replies = new Map<number, (m: any) => void>();
        let next = 1;
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { protocols: ["harness.v1", "auth.browser-token-0123456789"] } as any);
        ws.onmessage = (m) => {
            const msg = JSON.parse(String(m.data));
            if ("event" in msg) events.push(msg.event);
            else replies.get(msg.id)?.(msg);
        };
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error("connection failed"));
        });
        const rpc = (method: string, params: Record<string, unknown>) =>
            new Promise<any>((resolve) => {
                const n = next++;
                replies.set(n, resolve);
                ws.send(JSON.stringify({ id: n, method, params }));
            });
        // without the token, no connection at all
        const stranger = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { protocols: ["harness.v1", "auth.wrong"] } as any);
        const refused = await new Promise<boolean>((resolve) => {
            stranger.onopen = () => resolve(false);
            stranger.onerror = () => resolve(true);
        });
        expect(refused).toBe(true);
        try {
            const dir = realpathSync(createDemoProject(tempDir("harness-browser-ws-"), { git: false }));
            const made = (await rpc("session.create", { cwd: dir })).result as SessionSnapshot;
            const rt = (server.engine as any).runtimes.get(made.state.id);
            await BrowserNavigateTool.run({ url: `${site.url}/` }, { state: rt.toolState, settings: {}, signal: new AbortController().signal } as any);
            const watching = await rpc("browser.watch", { id: made.state.id, width: 400, height: 300, scale: 1 });
            expect(watching.result.status).toBe("ready");
            await until(() => events.some((e) => e.type === "browser.frame"), "a frame over the socket");
            const frame = events.find((e) => e.type === "browser.frame");
            expect(frame).toMatchObject({ sessionId: made.state.id, width: 400, height: 300 });
        } finally {
            ws.close();
            await server.stop();
            process.env.HARNESS_BROWSER = offBrowser;
            forgetChromeLookup();
        }
    });
});
