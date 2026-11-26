// Saved models that named a provider just removed (or a model taken off its list) went back to unset on the server
// (src/providers/model-refs.ts): said once, in a toast.

import type { ModelSettingName } from "@shared/protocol";
import { toast } from "../state/app";

export function resetToast(reset: readonly ModelSettingName[] | undefined) {
    if (!reset?.length) return;
    toast(reset.length === 1 && reset[0] === "model" ? "Default model is now Automatic" : "Defaults that used it were reset", "info");
}

/** A CLI instance removed: one toast, under 8 words, its name cut when long. */
export function removedToast(name: string, reset: readonly ModelSettingName[] | undefined) {
    const shown = name.length > 24 ? `${name.slice(0, 23).trimEnd()}…` : name;
    toast(reset?.length ? `Removed ${shown}. Defaults reset.` : `Removed ${shown}`, "success");
}
