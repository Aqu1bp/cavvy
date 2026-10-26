// Picking a CLI account in the model picker. Pure, so the rule is tested without a browser.

/**
 * Whether picking account `id` asks the server to switch: another account than the session's, the session's own
 * when it's missing (removed), or the one messages are held for (#410). That account may be back, added again under
 * the same id: picking it is what sends them, so the pick must reach the server even though nothing changes.
 */
export function sendsAccountPick(id: string, selected: string, o: { missing: boolean; needed: boolean }): boolean {
    return id !== selected || o.missing || o.needed;
}
