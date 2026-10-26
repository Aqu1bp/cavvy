// Idle compaction: a long conversation left idle is summarized shortly before
// its prompt cache expires, while reading the history still costs a tenth of
// the input price. Coming back after the cache has gone, the next turn then
// starts from the summary instead of reading (and caching) the whole history
// again: cheaper, and a much shorter wait for the first token.
//
// As in Claude Code (`idleCompaction`, 200K tokens at least, never under 100K),
// it's on for one-hour caches (Claude Code on a subscription). A five-minute
// cache (an Anthropic API key) only with "idleCompaction": "always": a pause of
// a few minutes doesn't mean the user has left.

import type { Settings } from "../config/settings";
import type { Usage } from "../providers/types";

export const IDLE_COMPACT_DEFAULT_TOKENS = 200_000;
/** Below this, reading the history cold is cheap: compacting would mostly lose context. */
export const IDLE_COMPACT_FLOOR_TOKENS = 100_000;
/** Into the cache's life it fires (Claude Code's default): 54 minutes of an hour, 4.5 of five. */
export const IDLE_COMPACT_FIRE_AT = 0.9;
/** A timer this late (a computer that slept) finds the cache gone or nearly: it skips. */
export const IDLE_COMPACT_LATE_MS = 60_000;

export const FIVE_MINUTES = 5 * 60_000;
export const ONE_HOUR = 60 * 60_000;

/** The prompt cache of the conversation's last request: when it was sent, and how long the provider keeps it. */
export interface CacheWindow {
    at: number;
    ttlMs: number;
}

export interface IdleCompactPlan {
    /** When to compact. */
    fireAt: number;
    /** When the cache goes: compacting after this pays the full read it was meant to save. */
    expiresAt: number;
    contextTokens: number;
}

/** The context size it takes: the setting, but never under the floor. */
export function idleCompactMinTokens(s: Settings): number {
    const n = s.idleCompactionMinTokens;
    return typeof n === "number" && Number.isFinite(n) ? Math.max(IDLE_COMPACT_FLOOR_TOKENS, n) : IDLE_COMPACT_DEFAULT_TOKENS;
}

/** Whether a cache this long qualifies under the settings. */
export function idleCompactAllows(s: Settings, ttlMs: number): boolean {
    if (s.autoCompact === false || s.idleCompaction === false) return false;
    return ttlMs >= ONE_HOUR || s.idleCompaction === "always";
}

/**
 * How long the cache a response wrote or read lasts, or undefined when the
 * provider doesn't say (Codex, OpenAI-compatible, Gemini: their caches expire
 * on their own schedule). `anthropicCache`: the request asked Anthropic for its
 * default (five-minute) cache. A response that only read the cache keeps what
 * was known before (`previous`): reading refreshes entries for their own TTL.
 */
export function cacheTtl(usage: Usage, anthropicCache: boolean, previous?: number): number | undefined {
    if ((usage.cacheWrite1hTokens ?? 0) > 0) return ONE_HOUR;
    // A breakdown that has no one-hour writes: they were five-minute ones.
    if ((usage.cacheWriteTokens ?? 0) > 0) return anthropicCache || usage.cacheWrite1hTokens !== undefined ? FIVE_MINUTES : previous;
    if ((usage.cacheReadTokens ?? 0) > 0) return previous ?? (anthropicCache ? FIVE_MINUTES : undefined);
    // Nothing cached (a proxy that drops cache_control, a prompt too short to cache): nothing to keep warm.
    return undefined;
}

/** When an idle conversation should compact, or null when it shouldn't. */
export function idleCompactPlan(o: { settings: Settings; cache?: CacheWindow; contextTokens: number; now: number }): IdleCompactPlan | null {
    const { cache } = o;
    if (!cache || !idleCompactAllows(o.settings, cache.ttlMs)) return null;
    if (o.contextTokens < idleCompactMinTokens(o.settings)) return null;
    const expiresAt = cache.at + cache.ttlMs;
    const fireAt = cache.at + cache.ttlMs * IDLE_COMPACT_FIRE_AT;
    if (o.now > fireAt + IDLE_COMPACT_LATE_MS || o.now >= expiresAt) return null;
    return { fireAt, expiresAt, contextTokens: o.contextTokens };
}

export interface Clock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        // A waiting compaction never keeps the process alive.
        (t as { unref?: () => void }).unref?.();
        return t;
    },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * One idle compaction per idle spell. The host arms it when a turn ends and
 * disarms it when anything starts; when it fires, the plan is asked for again
 * (the conversation may have moved on, or the timer fired late) and `run` goes
 * only if it still holds and the host is still idle (`ready`).
 */
export class IdleCompactTimer {
    private handle: unknown;
    /** When the armed timer fires. */
    due?: number;
    /** Tests use a fake one. */
    clock: Clock = realClock;

    constructor(
        private o: {
            plan: (now: number) => IdleCompactPlan | null;
            /** The host is idle: nothing running, queued, asked or being typed. */
            ready: () => boolean;
            run: (plan: IdleCompactPlan) => void;
        },
    ) {}

    arm(): boolean {
        this.disarm();
        const now = this.clock.now();
        let plan: IdleCompactPlan | null;
        try {
            plan = this.o.plan(now);
        } catch {
            // Never in the way of the turn that just ended.
            return false;
        }
        if (!plan) return false;
        this.due = plan.fireAt;
        this.handle = this.clock.setTimeout(() => this.fire(), Math.max(0, plan.fireAt - now));
        return true;
    }

    disarm() {
        if (this.handle !== undefined) this.clock.clearTimeout(this.handle);
        this.handle = undefined;
        this.due = undefined;
    }

    private fire() {
        this.handle = undefined;
        this.due = undefined;
        const now = this.clock.now();
        let plan: IdleCompactPlan | null;
        try {
            plan = this.o.plan(now);
        } catch {
            return;
        }
        // Fired early (a timer can), it waits the rest.
        if (plan && now < plan.fireAt) return void this.arm();
        if (!plan || !this.o.ready()) return;
        this.o.run(plan);
    }
}
