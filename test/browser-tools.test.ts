// The browser tools as a model and the permission system see them: what is offered, what each tool takes, what asks, what is
// refused (also for a page that goes somewhere by itself, and for files), what is served to Claude Code and Codex, and how a
// screenshot reaches each kind of provider. No browser runs here (test/browser-engine.test.ts runs the tools on one).
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { fakeChromeProgram } from "./helpers/fake-chrome";
import { FAKE, isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const root = tempDir("cavvy-browser-tools-project-");
const { BUILTIN_TOOLS, EXPLORE_TOOLS, offered } = await import("../src/tools/index");
const tools = await import("../src/tools/browser-tools");
const { PermissionChecker } = await import("../src/permissions/checker");
const { forgetChromeLookup } = await import("../src/browser/chrome");
const { isBrowserTool, isReadOnly } = await import("../src/tools/types");
const { paths } = await import("../src/config/paths");
const { toAnthropicMessages } = await import("../src/providers/anthropic");
const { toOpenAIMessages } = await import("../src/providers/openai-compat");
const { toResponsesInput } = await import("../src/providers/openai-responses");
const { BUILTIN_PROVIDERS } = await import("../src/providers/registry");
const { imagesFor } = await import("../src/providers/images");
type Message = import("../src/providers/types").Message;

const { BrowserNavigateTool, BrowserSnapshotTool, BrowserActTool, BrowserScreenshotTool, BrowserEvalTool, BrowserLogsTool, BROWSER_TOOLS } = tools;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

afterAll(iso.cleanup);

const ctx = (state: object = { projectRoot: root, cwd: root }, settings = {}) => ({ state, settings, signal: new AbortController().signal }) as never;
const checker = (settings: object = {}) => new PermissionChecker(() => settings, root);
const decide = (tool: { name: string }, input: Record<string, unknown>, mode = "default", settings: object = {}) => checker(settings).check(tool as never, input, mode as never, root);

describe("the tools", () => {
    test("are six, in the built-in set, and not for read-only explore agents", () => {
        expect(BROWSER_TOOLS.map((t) => t.name)).toEqual(["BrowserNavigate", "BrowserSnapshot", "BrowserAct", "BrowserScreenshot", "BrowserEval", "BrowserLogs"]);
        for (const t of BROWSER_TOOLS) {
            expect(BUILTIN_TOOLS).toContain(t);
            expect(EXPLORE_TOOLS.has(t.name)).toBe(false);
            expect(isBrowserTool(t.name)).toBe(true);
        }
        expect(isBrowserTool("WebFetch")).toBe(false);
        expect(new Set(BUILTIN_TOOLS.map((t) => t.name)).size).toBe(BUILTIN_TOOLS.length);
    });

    test("have schemas every provider takes: flat, with nothing that strict endpoints refuse", () => {
        const refuse = new Set(["oneOf", "anyOf", "allOf", "not", "$ref", "$defs", "definitions", "patternProperties", "if", "then", "else", "const"]);
        const walk = (schema: unknown, at: string) => {
            if (!schema || typeof schema !== "object") return;
            for (const [k, v] of Object.entries(schema)) {
                expect(refuse.has(k), `${at}.${k}`).toBe(false);
                walk(v, `${at}.${k}`);
            }
        };
        for (const t of BROWSER_TOOLS) {
            walk(t.parameters, t.name);
            expect(t.parameters.type).toBe("object");
            for (const p of Object.values(t.parameters.properties as Record<string, any>)) expect(typeof p.type, t.name).toBe("string");
        }
        expect(BrowserActTool.parameters.required).toEqual(["action"]);
        expect(BrowserEvalTool.parameters.required).toEqual(["expression"]);
        expect(BrowserNavigateTool.parameters.required).toBeUndefined();
    });

    test("cost little to define: every request of every API model carries them", () => {
        const size = BROWSER_TOOLS.map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length).reduce((a, b) => a + b, 0);
        // about 2,000 tokens
        expect(size).toBeLessThan(9000);
        for (const t of BROWSER_TOOLS) expect(t.description.length, t.name).toBeLessThan(1700);
    });

    test("are offered only with the setting on and a browser found, and the lookup is remembered", () => {
        const saved = process.env.CAVVY_BROWSER;
        try {
            process.env.CAVVY_BROWSER = fakeChromeProgram();
            forgetChromeLookup();
            for (const t of BROWSER_TOOLS) {
                expect(offered(t, {}), t.name).toBe(true);
                expect(offered(t, { browser: { enabled: false } }), t.name).toBe(false);
            }
            // malformed settings are the defaults
            expect(offered(BrowserNavigateTool, { browser: "off" as never })).toBe(true);
            // a browser found stays found for a moment: removing the setting doesn't show at once, but the key does
            process.env.CAVVY_BROWSER = join(root, "missing");
            expect(offered(BrowserNavigateTool, {})).toBe(false);
            forgetChromeLookup();
            expect(offered(BrowserNavigateTool, {})).toBe(false);
            // other tools are offered regardless
            expect(offered(BUILTIN_TOOLS.find((t) => t.name === "Read")!, {})).toBe(true);
        } finally {
            process.env.CAVVY_BROWSER = saved;
            forgetChromeLookup();
        }
    });

    test("say what is wrong with the input before anyone is asked", () => {
        const check = (tool: { validate?: (i: never, c: never) => unknown }, input: Record<string, unknown>) => tool.validate!(input as never, ctx());
        expect(check(BrowserNavigateTool, {})).toBe("goto needs a url");
        expect(check(BrowserNavigateTool, { url: "  " })).toBe("goto needs a url");
        expect(check(BrowserNavigateTool, { url: "http://localhost:3000/" })).toBeUndefined();
        expect(check(BrowserNavigateTool, { url: "javascript:alert(1)" })).toContain("aren't allowed");
        expect(check(BrowserNavigateTool, { url: "file:///etc/passwd" })).toContain("limited to the project");
        expect(check(BrowserNavigateTool, { url: `file://${join(root, "a.html")}` })).toBeUndefined();
        expect(check(BrowserNavigateTool, { action: "new_tab" })).toBeUndefined();
        expect(check(BrowserNavigateTool, { action: "new_tab", url: "chrome://settings" })).toContain("aren't allowed");
        expect(check(BrowserNavigateTool, { action: "back" })).toBeUndefined();
        expect(check(BrowserNavigateTool, { action: "switch_tab" })).toBe("switch_tab needs a tab number");
        expect(check(BrowserNavigateTool, { action: "close_tab" })).toBe("close_tab needs a tab number");
        expect(check(BrowserNavigateTool, { action: "fly" })).toBe('Unknown action "fly"');
        expect(check(BrowserNavigateTool, { action: "resize", width: 800 })).toContain("resize needs width and height between 200 and 4000");
        expect(check(BrowserNavigateTool, { action: "resize", width: 800, height: 99_999 })).toContain("between 200 and 4000");
        expect(check(BrowserNavigateTool, { action: "resize", width: 800, height: 600 })).toBeUndefined();

        expect(check(BrowserActTool, { action: "dance" })).toBe('Unknown action "dance"');
        for (const action of ["click", "double_click", "hover"]) {
            expect(check(BrowserActTool, { action })).toBe(`${action} needs a ref, or both x and y`);
            expect(check(BrowserActTool, { action, x: 5 })).toBe(`${action} needs a ref, or both x and y`);
            expect(check(BrowserActTool, { action, ref: "e1" })).toBeUndefined();
            expect(check(BrowserActTool, { action, x: 5, y: 6 })).toBeUndefined();
        }
        expect(check(BrowserActTool, { action: "type" })).toBe("type needs text");
        expect(check(BrowserActTool, { action: "type", text: "" })).toBeUndefined();
        expect(check(BrowserActTool, { action: "press" })).toBe("press needs a key");
        expect(check(BrowserActTool, { action: "press", key: "Enter" })).toBeUndefined();
        expect(check(BrowserActTool, { action: "select", ref: "e1" })).toBe("select needs a ref and a value");
        expect(check(BrowserActTool, { action: "select", ref: "e1", value: "m" })).toBeUndefined();
        expect(check(BrowserActTool, { action: "dialog" })).toBe("dialog needs accept (true or false)");
        expect(check(BrowserActTool, { action: "dialog", accept: false })).toBeUndefined();
        expect(check(BrowserActTool, { action: "wait" })).toBeUndefined();
        expect(check(BrowserActTool, { action: "scroll" })).toBeUndefined();

        expect(check(BrowserScreenshotTool, { fullPage: true, ref: "e1" })).toBe("Pass fullPage or ref, not both");
        expect(check(BrowserScreenshotTool, { fullPage: true })).toBeUndefined();
        expect(check(BrowserEvalTool, { expression: " " })).toBe("expression is empty");
        expect(check(BrowserEvalTool, { expression: "1" })).toBeUndefined();
    });

    test("are headed in the transcript by what they do, with nothing secret or endless", () => {
        expect(BrowserNavigateTool.title({ url: "http://user:pw@localhost:3000/x" })).toBe("BrowserNavigate(http://localhost:3000/x)");
        expect(BrowserNavigateTool.title({ action: "switch_tab", tab: 2 })).toBe("BrowserNavigate(switch_tab 2)");
        expect(BrowserNavigateTool.title({ action: "new_tab", url: "http://localhost/" })).toBe("BrowserNavigate(new_tab http://localhost/)");
        expect(BrowserActTool.title({ action: "click", ref: "e12" })).toBe("BrowserAct(click e12)");
        expect(BrowserActTool.title({ action: "click", x: 10.4, y: 20.6 })).toBe("BrowserAct(click 10,21)");
        expect(BrowserActTool.title({ action: "press", key: "Enter" })).toBe("BrowserAct(press Enter)");
        expect(BrowserActTool.title({ action: "wait", text: "Saved" })).toBe("BrowserAct(wait Saved)");
        expect(BrowserEvalTool.title({ expression: `document.querySelectorAll("li")\n.length ${"+ 1".repeat(60)}` }).length).toBeLessThan(90);
        expect(BrowserScreenshotTool.title({ fullPage: true })).toBe("BrowserScreenshot(full page)");
        expect(BrowserLogsTool.title({})).toBe("BrowserLogs(all)");
        expect(BrowserSnapshotTool.title({ screenshot: true })).toBe("BrowserSnapshot(current tab, screenshot)");
    });

    test("show what will be done in the prompt, with a typed secret redacted", async () => {
        const typed = await BrowserActTool.preview!({ action: "type", ref: "e3", text: `token ${FAKE.anthropic}` }, ctx());
        expect(typed!.summary).toContain("Browser: type e3");
        expect(typed!.summary).not.toContain("sk-ant");
        expect((await BrowserEvalTool.preview!({ expression: `fetch("/x?k=${FAKE.openai}")` }, ctx()))!.body).not.toContain("sk-proj");
        expect((await BrowserNavigateTool.preview!({ url: "http://user:pw@localhost:3000/" }, ctx()))!.summary).toBe("Open http://localhost:3000/ in the browser");
    });

    test("only waiting and scrolling count as reading", () => {
        const read = (action: string) => isReadOnly(BrowserActTool, { action });
        expect([read("wait"), read("scroll")]).toEqual([true, true]);
        for (const action of ["click", "double_click", "hover", "type", "press", "select", "dialog"]) expect(read(action), action).toBe(false);
        for (const t of [BrowserSnapshotTool, BrowserScreenshotTool, BrowserLogsTool]) expect(isReadOnly(t, {}), t.name).toBe(true);
        for (const t of [BrowserNavigateTool, BrowserEvalTool]) expect(isReadOnly(t, {}), t.name).toBe(false);
    });
});

