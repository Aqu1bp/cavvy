// The live CLI sessions of a Cavvy process, one per Cavvy session (or child
// agent) and provider. A session is made on first use and starts its process at
// its first turn, so reopening many sessions starts nothing. Idle processes
// with nothing in the background are stopped after LiveOptions.idleMs, and at
// most `maxIdle` of them are kept (the least recently used go first); one with
// background work is never stopped here. The sessions stay (dead) until
// released, so their task lists and wake listeners outlive their processes.

import { LiveCliSession, liveOptions, type LiveOptions } from "./session";
import type { AgentCliAdapter } from "./types";

export interface PoolOptions extends Partial<LiveOptions> {
    /** At most this many idle processes with nothing in the background. */
    maxIdle?: number;
}

export class LiveCliPool {
    /** By Cavvy session key, then provider. */
    private sessions = new Map<string, Map<string, LiveCliSession>>();
    private o: LiveOptions;
    private maxIdle: number;

    constructor(
        private adapterFor: (provider: string) => AgentCliAdapter,
        o: PoolOptions = {},
    ) {
        const { maxIdle = 6, ...rest } = o;
        this.o = liveOptions(rest);
        this.maxIdle = maxIdle;
    }

    /** The session for this key and provider, made if there's none. Nothing is started until its first turn. */
    session(key: string, provider: string): LiveCliSession {
        let byProvider = this.sessions.get(key);
        if (!byProvider) this.sessions.set(key, (byProvider = new Map()));
        let s = byProvider.get(provider);
        if (!s) {
            s = new LiveCliSession(key, this.adapterFor(provider), { ...this.o, onChange: () => this.enforceCap() });
            byProvider.set(provider, s);
        }
        return s;
    }

    get(key: string, provider: string): LiveCliSession | undefined {
        return this.sessions.get(key)?.get(provider);
    }

    list(): LiveCliSession[] {
        return [...this.sessions.values()].flatMap((m) => [...m.values()]);
    }

    /**
     * Stop and forget a Cavvy session's live sessions: this provider's, or all of them (the session was
     * closed, rewound, or switched accounts). Background work stops with them; callers confirm that first.
     */
    async release(key: string, provider?: string): Promise<void> {
        const byProvider = this.sessions.get(key);
        if (!byProvider) return;
        const gone = provider === undefined ? [...byProvider.values()] : [byProvider.get(provider)].filter((s) => s !== undefined);
        if (provider === undefined) byProvider.clear();
        else byProvider.delete(provider);
        if (!byProvider.size) this.sessions.delete(key);
        await Promise.all(gone.map((s) => s.close()));
    }

    /** Stop every process (Cavvy is quitting). */
    async shutdownAll(): Promise<void> {
        const all = this.list();
        this.sessions.clear();
        await Promise.all(all.map((s) => s.close()));
    }

    /** Stop the least recently used idle processes past the cap. */
    private enforceCap() {
        const idle = this.list().filter((s) => s.reapable());
        if (idle.length <= this.maxIdle) return;
        idle.sort((a, b) => a.lastActive - b.lastActive);
        for (const s of idle.slice(0, idle.length - this.maxIdle)) void s.stop();
    }
}
