// A plugin maker's logo for Settings → Plugins: their GitHub account's avatar. The GUI's
// Content-Security-Policy keeps images to its own origin, so the server fetches it and hands
// over the bytes. Each account is asked once per run; one without an avatar is remembered too.

import { sniffImage } from "../util/files";

/** A GitHub user or organization name. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8_000;

export type Logo = { mediaType: string; data: string } | null;

const cache = new Map<string, Promise<Logo>>();

export function pluginLogo(owner: string, get: typeof fetch = fetch): Promise<Logo> {
    if (!OWNER.test(owner)) return Promise.resolve(null);
    const key = owner.toLowerCase();
    let hit = cache.get(key);
    if (!hit) {
        // Offline or timed out (undefined): asked again next time, unlike an account with no avatar.
        hit = fetchLogo(owner, get).then((logo) => {
            if (logo === undefined) cache.delete(key);
            return logo ?? null;
        });
        cache.set(key, hit);
    }
    return hit;
}

async function fetchLogo(owner: string, get: typeof fetch): Promise<Logo | undefined> {
    try {
        const res = await get(`https://github.com/${encodeURIComponent(owner)}.png?size=96`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
        if (!res.ok) return null;
        const length = Number(res.headers.get("content-length") ?? 0);
        if (length > MAX_BYTES) return null;
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > MAX_BYTES) return null;
        const mediaType = sniffImage(bytes);
        return mediaType ? { mediaType, data: Buffer.from(bytes).toString("base64") } : null;
    } catch {
        return undefined;
    }
}

/** For tests: forget what was fetched. */
export function clearLogoCache(): void {
    cache.clear();
}
