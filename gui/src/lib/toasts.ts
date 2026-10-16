// How long a toast stays up.

/** The Undo after a delete is the only way back, so it stays longer than the rest. */
export const UNDO_DELETE_MS = 10_000;

export function toastMs(level: "info" | "warn" | "error" | "success", ms?: number): number {
    return ms ?? (level === "error" ? 8000 : 4500);
}

export interface ToastAction {
    label: string;
    /** False or a rejection keeps the action available for an explicit retry. */
    run: () => void | boolean | Promise<void | boolean>;
}

export interface Toast {
    id: number;
    level: "info" | "warn" | "error" | "success";
    message: string;
    count: number;
    action?: ToastAction;
    /** Extra choices for a saved file; the primary action keeps existing queue semantics. */
    additionalActions?: ToastAction[];
    running?: boolean;
}

export function repeatedToast(toasts: readonly Toast[], message: string, level: Toast["level"], action?: ToastAction): Toast | undefined {
    // Each Undo belongs to one operation and must remain individually reachable.
    if (action) return undefined;
    return toasts.find((t) => !t.action && t.message === message && t.level === level);
}

/** Remaining visible time, with independent pause reasons (hover, focus, hidden). */
export class ToastLifetime {
    private reasons = new Set<string>();
    private since: number;

    constructor(
        private left: number,
        now: number,
    ) {
        this.since = now;
    }

    remaining(now: number): number {
        return Math.max(0, this.left - (this.reasons.size ? 0 : now - this.since));
    }

    get paused(): boolean {
        return this.reasons.size > 0;
    }

    get interacting(): boolean {
        return this.reasons.has("hover") || this.reasons.has("focus") || this.reasons.has("action");
    }

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
