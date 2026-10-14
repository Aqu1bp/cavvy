import { allProviders, resolveBaseUrl, SEARCH_PROVIDERS, type ProviderDef } from "../providers/registry";
import { maskKey } from "../util/redact";

export interface KeyGuess {
    id: string;
    name: string;
    kind: "model" | "search";
}

/** Guess which provider(s) a pasted key belongs to from its shape. */
export function detectKeyProvider(key: string): KeyGuess[] {
    const k = key.trim();
    const out: KeyGuess[] = [];
    if (/^sk-ant-admin/.test(k)) return []; // admin keys can't call the Messages API
    for (const p of allProviders()) {
        if (p.keyPatterns?.some((re) => re.test(k))) out.push({ id: p.id, name: p.name, kind: "model" });
    }
    for (const s of SEARCH_PROVIDERS) {
        if (s.keyPatterns.some((re) => re.test(k))) out.push({ id: s.id, name: s.name, kind: "search" });
    }
    // Old-style OpenAI keys: sk- followed by 48 chars (not DeepSeek's 32 hex).
    if (out.length === 0 && /^sk-[A-Za-z0-9]{40,}$/.test(k)) out.push({ id: "openai", name: "OpenAI", kind: "model" });
    return out;
}

export type ValidationResult = { ok: true; detail?: string } | { ok: false; reason: string; definitive: boolean };

/**
 * Check a key with a cheap authenticated read (model listing or key info).
 * `definitive: false` means we couldn't tell (network error, 5xx).
 */
export async function validateKey(p: ProviderDef, key: string, signal?: AbortSignal): Promise<ValidationResult> {
    const base = resolveBaseUrl(p);
    let url: string;
    const headers: Record<string, string> = { ...(p.headers ?? {}) };
    if (p.kind === "anthropic") {
        url = `${base}/v1/models?limit=1`;
        headers["x-api-key"] = key;
        headers["anthropic-version"] = "2023-06-01";
    } else if (p.id === "openrouter") {
        // /models is public on OpenRouter; /key requires a valid key.
        url = `${base}/key`;
        headers.Authorization = `Bearer ${key}`;
    } else {
        url = `${base}/models`;
        headers.Authorization = `Bearer ${key}`;
    }
    // Error bodies can quote the key back, and it isn't registered for
    // redaction until it is saved; keys without a known prefix match no pattern.
    // Also the JSON-escaped form, for bodies that quote it inside a JSON string.
    const forms = key ? [...new Set([key, JSON.stringify(key).slice(1, -1)])] : [];
    const scrub = (s: string) => forms.reduce((acc, f) => acc.split(f).join(maskKey(key)), s);
    try {
        const res = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(15000) });
        if (res.ok) {
            await res.body?.cancel();
            return { ok: true };
        }
        const body = scrub(await res.text()).slice(0, 300);
        if (res.status === 401 || res.status === 403) {
            return { ok: false, reason: `${res.status} ${res.statusText}: the provider rejected this key`, definitive: true };
        }
        return { ok: false, reason: scrub(`${res.status} ${res.statusText} ${body}`.trim()), definitive: false };
    } catch (e) {
        return { ok: false, reason: scrub((e as Error).message), definitive: false };
    }
}
