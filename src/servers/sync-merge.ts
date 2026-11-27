// Several of the user's computers can sync one server (sync-state.ts). The server keeps what each one last sent, item
// by item (a setting, a permission rule, an MCP server, a marketplace, a plugin, a provider, an agent CLI, a key), and
// when each item last changed on that computer. What it applies is all of them together: for an item more than one
// sends, the most recent change. One that starts syncing adds what the server lacks without replacing what another
// sent, and an item goes from the server once no computer sends it. Each computer's sync is otherwise as it was alone.
//
// The record holds the keys a computer sent while its key sync is on, as credentials.json does here (0600); turned
// off, or the computer signed out of this server for good (host.ts), they go from it.

import { createHash, randomUUID } from "crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { cavvyHome } from "../config/paths";
import { applyStateSync, readSyncedStateDigest, readSyncedStateRecord, type ApplyStateResult, type SyncRemoteStateStatus, type SyncStatePayload } from "./sync-state";

/** Parts of a payload sent together, each left out when the computer couldn't read it (see localSyncState). */
type Group = "settings" | "plugins" | "providers" | "keys";
const GROUPS: Group[] = ["settings", "plugins", "providers", "keys"];

interface Item {
    v: unknown;
    /** When it last changed on that computer; 0: it had it as it is when it started syncing. */
    t: number;
}

interface Sent {
    /** When it first synced: of two that never changed an item, the first one's stays. */
    since: number;
    /** The digest of its last payload, once the server took all of it. */
    digest?: string;
    /** Its key sync was on. */
    keys?: boolean;
    groups: Partial<Record<Group, Record<string, Item>>>;
}

type Store = Record<string, Sent>;

const FILE = () => join(cavvyHome(), "synced-by.json");

const stableJson = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
    const entries = Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`).join(",")}}`;
};
const hashVal = (v: unknown) => createHash("sha256").update(stableJson(v)).digest("hex");

function readStore(): Store {
    try {
        const v = JSON.parse(readFileSync(FILE(), "utf-8"));
        const out: Store = {};
        if (v?.v === 1 && v.by && typeof v.by === "object") {
            for (const [m, s] of Object.entries(v.by as Record<string, Partial<Sent>>)) {
                if (!s || typeof s !== "object" || typeof s.since !== "number" || !s.groups || typeof s.groups !== "object") continue;
                out[m] = { since: s.since, groups: s.groups, ...(typeof s.digest === "string" ? { digest: s.digest } : {}), ...(s.keys === true ? { keys: true } : {}) };
            }
        }
        return out;
    } catch {
        return {};
    }
}

