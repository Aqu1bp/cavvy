// Provider clients and the combined model catalog behind /model.
//
// Every configured provider is queried in parallel; results are cached in
// ~/.harness/cache/models.json (no keys, only a short fingerprint so a new key
// invalidates the cache). Local servers are always probed live with a short
// timeout because they come and go.

import { createHash } from "crypto";
import { existsSync } from "fs";
import { AnthropicProvider } from "./anthropic";
import { OpenAICompatProvider } from "./openai-compat";
import { apiFastModeInfo } from "./fast-mode";
import { OpenAIResponsesProvider, responsesModelInfo } from "./openai-responses";
import { allProviders, getProvider, readAgentConfig, readVertexConfig, resolveBaseUrl, type ProviderDef } from "./registry";
import { VertexProvider, forgetTokens } from "./vertex";
import { anthropicTraits } from "./anthropic-models";
import { ProviderError, parseModelRef, type ModelInfo, type ProviderClient } from "./types";
import { getKey } from "../auth/credentials";
import { createBackend } from "../backends/index";
import { backendModel, isAgentBackend } from "../backends/types";
import { readJson, writeJson } from "../config/settings";
import { ensureDir, paths } from "../config/paths";
import { dirname } from "path";
import { account, defaultAccount } from "./accounts";

export function createClient(def: ProviderDef, key: string | undefined): ProviderClient {
    switch (def.kind) {
        case "anthropic":
            return new AnthropicProvider(def, key ?? "");
        case "responses":
            return new OpenAIResponsesProvider(def, key);
        case "agent":
            return createBackend(def);
        default:
            return new OpenAICompatProvider(def, key);
    }
}

const clients = new Map<string, { fp: string; client: ProviderClient }>();

/**
 * What identifies a provider's credential, without the credential: a key's
 * short hash, or the gcloud setup. Undefined when it has none.
 */
async function credentialFingerprint(def: ProviderDef): Promise<{ fp: string; key?: string } | undefined> {
    if (def.auth === "gcloud") {
        const cfg = readVertexConfig();
        return cfg ? { fp: `${cfg.account}|${cfg.project}|${cfg.location}` } : undefined;
    }
    if (def.auth === "cli") {
        // Turned on with /login; the CLI keeps its own sign-in.
        const cfg = readAgentConfig(def.id);
        const selected = cfg ? account(def.id, defaultAccount(def.id)) : undefined;
        return cfg ? { fp: `cli|${cfg.path ?? ""}|${(cfg.args ?? []).join("\0")}|${selected!.id}|${selected!.folder}` } : undefined;
    }
    const key = def.requiresKey ? await getKey(def.id) : undefined;
    if (def.requiresKey && !key) return undefined;
    return { fp: fingerprint(key?.value) + "|" + def.baseUrl, key: key?.value };
}

/** A client for a provider, with its stored key. Throws if a key is required but missing. */
export async function clientFor(providerId: string): Promise<ProviderClient> {
    const def = getProvider(providerId);
    if (!def) throw new ProviderError(`Unknown provider "${providerId}". Run /providers to see the list.`);
    const cred = await credentialFingerprint(def);
    if (!cred) throw new ProviderError(def.auth === "gcloud" ? `${def.name} isn't set up. Run /login vertex.` : def.auth === "cli" ? `${def.name} isn't turned on. Run /login ${def.id}.` : `No API key for ${def.name}. Run /login to add one.`, 401);
    const hit = clients.get(providerId);
    if (hit && hit.fp === cred.fp) return hit.client;
    const cfg = def.auth === "gcloud" ? readVertexConfig() : undefined;
    const client = cfg ? new VertexProvider(def, cfg) : createClient(def, cred.key);
    clients.set(providerId, { fp: cred.fp, client });
    return client;
}

export function forgetClient(providerId: string) {
    clients.delete(providerId);
    if (getProvider(providerId)?.auth === "gcloud") forgetTokens();
    const c = readCache();
    if (c.providers[providerId]) {
        delete c.providers[providerId];
        writeCache(c);
    }
}

function fingerprint(key: string | undefined): string {
    if (!key) return "none";
    return createHash("sha256").update(key).digest("hex").slice(0, 10);
}

// ---------------------------------------------------------------------------
// Cache

const CACHE_VERSION = 3;
const TTL_MS = 12 * 60 * 60 * 1000;

