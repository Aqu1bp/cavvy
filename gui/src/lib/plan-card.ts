// The rail's plan card's own (loaded with it, when it first opens): how it keeps its order while it's open.

import type { RailPlan } from "./rail-plans";

/** A plan's place in the footer: its CLI and account. */
export const planKey = (p: Pick<RailPlan, "provider" | "accountId">) => `${p.provider}\0${p.accountId}`;

/** `plans` in the order `held` had them (planKey), any new ones after: the card keeps its order while it's open. */
export function heldOrder<T extends Pick<RailPlan, "provider" | "accountId">>(plans: readonly T[], held: readonly string[]): T[] {
    const at = (p: T) => {
        const i = held.indexOf(planKey(p));
        return i < 0 ? Infinity : i;
    };
    return [...plans].sort((a, b) => at(a) - at(b));
}
