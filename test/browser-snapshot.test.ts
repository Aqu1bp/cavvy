// How the browser tells the agent about a page, with no browser running: the outline built from an accessibility tree
// (what's pruned, what gets a ref, what's masked, where it's cut), refs and when they go stale, what changed between
// two outlines, the console and network logs, and the header and body of a page report.
import { registerSecret, unregisterSecret } from "../src/util/redact";
import { describe, expect, test } from "bun:test";
import { domFacts, outlineOf, SNAPSHOT_CHARS } from "../src/browser/ax";
import { outlineDiff } from "../src/browser/diff";
import { CONSOLE_CAPACITY, ConsoleLog, formatLogs, NETWORK_CAPACITY, NetworkLog, Ring } from "../src/browser/logs";
import { RefTable } from "../src/browser/refs";
import { pageHeader, pageReport } from "../src/browser/report";
import { TabControl } from "../src/browser/control";
import { displayUrl } from "../src/browser/url-policy";
import { axTree, SHOP, SHOP_DOM, text, type AxSpec } from "./helpers/ax-tree";

const outline = (spec: AxSpec = SHOP, o: { refs?: RefTable; maxChars?: number } = {}) => outlineOf(axTree(spec), { refs: o.refs ?? new RefTable(), dom: domFacts(SHOP_DOM), maxChars: o.maxChars });