function writeStore(store: Store) {
    const file = FILE();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = join(dirname(file), `.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify({ v: 1, by: store }), { mode: 0o600, flag: "wx" });
    try {
        renameSync(tmp, file);
    } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
    }
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const named = (list: unknown, key: "id" | "name") => (Array.isArray(list) ? list.filter((x) => isObj(x) && typeof x[key] === "string") : []) as Record<string, unknown>[];

/** A payload's groups as items, by a key naming what each is. */
function split(p: Partial<SyncStatePayload>): Partial<Record<Group, Record<string, unknown>>> {
    const out: Partial<Record<Group, Record<string, unknown>>> = {};
    if (isObj(p.settings)) {
        const g: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(p.settings)) if (v !== undefined) g[`s:${k}`] = v;
        if (isObj(p.permissions)) {
            // Its rules were read: without this, none are, and the server's are left as they are.
            g["rules"] = true;
            for (const list of ["allow", "ask", "deny"] as const) {
                const rules = (p.permissions as Record<string, unknown>)[list];
                for (const r of Array.isArray(rules) ? rules : []) if (typeof r === "string") g[`r:${list}:${r}`] = true;
            }
        }
        if (isObj(p.mcpServers)) for (const [name, c] of Object.entries(p.mcpServers)) g[`m:${name}`] = c;
        out.settings = g;
    }
    if (Array.isArray(p.marketplaces) && Array.isArray(p.plugins)) {
        const g: Record<string, unknown> = {};
        for (const m of named(p.marketplaces, "name")) g[`k:${m.name}`] = m;
        for (const pl of named(p.plugins, "id")) g[`p:${pl.id}`] = pl;
        out.plugins = g;
    }
    if (Array.isArray(p.customProviders)) {
        const g: Record<string, unknown> = {};
        for (const c of named(p.customProviders, "id")) g[`c:${c.id}`] = c;
        if (p.vertex !== undefined) g["vertex"] = p.vertex;
        // Its CLIs were read with its providers (localSyncState); said apart, as the server takes them apart.
        if (Array.isArray(p.agents)) {
            g["agents"] = true;
            for (const a of named(p.agents, "id")) g[`a:${a.id}`] = a;
        }
        out.providers = g;
    }
    if (p.includeSecrets === true && isObj(p.apiKeys)) {
        const g: Record<string, unknown> = {};
        for (const [id, k] of Object.entries(p.apiKeys)) g[`key:${id}`] = k;
        out.keys = g;
    }
    return out;
}

/** Items back into a payload. */
function join_(groups: Partial<Record<Group, Record<string, unknown>>>, keysOn: boolean): Partial<SyncStatePayload> {
    const p: Partial<SyncStatePayload> = {};
    const of = (g: Record<string, unknown>, prefix: string) =>
        Object.keys(g)
            .filter((k) => k.startsWith(prefix))
            .sort()
            .map((k) => [k.slice(prefix.length), g[k]] as const);
    const s = groups.settings;
    if (s) {
        p.settings = Object.fromEntries(of(s, "s:"));
        if (s["rules"] === true) {
            const rules = { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
            for (const [k] of of(s, "r:")) {
                const at = k.indexOf(":");
                const list = k.slice(0, at) as keyof typeof rules;
                if (list in rules) rules[list].push(k.slice(at + 1));
            }
            p.permissions = rules;
        }
        p.mcpServers = Object.fromEntries(of(s, "m:")) as SyncStatePayload["mcpServers"];
    }
    const pl = groups.plugins;
    if (pl) {
        p.marketplaces = of(pl, "k:").map(([, v]) => v) as SyncStatePayload["marketplaces"];
        p.plugins = of(pl, "p:").map(([, v]) => v) as SyncStatePayload["plugins"];
    }
    const pr = groups.providers;
    if (pr) {
        p.customProviders = of(pr, "c:").map(([, v]) => v) as SyncStatePayload["customProviders"];
        if (pr["vertex"] !== undefined) p.vertex = pr["vertex"] as SyncStatePayload["vertex"];
        if (pr["agents"] === true) p.agents = of(pr, "a:").map(([, v]) => v) as SyncStatePayload["agents"];
    }
    if (keysOn) {
        p.includeSecrets = true;
        if (groups.keys) p.apiKeys = Object.fromEntries(of(groups.keys, "key:")) as SyncStatePayload["apiKeys"];
    }
    return p;
}

/**
 * Records what computer `from` sent and gives what the server should have: every syncing computer's items, the most
 * recent change of each. `now` is when it's taken.
 */
export function mergeSent(store: Store, from: string, raw: unknown, now: number): Partial<SyncStatePayload> {
    const p = (isObj(raw) ? raw : {}) as Partial<SyncStatePayload>;
    const prev = store[from];
    const incoming = split(p);
    const groups: Sent["groups"] = { ...prev?.groups };
    for (const g of GROUPS) {
        const items = incoming[g];
        if (!items) {
            // Keys off: what it sent goes. Anything else it couldn't read this time: what it last sent stands.
            if (g === "keys" && p.includeSecrets !== true) delete groups.keys;
            continue;
        }
        const before = prev?.groups[g] ?? {};
        const next: Record<string, Item> = {};
        for (const [k, v] of Object.entries(items)) {
            const was = before[k];
            next[k] = { v, t: was && hashVal(was.v) === hashVal(v) ? was.t : prev ? now : 0 };
        }
        groups[g] = next;
    }
    store[from] = { since: prev?.since ?? now, groups, ...(p.includeSecrets === true ? { keys: true } : {}) };

    return { ...mergeAll(store), ...(p.installMissing === true ? { installMissing: true } : {}) };
}

/** What the server should have from the computers that sync it: of each item, the most recent change. */
function mergeAll(store: Store): Partial<SyncStatePayload> {
    // For each item, the most recent change; of equal ones (two that had it as it is when they started), the one
    // syncing longest: a computer that starts syncing doesn't replace what another sent.
    const order = Object.values(store).sort((a, b) => a.since - b.since);
    const merged: Partial<Record<Group, Record<string, unknown>>> = {};
    const when: Record<string, number> = {};
    for (const g of GROUPS) {
        for (const sent of order) {
            const items = sent.groups[g];
            if (!items || (g === "keys" && !sent.keys)) continue;
            const into = (merged[g] ??= {});
            for (const [k, it] of Object.entries(items)) {
                if (k in into && it.t <= when[`${g}\0${k}`]!) continue;
                into[k] = it.v;
                when[`${g}\0${k}`] = it.t;
            }
        }
    }
    return join_(merged, Object.values(store).some((s) => s.keys === true));
}


/** What computer `from` should send next: its digest, while what it last sent was taken whole. */
export async function syncedStateFor(from = "", signIns = false): Promise<SyncRemoteStateStatus> {
    const status = await readSyncedStateDigest(signIns);
    const mine = readStore()[from]?.digest;
    const { digest: _, ...rest } = status;
    return status.digest !== undefined && mine ? { ...rest, digest: mine } : rest;
}

/** Takes computer `from`'s payload (sync.applyState) as one of the computers that sync this server. */
export async function applyStateFrom(from: string, digest: unknown, raw: unknown, signIns = false): Promise<ApplyStateResult> {
    const store = readStore();
    const merged = mergeSent(store, from, raw, Date.now());
    const mergedDigest = hashVal(merged);
    // Recorded before applying: what's applied next time counts this computer's items, applied whole or not.
    writeStore(store);
    const result = await applyStateSync(mergedDigest, merged, { signIns });
    // Taken whole (the server recorded the digest): told so when it asks next, it sends again only after a change.
    if (readSyncedStateRecord().digest === mergedDigest && typeof digest === "string") {
        const after = readStore();
        if (after[from]) {
            after[from].digest = digest;
            writeStore(after);
        }
    }
    return result;
}

/**
 * A computer signed out of this server for good (host.ts): what it sent no longer keeps anything here, and what the
 * others send is applied again now; with none left, that takes back the keys sync put here. Undefined: it sent nothing.
 */
export async function forgetSyncedState(from: string): Promise<ApplyStateResult | undefined> {
    const store = readStore();
    if (!(from in store)) return undefined;
    delete store[from];
    // What the others sent hasn't changed, but what the server should have has: each one's next sync applies again.
    for (const s of Object.values(store)) delete s.digest;
    writeStore(store);
    const merged = mergeAll(store);
    return applyStateSync(hashVal(merged), merged, { signIns: false });
}
