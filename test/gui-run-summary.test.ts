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
    // Cavvy's own asks and server steps by what they are, however they were called; to what is in their rows.
    expect(summarize([tool("ServerKey", { name: "box" }), tool("mcp__cavvy__server_add", { name: "box" }), bash("ls")])).toBe("Ran 1 command, prepared a server and added a server");
    expect(summarize([bash("git push"), tool("mcp__cavvy__request_sign_in", { target: "gh" }), tool("RequestSignIn", { target: "gh" })])).toBe("Ran 1 command and asked to sign in");
    // Any other tool is a count: one a CLI added, another of Cavvy's, an MCP server's.
    expect(summarize([tool("ToolSearch"), tool("mcp__cavvy__browser_eval"), bash("ls")])).toBe("Ran 1 command and used 2 tools");
    expect(summarize([tool("ToolSearch"), tool("mcp__linear__list_issues")])).toBe("Used 2 tools");
    expect(summarize([tool("mcp__linear__list_issues"), tool("mcp__linear__get_issue")])).toBe("Used 2 MCP tools");
    for (const text of [summarize(run), summarize([tool("ServerKey", { name: "box" }), tool("ToolSearch"), tool("ToolSearch")])]) expect(text).not.toMatch(/server-tools|grep|ServerKey|ToolSearch|box/);
});

test("a call that failed isn't said to have done its thing", () => {
    const failed = (t: ToolBlock): ToolBlock => ({ ...t, status: "error" });
    const read = (p: string) => tool("Read", { file_path: p });
    // Both reads failed and the search worked: the line's mark counts the failures.
    expect(summarize([failed(read("/a")), failed(read("/b")), tool("Grep")])).toBe("Searched once");
    expect(summarize([failed(read("/a")), failed(read("/b"))])).toBe("2 calls failed");
    expect(summarize([read("/a"), failed(read("/b")), bash("ls")])).toBe("Read 1 file and ran 1 command");
    // A command that failed still ran.
    expect(summarize([failed(bash("false")), read("/a")])).toBe("Read 1 file and ran 1 command");
    // Declined calls aren't counted in the words either.
    expect(summarize([{ ...read("/a"), status: "denied" }, bash("ls")])).toBe("Ran 1 command");
});

test("one step alone says what it was", () => {
    expect(summarize([edit("/Users/me/app/src/tools/server-tools.ts")])).toBe("Edited …/tools/server-tools.ts");
    expect(summarize([bash("git status")])).toBe("Ran `git status`");
    expect(summarize([tool("Skill", { skill: "/review-change" })])).toBe("Loaded the review-change skill");
    expect(summarize([tool("ServerAdd", { name: "aws-mumbai" }, { status: "error" })])).toBe("Add server aws-mumbai");
    // A sign-in by its name, not the id the agent passes.
    expect(summarize([tool("mcp__cavvy__request_sign_in", { target: "gh" })])).toBe("Ask to sign in to GitHub");
    expect(summarize([tool("RequestSignIn", { target: "fly" })])).toBe("Ask to sign in to fly");
    // A read that failed isn't "Read 1 file".
    expect(summarize([tool("Read", { file_path: "/a.ts" }, { status: "error", title: "Read(/a.ts)" })])).toBe("Read /a.ts");
});

test("more than three kinds of step: the first three and how many more", () => {
    expect(summarize([tool("Read", { file_path: "/a" }), tool("Grep"), edit("/b"), bash("ls"), tool("WebSearch")])).toBe("Read 1 file, searched once, edited 1 file and 2 more");
});
