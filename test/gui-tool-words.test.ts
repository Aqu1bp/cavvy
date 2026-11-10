import { expect, test } from "bun:test";
import { resultEchoes, runningVerb, sameInARow, toolKind, toolLabel } from "../gui/src/lib/tool-words";

// How a call is worded in the work log and on the live line (gui/src/lib/tool-words.ts): in words, never by a
// tool's internal name, an element ref or the code it ran.

const call = (o: Record<string, unknown>) => ({ t: "tool", id: "c", status: "ok", input: {}, ...o }) as any;

test("Cavvy's browser tools, however they're called, are one kind", () => {
    expect(toolKind("mcp__cavvy__browser_eval")).toBe("BrowserEval");
    expect(toolKind("BrowserEval")).toBe("BrowserEval");
    expect(toolKind("mcp__github__create_issue")).toBe("mcp__github__create_issue");
});

test("a script run in the page doesn't show its code; a page opened shows where", () => {
    const evalCall = call({ name: "mcp__cavvy__browser_eval", title: "BrowserEval((async () => { const csrf = document.querySelector('meta[nam…)", input: { expression: "(async () => { const csrf = 1 })()" } });
    expect(toolLabel(evalCall)).toEqual({ verb: "Run a script in the page", arg: undefined });
    expect(runningVerb({ ...evalCall, status: "running" })).toBe("Running a script in the page");
    const nav = call({ name: "mcp__cavvy__browser_navigate", title: "BrowserNavigate(https://quaternius.itch.io/x/purchase)", input: { url: "https://quaternius.itch.io/x/purchase" } });
    expect(toolLabel(nav)).toEqual({ verb: "Open", arg: "quaternius.itch.io/x/purchase" });
    expect(toolLabel({ ...nav, input: { action: "reload" } })).toEqual({ verb: "Reload the page", arg: undefined });
});

test("an action names what it acted on, from what the browser said, never by its ref", () => {
    const click = call({ name: "mcp__cavvy__browser_act", title: "BrowserAct(click e128)", input: { action: "click", ref: "e128" }, output: 'Clicked button "Download" [e128]\n\nTab [1] …' });
    expect(toolLabel(click)).toEqual({ verb: "Click", arg: 'button "Download"' });
    // Under way, it hasn't said yet.
    expect(toolLabel({ ...click, status: "running", output: undefined })).toEqual({ verb: "Click", arg: undefined });
    expect(runningVerb({ ...click, status: "running" })).toBe("Clicking");
    expect(toolLabel(call({ name: "BrowserAct", title: "BrowserAct(press Enter)", input: { action: "press", key: "Enter" } }))).toEqual({ verb: "Press", arg: "Enter" });
});

test("another server's tool is said by its own name in words, and under way by its server, never mcp__…", () => {
    const issue = call({ name: "mcp__github__create_issue", title: "mcp__github__create_issue", status: "running" });
    expect(toolLabel(issue).verb).toBe("Create issue");
    expect(runningVerb(issue)).toBe("Using github");
    expect(runningVerb({ ...issue, status: "streaming" })).toBe("Using github");
});

test("a result that only repeats the row isn't shown; a failure's always is", () => {
    const click = call({ name: "mcp__cavvy__browser_act", input: { action: "click" }, summary: 'Clicked button "Save" [e12]' });
    expect(resultEchoes(click)).toBe(true);
    expect(resultEchoes({ ...click, status: "error" })).toBe(false);
    expect(resultEchoes(call({ name: "mcp__cavvy__browser_screenshot", summary: "1280×800" }))).toBe(false);
});

test("the same call made again right after is counted in one row; a failure, or anything between, starts a new one", () => {
    const evalCall = (id: string, status = "ok") => call({ id, name: "BrowserEval", title: "BrowserEval(document.title)", status });
    const thought = { t: "thinking", id: "th", text: "hm" } as any;
    const { more, joined } = sameInARow([evalCall("a"), evalCall("b"), evalCall("c"), thought, evalCall("d"), evalCall("e", "error"), evalCall("f")]);
    expect(more.get("a")?.map((t) => t.id)).toEqual(["b", "c"]);
    expect([...joined]).toEqual(["b", "c"]);
    expect(more.has("d")).toBe(false);
});

test("a tool with no words of its own is said by its name in words, never as the tool spells it", () => {
    // Claude Code's ToolSearch showed as a row labelled "ToolSearch".
    const search = call({ name: "ToolSearch", title: "ToolSearch(select:Monitor)", input: { query: "select:Monitor" } });
    expect(toolLabel(search)).toEqual({ verb: "Find tools", arg: "select:Monitor" });
    expect(runningVerb({ ...search, status: "running" })).toBe("Finding tools");
    expect(runningVerb({ ...search, status: "queued" })).toBe("Then find tools");
    // One nothing here knows: its name, as words.
    const other = call({ name: "TaskOutput", title: "TaskOutput(b1)" });
    expect(toolLabel(other)).toEqual({ verb: "Task output", arg: "b1" });
    expect(runningVerb({ ...other, status: "running" })).toBe("Running task output");
    expect(runningVerb({ ...other, status: "streaming" })).toBe("Preparing task output");
    expect(runningVerb({ ...other, status: "queued" })).toBe("Then task output");
    expect(toolLabel(call({ name: "LSP", title: "LSP" })).verb).toBe("LSP");
    // The ones with words keep them.
    expect(toolLabel(call({ name: "Read", title: "Read(a.ts)" }))).toEqual({ verb: "Read", arg: "a.ts" });
    expect(runningVerb(call({ name: "Grep", status: "queued" }))).toBe("Then search");
});
