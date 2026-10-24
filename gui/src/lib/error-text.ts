// Errors on screen: where the error cards go, and an error's message as they and the provider rows show it.

/** Where an error stack can be: above a session's composer, above Home's, at the foot of Settings, or the window's. */
export type ErrorPlace = "composer" | "home" | "settings" | "window";

/**
 * The one place errors show, of those mounted: Settings while it's open (it covers the composer),
 * else above the composer, else the window's foot, so an error is somewhere in every state
 * (the splash, a session still opening, a sub-agent's view). While the foot of the conversation
 * column is covered (lib/layout.ts coversComposer), the column's are mounted out of sight.
 */
export function errorPlace(mounted: readonly ErrorPlace[], settingsOpen: boolean, composerCovered: boolean): ErrorPlace {
    if (composerCovered) return "window";
    if (settingsOpen) return mounted.includes("settings") ? "settings" : "window";
    return mounted.includes("composer") ? "composer" : mounted.includes("home") ? "home" : "window";
}

/**
 * A short first sentence (or the part before a colon) as the title, the rest under it, so
 * "Codex isn't signed in. Run `codex login` …" reads as a heading and its fix. A message
 * without one is all title when it's short, all detail when it's long. Nothing is dropped
 * but the full stop or colon that ends the title (Copy has the message as it came).
 */
export function splitError(message: string): { title?: string; detail?: string } {
    const text = message.trim();
    for (const m of text.matchAll(/[.!?:]\s+(?=\S)/g)) {
        const head = text.slice(0, m.index);
        if (head.length >= 100 || head.includes("\n")) break;
        // Not inside a backticked command.
        if (!head || head.split("`").length % 2 === 0) continue;
        const end = m[0][0]!;
        return { title: end === "." || end === ":" ? head : head + end, detail: text.slice(m.index + m[0].length) };
    }
    return text.length <= 100 ? { title: text } : { detail: text };
}

/** The message in pieces: odd ones were in backticks (a command, a path), shown as code. */
export function messageParts(message: string): string[] {
    return message.split(/`([^`\n]+)`/);
}

/** The first backticked command in a message ("Run `codex login` …"), for a Copy command button. */
export function commandIn(message: string): string | undefined {
    return /`([^`\n]+)`/.exec(message)?.[1];
}
