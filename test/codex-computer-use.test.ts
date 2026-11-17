import { describe, expect, test } from "bun:test";
import { computerUseOffConfig, fromComputerUse, mergeThreadConfig } from "../src/backends/codex-computer-use";
import { computerUseOff } from "../src/backends/codex";

/** An app approval as ChatGPT 26.1106's computer use sends it, passed on by Codex 0.167. */
const appAsk = { threadId: "t", turnId: "u", serverName: "cua_repl", mode: "form", message: 'Allow Computer Use to use "Safari"?', requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", connector_id: "computer-use", persist: ["session", "always"], tool_name: "get_app_state", tool_params: { app: "com.apple.Safari" } } };

describe("the ChatGPT app's computer use, kept off", () => {
    test("off: only what's on is turned off, by plugin and by server name", () => {
        expect(computerUseOffConfig({ plugins: { "unified-computer-use@openai-bundled": { enabled: true }, "computer-use@openai-bundled": { enabled: false }, "browser@openai-bundled": { enabled: true } }, mcp_servers: { "computer-use": { command: "x" }, github: { url: "u" } } })).toEqual({
            plugins: { "unified-computer-use@openai-bundled": { enabled: false } },
            mcp_servers: { "computer-use": { enabled: false } },
        });
        expect(computerUseOffConfig({ mcp_servers: {} })).toEqual({});
        expect(computerUseOffConfig(undefined)).toEqual({});
        // Nothing to turn off: no thread config at all.
        expect(computerUseOff({})).toBeUndefined();
        expect(computerUseOff({ plugins: { "unified-computer-use@openai-bundled": { enabled: true } } })).toEqual({ plugins: { "unified-computer-use@openai-bundled": { enabled: false } } });
    });

    test("merged with what else is turned off: servers and plugins by name", () => {
        expect(mergeThreadConfig({ mcp_servers: { a: { enabled: false } }, plugins: { p: { enabled: false } } }, { mcp_servers: { b: { enabled: false } }, plugins: { q: { enabled: false } } })).toEqual({ mcp_servers: { a: { enabled: false }, b: { enabled: false } }, plugins: { p: { enabled: false }, q: { enabled: false } } });
        expect(mergeThreadConfig(undefined, {})).toBeUndefined();
        expect(mergeThreadConfig({ a: 1 }, undefined)).toEqual({ a: 1 });
    });

    test("what it asks anyway is recognised, to be declined: an app, Codex's own approval of its call, a link", () => {
        expect(fromComputerUse(appAsk)).toBe(true);
        // Its connector named, from a server by another name.
        expect(fromComputerUse({ ...appAsk, serverName: "elsewhere" })).toBe(true);
        expect(fromComputerUse({ serverName: "cua_repl", mode: "form", message: 'Allow the cua_repl MCP server to run tool "js"?', _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "js" } })).toBe(true);
        expect(fromComputerUse({ serverName: "computer-use", mode: "url", message: "Finish setting up", url: "https://example.com" })).toBe(true);
        // Another server's.
        expect(fromComputerUse({ serverName: "github", mode: "form", message: "Pick a repo", _meta: null })).toBe(false);
        expect(fromComputerUse({})).toBe(false);
    });
});