interface CacheEntry {
    fetchedAt: number;
    fp: string;
    models: ModelInfo[];
}

interface CacheFile {
    version: number;
    providers: Record<string, CacheEntry>;
}

function readCache(): CacheFile {
    const c = readJson<CacheFile>(paths.modelCache());
    if (!c || c.version !== CACHE_VERSION || typeof c.providers !== "object") return { version: CACHE_VERSION, providers: {} };
    return c;
}

function writeCache(c: CacheFile) {
    try {
        ensureDir(dirname(paths.modelCache()));
        writeJson(paths.modelCache(), c, 0o600);
    } catch {
        // cache is best-effort
    }
}

// ---------------------------------------------------------------------------
// Combined listing

export interface ProviderListing {
    provider: ProviderDef;
    models: ModelInfo[];
    status: "ok" | "cached" | "error" | "offline" | "no-key";
    error?: string;
    fetchedAt?: number;
}

export interface ListOptions {
    refresh?: boolean;
    signal?: AbortSignal;
    /** Include providers without a key (as "no-key" rows) for onboarding UIs. */
    includeUnconfigured?: boolean;
    onProvider?: (l: ProviderListing) => void;
    /** Only what's cached, of any age, without asking any provider; those with nothing cached for their credential are left out. */
    cachedOnly?: boolean;
}

export async function listAllModels(opts: ListOptions = {}): Promise<ProviderListing[]> {
    const cache = readCache();
    let dirty = false;
    const results = await Promise.all(
        allProviders().map(async (def): Promise<ProviderListing | undefined> => {
            const cached = cache.providers[def.id];
            let fp: string | undefined;
            try {
                const cred = await credentialFingerprint(def);
                if (!cred) {
                    return opts.includeUnconfigured ? { provider: def, models: [], status: "no-key" } : undefined;
                }
                fp = cred.fp;
                if (opts.cachedOnly) return cached && cached.fp === fp && !def.local ? { provider: def, models: cached.models, status: "cached", fetchedAt: cached.fetchedAt } : undefined;
                if (!def.local && !opts.refresh && cached && cached.fp === fp && Date.now() - cached.fetchedAt < TTL_MS) {
                    const l: ProviderListing = { provider: def, models: cached.models, status: "cached", fetchedAt: cached.fetchedAt };
                    opts.onProvider?.(l);
                    return l;
                }
                const client = await clientFor(def.id);
                const signal = combine(opts.signal, def.local ? 1500 : 20_000);
                const listed = await client.listModels(signal);
                const models = def.sorted ? listed : sortModels(listed);
                if (!def.local) {
                    cache.providers[def.id] = { fetchedAt: Date.now(), fp, models };
                    dirty = true;
                }
                const l: ProviderListing = { provider: def, models, status: "ok", fetchedAt: Date.now() };
                opts.onProvider?.(l);
                return l;
            } catch (e) {
                if (def.local) {
                    // A local server that isn't running isn't an error worth shouting about.
                    return opts.includeUnconfigured ? { provider: def, models: [], status: "offline" } : undefined;
                }
                const msg = (e as Error).message;
                // Serve stale cache rather than nothing.
                if (fp !== undefined && cached && cached.fp === fp) {
                    const l: ProviderListing = { provider: def, models: cached.models, status: "cached", error: msg, fetchedAt: cached.fetchedAt };
                    opts.onProvider?.(l);
                    return l;
                }
                const l: ProviderListing = { provider: def, models: [], status: "error", error: msg };
                opts.onProvider?.(l);
                return l;
            }
        }),
    );
    const listings = results.filter((x): x is ProviderListing => Boolean(x));
    enrichPricing(listings);
    if (dirty) writeCache(cache);
    return listings;
}

function combine(signal: AbortSignal | undefined, ms: number): AbortSignal {
    const t = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, t]) : t;
}

/** Newest first, then by name. */
function sortModels(models: ModelInfo[]): ModelInfo[] {
    return [...models].sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
}

// First-party providers whose models OpenRouter also lists under a vendor
// prefix. When the user has OpenRouter configured we borrow its pricing for
// models whose own API doesn't report prices. Marked as estimates in the UI.
// Vertex ids already carry the vendor (google/gemini-…).
const OPENROUTER_VENDOR: Record<string, string> = {
    openai: "openai/",
    gemini: "google/",
    vertex: "",
    deepseek: "deepseek/",
    xai: "x-ai/",
    mistral: "mistralai/",
};

