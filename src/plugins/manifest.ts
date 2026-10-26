// Plugin and marketplace manifests. The format is Claude Code's, so its
// plugins and marketplaces install as they are:
//
//   <plugin>/.cavvy-plugin/plugin.json   (or .claude-plugin/plugin.json)
//   <plugin>/commands/*.md  agents/*.md  skills/<name>/SKILL.md
//   <plugin>/hooks/hooks.json  <plugin>/.mcp.json
//
//   <marketplace>/.cavvy-plugin/marketplace.json  (or .claude-plugin/…)
//   { "name": "…", "owner": {…}, "plugins": [{ "name": "…", "source": "./plugins/x" }, …] }

import { existsSync } from "fs";
import { join } from "path";
import { LEGACY } from "../config/legacy";

/**
 * Manifest folders, ours first: a plugin that ships both is read as a Cavvy plugin.
 * Then Harness's, which a copy installed before the rename has (legacy.ts).
 */
export const MANIFEST_DIRS = [".cavvy-plugin", LEGACY.pluginManifestDir, ".claude-plugin"] as const;

export interface PluginAuthor {
    name?: string;
    email?: string;
    url?: string;
}

export interface PluginManifest {
    name: string;
    version?: string;
    description?: string;
    author?: PluginAuthor;
    homepage?: string;
    repository?: string;
    license?: string;
    keywords?: string[];
    /** Extra command/agent/skill paths (files or folders), on top of the default folders. */
    commands?: string[];
    agents?: string[];
    skills?: string[];
    /** A hooks.json path, or the hooks themselves. */
    hooks?: string | Record<string, unknown>;
    /** A .mcp.json-style file path, or the servers themselves. */
    mcpServers?: string | Record<string, unknown>;
    /** Language servers (a .lsp.json-style file path, or the servers): kept for the LSP support to read. */
    lspServers?: string | Record<string, unknown>;
}

export type PluginSource =
    | { source: "path"; path: string }
    | { source: "github"; repo: string; ref?: string; sha?: string }
    | { source: "git"; url: string; ref?: string; sha?: string; path?: string }
    | { source: "npm"; package: string; version?: string; registry?: string };

export interface MarketplaceEntry extends Partial<Omit<PluginManifest, "name">> {
    name: string;
    source: PluginSource;
    category?: string;
    tags?: string[];
    /** false: the entry is the whole manifest (the plugin has none of its own). */
    strict?: boolean;
    /** The entry's manifest fields as written, those Cavvy doesn't read included (outputStyles…), for Claude Code's copy. */
    raw?: Record<string, unknown>;
}

export interface Marketplace {
    name: string;
    owner?: PluginAuthor;
    description?: string;
    /** Folder that relative plugin sources start from. */
    pluginRoot?: string;
    plugins: MarketplaceEntry[];
    /** Entries that were left out, and why. */
    errors: string[];
}

/** Plugin and marketplace names become folder names and command prefixes. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validName(name: unknown): name is string {
    return typeof name === "string" && NAME.test(name);
}

export function nameError(kind: "plugin" | "marketplace", name: unknown): string {
    return `${kind} name ${JSON.stringify(name)} isn't valid: use lowercase letters, digits, "-" or "_", starting with a letter or digit (at most 64)`;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strList = (v: unknown): string[] | undefined => {
    if (typeof v === "string") return v.trim() ? [v.trim()] : undefined;
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
    return out.length ? out : undefined;
};
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function author(v: unknown): PluginAuthor | undefined {
    if (typeof v === "string") return str(v) ? { name: str(v) } : undefined;
    if (!record(v)) return undefined;
    const a = { name: str(v.name), email: str(v.email), url: str(v.url) };
    return a.name || a.email || a.url ? a : undefined;
}

function repository(v: unknown): string | undefined {
    return str(v) ?? (record(v) ? str(v.url) : undefined);
}

/** The manifest fields a marketplace entry can also carry. */
function manifestFields(j: Record<string, unknown>): Omit<PluginManifest, "name"> {
    const out: Omit<PluginManifest, "name"> = {
        version: str(j.version),
        description: str(j.description),
        author: author(j.author),
        homepage: str(j.homepage),
        repository: repository(j.repository),
        license: str(j.license),
        keywords: strList(j.keywords),
        commands: strList(j.commands),
        agents: strList(j.agents),
        skills: strList(j.skills),
        hooks: typeof j.hooks === "string" ? str(j.hooks) : record(j.hooks) ? j.hooks : undefined,
        mcpServers: typeof j.mcpServers === "string" ? str(j.mcpServers) : record(j.mcpServers) ? j.mcpServers : undefined,
        lspServers: typeof j.lspServers === "string" ? str(j.lspServers) : record(j.lspServers) ? j.lspServers : undefined,
    };
    for (const k of Object.keys(out) as (keyof typeof out)[]) if (out[k] === undefined) delete out[k];
    return out;
}

/** A plugin.json's contents; `fallbackName` names a plugin whose manifest doesn't. Throws on a bad name. */
export function parsePluginManifest(j: unknown, fallbackName: string): PluginManifest {
    if (!record(j)) throw new Error("plugin.json must be a JSON object");
    const name = j.name === undefined ? fallbackName : j.name;
    if (!validName(name)) throw new Error(nameError("plugin", name));
    return { name, ...manifestFields(j) };
}

