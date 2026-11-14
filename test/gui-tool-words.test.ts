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

test("another server's tool is said by what it does, under way too; its server where it has nothing else to show, never mcp__…", () => {
    const issue = call({ name: "mcp__github__create_issue", title: "mcp__github__create_issue", status: "running" });
    expect(toolLabel(issue)).toEqual({ verb: "Create issue", arg: "github" });
    expect(runningVerb(issue)).toBe("Create issue");
    expect(runningVerb({ ...issue, status: "streaming" })).toBe("Create issue");
    // With something it's about, that; and once it's done its server isn't said beside it.
    expect(toolLabel(call({ name: "mcp__github__create_issue", title: "Create issue(Fix login)", status: "running" }))).toEqual({ verb: "Create issue", arg: "Fix login" });
    expect(toolLabel(call({ name: "mcp__claude_ai_Gmail__search_threads", title: "mcp__claude_ai_Gmail__search_threads", status: "ok" }))).toEqual({ verb: "Search threads", arg: undefined });
});

test("Cavvy's own tools are said by what they do, however they were called: never \"Using cavvy\"", () => {
    // From an agent CLI, by the name Cavvy's server gives it; from a model Cavvy runs, by its own.
    for (const name of ["mcp__cavvy__server_add", "ServerAdd"]) {
        const add = call({ name, title: "ServerAdd(aws-mumbai)", status: "running", input: { name: "aws-mumbai", address: "ubuntu@203.0.113.7" } });
        expect(runningVerb(add)).toBe("Adding server");
        expect(toolLabel(add)).toEqual({ verb: "Add server", arg: "aws-mumbai" });
    }
    expect(runningVerb(call({ name: "mcp__cavvy__server_key", status: "running", input: { name: "aws-mumbai" } }))).toBe("Preparing server");
    expect(toolLabel(call({ name: "mcp__cavvy__server_remove", input: { name: "aws-mumbai" } }))).toEqual({ verb: "Remove server", arg: "aws-mumbai" });
    expect(toolLabel(call({ name: "mcp__cavvy__request_sign_in", input: { target: "gh" } }))).toEqual({ verb: "Ask to sign in", arg: "gh" });
    expect(runningVerb(call({ name: "mcp__cavvy__request_secret", status: "running", input: { name: "NPM_TOKEN" } }))).toBe("Asking for a secret");
    expect(runningVerb(call({ name: "mcp__cavvy__start_session", status: "running", input: { prompt: "Fix the build\nand push" } }))).toBe("Starting session");
    expect(toolLabel(call({ name: "mcp__cavvy__start_session", input: { prompt: "Fix the build\nand push" } })).arg).toBe("Fix the build");
    // One with words under its own name, called through Cavvy's server.
    expect(runningVerb(call({ name: "mcp__cavvy__watch_pull_request", title: "WatchPullRequest(140)", status: "running" }))).toBe("Reading pull request");
    // One nothing here knows yet: its own name in words, still never the app's.
    const odd = call({ name: "mcp__cavvy__tidy_things", title: "mcp__cavvy__tidy_things", status: "running" });
    expect(runningVerb(odd)).toBe("Tidy things");
    // Simulator and browser words stay their own.
    expect(runningVerb(call({ name: "mcp__cavvy__simulator_act", status: "running", input: {} }))).toBe("Acting on the screen");
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
    // What it looked for, in words: the tools it named, as what they do; a search, as it was typed.
    expect(toolLabel(search)).toEqual({ verb: "Find tools", arg: "Monitor" });
    expect(toolLabel(call({ name: "ToolSearch", title: "ToolSearch", input: { query: "select:mcp__cavvy__server_key,mcp__cavvy__server_add,mcp__cavvy__request_sign_in,mcp__github__create_issue,TaskOutput" } })).arg).toBe("Prepare server, Add server, Ask to sign in, Create issue, Check task");
    expect(toolLabel(call({ name: "ToolSearch", title: "ToolSearch", input: { query: "notebook jupyter" } })).arg).toBe("notebook jupyter");
    expect(runningVerb({ ...search, status: "running" })).toBe("Finding tools");
    expect(runningVerb({ ...search, status: "queued" })).toBe("Then find tools");
    // The agent CLIs' own tools are said as what they do, arriving and under way alike.
    const task = call({ name: "TaskOutput", title: "TaskOutput(b1)" });
    expect(toolLabel(task)).toEqual({ verb: "Check task", arg: "b1" });
    expect(runningVerb({ ...task, status: "running" })).toBe("Checking task");
    expect(runningVerb({ ...task, status: "streaming" })).toBe("Checking task");
    expect(runningVerb({ ...task, status: "queued" })).toBe("Then check task");
    expect(runningVerb(call({ name: "apply_patch", status: "running" }))).toBe("Editing");
    expect(runningVerb(call({ name: "CronCreate", status: "running" }))).toBe("Scheduling");
    expect(runningVerb(call({ name: "Agent", status: "streaming" }))).toBe("Starting agent");
    expect(runningVerb(call({ name: "Agent", status: "running" }))).toBe("Agent working");
    expect(toolLabel(call({ name: "LSP", title: "LSP" })).verb).toBe("Look up code");
    // Arriving, a call is about to be what it does: never "Preparing read", "Preparing open pull request".
    expect(runningVerb(call({ name: "Read", status: "streaming" }))).toBe("Reading");
    expect(runningVerb(call({ name: "CreatePullRequest", status: "streaming" }))).toBe("Opening pull request");
    // A question or a plan isn't waiting on the user until it's written.
    expect(runningVerb(call({ name: "AskUserQuestion", status: "streaming" }))).toBe("Writing a question");
    expect(runningVerb(call({ name: "ExitPlanMode", status: "streaming" }))).toBe("Writing the plan");
    // One nothing here knows: its name, as words, however it's spelled.
    const other = call({ name: "FrobnicateThings", title: "FrobnicateThings(b1)" });
    expect(toolLabel(other)).toEqual({ verb: "Frobnicate things", arg: "b1" });
    expect(runningVerb({ ...other, status: "running" })).toBe("Running frobnicate things");
    expect(runningVerb({ ...other, status: "streaming" })).toBe("Preparing frobnicate things");
    expect(runningVerb({ ...other, status: "queued" })).toBe("Then frobnicate things");
    expect(toolLabel(call({ name: "do_the_thing", title: "do_the_thing" })).verb).toBe("Do the thing");
    // After another word, a name in capitals stays as it is.
    expect(runningVerb(call({ name: "MCPAuth", title: "MCPAuth", status: "running" }))).toBe("Running MCPAuth");
    expect(runningVerb(call({ name: "KillShell", status: "running" }))).toBe("Stopping");
    expect(runningVerb(call({ name: "UnwatchPullRequest", status: "running" }))).toBe("Ending the watch");
    expect(runningVerb({ ...search, status: "streaming" })).toBe("Finding tools");
    // The ones with words keep them.
    expect(toolLabel(call({ name: "Read", title: "Read(a.ts)" }))).toEqual({ verb: "Read", arg: "a.ts" });
    expect(runningVerb(call({ name: "Grep", status: "queued" }))).toBe("Then search");
});
