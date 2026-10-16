// How long a toast stays up.

/** The Undo after a delete is the only way back, so it stays longer than the rest. */
export const UNDO_DELETE_MS = 10_000;

export function toastMs(level: "info" | "warn" | "error" | "success", ms?: number): number {
    return ms ?? (level === "error" ? 8000 : 4500);
}