describe("the outline of a page", () => {
    test("keeps what a person sees and uses, in order, with roles, names, states and values", () => {
        expect(outline().text).toBe(
            [
                "- banner",
                "  - navigation \"Main\" [e1]",
                "    - link \"Other page\" [e2] -> /other",
                "    - link \"Jump\" [e3] -> /#frag",
                "- main",
                "  - heading \"Fixture shop\" [e4] level=1",
                "  - text \"Welcome to the shop. Everything is fake.\"",
                "  - button \"Click me\" [e5]",
                "  - textbox \"Search\" [e6] required value=\"shoes\"",
                "  - textbox \"Password\" [e7] value=\"[hidden]\"",
                "  - checkbox \"I agree\" [e8] unchecked",
                "  - combobox \"Size\" [e9] collapsed value=\"Small\"",
                "    - option \"Small\" [e10] selected",
                "  - button \"Go\" [e11] disabled",
                "  - list",
                "    - listitem",
                "      - text \"One\"",
                "    - listitem",
                "      - text \"Two\"",
            ].join("\n"),
        );
    });

    test("leaves out wrappers, ignored nodes, empty regions and text a name already says", () => {
        const text_ = outline().text;
        // generic containers, paragraphs and the unnamed form and status vanish, with their content kept
        for (const gone of ["generic", "paragraph", "form", "status", "RootWebArea", "StaticText", "InlineTextBox", "ListMarker", "LabelText"]) expect(text_).not.toContain(gone);
        // the label's words are the textbox's name, and a button's words its own: neither is said twice
        expect(text_.match(/Search/g)).toHaveLength(1);
        expect(text_.match(/Click me/g)).toHaveLength(1);
        // a bullet nobody reads
        expect(text_).not.toContain("•");
    });

    test("joins a sentence broken by inline styling back together", () => {
        expect(outline().text).toContain('text "Welcome to the shop. Everything is fake."');
    });

    test("gives refs to what can be acted on or has a name, numbered in the order shown", () => {
        const o = outline();
        expect([...o.entries].map(([ref, e]) => `${ref} ${e.role} ${e.name}`)).toEqual([
            "e1 navigation Main",
            "e2 link Other page",
            "e3 link Jump",
            "e4 heading Fixture shop",
            "e5 button Click me",
            "e6 textbox Search",
            "e7 textbox Password",
            "e8 checkbox I agree",
            "e9 combobox Size",
            "e10 option Small",
            "e11 button Go",
        ]);
        // a ref names the DOM node, which is what acting needs
        expect(o.entries.get("e5")?.backendNodeId).toBe(19);
        expect(o.entries.get("e7")?.backendNodeId).toBe(25);
    });

    test("never shows what a password field holds", () => {
        const o = outline();
        expect(o.text).toContain('textbox "Password" [e7] value="[hidden]"');
        expect(o.text).not.toContain("hunter2");
    });

    test("an unnamed button still gets a ref, an unnamed region none", () => {
        const o = outline({ id: "1", role: "RootWebArea", node: 1, kids: [{ id: "2", role: "button", node: 2 }, { id: "3", role: "region", node: 3, kids: [text("4", "inside")] }] });
        expect(o.text).toBe('- button [e1]\n- text "inside"');
    });

    test("says which way a link goes: a path on the same site, the whole address elsewhere", () => {
        const dom = domFacts({ strings: ["", "A", "href", "https://other.example/x?y=1", "/local?q=2", "http://127.0.0.1:1234/page"], documents: [{ baseURL: 5, nodes: { nodeName: [1, 1], backendNodeId: [2, 3], attributes: [[2, 3], [2, 4]] } }] });
        const links = outlineOf(axTree({ id: "1", role: "RootWebArea", node: 1, kids: [{ id: "2", role: "link", name: "Away", node: 2 }, { id: "3", role: "link", name: "Here", node: 3 }] }), { refs: new RefTable(), dom });
        expect(links.text).toBe('- link "Away" [e1] -> https://other.example/x?y=1\n- link "Here" [e2] -> /local?q=2');
    });

    test("reports checkable states, including mixed and on, and marks a field invalid", () => {
        const o = outline({
            id: "1",
            role: "RootWebArea",
            node: 1,
            kids: [
                { id: "2", role: "checkbox", name: "A", node: 2, props: { checked: "true" } },
                { id: "3", role: "checkbox", name: "B", node: 3, props: { checked: "mixed" } },
                { id: "4", role: "switch", name: "C", node: 4 },
                { id: "5", role: "button", name: "D", node: 5, props: { pressed: "true", expanded: true } },
                { id: "6", role: "textbox", name: "E", node: 6, props: { invalid: "true", readonly: true } },
            ],
        });
        expect(o.text.split("\n")).toEqual(['- checkbox "A" [e1] checked', '- checkbox "B" [e2] mixed', '- switch "C" [e3] unchecked', '- button "D" [e4] expanded pressed', '- textbox "E" [e5] readonly invalid']);
    });

    test("cuts a long page at the limit and counts what it left out", () => {
        const items: AxSpec[] = Array.from({ length: 200 }, (_, i) => ({ id: `b${i}`, role: "button", name: `Button number ${i}`, node: 100 + i }));
        const refs = new RefTable();
        const o = outline({ id: "1", role: "RootWebArea", node: 1, kids: items }, { refs, maxChars: 1000 });
        expect(o.lines).toBe(200);
        expect(o.shown).toBeGreaterThan(20);
        expect(o.shown).toBeLessThan(60);
        expect(o.text.length).toBeLessThanOrEqual(1000);
        expect(o.text.split("\n")).toHaveLength(o.shown);
        // only what is shown has a ref, so every ref listed is in the text
        expect(o.entries.size).toBe(o.shown);
        expect(o.text).toContain("[e1]");
        expect(o.text).not.toContain(`Button number ${o.shown + 5}`);
        expect(outline().shown).toBe(outline().lines);
        expect(SNAPSHOT_CHARS).toBeGreaterThan(10_000);
    });

    test("redacts original names and values before shortening them", () => {
        const secret = "private-outline-value-987654321";
        registerSecret(secret);
        try {
            const name = outline({ role: "button", name: "x".repeat(150) + secret }).text;
            const value = outline({ role: "textbox", name: "Field", value: "x".repeat(110) + secret }).text;
            expect(name).not.toContain("private-ou");
            expect(value).not.toContain("private-ou");
        } finally { unregisterSecret(secret); }
    });

    test("shortens a very long name and collapses its whitespace", () => {
        const o = outline({ id: "1", role: "RootWebArea", node: 1, kids: [{ id: "2", role: "button", name: `Buy\n   now ${"x".repeat(400)}`, node: 2 }] });
        const line = o.text;
        expect(line).toContain('"Buy now ');
        expect(line).toContain("…");
        expect(line.length).toBeLessThan(220);
    });

    test("an empty or rootless tree is an empty outline, and a cycle can't loop", () => {
        expect(outlineOf([], { refs: new RefTable() })).toMatchObject({ text: "", lines: 0, shown: 0 });
        const loop = axTree({ id: "1", role: "RootWebArea", node: 1, kids: [{ id: "2", role: "group", name: "g", node: 2 }] });
        loop[1]!.childIds = ["1", "2"];
        expect(outlineOf(loop, { refs: new RefTable() }).text).toBe('- group "g" [e1]');
    });
});

