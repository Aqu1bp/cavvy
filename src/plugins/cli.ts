// `harness plugin …` and `/plugin …`: one parser and one set of messages for
// both. The TUI's bare /plugin opens a browser instead (src/commands/plugins.ts).

import { existsSync, statSync } from "fs";
import { basename, resolve } from "path";
import type { SettingsScope } from "../config/settings";
import { canonical, expandPath, isInside } from "../util/files";
import { manifestFile, marketplaceFile, parseMarketplace, parsePluginManifest } from "./manifest";
import { addMarketplace, updateMarketplace } from "./marketplaces";
import { countComponents, total, enablePlugin, installPlugin, listPlugins, PluginError, removeMarketplace, SCOPES, uninstallPlugin, updateAll, updatePlugin, type Counts, type PluginInfo } from "./install";
import { cachedJson, readKnownMarketplaces, splitId } from "./store";

export interface Style {
    bold: (s: string) => string;
    muted: (s: string) => string;
    success: (s: string) => string;
    warning: (s: string) => string;
    error: (s: string) => string;
}

const plain: Style = { bold: (s) => s, muted: (s) => s, success: (s) => s, warning: (s) => s, error: (s) => s };

export interface PluginCliResult {
    lines: string[];
    /** Something changed: settings, commands and servers need reloading. */
    changed: boolean;
    /** Plugins (by name) whose files an update changed: restart their MCP servers, which a reload alone keeps running when their configuration reads the same. */
    restart?: string[];
    ok: boolean;
}

export const PLUGIN_USAGE = [
    "plugin                                   browse, install and manage plugins (in the terminal UI)",
    "plugin list                              installed plugins and where they're on",
    "plugin install <name>[@marketplace] [--scope user|project|local]",
    "plugin uninstall <name> [--scope …]      (no --scope: every scope in this folder)",
    "plugin enable|disable <name> [--scope …]",
    "plugin update [<name>|--all]",
    "plugin validate <path>                   check a plugin or marketplace folder",
    "plugin marketplace add <owner/repo | git URL | folder | marketplace.json path or URL>",
    "plugin marketplace list | update [name] | remove <name>",
];

export function countsText(c: Counts): string {
    const parts: string[] = [];
    const add = (n: number, one: string, many = `${one}s`) => n && parts.push(`${n} ${n === 1 ? one : many}`);
    add(c.commands, "command");
    add(c.agents, "agent");
    // Counted, but not loaded until the native skills and LSP support read them.
    add(c.skills, "skill");
    add(c.hooks, "hook");
    add(c.mcpServers, "MCP server");
    add(c.lspServers, "language server");
    const pending = c.lspServers ? " (language servers run on Claude Code only)" : "";
    return (parts.join(", ") || "nothing") + pending;
}

/** "on (user), off (local)" for the scopes that set it. */
export function scopesText(p: Pick<PluginInfo, "scopes">): string {
    return SCOPES.filter((s) => p.scopes[s] !== undefined)
        .map((s) => `${p.scopes[s] ? "on" : "off"} (${s})`)
        .join(", ");
}

function takeScope(args: string[]): SettingsScope | undefined {
    const i = args.findIndex((a) => a === "--scope" || a === "-s" || a.startsWith("--scope="));
    if (i < 0) return undefined;
    const v = args[i]!.includes("=") ? args[i]!.split("=")[1] : args[i + 1];
    args.splice(i, args[i]!.includes("=") ? 1 : 2);
    if (v !== "user" && v !== "project" && v !== "local") throw new PluginError(`--scope must be user, project or local${v ? `, not "${v}"` : ""}.`);
    return v;
}

