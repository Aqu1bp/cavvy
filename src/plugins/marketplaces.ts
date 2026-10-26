// Marketplaces: catalogs of plugins, added by source and refreshed on demand.
//
//   owner/repo[#ref]                 a GitHub repository
//   https://…/x.git, git@host:x.git  any git repository (#ref for a branch or tag)
//   ./path/to/folder                 a folder on disk, read in place
//   ./path/to/marketplace.json       a marketplace file on disk, read in place
//   https://…/marketplace.json       a file fetched over https

import { existsSync, mkdtempSync, rmSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { ensureDir } from "../config/paths";
import { writeJson } from "../config/settings";
import { canonical, expandPath, isInside } from "../util/files";
import { MANIFEST_DIRS, marketplaceFile, nameError, parseMarketplace, validName, type Marketplace } from "./manifest";
import { fetchJson, gitClone, githubUrl, SourceError, swapIn } from "./sources";
import { cachedJson, pluginPaths, readKnownMarketplaces, writeKnownMarketplaces, type KnownMarketplace, type MarketplaceSource } from "./store";

export class PluginError extends Error {}

/** What a source string the user typed means. */
export function parseMarketplaceSource(input: string, cwd: string): MarketplaceSource {
    const s = input.trim();
    if (!s) throw new PluginError("Give a marketplace source: owner/repo, a git URL, a folder, or a marketplace.json path or URL.");
    const [base, ref] = s.split(/#(?=[^#]*$)/) as [string, string | undefined];
    if (ref !== undefined && (!ref || ref.startsWith("-") || /\s/.test(ref))) throw new PluginError(`"#${ref}" isn't a branch or tag`);
    if (/^https?:\/\//i.test(s) && /\.json(\?.*)?$/i.test(base)) return { source: "url", url: s };
    if (/^(https?|ssh|git|file):\/\//i.test(base) || /^[\w.-]+@[\w.-]+:/.test(base) || base.endsWith(".git")) {
        if (/^(https?|ssh|git|file):\/\//i.test(base) || /^[\w.-]+@[\w.-]+:/.test(base) || !existsSync(expandPath(base, cwd))) return { source: "git", url: base, ...(ref ? { ref } : {}) };
    }
    const local = expandPath(s, cwd);
    if (s.startsWith(".") || s.startsWith("/") || s.startsWith("~") || existsSync(local)) {
        let st;
        try {
            st = statSync(local);
        } catch {
            throw new PluginError(`${s} doesn't exist`);
        }
        return st.isDirectory() ? { source: "directory", path: local } : { source: "file", path: local };
    }
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(base)) return { source: "github", repo: base, ...(ref ? { ref } : {}) };
    throw new PluginError(`"${s}" isn't a marketplace source: use owner/repo, a git URL, a folder, or a marketplace.json path or URL.`);
}

export function describeMarketplaceSource(s: MarketplaceSource): string {
    switch (s.source) {
        case "github":
            return `${s.repo}${s.ref ? `#${s.ref}` : ""}`;
        case "git":
            return `${s.url}${s.ref ? `#${s.ref}` : ""}`;
        case "directory":
        case "file":
            return s.path;
        case "url":
            return s.url;
    }
}

/** The folder a marketplace file's relative plugin paths start from: the one holding .claude-plugin/, or the file's own. */
function fileRoot(file: string): string {
    const d = dirname(file);
    return (MANIFEST_DIRS as readonly string[]).includes(basename(d)) ? dirname(d) : d;
}

export interface LoadedMarketplace extends Marketplace {
    known: KnownMarketplace;
    /** The marketplace's own folder: relative plugin sources must stay inside it, wherever pluginRoot points. */
    base?: string;
    /** Where relative plugin sources start; undefined for a marketplace fetched as a lone file. */
    root?: string;
    /** Set when the catalog couldn't be read at all. */
    error?: string;
}

/** A marketplace's catalog as it is on disk now. */
export function readMarketplace(name: string, known: KnownMarketplace): LoadedMarketplace {
    const src = known.source;
    const file = src.source === "file" ? src.path : marketplaceFile(known.installLocation);
    const root = src.source === "url" ? undefined : src.source === "file" ? fileRoot(src.path) : known.installLocation;
    const empty: LoadedMarketplace = { name, plugins: [], errors: [], known, root };
    if (!file || !existsSync(file)) return { ...empty, error: `its marketplace.json is missing from ${known.installLocation}; run /plugin marketplace update ${name}` };
    let err: string | undefined;
    const j = cachedJson<unknown>(file, (m) => (err = m));
    if (j === undefined) return { ...empty, error: err ?? `${file} is empty` };
    try {
        const m = parseMarketplace(j);
        const pluginRoot = root && m.pluginRoot ? resolve(root, m.pluginRoot) : root;
        if (root && pluginRoot && !isInside(canonical(pluginRoot), canonical(root))) return { ...m, name, known, base: root, root, errors: [...m.errors, `pluginRoot ${m.pluginRoot} is outside the marketplace, so it's ignored`] };
        return { ...m, name, known, base: root, root: pluginRoot };
    } catch (e) {
        return { ...empty, error: `${file}: ${(e as Error).message}` };
    }
}

export function listMarketplaces(): LoadedMarketplace[] {
    return Object.entries(readKnownMarketplaces())
        .map(([name, k]) => readMarketplace(name, k))
        .sort((a, b) => a.name.localeCompare(b.name));
}

const now = () => new Date().toISOString();

/** Fetch a git or URL marketplace into a fresh folder. Returns the folder and the catalog it holds. */
async function fetchMarketplace(src: MarketplaceSource): Promise<{ dir: string; marketplace: Marketplace; sha?: string }> {
    ensureDir(pluginPaths.marketplaces());
    const dir = mkdtempSync(join(pluginPaths.marketplaces(), ".fetch-"));
    try {
        if (src.source === "url") {
            const j = await fetchJson(src.url);
            const m = parseMarketplace(j);
            writeJson(join(dir, ".cavvy-plugin", "marketplace.json"), j);
            return { dir, marketplace: m };
        }
        if (src.source !== "github" && src.source !== "git") throw new PluginError("not a remote marketplace");
        const repo = join(dir, "repo");
        const sha = await gitClone(src.source === "github" ? githubUrl(src.repo) : src.url, repo, { ref: src.ref });
        const f = marketplaceFile(repo);
        if (!f) throw new PluginError(`${describeMarketplaceSource(src)} has no .claude-plugin/marketplace.json or .cavvy-plugin/marketplace.json`);
        rmSync(join(repo, ".git"), { recursive: true, force: true });
        return { dir: repo, marketplace: parseMarketplace(cachedJson(f)), sha };
    } catch (e) {
        rmSync(dir, { recursive: true, force: true });
        throw e instanceof SourceError || e instanceof PluginError ? new PluginError(e.message) : new PluginError(`${describeMarketplaceSource(src)}: ${(e as Error).message}`);
    }
}

/** Swap a fetched folder into marketplaces/<name>, replacing what was there. */
function place(fetched: string, name: string): string {
    const dest = join(pluginPaths.marketplaces(), name);
    swapIn(fetched, dest);
    // The temporary folder mkdtemp made, around a git checkout.
    const parent = dirname(fetched);
    if (basename(parent).startsWith(".fetch-")) rmSync(parent, { recursive: true, force: true });
    return dest;
}

/** Add a marketplace. Adding the same source again refreshes it. */
export async function addMarketplace(input: string, cwd: string): Promise<LoadedMarketplace> {
    const src = parseMarketplaceSource(input, cwd);
    const known = readKnownMarketplaces();
    let name: string;
    let location: string;
    let sha: string | undefined;
    if (src.source === "directory" || src.source === "file") {
        const file = src.source === "file" ? src.path : marketplaceFile(src.path);
        if (!file) throw new PluginError(`${src.path} has no .claude-plugin/marketplace.json or .cavvy-plugin/marketplace.json`);
        let err: string | undefined;
        const j = cachedJson<unknown>(file, (m) => (err = m));
        if (j === undefined) throw new PluginError(err ?? `${file} is empty`);
        try {
            name = parseMarketplace(j).name;
        } catch (e) {
            throw new PluginError(`${file}: ${(e as Error).message}`);
        }
        location = src.source === "file" ? fileRoot(src.path) : src.path;
        clash(known, name, src);
    } else {
        const { dir, marketplace, sha: at } = await fetchMarketplace(src);
        name = marketplace.name;
        sha = at;
        try {
            clash(known, name, src);
        } catch (e) {
            rmSync(basename(dirname(dir)).startsWith(".fetch-") ? dirname(dir) : dir, { recursive: true, force: true });
            throw e;
        }
        location = place(dir, name);
    }
    known[name] = { source: src, installLocation: location, lastUpdated: now(), ...(sha ? { gitCommitSha: sha } : {}) };
    writeKnownMarketplaces(known);
    return readMarketplace(name, known[name]!);
}

/** A different marketplace already has this name. */
function clash(known: Record<string, KnownMarketplace>, name: string, src: MarketplaceSource) {
    if (!validName(name)) throw new PluginError(nameError("marketplace", name));
    const k = Object.hasOwn(known, name) ? known[name] : undefined;
    if (k && JSON.stringify(k.source) !== JSON.stringify(src)) throw new PluginError(`A marketplace named "${name}" is already added (from ${describeMarketplaceSource(k.source)}). Remove it first with /plugin marketplace remove ${name}.`);
}

/** Fetch a marketplace again (a folder on disk is just re-read). */
export async function updateMarketplace(name: string): Promise<LoadedMarketplace> {
    const known = readKnownMarketplaces();
    const k = Object.hasOwn(known, name) ? known[name] : undefined;
    if (!k) throw new PluginError(unknownMarketplace(name));
    if (k.source.source !== "directory" && k.source.source !== "file") {
        const { dir, marketplace, sha } = await fetchMarketplace(k.source);
        if (marketplace.name !== name) {
            rmSync(basename(dirname(dir)).startsWith(".fetch-") ? dirname(dir) : dir, { recursive: true, force: true });
            throw new PluginError(`${describeMarketplaceSource(k.source)} now calls itself "${marketplace.name}", not "${name}". Remove it and add it again.`);
        }
        k.installLocation = place(dir, name);
        if (sha) k.gitCommitSha = sha;
    }
    k.lastUpdated = now();
    writeKnownMarketplaces(known);
    const m = readMarketplace(name, k);
    if (m.error) throw new PluginError(m.error);
    return m;
}

/** Forget a marketplace, deleting what was fetched for it (never a folder it only read). */
export function forgetMarketplace(name: string) {
    const known = readKnownMarketplaces();
    const k = Object.hasOwn(known, name) ? known[name] : undefined;
    if (!k) throw new PluginError(unknownMarketplace(name));
    delete known[name];
    writeKnownMarketplaces(known);
    const fetched = join(pluginPaths.marketplaces(), name);
    if (resolve(k.installLocation) === resolve(fetched)) rmSync(fetched, { recursive: true, force: true });
}

export function unknownMarketplace(name: string): string {
    const names = Object.keys(readKnownMarketplaces());
    return `No marketplace named "${name}".${names.length ? ` Added: ${names.join(", ")}.` : " Add one with /plugin marketplace add <source>."}`;
}
