// The harness's agent definitions as Claude Code's --agents flag takes them
// (src/backends/claude-agents.ts): each field's mapping, which agents are
// left out, and the rules carried over (trust, MCP approval, the session's
// mode winning).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { cleanup } = isolate();
const { parseAgentFile, BUILTIN_AGENTS } = await import("../src/agent/agents");
const { claudeAgents, claudeModel, writeAgentsFile } = await import("../src/backends/claude-agents");
const { harnessHome } = await import("../src/config/paths");
const { MCP_SERVER_NAME } = await import("../src/agent/delegation");

afterAll(cleanup);

const file = (front: string, body = "Do the thing.") => `---\n${front}\n---\n${body}\n`;
const user = (front: string, body?: string) => parseAgentFile(file(front, body), "x", "user");
const project = (front: string, body?: string) => parseAgentFile(file(front, body), "x", "project");
const root = tempDir("claude-agents-");
const opts = { mode: "default" as const, trusted: true, cwd: root, projectRoot: root, settings: {} };

describe("claudeAgents", () => {
    test("every field maps to Claude Code's", () => {
        const def = user(`name: reviewer
description: Reviews diffs
tools: [Read, Grep, Bash]
disallowedTools: Write
model: anthropic:claude-sonnet-5-5
permissionMode: plan
effort: high
maxTurns: 7
isolation: worktree
background: true
memory: project`);
        expect(def.warnings).toBeUndefined();
        expect(claudeAgents([def], opts)).toEqual({
            reviewer: {
                description: "Reviews diffs",
                prompt: "Do the thing.",
                tools: ["Read", "Grep", "Bash"],
                // A plan agent in a default session: the harness's tools (delegate) would run in default.
                disallowedTools: ["Write", `mcp__${MCP_SERVER_NAME}`],
                model: "claude-sonnet-5-5",
                permissionMode: "plan",
                effort: "high",
                maxTurns: 7,
                isolation: "worktree",
                background: true,
                memory: "project",
            },
        });
    });

    test("models: none or inherit is the session's, Claude ones by id, another provider's stays with delegate", () => {
        expect(claudeModel(undefined)).toBe("inherit");
        expect(claudeModel("claude-code:opus")).toBe("opus");
        expect(claudeModel("claude-code:default")).toBe("inherit");
        expect(claudeModel("anthropic:claude-haiku-5-5")).toBe("claude-haiku-5-5");
        expect(claudeModel("openrouter:anthropic/claude-opus-5-5")).toBe("claude-opus-5-5");
        expect(claudeModel("openai:gpt-5")).toBeUndefined();
        expect(claudeModel("openrouter:openai/gpt-5")).toBeUndefined();
        const defs = [user("name: a\ndescription: d"), user("name: b\ndescription: d\nmodel: inherit"), user("name: c\ndescription: d\nmodel: codex:gpt-5")];
        const out = claudeAgents(defs, opts);
        expect(Object.keys(out)).toEqual(["a", "b"]);
        expect(out.a!.model).toBe("inherit");
        expect(out.b!.model).toBe("inherit");
    });

    test("built-in and plugin agents stay Claude Code's own; an empty description gets one (Claude Code refuses empty ones)", () => {
        const plugin = parseAgentFile(file("name: kit:helper\ndescription: d"), "helper", "plugin");
        const out = claudeAgents([...BUILTIN_AGENTS, plugin, user("name: quiet")], opts);
        expect(Object.keys(out)).toEqual(["quiet"]);
        expect(out.quiet!.description).toBe("quiet agent");
    });

    test("project agents only when the user trusted the folder", () => {
        const defs = [user("name: mine\ndescription: d"), project("name: theirs\ndescription: d")];
        expect(Object.keys(claudeAgents(defs, opts))).toEqual(["mine", "theirs"]);
        expect(Object.keys(claudeAgents(defs, { ...opts, trusted: false }))).toEqual(["mine"]);
    });

    test("the session's plan, auto and bypass modes win over an agent's own; acceptEdits runs as default, as the session's does", () => {
        const def = user("name: e\ndescription: d\npermissionMode: acceptEdits");
        expect(claudeAgents([def], opts).e!.permissionMode).toBe("default");
        for (const mode of ["plan", "auto", "bypassPermissions"] as const) expect(claudeAgents([def], { ...opts, mode }).e!.permissionMode).toBeUndefined();
        expect(claudeAgents([user("name: p\ndescription: d\npermissionMode: plan")], { ...opts, mode: "acceptEdits" }).p!.permissionMode).toBe("plan");
        // A project agent's bypass was already dropped when it was read.
        expect(claudeAgents([project("name: b\ndescription: d\npermissionMode: bypassPermissions")], opts).b!.permissionMode).toBeUndefined();
    });

    test("hooks become Claude Code's nested form; an agent's Stop stays Stop there (Claude Code makes it SubagentStop)", () => {
        const def = user(`name: h
description: d
hooks:
  Stop:
    - command: ./done.sh
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: ./guard.sh
          timeout: 5`);
        expect(def.hooks?.SubagentStop).toBeDefined();
        expect(claudeAgents([def], opts).h!.hooks).toEqual({
            Stop: [{ hooks: [{ type: "command", command: "./done.sh" }] }],
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh", timeout: 5 }] }],
        });
    });

    test("skills the harness finds go in the prompt; the rest are Claude Code's to find", () => {
        mkdirSync(join(harnessHome(), "skills", "style"), { recursive: true });
        writeFileSync(join(harnessHome(), "skills", "style", "SKILL.md"), "---\nname: style\n---\nUse tabs.\n");
        const out = claudeAgents([user("name: s\ndescription: d\nskills: [style, cc-only]")], opts);
        expect(out.s!.prompt).toBe("Do the thing.\n\n# Skill: style\n\nUse tabs.");
        expect(out.s!.skills).toEqual(["cc-only"]);
    });

    test("MCP servers: names pass through; own ones by transport, with the approval and name rules the harness applies", () => {
        const front = `name: m
description: d
mcpServers:
  - github
  - local:
      command: node
      args: [server.js]
      env: { A: "1" }
  - remote:
      url: https://example.com/mcp
      headers: { X: y }
  - off:
      command: x
      disabled: true
  - taken:
      command: y`;
        const settings = { mcpServers: { taken: { command: "z" } } };
        expect(claudeAgents([user(front)], { ...opts, settings }).m!.mcpServers).toEqual([
            "github",
            { local: { type: "stdio", command: "node", args: ["server.js"], env: { A: "1" } } },
            { remote: { type: "http", url: "https://example.com/mcp", headers: { X: "y" } } },
        ]);
        // A project's agent: its own servers need .mcp.json's approval; named ones are Claude Code's to load (or not).
        expect(claudeAgents([project(front)], { ...opts, settings }).m!.mcpServers).toEqual(["github"]);
        expect(claudeAgents([project(front)], { ...opts, settings: { ...settings, enableAllProjectMcpServers: true } }).m!.mcpServers).toHaveLength(3);
    });

    test("an own server Claude Code would start somewhere else, or read differently, isn't passed (it has no cwd and expands ${VAR})", () => {
        const def = (src: "user" | "project", server: string) => parseAgentFile(file(`name: m\ndescription: d\nmcpServers:\n  - s:\n${server}`), "m", src);
        const notes: string[] = [];
        const approved = { ...opts, settings: { enableAllProjectMcpServers: true }, notes };
        // An approved project server in "tools": Claude Code would run server.js from the session folder, maybe another program.
        expect(claudeAgents([def("project", "      command: node\n      args: [server.js]\n      cwd: tools")], approved).m!.mcpServers).toBeUndefined();
        expect(notes.pop()).toMatch(/would start it in this folder/);
        expect(claudeAgents([def("user", "      command: node\n      cwd: tools")], approved).m!.mcpServers).toBeUndefined();
        // A cwd that is where Claude Code runs is fine, and so is a URL server.
        expect(claudeAgents([def("project", "      command: node\n      cwd: .")], approved).m!.mcpServers).toHaveLength(1);
        expect(claudeAgents([def("project", "      url: https://example.com/mcp\n      cwd: tools")], approved).m!.mcpServers).toHaveLength(1);
        // A session in a subfolder: Claude Code starts it there, the harness at the project root.
        mkdirSync(join(root, "sub"), { recursive: true });
        expect(claudeAgents([def("user", "      command: node")], { ...approved, cwd: join(root, "sub") }).m!.mcpServers).toBeUndefined();
        // ${VAR}: Claude Code expands it, the approval covers the literal text.
        expect(claudeAgents([def("project", '      command: "${TOOL}"')], approved).m!.mcpServers).toBeUndefined();
        expect(notes.pop()).toMatch(/expand/);
        expect(claudeAgents([def("user", '      command: "${TOOL}"')], approved).m!.mcpServers).toHaveLength(1);
    });

    test("an own server named like the project's .mcp.json one isn't passed, as the harness refuses it", () => {
        writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "x" } } }));
        const notes: string[] = [];
        const def = user("name: c\ndescription: d\nmcpServers:\n  - shared:\n      command: y");
        expect(claudeAgents([def], { ...opts, notes }).c!.mcpServers).toBeUndefined();
        expect(notes).toEqual([`The c agent's MCP server "shared" isn't passed to Claude Code: a configured server has that name.`]);
        // An untrusted folder's .mcp.json isn't loaded, so it can't clash.
        expect(claudeAgents([def], { ...opts, trusted: false }).c!.mcpServers).toHaveLength(1);
    });

    test("an agent's own server can't take the harness's own server's name", () => {
        const notes: string[] = [];
        const def = user(`name: h\ndescription: d\nmcpServers:\n  - ${MCP_SERVER_NAME}:\n      command: erase`);
        expect(claudeAgents([def], { ...opts, notes }).h!.mcpServers).toBeUndefined();
        expect(notes[0]).toContain("a configured server has that name");
    });

    test("an agent whose own mode differs from the session's doesn't get the harness's tools (they run in the session's mode)", () => {
        const harness = `mcp__${MCP_SERVER_NAME}`;
        const def = (mode?: string) => user(`name: a\ndescription: d${mode ? `\npermissionMode: ${mode}` : ""}\ndisallowedTools: Bash`);
        // A plan agent in an acceptEdits session: delegate would edit in acceptEdits.
        expect(claudeAgents([def("plan")], { ...opts, mode: "acceptEdits" }).a!.disallowedTools).toEqual(["Bash", harness]);
        expect(claudeAgents([def("acceptEdits")], opts).a!.disallowedTools).toEqual(["Bash", harness]);
        // The same mode, no mode of its own, or a session mode that wins: they keep them.
        expect(claudeAgents([def("default")], opts).a!.disallowedTools).toEqual(["Bash"]);
        expect(claudeAgents([def()], { ...opts, mode: "acceptEdits" }).a!.disallowedTools).toEqual(["Bash"]);
        expect(claudeAgents([def("acceptEdits")], { ...opts, mode: "plan" }).a!.disallowedTools).toEqual(["Bash"]);
    });

    test("the file is private and goes away when removed", () => {
        const f = writeAgentsFile({ a: { description: "d", prompt: "p" } });
        expect(JSON.parse(readFileSync(f.path, "utf-8"))).toEqual({ a: { description: "d", prompt: "p" } });
        expect(statSync(f.path).mode & 0o777).toBe(0o600);
        f.remove();
        expect(existsSync(f.path)).toBe(false);
    });
});
