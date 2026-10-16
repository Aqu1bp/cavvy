// How long a toast stays up.

/** The Undo after a delete is the only way back, so it stays longer than the rest. */
export const UNDO_DELETE_MS = 10_000;

export function toastMs(level: "info" | "warn" | "error" | "success", ms?: number): number {
    return ms ?? (level === "error" ? 8000 : 4500);
}

export interface ToastAction { label: string; run: () => void }
export interface Toast {
    id: number;
    level: "info" | "warn" | "error" | "success";
    message: string;
    count: number;
    actions: ToastAction[];
}

export function repeatedToast(toasts: readonly Toast[], message: string, level: Toast["level"], action?: ToastAction): Toast | undefined {
    // Different actions must remain individually reachable. Repeated Undo actions run together.
    return toasts.find((t) => t.message === message && t.level === level && t.actions[0]?.label === action?.label);
}

/** Remaining visible time, with independent pause reasons (hover, focus, hidden). */
export class ToastLifetime {
    private reasons = new Set<string>();
    private since: number;

    constructor(private left: number, now: number) { this.since = now; }

    remaining(now: number): number {
        return Math.max(0, this.left - (this.reasons.size ? 0 : now - this.since));
    }

    get paused(): boolean { return this.reasons.size > 0; }

    pause(reason: string, now: number) {
        this.left = this.remaining(now);
        this.reasons.add(reason);
        this.since = now;
    }

    resume(reason: string, now: number) {
        this.left = this.remaining(now);
        this.reasons.delete(reason);
        this.since = now;
    }

    restart(ms: number, now: number) {
        this.left = ms;
        this.since = now;
    }
}
