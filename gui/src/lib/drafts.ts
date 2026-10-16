import { matchesSecretPattern } from "../../../src/util/secret-patterns";

/** Browser-local composer text only. Never pass attachment payloads or transcript data here. */
export const COMPOSER_STORAGE_KEY = "harness.composer.v1";
export const HISTORY_LIMIT = 100;
export const COMPOSER_MAX_CHARS = 1_000_000; // ~2 MB of UTF-16, leaving room for other preferences.
export const COMPOSER_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
type Entry = { draft: string; history: string[]; updated: number };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

// redact.ts's known-format patterns are shared; the GUI cannot import its Node config or
// server-only registered secrets. Also exclude login commands and legacy OpenAI key shapes.
const privateText = (text: string) => /^\s*\/login\b/im.test(text) || /\bsk-[A-Za-z0-9_-]{20,}/.test(text) || matchesSecretPattern(text);
const safe = (e: Entry): Entry => ({ ...e, draft: privateText(e.draft) ? "" : e.draft, history: e.history.filter((text) => !privateText(text)) });
const clearPriority = (e: Entry) => e.draft ? 0 : e.history.length ? 1 : 2;
const hasPrivateText = (e: Entry) => privateText(e.draft) || e.history.some(privateText);

export function createComposerStorage(storage: () => Storage | undefined, now = Date.now) {
    const entries = new Map<string, Entry>();
    const dirty = new Set<string>();
    // Sensitive or over-budget edits remain usable in this tab, but never go back on disk.
    const memoryOnly = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    function read(target: Storage) {
        const raw = target.getItem(COMPOSER_STORAGE_KEY);
        const result = new Map<string, Entry>();
        let scrub = false;
        try {
            const saved: unknown = raw && raw.length <= COMPOSER_MAX_CHARS ? JSON.parse(raw) : undefined;
            if (Array.isArray(saved)) for (const pair of saved.slice(-100)) {
                if (!Array.isArray(pair) || pair.length !== 2) continue;
                const [key, value] = pair;
                if (typeof key !== "string" || !value || typeof value.draft !== "string" || !Array.isArray(value.history) || !Number.isFinite(value.updated)) continue;
                if (now() - value.updated >= COMPOSER_MAX_AGE) continue;
                const e: Entry = { draft: value.draft, history: [...new Set<string>(value.history.filter((v: unknown) => typeof v === "string"))].slice(-HISTORY_LIMIT), updated: value.updated };
                scrub ||= hasPrivateText(e);
                result.set(key, safe(e));
            }
        } catch { /* Invalid storage is treated as empty. */ }
        // Expired/oversized malformed values can contain credentials too; discard them on read.
        scrub ||= !!raw && raw !== JSON.stringify([...result]);
        return { raw, result, scrub };
    }

    function sync(remote: Map<string, Entry>) {
        for (const key of new Set([...entries.keys(), ...remote.keys()])) {
            if (dirty.has(key)) continue;
            const next = remote.get(key);
            if (memoryOnly.has(key) && (!next || next.updated <= (entries.get(key)?.updated ?? 0))) continue;
            memoryOnly.delete(key);
            if (next) entries.set(key, next);
            else entries.delete(key);
        }
    }

    function flush() {
        clearTimeout(timer);
        timer = undefined;
        try {
            const target = storage();
            if (!target) return;
            const { raw, result: merged } = read(target);
            const applied = new Set<string>();
            for (const key of dirty) {
                const local = entries.get(key)!;
                const remote = merged.get(key);
                if (now() - local.updated >= COMPOSER_MAX_AGE) continue;
                // A clear wins a same-millisecond tie. Empty entries are tombstones: an older
                // pending edit must not resurrect a sent/deleted draft on a later unload.
                const value = safe(local);
                if (!remote || value.updated > remote.updated || (value.updated === remote.updated && (clearPriority(value) >= clearPriority(remote)))) {
                    merged.set(key, value);
                    applied.add(key);
                }
            }
            const saved = [...merged].sort((a, b) => a[1].updated - b[1].updated).slice(-100);
            let json = JSON.stringify(saved);
            // Never truncate text: keep the most recent complete entries that fit.
            while (json.length > COMPOSER_MAX_CHARS && saved.length) {
                saved.shift();
                json = JSON.stringify(saved);
            }
            if (saved.length) {
                if (json !== raw) target.setItem(COMPOSER_STORAGE_KEY, json);
            } else if (raw !== null) target.removeItem(COMPOSER_STORAGE_KEY);
            const persisted = new Map(saved);
            for (const key of dirty) {
                if (applied.has(key) && (hasPrivateText(entries.get(key)!) || !persisted.has(key))) memoryOnly.add(key);
                else memoryOnly.delete(key);
            }
            dirty.clear();
            sync(persisted);
        } catch { /* Quota/private mode: retain dirty edits for retry and keep typing in memory. */ }
    }
    function refresh() {
        try {
            const target = storage();
            if (!target) return;
            const { result, scrub } = read(target);
            sync(result);
            // Remove credentials left by older versions immediately, without waiting for an edit.
            if (scrub) flush();
        } catch { /* Unavailable storage must not prevent typing. */ }
    }
    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(flush, 250);
    }
    function entry(key: string): Entry {
        const existing = entries.get(key);
        if (existing && now() - existing.updated < COMPOSER_MAX_AGE) return existing;
        return { draft: "", history: [], updated: 0 };
    }
    function update(key: string, e: Entry) {
        entries.set(key, { ...e, updated: now() });
        dirty.add(key);
        if (hasPrivateText(e)) flush(); // Purge any previously saved version immediately.
        else schedule();
    }
    refresh();
    return {
        draft: (key: string) => entry(key).draft,
        history: (key: string) => [...entry(key).history],
        setDraft(key: string, text: string) {
            refresh();
            const e = entry(key);
            if (e.draft === text) return;
            update(key, { ...e, draft: text });
        },
        remember(key: string, text: string) {
            if (!text.trim()) return;
            refresh();
            const e = entry(key);
            update(key, { ...e, history: [...e.history.filter((t) => t !== text), text].slice(-HISTORY_LIMIT) });
        },
        delete(key: string) {
            refresh();
            update(key, { draft: "", history: [], updated: 0 });
            flush();
        },
        refresh,
        flush,
    };
}

export const composerStorage = createComposerStorage(() => typeof window === "undefined" ? undefined : window.localStorage);
if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", composerStorage.flush);
    window.addEventListener("pagehide", composerStorage.flush);
    window.addEventListener("storage", (event) => {
        if (event.key === COMPOSER_STORAGE_KEY || event.key === null) composerStorage.refresh();
    });
}
