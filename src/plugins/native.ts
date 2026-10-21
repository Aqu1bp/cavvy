// Claude Code loads the harness's plugins itself: the format is its own, so
// each enabled plugin's folder goes to it with --plugin-dir, and its commands,
// agents, skills, hooks, MCP and language servers run natively there. The
// harness then doesn't run the same hooks a second time, and sends a plugin's
// slash commands and skills to Claude Code as they were typed.

import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { writeJson, type HookConfig, type Settings } from "../config/settings";
import { loadPlugins } from "./loader";

/**
 * The backend that loads plugins itself. Codex reads the same format but only
 * from its own installs (codex plugin add), so it gets the harness's loading,
 * as does every API provider. Its MCP servers come only from its own config,
 * so a plugin's servers reach it only when the plugin is installed in Codex too.
 */
export const loadsPluginsNatively = (provider: string | undefined) => provider === "claude-code";

/**
 * Claude Code runs this plugin command (or skill) itself: it has the plugins
 * loaded, and lists it (or hasn't said what it lists yet).
 */
export function runsPluginCommand(provider: string | undefined, name: string, listed: ReadonlySet<string> | undefined): boolean {
    return loadsPluginsNatively(provider) && (listed ? listed.has(name) : true);
}

/**
 * What the CLI listed, after a plugin change: its own names stay (so a plugin's
 * bare alias still can't take one of them over), and the enabled plugins'
 * commands are added, since its next process loads them all.
 */
export function withPluginCommands(listed: ReadonlySet<string>, commands: readonly { name: string; source: string }[]): Set<string> {
    const out = new Set(listed);
    for (const c of commands) if (c.source === "plugin") out.add(c.name);
    return out;
}

/**
 * Settings for the harness's own hook runs on a turn Claude Code runs with the
 * plugins loaded: their hooks are left out, since Claude Code runs them.
 * Notification hooks stay: those are the harness's notices, which Claude Code
 * never sees.
 */
export function withoutPluginHooks(s: Settings): Settings {
    if (!s.hooks) return s;
    let changed = false;
    const hooks: Record<string, HookConfig[]> = {};
    for (const [event, list] of Object.entries(s.hooks) as [string, HookConfig[] | undefined][]) {
        if (!list) continue;
        const kept = event === "Notification" ? list : list.filter((h) => !h.plugin);
        if (kept.length !== list.length) changed = true;
        if (kept.length) hooks[event] = kept;
    }
    return changed ? { ...s, hooks } : s;
}

/** Only the plugins' hooks: what's left to run once the session's model is known not to be Claude Code's. */
export function onlyPluginHooks(s: Settings): Settings {
    const hooks: Record<string, HookConfig[]> = {};
    for (const [event, list] of Object.entries(s.hooks ?? {}) as [string, HookConfig[] | undefined][]) {
        const kept = (list ?? []).filter((h) => h.plugin);
        if (kept.length) hooks[event] = kept;
    }
    return { ...s, hooks };
}

/** Settings for SessionStart and SessionEnd: Claude Code fires the plugins' own in each of its processes. */
export const sessionHookSettings = (s: Settings, provider: string | undefined): Settings => (loadsPluginsNatively(provider) ? withoutPluginHooks(s) : s);

/** Where Claude Code reads a plugin's manifest. */
export const claudeManifest = (root: string) => join(root, ".claude-plugin", "plugin.json");

/**
 * The folders of the plugins enabled for this folder, for --plugin-dir. Each
 * has the .claude-plugin/plugin.json Claude Code names it by (an install
 * writes one; a plugin installed before that gets it now, from the manifest
 * the harness reads).
 */
export function claudePluginDirs(cwd: string, trusted: boolean): string[] {
    const out: string[] = [];
    for (const p of loadPlugins(cwd, trusted)) {
        if (!existsSync(p.root)) continue;
        if (!existsSync(claudeManifest(p.root))) {
            try {
                writeClaudeManifest(p.root, p.manifest);
            } catch {
                continue; // Claude Code would name it after its folder (its version): better left out
            }
        }
        out.push(p.root);
    }
    return out;
}

/** Write .claude-plugin/plugin.json as a fresh file in a real folder, never through a link. */
export function writeClaudeManifest(root: string, manifest: object) {
    const dir = join(root, ".claude-plugin");
    if (existsSync(dir) && !lstatSync(dir).isDirectory()) rmSync(dir, { recursive: true, force: true });
    rmSync(claudeManifest(root), { force: true });
    writeJson(claudeManifest(root), manifest);
}

const HARNESS_ROOT = /\$\{HARNESS_PLUGIN_ROOT\}|\$HARNESS_PLUGIN_ROOT\b/g;

/**
 * In an installed copy's configuration (its manifests, hooks, MCP and language
 * server files), ${HARNESS_PLUGIN_ROOT} spelled as Claude Code knows it
 * (${CLAUDE_PLUGIN_ROOT}): Claude Code substitutes and sets only its own name,
 * and the harness treats the two alike. Scripts and other files are left as
 * they are. Links are never written through.
 */
export function useClaudeRootName(files: readonly string[]) {
    for (const f of files) {
        try {
            if (!lstatSync(f).isFile()) continue;
            const text = readFileSync(f, "utf-8");
            HARNESS_ROOT.lastIndex = 0;
            if (!HARNESS_ROOT.test(text)) continue;
            writeFileSync(f, text.replace(HARNESS_ROOT, (m) => (m.startsWith("${") ? "${CLAUDE_PLUGIN_ROOT}" : "$CLAUDE_PLUGIN_ROOT")));
        } catch {
            // unreadable: the harness reports it when it loads the plugin
        }
    }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Hooks in Claude Code's format ({ hooks: { Event: [{ matcher, hooks: [{ type, command }] }] } }).
 * The harness also reads its own flat one ({ Event: [{ matcher, command }] }),
 * which Claude Code refuses to load, so an installed copy is converted.
 */
export function claudeHooks(j: unknown): unknown {
    if (!isRecord(j) || isRecord(j.hooks)) return j;
    const events: Record<string, unknown> = {};
    for (const [event, list] of Object.entries(j)) {
        if (event === "__proto__") continue;
        events[event] = Array.isArray(list)
            ? list.map((g) => {
                  if (!isRecord(g) || Array.isArray(g.hooks)) return g;
                  const { matcher, ...hook } = g;
                  return { ...(matcher !== undefined ? { matcher } : {}), hooks: [{ type: "command", ...hook }] };
              })
            : list;
    }
    return { hooks: events };
}

/**
 * Ready an installed copy for Claude Code: its hooks files in Claude Code's
 * format, and ${HARNESS_PLUGIN_ROOT} spelled its way in the configuration
 * files. `hookFiles` must be among `configFiles` (inside the plugin).
 */
export function prepareForClaudeCode(p: { root: string; manifest: { hooks?: unknown }; configFiles: readonly string[] }) {
    const hookFiles = [join(p.root, "hooks", "hooks.json"), ...(typeof p.manifest.hooks === "string" ? [resolve(p.root, p.manifest.hooks)] : [])];
    for (const f of hookFiles) {
        if (!p.configFiles.includes(f)) continue;
        try {
            if (!lstatSync(f).isFile()) continue;
            const j = JSON.parse(readFileSync(f, "utf-8"));
            const converted = claudeHooks(j);
            if (converted !== j) writeFileSync(f, JSON.stringify(converted, null, 2));
        } catch {
            // unreadable: the harness reports it when it loads the plugin
        }
    }
    useClaudeRootName(p.configFiles);
}
