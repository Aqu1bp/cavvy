// Saved models that named a provider just removed (or a model taken off its list) went back to unset on the server
// (src/providers/model-refs.ts): said once, in a toast.

import type { ModelSettingName } from "@shared/protocol";
import { toast } from "../state/app";

export function resetToast(reset: readonly ModelSettingName[] | undefined) {
    if (!reset?.length) return;
    toast(reset.length === 1 && reset[0] === "model" ? "Default model is now Automatic" : "Defaults that used it were reset", "info");
}

/** A CLI instance's name for a toast: cut at a word when long, so the toast stays under 8 words. */
export function shortName(name: string): string {
    if (name.length <= 24) return name;
    const cut = name.slice(0, 23);
    const word = cut.lastIndexOf(" ");
    return `${(word > 10 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

/** A CLI instance removed: one toast. */
export function removedToast(name: string, reset: readonly ModelSettingName[] | undefined) {
    const shown = shortName(name);
    toast(reset?.length ? `Removed ${shown}${shown.endsWith("…") ? "" : "."} Defaults reset.` : `Removed ${shown}`, "success");
}