/** Where a plugin keeps its manifest, if it has one. */
export function manifestFile(root: string): string | undefined {
    for (const d of MANIFEST_DIRS) {
        const f = join(root, d, "plugin.json");
        if (existsSync(f)) return f;
    }
    return undefined;
}

export function marketplaceFile(root: string): string | undefined {
    for (const d of MANIFEST_DIRS) {
        const f = join(root, d, "marketplace.json");
        if (existsSync(f)) return f;
    }
    return undefined;
}

export function parseSource(v: unknown): PluginSource {
    if (typeof v === "string") {
        if (!v.trim()) throw new Error("source is empty");
        return { source: "path", path: v.trim() };
    }
    if (!record(v)) throw new Error("source must be a path or an object");
    const ref = str(v.ref);
    const sha = str(v.sha);
    if (sha && !/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error(`sha ${JSON.stringify(sha)} isn't a commit hash`);
    if (ref && (ref.startsWith("-") || /\s/.test(ref))) throw new Error(`ref ${JSON.stringify(ref)} isn't valid`);
    switch (v.source) {
        case "github": {
            const repo = str(v.repo);
            if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`github source needs "repo": "owner/name"`);
            return { source: "github", repo, ...(ref ? { ref } : {}), ...(sha ? { sha } : {}) };
        }
        case "url":
        case "git":
        case "git-subdir": {
            const url = str(v.url);
            if (!url || url.startsWith("-")) throw new Error(`${v.source} source needs a "url"`);
            const path = str(v.path);
            if (v.source === "git-subdir" && !path) throw new Error(`git-subdir source needs a "path"`);
            return { source: "git", url, ...(ref ? { ref } : {}), ...(sha ? { sha } : {}), ...(path ? { path } : {}) };
        }
        case "npm": {
            const pkg = str(v.package);
            if (!pkg || !/^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(pkg)) throw new Error(`npm source needs a valid "package"`);
            const registry = str(v.registry);
            if (registry && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(registry + "/")) throw new Error(`npm registry must be an https URL`);
            return { source: "npm", package: pkg, ...(str(v.version) ? { version: str(v.version) } : {}), ...(registry ? { registry: registry.replace(/\/+$/, "") } : {}) };
        }
        case "path":
        case "local":
        case "directory": {
            const path = str(v.path);
            if (!path) throw new Error(`${v.source} source needs a "path"`);
            return { source: "path", path };
        }
        default:
            throw new Error(`unknown source type ${JSON.stringify(v.source)}`);
    }
}

/** A marketplace entry without the fields that only say where and how to list it. */
function entryFields(raw: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) if (k !== "__proto__" && k !== "source" && k !== "strict" && k !== "category" && k !== "tags") out[k] = structuredClone(v);
    return out;
}

/** A marketplace.json's contents. Bad entries are dropped (and listed in `errors`), not fatal. */
export function parseMarketplace(j: unknown): Marketplace {
    if (!record(j)) throw new Error("marketplace.json must be a JSON object");
    if (!validName(j.name)) throw new Error(nameError("marketplace", j.name));
    const metadata = record(j.metadata) ? j.metadata : {};
    const errors: string[] = [];
    const plugins: MarketplaceEntry[] = [];
    const seen = new Set<string>();
    for (const [i, raw] of (Array.isArray(j.plugins) ? j.plugins : []).entries()) {
        if (!record(raw)) {
            errors.push(`plugins[${i}] isn't an object`);
            continue;
        }
        if (!validName(raw.name)) {
            errors.push(`plugins[${i}]: ${nameError("plugin", raw.name)}`);
            continue;
        }
        if (seen.has(raw.name)) {
            errors.push(`plugins[${i}]: "${raw.name}" is listed twice; the first one counts`);
            continue;
        }
        let source: PluginSource;
        try {
            source = parseSource(raw.source);
        } catch (e) {
            errors.push(`${raw.name}: ${(e as Error).message}`);
            continue;
        }
        seen.add(raw.name);
        plugins.push({
            ...manifestFields(raw),
            name: raw.name,
            source,
            ...(str(raw.category) ? { category: str(raw.category) } : {}),
            ...(strList(raw.tags) ? { tags: strList(raw.tags) } : {}),
            ...(raw.strict === false ? { strict: false } : {}),
            raw: entryFields(raw),
        });
    }
    if (!Array.isArray(j.plugins)) errors.push(`"plugins" should be a list`);
    return {
        name: j.name,
        owner: author(j.owner),
        description: str(j.description) ?? str(metadata.description),
        pluginRoot: str(metadata.pluginRoot) ?? str(j.pluginRoot),
        plugins,
        errors,
    };
}

/** "./plugins/x" for display; "github:owner/repo", "npm:pkg@1.2" for the rest. */
export function describeSource(s: PluginSource): string {
    switch (s.source) {
        case "path":
            return s.path;
        case "github":
            return `github:${s.repo}${s.ref ? `#${s.ref}` : ""}`;
        case "git":
            return `${s.url}${s.ref ? `#${s.ref}` : ""}${s.path ? ` (${s.path})` : ""}`;
        case "npm":
            return `npm:${s.package}${s.version ? `@${s.version}` : ""}`;
    }
}
