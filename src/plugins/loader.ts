// Enabled plugins and what they add. A plugin's commands, agents and skills
// are folders the existing loaders also scan; its hooks and MCP servers are
// merged into settings by loadSettings, so every front end and backend that
// reads settings gets them.
//
// Which plugins are on: "enabledPlugins" from user < project < local
// settings, the later scope deciding each plugin. In a folder that isn't
// trusted only the user's own settings count. A plugin must also be
// installed (installed_plugins.json) to load.
//
// Parsed files are cached by mtime and size, so loading again with nothing
// changed costs a few stat calls per plugin.

import { existsSync, statSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import type { HookConfig, McpServerConfig, Settings, SettingsScope } from "../config/settings";
import type { LspServerConfig } from "../lsp/config";
import { paths } from "../config/paths";
import { normalizeHooks } from "../config/hook-config";
import { canonical, isInside } from "../util/files";
import { manifestFile, MANIFEST_DIRS, parsePluginManifest, type PluginManifest } from "./manifest";
import { cachedJson, readInstalled, splitId } from "./store";

export interface LoadedPlugin {
    /** name@marketplace */
    id: string;
    name: string;
    marketplace: string;
    version: string;
    root: string;
    manifest: PluginManifest;
    /** Folders (or single .md files) of slash commands, named "<plugin>:<file>". */
    commandPaths: string[];
    /** Folders (or single .md files) of sub-agents, named "<plugin>:<name>". */
    agentPaths: string[];
    /**
     * Skills, named "<plugin>:<skill>": folders whose children are <skill>/SKILL.md
     * (skills/ and manifest paths to such folders), and single skill folders a
     * manifest lists (holding SKILL.md themselves).
     */
    skillDirs: string[];
    skillFolders: string[];
    hooks: Partial<Record<string, HookConfig[]>>;
    mcpServers: Record<string, McpServerConfig>;
    /** Language servers by name (.lsp.json or the manifest's lspServers), plugin root substituted. Claude Code runs them itself (loading the plugin); elsewhere they join settings.lsp.servers. */
    lspServers: Record<string, unknown>;
    /** The configuration files read: manifests, and the hooks, MCP and language server files. */
    configFiles: string[];
    /** What couldn't be read; the rest of the plugin still loads. */
    errors: string[];
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Each layer's enabledPlugins, later layers deciding. */
export function mergeEnabled(layers: Pick<Settings, "enabledPlugins">[]): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const l of layers) {
        if (!record(l.enabledPlugins)) continue;
        for (const [id, on] of Object.entries(l.enabledPlugins)) if (typeof on === "boolean") Object.defineProperty(out, id, { value: on, enumerable: true, writable: true, configurable: true });
    }
    return out;
}

/** Settings files in the order they're merged; just the user's in a folder that isn't trusted. */
export function scopeFiles(cwd: string, trusted: boolean): { scope: SettingsScope; file: string }[] {
    const user = { scope: "user" as const, file: paths.userSettings() };
    if (!trusted) return [user];
    return [user, { scope: "project", file: paths.projectSettings(cwd) }, { scope: "local", file: paths.localSettings(cwd) }];
}

/** The plugins on for this folder, by the settings on disk now. */
export function loadPlugins(cwd: string, trusted: boolean): LoadedPlugin[] {
    return pluginsFor(mergeEnabled(scopeFiles(cwd, trusted).map((f) => cachedJson<Settings>(f.file) ?? {}))).plugins;
}

/** Installed plugins among `enabled`; ids that are on but not installed are `missing`. */
export function pluginsFor(enabled: Record<string, boolean>): { plugins: LoadedPlugin[]; missing: string[] } {
    const ids = Object.keys(enabled).filter((id) => enabled[id]);
    if (!ids.length) return { plugins: [], missing: [] };
    const installed = readInstalled();
    const plugins: LoadedPlugin[] = [];
    const missing: string[] = [];
    for (const id of ids.sort()) {
        const rec = Object.hasOwn(installed, id) ? installed[id] : undefined;
        const { name, marketplace } = splitId(id);
        if (!rec || !marketplace) {
            missing.push(id);
            continue;
        }
        plugins.push(readPlugin(rec.installPath, { id, name, marketplace, version: rec.version }));
    }
    return { plugins, missing };
}

type Stamp = string;
const cache = new Map<string, { files: string[]; stamp: Stamp; plugin: LoadedPlugin }>();

function stampOf(files: string[]): Stamp {
    return files
        .map((f) => {
            try {
                const s = statSync(f);
                return `${s.mtimeMs}:${s.size}`;
            } catch {
                return "-";
            }
        })
        .join("|");
}

export function clearPluginCache() {
    cache.clear();
}

