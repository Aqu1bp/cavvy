// Cavvy was called Harness, and this GUI kept its preferences, drafts and review
// comments under harness.* keys. Each moves to its cavvy.* key once (a value
// already there wins) before anything reads them: main.tsx imports this first.
// Only localStorage: what a window keeps in sessionStorage lasts as long as the window.

const OLD = "harness.";
const NEW = "cavvy.";

export function moveLegacyKeys(storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem"> | undefined): void {
    if (!storage) return;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k?.startsWith(OLD)) keys.push(k);
    }
    for (const k of keys) {
        try {
            const value = storage.getItem(k);
            const now = NEW + k.slice(OLD.length);
            if (value !== null && storage.getItem(now) === null) storage.setItem(now, value);
            storage.removeItem(k);
        } catch {
            // Full or blocked storage: the old key stays, and the GUI starts from its defaults.
        }
    }
}

try {
    moveLegacyKeys(typeof window === "undefined" ? undefined : window.localStorage);
} catch {
    // Storage the browser won't let this page use.
}
