// Installing, removing, enabling and updating plugins, and the listing every
// front end shows. A plugin is fetched once into the cache; scopes turn it
// on in settings ("enabledPlugins"):
//
//   user     ~/.cavvy/settings.json              every folder
//   project  <project>/.cavvy/settings.json      everyone working in the repo
//   local    <project>/.cavvy/settings.local.json  just you, in this repo

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { ensureDir } from "../config/paths";
import { readJsonForUpdate, settingsPath, updateSettings, writeJson, type Settings, type SettingsScope } from "../config/settings";
import { canonical, isInside } from "../util/files";
import { describeSource, manifestFile, parsePluginManifest, type MarketplaceEntry, type PluginManifest } from "./manifest";
import { cachedJson, pluginPaths, readInstalled, readKnownMarketplaces, sameScope, splitId, writeInstalled, type InstalledPlugin, type ScopeRecord } from "./store";
import { copyDir, fetchNpm, gitClone, githubUrl, pruneSymlinks, SourceError, swapIn, treeHash } from "./sources";
import { describeMarketplaceSource, forgetMarketplace, listMarketplaces, PluginError, unknownMarketplace, updateMarketplace, type LoadedMarketplace } from "./marketplaces";
import type { Counts, PluginInfo, PluginListing } from "./info";
import { clearPluginCache, mergeEnabled, readPlugin, scopeFiles } from "./loader";
import { claudeHooks, prepareForClaudeCode, writeClaudeManifest } from "./native";

export { PluginError };
export type { Counts, MarketplaceInfo, PluginInfo, PluginListing } from "./info";

export const SCOPES: SettingsScope[] = ["user", "project", "local"];

/** The marketplace entry `spec` (name or name@marketplace) names. */
export function findEntry(spec: string): { entry: MarketplaceEntry; marketplace: LoadedMarketplace } {
    const { name, marketplace } = splitId(spec.trim());
    if (!name) throw new PluginError("Give a plugin name, like formatter or formatter@my-marketplace.");
    const all = listMarketplaces();
    if (marketplace) {
        const m = all.find((x) => x.name === marketplace);
        if (!m) throw new PluginError(unknownMarketplace(marketplace));
        if (m.error) throw new PluginError(`Marketplace ${marketplace} can't be read: ${m.error}`);
        const entry = m.plugins.find((p) => p.name === name);
        if (!entry) throw new PluginError(`Marketplace ${marketplace} has no plugin "${name}".${m.plugins.length ? ` It has: ${m.plugins.map((p) => p.name).slice(0, 20).join(", ")}${m.plugins.length > 20 ? ", …" : ""}.` : ""}`);
        return { entry, marketplace: m };
    }
    const hits = all.flatMap((m) => m.plugins.filter((p) => p.name === name).map((entry) => ({ entry, marketplace: m })));
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) throw new PluginError(`"${name}" is in more than one marketplace. Say which: ${hits.map((h) => `${name}@${h.marketplace.name}`).join(", ")}.`);
    if (!all.length) throw new PluginError(`No marketplaces are added yet. Add one with /plugin marketplace add <owner/repo | git URL | folder>.`);
    throw new PluginError(`No marketplace has a plugin named "${name}". Browse them with /plugin.`);
}

/** Folder-safe form of a version. */
const versionDir = (v: string) => v.replace(/[^A-Za-z0-9._+-]/g, "_").replace(/^\.+$/, "_").slice(0, 80) || "_";


const mdCount = (p: string, depth = 0): number => {
    try {
        const st = statSync(p);
        if (st.isFile()) return p.endsWith(".md") ? 1 : 0;
        if (depth > 3) return 0;
        return readdirSync(p).reduce((n, f) => n + mdCount(join(p, f), depth + 1), 0);
    } catch {
        return 0;
    }
};
const skillCount = (d: string) => {
    try {
        return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(d, e.name, "SKILL.md"))).length;
    } catch {
        return 0;
    }
};

/** What an installed plugin folder contributes. */
export function countComponents(root: string, id: string, version = ""): Counts & { errors: string[] } {
    const { name, marketplace = "" } = splitId(id);
    const p = readPlugin(root, { id, name, marketplace, version });
    return {
        commands: p.commandPaths.reduce((n, d) => n + mdCount(d), 0),
        agents: p.agentPaths.reduce((n, d) => n + mdCount(d, 3), 0),
        skills: p.skillDirs.reduce((n, d) => n + skillCount(d), 0) + p.skillFolders.length,
        hooks: Object.values(p.hooks).reduce((n, l) => n + (l?.length ?? 0), 0),
        mcpServers: Object.keys(p.mcpServers).length,
        lspServers: Object.keys(p.lspServers).length,
        errors: p.errors,
    };
}

