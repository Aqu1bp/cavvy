import { expect, test } from "bun:test";
import { summarize } from "../gui/src/lib/run-summary";
import type { ToolBlock } from "../src/server/protocol";

let n = 0;
const tool = (name: string, input: Record<string, unknown> = {}, o: Partial<ToolBlock> = {}): ToolBlock => ({ t: "tool", id: `c${n++}`, name, title: name, status: "ok", input, ...o });
const bash = (command: string) => tool("Bash", { command });
const edit = (file_path: string) => tool("Edit", { file_path });

test("a run of several steps is counted, never named: no path, command, skill or tool name", () => {
    const run = [bash("grep -rn foo src"), edit("/Users/me/app/src/tools/server-tools.ts"), bash("bun run typecheck")];
    expect(summarize(run)).toBe("Edited 1 file and ran 2 commands");
    expect(summarize([edit("/Users/me/app/a.ts"), bash("git status")])).toBe("Edited 1 file and ran 1 command");
    expect(summarize([tool("Read", { file_path: "/a.ts" }), tool("Skill", { skill: "review-change" })])).toBe("Read 1 file and loaded 1 skill");
    expect(summarize([bash("ls"), tool("Monitor", { description: "the build" })])).toBe("Ran 1 command and started 1 monitor");
    expect(summarize([bash("ls"), edit("/Users/me/app/a.ts")].map((t, i) => (i ? { ...t, status: "error" as const } : t)))).toBe("Ran 1 command and couldn't change 1 file");
    // A Cavvy tool, or one a CLI added, is a count too, with MCP tools.
    expect(summarize([tool("ServerKey"), tool("ServerAdd"), bash("ls")])).toBe("Ran 1 command and used 2 tools");
    expect(summarize([tool("ServerAdd"), tool("mcp__linear__list_issues")])).toBe("Used 2 tools");
    expect(summarize([tool("mcp__linear__list_issues"), tool("mcp__linear__get_issue")])).toBe("Used 2 MCP tools");
    for (const text of [summarize(run), summarize([tool("ServerKey"), tool("ToolSearch"), tool("ToolSearch")])]) expect(text).not.toMatch(/server-tools|grep|ServerKey|ToolSearch/);
});

test("one step alone says what it was", () => {
    expect(summarize([edit("/Users/me/app/src/tools/server-tools.ts")])).toBe("Edited …/tools/server-tools.ts");
    expect(summarize([bash("git status")])).toBe("Ran `git status`");
    expect(summarize([tool("Skill", { skill: "/review-change" })])).toBe("Loaded the review-change skill");
    expect(summarize([tool("ServerAdd", { name: "aws-mumbai" }, { status: "error" })])).toBe("Add server");
});

test("more than three kinds of step: the first three and how many more", () => {
    expect(summarize([tool("Read", { file_path: "/a" }), tool("Grep"), edit("/b"), bash("ls"), tool("WebSearch")])).toBe("Read 1 file, searched once, edited 1 file and 2 more");
});