export async function runPluginCli(argv: string[], cwd: string, trusted: boolean, st: Style = plain, progress?: (msg: string) => void): Promise<PluginCliResult> {
    const lines: string[] = [];
    const out = (s = "") => lines.push(s);
    const done = (changed: boolean, ok = true): PluginCliResult => ({ lines, changed, ok });
    const args = [...argv];
    const sub = (args.shift() ?? "list").toLowerCase();
    try {
        switch (sub) {
            case "list":
            case "ls": {
                const l = listPlugins(cwd, trusted);
                const mine = l.plugins.filter((p) => p.installed || p.missing);
                if (!mine.length) {
                    out(st.muted(l.marketplaces.length ? `No plugins installed. ${l.plugins.length} available: browse with /plugin, or harness plugin install <name>.` : "No plugins installed, and no marketplaces added. Add one with: harness plugin marketplace add <owner/repo | git URL | folder>"));
                    return done(false);
                }
                for (const p of mine) {
                    const state = p.missing ? st.warning("not installed") : p.enabled ? st.success("on") : st.muted("off");
                    out(`${st.bold(p.id)}${p.installed ? st.muted(` v${p.installed.version}`) : ""}  ${state}${scopesText(p) ? st.muted(`  · ${scopesText(p)}`) : ""}`);
                    if (p.installed) out(st.muted(`  ${countsText(p.installed.counts)}${p.description ? ` · ${p.description.length > 90 ? `${p.description.slice(0, 89)}…` : p.description}` : ""}`));
                    if (p.missing) out(st.muted(`  turned on in settings; install it with: harness plugin install ${p.id}`));
                    if (p.orphaned) out(st.muted("  no longer listed by its marketplace"));
                    for (const e of p.errors) out(st.warning(`  ${e}`));
                }
                return done(false);
            }
            case "install":
            case "i":
            case "add": {
                const scope = takeScope(args) ?? "user";
                const spec = args[0];
                if (!spec) throw new PluginError("Usage: plugin install <name>[@marketplace] [--scope user|project|local]");
                if (scope !== "user" && !trusted) throw new PluginError(`This folder isn't trusted, so its ${scope} settings don't load. Trust it first, or install with --scope user.`);
                progress?.(`Installing ${spec}…`);
                const r = await installPlugin(spec, scope, cwd);
                out(st.success(`✔ ${r.reused ? "Turned on" : "Installed"} ${st.bold(r.id)} v${r.version} (${scope} scope)`));
                out(st.muted(`  ${countsText(r.counts)}`));
                for (const e of r.errors) out(st.warning(`  ${e}`));
                if (r.counts.hooks || r.counts.mcpServers) out(st.muted("  Its hooks and MCP servers run commands on this computer."));
                return done(true);
            }
            case "uninstall":
            case "remove":
            case "rm": {
                const scope = takeScope(args);
                if (!args[0]) throw new PluginError("Usage: plugin uninstall <name> [--scope user|project|local]");
                const r = uninstallPlugin(args[0], cwd, trusted, scope);
                out(st.success(`✔ ${r.removed ? "Uninstalled" : "Removed"} ${st.bold(r.id)} from ${r.scopes.join(", ")} scope${r.scopes.length === 1 ? "" : "s"}`));
                if (!r.removed) out(st.muted("  Its files stay: another scope or project still uses it."));
                return done(true);
            }
            case "enable":
            case "disable": {
                const scope = takeScope(args);
                if (!args[0]) throw new PluginError(`Usage: plugin ${sub} <name> [--scope user|project|local]`);
                const r = enablePlugin(args[0], sub === "enable", cwd, trusted, scope);
                out(st.success(`✔ ${sub === "enable" ? "Enabled" : "Disabled"} ${st.bold(r.id)} (${r.scope} scope)`));
                return done(true);
            }
            case "update":
            case "upgrade": {
                const all = !args[0] || args[0] === "--all";
                progress?.(all ? "Updating plugins…" : `Updating ${args[0]}…`);
                const results = all ? await updateAll(cwd, trusted) : [await updatePlugin(args[0]!, cwd, trusted)];
                if (!results.length) out(st.muted("No plugins installed."));
                for (const r of results) {
                    if (r.error) out(st.error(`✘ ${r.id}: ${r.error}`));
                    else if (r.changed) out(st.success(`✔ ${st.bold(r.id)} ${r.from !== r.to ? `${r.from} → ${r.to}` : r.filesChanged === false ? `updated to its latest commit (still ${r.to})` : `updated: its files changed (still ${r.to})`}`));
                    else out(st.muted(`  ${r.id} is up to date (${r.to})`));
                }
                const restart = results.filter((r) => !r.error && (r.filesChanged || r.from !== r.to)).map((r) => splitId(r.id).name);
                return { ...done(results.some((r) => !r.error), results.every((r) => !r.error)), ...(restart.length ? { restart } : {}) };
            }
            case "validate": {
                const p = expandPath(args[0] ?? ".", cwd);
                return done(false, validate(p, out, st));
            }
            case "marketplace":
            case "marketplaces":
            case "market":
                return await marketplace(args, cwd, out, st, progress, done);
            case "help":
            case "--help":
            case "-h":
                for (const l of PLUGIN_USAGE) out(l);
                return done(false);
            default:
                throw new PluginError(`Unknown plugin command "${sub}". ${PLUGIN_USAGE.slice(1).map((l) => l.split(/\s{2,}/)[0]).join(" · ")}`);
        }
    } catch (e) {
        out(st.error((e as Error).message));
        return done(false, false);
    }
}

