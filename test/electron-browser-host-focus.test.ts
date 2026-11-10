// The desktop app's browser and the person's keyboard (desktop-electron/src/browser-host.ts), with Electron itself
// stood in for: pages that take the window's one keyboard when pressed, the person typing wherever it is, and the agent
// sending its commands. What the app tells the window (gui/src/lib/page-focus.ts acts on it), and where every key the
// person typed ends up.
import { afterEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

mock.module("electron", () => ({
    app: { getAppMetrics: () => [], userAgentFallback: "Chrome/140", getName: () => "Cavvy" },
    session: { fromPartition: () => ({ setUserAgent() {}, getUserAgent: () => "Chrome/140", on() {}, setPermissionRequestHandler() {} }) },
}));
const { BrowserHost } = await import("../desktop-electron/src/browser-host");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The window's keyboard: the window's own, or one page's (in its own document or a frame of it). */
let keyboard: Page | "window" = "window";

/** A tab's page. */
class Page extends EventEmitter {
    readonly mainFrame = { name: "page" };
    readonly frame = { name: "frame" };
    /** Where its own focus is: its document, or the frame in it. */
    at: { name: string } = this.mainFrame;
    /** What the person's keys typed in it, by where: "page:a", "frame:a". */
    got: string[] = [];
    /** What the app typed in it (sendInputEvent): kept keys, sent on. */
    sent: string[] = [];
    constructor(readonly targetId: string) {
        super();
    }
    get focusedFrame() {
        return keyboard === this ? this.at : null;
    }
    readonly debugger = {
        attach() {},
        detach() {},
        isAttached: () => true,
        on() {},
        sendCommand: async (method: string, params: Record<string, unknown> = {}) => {
            if (method === "Target.getTargetInfo") return { targetInfo: { targetId: this.targetId } };
            // The agent's press takes the window's keyboard into the page, to what it pressed in its own document.
            if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
                keyboard = this;
                this.at = this.mainFrame;
            }
            return {};
        },
    };
    isLoading = () => false;
    isDestroyed = () => false;
    isCurrentlyAudible = () => false;
    getOSProcessId = () => 1;
    getTitle = () => "";
    getURL = () => "";
    setWindowOpenHandler() {}
    sendInputEvent(e: { type: string; keyCode: string }) {
        if (e.type === "char") this.sent.push(e.keyCode);
    }
}

