// What a window on the new-session screen takes with it to another machine (lib/picked.ts): the pick as its
// composer shows it. An effort its model doesn't take, or fast mode on a model that can't run fast, is saved here
// from an earlier model and isn't shown, so it isn't taken along.

import type { GuiSettings } from "@shared/protocol";
import type { Listed, Picked } from "./picked";

export function pickedOf(settings: GuiSettings, models: readonly Listed[]): Picked | undefined {
    const model = models.find((m) => m.ref === settings.model);
    if (!model) return undefined;
    return {
        model: model.ref,
        ...(settings.effort && model.effortLevels?.includes(settings.effort) ? { effort: settings.effort } : {}),
        ...(settings.fastMode !== undefined ? { fastMode: settings.fastMode && Boolean(model.supportsFastMode) } : {}),
    };
}
