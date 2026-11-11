import type { PermissionOption } from "@shared/protocol";

/**
 * An approval card's answers. Three at most: Deny, Allow once, and one broader choice, the one that lasts (always,
 * in this project) before one for the session; the server offers no lasting one beside a narrower grant.
 * `keys`: what 1 and 2 answer (Esc denies). `row`: on screen at the trailing edge, Deny first and Allow once last,
 * where the eye lands, the broader choice between; `key` is 0 for Deny.
 */
export function approvalChoices(options: readonly PermissionOption[]): { keys: PermissionOption[]; row: { o: PermissionOption; key: number }[] } {
    const broader = options.find((o) => o.id === "always") ?? options.find((o) => o.id !== "yes" && o.id !== "no");
    const keys = [options.find((o) => o.id === "yes"), broader].filter((o) => o !== undefined);
    return { keys, row: [...options.filter((o) => o.id === "no"), ...keys.slice(1), ...keys.slice(0, 1)].map((o) => ({ o, key: keys.indexOf(o) + 1 })) };
}