describe("what the DOM adds to the tree", () => {
    test("link targets and password fields are found by node", () => {
        const facts = domFacts(SHOP_DOM);
        expect(facts.hrefs.get(4)).toBe("/other");
        expect(facts.hrefs.get(6)).toBe("/#frag");
        expect([...facts.secret]).toEqual([25]);
        // an input that isn't a password, and nodes that aren't links, add nothing
        expect(facts.hrefs.has(25)).toBe(false);
        expect(facts.hrefs.has(8)).toBe(false);
    });
});

describe("refs", () => {
    const entry = (n: number) => ({ backendNodeId: n, role: "button", name: `B${n}` });
    /** Why a ref didn't resolve ("" if it did). */
    const why = (r: ReturnType<RefTable["resolve"]>) => ("error" in r ? r.error : "");

    test("an element keeps its ref from one snapshot to the next, new ones count on", () => {
        const refs = new RefTable();
        expect(refs.refFor(10)).toBe("e1");
        expect(refs.refFor(20)).toBe("e2");
        expect(refs.refFor(10)).toBe("e1");
        expect(refs.refFor(30)).toBe("e3");
    });

    test("only the latest snapshot's refs resolve", () => {
        const refs = new RefTable();
        refs.replace(new Map([["e1", entry(10)]]));
        expect(refs.resolve("e1")).toEqual({ entry: entry(10) });
        // the way a ref is written in an outline, and a little loosely
        expect(refs.resolve("[e1]")).toEqual({ entry: entry(10) });
        expect(refs.resolve(" e1 ")).toEqual({ entry: entry(10) });
        refs.replace(new Map([["e2", entry(20)]]));
        expect(why(refs.resolve("e1"))).toContain("isn't in the latest snapshot");
    });

    test("a page that changed ends them all, and the error says to snapshot again", () => {
        const refs = new RefTable();
        refs.refFor(10);
        refs.replace(new Map([["e1", entry(10)]]));
        expect(refs.generation).toBe(0);
        refs.invalidate();
        expect(refs.generation).toBe(1);
        expect(refs.size).toBe(0);
        expect(why(refs.resolve("e1"))).toContain("stale");
        expect(why(refs.resolve("e1"))).toContain("BrowserSnapshot");
        // a ref never seen at all is another error
        expect(why(refs.resolve("e9"))).toContain("Unknown ref e9");
    });

    test("a number is never reused after the page changes, so an old ref can't name a new element", () => {
        const refs = new RefTable();
        expect(refs.refFor(10)).toBe("e1");
        refs.invalidate();
        // the same node gets a new number in the new generation, and the old number is still stale
        expect(refs.refFor(10)).toBe("e2");
        refs.replace(new Map([["e2", entry(10)]]));
        expect(refs.resolve("e2")).toEqual({ entry: entry(10) });
        expect(why(refs.resolve("e1"))).toContain("stale");
    });

    test("something that isn't a ref says what refs look like", () => {
        const refs = new RefTable();
        for (const bad of ["", "12", "button", "e", "e1x"]) expect(why(refs.resolve(bad))).toContain("isn't a ref");
    });

    test("an endless feed starts the numbering over rather than growing without bound", () => {
        const refs = new RefTable();
        for (let n = 1; n <= 20_000; n++) refs.refFor(n);
        expect(refs.generation).toBe(0);
        refs.refFor(30_000);
        expect(refs.generation).toBe(1);
    });
});

