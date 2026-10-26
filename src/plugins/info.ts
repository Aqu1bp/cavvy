// What the plugin listing says, for every front end (the GUI imports this file: types only).

export type PluginScope = "user" | "project" | "local";

export interface Counts {
    commands: number;
    agents: number;
    skills: number;
    hooks: number;
    mcpServers: number;
    lspServers: number;
}

export interface PluginInfo {
    id: string;
    name: string;
    marketplace: string;
    description?: string;
    version?: string;
    author?: string;
    category?: string;
    homepage?: string;
    source?: string;
    /** In the cache (any scope). */
    installed?: { version: string; installedAt: string; lastUpdated: string; counts: Counts };
    /** On for this folder (by the settings that apply here). */
    enabled: boolean;
    /** How each scope sets it, for this folder. */
    scopes: Partial<Record<PluginScope, boolean>>;
    /** On in settings, but not installed. */
    missing?: boolean;
    /** No longer in its marketplace's catalog. */
    orphaned?: boolean;
    errors: string[];
}

export interface MarketplaceInfo {
    name: string;
    source: string;
    kind: "github" | "git" | "directory" | "file" | "url";
    description?: string;
    owner?: string;
    plugins: number;
    lastUpdated?: string;
    error?: string;
    warnings: string[];
}

export interface PluginListing {
    marketplaces: MarketplaceInfo[];
    plugins: PluginInfo[];
}
