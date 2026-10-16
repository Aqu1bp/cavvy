/** MCP provenance from Codex 0.163 config/read(includeLayers:true), before any thread starts servers. */
export interface CodexMcpOverrides {
    config?: { mcp_servers: Record<string, { enabled: false }> };
    missingProvenance: boolean;
    reservedCollision: boolean;
}

const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

// ConfigLayerSource from the Codex 0.163.0 app-server schema. New sources need verification before their servers can run.
const knownLayers = new Set([
    "packagedDefaults", "mdm", "system", "enterpriseManaged", "user", "project", "sessionFlags",
    "legacyManagedConfigTomlFromFile", "legacyManagedConfigTomlFromMdm",
]);

function serverNames(config: Record<string, any>): string[] {
    if (config.mcp_servers === undefined) return [];
    if (!record(config.mcp_servers)) throw new Error("Invalid MCP server map");
    return Object.keys(config.mcp_servers);
}

/** Disable whole names: a project can modify only one field of a user server through config merging. */
export function codexMcpOverrides(response: unknown, readOnly: boolean, reservedName?: string): CodexMcpOverrides {
    if (!record(response) || !record(response.config)) throw new Error("Missing Codex configuration");
    const effective = serverNames(response.config);
    let missingProvenance = false;
    const disabled = new Set<string>();
    if (readOnly) effective.forEach((n) => disabled.add(n));
    else {
        try {
            if (!Array.isArray(response.layers)) throw new Error("Missing config layers");
            const explained = new Set<string>();
            for (const layer of response.layers) {
                if (!record(layer) || !record(layer.name) || typeof layer.name.type !== "string" || !record(layer.config)) throw new Error("Invalid config layer");
                if (layer.disabledReason != null && typeof layer.disabledReason !== "string") throw new Error("Invalid disabled reason");
                const names = serverNames(layer.config);
                if (names.length && !knownLayers.has(layer.name.type)) throw new Error("Unknown config layer source");
                if (typeof layer.disabledReason === "string" && layer.disabledReason.length > 0) continue;
                names.forEach((n) => explained.add(n));
                if (layer.name.type === "project") names.forEach((n) => disabled.add(n));
            }
            // An empty or partial layer list is not evidence that effective servers came from safe sources.
            if (effective.some((n) => !explained.has(n))) throw new Error("Unexplained MCP servers");
        } catch {
            // Missing or malformed provenance must not leave any configured servers running.
            missingProvenance = true;
            effective.forEach((n) => disabled.add(n));
        }
    }
    // Nested thread config merges with existing servers. Never merge delegation credentials into an existing transport.
    const reservedCollision = reservedName !== undefined && effective.includes(reservedName);
    if (reservedCollision) disabled.add(reservedName!);
    return {
        config: disabled.size ? { mcp_servers: Object.fromEntries([...disabled].map((n) => [n, { enabled: false as const }])) } : undefined,
        missingProvenance,
        reservedCollision,
    };
}