function app() {
    keyboard = "window";
    const told: { type: string; key?: string; framed?: boolean; press?: boolean }[] = [];
    /** What the app typed in the window. */
    const windowSent: string[] = [];
    const gui = new EventEmitter();
    const pages: Page[] = [];
    const win = {
        webContents: {
            isDestroyed: () => false,
            sendInputEvent: (e: { type: string; keyCode: string }) => void (e.type === "char" && windowSent.push(e.keyCode)),
            send: (_channel: string, msg: { type: string; key: string; partition: string }) => {
                told.push(msg);
                // The window makes the webview it's asked for.
                if (msg.type !== "create") return;
                const page = new Page(`T${pages.length + 1}`);
                pages.push(page);
                gui.emit("will-attach-webview", { preventDefault() {} }, {}, { src: `about:blank#${msg.key}`, partition: msg.partition });
                gui.emit("did-attach-webview", {}, page);
            },
        },
    };
    const host = new BrowserHost(() => win as any) as any;
    host.watch(gui);
    host.receive(JSON.stringify({ channel: "c", open: { profile: "p" } }));
    const channel = host.channels.get("c");
    let id = 0;
    const cmd = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => host.command(channel, { id: ++id, method, params, sessionId });
    const tab = async () => {
        await cmd("Target.createTarget", { url: "about:blank" });
        return pages[pages.length - 1]!;
    };
    const sid = (page: Page) => `desktop-${pages.indexOf(page) + 1}`;
    const key = (page: Page) => `tab-${pages.indexOf(page) + 1}`;
    /** The agent clicks in a page, as the server does: three commands. */
    const click = async (page: Page, during?: () => void) => {
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
            await cmd("Input.dispatchMouseEvent", { type, x: 10, y: 10, button: "left", clickCount: 1 }, sid(page));
            if (type === "mousePressed") during?.();
        }
    };
    /** The person presses in a page (its document, or the frame in it): the keyboard goes there after the event. */
    const press = (page: Page, where: "page" | "frame") => {
        page.emit("before-mouse-event", {}, { type: "mouseDown" });
        keyboard = page;
        page.at = where === "page" ? page.mainFrame : page.frame;
    };
    /** The person types: each key goes where the keyboard is, unless the app keeps it. */
    const type = (text: string) => {
        for (const ch of text) {
            if (keyboard === "window") {
                windowSent.push(`typed:${ch}`);
                continue;
            }
            const page = keyboard;
            let kept = false;
            page.emit("before-input-event", { preventDefault: () => void (kept = true) }, { type: "keyDown", key: ch });
            if (!kept) page.got.push(`${page.at.name}:${ch}`);
        }
    };
    /**
     * What the window does when the agent's page took the keyboard (gui/src/lib/page-focus.ts): gives it back to the
     * person's page, unless the app said their keyboard was in a frame of it, then to the window. Given back, it lands
     * on the page itself (measured on macOS and Linux).
     */
    const handBack = (page: Page) => {
        const framed = told.filter((m) => m.type === "framed" && m.key === key(page)).at(-1)?.framed;
        keyboard = framed ? "window" : page;
        if (!framed) page.at = page.mainFrame;
    };
    /** The person presses Tab in the window, and the keyboard goes into a page (its document, or the frame in it). */
    const tabIn = (page: Page, where: "page" | "frame") => {
        gui.emit("before-input-event", {}, { type: "keyDown", key: "Tab" });
        keyboard = page;
        page.at = where === "page" ? page.mainFrame : page.frame;
    };
    return { host, told, windowSent, cmd, tab, sid, key, click, press, type, handBack, tabIn };
}

let hosts: any[] = [];
afterEach(() => {
    for (const h of hosts) h.close();
    hosts = [];
});
function start() {
    const a = app();
    hosts.push(a.host);
    return a;
}

test("typing in a frame of their page: the agent working in another page, then in theirs, loses none of their keys", async () => {
    // With the page marked not theirs as the agent acted in another page (whose script never took the keyboard), keys
    // typed in the frame for a second after the agent next acted on their page were kept from it, and dropped.
    const a = start();
    const mine = await a.tab();
    const agents = await a.tab();
    a.press(mine, "frame");
    await sleep(150);
    a.type("ab");
    expect(a.told).toContainEqual({ type: "framed", key: a.key(mine), framed: true });
    await a.cmd("Runtime.evaluate", { expression: "1", userGesture: true }, a.sid(agents));
    await a.cmd("Input.dispatchMouseEvent", { type: "mouseWheel", x: 10, y: 10, deltaX: 0, deltaY: 100 }, a.sid(mine));
    a.type("cde");
    await sleep(50);
    expect(mine.got).toEqual(["frame:a", "frame:b", "frame:c", "frame:d", "frame:e"]);
    expect([a.windowSent, agents.got, mine.sent]).toEqual([[], [], []]);
    // Nothing told the window they left their page.
    expect(a.told.filter((m) => m.type === "left")).toEqual([]);
});

test("the agent clicking in another page takes the keys typed meanwhile; they go to the page being typed in once it has the keyboard back", async () => {
    const a = start();
    const mine = await a.tab();
    const agents = await a.tab();
    a.press(mine, "page");
    a.type("ab");
    // Typed while the agent's press holds the keyboard, and after its release.
    await a.click(agents, () => a.type("cd"));
    a.type("e");
    expect(agents.got).toEqual([]);
    await sleep(20);
    expect(a.told).toContainEqual({ type: "focused", key: a.key(agents) });
    expect(a.told.filter((m) => m.type === "framed")).toEqual([]);
    // The window gives the keyboard back to their page (page-focus.ts).
    keyboard = mine;
    await sleep(30);
    expect(mine.sent).toEqual(["c", "d", "e"]);
    a.type("f");
    expect(mine.got).toEqual(["page:a", "page:b", "page:f"]);
    expect([a.windowSent, agents.sent]).toEqual([[], []]);
});

