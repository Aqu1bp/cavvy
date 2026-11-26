import { isElectron, os, type Os } from "./platform";

/**
 * Ctrl+Q, the desktop app's Quit on Linux: its menu's key, which runs only for a key the page leaves alone, so a
 * terminal, which sends Ctrl+Q to its shell, leaves it to the app. ⌘Q on a Mac is the menu's before the page sees it,
 * so Ctrl+Q there stays the shell's, as it does on Windows, where Quit has no key, and in a browser tab.
 */
export const quitsApp = (e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">, on: { os: Os; desktop: boolean } = { os, desktop: isElectron }): boolean =>
    on.desktop && on.os === "linux" && e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === "q";
