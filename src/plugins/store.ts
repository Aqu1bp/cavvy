// What's on disk under ~/.harness/plugins/:
//
//   known_marketplaces.json   marketplaces added, and where each one lives
//   installed_plugins.json    installed plugins: version, folder, and which scopes enabled them
//   marketplaces/<name>/      marketplaces fetched from git or a URL
//   cache/<marketplace>/<plugin>/<version>/   installed plugin files
//
// Which plugins are on is in settings ("enabledPlugins"), per scope.

import { readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { paths } from "../config/paths";
import type { SettingsScope } from "../config/settings";
import { writeJson } from "../config/settings";
import { stripJsonComments } from "../util/jsonc";

export type MarketplaceSource =
    | { source: "github"; repo: string; ref?: string }
    | { source: "git"; url: string; ref?: string }
    | { source: "directory"; path: string }
    | { source: "file"; path: string }
    | { source: "url"; url: string };

export interface KnownMarketplace {
    source: MarketplaceSource;
    /** The folder holding the marketplace (for "file" and "url", the folder of the saved marketplace.json). */
    installLocation: string;
    lastUpdated: string;
    /** The commit a git marketplace was fetched at: the version of plugins it holds that don't give one. */
    gitCommitSha?: string;
}

export interface ScopeRecord {
    scope: SettingsScope;
    /** For project and local scopes: the project folder. */
    projectPath?: string;
}

export interface InstalledPlugin {
    version: string;
    installPath: string;
    installedAt: string;
    lastUpdated: string;
    gitCommitSha?: string;
    scopes: ScopeRecord[];
}

export const pluginPaths = {
    root: () => paths.plugins(),
    known: () => join(paths.plugins(), "known_marketplaces.json"),
    installed: () => join(paths.plugins(), "installed_plugins.json"),
    marketplaces: () => join(paths.plugins(), "marketplaces"),
    cache: () => join(paths.plugins(), "cache"),
};

const entries = new Map<string, { mtime: number; size: number; value: unknown }>();

/**
 * A JSON (with comments) file, parsed once per change: the second read of an
 * unchanged file is a stat. Missing or unparseable files are undefined (and
 * not cached, so a fix shows at once); `onError` hears about the latter.
 */
export function cachedJson<T>(file: string, onError?: (msg: string) => void): T | undefined {
    let st;
    try {
        st = statSync(file);
    } catch {
        entries.delete(file);
        return undefined;
    }
    const hit = entries.get(file);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.value as T;
    try {
        const text = readFileSync(file, "utf-8");
        const value = text.trim() ? JSON.parse(stripJsonComments(text)) : undefined;
        entries.set(file, { mtime: st.mtimeMs, size: st.size, value });
        return value as T;
    } catch (e) {
        entries.delete(file);
        onError?.(`${file} isn't valid JSON (${(e as Error).message})`);
        return undefined;
    }
}

/** Forget cached files (tests, and after this process writes them). */
export function clearJsonCache(file?: string) {
    if (file) entries.delete(file);
    else entries.clear();
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readKnownMarketplaces(): Record<string, KnownMarketplace> {
    const j = cachedJson<unknown>(pluginPaths.known());
    const out: Record<string, KnownMarketplace> = {};
    if (!record(j)) return out;
    for (const [name, v] of Object.entries(j)) {
        if (!record(v) || !record(v.source) || typeof v.installLocation !== "string") continue;
        Object.defineProperty(out, name, { value: structuredClone(v) as unknown as KnownMarketplace, enumerable: true, writable: true, configurable: true });
    }
    return out;
}

export function writeKnownMarketplaces(m: Record<string, KnownMarketplace>) {
    writeJson(pluginPaths.known(), m);
    clearJsonCache(pluginPaths.known());
}

export function readInstalled(): Record<string, InstalledPlugin> {
    const j = cachedJson<unknown>(pluginPaths.installed());
    const out: Record<string, InstalledPlugin> = {};
    const plugins = record(j) && record(j.plugins) ? j.plugins : {};
    for (const [id, v] of Object.entries(plugins)) {
        if (!record(v) || typeof v.installPath !== "string" || typeof v.version !== "string") continue;
        const scopes = Array.isArray(v.scopes) ? v.scopes.filter((s): s is ScopeRecord => record(s) && (s.scope === "user" || s.scope === "project" || s.scope === "local")) : [];
        Object.defineProperty(out, id, { value: { ...(structuredClone(v) as unknown as InstalledPlugin), scopes: structuredClone(scopes) }, enumerable: true, writable: true, configurable: true });
    }
    return out;
}

export function writeInstalled(p: Record<string, InstalledPlugin>) {
    writeJson(pluginPaths.installed(), { version: 1, plugins: p });
    clearJsonCache(pluginPaths.installed());
}

/** "name@marketplace" split; undefined parts when it isn't one. */
export function splitId(id: string): { name: string; marketplace?: string } {
    const at = id.lastIndexOf("@");
    return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) || undefined } : { name: id };
}

export const sameScope = (a: ScopeRecord, b: ScopeRecord) => a.scope === b.scope && (a.scope === "user" || resolve(a.projectPath ?? "") === resolve(b.projectPath ?? ""));
