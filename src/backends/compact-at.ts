// Where a session compacts on its own, in tokens of context: what the composer's context card and ring
// measure against. An agent CLI's own trigger, worked out the way the CLI does; Cavvy's for its own sessions.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listAccounts } from "../providers/accounts";

function readJson(file: string): Record<string, unknown> | undefined {
    try {
        const v = JSON.parse(readFileSync(file, "utf8"));
        return v && typeof v === "object" ? v : undefined;
    } catch {
        return undefined;
    }
}

const tokenCount = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

/** Claude Code takes an auto-compact window from 100K to 1M tokens, or "auto" (its own choice). */
const CLAUDE_MIN_WINDOW = 100_000;
const CLAUDE_MAX_WINDOW = 1_000_000;
type ClaudeWindow = number | "auto";
function claudeWindow(v: unknown): ClaudeWindow | undefined {
    if (v === "auto") return "auto";
    return typeof v === "number" && Number.isInteger(v) && v >= CLAUDE_MIN_WINDOW && v <= CLAUDE_MAX_WINDOW ? v : undefined;
}

/** CLAUDE_CODE_AUTO_COMPACT_WINDOW as Claude Code reads it: "500000", "500k", "0.5m"; clamped to 100K-1M; else none. */
export function claudeEnvWindow(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const t = raw.trim();
    const unit = t.slice(-1).toLowerCase();
    const scale = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : undefined;
    const n = scale === undefined ? Number(t) : parseFloat(t) * scale;
    if (!t || Number.isNaN(n) || n < 1) return undefined;
    return Math.min(CLAUDE_MAX_WINDOW, Math.max(CLAUDE_MIN_WINDOW, Math.round(n)));
}

/**
 * The key Claude Code files a model's settings under: one model however it's spelled, with its 1M-context
 * suffix, a release date, or a Bedrock or Vertex id ("us.anthropic.claude-opus-5-5-20260101-v1:0",
 * "claude-opus-5-5@20260101", "claude-opus-5-5[1m]" all read "claude-opus-5-5").
 */
export function claudeSettingsKey(id: string): string {
    return id
        .trim()
        .toLowerCase()
        .replace(/\[1m\]$/, "")
        .replace(/^(?:(?:us|eu|apac|global)\.)?anthropic\./, "")
        .replace(/-v\d+(?::\d+)?$/, "")
        .replace(/@\d{8}$/, "")
        .replace(/-\d{8}$/, "");
}

/**
 * Claude Code's /autocompact window for a model, resolved as Claude Code resolves it: its account's
 * settings.json, then (only where it reads them, a trusted folder) the project's .claude/settings.json and
 * .claude/settings.local.json. Each layer's `modelSettings[model].autoCompactWindow` adds to the ones
 * before; a layer's top-level `autoCompactWindow` replaces them all as the default. "auto" is no window.
 * `models`: the ids the model may be filed under, the model served first ("claude-opus-5-5" for "opus"): all
 * of them are one model, as Claude Code resolves an alias, so a project's "opus" overrides the account's
 * "claude-opus-5-5".
 */
