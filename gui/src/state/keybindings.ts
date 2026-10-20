// The keybindings file as this window applies it: the keymap (rebuilt when the
// file is saved or Enter-sends changes), matching, and labels for the keys.

import { createSignal } from "solid-js";
import type { KeybindingsFile } from "@shared/protocol";
import { KeyMatcher, keyLabel, loadKeymap, parseKeybindingsText, type Context, type KeyIssue, type Keymap, type MatchResult } from "../../../src/keybindings/core";
import { eventStrokes } from "../lib/keystrokes";
import { os } from "../lib/platform";

const [file, setFile] = createSignal<KeybindingsFile | undefined>();
/** The Enter-sends preference (App keeps it in step; this module stays free of prefs' DOM work). */
const [enterSends, setEnterSends] = createSignal(true);
export { setEnterSends };
/** Set when the file on disk isn't usable: the last good text stays in force. */
const [fatal, setFatal] = createSignal<string | undefined>();
export { file as keybindingsFile };

/** With Enter-sends off, Enter adds a line and Mod+Enter sends. */
const ENTER_NEWLINE = { "chat:submit": ["mod+enter"], "chat:newline": ["enter", "shift+enter", "alt+enter"] };

let built: { file?: KeybindingsFile; fatal?: string; enterSends: boolean; keymap: Keymap } | undefined;

/**
 * The keymap now. Reading it in an effect or JSX tracks the file and the
 * preference; it's rebuilt only when one of them changed.
 */
export function keymap(): Keymap {
    const f = file();
    const why = fatal();
    const sends = enterSends();
    if (built && built.file === f && built.fatal === why && built.enterSends === sends) return built.keymap;
    let km: Keymap = loadKeymap(f?.text, "gui", os, sends ? undefined : { defaults: ENTER_NEWLINE });
    const extra: KeyIssue[] = [];
    if (f?.error) extra.push({ level: "error", message: f.error });
    if (why) extra.push({ level: "error", message: `${why} The last good bindings stay in force.` });
    if (extra.length) km = { ...km, issues: [...extra, ...km.issues] };
    built = { file: f, fatal: why, enterSends: sends, keymap: km };
    return km;
}

const matcher = new KeyMatcher(keymap());
const results = new WeakMap<Event, MatchResult>();

/**
 * What a key press is bound to, in the active contexts (most specific first).
 * The first handler to ask decides for the event; later handlers get the same
 * answer, so a chord moves on once per key however many handlers see it.
 */
export function matchKey(e: KeyboardEvent, contexts: readonly Context[]): MatchResult {
    const known = results.get(e);
    if (known) return known;
    let r: MatchResult;
    if ((e.type && e.type !== "keydown") || e.isComposing || e.keyCode === 229) r = { kind: "none", abandoned: 0 };
    else {
        matcher.keymap = keymap();
        const ids = eventStrokes(e);
        r = ids.length ? matcher.match(ids, contexts) : { kind: "none", abandoned: 0 };
        // Waiting for the rest of a chord: the first key does nothing of its own.
        if (r.kind === "pending") e.preventDefault();
    }
    results.set(e, r);
    return r;
}

/** The action a key press runs, if any. */
export const actionOf = (e: KeyboardEvent, contexts: readonly Context[]): string | undefined => {
    const r = matchKey(e, contexts);
    return r.kind === "action" ? r.action : undefined;
};

/** The keys bound to an action, for people: "⌘+K" (each part one key cap). `all`: every key, joined by "  ". */
export function shortcut(action: string, all = false): string | undefined {
    return keyLabel(keymap(), action, all, "  ");
}

/** The first key for an action spaced out for a hint ("⌘ K"), or "" when it has none. */
export const shortcutHint = (action: string) => shortcut(action)?.replaceAll("+", " ") ?? "";

/** "Toggle the sidebar (⌘B)"-style tooltip text. */
export const withShortcut = (label: string, action: string) => {
    const k = shortcut(action);
    return k ? `${label} (${os === "macos" ? k.replaceAll("+", "") : k})` : label;
};

/**
 * The file from the server. A save that isn't usable JSON keeps the bindings
 * already in force (the editor may be halfway through a change).
 */
export function applyKeybindingsFile(next: KeybindingsFile): { fatal?: string } {
    const why = next.text?.trim() ? parseKeybindingsText(next.text).fatal : undefined;
    if (why) {
        setFatal(why);
        if (!file()) setFile({ path: next.path });
        return { fatal: why };
    }
    setFatal(undefined);
    setFile(next);
    return {};
}
