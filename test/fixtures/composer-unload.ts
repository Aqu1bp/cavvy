import { strict as assert } from "node:assert";
const data = new Map<string, string>();
const listeners = new Map<string, () => void>();
Object.assign(globalThis, { window: {
    localStorage: { getItem: (k: string) => data.get(k), setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) },
    addEventListener: (event: string, callback: () => void) => listeners.set(event, callback),
} });
const { composerStorage, COMPOSER_STORAGE_KEY } = await import("../../gui/src/lib/drafts");
for (const event of ["pagehide", "beforeunload"]) {
    composerStorage.setDraft("session", event);
    listeners.get(event)!();
    assert.equal(JSON.parse(data.get(COMPOSER_STORAGE_KEY)!)[0][1].draft, event);
}
composerStorage.delete("session");
assert.equal(data.has(COMPOSER_STORAGE_KEY), false);