test("their keyboard in a frame of their page: the keys taken go to the window, where the keyboard goes back to", async () => {
    // Given back, the keyboard lands on the page itself, not the frame: their keys don't go there either.
    const a = start();
    const mine = await a.tab();
    const agents = await a.tab();
    a.press(mine, "frame");
    await sleep(150);
    a.type("a");
    await a.click(agents, () => a.type("bc"));
    keyboard = "window";
    await sleep(30);
    expect(a.windowSent).toEqual(["b", "c"]);
    expect([mine.sent, agents.sent]).toEqual([[], []]);
    // Not to their page either where its frame has the keyboard again by then: it was never given back there.
    await a.click(agents, () => a.type("de"));
    keyboard = mine;
    mine.at = mine.frame;
    await sleep(30);
    expect(a.windowSent).toEqual(["b", "c", "d", "e"]);
    expect([mine.sent, agents.sent]).toEqual([[], []]);
});

test("Tab out of the frame into their page's own field: the keyboard and the keys go back to the page again", async () => {
    const a = start();
    const mine = await a.tab();
    const agents = await a.tab();
    a.press(mine, "frame");
    await sleep(150);
    a.type("a");
    // Tab, then the focus moves.
    a.type("\t");
    mine.at = mine.mainFrame;
    await sleep(150);
    expect(a.told.filter((m) => m.type === "framed")).toEqual([{ type: "framed", key: a.key(mine), framed: true }, { type: "framed", key: a.key(mine), framed: false }]);
    await a.click(agents, () => a.type("bc"));
    keyboard = mine;
    await sleep(30);
    expect(mine.sent).toEqual(["b", "c"]);
    expect(a.windowSent).toEqual([]);
});

test("the agent's own page never gets the person's keys, even where it keeps the keyboard", async () => {
    const a = start();
    const mine = await a.tab();
    const agents = await a.tab();
    a.press(mine, "page");
    await a.click(agents, () => a.type("xy"));
    // The window never takes the keyboard back: after the wait, they go to the window.
    await sleep(1100);
    expect(a.windowSent).toEqual(["x", "y"]);
    expect([agents.got, agents.sent, mine.sent]).toEqual([[], [], []]);
});

test("the person left their page: the window is told as the agent next acts there, but not while another page has the keyboard for the agent", async () => {
    const a = start();
    const mine = await a.tab();
    const agents = await a.tab();
    a.press(mine, "page");
    // Another page has the keyboard for the agent when the agent acts in theirs: they're still typing there.
    await a.click(agents, () => a.cmd("Runtime.evaluate", { expression: "1", userGesture: true }, a.sid(mine)));
    await sleep(10);
    expect(a.told.filter((m) => m.type === "left")).toEqual([]);
    keyboard = mine;
    a.type("ab");
    expect(mine.got).toEqual(["page:a", "page:b"]);
    // Back in the window (a press of theirs there, which only the window sees): the agent's next act in their page says so.
    keyboard = "window";
    await a.cmd("Runtime.evaluate", { expression: "1", userGesture: true }, a.sid(mine));
    expect(a.told.filter((m) => m.type === "left")).toEqual([{ type: "left", key: a.key(mine) }]);
});

test("the page's own script moves the keyboard into a frame: an agent's click elsewhere sends it, and the keys taken, to the window", async () => {
    // Nothing of the person's said so: the keyboard was given back to the page, landed on the page itself, and what
    // they typed for the frame went to the page.
    const a = start();
    const mine = await a.tab();
    const agents = await a.tab();
    a.press(mine, "page");
    a.type("a");
    await sleep(150);
    // Later, the page focuses a field in a frame of it.
    mine.at = mine.frame;
    await sleep(50);
    await a.click(agents, () => a.type("bc"));
    expect(a.told).toContainEqual({ type: "framed", key: a.key(mine), framed: true });
    a.handBack(mine);
    await sleep(30);
    a.type("d");
    expect(a.windowSent).toEqual(["b", "c", "typed:d"]);
    expect([mine.got, mine.sent, agents.sent]).toEqual([["page:a"], [], []]);
});

