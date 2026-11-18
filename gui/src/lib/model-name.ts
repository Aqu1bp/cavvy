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