describe("what changed in an outline", () => {
    /** A page of enough lines that telling a change is shorter than telling the page. */
    const lines = (extra: string[] = [], items = 30) => ["- main", '  - heading "Shop" [e1] level=1', '  - button "Add" [e2]', "  - list", ...Array.from({ length: items }, (_, i) => `    - listitem "Item ${i}"`), ...extra].join("\n");
    const base = lines();

    test("a page that didn't change says so", () => {
        expect(outlineDiff(base, base)).toBe("The page's outline hasn't changed.");
    });

    test("a new line shows with the lines it sits in, unmarked, so it reads in place", () => {
        const next = base.replace('    - listitem "Item 7"', '    - listitem "Item 7"\n    - listitem "Seven and a half"');
        const diff = outlineDiff(base, next)!;
        expect(diff).toContain("Changed since the last snapshot");
        expect(diff).toContain('+     - listitem "Seven and a half"');
        expect(diff).toContain("  - main");
        expect(diff).toContain("    - list\n");
        expect(diff).not.toContain("Item 7");
        expect(diff).not.toContain("[e1]");
        expect(diff).not.toContain("Gone:");
    });

    test("what went away is listed", () => {
        const gone = outlineDiff(base, base.replace('  - button "Add" [e2]\n', ""))!;
        expect(gone).toContain("Gone:");
        expect(gone).toContain('- button "Add" [e2]');
        // a long list of what went is cut
        const all = lines([], 150).split("\n");
        const many = outlineDiff(all.join("\n"), [...all.slice(0, 10), ...all.slice(32)].join("\n"))!;
        expect(many).toContain("Gone:");
        expect(many).toContain("… 2 more");
    });

    test("a changed value is a new line and an old one gone", () => {
        const diff = outlineDiff(lines(['  - textbox "Q" [e3]']), lines(['  - textbox "Q" [e3] value="shoes"']))!;
        expect(diff).toContain('+   - textbox "Q" [e3] value="shoes"');
        expect(diff).toContain('Gone:\n  - textbox "Q" [e3]');
    });

    test("a change as large as the page is better told as the page", () => {
        const before = Array.from({ length: 10 }, (_, i) => `- text "line ${i}"`).join("\n");
        const after = Array.from({ length: 10 }, (_, i) => `- text "other ${i}"`).join("\n");
        expect(outlineDiff(before, after)).toBeUndefined();
        const many = Array.from({ length: 300 }, (_, i) => `  - text "n${i}"`).join("\n");
        expect(outlineDiff(base, `${base}\n${many}`)).toBeUndefined();
    });

    test("an empty page against a page, and the reverse", () => {
        expect(outlineDiff("", "")).toBe("The page's outline hasn't changed.");
        expect(outlineDiff("", '- text "a"')).toBeUndefined();
        // a page that went blank: shorter to say what's gone than the (empty) page, so it is the whole outline
        expect(outlineDiff(base, "")).toBeUndefined();
    });
});