async function marketplace(args: string[], cwd: string, out: (s?: string) => void, st: Style, progress: ((m: string) => void) | undefined, done: (c: boolean, ok?: boolean) => PluginCliResult): Promise<PluginCliResult> {
    const sub = (args.shift() ?? "list").toLowerCase();
    switch (sub) {
        case "add": {
            if (!args[0]) throw new PluginError("Usage: plugin marketplace add <owner/repo | git URL | folder | marketplace.json path or URL>");
            progress?.(`Adding marketplace ${args[0]}…`);
            const m = await addMarketplace(args[0], cwd);
            out(st.success(`✔ Added marketplace ${st.bold(m.name)} · ${m.plugins.length} plugin${m.plugins.length === 1 ? "" : "s"}`));
            for (const e of m.errors) out(st.warning(`  ${e}`));
            if (m.plugins.length) out(st.muted(`  Install one with: plugin install <name>@${m.name}  (${m.plugins.slice(0, 5).map((p) => p.name).join(", ")}${m.plugins.length > 5 ? ", …" : ""})`));
            return done(true);
        }
        case "remove":
        case "rm": {
            if (!args[0]) throw new PluginError("Usage: plugin marketplace remove <name>");
            const r = removeMarketplace(args[0], cwd);
            out(st.success(`✔ Removed marketplace ${st.bold(args[0])}`));
            if (r.uninstalled.length) out(st.muted(`  Uninstalled its plugins: ${r.uninstalled.join(", ")}`));
            return done(true);
        }
        case "update": {
            const names = args[0] ? [args[0]] : Object.keys(readKnownMarketplaces()).sort();
            if (!names.length) out(st.muted("No marketplaces added."));
            let ok = true;
            for (const n of names) {
                progress?.(`Updating marketplace ${n}…`);
                try {
                    const m = await updateMarketplace(n);
                    out(st.success(`✔ ${st.bold(n)} · ${m.plugins.length} plugin${m.plugins.length === 1 ? "" : "s"}`));
                } catch (e) {
                    ok = false;
                    out(st.error(`✘ ${n}: ${(e as Error).message}`));
                }
            }
            return done(true, ok);
        }
        case "list":
        case "ls": {
            const l = listPlugins(cwd, true).marketplaces;
            if (!l.length) out(st.muted("No marketplaces added. Add one with: plugin marketplace add <owner/repo | git URL | folder>"));
            for (const m of l) {
                out(`${st.bold(m.name)}  ${st.muted(m.source)}`);
                out(m.error ? st.error(`  ${m.error}`) : st.muted(`  ${m.plugins} plugin${m.plugins === 1 ? "" : "s"}${m.description ? ` · ${m.description}` : ""}`));
            }
            return done(false);
        }
        default:
            throw new PluginError(`Unknown marketplace command "${sub}": use add, list, update or remove.`);
    }
}

/** Check a plugin folder, or a marketplace folder (and the plugins it holds on disk). */
function validate(path: string, out: (s?: string) => void, st: Style): boolean {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
        out(st.error(`${path} isn't a folder.`));
        return false;
    }
    let ok = true;
    let found = false;
    const mk = marketplaceFile(path);
    if (mk) {
        found = true;
        try {
            const m = parseMarketplace(cachedJson(mk, (e) => out(st.error(e))));
            out(st.success(`✔ Marketplace ${st.bold(m.name)}: ${m.plugins.length} plugin${m.plugins.length === 1 ? "" : "s"}`));
            const root = resolve(path, m.pluginRoot ?? ".");
            for (const e of m.plugins) {
                if (e.source.source !== "path") continue;
                const dir = resolve(root, e.source.path);
                if (!isInside(canonical(dir), canonical(path))) m.errors.push(`${e.name}: source ${e.source.path} is outside the marketplace`);
                else if (!existsSync(dir)) m.errors.push(`${e.name}: source ${e.source.path} doesn't exist`);
            }
            for (const e of m.errors) {
                ok = false;
                out(st.error(`  ✘ ${e}`));
            }
        } catch (e) {
            ok = false;
            out(st.error(`✘ ${mk}: ${(e as Error).message}`));
        }
    }
    const mf = manifestFile(path);
    if (mf || !mk) {
        found = true;
        let name = basename(path).toLowerCase();
        if (mf) {
            try {
                name = parsePluginManifest(cachedJson(mf, (e) => out(st.error(e))), name).name;
            } catch (e) {
                out(st.error(`✘ ${mf}: ${(e as Error).message}`));
                return false;
            }
        }
        const { errors, ...counts } = countComponents(path, `${name}@validate`);
        const n = total(counts);
        if (n) out(st.success(`✔ Plugin ${st.bold(name)}: ${countsText(counts)}`));
        else {
            ok = false;
            out(st.error(`✘ ${path} has no commands, agents, skills, hooks, MCP or language servers${mf ? "" : " (and no .claude-plugin/plugin.json)"}.`));
        }
        for (const e of errors) {
            ok = false;
            out(st.error(`  ✘ ${e}`));
        }
    }
    if (!found) out(st.error(`${path} has no plugin or marketplace manifest.`));
    return ok;
}
