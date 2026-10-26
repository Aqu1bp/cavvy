// What Settings → Plugins shows about a plugin beyond the listing: its category's
// name, hue and icon, and the GitHub account whose logo marks it.

import type { PluginInfo, PluginMarketplaceInfo } from "@shared/protocol";

export type CategoryIcon = "code" | "briefcase" | "palette" | "shield" | "flask" | "database" | "graduation" | "activity" | "rocket" | "puzzle";

interface Category {
    name: string;
    /** The mark's tint and the category's dot: one hue per category, the same in both schemes. */
    hue: string;
    icon: CategoryIcon;
}

const KNOWN: Record<string, Category> = {
    development: { name: "Development", hue: "#2a78d6", icon: "code" },
    productivity: { name: "Productivity", hue: "#e8a200", icon: "briefcase" },
    design: { name: "Design", hue: "#d6517f", icon: "palette" },
    security: { name: "Security", hue: "#e34948", icon: "shield" },
    testing: { name: "Testing", hue: "#1baf7a", icon: "flask" },
    data: { name: "Data", hue: "#6250d6", icon: "database" },
    learning: { name: "Learning", hue: "#0f9b8e", icon: "graduation" },
    monitoring: { name: "Monitoring", hue: "#eb6834", icon: "activity" },
    deployment: { name: "Deployment", hue: "#5b5e66", icon: "rocket" },
};
const ALIASES: Record<string, string> = { database: "data", databases: "data", devops: "deployment", education: "learning", observability: "monitoring", test: "testing", tools: "development", "developer-tools": "development" };
const OTHER = { hue: "#5b5e66", icon: "puzzle" as const };

/** A plugin's category as the page shows it; one it doesn't know keeps its own name, in neutral ink. */
export function categoryOf(raw?: string): Category {
    const key = raw?.trim().toLowerCase().replace(/\s+/g, "-") ?? "";
    const known = KNOWN[ALIASES[key] ?? key];
    if (known) return known;
    if (!key) return { name: "Other", ...OTHER };
    return { name: raw!.trim().replace(/^./, (c) => c.toUpperCase()), ...OTHER };
}

/** A GitHub user or organization name. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * The GitHub account whose avatar marks a plugin: where its source ("github:owner/repo") or homepage says
 * it lives. Not the marketplace's own account: one logo on half the catalog says nothing, so those plugins
 * keep their category's icon.
 */
export function logoOwner(p: Pick<PluginInfo, "source" | "homepage" | "marketplace">, markets: PluginMarketplaceInfo[]): string | undefined {
    const owner = p.source?.match(/^github:([^/#\s]+)\//)?.[1] ?? p.homepage?.match(/^https?:\/\/(?:www\.)?github\.com\/([^/?#\s]+)/i)?.[1];
    if (!owner || !OWNER.test(owner)) return undefined;
    const market = markets.find((m) => m.name === p.marketplace);
    const marketOwner = market?.kind === "github" ? market.source.split("/")[0] : undefined;
    return marketOwner?.toLowerCase() === owner.toLowerCase() ? undefined : owner;
}