export const total = (c: Counts) => c.commands + c.agents + c.skills + c.hooks + c.mcpServers + c.lspServers;

/**
 * Fetch a marketplace entry's plugin into the cache. Returns its record (no
 * scopes yet). The entry's own manifest fields are saved with the copy, so
 * the plugin loads the same with or without its marketplace.
 */
export async function fetchPlugin(entry: MarketplaceEntry, m: LoadedMarketplace): Promise<Omit<InstalledPlugin, "scopes">> {
    const cacheDir = ensureDir(pluginPaths.cache());
    const staging = mkdtempSync(join(cacheDir, ".fetch-"));
    try {
        let dir: string;
        let sha: string | undefined;
        let fetchedVersion: string | undefined;
        const s = entry.source;
        if (s.source === "path") {
            if (!m.root) throw new PluginError(`${entry.name}'s source is a relative path, but marketplace ${m.name} was fetched as a single file, so there's nothing for it to point into.`);
            const src = resolve(m.root, s.path);
            // Inside the marketplace's own folder, wherever its pluginRoot points.
            if (!m.base || !isInside(canonical(src), canonical(m.base))) throw new PluginError(`${entry.name}'s source ${s.path} is outside its marketplace, so it isn't installed.`);
            dir = join(staging, "plugin");
            copyDir(src, dir);
        } else if (s.source === "github" || s.source === "git") {
            const repo = join(staging, "repo");
            sha = await gitClone(s.source === "github" ? githubUrl(s.repo) : s.url, repo, { ref: s.ref, sha: s.sha });
            rmSync(join(repo, ".git"), { recursive: true, force: true });
            dir = repo;
            if (s.source === "git" && s.path) {
                dir = resolve(repo, s.path);
                if (!isInside(canonical(dir), canonical(repo)) || !existsSync(dir)) throw new PluginError(`${entry.name}'s path ${s.path} isn't a folder in ${s.url}.`);
                dir = canonical(dir);
            }
        } else {
            const r = await fetchNpm(s.package, s.version, join(staging, "npm"), s.registry);
            dir = r.dir;
            fetchedVersion = r.version;
        }
        // Links that leave the plugin go before anything is read or written through them.
        pruneSymlinks(dir);
        // The plugin's manifest, with the marketplace entry's fields: the entry fills gaps, or is the whole manifest (strict: false).
        let own: PluginManifest | undefined;
        const mf = manifestFile(dir);
        let ownRaw: Record<string, unknown> = {};
        if (mf && entry.strict !== false) {
            let err: string | undefined;
            const j = cachedJson<unknown>(mf, (x) => (err = x));
            if (j === undefined) throw new PluginError(`${entry.name}: ${err ?? "its plugin.json is empty"}`);
            if (typeof j === "object" && j !== null && !Array.isArray(j)) ownRaw = structuredClone(j) as Record<string, unknown>;
            try {
                own = parsePluginManifest(j, entry.name);
            } catch (e) {
                throw new PluginError(`${entry.name}: ${(e as Error).message}`);
            }
        }
        const { source: _s, strict: _st, category: _c, tags: _t, raw: entryRaw, ...fields } = entry;
        const manifest: PluginManifest = { ...fields, ...own, name: entry.name };
        // No version given: the commit it came from (its own repository's, or its marketplace's), else "local".
        const commit = sha ?? (s.source === "path" ? m.known.gitCommitSha : undefined);
        const version = own?.version ?? entry.version ?? fetchedVersion ?? (commit ? commit.slice(0, 12) : "local");
        manifest.version ??= version;
        // A real folder and a fresh file: never written through a link (pruneSymlinks kept only links inside the plugin).
        const ownDir = join(dir, ".cavvy-plugin");
        if (existsSync(ownDir) && !lstatSync(ownDir).isDirectory()) rmSync(ownDir, { recursive: true, force: true });
        rmSync(join(ownDir, "plugin.json"), { force: true });
        writeJson(join(ownDir, "plugin.json"), manifest);
        // Claude Code loads the plugin from this folder too (src/plugins/native.ts): the same merge, keeping the fields only it reads.
        const native: Record<string, unknown> = { ...entryRaw, ...fields, ...ownRaw, name: entry.name, version: manifest.version };
        // Inline hooks in Claude Code's format (it refuses Cavvy's flat one).
        if (native.hooks !== undefined && typeof native.hooks !== "string") native.hooks = (claudeHooks(native.hooks) as { hooks?: unknown }).hooks ?? native.hooks;
        writeClaudeManifest(dir, native);
        clearPluginCache();
        prepareForClaudeCode(readPlugin(dir, { id: `${entry.name}@${m.name}`, name: entry.name, marketplace: m.name, version: manifest.version ?? version }));
        const id = `${entry.name}@${m.name}`;
        clearPluginCache();
        const counts = countComponents(dir, id, version);
        if (!total(counts)) throw new PluginError(`${entry.name} has no commands, agents, skills, hooks, MCP or language servers${counts.errors.length ? ` (${counts.errors[0]})` : ""}.`);
        const dest = join(cacheDir, m.name, entry.name, versionDir(version));
        mkdirSync(dirname(dest), { recursive: true });
        swapIn(dir, dest);
        const at = new Date().toISOString();
        return { version, installPath: dest, installedAt: at, lastUpdated: at, ...(commit ? { gitCommitSha: commit } : {}) };
    } catch (e) {
        throw e instanceof SourceError ? new PluginError(`Couldn't fetch ${entry.name} from ${describeSource(entry.source)}: ${e.message}`) : e;
    } finally {
        rmSync(staging, { recursive: true, force: true });
        clearPluginCache();
    }
}