describe("what asks", () => {
    test("reading the page never asks, in any mode", () => {
        for (const mode of ["default", "acceptEdits", "plan", "auto"]) for (const t of [BrowserSnapshotTool, BrowserScreenshotTool, BrowserLogsTool]) expect(decide(t, {}, mode).behavior, `${t.name} in ${mode}`).toBe("allow");
    });

    test("opening a dev server, a file in the project or a blank page is allowed; any other host asks like WebFetch", () => {
        for (const url of ["http://localhost:3000/", "http://127.0.0.1:5173/x", "http://[::1]:80/", "http://app.localhost/", `file://${join(root, "index.html")}`, "about:blank"]) expect(decide(BrowserNavigateTool, { url }).behavior, url).toBe("allow");
        const remote = decide(BrowserNavigateTool, { url: "https://Docs.Example.com/a" });
        expect(remote).toMatchObject({ behavior: "ask", suggestions: ["WebFetch(domain:docs.example.com)"] });
        expect(decide(BrowserNavigateTool, { url: "https://example.com/" }, "auto")).toMatchObject({ behavior: "ask", needsClassifier: true });
        // what the browser would refuse always asks, with nothing to remember
        expect(decide(BrowserNavigateTool, { url: "javascript:alert(1)" })).toMatchObject({ behavior: "ask", suggestions: [] });
        // going back or switching tabs opens nothing
        for (const input of [{ action: "back" }, { action: "reload" }, { action: "list_tabs" }, { action: "switch_tab", tab: 1 }, { action: "close_tab", tab: 1 }, { action: "resize", width: 800, height: 600 }, { action: "back", url: "https://example.com" }]) expect(decide(BrowserNavigateTool, input).behavior, JSON.stringify(input)).toBe("allow");
        expect(decide(BrowserNavigateTool, { action: "new_tab", url: "https://example.com" }).behavior).toBe("ask");
    });

    test("WebFetch rules for a domain cover visiting it, subdomains too, and nothing else", () => {
        const allow = { permissions: { allow: ["WebFetch(domain:example.com)"] } };
        expect(decide(BrowserNavigateTool, { url: "https://example.com/x" }, "default", allow).behavior).toBe("allow");
        expect(decide(BrowserNavigateTool, { url: "https://docs.example.com/x" }, "default", allow).behavior).toBe("allow");
        expect(decide(BrowserNavigateTool, { url: "https://notexample.com/x" }, "default", allow).behavior).toBe("ask");
        expect(decide(BrowserNavigateTool, { url: "https://example.com.evil.test/x" }, "default", allow).behavior).toBe("ask");
        // a rule with no domain says nothing about a visit
        expect(decide(BrowserNavigateTool, { url: "https://example.com/x" }, "default", { permissions: { allow: ["WebFetch"] } }).behavior).toBe("ask");
        const deny = { permissions: { deny: ["WebFetch(domain:evil.example)"] } };
        for (const mode of ["default", "acceptEdits", "plan", "auto", "bypassPermissions"]) {
            expect(decide(BrowserNavigateTool, { url: "https://evil.example/x" }, mode, deny), mode).toMatchObject({ behavior: "deny", rule: "WebFetch(domain:evil.example)" });
        }
        expect(decide(BrowserNavigateTool, { url: "https://www.evil.example/x" }, "default", deny).behavior).toBe("deny");
        expect(decide(BrowserNavigateTool, { action: "new_tab", url: "https://evil.example/x" }, "default", deny).behavior).toBe("deny");
        // tab rules for the tool itself
        expect(decide(BrowserNavigateTool, { url: "http://localhost:3000/" }, "default", { permissions: { deny: ["BrowserNavigate"] } }).behavior).toBe("deny");
        expect(decide(BrowserNavigateTool, { url: "https://example.com/" }, "default", { permissions: { allow: ["BrowserNavigate(domain:example.com)"] } }).behavior).toBe("allow");
    });

    test("clicking, typing, pressing, selecting and answering dialogs ask, once for the tool when told not to ask again", () => {
        for (const action of ["click", "double_click", "type", "press", "select", "dialog"]) {
            const input = { action, ref: "e1", text: "x", key: "a", value: "v", accept: true };
            expect(decide(BrowserActTool, input), action).toMatchObject({ behavior: "ask", suggestions: ["BrowserAct"] });
            expect(decide(BrowserActTool, input, "auto"), action).toMatchObject({ behavior: "ask", needsClassifier: true });
            expect(decide(BrowserActTool, input, "default", { permissions: { allow: ["BrowserAct"] } }).behavior, action).toBe("allow");
            expect(decide(BrowserActTool, input, "default", { permissions: { deny: ["BrowserAct"] } }).behavior, action).toBe("deny");
        }
        expect(decide(BrowserEvalTool, { expression: "1" })).toMatchObject({ behavior: "ask", suggestions: ["BrowserEval"] });
    });

    test("a yes to a click or a script covers that call: the same input on the next page asks again", () => {
        const c = checker();
        for (const [tool, input] of [[BrowserActTool, { action: "click", x: 100, y: 100 }], [BrowserActTool, { action: "type", ref: "e7", text: "x", submit: true }], [BrowserEvalTool, { expression: "document.forms[0].submit()" }]] as const) {
            c.approve(tool as never, input, root);
            expect(c.check(tool as never, input, "default", root), tool.name).toMatchObject({ behavior: "ask" });
            expect(c.recentApprovals(), tool.name).toEqual([]);
        }
        // Opening the same address is the same thing every time: a yes to it is remembered.
        c.approve(BrowserNavigateTool as never, { url: "https://example.com/" }, root);
        expect(c.check(BrowserNavigateTool as never, { url: "https://example.com/" }, "default", root)).toMatchObject({ behavior: "allow", remembered: true });
    });

    test("hovering, scrolling and waiting go unasked", () => {
        for (const input of [{ action: "hover", ref: "e1" }, { action: "scroll", deltaY: 300 }, { action: "wait", text: "Saved" }]) expect(decide(BrowserActTool, input).behavior, input.action).toBe("allow");
    });

    test("plan mode lets the browser open pages and read them, and refuses hovering, clicking, typing and scripts", () => {
        expect(decide(BrowserNavigateTool, { url: "http://localhost:3000/" }, "plan").behavior).toBe("allow");
        for (const input of [{ action: "scroll" }, { action: "wait" }]) expect(decide(BrowserActTool, input, "plan").behavior).toBe("allow");
        for (const input of [{ action: "click", ref: "e1" }, { action: "hover", ref: "e1" }, { action: "type", text: "x" }, { action: "press", key: "a" }, { action: "select", ref: "e1", value: "a" }, { action: "dialog", accept: true }]) {
            const d = decide(BrowserActTool, input, "plan");
            expect(d.behavior, input.action).toBe("deny");
            expect(d.reason).toContain("Plan mode is active");
        }
        expect(decide(BrowserEvalTool, { expression: "1" }, "plan").behavior).toBe("deny");
    });

    test("bypass mode allows acting, though deny rules still hold", () => {
        expect(decide(BrowserActTool, { action: "click", ref: "e1" }, "bypassPermissions").behavior).toBe("allow");
        expect(decide(BrowserActTool, { action: "click", ref: "e1" }, "bypassPermissions", { permissions: { deny: ["BrowserAct"] } }).behavior).toBe("deny");
    });

    test("rules by the name a tool has when served to Claude Code or Codex match the served names, nothing else", async () => {
        const { servedBrowserName } = tools;
        expect(BROWSER_TOOLS.map((t) => servedBrowserName(t.name))).toEqual(tools.BROWSER_SERVER_TOOLS);
        expect(servedBrowserName("Read")).toBeUndefined();
        const rules = await import("../src/permissions/rules");
        for (const pattern of ["mcp__cavvy", "mcp__cavvy__*", "mcp__cavvy__browser_act"]) expect(rules.mcpToolMatches(pattern, "mcp__cavvy__browser_act"), pattern).toBe(true);
        expect(rules.mcpToolMatches("mcp__cavvy__browser_act", "mcp__cavvy__browser_eval")).toBe(false);
        expect(rules.mcpToolMatches("mcp__cavvy__browser_act", "BrowserAct")).toBe(false);
    });
});

