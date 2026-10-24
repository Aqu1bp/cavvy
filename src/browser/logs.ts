// What a page says and does while the agent isn't looking: console output, uncaught exceptions, dialogs, and the
// requests it makes (method, URL, status, failure; no bodies). Both logs keep only the latest entries.

import { redact } from "../util/redact";
import { displayUrl } from "./url-policy";

export const CONSOLE_CAPACITY = 200;
export const NETWORK_CAPACITY = 300;
const MAX_TEXT = 500;

/** The latest `capacity` items. */
export class Ring<T> {
    private list: T[] = [];
    /** How many it let go of to stay within its capacity. */
    dropped = 0;

    constructor(readonly capacity: number) {}

    push(item: T): T | undefined {
        this.list.push(item);
        if (this.list.length <= this.capacity) return undefined;
        this.dropped++;
        return this.list.shift();
    }

    get items(): readonly T[] {
        return this.list;
    }

    clear() {
        this.list = [];
        this.dropped = 0;
    }
}

export type ConsoleLevel = "log" | "info" | "debug" | "warn" | "error" | "exception" | "dialog" | "download";

export interface ConsoleEntry {
    at: number;
    level: ConsoleLevel;
    text: string;
}

const cut = (text: string, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max)}…` : text);

export class ConsoleLog {
    private ring = new Ring<ConsoleEntry>(CONSOLE_CAPACITY);
    /** Errors and exceptions since they were last looked at (a snapshot or the logs). */
    unseenErrors = 0;

    add(level: ConsoleLevel, text: string, at = Date.now()) {
        this.ring.push({ at, level, text: cut(text) });
        if (level === "error" || level === "exception") this.unseenErrors++;
    }

    get entries(): readonly ConsoleEntry[] {
        return this.ring.items;
    }

    get dropped(): number {
        return this.ring.dropped;
    }

    clear() {
        this.ring.clear();
        this.unseenErrors = 0;
    }
}

export interface NetworkEntry {
    id: string;
    method: string;
    url: string;
    type?: string;
    status?: number;
    /** Why it failed ("net::ERR_CONNECTION_REFUSED", "blocked"); cancelled requests aren't failures. */
    failure?: string;
    done: boolean;
}

/** Requests that stay open by design say nothing about the page having settled. */
const LONG_LIVED = new Set(["EventSource", "WebSocket", "Ping", "Prefetch"]);

export class NetworkLog {
    private ring = new Ring<NetworkEntry>(NETWORK_CAPACITY);
    private byId = new Map<string, NetworkEntry>();
    private open = new Set<string>();
    /** Requests started, all told (the ring forgets old ones; this keeps counting). */
    started = 0;

    /** Requests in flight (apart from ones that stay open by design). */
    get inflight(): number {
        return this.open.size;
    }

    get entries(): readonly NetworkEntry[] {
        return this.ring.items;
    }

    get dropped(): number {
        return this.ring.dropped;
    }

    start(id: string, method: string, url: string, type?: string, redirected?: { status: number }) {
        if (/^(data|blob|chrome-extension):/.test(url)) return;
        this.started++;
        const previous = this.byId.get(id);
        // A redirect continues the same request id: the earlier hop is finished with the redirect's status.
        if (previous && redirected) {
            previous.status = redirected.status;
            previous.done = true;
        }
        const entry: NetworkEntry = { id, method, url, type, done: false };
        const evicted = this.ring.push(entry);
        if (evicted && this.byId.get(evicted.id) === evicted) this.byId.delete(evicted.id);
        this.byId.set(id, entry);
        if (!type || !LONG_LIVED.has(type)) this.open.add(id);
        else this.open.delete(id);
    }

    response(id: string, status: number) {
        const entry = this.byId.get(id);
        if (entry) entry.status = status;
    }

    finish(id: string) {
        const entry = this.byId.get(id);
        if (entry) entry.done = true;
        this.open.delete(id);
    }

    fail(id: string, error: string, cancelled: boolean) {
        const entry = this.byId.get(id);
        if (entry) {
            entry.done = true;
            if (!cancelled) entry.failure = error;
        }
        this.open.delete(id);
    }

    /** A new page: requests of the old one that never finished are not waited for. */
    forgetInflight() {
        this.open.clear();
    }

    clear() {
        this.ring.clear();
        this.byId.clear();
        this.open.clear();
    }
}

/** Entries as lines for the agent, secrets redacted. */
export function formatLogs(kind: "console" | "network" | "all", consoleLog: ConsoleLog, network: NetworkLog): string {
    const lines: string[] = [];
    if (kind !== "network") {
        lines.push(`Console (${consoleLog.entries.length}${consoleLog.dropped ? `, ${consoleLog.dropped} earlier ones dropped` : ""}):`);
        for (const e of consoleLog.entries) lines.push(`  [${new Date(e.at).toISOString().slice(11, 19)}] ${e.level}: ${e.text}`);
        if (!consoleLog.entries.length) lines.push("  (nothing)");
    }
    if (kind !== "console") {
        const failed = network.entries.filter((e) => e.failure || (e.status !== undefined && e.status >= 400)).length;
        lines.push(`Network (${network.entries.length} requests, ${failed} failed${network.dropped ? `, ${network.dropped} earlier ones dropped` : ""}):`);
        for (const e of network.entries) {
            const result = e.failure ? `FAILED ${e.failure}` : e.status !== undefined ? String(e.status) : e.done ? "cancelled" : "pending";
            lines.push(`  ${e.method} ${result} ${displayUrl(e.url)}${e.type ? ` (${e.type})` : ""}`);
        }
        if (!network.entries.length) lines.push("  (nothing)");
    }
    return redact(lines.join("\n"));
}