function normId(id: string): string {
    return id.toLowerCase().replace(/^models\//, "").replace(/[.:_]/g, "-");
}

function enrichPricing(listings: ProviderListing[]) {
    // Vertex's catalog has no token limits; the same models listed by the Gemini API do.
    const gemini = new Map((listings.find((l) => l.provider.id === "gemini")?.models ?? []).map((m) => [m.id, m]));
    for (const m of listings.find((l) => l.provider.id === "vertex")?.models ?? []) {
        const g = gemini.get(m.id.replace(/^google\//, ""));
        m.contextWindow ??= g?.contextWindow;
        m.maxOutput ??= g?.maxOutput;
    }
    const or = listings.find((l) => l.provider.id === "openrouter");
    if (!or || !or.models.length) return;
    const byId = new Map<string, ModelInfo>();
    for (const m of or.models) byId.set(normId(m.id), m);
    for (const l of listings) {
        const vendor = OPENROUTER_VENDOR[l.provider.id];
        if (vendor === undefined) continue;
        for (const m of l.models) {
            if (m.pricing) continue;
            const match = byId.get(normId(`${vendor}${m.id}`));
            if (match?.pricing) {
                m.pricing = match.pricing;
                m.pricingEstimated = true;
                m.contextWindow ??= match.contextWindow;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Resolving a model reference

/** Find a model's info from the cache, falling back to static knowledge. */
export function resolveModelInfo(ref: string): ModelInfo | undefined {
    const parsed = parseModelRef(ref);
    if (!parsed) return undefined;
    const def = getProvider(parsed.provider);
    if (!def) return undefined;
    const cached = readCache().providers[parsed.provider]?.models.find((m) => m.id === parsed.id);
    if (cached) return cached;
    if (def.kind === "agent") return backendModel(def.id, parsed.id);
    if (def.kind === "responses") return responsesModelInfo(def.id, parsed.id, resolveBaseUrl(def));
    if (def.kind === "anthropic") {
        const t = anthropicTraits(parsed.id);
        return {
            provider: def.id,
            id: parsed.id,
            contextWindow: t.contextWindow,
            maxOutput: t.maxOutput,
            pricing: t.pricing,
            ...apiFastModeInfo(def.id, parsed.id, resolveBaseUrl(def)),
            supportsTools: true,
            supportsImages: true,
            supportsReasoning: t.adaptive,
            adaptiveThinking: t.adaptive,
            budgetThinking: !t.adaptive,
            effortLevels: t.effort,
        };
    }
    return { provider: def.id, id: parsed.id };
}

/** Look up a model live if it isn't cached (used when switching to a model typed by hand). */
export async function lookupModel(ref: string, signal?: AbortSignal): Promise<ModelInfo | undefined> {
    const parsed = parseModelRef(ref);
    if (!parsed) return undefined;
    const cached = readCache().providers[parsed.provider]?.models.find((m) => m.id === parsed.id);
    if (cached) return cached;
    try {
        const client = await clientFor(parsed.provider);
        const models = await client.listModels(signal);
        return models.find((m) => m.id === parsed.id);
    } catch {
        return undefined;
    }
}

/** Suggested defaults, in order of preference, per provider. */
const PREFERRED: Record<string, RegExp[]> = {
    anthropic: [/^claude-opus-5-5$/, /^claude-sonnet-5-5$/, /^claude-opus/, /^claude-sonnet/],
    openai: [/^gpt-6\.1-sol$/, /^gpt-6-sol$/, /^gpt-6-astra$/, /^gpt-\d/],
    gemini: [/pro-latest$/, /-pro$/, /pro/, /flash/],
    // Listed newest first: the newest released model that isn't a lite one.
    vertex: [/^google\/gemini-(?!.*(lite|preview))/, /^google\/gemini-/],
    openrouter: [/^anthropic\/claude-opus-5\.5$/, /^anthropic\/claude-sonnet-5\.5$/, /^anthropic\//, /^openai\//],
    deepseek: [/v4-pro/, /flash/, /chat/],
    xai: [/^grok-\d/],
    mistral: [/devstral/, /large/],
    groq: [/kimi|qwen|llama-3\.3/],
    // The CLI's own default (its listing comes in its order, default first).
    "claude-code": [/^default$/, /^opus$/],
};

const SMALL: Record<string, RegExp[]> = {
    anthropic: [/^claude-haiku-5-5$/, /^claude-haiku/],
    openai: [/^gpt-6-luna$/, /luna/, /mini/],
    gemini: [/flash-lite/, /flash/],
    // The auto-mode reviewer: flash-lite let through actions that should have asked; 3.5 Flash didn't, and answers in a second or two.
    vertex: [/^google\/gemini-3\.5-flash$/, /^google\/gemini-[\d.]+-flash$/, /^google\/gemini-[\d.]+-flash-lite$/],
    openrouter: [/^anthropic\/claude-haiku/, /mini/, /flash/],
    deepseek: [/flash/, /chat/],
    xai: [/mini|fast/],
    mistral: [/small/],
    groq: [/instant|8b/],
};

function pick(models: ModelInfo[], prefs: RegExp[] | undefined): ModelInfo | undefined {
    for (const re of prefs ?? []) {
        const m = models.find((x) => re.test(x.id));
        if (m) return m;
    }
    return models[0];
}

/** Choose a default model when none is configured: first configured provider, best model. */
export function defaultModelFrom(listings: ProviderListing[]): ModelInfo | undefined {
    const order = ["anthropic", "openai", "openrouter", "gemini", "vertex", "xai", "deepseek", "mistral", "groq"];
    const usable = listings.filter((l) => l.models.length);
    usable.sort((a, b) => idx(order, a.provider.id) - idx(order, b.provider.id));
    for (const l of usable) {
        const m = pick(l.models, PREFERRED[l.provider.id]);
        if (m) return m;
    }
    return undefined;
}

/** The auto-mode reviewer when none is set and there's an Anthropic key. */
export const DEFAULT_REVIEW_MODEL = "anthropic:claude-sonnet-5-5";

/**
 * Who reviews auto-mode actions: the reviewModel setting, else Claude Sonnet
 * 5.5 when there's an Anthropic key. Undefined: the session's own model does.
 * Never Claude Code or Codex, which review with their own auto modes. A reviewer
 * the user chose that can't be used throws, so its actions go to the user
 * rather than quietly to another model.
 */
export async function reviewTarget(setting: string | undefined): Promise<{ client: ProviderClient; model: ModelInfo } | undefined> {
    const ref = setting || ((await getKey("anthropic")) ? DEFAULT_REVIEW_MODEL : undefined);
    if (!ref) return undefined;
    try {
        const p = parseModelRef(ref);
        const model = resolveModelInfo(ref);
        if (!p || !model) throw new ProviderError(`"${ref}" isn't a model ("provider:model")`);
        const client = await clientFor(p.provider);
        if (isAgentBackend(client)) throw new ProviderError(`${getProvider(p.provider)?.name ?? p.provider} can't review actions; pick an API model`);
        return { client, model };
    } catch (e) {
        if (setting) throw new ProviderError(`the reviewer you chose (${setting}) can't be used: ${(e as Error).message}`);
        return undefined;
    }
}

/** A cheap model on the same provider, for titles and summaries. */
export function smallModelFor(provider: string, listings?: ProviderListing[]): ModelInfo | undefined {
    if (provider === "anthropic") {
        const cached = listings?.find((l) => l.provider.id === "anthropic")?.models;
        return (cached && pick(cached, SMALL.anthropic)) ?? resolveModelInfo("anthropic:claude-haiku-5-5");
    }
    const models = listings?.find((l) => l.provider.id === provider)?.models ?? readCache().providers[provider]?.models ?? [];
    const prefs = SMALL[provider];
    if (!prefs) return undefined;
    for (const re of prefs) {
        const m = models.find((x) => re.test(x.id));
        if (m) return m;
    }
    return undefined;
}

function idx(order: string[], id: string): number {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
}

export function cachedListings(): ProviderListing[] {
    const c = readCache();
    const out: ProviderListing[] = [];
    for (const def of allProviders()) {
        const e = c.providers[def.id];
        if (e) out.push({ provider: def, models: e.models, status: "cached", fetchedAt: e.fetchedAt });
    }
    return out;
}

export function modelCacheExists(): boolean {
    return existsSync(paths.modelCache());
}