describe("files a page is opened from", () => {
    mkdirSync(join(root, "private"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "private", "x.html"), "<p>secret</p>");
    writeFileSync(join(root, "docs", "a.html"), "<p>docs</p>");
    writeFileSync(join(root, "public.html"), "<p>fine</p>");
    writeFileSync(join(root, ".env"), "KEY=1");
    writeFileSync(join(root, ".env.example"), "KEY=");
    symlinkSync(join(root, "private"), join(root, "docs", "shortcut"));
    const url = (...p: string[]) => `file://${join(root, ...p)}`;
    const denyPrivate = { permissions: { deny: ["Read(private/**)"] } };

    test("are read under the rules for reading them: a file Read is denied can't be shown by opening it", () => {
        expect(decide(BrowserNavigateTool, { url: url("private", "x.html") }, "default", denyPrivate)).toMatchObject({ behavior: "deny", rule: "Read(private/**)" });
        expect(decide(BrowserNavigateTool, { action: "new_tab", url: url("private", "x.html") }, "default", denyPrivate).behavior).toBe("deny");
        for (const mode of ["plan", "auto", "acceptEdits", "bypassPermissions"]) expect(decide(BrowserNavigateTool, { url: url("private", "x.html") }, mode, denyPrivate).behavior, mode).toBe("deny");
        // where a link leads is what counts
        expect(decide(BrowserNavigateTool, { url: url("docs", "shortcut", "x.html") }, "default", denyPrivate).behavior).toBe("deny");
        // others are fine
        expect(decide(BrowserNavigateTool, { url: url("public.html") }, "default", denyPrivate).behavior).toBe("allow");
        expect(decide(BrowserNavigateTool, { url: url("docs", "a.html") }, "default", denyPrivate).behavior).toBe("allow");
    });

    test("ask rules for reading ask, and so do files that may hold credentials", () => {
        expect(decide(BrowserNavigateTool, { url: url("docs", "a.html") }, "default", { permissions: { ask: ["Read(docs/**)"] } })).toMatchObject({ behavior: "ask", rule: "Read(docs/**)" });
        expect(decide(BrowserNavigateTool, { url: url(".env") })).toMatchObject({ behavior: "ask", reason: "This file may contain credentials." });
        expect(decide(BrowserNavigateTool, { url: url(".env.example") }).behavior).toBe("allow");
    });

    test("never show Cavvy's own credential files", () => {
        const d = decide(BrowserNavigateTool, { url: `file://${paths.credentialsFile()}` });
        expect(d).toMatchObject({ behavior: "deny", reason: "Access to Cavvy credential store is blocked." });
        expect(decide(BrowserNavigateTool, { url: `file://${paths.providers()}` }).behavior).toBe("deny");
    });

    test("are judged the same when a page asks to go there itself, and nothing else of the rules comes into it", () => {
        const c = checker(denyPrivate);
        expect(c.urlRefusal(url("private", "x.html"))).toBe("Denied by permission rule Read(private/**)");
        expect(c.urlRefusal(url("private", "nothere.png"))).toBe("Denied by permission rule Read(private/**)");
        expect(c.urlRefusal(url("docs", "shortcut", "x.html"))).toContain("Read(private/**)");
        expect(c.urlRefusal(url("public.html"))).toBeUndefined();
        expect(c.urlRefusal(url(".env"))).toBe("It may contain credentials");
        expect(c.urlRefusal(`file://${paths.credentialsFile()}`)).toBe("Access to Cavvy credential store is blocked");
        // a folder's listing is a read of the folder
        expect(checker({ permissions: { deny: ["Read(private)"] } }).urlRefusal(url("private"))).toContain("Denied by permission rule");
        // a page cannot answer an ask: the file must be requested explicitly
        expect(checker({ permissions: { ask: ["Read(docs/**)"], allow: [] } }).urlRefusal(url("docs", "a.html"))).toContain("Requires approval");
    });

    test("and the hosts a page goes to by itself are refused by deny rules for them", () => {
        const c = checker({ permissions: { deny: ["WebFetch(domain:evil.example)"], allow: ["WebFetch(domain:fine.example)"] } });
        expect(c.urlRefusal("https://evil.example/landing")).toBe("Denied by permission rule WebFetch(domain:evil.example)");
        expect(c.urlRefusal("http://sub.evil.example:8080/x?y=1")).toContain("evil.example");
        expect(c.urlRefusal("https://fine.example/")).toBeUndefined();
        expect(c.urlRefusal("https://unlisted.example/")).toBeUndefined();
        expect(c.urlRefusal("about:blank")).toBeUndefined();
        expect(c.urlRefusal("http://localhost:3000/")).toBeUndefined();
        expect(checker({ permissions: { deny: ["WebFetch(domain:localhost)"] } }).urlRefusal("http://localhost:3000/")).toContain("WebFetch(domain:localhost)");
        expect(checker({ permissions: { deny: ["BrowserNavigate"] } }).urlRefusal("https://example.com/")).toBe("Denied by permission rule BrowserNavigate");
        expect(checker().urlRefusal("https://example.com/")).toBeUndefined();
    });

    test("and so are hosts an ask rule names, except the one the tab was let open (or a person went to)", () => {
        const c = checker({ permissions: { ask: ["WebFetch(domain:private.example)"], deny: ["WebFetch(domain:evil.example)"] } });
        const asks = "Requires approval by permission rule WebFetch(domain:private.example). Open it explicitly with BrowserNavigate.";
        // a redirect, a link or a script from anywhere: the user is asked about every visit
        expect(c.urlRefusal("https://private.example/")).toBe(asks);
        expect(c.urlRefusal("https://api.private.example/x")).toBe(asks);
        expect(c.urlRefusal("https://private.example/", { host: "elsewhere.example" })).toBe(asks);
        // within the visit asked for, the page moves about freely; not to another host the rule names
        expect(c.urlRefusal("https://private.example/next?page=2", { host: "private.example" })).toBeUndefined();
        expect(c.urlRefusal("https://api.private.example/x", { host: "private.example" })).toBe(asks);
        // hosts no rule names are a page's to go to; deny rules hold whatever was approved
        expect(c.urlRefusal("https://unlisted.example/")).toBeUndefined();
        expect(c.urlRefusal("https://evil.example/", { host: "evil.example" })).toBe("Denied by permission rule WebFetch(domain:evil.example)");
        expect(checker({ permissions: { ask: ["BrowserNavigate"] } }).urlRefusal("https://example.com/")).toContain("Requires approval by permission rule BrowserNavigate");
    });
});

