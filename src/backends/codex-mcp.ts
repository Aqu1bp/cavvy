/** MCP provenance from Codex 0.163 config/read(includeLayers:true), before any thread starts servers. */
export interface CodexMcpOverrides {
    config?: { mcp_servers?: Record<string, { enabled: false }>; plugins?: Record<string, { enabled: false }> };
    missingProvenance: boolean;
    reservedCollision: boolean;
    /** Every reserved name Codex already has a server under (each is disabled). */
    collisions: string[];
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

/** Plugins Codex has turned on (`[plugins."name@marketplace"] enabled = true`). Their MCP servers aren't in mcp_servers. */
function enabledPlugins(config: Record<string, any>): string[] {
    if (!record(config.plugins)) return [];
    return Object.entries(config.plugins).filter(([, v]) => record(v) && v.enabled !== false).map(([id]) => id);
}

/** Disable whole names: a project can modify only one field of a user server through config merging. */
export function codexMcpOverrides(response: unknown, readOnly: boolean, reservedName?: string | string[]): CodexMcpOverrides {
    if (!record(response) || !record(response.config)) throw new Error("Missing Codex configuration");
    const effective = serverNames(response.config);
    let missingProvenance = false;
    const disabled = new Set<string>();
    // Codex starts a native plugin's MCP servers outside mcp_servers, and a thread can't turn one of those off
    // by name (Codex refuses a server entry without a transport), only the whole plugin, skills included.
    const plugins = enabledPlugins(response.config);
    const pluginsOff = new Set<string>();
    if (readOnly) {
        effective.forEach((n) => disabled.add(n));
        plugins.forEach((id) => pluginsOff.add(id));
    }
    else {
        try {
            if (!Array.isArray(response.layers)) throw new Error("Missing config layers");
            const explained = new Set<string>();
            // Each active layer's plugins table, highest precedence first (as Codex 0.163 lists layers: project, user, system).
            const pluginLayers: Record<string, unknown>[] = [];
            for (const layer of response.layers) {
                if (!record(layer) || !record(layer.name) || typeof layer.name.type !== "string" || !record(layer.config)) throw new Error("Invalid config layer");
                if (layer.disabledReason != null && typeof layer.disabledReason !== "string") throw new Error("Invalid disabled reason");
                const names = serverNames(layer.config);
                // An enabled plugin starts servers too, so it needs the same provenance as one.
                const turnedOn = enabledPlugins(layer.config);
                const pluginTable = record(layer.config.plugins) ? layer.config.plugins : {};
                if ((names.length || Object.keys(pluginTable).length) && !knownLayers.has(layer.name.type)) throw new Error("Unknown config layer source");
                if (typeof layer.disabledReason === "string" && layer.disabledReason.length > 0) continue;
                names.forEach((n) => explained.add(n));
                pluginLayers.push(pluginTable);
                if (layer.name.type === "project") {
                    names.forEach((n) => disabled.add(n));
                    // A project can turn on a plugin someone installed and left off; its servers are the project's too.
                    turnedOn.forEach((id) => pluginsOff.add(id));
                }
            }
            // An empty or partial layer list is not evidence that effective servers came from safe sources.
            if (effective.some((n) => !explained.has(n))) throw new Error("Unexplained MCP servers");
            // A plugin is explained only if the layers, applied lowest precedence first, leave it on.
            const pluginOn = new Map<string, boolean>();
            for (const table of [...pluginLayers].reverse()) {
                for (const [id, v] of Object.entries(table)) if (record(v) && typeof v.enabled === "boolean") pluginOn.set(id, v.enabled);
            }
            if (plugins.some((id) => pluginOn.get(id) !== true)) throw new Error("Unexplained plugins");
        } catch {
            // Missing or malformed provenance must not leave any configured servers running.
            missingProvenance = true;
            effective.forEach((n) => disabled.add(n));
            plugins.forEach((id) => pluginsOff.add(id));
        }
    }
    // Nested thread config merges with existing servers. Never merge delegation credentials into an existing transport.
    const reserved = reservedName === undefined ? [] : Array.isArray(reservedName) ? reservedName : [reservedName];
    const collisions = reserved.filter((n) => effective.includes(n));
    collisions.forEach((n) => disabled.add(n));
    const reservedCollision = reserved[0] !== undefined && collisions.includes(reserved[0]);
    const off = (names: Set<string>) => Object.fromEntries([...names].map((n) => [n, { enabled: false as const }]));
    const config = { ...(disabled.size ? { mcp_servers: off(disabled) } : {}), ...(pluginsOff.size ? { plugins: off(pluginsOff) } : {}) };
    return {
        config: Object.keys(config).length ? config : undefined,
        missingProvenance,
        reservedCollision,
        collisions,
    };
}