/** Read one plugin folder (cached until one of the files it read changes). */
export function readPlugin(root: string, who: { id: string; name: string; marketplace: string; version: string }): LoadedPlugin {
    const key = `${root}\0${who.id}\0${who.version}`;
    const hit = cache.get(key);
    if (hit && stampOf(hit.files) === hit.stamp) return hit.plugin;
    const files = [root, ...MANIFEST_DIRS.map((d) => join(root, d, "plugin.json")), join(root, "hooks", "hooks.json"), join(root, ".mcp.json"), join(root, ".lsp.json")];
    const plugin = parsePlugin(root, who, files);
    cache.set(key, { files, stamp: stampOf(files), plugin });
    return plugin;
}

function parsePlugin(root: string, who: { id: string; name: string; marketplace: string; version: string }, files: string[]): LoadedPlugin {
    const errors: string[] = [];
    const base: LoadedPlugin = { ...who, root, manifest: { name: who.name }, commandPaths: [], agentPaths: [], skillDirs: [], skillFolders: [], hooks: {}, mcpServers: {}, lspServers: {}, configFiles: [], errors };
    try {
        if (!statSync(root).isDirectory()) throw new Error();
    } catch {
        errors.push(`its folder ${root} is missing; reinstall it with /plugin install ${who.id}`);
        return base;
    }
    const mf = manifestFile(root);
    if (mf) {
        const j = cachedJson<unknown>(mf, (m) => errors.push(m));
        try {
            if (j !== undefined) base.manifest = { ...parsePluginManifest(j, who.name), name: who.name };
        } catch (e) {
            errors.push(`${mf}: ${(e as Error).message}`);
        }
    }
    const m = base.manifest;
    const realRoot = canonical(root);
    /** A path from the manifest, if it stays inside the plugin. */
    const own = (p: string, what: string): string | undefined => {
        const abs = isAbsolute(p) ? p : resolve(root, p);
        if (isAbsolute(p) || !isInside(canonical(abs), realRoot)) {
            errors.push(`${what} path ${JSON.stringify(p)} is outside the plugin, so it's ignored`);
            return undefined;
        }
        return abs;
    };
    /** A default location, unless it's a link out of the plugin. */
    const fixed = (rel: string): string | undefined => {
        const abs = join(root, rel);
        if (!existsSync(abs) || isInside(canonical(abs), realRoot)) return abs;
        errors.push(`${rel} links outside the plugin, so it's ignored`);
        return undefined;
    };
    const readFixed = (rel: string) => {
        const f = fixed(rel);
        return f ? cachedJson<unknown>(f, (msg) => errors.push(msg)) : undefined;
    };
    /** Commands and agents are folders or single .md files; anything else in the manifest is reported and skipped. */
    const mdOrDir = (p: string, abs: string, what: string): string | undefined => {
        if (what === "skills" || abs.endsWith(".md")) return abs;
        try {
            if (!statSync(abs).isFile()) return abs;
        } catch {
            return abs; // missing: nothing to load
        }
        errors.push(`${what} path ${JSON.stringify(p)} isn't a folder or .md file, so it's ignored`);
        return undefined;
    };
    const paths = (def: string, extra: string[] | undefined, what: string) => [
        ...(fixed(def) ? [join(root, def)] : []),
        ...(extra ?? []).map((p) => {
            const abs = own(p, what);
            return abs && mdOrDir(p, abs, what);
        }).filter((p): p is string => !!p),
    ];
    base.commandPaths = [...new Set(paths("commands", m.commands, "commands"))];
    base.agentPaths = [...new Set(paths("agents", m.agents, "agents"))];
    for (const d of new Set(paths("skills", m.skills, "skills"))) (existsSync(join(d, "SKILL.md")) ? base.skillFolders : base.skillDirs).push(d);

    // Hooks: hooks/hooks.json, plus the manifest's (a file or inline).
    const hookSources: unknown[] = [];
    const defHooks = readFixed("hooks/hooks.json");
    if (defHooks !== undefined) hookSources.push(defHooks);
    if (typeof m.hooks === "string") {
        const f = own(m.hooks, "hooks");
        if (f && resolve(f) !== resolve(root, "hooks", "hooks.json")) {
            files.push(f);
            const j = cachedJson<unknown>(f, (msg) => errors.push(msg));
            if (j === undefined) errors.push(`hooks file ${m.hooks} is missing or empty`);
            else hookSources.push(j);
        }
    } else if (m.hooks) hookSources.push(m.hooks);
    for (const h of hookSources) addHooks(base, h);

    // MCP servers: .mcp.json, plus the manifest's (a file or inline).
    const mcpSources: unknown[] = [];
    const defMcp = readFixed(".mcp.json");
    if (defMcp !== undefined) mcpSources.push(defMcp);
    if (typeof m.mcpServers === "string") {
        const f = own(m.mcpServers, "mcpServers");
        if (f && resolve(f) !== resolve(root, ".mcp.json")) {
            files.push(f);
            const j = cachedJson<unknown>(f, (msg) => errors.push(msg));
            if (j === undefined) errors.push(`MCP file ${m.mcpServers} is missing or empty`);
            else mcpSources.push(j);
        }
    } else if (m.mcpServers) mcpSources.push(m.mcpServers);
    for (const s of mcpSources) addMcp(base, s);

    // Language servers: .lsp.json, plus the manifest's.
    const lspSources: unknown[] = [];
    const defLsp = readFixed(".lsp.json");
    if (defLsp !== undefined) lspSources.push(defLsp);
    if (typeof m.lspServers === "string") {
        const f = own(m.lspServers, "lspServers");
        if (f && resolve(f) !== resolve(root, ".lsp.json")) {
            files.push(f);
            const j = cachedJson<unknown>(f, (msg) => errors.push(msg));
            if (j !== undefined) lspSources.push(j);
        }
    } else if (m.lspServers) lspSources.push(m.lspServers);
    for (const s of lspSources) {
        const servers = record(s) && record(s.lspServers) ? s.lspServers : s;
        if (!record(servers)) continue;
        for (const [name, raw] of Object.entries(servers)) if (name !== "__proto__" && record(raw)) base.lspServers[name] = substitute(raw, root);
    }
    base.configFiles = files.slice(1).filter((f) => existsSync(f));
    return base;
}

