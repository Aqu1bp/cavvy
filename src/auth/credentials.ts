// API-key storage.
//
// Resolution order for a provider key:
//   1. environment variable (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, ...)
//   2. OS keychain via Bun.secrets (macOS Keychain, libsecret, Windows Credential Manager)
//   3. ~/.harness/credentials.json (0600) — only used when no keychain is available
//
// Keys are never written to transcripts, logs, settings or history, and are
// registered with the redactor so they cannot leak through tool output.

import { chmodSync, existsSync, readFileSync, statSync } from "fs";
import { readJson, writeJson } from "../config/settings";
import { paths } from "../config/paths";
import { allProviders, getProvider, readProvidersFile, writeProvidersFile, SEARCH_PROVIDERS, type ProviderDef } from "../providers/registry";
import { registerSecret, unregisterSecret } from "../util/redact";

const SERVICE = "harness-cli";

export type KeySource = "env" | "keychain" | "file";

export interface ResolvedKey {
    value: string;
    source: KeySource;
    envVar?: string;
}

let keychainAvailable: boolean | undefined;

async function keychainWorks(): Promise<boolean> {
    if (keychainAvailable !== undefined) return keychainAvailable;
    if (process.env.HARNESS_NO_KEYCHAIN) return (keychainAvailable = false);
    try {
        await Bun.secrets.get({ service: SERVICE, name: "__probe__" });
        keychainAvailable = true;
    } catch {
        keychainAvailable = false;
    }
    return keychainAvailable;
}

function readFileStore(): Record<string, string> {
    const file = paths.credentialsFile();
    if (!existsSync(file)) return {};
    try {
        const mode = statSync(file).mode & 0o777;
        if (mode & 0o077) {
            // Someone loosened the permissions; tighten them back.
            chmodSync(file, 0o600);
        }
    } catch {
        // ignore
    }
    return readJson<Record<string, string>>(file) ?? {};
}

function writeFileStore(data: Record<string, string>) {
    writeJson(paths.credentialsFile(), data, 0o600);
    chmodSync(paths.credentialsFile(), 0o600);
}

export function envKeysFor(providerId: string): string[] {
    const p = getProvider(providerId);
    if (p) return p.envKeys;
    const s = SEARCH_PROVIDERS.find((x) => x.id === providerId);
    return s ? [...s.envKeys] : [];
}

const cache = new Map<string, ResolvedKey | null>();

export async function getKey(providerId: string): Promise<ResolvedKey | undefined> {
    if (cache.has(providerId)) return cache.get(providerId) ?? undefined;
    const found = await lookup(providerId);
    cache.set(providerId, found ?? null);
    if (found) registerSecret(found.value, providerId);
    return found;
}

async function lookup(providerId: string): Promise<ResolvedKey | undefined> {
    for (const envVar of envKeysFor(providerId)) {
        const v = process.env[envVar]?.trim();
        if (v) return { value: v, source: "env", envVar };
    }
    if (await keychainWorks()) {
        try {
            const v = await Bun.secrets.get({ service: SERVICE, name: providerId });
            if (v) return { value: v, source: "keychain" };
        } catch {
            // fall through to file store
        }
    }
    const fileVal = readFileStore()[providerId];
    if (fileVal) return { value: fileVal, source: "file" };
    return undefined;
}

/** Store a key. Returns where it was stored. */
export async function setKey(providerId: string, value: string): Promise<KeySource> {
    const key = value.trim();
    if (!key) throw new Error("empty key");
    const old = cache.get(providerId);
    if (old) unregisterSecret(old.value);
    let source: KeySource = "file";
    if (await keychainWorks()) {
        try {
            await Bun.secrets.set({ service: SERVICE, name: providerId, value: key });
            source = "keychain";
            const pf = readProvidersFile();
            pf.keychain = [...new Set([...(pf.keychain ?? []), providerId])];
            writeProvidersFile(pf);
            // Remove any stale plaintext copy.
            const store = readFileStore();
            if (store[providerId]) {
                delete store[providerId];
                writeFileStore(store);
            }
        } catch {
            source = "file";
        }
    }
    if (source === "file") {
        const store = readFileStore();
        store[providerId] = key;
        writeFileStore(store);
    }
    cache.delete(providerId);
    registerSecret(key, providerId);
    // An env var still takes precedence; tell the caller via getKey().source.
    return source;
}

export async function removeKey(providerId: string): Promise<boolean> {
    let removed = false;
    if (await keychainWorks()) {
        try {
            removed = (await Bun.secrets.delete({ service: SERVICE, name: providerId })) || removed;
        } catch {
            // ignore
        }
    }
    const store = readFileStore();
    if (store[providerId]) {
        delete store[providerId];
        writeFileStore(store);
        removed = true;
    }
    const pf = readProvidersFile();
    if (pf.keychain?.includes(providerId)) {
        pf.keychain = pf.keychain.filter((x) => x !== providerId);
        writeProvidersFile(pf);
    }
    const old = cache.get(providerId);
    if (old) unregisterSecret(old.value);
    cache.delete(providerId);
    return removed;
}

