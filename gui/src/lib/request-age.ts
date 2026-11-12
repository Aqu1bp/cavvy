import type { Method } from "@shared/protocol";

const slowMethods = new Set<Method>(["models.list", "providers.setKey", "providers.connectCli", "projects.createWorktree", "projects.removeWorktree", "cliSessions.import", "session.compact"]);

export const requestNoticeMs = (method: Method): number => (slowMethods.has(method) ? 60_000 : 15_000);

/** Only outstanding replies count; a running turn has already received its reply. */
export class RequestAges {
    private due = new Map<number, number>();
    private asked = new Map<number, { method: Method; at: number }>();

    add(id: number, method: Method, now: number) {
        this.due.set(id, now + requestNoticeMs(method));
        this.asked.set(id, { method, at: now });
    }

    remove(id: number) {
        this.due.delete(id);
        this.asked.delete(id);
    }

    clear() {
        this.due.clear();
        this.asked.clear();
    }

    /** What the notice is for: each request past its time, the longest waiting first. */
    waiting(now: number): { method: Method; ms: number }[] {
        return [...this.due].filter(([, at]) => at <= now).map(([id]) => this.asked.get(id)!).map((a) => ({ method: a.method, ms: now - a.at })).sort((a, b) => b.ms - a.ms);
    }

    slow(now: number): boolean {
        return [...this.due.values()].some((at) => at <= now);
    }

    nextDelay(now: number): number | undefined {
        const next = Math.min(...[...this.due.values()].filter((at) => at > now));
        return Number.isFinite(next) ? next - now : undefined;
    }
}

/** One line per kind of request the notice waits on, for its tooltip: "models.list · 3m 12s", "session.open ×2 · 20s". */
export function waitingLabel(waiting: { method: string; ms: number }[]): string {
    const byMethod = new Map<string, { n: number; ms: number }>();
    for (const w of waiting) {
        const seen = byMethod.get(w.method);
        byMethod.set(w.method, { n: (seen?.n ?? 0) + 1, ms: Math.max(seen?.ms ?? 0, w.ms) });
    }
    return [...byMethod].sort((a, b) => b[1].ms - a[1].ms).map(([method, { n, ms }]) => {
        const s = Math.floor(ms / 1000);
        return `${method}${n > 1 ? ` ×${n}` : ""} · ${s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`}`;
    }).join("\n");
}
