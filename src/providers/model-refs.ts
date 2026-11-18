// Model ids saved for later: the default model, the small model and the auto-mode reviewer (settings), a session's own.
// Each names a provider that can go away (an instance removed, a CLI turned off, a key removed). What names one that
// can't run falls back to what's chosen when nothing is set, and the user hears of it once, by the provider's name.

import { loadScope, updateSettings, type Settings } from "../config/settings";
import { getProvider, providerLabel } from "./registry";
import { clientFor } from "./models";
import { parseModelRef, type ModelInfo } from "./types";

/** The settings that hold a model ("provider:model"). */
export const MODEL_SETTINGS = ["model", "smallModel", "reviewModel"] as const;
export type ModelSetting = (typeof MODEL_SETTINGS)[number];

/**
 * Why a saved model can't run now, as the user is told it ("Claude Code · OpenRouter was removed"), or undefined when it
 * can be tried. The same check a session makes as it takes a model (clientFor).
 */
export async function unavailableReason(ref: string): Promise<string | undefined> {
    const p = parseModelRef(ref);
    if (!p) return "That model isn't available";
    const def = getProvider(p.provider);
    if (!def) return `${providerLabel(p.provider)} was removed`;
    try {
        await clientFor(p.provider);
        return undefined;
    } catch {
        return def.auth === "cli" ? `${def.name} is turned off` : def.auth === "gcloud" || !def.requiresKey ? `${def.name} isn't set up` : `${def.name} has no key`;
    }
}

/** A model as a notice names it: "Opus 5.5 on Anthropic API", without what an alias resolves to ("Default (claude-x-1)" says "Default"). */
export function modelLabel(m: Pick<ModelInfo, "provider" | "id" | "name">): string {
    const full = m.name || m.id;
    const paren = /^(.*\S)\s+\(([^()\s]+)\)$/.exec(full);
    const name = paren && /^[\w.:/@-]*[\d/-][\w.:/@-]*$/.test(paren[2]!) ? paren[1]! : full;
    return `${name} on ${providerLabel(m.provider)}`;
}

/** What a session that couldn't open on `ref` says, now on `now`. */
export function fallbackNotice(reason: string, now: Pick<ModelInfo, "provider" | "id" | "name">): string {
    return `${reason}, so this session uses ${modelLabel(now)}.`;
}

/**
 * Clear the user's saved models that `gone` matches (an instance removed, a CLI turned off, a key removed): each then
 * does what it does when it isn't set. The settings cleared.
 */
export function clearModelSettings(cwd: string, gone: (ref: { provider: string; id: string }) => boolean): ModelSetting[] {
    const matches = (s: Settings) =>
        MODEL_SETTINGS.filter((k) => {
            const p = typeof s[k] === "string" ? parseModelRef(s[k]!) : undefined;
            return Boolean(p && gone(p));
        });
    // Read first: a settings file nothing in names it isn't written.
    const found = matches(loadScope("user", cwd));
    if (!found.length) return [];
    let cleared: ModelSetting[] = [];
    updateSettings("user", cwd, (s) => {
        cleared = matches(s);
        for (const k of cleared) delete s[k];
    });
    return cleared;
}

/**
 * A key removed or a CLI turned off: the user's saved models that name it go back to unset, unless it can still be
 * used (a key from the environment). The settings reset.
 */
export async function forgetRemovedProvider(cwd: string, provider: string): Promise<ModelSetting[]> {
    if (await clientFor(provider).then(() => true, () => false)) return [];
    return clearModelSettings(cwd, (r) => r.provider === provider);
}

/** What the terminal says of `reset` (empty: nothing). */
export function resetNote(reset: readonly ModelSetting[]): string {
    if (!reset.length) return "";
    return reset.length === 1 && reset[0] === "model" ? "The default model is now automatic." : "Defaults that used it were reset.";
}