describe("the console and network logs", () => {
    test("keep only the latest entries, and say how many went", () => {
        const ring = new Ring<number>(3);
        for (let n = 1; n <= 5; n++) ring.push(n);
        expect(ring.items).toEqual([3, 4, 5]);
        expect(ring.dropped).toBe(2);
        ring.clear();
        expect(ring.items).toEqual([]);
        expect(ring.dropped).toBe(0);
        const log = new ConsoleLog();
        for (let n = 0; n < CONSOLE_CAPACITY + 10; n++) log.add("log", `m${n}`);
        expect(log.entries).toHaveLength(CONSOLE_CAPACITY);
        expect(log.dropped).toBe(10);
        expect(log.entries[0]!.text).toBe("m10");
    });

    test("count errors and exceptions not yet looked at", () => {
        const log = new ConsoleLog();
        log.add("log", "hello");
        log.add("warn", "careful");
        expect(log.unseenErrors).toBe(0);
        log.add("error", "bad");
        log.add("exception", "worse");
        expect(log.unseenErrors).toBe(2);
        log.clear();
        expect(log.unseenErrors).toBe(0);
        expect(log.entries).toEqual([]);
    });

    test("cut a long message, and redact a secret before the cut can hide half of it", () => {
        const log = new ConsoleLog();
        const key = `sk-ant-api03-${"a1B2c3D4e5".repeat(4)}`;
        log.add("error", `${"x".repeat(470)} token=${key} and more`);
        const kept = log.entries[0]!.text;
        expect(kept.length).toBeLessThanOrEqual(501);
        expect(kept).not.toContain("sk-ant");
        expect(kept).not.toContain("a1B2c3D4e5");
        log.add("log", "y".repeat(800));
        expect(log.entries[1]!.text).toHaveLength(501);
        expect(log.entries[1]!.text.endsWith("…")).toBe(true);
    });

    test("follow a request from its start to its end, and a redirect finishes the hop before it", () => {
        const net = new NetworkLog();
        net.start("1", "GET", "http://x.test/a", "Document");
        expect(net.inflight).toBe(1);
        net.response("1", 200);
        net.finish("1");
        expect(net.inflight).toBe(0);
        net.start("2", "GET", "http://x.test/old", "XHR");
        net.start("2", "GET", "http://x.test/new", "XHR", { status: 302 });
        expect(net.entries.map((e) => [e.url, e.status, e.done])).toEqual([
            ["http://x.test/a", 200, true],
            ["http://x.test/old", 302, true],
            ["http://x.test/new", undefined, false],
        ]);
        expect(net.inflight).toBe(1);
        net.fail("2", "net::ERR_CONNECTION_REFUSED", false);
        expect(net.entries.at(-1)).toMatchObject({ failure: "net::ERR_CONNECTION_REFUSED", done: true });
        expect(net.inflight).toBe(0);
        expect(net.started).toBe(3);
    });

    test("a cancelled request is not a failure, and requests that stay open by design don't hold the page busy", () => {
        const net = new NetworkLog();
        net.start("1", "GET", "http://x.test/slow", "Fetch");
        net.fail("1", "net::ERR_ABORTED", true);
        expect(net.entries[0]!.failure).toBeUndefined();
        net.start("2", "GET", "http://x.test/events", "EventSource");
        net.start("3", "GET", "ws://x.test/socket", "WebSocket");
        expect(net.inflight).toBe(0);
        net.start("4", "GET", "http://x.test/late", "Fetch");
        net.forgetInflight();
        expect(net.inflight).toBe(0);
    });

    test("don't list data and blob URLs, and keep only the latest requests", () => {
        const net = new NetworkLog();
        net.start("1", "GET", "data:image/png;base64,AAAA", "Image");
        net.start("2", "GET", "blob:http://x.test/uuid", "Image");
        expect(net.entries).toEqual([]);
        expect(net.started).toBe(0);
        for (let n = 0; n < NETWORK_CAPACITY + 5; n++) net.start(`r${n}`, "GET", `http://x.test/${n}`, "Fetch");
        expect(net.entries).toHaveLength(NETWORK_CAPACITY);
        expect(net.dropped).toBe(5);
        // a response for one that was dropped is ignored
        expect(() => net.response("r0", 200)).not.toThrow();
    });

    test("a secret that starts near where a long address is cut is taken out whole first, not left as a prefix", () => {
        const net = new NetworkLog();
        const key = `sk-ant-api03-${"Zq8Xw7Vv6".repeat(5)}`;
        // the key starts 20 characters before the cut at 300
        net.start("1", "GET", `http://x.test/${"p".repeat(265)}?k=${key}`, "Fetch");
        const read = formatLogs("network", new ConsoleLog(), net);
        expect(read).not.toContain("sk-ant");
        expect(read).not.toContain("Zq8Xw7");
        expect(read).toContain("[REDACTED anthropi");
        // the same for the tab's own address in a report
        const long = displayUrl(`http://x.test/${"p".repeat(280)}?k=${key}`);
        expect(long).not.toContain("sk-ant");
        expect(long.length).toBeLessThanOrEqual(301);
    });

    test("read as lines for the agent, secrets and passwords in URLs out of them", () => {
        const consoleLog = new ConsoleLog();
        const net = new NetworkLog();
        consoleLog.add("error", "boom happened", Date.UTC(2026, 0, 1, 12, 30, 5));
        net.start("1", "GET", "http://user:hunter2@x.test/missing.json?key=AIza" + "a".repeat(35), "Fetch");
        net.response("1", 404);
        net.finish("1");
        net.start("2", "POST", "http://127.0.0.1:1/x", "Fetch");
        net.fail("2", "net::ERR_CONNECTION_REFUSED", false);
        net.start("3", "GET", "http://x.test/pending", "Fetch");
        const all = formatLogs("all", consoleLog, net);
        expect(all).toContain("Console (1):");
        expect(all).toContain("[12:30:05] error: boom happened");
        expect(all).toContain("Network (3 requests, 2 failed):");
        expect(all).toContain("GET 404 http://x.test/missing.json");
        expect(all).not.toContain("hunter2");
        expect(all).not.toContain("AIza");
        expect(all).toContain("POST FAILED net::ERR_CONNECTION_REFUSED http://127.0.0.1:1/x (Fetch)");
        expect(all).toContain("GET pending http://x.test/pending");
        expect(formatLogs("console", consoleLog, net)).not.toContain("Network");
        expect(formatLogs("network", consoleLog, net)).not.toContain("Console");
        expect(formatLogs("all", new ConsoleLog(), new NetworkLog())).toBe("Console (0):\n  (nothing)\nNetwork (0 requests, 0 failed):\n  (nothing)");
    });
});

