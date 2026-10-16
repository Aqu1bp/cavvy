/** Browser-local composer text only. Never pass attachment payloads or transcript data here. */
export const COMPOSER_STORAGE_KEY = "harness.composer.v1";
export const HISTORY_LIMIT = 100;
export const COMPOSER_MAX_CHARS = 1_000_000; // ~2 MB of UTF-16, leaving room for other preferences.
export const COMPOSER_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
type Entry = { draft: string; history: string[]; updated: number };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

export function createComposerStorage(storage: () => Storage | undefined, now = Date.now) {
    const entries = new Map<string, Entry>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const raw = storage()?.getItem(COMPOSER_STORAGE_KEY);
        const saved: unknown = raw && raw.length <= COMPOSER_MAX_CHARS ? JSON.parse(raw) : undefined;
        if (Array.isArray(saved)) for (const pair of saved.slice(-100)) {
            if (!Array.isArray(pair) || pair.length !== 2) continue;
            const [key, value] = pair;
            if (typeof key !== "string" || !value || typeof value.draft !== "string" || !Array.isArray(value.history) || !Number.isFinite(value.updated)) continue;
            if (now() - value.updated > COMPOSER_MAX_AGE) continue;
            entries.set(key, { draft: value.draft, history: [...new Set<string>(value.history.filter((v: unknown) => typeof v === "string"))].slice(-HISTORY_LIMIT), updated: value.updated });
        }
    } catch { /* Unavailable or corrupt storage must not prevent typing. */ }

    function flush() {
        clearTimeout(timer);
        timer = undefined;
        const saved = [...entries].filter(([, e]) => now() - e.updated <= COMPOSER_MAX_AGE).sort((a, b) => a[1].updated - b[1].updated).slice(-100);
        let json = JSON.stringify(saved);
        // Never truncate text: keep the most recent complete entries that fit.
        while (json.length > COMPOSER_MAX_CHARS && saved.length) {
            saved.shift();
            json = JSON.stringify(saved);
        }
        try {
            if (saved.length) storage()?.setItem(COMPOSER_STORAGE_KEY, json);
            else storage()?.removeItem(COMPOSER_STORAGE_KEY);
        } catch { /* Quota/private mode: the in-memory draft remains usable. */ }
    }
    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(flush, 250);
    }
    function entry(key: string): Entry {
        const existing = entries.get(key);
        if (existing && now() - existing.updated <= COMPOSER_MAX_AGE) return existing;
        entries.delete(key);
        return { draft: "", history: [], updated: now() };
    }
    return {
        draft: (key: string) => entry(key).draft,
        history: (key: string) => [...entry(key).history],
        setDraft(key: string, text: string) {
            const e = entry(key);
            entries.set(key, { ...e, draft: text, updated: now() });
            if (!text && !e.history.length) entries.delete(key);
            schedule();
        },
        remember(key: string, text: string) {
            if (!text.trim()) return;
            const e = entry(key);
            entries.set(key, { ...e, history: [...e.history.filter((t) => t !== text), text].slice(-HISTORY_LIMIT), updated: now() });
            schedule();
        },
        delete(key: string) { entries.delete(key); flush(); },
        flush,
    };
}

export const composerStorage = createComposerStorage(() => typeof window === "undefined" ? undefined : window.localStorage);
if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", composerStorage.flush);
    window.addEventListener("pagehide", composerStorage.flush);
}