/** Providers that can be used right now (have a key, or don't need one). */
export async function configuredProviders(): Promise<ProviderDef[]> {
    const out: ProviderDef[] = [];
    for (const p of allProviders()) {
        if (!p.requiresKey) {
            out.push(p);
            continue;
        }
        if (await getKey(p.id)) out.push(p);
    }
    return out;
}

/** Load all keys up front so they're registered with the redactor. */
export async function preloadKeys(): Promise<void> {
    await Promise.all([...allProviders().map((p) => getKey(p.id)), ...SEARCH_PROVIDERS.map((s) => getKey(s.id))]);
}

export function keychainLabel(): string {
    if (process.platform === "darwin") return "macOS Keychain";
    if (process.platform === "win32") return "Windows Credential Manager";
    return "system keyring (libsecret)";
}

export async function storageDescription(): Promise<string> {
    return (await keychainWorks()) ? keychainLabel() : `${paths.credentialsFile()} (chmod 600)`;
}

// ---------------------------------------------------------------------------
// .env loading. Bun's automatic .env loading is disabled (--no-env-file) so a
// project's .env is never silently picked up. We load only the harness's own
// files, and only variables that look like provider settings.

const LEGACY_HOSTS: [RegExp, string][] = [
    [/(^|\.)anthropic\.com$/, "anthropic"],
    [/(^|\.)openrouter\.ai$/, "openrouter"],
    [/(^|\.)generativelanguage\.googleapis\.com$/, "gemini"],
    [/(^|\.)openai\.com$/, "openai"],
    [/(^|\.)groq\.com$/, "groq"],
    [/(^|\.)deepseek\.com$/, "deepseek"],
    [/(^|\.)x\.ai$/, "xai"],
    [/(^|\.)mistral\.ai$/, "mistral"],
    [/(^|\.)together\.(xyz|ai)$/, "together"],
    [/(^|\.)fireworks\.ai$/, "fireworks"],
    [/(^|\.)cerebras\.ai$/, "cerebras"],
];

export function parseDotenv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        let v = m[2]!.trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        else v = v.replace(/\s+#.*$/, "");
        out[m[1]!] = v;
    }
    return out;
}

/**
 * Load harness-owned .env files. Supports the original BASE_URL / API_KEY /
 * MODEL trio: the key is mapped to a known provider by BASE_URL's host, and
 * ignored for unknown hosts so a key is never sent somewhere unexpected.
 * Returns a default model ref if the legacy MODEL variable was set.
 */
export function loadHarnessEnv(files: string[]): { legacyModel?: string; notes: string[] } {
    const notes: string[] = [];
    let legacyModel: string | undefined;
    const allowed = new Set<string>([
        ...allProviders().flatMap((p) => p.envKeys),
        ...allProviders().flatMap((p) => (p.baseUrlEnv ? [p.baseUrlEnv] : [])),
        ...SEARCH_PROVIDERS.flatMap((s) => [...s.envKeys]),
        "HARNESS_MODEL",
    ]);
    for (const file of files) {
        if (!existsSync(file)) continue;
        let vars: Record<string, string>;
        try {
            vars = parseDotenv(readFileSync(file, "utf-8"));
        } catch {
            continue;
        }
        for (const [k, v] of Object.entries(vars)) {
            if (allowed.has(k) && v && process.env[k] === undefined) process.env[k] = v;
        }
        if (vars.API_KEY && vars.BASE_URL) {
            let host = "";
            try {
                host = new URL(vars.BASE_URL).hostname;
            } catch {
                // ignore
            }
            const match = LEGACY_HOSTS.find(([re]) => re.test(host));
            if (match) {
                const provider = getProvider(match[1])!;
                const envVar = provider.envKeys[0]!;
                if (process.env[envVar] === undefined) process.env[envVar] = vars.API_KEY;
                if (vars.MODEL && !legacyModel) legacyModel = `${provider.id}:${vars.MODEL}`;
            } else {
                notes.push(`Ignored API_KEY in ${file}: BASE_URL host "${host}" is not a known provider. Use /login to add a custom provider.`);
            }
        }
        if (vars.HARNESS_MODEL && !legacyModel) legacyModel = vars.HARNESS_MODEL;
    }
    return { legacyModel, notes };
}

/** Env vars that hold secrets; stripped from Bash tool child processes. */
export function secretEnvVarNames(): string[] {
    return [
        ...new Set([
            ...allProviders().flatMap((p) => p.envKeys),
            ...SEARCH_PROVIDERS.flatMap((s) => [...s.envKeys]),
            "ANTHROPIC_AUTH_TOKEN",
            "API_KEY",
        ]),
    ];
}
