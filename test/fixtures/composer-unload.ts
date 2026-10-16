import { strict as assert } from "node:assert";
const data = new Map<string, string>();
const listeners = new Map<string, (event?: any) => void>();
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
assert.deepEqual(JSON.parse(data.get(COMPOSER_STORAGE_KEY)!)[0][1].draft, "");
assert.deepEqual(JSON.parse(data.get(COMPOSER_STORAGE_KEY)!)[0][1].history, []);

// Storage events refresh this tab; null keys represent localStorage.clear().
const { createComposerStorage } = await import("../../gui/src/lib/drafts");
const other = createComposerStorage(() => window.localStorage);
other.setDraft("remote", "typed in another tab");
other.flush();
listeners.get("storage")!({ key: COMPOSER_STORAGE_KEY });
assert.equal(composerStorage.draft("remote"), "typed in another tab");
data.clear();
listeners.get("storage")!({ key: null });
assert.equal(composerStorage.draft("remote"), "");

// Mount, attachment updates and cleanup cannot mark unchanged stale text as a new edit.
const { createRoot } = await import("../../gui/node_modules/solid-js/dist/solid.js");
const { createComposerDraft } = await import("../../gui/src/lib/composer-draft");
const mount = () => createRoot((dispose) => ({ ...createComposerDraft(() => "lifecycle"), dispose }));
const composer = mount();
composer.setText("message sent by another tab");
composerStorage.flush();
other.refresh();
other.setDraft("lifecycle", "");
other.flush();
listeners.get("storage")!({ key: COMPOSER_STORAGE_KEY });
composer.setAttachments([]);
composer.dispose();
listeners.get("beforeunload")!();
assert.equal(createComposerStorage(() => window.localStorage).draft("lifecycle"), "");
const reopened = mount();
assert.equal(reopened.text(), "");
reopened.dispose();
composerStorage.flush();