function scopeRecord(scope: SettingsScope, cwd: string): ScopeRecord {
    return scope === "user" ? { scope } : { scope, projectPath: resolve(cwd) };
}

/** Throw before fetching anything if the scope's settings file can't be updated. */
function checkWritable(scope: SettingsScope, cwd: string) {
    readJsonForUpdate<Settings>(settingsPath(scope, cwd));
}

function setEnabled(scope: SettingsScope, cwd: string, id: string, on: boolean | undefined) {
    updateSettings(scope, cwd, (s) => {
        const e = (s.enabledPlugins && typeof s.enabledPlugins === "object" ? s.enabledPlugins : {}) as Record<string, boolean>;
        if (on === undefined) delete e[id];
        else e[id] = on;
        if (Object.keys(e).length) s.enabledPlugins = e;
        else delete s.enabledPlugins;
    });
}

export interface InstallResult {
    id: string;
    version: string;
    /** Already in the cache: only turned on at this scope. */
    reused: boolean;
    counts: Counts;
    errors: string[];
}

/** Install `spec` (name or name@marketplace) and turn it on at `scope`. */
export async function installPlugin(spec: string, scope: SettingsScope, cwd: string): Promise<InstallResult> {
    const { entry, marketplace } = findEntry(spec);
    const id = `${entry.name}@${marketplace.name}`;
    checkWritable(scope, cwd);
    let rec = readInstalled()[id];
    const reused = !!rec && existsSync(rec.installPath);
    if (!reused) {
        const fetched = await fetchPlugin(entry, marketplace);
        rec = { ...fetched, scopes: rec?.scopes ?? [] };
    }
    const r = rec!;
    const sr = scopeRecord(scope, cwd);
    if (!r.scopes.some((x) => sameScope(x, sr))) r.scopes.push(sr);
    const installed = readInstalled();
    installed[id] = r;
    writeInstalled(installed);
    setEnabled(scope, cwd, id, true);
    const { errors, ...counts } = countComponents(r.installPath, id, r.version);
    return { id, version: r.version, reused, counts, errors };
}

/** The installed id `spec` names: an exact id, or a name only one installed plugin has. */
export function resolveInstalled(spec: string, cwd?: string, trusted = true): string {
    const s = spec.trim();
    const installed = readInstalled();
    if (Object.hasOwn(installed, s)) return s;
    // Also ids that are only turned on in settings (a teammate's project), so they can be disabled.
    const enabled = cwd ? Object.keys(mergeEnabled(scopeFiles(cwd, trusted).map((f) => cachedJson<Settings>(f.file) ?? {}))) : [];
    const ids = [...new Set([...Object.keys(installed), ...enabled])];
    if (ids.includes(s)) return s;
    const { name, marketplace } = splitId(s);
    if (marketplace) throw new PluginError(`${s} isn't installed.`);
    const hits = ids.filter((id) => splitId(id).name === name);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) throw new PluginError(`More than one installed plugin is called ${name}: ${hits.join(", ")}. Say which.`);
    throw new PluginError(`No installed plugin is called ${name}.${ids.length ? ` Installed: ${ids.join(", ")}.` : ""}`);
}

/** Which scopes turn `id` on or off for this folder, from the settings files on disk. */
export function scopeStates(id: string, cwd: string, trusted: boolean): Partial<Record<SettingsScope, boolean>> {
    const out: Partial<Record<SettingsScope, boolean>> = {};
    for (const f of scopeFiles(cwd, trusted)) {
        const e = cachedJson<Settings>(f.file)?.enabledPlugins;
        if (e && typeof e === "object" && Object.hasOwn(e, id) && typeof e[id] === "boolean") out[f.scope] = e[id];
    }
    return out;
}

