// What was picked for a new session goes with the window when it changes machines (lib/machines.ts switchMachine):
// the model, its effort and fast mode. Each machine saves its own, so without this the composer changed under the
// user's hand whenever they changed only where the session would run. The permission mode isn't carried: it's each
// machine's own (a server's is Bypass; this computer's is never set by a server's).
//
// This half is what the window does where it arrives. What it leaves with is in lib/picked-leaving.ts, which only
// the servers code loads.

import type { EffortLevel, GuiSettings, ModelSummary } from "@shared/protocol";

export const PICKED_KEY = "cavvy.picked";

export interface Picked {
    model: string;
    effort?: EffortLevel;
    fastMode?: boolean;
}

/** A model as a machine lists it: what says whether a pick can be had there. */
export type Listed = Pick<ModelSummary, "ref" | "effortLevels" | "supportsFastMode">;

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
 * machine hasn't that model (`models`: the ones it lists), or is set that way already. An effort the model doesn't
 * take here, or fast mode where it can't run fast, is left out: the machine would refuse the rest with it.
 */
export function pickedPatch(picked: Picked, settings: GuiSettings, models: readonly Listed[]): GuiSettings | undefined {
    const model = models.find((m) => m.ref === picked.model);
    if (!model) return undefined;
    const patch: GuiSettings = {};
    if (settings.model !== picked.model) patch.model = picked.model;
    if (picked.effort && model.effortLevels?.includes(picked.effort) && settings.effort !== picked.effort) patch.effort = picked.effort;
    if (picked.fastMode !== undefined && (model.supportsFastMode || !picked.fastMode) && Boolean(settings.fastMode) !== picked.fastMode) patch.fastMode = picked.fastMode;
    return Object.keys(patch).length ? patch : undefined;
}
