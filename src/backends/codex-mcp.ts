/** MCP provenance from Codex 0.163 config/read(includeLayers:true), before any thread starts servers. */
export interface CodexMcpOverrides {
    config?: { mcp_servers: Record<string, { enabled: false }> };
    missingProvenance: boolean;
    reservedCollision: boolean;
}

const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

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
            for (const layer of response.layers) {
                if (!record(layer) || !record(layer.name) || typeof layer.name.type !== "string" || !record(layer.config)) throw new Error("Invalid config layer");
                if (layer.disabledReason) continue;
                if (layer.name.type === "project") serverNames(layer.config).forEach((n) => disabled.add(n));
            }
        } catch {
            // Older CLIs without provenance can still be used, but none of their configured servers can start.
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