/** Turn an installed plugin on or off at a scope (default: where it's set now, the narrowest first; else user). */
export function enablePlugin(spec: string, on: boolean, cwd: string, trusted: boolean, scope?: SettingsScope): { id: string; scope: SettingsScope } {
    const id = resolveInstalled(spec, cwd, trusted);
    if (on && !Object.hasOwn(readInstalled(), id)) throw new PluginError(`${id} is turned on in settings but isn't installed. Install it with /plugin install ${id}.`);
    const states = scopeStates(id, cwd, trusted);
    const target = scope ?? (["local", "project", "user"] as const).find((s) => states[s] !== undefined) ?? "user";
    if ((target === "project" || target === "local") && !trusted) throw new PluginError(`This folder isn't trusted, so its ${target} settings don't load. Trust it first, or use --scope user.`);
    setEnabled(target, cwd, id, on);
    if (on) {
        const installed = readInstalled();
        const r = installed[id]!;
        const sr = scopeRecord(target, cwd);
        if (!r.scopes.some((x) => sameScope(x, sr))) {
            r.scopes.push(sr);
            writeInstalled(installed);
        }
    }
    return { id, scope: target };
}

/**
 * Remove a plugin from a scope, or from every scope of this folder when none
 * is given. Its files go once no scope this Cavvy knows of uses it.
 */
export function uninstallPlugin(spec: string, cwd: string, trusted: boolean, scope?: SettingsScope): { id: string; scopes: SettingsScope[]; removed: boolean } {
    if ((scope === "project" || scope === "local") && !trusted) throw new PluginError(`This folder isn't trusted, so its ${scope} settings don't load. Trust it first, or use --scope user.`);
    const id = resolveInstalled(spec, cwd, trusted);
    const states = scopeStates(id, cwd, trusted);
    const targets = scope ? [scope] : SCOPES.filter((s) => states[s] !== undefined);
    if (!scope && !targets.length) targets.push("user");
    for (const t of targets) if (t === "user" || states[t] !== undefined) setEnabled(t, cwd, id, undefined);
    const installed = readInstalled();
    const r = Object.hasOwn(installed, id) ? installed[id] : undefined;
    let removed = false;
    if (r) {
        r.scopes = r.scopes.filter((x) => !targets.some((t) => sameScope(x, scopeRecord(t, cwd))));
        if (!r.scopes.length) {
            delete installed[id];
            removeFiles(r.installPath);
            removed = true;
        }
        writeInstalled(installed);
    }
    return { id, scopes: targets, removed };
}

/** Delete an installed copy, only ever inside the plugin cache. */
function removeFiles(dir: string) {
    if (!isInside(resolve(dir), pluginPaths.cache()) || resolve(dir) === resolve(pluginPaths.cache())) return;
    rmSync(dir, { recursive: true, force: true });
    // And the <marketplace>/<plugin> folders it leaves empty.
    for (let d = dirname(resolve(dir)); isInside(d, pluginPaths.cache()) && d !== resolve(pluginPaths.cache()); d = dirname(d)) {
        try {
            if (readdirSync(d).length) break;
            rmSync(d, { recursive: true });
        } catch {
            break;
        }
    }
    clearPluginCache();
}

export interface UpdateResult {
    id: string;
    from: string;
    to: string;
    changed: boolean;
    /** The installed files changed (whatever the version says): its running servers need restarting. */
    filesChanged?: boolean;
    error?: string;
}

/** Fetch a plugin again from its marketplace (refreshed first) and keep its scopes. */
export async function updatePlugin(spec: string, cwd: string, trusted: boolean, refreshed = new Set<string>()): Promise<UpdateResult> {
    const id = resolveInstalled(spec, cwd, trusted);
    const { name, marketplace } = splitId(id);
    const before = readInstalled()[id];
    if (!before) throw new PluginError(`${id} isn't installed.`);
    if (marketplace && !refreshed.has(marketplace)) {
        refreshed.add(marketplace);
        const k = readKnownMarketplaces()[marketplace];
        if (k && k.source.source !== "directory" && k.source.source !== "file") await updateMarketplace(marketplace);
    }
    const { entry, marketplace: m } = findEntry(`${name}@${marketplace}`);
    // Taken before the fetch, which replaces the folder in place when the version is the same.
    const oldHash = treeHash(before.installPath);
    const fetched = await fetchPlugin(entry, m);
    const installed = readInstalled();
    const cur = installed[id] ?? before;
    installed[id] = { ...fetched, installedAt: cur.installedAt, scopes: cur.scopes };
    writeInstalled(installed);
    if (resolve(cur.installPath) !== resolve(fetched.installPath)) removeFiles(cur.installPath);
    const filesChanged = oldHash !== treeHash(fetched.installPath);
    return { id, from: cur.version, to: fetched.version, changed: filesChanged || cur.version !== fetched.version || cur.gitCommitSha !== fetched.gitCommitSha, filesChanged };
}

