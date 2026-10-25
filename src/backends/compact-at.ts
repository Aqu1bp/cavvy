// Where a session compacts on its own, in tokens of context: what the composer's context card and ring
// measure against. An agent CLI's own setting when there is one, else nothing (the CLI decides).

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

/**
 * Claude Code's /autocompact window for a model: `modelSettings[model].autoCompactWindow` in its settings,
 * the project's (.claude/settings.json, then .claude/settings.local.json) over the account's. `models`: the
 * ids the setting may be under, the model served first ("claude-opus-5-5" for the "opus" alias).
 */
export function claudeCompactWindow(configDir: string, cwd: string | undefined, models: string[]): number | undefined {
    const files = [join(configDir, "settings.json"), ...(cwd ? [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")] : [])];
    let found: number | undefined;
    for (const file of files) {
        const all = readJson(file)?.modelSettings;
        if (!all || typeof all !== "object") continue;
        for (const id of models) {
            const w = tokenCount((all as Record<string, { autoCompactWindow?: unknown } | undefined>)[id]?.autoCompactWindow);
            if (w) { found = w; break; }
        }
    }
    return found;
}

/** Codex's `model_auto_compact_token_limit`, at the top of its config.toml (before any [table]). */
export function codexCompactLimit(codexHome: string): number | undefined {
    let text: string;
    try {
        text = readFileSync(join(codexHome, "config.toml"), "utf8");
    } catch {
        return undefined;
    }
    for (const line of text.split(/\r?\n/)) {
        if (/^\s*\[/.test(line)) break;
        const m = line.match(/^\s*model_auto_compact_token_limit\s*=\s*([\d_]+)\s*(?:#.*)?$/);
        if (m) return tokenCount(Number(m[1]!.replaceAll("_", "")));
    }
    return undefined;
}

/** The ids a Claude Code setting may be filed under: the model served, the one asked for, and what its name says it resolves to. */
export function modelKeys(m: { id: string; name?: string }, served?: string): string[] {
    const named = m.name?.match(/\(([^()\s]+)\)\s*$/)?.[1];
    return [...new Set([served, m.id, named].filter((x): x is string => Boolean(x)))];
}

/** Usage arrives often while a reply streams: the files are read again at most every few seconds. */
const CACHE_MS = 5_000;
const cache = new Map<string, { at: number; value: number | undefined }>();

/** An agent CLI's own auto-compact point for this model and account, or undefined when it isn't set. */
export function cliCompactAt(provider: string, accountId: string, cwd: string | undefined, models: string[], now = Date.now()): number | undefined {
    if (provider !== "claude-code" && provider !== "codex") return undefined;
    const key = JSON.stringify([provider, accountId, cwd, models]);
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.value;
    const value = readCompactAt(provider, accountId, cwd, models);
    cache.set(key, { at: now, value });
    return value;
}

function readCompactAt(provider: "claude-code" | "codex", accountId: string, cwd: string | undefined, models: string[]): number | undefined {
    let folder: string | undefined;
    try {
        folder = listAccounts(provider).find((a) => a.id === accountId)?.folder;
    } catch {
        return undefined;
    }
    if (!folder) return undefined;
    return provider === "claude-code" ? claudeCompactWindow(folder, cwd, models) : codexCompactLimit(folder);
}

/**
 * Room for the answer that auto-compaction keeps free below the window: the model's max output, at most 32K,
 * and never more than a quarter of the window. A model that can write about its whole window would otherwise
 * compact with next to nothing in it; its requests ask for less output instead (turnMaxTokens).
 */
export function outputReserve(window: number, maxOutput?: number): number {
    return Math.min(maxOutput ?? 32_000, 32_000, Math.floor(window / 4));
}

/** Harness's own sessions compact once their context passes this: `threshold` of what the window leaves after the answer's room. */
export function harnessCompactAt(window: number, maxOutput: number | undefined, threshold = 0.92): number {
    return (window - outputReserve(window, maxOutput)) * threshold;
}