describe("a page report", () => {
    /** A tab and session with only what a report reads of them. */
    function fakes(over: Record<string, unknown> = {}, tabs = 1) {
        const page = {
            url: "http://localhost:3000/shop",
            loading: false,
            crashed: false,
            documentStatus: 200 as number | undefined,
            dialog: undefined as undefined | { type: string; message: string; defaultPrompt?: string },
            control: new TabControl("agent"),
            console: new ConsoleLog(),
            refs: { generation: 0 },
            lastOutline: undefined as undefined | { generation: number; text: string },
            readTitle: async () => "Shop",
            outline: async () => ({ text: '- button "Go" [e1]', lines: 1, shown: 1 }),
            ...over,
        };
        const session = { idOf: () => 3, tabCount: tabs, tabsText: () => "Tabs:\n  [3] current" };
        return { page: page as never, raw: page, session: session as never };
    }

    test("starts with the tab, its address and whether it has loaded, then the outline", async () => {
        const { page, session } = fakes();
        expect(await pageReport(session, page)).toBe('Tab [3] "Shop" http://localhost:3000/shop — loaded\n\n- button "Go" [e1]');
        expect(await pageReport(session, fakes({ loading: true, url: "" }).page)).toContain("about:blank — still loading");
    });

    test("tells what is wrong with the page and what waits for the agent", async () => {
        const status = await pageHeader(fakes({ documentStatus: 404 }).session, fakes({ documentStatus: 404 }).page);
        expect(status).toContain("The page answered HTTP 404.");
        const used = new TabControl("agent");
        used.humanInput();
        const user = fakes({ control: used });
        expect(await pageReport(user.session, user.page)).toContain("The user has used this tab since you last read it");
        // told once
        expect(await pageReport(user.session, user.page)).not.toContain("The user has used this tab");
        const crashed = await pageReport(fakes().session, fakes({ crashed: true }).page);
        expect(crashed).toContain("crashed: reload it");
        expect(crashed).not.toContain("button");
    });

    test("a dialog is named with how to answer it, and the page behind it is not read", async () => {
        const f = fakes({ dialog: { type: "prompt", message: "Your name?", defaultPrompt: "Ada" }, outline: async () => { throw new Error("must not read a page held by a dialog"); } });
        const r = await pageReport(f.session, f.page);
        expect(r).toContain('A JavaScript prompt dialog is waiting: "Your name?" (default "Ada")');
        expect(r).toContain("accept=true or false (text= is the answer)");
        expect(r).toContain("blocked by the dialog");
        const confirm = fakes({ dialog: { type: "confirm", message: "Really?" } });
        expect(await pageReport(confirm.session, confirm.page)).not.toContain("text= is the answer");
    });

    test("counts the console errors since the last report, once", async () => {
        const f = fakes();
        f.raw.console.add("error", "one");
        f.raw.console.add("exception", "two");
        f.raw.console.add("log", "fine");
        expect(await pageReport(f.session, f.page)).toContain("2 new console errors (BrowserLogs shows them).");
        expect(await pageReport(f.session, f.page)).not.toContain("console error");
        f.raw.console.add("error", "again");
        expect(await pageReport(f.session, f.page)).toContain("1 new console error (BrowserLogs");
    });

    test("lists the tabs when there are several", async () => {
        expect(await pageReport(fakes({}, 2).session, fakes().page)).toContain("Tabs:\n  [3] current");
        expect(await pageReport(fakes({}, 1).session, fakes().page)).not.toContain("Tabs:");
    });

    test("says what a cut outline left out", async () => {
        const f = fakes({ outline: async () => ({ text: '- text "a"', lines: 120, shown: 80 }) });
        expect(await pageReport(f.session, f.page)).toContain("40 more lines (of 120) didn't fit");
        const empty = fakes({ outline: async () => ({ text: "", lines: 0, shown: 0 }) });
        expect(await pageReport(empty.session, empty.page)).toContain("(The page shows nothing.)");
    });

    test("tells only what changed when asked to and the page is the same one, remembering the outline either way", async () => {
        let current = ["- main", '  - button "Go" [e1]', '  - text "A"', ...Array.from({ length: 30 }, (_, i) => `  - listitem "Item ${i}"`), '  - text "C"'].join("\n");
        const f = fakes({ outline: async () => ({ text: current, lines: 34, shown: 34 }) });
        expect(await pageReport(f.session, f.page, { diff: true })).toContain('- text "C"');
        expect(f.raw.lastOutline).toEqual({ generation: 0, text: current });
        current = current.replace('"C"', '"D"');
        const changed = await pageReport(f.session, f.page, { diff: true });
        expect(changed).toContain("Changed since the last snapshot");
        expect(changed).toContain('+   - text "D"');
        expect(changed).not.toContain('- text "A"');
        // after the page changed under the refs, the whole outline again
        f.raw.refs.generation = 1;
        expect(await pageReport(f.session, f.page, { diff: true })).toContain('- text "A"');
        // and without asking for a diff, always the whole outline
        current = current.replace('"D"', '"E"');
        expect(await pageReport(f.session, f.page)).toContain('- text "A"');
    });

    test("redacts a secret the page shows", async () => {
        const key = `sk-ant-api03-${"q9W8e7R6t5".repeat(4)}`;
        const f = fakes({ outline: async () => ({ text: `- text "${key}"`, lines: 1, shown: 1 }) });
        expect(await pageReport(f.session, f.page)).not.toContain(key);
    });
});