/** Update every installed plugin; one failing doesn't stop the rest. */
export async function updateAll(cwd: string, trusted: boolean): Promise<UpdateResult[]> {
    const refreshed = new Set<string>();
    const out: UpdateResult[] = [];
    for (const id of Object.keys(readInstalled()).sort()) {
        try {
            out.push(await updatePlugin(id, cwd, trusted, refreshed));
        } catch (e) {
            const v = readInstalled()[id]?.version ?? "?";
            out.push({ id, from: v, to: v, changed: false, error: (e as Error).message });
        }
    }
    return out;
}

/** Remove a marketplace and every plugin installed from it. */
export function removeMarketplace(name: string, cwd: string): { uninstalled: string[] } {
    if (!Object.hasOwn(readKnownMarketplaces(), name)) throw new PluginError(unknownMarketplace(name));
    const uninstalled: string[] = [];
    const installed = readInstalled();
    for (const id of Object.keys(installed)) {
        if (splitId(id).marketplace !== name) continue;
        // Its settings entries for you and in this folder, and its files. Other folders' settings (often committed
        // and shared) are left as they are: an entry for a plugin that isn't installed loads nothing.
        for (const sr of installed[id]!.scopes) {
            try {
                if (sr.scope === "user") setEnabled("user", cwd, id, undefined);
                else if (sr.projectPath && existsSync(sr.projectPath) && resolve(sr.projectPath) === resolve(cwd)) setEnabled(sr.scope, cwd, id, undefined);
            } catch {
                // a broken settings file elsewhere doesn't stop the removal
            }
        }
        delete installed[id];
        removeFiles(join(pluginPaths.cache(), name, splitId(id).name));
        uninstalled.push(id);
    }
    writeInstalled(installed);
    forgetMarketplace(name);
    return { uninstalled };
}

// ---------------------------------------------------------------------------
// The listing every front end shows.




export function listPlugins(cwd: string, trusted: boolean): PluginListing {
    const markets = listMarketplaces();
    const installed = readInstalled();
    const enabled = mergeEnabled(scopeFiles(cwd, trusted).map((f) => cachedJson<Settings>(f.file) ?? {}));
    const byId = new Map<string, PluginInfo>();
    const base = (id: string): PluginInfo => {
        const { name, marketplace = "" } = splitId(id);
        return { id, name, marketplace, enabled: enabled[id] === true, scopes: scopeStates(id, cwd, trusted), errors: [] };
    };
    for (const m of markets) {
        for (const e of m.plugins) {
            const id = `${e.name}@${m.name}`;
            byId.set(id, { ...base(id), description: e.description, version: e.version, author: e.author?.name, category: e.category, homepage: e.homepage, source: describeSource(e.source) });
        }
    }
    for (const [id, r] of Object.entries(installed)) {
        const info = byId.get(id) ?? { ...base(id), orphaned: true };
        const { errors, ...counts } = countComponents(r.installPath, id, r.version);
        const man = readPlugin(r.installPath, { id, name: info.name, marketplace: info.marketplace, version: r.version }).manifest;
        info.description ??= man.description;
        info.author ??= man.author?.name;
        info.installed = { version: r.version, installedAt: r.installedAt, lastUpdated: r.lastUpdated, counts };
        info.errors.push(...errors);
        byId.set(id, info);
    }
    for (const id of Object.keys(enabled)) if (enabled[id] && !Object.hasOwn(installed, id)) byId.set(id, { ...(byId.get(id) ?? base(id)), missing: true });
    return {
        marketplaces: markets.map((m) => ({
            name: m.name,
            source: describeMarketplaceSource(m.known.source),
            kind: m.known.source.source,
            description: m.description,
            owner: m.owner?.name,
            plugins: m.plugins.length,
            lastUpdated: m.known.lastUpdated,
            error: m.error,
            warnings: m.errors,
        })),
        plugins: [...byId.values()].sort((a, b) => Number(!!b.installed) - Number(!!a.installed) || a.name.localeCompare(b.name) || a.marketplace.localeCompare(b.marketplace)),
    };
}