/**
 * Hooks in either format: Cavvy's flat one ({ Event: [{ matcher, command }] })
 * or Claude Code's ({ hooks: { Event: [{ matcher, hooks: [{ type, command }] }] } }).
 * Hook commands run in a shell with CAVVY_PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT set.
 */
function addHooks(p: LoadedPlugin, j: unknown) {
    const events = record(j) && record(j.hooks) ? j.hooks : j;
    if (!record(events)) {
        p.errors.push("hooks must be an object of events");
        return;
    }
    // Every type Cavvy runs (src/config/hook-config.ts), each knowing its plugin and folder.
    const hooks = normalizeHooks(events, (msg) => p.errors.push(msg), { plugin: p.id, pluginRoot: p.root });
    for (const [event, list] of Object.entries(hooks ?? {})) if (list?.length) p.hooks[event] = [...(p.hooks[event] ?? []), ...list];
}

const ROOT_VARS = /\$\{(?:CAVVY|CLAUDE)_PLUGIN_ROOT\}/g;

function substitute(v: unknown, root: string): unknown {
    if (typeof v === "string") return v.replace(ROOT_VARS, () => root);
    if (Array.isArray(v)) return v.map((x) => substitute(x, root));
    if (record(v)) {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) if (k !== "__proto__") out[k] = substitute(x, root);
        return out;
    }
    return v;
}

/** The server name settings know it by. */
export const pluginServerName = (plugin: string, server: string) => `plugin:${plugin}:${server}`;

/** Picks the MCP servers of these plugins (by name); undefined for none. */
export function pluginServerMatch(plugins: string[] | undefined): ((server: string) => boolean) | undefined {
    if (!plugins?.length) return undefined;
    const prefixes = plugins.map((p) => pluginServerName(p, ""));
    return (server) => prefixes.some((pre) => server.startsWith(pre));
}

function addMcp(p: LoadedPlugin, j: unknown) {
    const servers = record(j) && record(j.mcpServers) ? j.mcpServers : j;
    if (!record(servers)) {
        p.errors.push("mcpServers must be an object of servers");
        return;
    }
    for (const [name, raw] of Object.entries(servers)) {
        if (name === "__proto__") continue;
        if (!record(raw) || (typeof raw.command !== "string" && typeof raw.url !== "string")) {
            p.errors.push(`MCP server "${name}" needs a "command" or a "url"`);
            continue;
        }
        const config = substitute(raw, p.root) as McpServerConfig;
        // Relative stdio servers run from the plugin's folder.
        if (typeof raw.command === "string" && config.cwd === undefined) config.cwd = p.root;
        config.plugin = p.id;
        p.mcpServers[pluginServerName(p.name, name)] = config;
    }
}

/**
 * Add the plugins' hooks, MCP servers and language servers to merged settings.
 * A plugin server never replaces one the user configured under the same name.
 */
export function applyPlugins(merged: Settings, plugins: LoadedPlugin[]) {
    for (const p of plugins) {
        for (const [event, list] of Object.entries(p.hooks)) {
            if (!list?.length) continue;
            const h = (merged.hooks ??= {}) as Record<string, HookConfig[]>;
            h[event] = [...(h[event] ?? []), ...list];
        }
        for (const [name, config] of Object.entries(p.mcpServers)) {
            merged.mcpServers ??= {};
            if (!Object.hasOwn(merged.mcpServers, name)) merged.mcpServers[name] = config;
        }
        // Named by the plugin's full id (two marketplaces can have a plugin of the same name), so it adds to
        // the built-ins rather than replacing one; `"lsp": false` keeps them off.
        const lsp = Object.entries(p.lspServers);
        if (lsp.length && merged.lsp !== false) {
            const base = merged.lsp ?? {};
            const servers: Record<string, LspServerConfig> = { ...base.servers };
            for (const [name, config] of lsp) if (!Object.hasOwn(servers, pluginServerName(p.id, name))) servers[pluginServerName(p.id, name)] = config as LspServerConfig;
            merged.lsp = { ...base, servers };
        }
    }
}