describe("served to Claude Code and Codex", () => {
    const served = tools.browserServerTools(async () => ({ text: "ok" }));

    test("are the same six, under their served names, with the tool's own description and schema", () => {
        expect(served.map((s) => s.name)).toEqual(tools.BROWSER_SERVER_TOOLS);
        served.forEach((s, i) => {
            expect(s.description).toBe(BROWSER_TOOLS[i]!.description);
            expect(s.inputSchema).toBe(BROWSER_TOOLS[i]!.parameters);
            expect(s.title).toBeTruthy();
        });
    });

    test("say which are read-only, so a CLI can tell", () => {
        const hints = Object.fromEntries(served.map((s) => [s.name, s.annotations]));
        for (const name of ["browser_snapshot", "browser_screenshot", "browser_logs"]) expect(hints[name], name).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
        for (const name of ["browser_navigate", "browser_act", "browser_eval"]) expect(hints[name], name).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    });

    test("pass a call to Cavvy's checks as the tool it is, with Codex's call id", async () => {
        const seen: [string, unknown, string | undefined][] = [];
        const wired = tools.browserServerTools(async (tool, input, _signal, callId) => (seen.push([tool.name, input, callId]), { text: "ran" }));
        const signal = new AbortController().signal;
        expect(await wired[2]!.call({ action: "click", ref: "e1" }, { signal, meta: { callId: "mcp-1" } })).toEqual({ text: "ran" });
        await wired[1]!.call({}, { signal, meta: {} });
        await wired[0]!.call({ url: "http://localhost/" }, { signal, meta: { callId: 7 } });
        expect(seen).toEqual([["BrowserAct", { action: "click", ref: "e1" }, "mcp-1"], ["BrowserSnapshot", {}, undefined], ["BrowserNavigate", { url: "http://localhost/" }, undefined]]);
    });

    test("show in the transcript as the Cavvy tools, and run their hooks once", () => {
        expect(tools.nativeBrowserCall("browser_act", { action: "wait" })).toEqual({ name: "BrowserAct", input: { action: "wait" } });
        expect(tools.nativeBrowserCall("browser_navigate", {})?.name).toBe("BrowserNavigate");
        expect(tools.nativeBrowserCall("monitor", {})).toBeUndefined();
        expect(tools.servedBrowserTool("cavvy", "mcp__cavvy__browser_eval")).toBe(true);
        expect(tools.servedBrowserTool("cavvy", "mcp__cavvy__monitor")).toBe(false);
        expect(tools.servedBrowserTool("cavvy", "mcp__other__browser_eval")).toBe(false);
        expect(tools.servedBrowserTool(undefined, "mcp__cavvy__browser_eval")).toBe(false);
        expect(tools.servedBrowserTool("cavvy", 5)).toBe(false);
    });
});

