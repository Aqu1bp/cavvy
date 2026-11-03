// The live CLI sessions of a Cavvy process, one per Cavvy session (or child
// agent) and provider. A session is made on first use and starts its process at
// its first turn, so reopening many sessions starts nothing. Idle processes
// with nothing in the background are stopped after LiveOptions.idleMs, and at
// most `maxIdle` of them are kept (the least recently used go first) once
// they've been idle `keepRecentMs`: a session in use, whose turns come a moment
// apart, isn't restarted between them (with 30 at work, it was, again and
// again). With the machine short of memory, the cap doesn't wait. One with
// background work is never stopped here. The sessions stay (dead) until
// released, so their task lists and wake listeners outlive their processes.

import { readFileSync } from "fs";
import { freemem, totalmem } from "os";
import { LiveCliSession, liveOptions, type LiveOptions } from "./session";
import type { AgentCliAdapter } from "./types";

export interface PoolOptions extends Partial<LiveOptions> {
    /** At most this many idle processes with nothing in the background, of those idle this long (ms). */
    maxIdle?: number;
    keepRecentMs?: number;
    /** The machine is short of memory: the cap doesn't wait (memoryShort, by default). */
    memoryShort?: () => boolean;
}

/**
 * Less than a tenth of the machine's memory can be had: on Linux, as the kernel says (MemAvailable, which counts the
 * cache it can drop). Elsewhere the system's free count leaves out what it can reclaim (a Mac's is a few percent with
 * plenty to spare), so it isn't taken for short.
 */
export function memoryShort(): boolean {
    if (process.platform !== "linux") return false;
    try {
        const kb = Number(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf-8"))?.[1]);
        return Number.isFinite(kb) && kb * 1024 < totalmem() * 0.1;
    } catch {
        return freemem() < totalmem() * 0.1;
    }
}

export class LiveCliPool {
    /** By Cavvy session key, then provider. */
    private sessions = new Map<string, Map<string, LiveCliSession>>();
    private o: LiveOptions;
    private maxIdle: number;
    private keepRecentMs: number;
    private memoryShort: () => boolean;
    /** When the cap is looked at again: a process past it was idle too short a time to stop. */
    private recheck?: unknown;

    constructor(
        private adapterFor: (provider: string) => AgentCliAdapter,
        o: PoolOptions = {},
    ) {
        const { maxIdle = 6, keepRecentMs = 5 * 60_000, memoryShort: short = memoryShort, ...rest } = o;
        this.o = liveOptions(rest);
        this.maxIdle = maxIdle;
        this.keepRecentMs = keepRecentMs;
        this.memoryShort = short;
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
        if (this.recheck !== undefined) this.o.clock.clearTimeout(this.recheck);
        this.recheck = undefined;
        const all = this.list();
        this.sessions.clear();
        await Promise.all(all.map((s) => s.close()));
    }

    /** Stop the least recently used idle processes past the cap: those idle `keepRecentMs`, or any with memory short. */
    private enforceCap() {
        if (this.recheck !== undefined) this.o.clock.clearTimeout(this.recheck);
        this.recheck = undefined;
        const idle = this.list().filter((s) => s.reapable());
        let over = idle.length - this.maxIdle;
        if (over <= 0) return;
        idle.sort((a, b) => a.lastActive - b.lastActive);
        const now = this.o.clock.now(), short = this.memoryShort();
        for (const s of idle) {
            if (over <= 0) return;
            const due = s.lastActive + this.keepRecentMs;
            if (!short && due > now) {
                // The rest were idle less time still: looked at again when this one has been long enough.
                this.recheck = this.o.clock.setTimeout(() => this.enforceCap(), due - now);
                return;
            }
            void s.stop();
            over--;
        }
    }
}