export function claudeCompactWindow(configDir: string, project: { cwd: string; trusted: boolean } | undefined, models: string[]): number | undefined {
    const env = claudeEnvWindow(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
    if (env !== undefined) return env;
    // The model's every spelling files under one key: its full id where one is known, as Claude Code resolves aliases.
    const spellings = models.map(claudeSettingsKey);
    const canonical = spellings.find((k) => k.startsWith("claude-")) ?? spellings[0];
    const keyOf = (id: string) => (spellings.includes(claudeSettingsKey(id)) && canonical ? canonical : claudeSettingsKey(id));
    const files = [join(configDir, "settings.json"), ...(project?.trusted ? [join(project.cwd, ".claude", "settings.json"), join(project.cwd, ".claude", "settings.local.json")] : [])];
    let resolved: { default?: ClaudeWindow; byModel: Record<string, ClaudeWindow> } = { byModel: {} };
    for (const file of files) {
        const j = readJson(file);
        if (!j) continue;
        const layer: Record<string, ClaudeWindow> = {};
        const all = j.modelSettings && typeof j.modelSettings === "object" ? (j.modelSettings as Record<string, { autoCompactWindow?: unknown } | undefined>) : {};
        for (const [id, v] of Object.entries(all)) {
            const w = claudeWindow(v?.autoCompactWindow);
            if (w === undefined) continue;
            const key = keyOf(id);
            // The id exactly as it's keyed wins over another spelling of it.
            if (id === key || !Object.hasOwn(layer, key)) layer[key] = w;
        }
        const top = claudeWindow(j.autoCompactWindow);
        resolved = top === undefined ? { default: resolved.default, byModel: { ...resolved.byModel, ...layer } } : { default: top, byModel: layer };
    }
    const w = canonical && Object.hasOwn(resolved.byModel, canonical) ? resolved.byModel[canonical] : resolved.default;
    return w === "auto" ? undefined : w;
}

/** Claude Code's trigger below its window: room for the answer (at most 20K) and a 13K margin (2.1.x). */
const CLAUDE_OUTPUT_ROOM = 20_000;
const CLAUDE_MARGIN = 13_000;

/** Where Claude Code compacts: its window (the model's, or the setting's if smaller) less the answer's room and its margin. */
export function claudeCompactAt(contextWindow: number | undefined, configured: number | undefined, maxOutput?: number): number | undefined {
    const window = contextWindow && configured ? Math.min(contextWindow, configured) : (contextWindow ?? configured);
    if (!window) return undefined;
    return Math.max(0, window - Math.min(maxOutput ?? CLAUDE_OUTPUT_ROOM, CLAUDE_OUTPUT_ROOM) - CLAUDE_MARGIN);
}

/** Codex's top-level `model_auto_compact_token_limit` in its config.toml. */
export function codexCompactLimit(codexHome: string): number | undefined {
    let config: Record<string, unknown>;
    try {
        config = Bun.TOML.parse(readFileSync(join(codexHome, "config.toml"), "utf8")) as Record<string, unknown>;
    } catch {
        return undefined;
    }
    const v = config.model_auto_compact_token_limit;
    return typeof v === "number" && Number.isInteger(v) ? tokenCount(v) : undefined;
}

/** The ids a Claude Code setting may be filed under: the model served, the one asked for, and what its name says it resolves to. */
export function modelKeys(m: { id: string; name?: string }, served?: string): string[] {
    const named = m.name?.match(/\(([^()\s]+)\)\s*$/)?.[1];
    return [...new Set([served, m.id, named].filter((x): x is string => Boolean(x)))];
}

/** Usage arrives often while a reply streams: the files are read again at most every few seconds. */
const CACHE_MS = 5_000;
const cache = new Map<string, { at: number; value: number | undefined }>();

/** An agent CLI's own auto-compact setting for this model and account (a window or a limit), or undefined when it has none. */
export function cliCompactSetting(provider: string, accountId: string, project: { cwd: string; trusted: boolean } | undefined, models: string[], now = Date.now()): number | undefined {
    if (provider !== "claude-code" && provider !== "codex") return undefined;
    const key = JSON.stringify([provider, accountId, project?.cwd, project?.trusted, models]);
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.value;
    const value = readSetting(provider, accountId, project, models);
    cache.set(key, { at: now, value });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    return value;
}

function readSetting(provider: "claude-code" | "codex", accountId: string, project: { cwd: string; trusted: boolean } | undefined, models: string[]): number | undefined {
    let folder: string | undefined;
    try {
        folder = listAccounts(provider).find((a) => a.id === accountId)?.folder;
    } catch {
        return undefined;
    }
    if (!folder) return undefined;
    return provider === "claude-code" ? claudeCompactWindow(folder, project, models) : codexCompactLimit(folder);
}

/** For tests: read the files again. */
export function clearCompactCache(): void {
    cache.clear();
}

/**
 * Room for the answer that auto-compaction keeps free below the window: the model's max output, at most 32K,
 * and never more than a quarter of the window. A model that can write about its whole window would otherwise
 * compact with next to nothing in it; its requests ask for less output instead (turnMaxTokens).
 */
export function outputReserve(window: number, maxOutput?: number): number {
    return Math.min(maxOutput ?? 32_000, 32_000, Math.floor(window / 4));
}

/** Cavvy's own sessions compact once their context passes this: `threshold` (0.92 unless set) of what the window leaves after the answer's room. */
export function cavvyCompactAt(window: number, maxOutput: number | undefined, threshold?: number | null): number {
    return (window - outputReserve(window, maxOutput)) * (threshold ?? 0.92);
}
