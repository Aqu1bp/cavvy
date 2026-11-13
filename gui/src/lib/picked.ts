// What was picked for a new session goes with the window when it changes machines (lib/machines.ts switchMachine):
// the model, its effort and fast mode. Each machine saves its own, so without this the composer changed under the
// user's hand whenever they changed only where the session would run. The permission mode isn't carried: it's each
// machine's own (a server's is Bypass; this computer's is never set by a server's).

import type { EffortLevel, GuiSettings } from "@shared/protocol";

export const PICKED_KEY = "cavvy.picked";

export interface Picked {
    model: string;
    effort?: EffortLevel;
    fastMode?: boolean;
}

/** What to carry from a window on the new-session screen: nothing where no model is picked. */
export const pickedOf = (settings: GuiSettings): Picked | undefined =>
    settings.model ? { model: settings.model, ...(settings.effort ? { effort: settings.effort } : {}), ...(settings.fastMode !== undefined ? { fastMode: settings.fastMode } : {}) } : undefined;

/** What the window brought with it, once. (`storage` is asked for here: where there's none, there's nothing.) */
export function takePicked(storage: () => Pick<Storage, "getItem" | "removeItem">): Picked | undefined {
    try {
        const raw = storage().getItem(PICKED_KEY);
        storage().removeItem(PICKED_KEY);
        const p = raw ? (JSON.parse(raw) as Partial<Picked>) : undefined;
        return p && typeof p.model === "string" && p.model ? { model: p.model, ...(typeof p.effort === "string" ? { effort: p.effort } : {}), ...(typeof p.fastMode === "boolean" ? { fastMode: p.fastMode } : {}) } : undefined;
    } catch {
        return undefined;
    }
}

/**
 * What to change in this machine's settings so a new session here starts as picked there. Nothing when this
 * machine hasn't that model (`refs`: the models it has), or is set that way already.
 */
export function pickedPatch(picked: Picked, settings: GuiSettings, refs: readonly string[]): GuiSettings | undefined {
    if (!refs.includes(picked.model)) return undefined;
    const patch: GuiSettings = {};
    if (settings.model !== picked.model) patch.model = picked.model;
    if (picked.effort && settings.effort !== picked.effort) patch.effort = picked.effort;
    if (picked.fastMode !== undefined && Boolean(settings.fastMode) !== picked.fastMode) patch.fastMode = picked.fastMode;
    return Object.keys(patch).length ? patch : undefined;
}
