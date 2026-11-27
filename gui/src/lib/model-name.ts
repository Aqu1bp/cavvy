import { modelsFor } from "../state/app";
import { modelName as named } from "../components/ModelPicker";
import { shortModelRef } from "./tool-words";

/** A model as the model picker names it ("Mock Haiku" for "mock:mock-haiku"); the ref's model part when it isn't listed. */
export function modelName(ref: string, sessionId?: string): string {
    for (const g of modelsFor(sessionId)) {
        const m = g.models.find((x) => x.ref === ref);
        if (m) return named(m);
    }
    return shortModelRef(ref) ?? ref;
}

/**
 * The model that drafted something (Generate, Suggest), for their tooltips: its name, with its provider's in front when
 * the name doesn't say it ("Claude Code (Default)" for Claude Code's "Default (recommended)"; "Mock Haiku" as it is).
 */
export function draftedBy(ref: string, sessionId?: string): string {
    const provider = ref.slice(0, Math.max(0, ref.indexOf(":")));
    const g = modelsFor(sessionId).find((x) => x.provider === provider);
    const name = modelName(ref, sessionId);
    // "Mock (demo)" is Mock's.
    const whose = g?.providerName.replace(/\s*\([^()]*\)$/, "");
    if (!whose || name.toLowerCase().includes(whose.toLowerCase())) return name;
    return `${whose} (${name.replace(/\s*\(recommended\)$/i, "").replace(/\s*\(([^()]*)\)$/, ", $1")})`;
}
