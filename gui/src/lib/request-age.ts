import type { Method } from "@shared/protocol";

const slowMethods = new Set<Method>(["models.list", "providers.setKey", "providers.connectCli", "projects.createWorktree", "projects.removeWorktree", "cliSessions.import", "session.compact"]);

export const requestNoticeMs = (method: Method): number => slowMethods.has(method) ? 60_000 : 15_000;

/** Only outstanding replies count; a running turn has already received its reply. */
export class RequestAges {
    private due = new Map<number, number>();

    add(id: number, method: Method, now: number) {
        this.due.set(id, now + requestNoticeMs(method));
    }

    remove(id: number) {
        this.due.delete(id);
    }

    clear() {
        this.due.clear();
    }

    slow(now: number): boolean {
        return [...this.due.values()].some((at) => at <= now);
    }

    nextDelay(now: number): number | undefined {
        const next = Math.min(...[...this.due.values()].filter((at) => at > now));
        return Number.isFinite(next) ? next - now : undefined;
    }
}
