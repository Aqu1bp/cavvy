// What drives a page, with no browser running: key names and a person's key events as the browser wants them, what the
// GUI pane may send (checked, because it comes off the wire), who has a tab, how frames reach a slow window, and where
// a page may go.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { fromKeyboardEvent, modifierBits, parseKey } = await import("../src/browser/keys");
const { TabControl, TAKEN_OVER } = await import("../src/browser/control");
const { FrameFeed } = await import("../src/browser/feed");
const { parseInput, takesControl } = await import("../src/browser/interact");
const { addressToUrl, allowedPage, checkUrl, displayUrl, isLocalHost, navigationTarget } = await import("../src/browser/url-policy");

afterAll(iso.cleanup);

describe("keys by name", () => {
    test("a letter, a digit and punctuation are pressed on their own keys and type their character", () => {
        expect(parseKey("a")).toEqual({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0, text: "a" });
        expect(parseKey("7")).toEqual({ key: "7", code: "Digit7", windowsVirtualKeyCode: 55, modifiers: 0, text: "7" });
        expect(parseKey("/")).toEqual({ key: "/", code: "Slash", windowsVirtualKeyCode: 191, modifiers: 0, text: "/" });
    });

    test("Shift types the shifted character", () => {
        expect(parseKey("a", ["Shift"])).toMatchObject({ key: "A", code: "KeyA", modifiers: 8, text: "A" });
        expect(parseKey("5", ["Shift"])).toMatchObject({ key: "%", code: "Digit5", text: "%" });
        expect(parseKey("-", ["Shift"])).toMatchObject({ key: "_", code: "Minus", text: "_" });
        // a shifted character asked for as itself is its key with Shift held
        expect(parseKey("!")).toMatchObject({ key: "!", code: "Digit1", modifiers: 8, text: "!" });
        expect(parseKey("?")).toMatchObject({ key: "?", code: "Slash", modifiers: 8 });
    });

    test("named keys have codes and virtual key codes, and only Enter and Space type anything", () => {
        expect(parseKey("Enter")).toEqual({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r" });
        expect(parseKey("Tab")).toEqual({ key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 0 });
        expect(parseKey("ArrowDown")).toMatchObject({ code: "ArrowDown", windowsVirtualKeyCode: 40 });
        expect(parseKey("PageDown")).toMatchObject({ windowsVirtualKeyCode: 34 });
        expect(parseKey("F5")).toMatchObject({ code: "F5", windowsVirtualKeyCode: 116 });
        expect(parseKey("F12")).toMatchObject({ windowsVirtualKeyCode: 123 });
        expect(parseKey(" ")).toMatchObject({ key: " ", code: "Space", text: " " });
    });

    test("is lenient about what a key is called", () => {
        expect(parseKey("return")).toMatchObject({ key: "Enter" });
        expect(parseKey("esc")).toMatchObject({ key: "Escape", windowsVirtualKeyCode: 27 });
        expect(parseKey("space")).toMatchObject({ key: " " });
        expect(parseKey("pgdn")).toMatchObject({ key: "PageDown" });
        expect(parseKey("down")).toMatchObject({ key: "ArrowDown" });
        expect(parseKey("del")).toMatchObject({ key: "Delete" });
    });

    test("a combination holds its modifiers, and Control or Meta turns a letter into a command, not text", () => {
        const all = parseKey("Control+a")!;
        expect(all).toMatchObject({ key: "a", code: "KeyA", modifiers: 2, commands: ["selectAll"] });
        expect(all).not.toHaveProperty("text");
        expect(parseKey("ctrl+C")).toMatchObject({ code: "KeyC", modifiers: 2, commands: ["copy"] });
        expect(parseKey("cmd+v")).toMatchObject({ modifiers: 4, commands: ["paste"] });
        expect(parseKey("Meta+Shift+z")).toMatchObject({ modifiers: 12, commands: ["redo"] });
        expect(parseKey("Control+Shift+Alt+p")).toMatchObject({ modifiers: 2 | 8 | 1 });
        // the same, with the modifiers given apart
        expect(parseKey("a", ["Control"])).toEqual(parseKey("Control+a"));
        expect(parseKey("Enter", ["Control"])).not.toHaveProperty("text");
    });

    test("a plus key is a key, also with a modifier held", () => {
        expect(parseKey("+")).toMatchObject({ key: "+", code: "Equal", modifiers: 8 });
        expect(parseKey("Control++")).toMatchObject({ key: "+", modifiers: 2 | 8 });
    });

    test("a modifier pressed alone carries its own bit", () => {
        expect(parseKey("Shift")).toMatchObject({ key: "Shift", code: "ShiftLeft", modifiers: 8 });
        expect(parseKey("Control")).toMatchObject({ code: "ControlLeft", modifiers: 2 });
    });

    test("a character that isn't on a US keyboard is typed, with no key code", () => {
        expect(parseKey("é")).toEqual({ key: "é", code: "", windowsVirtualKeyCode: 0, modifiers: 0, text: "é" });
        expect(parseKey("日", ["Control"])).not.toHaveProperty("text");
    });

    test("anything else is not a key", () => {
        for (const bad of ["", "Foo", "Hyper+a", "Control+", "ab", "Control+Foo"]) expect(parseKey(bad)).toBeUndefined();
        expect(parseKey("a", ["Hyper"])).toBeUndefined();
    });

    test("modifier names, in any case, are bits", () => {
        expect(modifierBits(["Alt", "control", "META", "shift"])).toBe(15);
        expect(modifierBits(["option", "cmd", "nonsense"])).toBe(1 | 4);
        expect(modifierBits([])).toBe(0);
    });
});

describe("a person's key events", () => {
    test("keep the key and code the keyboard reported, whatever the layout", () => {
        expect(fromKeyboardEvent({ key: "a", code: "KeyQ", modifiers: 0 })).toMatchObject({ key: "a", code: "KeyQ", text: "a" });
        expect(fromKeyboardEvent({ key: "Enter", code: "NumpadEnter", modifiers: 0 })).toMatchObject({ key: "Enter", code: "NumpadEnter", windowsVirtualKeyCode: 13 });
        expect(fromKeyboardEvent({ key: "ß", code: "Minus", modifiers: 0 })).toMatchObject({ key: "ß", code: "Minus", text: "ß" });
    });

    test("carry the modifiers as sent, and commands for the editing shortcuts", () => {
        expect(fromKeyboardEvent({ key: "ArrowLeft", code: "ArrowLeft", modifiers: 8 })).toMatchObject({ modifiers: 8, windowsVirtualKeyCode: 37 });
        expect(fromKeyboardEvent({ key: "a", code: "KeyA", modifiers: 4 })).toMatchObject({ commands: ["selectAll"] });
        expect(fromKeyboardEvent({ key: "a", code: "KeyA", modifiers: 4 })).not.toHaveProperty("text");
    });

    test("an empty code falls back to the key's own", () => {
        expect(fromKeyboardEvent({ key: "a", code: "", modifiers: 0 })?.code).toBe("KeyA");
    });

    test("are nothing when they aren't a key (dead keys, an input method's), or malformed", () => {
        expect(fromKeyboardEvent({ key: "Dead", code: "KeyE", modifiers: 0 })).toBeUndefined();
        expect(fromKeyboardEvent({ key: "Process", code: "", modifiers: 0 })).toBeUndefined();
        expect(fromKeyboardEvent({ key: 5, code: "KeyE", modifiers: 0 } as never)).toBeUndefined();
        expect(fromKeyboardEvent({ key: "a", code: "KeyA", modifiers: "1" } as never)).toBeUndefined();
    });
});

describe("who has a tab", () => {
    test("the agent may act on its own tab, and on one nobody has", () => {
        const own = new TabControl("agent");
        expect(own.agentAct()).toEqual({ ok: true });
        const open = new TabControl();
        expect(open.owner).toBe("none");
        expect(open.agentAct()).toEqual({ ok: true });
        expect(open.owner).toBe("agent");
    });

    test("a person using the pane takes the tab, and the agent is refused with what to do", () => {
        const c = new TabControl("agent");
        expect(c.humanInput()).toBe(true);
        expect(c.owner).toBe("human");
        const refused = c.agentAct();
        expect(refused).toEqual({ ok: false, error: TAKEN_OVER });
        expect(TAKEN_OVER).toContain("taken control");
        expect(TAKEN_OVER).toContain("Hand back to agent");
        expect(c.owner).toBe("human");
        // more input from them changes nothing: the refs were stale already
        expect(c.humanInput()).toBe(false);
    });

    test("handing back returns it to the agent, once", () => {
        const c = new TabControl("agent");
        expect(c.handBack()).toBe(false);
        c.humanInput();
        expect(c.handBack()).toBe(true);
        expect(c.owner).toBe("agent");
        expect(c.agentAct()).toEqual({ ok: true });
        expect(c.handBack()).toBe(false);
    });

    test("a tab the person opened is theirs from the start; a tab nobody had is taken from nobody", () => {
        const theirs = new TabControl("human");
        expect(theirs.agentAct().ok).toBe(false);
        expect(theirs.humanInput()).toBe(false);
        const free = new TabControl("none");
        expect(free.humanInput()).toBe(true);
    });
});

describe("what the pane may send", () => {
    test("a mouse event, with a button and the buttons held", () => {
        expect(parseInput({ kind: "mouse", type: "down", x: 10.5, y: 20, button: "right", buttons: 2, clickCount: 2, modifiers: 8 })).toEqual({ kind: "mouse", type: "down", x: 10.5, y: 20, button: "right", buttons: 2, clickCount: 2, modifiers: 8 });
        // what's left out is the default: one click, no buttons, no modifiers
        expect(parseInput({ kind: "mouse", type: "move", x: 1, y: 2 })).toEqual({ kind: "mouse", type: "move", x: 1, y: 2, buttons: 0, clickCount: 1, modifiers: 0 });
    });

    test("numbers are held to what they can be", () => {
        expect(parseInput({ kind: "mouse", type: "up", x: 1e9, y: -1e9, buttons: 99, clickCount: 40, modifiers: 255 })).toMatchObject({ x: 100_000, y: -100_000, buttons: 31, clickCount: 3, modifiers: 15 });
        expect(parseInput({ kind: "wheel", x: 1, y: 2, deltaX: 1e9, deltaY: -1e9 })).toMatchObject({ deltaX: 100_000, deltaY: -100_000, modifiers: 0 });
    });

    test("an unknown button is no button, and a bad number is no event", () => {
        expect(parseInput({ kind: "mouse", type: "down", x: 1, y: 2, button: "back" })).not.toHaveProperty("button");
        for (const bad of [{ x: "1", y: 2 }, { x: 1 }, { x: NaN, y: 1 }, { x: Infinity, y: 1 }, { x: 1, y: 2, type: "click" }]) expect(parseInput({ kind: "mouse", type: "down", ...bad })).toBeUndefined();
        expect(parseInput({ kind: "wheel", x: 1, y: 2, deltaX: 0 })).toBeUndefined();
    });

    test("a key has a name and a code of a sane length", () => {
        expect(parseInput({ kind: "key", type: "down", key: "a", code: "KeyA", modifiers: 2 })).toEqual({ kind: "key", type: "down", key: "a", code: "KeyA", modifiers: 2 });
        expect(parseInput({ kind: "key", type: "up", key: "Enter", code: "" })).toEqual({ kind: "key", type: "up", key: "Enter", code: "", modifiers: 0 });
        for (const bad of [{ key: "" }, { key: "x".repeat(33) }, { key: "a", code: "x".repeat(33) }, { key: 1 }, { type: "press" }]) expect(parseInput({ kind: "key", type: "down", key: "a", code: "KeyA", ...bad })).toBeUndefined();
    });

    test("text is text, not empty and not unbounded", () => {
        expect(parseInput({ kind: "text", text: "héllo" })).toEqual({ kind: "text", text: "héllo" });
        expect(parseInput({ kind: "text", text: "" })).toBeUndefined();
        expect(parseInput({ kind: "text", text: "x".repeat(100_001) })).toBeUndefined();
        expect(parseInput({ kind: "text", text: 5 })).toBeUndefined();
    });

    test("nothing else is an input", () => {
        for (const bad of [undefined, null, "click", 5, [], {}, { kind: "eval", code: "1" }, { kind: "mouse" }]) expect(parseInput(bad)).toBeUndefined();
    });

    test("only a pointer moving, with nothing held, leaves the tab with the agent", () => {
        expect(takesControl({ kind: "mouse", type: "move", x: 1, y: 1, buttons: 0 })).toBe(false);
        expect(takesControl({ kind: "mouse", type: "move", x: 1, y: 1 })).toBe(false);
        expect(takesControl({ kind: "mouse", type: "move", x: 1, y: 1, buttons: 1 })).toBe(true);
        expect(takesControl({ kind: "mouse", type: "down", x: 1, y: 1 })).toBe(true);
        expect(takesControl({ kind: "wheel", x: 1, y: 1, deltaX: 0, deltaY: 5 })).toBe(true);
        expect(takesControl({ kind: "key", type: "down", key: "a", code: "KeyA" })).toBe(true);
        expect(takesControl({ kind: "text", text: "a" })).toBe(true);
    });
});

describe("frames on their way to windows", () => {
    function setup() {
        let now = 0;
        const feed = new FrameFeed<string>();
        const a = { got: [] as string[], ids: [] as string[] };
        const b = { got: [] as string[], ids: [] as string[] };
        feed.add(a, (f, id) => { a.got.push(f); a.ids.push(id); });
        feed.add(b, (f, id) => { b.got.push(f); b.ids.push(id); });
        return { feed, a, b, tick: (ms: number) => (now += ms) };
    }

    test("a window is sent one frame, and the next only when it says it drew that one", () => {
        const { feed, a } = setup();
        feed.push("f1");
        feed.push("f2");
        feed.push("f3");
        expect(a.got).toEqual(["f1"]);
        feed.ack(a, a.ids.at(-1)!);
        // the newest frame that came while it was busy, not every one: a slow window never builds a backlog
        expect(a.got).toEqual(["f1", "f3"]);
        feed.ack(a, a.ids.at(-1)!);
        expect(a.got).toEqual(["f1", "f3"]);
        feed.push("f4");
        expect(a.got).toEqual(["f1", "f3", "f4"]);
    });

    test("each window goes at its own pace", () => {
        const { feed, a, b } = setup();
        feed.push("f1");
        feed.ack(a, a.ids.at(-1)!);
        feed.push("f2");
        feed.push("f3");
        expect(a.got).toEqual(["f1", "f2"]);
        expect(b.got).toEqual(["f1"]);
        feed.ack(b, b.ids.at(-1)!);
        expect(b.got).toEqual(["f1", "f3"]);
    });

    test("a stalled viewer never receives another frame without its matching acknowledgement", () => {
        const { feed, a, tick } = setup();
        feed.push("f1");
        tick(3000);
        feed.push("f2");
        expect(a.got).toEqual(["f1"]);
        tick(2);
        feed.push("f3");
        expect(a.got).toEqual(["f1"]);
        feed.ack(a, "wrong");
        expect(a.got).toEqual(["f1"]);
        feed.ack(a, a.ids[0]!);
        expect(a.got).toEqual(["f1", "f3"]);
        feed.push("f4");
        feed.ack(a, a.ids[0]!);
        expect(a.got).toEqual(["f1", "f3"]);
    });

    test("resizing preserves backpressure and a departed subscription cannot acknowledge its replacement", () => {
        const { feed, a } = setup();
        feed.push("old");
        const oldId = a.ids[0]!;
        feed.add(a, (f, id) => { a.got.push(f); a.ids.push(id); });
        feed.push("resized");
        expect(a.got).toEqual(["old"]);
        feed.remove(a);
        feed.add(a, (f, id) => { a.got.push(f); a.ids.push(id); });
        feed.push("new");
        feed.push("waiting");
        feed.ack(a, oldId);
        expect(a.got).toEqual(["old", "new"]);
        feed.ack(a, a.ids.at(-1)!);
        expect(a.got).toEqual(["old", "new", "waiting"]);
    });

    test("a window that is gone gets nothing, and an answer from a stranger is ignored", () => {
        const { feed, a, b } = setup();
        expect(feed.size).toBe(2);
        feed.remove(a);
        expect(feed.has(a)).toBe(false);
        feed.push("f1");
        expect(a.got).toEqual([]);
        expect(b.got).toEqual(["f1"]);
        expect(() => feed.ack({}, "unknown")).not.toThrow();
        expect(feed.size).toBe(1);
    });

    test("what waited is dropped when the window shows another page", () => {
        const { feed, a } = setup();
        feed.push("old");
        feed.push("stale");
        feed.clearWaiting();
        feed.ack(a, a.ids.at(-1)!);
        expect(a.got).toEqual(["old"]);
    });
});

describe("where a page may go", () => {
    const root = tempDir("cavvy-browser-policy-");
    const outside = tempDir("cavvy-browser-outside-");
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app", "index.html"), "<p>hi</p>");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "link"));
    const file = (path: string) => `file://${path}`;

    test("http and https pages, and about:blank", () => {
        expect(checkUrl("http://localhost:3000/", root)).toEqual({ ok: true, url: "http://localhost:3000/" });
        expect(checkUrl("  https://Example.com/a b?x=1#y ", root)).toEqual({ ok: true, url: "https://example.com/a%20b?x=1#y" });
        expect(checkUrl("about:blank", root)).toEqual({ ok: true, url: "about:blank" });
    });

    test("not the browser's own pages, scripts, inline documents or the rest", () => {
        for (const url of ["javascript:alert(1)", "data:text/html,<script>1</script>", "chrome://settings", "chrome://password-manager/passwords", "view-source:https://example.com", "blob:http://localhost/uuid", "ftp://example.com/x", "ws://localhost:1/", "chrome-extension://abc/page.html", "devtools://devtools/bundled/inspector.html", "about:srcdoc", "about:config", "mailto:a@b.c", "filesystem:http://localhost/temporary/x"]) {
            const r = checkUrl(url, root);
            expect(r.ok, url).toBe(false);
            expect("error" in r && r.error, url).toBeTruthy();
        }
    });

    test("an address that isn't one says what a URL looks like", () => {
        for (const url of ["", "localhost:3000", "not a url", "//example.com", "/relative/path", "http://"]) {
            const r = checkUrl(url, root);
            expect(r.ok, url).toBe(false);
        }
        expect((checkUrl("nonsense", root) as { error: string }).error).toContain("Give a full URL");
        // a very long one is cut in the message
        expect((checkUrl("x".repeat(1000), root) as { error: string }).error.length).toBeLessThan(400);
    });

    test("files inside the project", () => {
        expect(checkUrl(file(join(root, "app", "index.html")), root)).toMatchObject({ ok: true });
        expect(checkUrl(file(join(root, "app")), root)).toMatchObject({ ok: true });
    });

    test("not files outside it, however the path is spelled", () => {
        for (const url of [file(join(outside, "secret.txt")), file("/etc/passwd"), file(join(root, "..", "etc", "passwd")), file(`${root}/app/../../../etc/passwd`), file(`${root}%2F..%2F..%2Fetc%2Fpasswd`), "file://remote.example/share/x", "file:///", file(`${root}-sibling/x`)]) {
            expect(checkUrl(url, root).ok, url).toBe(false);
        }
        expect((checkUrl("file:///etc/passwd", root) as { error: string }).error).toContain("limited to the project");
    });

    test("not through a link inside the project that leaves it", () => {
        expect(checkUrl(file(join(root, "link", "secret.txt")), root).ok).toBe(false);
    });

    test("a page that has gone somewhere by itself is held to the same rules, and the browser's own error page is allowed", () => {
        expect(allowedPage("http://localhost:3000/x", root)).toBe(true);
        expect(allowedPage("about:blank", root)).toBe(true);
        expect(allowedPage("", root)).toBe(true);
        expect(allowedPage("chrome-error://chromewebdata/", root)).toBe(true);
        expect(allowedPage("chrome://settings/", root)).toBe(false);
        expect(allowedPage("data:text/html,x", root)).toBe(false);
        expect(allowedPage("javascript:1", root)).toBe(false);
        expect(allowedPage("file:///etc/passwd", root)).toBe(false);
    });

    test("a dev server is local; so are loopback addresses", () => {
        for (const h of ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "0.0.0.0"]) expect(isLocalHost(h), h).toBe(true);
        for (const h of ["example.com", "localhost.example.com", "127.0.0.1.example.com", "10.0.0.5", "192.168.1.2", "128.0.0.1", ""]) expect(isLocalHost(h), h).toBe(false);
    });

    test("what a person types in the address bar", () => {
        expect(addressToUrl("localhost:3000")).toBe("http://localhost:3000");
        expect(addressToUrl("localhost:3000/a?b=1")).toBe("http://localhost:3000/a?b=1");
        expect(addressToUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
        expect(addressToUrl("[::1]:5173/x")).toBe("http://[::1]:5173/x");
        expect(addressToUrl("example.com")).toBe("https://example.com");
        expect(addressToUrl("example.com/a/b")).toBe("https://example.com/a/b");
        expect(addressToUrl("app.localhost")).toBe("http://app.localhost");
        expect(addressToUrl("192.168.1.2/admin")).toBe("http://192.168.1.2/admin");
        expect(addressToUrl("https://example.com/x")).toBe("https://example.com/x");
        expect(addressToUrl("  http://localhost:3000  ")).toBe("http://localhost:3000");
        // a scheme is left for the policy to judge
        expect(addressToUrl("javascript:alert(1)")).toBe("javascript:alert(1)");
        expect(addressToUrl("file:///tmp/x.html")).toBe("file:///tmp/x.html");
    });

    test("and what isn't an address", () => {
        for (const text of ["", "   ", "two words", "word", "a b.c", "http://exa mple.com"]) expect(addressToUrl(text), text).toBeUndefined();
    });

    test("a navigation is local, to a host, or to somewhere the browser won't go; going back opens nothing", () => {
        expect(navigationTarget({ url: "http://localhost:3000/" })).toEqual({ kind: "local" });
        expect(navigationTarget({ action: "new_tab", url: "http://127.0.0.1:1/" })).toEqual({ kind: "local" });
        expect(navigationTarget({ url: "file:///tmp/x.html" })).toEqual({ kind: "local" });
        expect(navigationTarget({ url: "about:blank" })).toEqual({ kind: "local" });
        expect(navigationTarget({ url: "https://Example.COM/a" })).toEqual({ kind: "host", host: "example.com" });
        expect(navigationTarget({ action: "goto", url: "http://user:pw@evil.test:8080/" })).toEqual({ kind: "host", host: "evil.test" });
        expect(navigationTarget({ url: "javascript:alert(1)" })).toEqual({ kind: "other" });
        expect(navigationTarget({ url: "chrome://settings" })).toEqual({ kind: "other" });
        expect(navigationTarget({ url: "not a url" })).toEqual({ kind: "other" });
        for (const action of ["back", "forward", "reload", "list_tabs", "switch_tab", "close_tab", "resize"]) expect(navigationTarget({ action, url: "https://example.com" })).toBeUndefined();
        expect(navigationTarget({ action: "new_tab" })).toBeUndefined();
        expect(navigationTarget({})).toBeUndefined();
        expect(navigationTarget({ url: "  " })).toBeUndefined();
        expect(navigationTarget({ url: 5 })).toBeUndefined();
    });

    test("a URL in a message carries no password and isn't endless", () => {
        expect(displayUrl("http://user:hunter2@example.com/x")).toBe("http://example.com/x");
        expect(displayUrl("http://user@example.com/x")).toBe("http://example.com/x");
        expect(displayUrl("not a url")).toBe("not a url");
        const long = displayUrl(`http://example.com/${"a".repeat(500)}`);
        expect(long.length).toBe(301);
        expect(long.endsWith("…")).toBe(true);
    });
});
