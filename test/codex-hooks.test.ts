import { describe, expect, test } from "bun:test";
import { CODEX_HOOK_SERVER, codexHookArgs, codexHookFailed, codexHookHash, codexHookTaken, nativeCall, preToolUseAnswer } from "../src/backends/codex-hooks";
import { registerTools } from "../src/mcp/server";

describe("the harness's PreToolUse hook as one of Codex's", () => {
    test("its trust hash is the one Codex 0.163 computes for it", () => {
        // Reported by hooks/list (currentHash) of a real Codex 0.163.0 for this handler, with trustStatus "trusted".
        const handler = { type: "mcp_tool", server: "harness_hooks", tool: "pre_tool_use", input: { tool_name: "${tool_name}", tool_input: "${tool_input}", tool_use_id: "${tool_use_id}" }, timeout: 600 };
        expect(codexHookHash("pre_tool_use", { hooks: [handler] })).toBe("sha256:419b558bc420334071f3702580e60fff5eff3d16cff2c012c2cd215c841c38bf");
        // Key order doesn't matter, as Codex sorts it.
        expect(codexHookHash("pre_tool_use", { hooks: [{ timeout: 600, input: handler.input, tool: handler.tool, server: handler.server, type: handler.type }] })).toBe(codexHookHash("pre_tool_use", { hooks: [handler] }));
        const arg = codexHookArgs()[1]!;
        expect(codexHookArgs()[0]).toBe("-c");
        // The hook as given (an hour's timeout, so a hook that asks can wait on the user), trusted by its own hash.
        const given = { ...handler, timeout: 3600 };
        expect(arg).toContain(`"/<session-flags>/config.toml:pre_tool_use:0:0"={"trusted_hash"="${codexHookHash("pre_tool_use", { hooks: [given] })}"}`);
        expect(arg).toContain('"timeout"=3600');
        expect(arg).toStartWith('hooks={"PreToolUse"=[{"hooks"=[{"type"="mcp_tool","server"="harness_hooks","tool"="pre_tool_use"');
    });

    test("hooks/list: taken only when Codex lists it trusted and on", () => {
        const ours = { handlerType: "mcpTool", server: CODEX_HOOK_SERVER, tool: "pre_tool_use", trustStatus: "trusted", enabled: true };
        expect(codexHookTaken({ data: [{ cwd: "/p", hooks: [ours] }] })).toBe(true);
        for (const h of [{ ...ours, trustStatus: "untrusted" }, { ...ours, trustStatus: "modified" }, { ...ours, enabled: false }, { ...ours, server: "other" }, { handlerType: "command", command: "x", trustStatus: "trusted" }]) expect(codexHookTaken({ data: [{ hooks: [h] }] })).toBe(false);
        for (const r of [undefined, null, {}, { data: "x" }, { data: [{}] }]) expect(codexHookTaken(r)).toBe(false);
    });

    test("a failed run is only the harness's PreToolUse hook failing", () => {
        const run = { eventName: "preToolUse", handlerType: "mcpTool", source: "sessionFlags", status: "failed" };
        expect(codexHookFailed({ run })).toBe(true);
        for (const r of [{ ...run, status: "blocked" }, { ...run, status: "completed" }, { ...run, source: "user" }, { ...run, eventName: "postToolUse" }, { ...run, handlerType: "command" }]) expect(codexHookFailed({ run: r })).toBe(false);
        expect(codexHookFailed({})).toBe(false);
    });

    test("Codex's calls in the harness's names: Bash, a patch as Write or Edit with its first file, spawn_agent as Task", () => {
        expect(nativeCall("Bash", { command: "ls" }, "/p")).toEqual({ toolName: "Bash", input: { command: "ls" }, rewritable: true });
        const add = "*** Begin Patch\n*** Add File: new.txt\n+hi\n*** Add File: /abs/b.txt\n+x\n*** End Patch";
        expect(nativeCall("apply_patch", { command: add }, "/p")).toEqual({ toolName: "Write", input: { file_path: "/p/new.txt", patch: add }, rewritable: false });
        const update = "*** Begin Patch\n*** Add File: a.txt\n+a\n*** Update File: src/x.ts\n@@\n-a\n+b\n*** End Patch";
        expect(nativeCall("apply_patch", { command: update }, "/p")).toMatchObject({ toolName: "Edit", input: { file_path: "/p/a.txt" } });
        expect(nativeCall("apply_patch", { command: "garbage" }, "/p")).toMatchObject({ toolName: "Edit", input: { file_path: "" } });
        expect(nativeCall("spawn_agent", { message: "go" }, "/p")).toEqual({ toolName: "Task", input: { message: "go" }, rewritable: false });
        expect(nativeCall("mcp__docs__search", { q: "x" }, "/p")).toEqual({ toolName: "mcp__docs__search", input: { q: "x" }, rewritable: true });
        expect(nativeCall("web_search", null, "/p").input).toEqual({});
    });

    test("the answer Codex reads: a deny, a rewrite, context, or nothing", () => {
        expect(preToolUseAnswer({})).toBe("");
        expect(JSON.parse(preToolUseAnswer({ deny: "no" }))).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } });
        expect(JSON.parse(preToolUseAnswer({ updatedInput: { command: "ls" }, context: "c" }))).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "ls" }, additionalContext: "c" } });
        // A deny wins over a rewrite.
        expect(JSON.parse(preToolUseAnswer({ deny: "", updatedInput: { command: "ls" } })).hookSpecificOutput).not.toHaveProperty("updatedInput");
        expect(JSON.parse(preToolUseAnswer({ context: "only context" }))).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "only context" } });
    });

    test("the MCP server lists a tool's _meta, which keeps it from Codex's model", async () => {
        const reg = registerTools([{ name: "pre_tool_use", description: "d", inputSchema: { type: "object" }, meta: { ui: { visibility: ["app"] } }, call: async () => ({ text: "" }) }]);
        try {
            const r = await fetch(reg.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: reg.authorization }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
            expect((await r.json()).result.tools[0]).toMatchObject({ name: "pre_tool_use", _meta: { ui: { visibility: ["app"] } } });
        } finally {
            reg.close();
        }
    });
});