describe("a screenshot as providers are sent it", () => {
    /** The tool's own result for a screenshot, from a tab that returns one. */
    async function screenshotResult() {
        const page = { url: "http://localhost:3000/", exclusive: <T,>(fn: () => Promise<T>) => fn(), screenshot: async () => ({ type: "image" as const, mediaType: "image/png", data: PNG, width: 1280, height: 800 }) };
        const browser = { run: <T,>(fn: () => Promise<T>) => fn(), page: async () => page, idOf: () => 2 };
        return BrowserScreenshotTool.run({}, ctx({ projectRoot: root, cwd: root, browser }));
    }
    async function history(): Promise<Message[]> {
        const result = await screenshotResult();
        expect(result.isError).toBeFalsy();
        // Saved in Cavvy's home, with how to show it in the reply (the transcript draws a local image a reply links to).
        const saved = /^Screenshot of the viewport of tab \[2\] \(1280×800 CSS pixels\) at http:\/\/localhost:3000\/\. Saved as (\S+\.png): to show it to the user, put !\[what it shows\]\(\1\) in your last message\.$/.exec(result.content);
        expect(saved?.[1]).toStartWith(join(iso.home, "screenshots") + "/");
        expect(readFileSync(saved![1]!).toString("base64")).toBe(PNG);
        expect(result.images).toEqual([{ type: "image", mediaType: "image/png", data: PNG }]);
        return [
            { role: "user", content: [{ type: "text", text: "check the page" }] },
            { role: "assistant", provider: "anthropic", model: "m", content: [{ type: "tool_call", id: "call_1", name: "BrowserScreenshot", input: {} }] },
            { role: "user", content: [{ type: "tool_result", toolCallId: "call_1", toolName: "BrowserScreenshot", content: result.content, images: result.images }], meta: { kind: "tool_results" } },
        ];
    }

    test("Anthropic gets it inside the tool result", async () => {
        const out = toAnthropicMessages(await history());
        expect(out.at(-1)).toEqual({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: expect.stringContaining("Screenshot of the viewport") }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }],
        });
    });

    test("the Responses API gets it as input_image in the output of the call", async () => {
        const def = BUILTIN_PROVIDERS.find((p) => p.id === "openai")!;
        const items = toResponsesInput(await history(), def, "gpt-6-sol");
        expect(items.at(-1)).toEqual({
            type: "function_call_output",
            call_id: "call_1",
            output: [{ type: "input_text", text: expect.stringContaining("Screenshot of the viewport") }, { type: "input_image", image_url: `data:image/png;base64,${PNG}`, detail: "auto" }],
        });
    });

    test("Chat Completions can't carry it in a tool message, so it follows as a user message that says whose it is", async () => {
        const def = BUILTIN_PROVIDERS.find((p) => p.id === "groq")!;
        const out = toOpenAIMessages("SYS", await history(), def);
        const tool = out.find((m: any) => m.role === "tool");
        expect(tool.content).toContain("[1 image(s) attached in the next message]");
        expect(out.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "Images returned by the tool calls above:" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }] });
    });

    test("a model that can't read images is told so instead, and the text stays", async () => {
        const messages = await history();
        const blind = await imagesFor(messages, { readsImages: false });
        const result = blind.at(-1)!.content[0] as { content: string; images?: unknown[] };
        expect(result.images).toBeUndefined();
        expect(result.content).toContain("Screenshot of the viewport of tab [2]");
        expect(result.content).toContain("this model can't read images");
        // one that can gets it as it was
        const seeing = await imagesFor(messages, { readsImages: true });
        expect((seeing.at(-1)!.content[0] as { images?: unknown[] }).images).toHaveLength(1);
        // and for the one that can't, every adapter has the text only
        expect(JSON.stringify(toAnthropicMessages(blind))).not.toContain(PNG);
        expect(JSON.stringify(toOpenAIMessages("", blind, BUILTIN_PROVIDERS.find((p) => p.id === "groq")!))).not.toContain(PNG);
        expect(JSON.stringify(toResponsesInput(blind, BUILTIN_PROVIDERS.find((p) => p.id === "openai")!, "gpt-6-sol"))).not.toContain(PNG);
    });
});
