import { expect, test } from "bun:test";
import { codexMcpOverrides } from "../src/backends/codex-mcp";

test("project provenance disables whole names, but disabled layers do not affect user-only servers", () => {
    const result = codexMcpOverrides({ config: { mcp_servers: { personal: {}, shared: {}, project: {} } }, layers: [
        { name: { type: "user" }, config: { mcp_servers: { personal: {}, shared: {} } } },
        { name: { type: "project" }, config: { mcp_servers: { shared: { env: { X: "changed" } }, project: {} } } },
        { name: { type: "project" }, config: { mcp_servers: { personal: {} } }, disabledReason: "untrusted" },
    ] }, false);
    expect(result.config).toEqual({ mcp_servers: { shared: { enabled: false }, project: { enabled: false } } });
    expect(result.missingProvenance).toBe(false);
});

test("malformed provenance disables every effective server; malformed effective config refuses the turn", () => {
    for (const layers of [
        undefined, {}, [], [null],
        [{ name: { type: "project" }, config: { mcp_servers: [] } }],
        [{ name: { type: "unknown" }, config: { mcp_servers: { personal: {} } } }],
        [{ name: { type: "project" }, config: { mcp_servers: { personal: {} } }, disabledReason: {} }],
        [{ name: { type: "user" }, config: { mcp_servers: { unrelated: {} } } }],
        [{ name: { type: "user" }, config: { mcp_servers: { personal: {} } }, disabledReason: "disabled" }],
    ]) {
        const result = codexMcpOverrides({ config: { mcp_servers: { personal: {} } }, layers }, false);
        expect(result.missingProvenance).toBe(true);
        expect(result.config).toEqual({ mcp_servers: { personal: { enabled: false } } });
    }
    for (const response of [null, {}, { config: { mcp_servers: [] } }]) expect(() => codexMcpOverrides(response, false)).toThrow();
});

test("read-only turns disable all servers and an existing delegation name is never merged", () => {
    const config = { mcp_servers: { personal: {}, harness: { command: "unapproved" } } };
    const response = { config, layers: [{ name: { type: "user" }, config }] };
    expect(codexMcpOverrides(response, true).config).toEqual({ mcp_servers: { personal: { enabled: false }, harness: { enabled: false } } });
    const result = codexMcpOverrides(response, false, "harness");
    expect(result.reservedCollision).toBe(true);
    expect(result.config).toEqual({ mcp_servers: { harness: { enabled: false } } });
});

for (const type of ["packagedDefaults", "mdm", "system", "enterpriseManaged", "user", "sessionFlags", "legacyManagedConfigTomlFromFile", "legacyManagedConfigTomlFromMdm"]) {
    test(`Codex 0.163 ${type} provenance explains an effective server`, () => {
        const config = { mcp_servers: { personal: {} } };
        const result = codexMcpOverrides({ config, layers: [{ name: { type }, config }] }, false);
        expect(result.missingProvenance).toBe(false);
        expect(result.config).toBeUndefined();
    });
}

test("an unknown layer cannot modify an otherwise explained server", () => {
    const config = { mcp_servers: { personal: {} } };
    const result = codexMcpOverrides({ config, layers: [
        { name: { type: "user" }, config },
        { name: { type: "unknown" }, config: { mcp_servers: { personal: { env: { X: "changed" } } } } },
    ] }, false);
    expect(result.missingProvenance).toBe(true);
    expect(result.config).toEqual({ mcp_servers: { personal: { enabled: false } } });
});

for (const disabledReason of [undefined, null, "", {}, false]) {
    test(`a project layer with disabledReason=${JSON.stringify(disabledReason)} is not skipped`, () => {
        const config = { mcp_servers: { project: {} } };
        const result = codexMcpOverrides({ config, layers: [{ name: { type: "project" }, config, disabledReason }] }, false);
        expect(result.config).toEqual({ mcp_servers: { project: { enabled: false } } });
    });
}

// Codex 0.163 lists a native plugin's MCP servers nowhere in mcp_servers (checked against a real install),
// so only turning the plugin off keeps them from starting.
test("read-only turns and missing provenance also turn off Codex's own plugins, whose servers mcp_servers doesn't list", () => {
    const config = { mcp_servers: {}, plugins: { "fmt@local": { enabled: true }, "old@local": { enabled: false }, "bad@local": "x" } };
    const layers = [{ name: { type: "user" }, config }];
    expect(codexMcpOverrides({ config, layers }, true).config).toEqual({ plugins: { "fmt@local": { enabled: false } } });
    expect(codexMcpOverrides({ config, layers }, false).config).toBeUndefined();
    const lost = codexMcpOverrides({ config: { ...config, mcp_servers: { personal: {} } }, layers }, false);
    expect(lost.missingProvenance).toBe(true);
    expect(lost.config).toEqual({ mcp_servers: { personal: { enabled: false } }, plugins: { "fmt@local": { enabled: false } } });
});

test("a plugin a project layer turns on is turned off, like the project's own servers", () => {
    const config = { plugins: { "mine@local": { enabled: true }, "theirs@local": { enabled: true } } };
    const result = codexMcpOverrides({ config, layers: [
        { name: { type: "user" }, config: { plugins: { "mine@local": { enabled: true }, "theirs@local": { enabled: false } } } },
        { name: { type: "project" }, config: { plugins: { "theirs@local": { enabled: true } } } },
        { name: { type: "project" }, config: { plugins: { "mine@local": { enabled: true } } }, disabledReason: "untrusted" },
    ] }, false);
    expect(result.missingProvenance).toBe(false);
    expect(result.config).toEqual({ plugins: { "theirs@local": { enabled: false } } });
});
