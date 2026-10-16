// A session a window couldn't open again (after a reconnect, or a delete
// that failed): deleted meanwhile, kept for the next reconnect to reopen, or
// dropped (opened again when it's next shown).

export function afterFailedReopen(code: string | undefined): "forget" | "keep" | "drop" {
    if (code === "not_found") return "forget";
    if (code === "disconnected") return "keep";
    return "drop";
}
