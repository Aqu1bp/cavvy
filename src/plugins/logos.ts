// A plugin maker's logo for Settings → Plugins: their GitHub account's avatar. The GUI's
// Content-Security-Policy keeps images to its own origin, so the server fetches it and hands
// over the bytes. Each account is asked once per run; one without an avatar is remembered too.
// Only GitHub's hosts are contacted, a few requests at a time, and only so many answers are kept.

import { sniffImage } from "../util/files";

/** A GitHub user or organization name. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8_000;
/** github.com/<owner>.png redirects to the avatar's host; nothing else is followed. */
const HOSTS = new Set(["github.com", "avatars.githubusercontent.com"]);
const MAX_REDIRECTS = 3;
const MAX_ENTRIES = 300;
const MAX_ACTIVE = 4;

export type Logo = { mediaType: string; data: string } | null;

/** Oldest first: a hit moves to the end, and the front goes when it's full. */
const cache = new Map<string, Promise<Logo>>();

export function pluginLogo(owner: string, get: typeof fetch = fetch): Promise<Logo> {
    if (!OWNER.test(owner)) return Promise.resolve(null);
    const key = owner.toLowerCase();
    const cached = cache.get(key);
    if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        return cached;
    }
    // Offline, timed out or GitHub busy (undefined): asked again next time, unlike an account with no avatar.
    const hit: Promise<Logo> = limited(() => fetchLogo(owner, get)).then((logo) => {
        if (logo === undefined && cache.get(key) === hit) cache.delete(key);
        return logo ?? null;
    });
    cache.set(key, hit);
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    return hit;
}

let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(run: () => Promise<T>): Promise<T> {
    if (active >= MAX_ACTIVE) await new Promise<void>((go) => waiting.push(go));
    active++;
    try {
        return await run();
    } finally {
        active--;
        waiting.shift()?.();
    }
}

async function fetchLogo(owner: string, get: typeof fetch): Promise<Logo | undefined> {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
        let url = new URL(`https://github.com/${encodeURIComponent(owner)}.png?size=96`);
        for (let hop = 0; ; hop++) {
            const res = await get(url, { signal, redirect: "manual" });
            const location = res.headers.get("location");
            if (res.status >= 300 && res.status < 400 && location) {
                await res.body?.cancel();
                const next = new URL(location, url);
                if (hop >= MAX_REDIRECTS || next.protocol !== "https:" || !HOSTS.has(next.hostname)) return null;
                url = next;
                continue;
            }
            if (res.status === 429 || res.status >= 500) {
                await res.body?.cancel();
                return undefined;
            }
            if (!res.ok || Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) {
                await res.body?.cancel();
                return null;
            }
            const bytes = await readCapped(res);
            const mediaType = bytes && sniffImage(bytes);
            return bytes && mediaType ? { mediaType, data: Buffer.from(bytes).toString("base64") } : null;
        }
    } catch {
        return undefined;
    }
}

/** The body, or undefined once it passes MAX_BYTES (whatever Content-Length said): reading stops there. */
async function readCapped(res: Response): Promise<Uint8Array | undefined> {
    if (!res.body) return new Uint8Array();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) {
            await reader.cancel();
            return undefined;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

/** For tests: forget what was fetched. */
export function clearLogoCache(): void {
    cache.clear();
}
