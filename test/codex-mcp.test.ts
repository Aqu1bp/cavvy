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