test("Tab from the window into a frame of a page: an agent's click elsewhere sends the keyboard, and the keys taken, to the window", async () => {
    const a = start();
    const mine = await a.tab();
    const agents = await a.tab();
    a.tabIn(mine, "frame");
    await sleep(150);
    expect(a.told).toContainEqual({ type: "person", key: a.key(mine), press: true });
    expect(a.told).toContainEqual({ type: "framed", key: a.key(mine), framed: true });
    await a.click(agents, () => a.type("xy"));
    a.handBack(mine);
    await sleep(30);
    expect(a.windowSent).toEqual(["x", "y"]);
    expect([mine.got, mine.sent]).toEqual([[], []]);
});

test("where the app's word and the page's keyboard disagree as the keys taken are sent, they go to the window", async () => {
    // Their page was given the keyboard back, and its script moved it into a frame at once: not the page's document.
    const a = start();
    const mine = await a.tab();
    const agents = await a.tab();
    a.press(mine, "page");
    await sleep(150);
    await a.click(agents, () => a.type("bc"));
    keyboard = mine;
    mine.at = mine.frame;
    await sleep(30);
    expect([a.windowSent, mine.sent]).toEqual([["b", "c"], []]);
    // Their keyboard was last in a frame of the page, and the page's document has it again: still not there.
    const b = start();
    const theirs = await b.tab();
    const other = await b.tab();
    b.press(theirs, "frame");
    await sleep(150);
    b.type("a");
    await b.click(other, () => b.type("bc"));
    keyboard = theirs;
    theirs.at = theirs.mainFrame;
    await sleep(30);
    expect([b.windowSent, theirs.sent]).toEqual([["b", "c"], []]);
});

test("the person pressing in the agent's page after it took their keys: those keys still go to the window, not there", async () => {
    const a = start();
    const mine = await a.tab();
    const agents = await a.tab();
    a.press(mine, "page");
    await a.click(agents, () => a.type("bc"));
    a.press(agents, "page");
    await sleep(1100);
    expect(a.windowSent).toEqual(["b", "c"]);
    expect([agents.sent, mine.sent]).toEqual([[], []]);
});

test("a key of theirs in a frame says so at once: the agent's page taking the keyboard just after sends it to the window", async () => {
    // The agent acted on its page just before (its script can take the keyboard a moment later, with no new command).
    const a = start();
    const mine = await a.tab();
    const agents = await a.tab();
    a.press(mine, "page");
    await sleep(150);
    await a.cmd("Runtime.evaluate", { expression: "1", userGesture: true }, a.sid(agents));
    mine.at = mine.frame;
    a.type("a");
    keyboard = agents;
    agents.at = agents.mainFrame;
    a.type("bc");
    a.handBack(mine);
    await sleep(30);
    expect(a.windowSent).toEqual(["b", "c"]);
    expect([mine.got, mine.sent, agents.got]).toEqual([["frame:a"], [], []]);
});

test("back in the window, then two agents pressing at once: the person's page they left doesn't keep the keys typed for the window", async () => {
    // Its own agent's press came while the other's page held the keyboard, which the app doesn't take for them leaving.
    const a = start();
    const mine = await a.tab();
    const agents = await a.tab();
    a.press(mine, "page");
    // A press in the message box: the window says so (page-focus.ts).
    keyboard = "window";
    a.host.back();
    await a.click(agents);
    await a.click(mine, () => a.type("xy"));
    expect(mine.got).toEqual([]);
    expect(a.told.filter((m) => m.type === "left")).toEqual([]);
});
