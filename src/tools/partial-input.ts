// What a call is about before its arguments have all arrived: the short fields most tools' input starts with
// (the file, the command, the pattern), read from the JSON as it streams. A 4k-character Write can take seconds
// to arrive; its file is in the first few dozen.

/** The fields read, in the order a row would want them. Long ones (a Write's content, a prompt) aren't: they're never what a row names. */
const LEADING = ["file_path", "notebook_path", "path", "pattern", "command", "description", "url", "query", "skill"] as const;

/** How much of the arguments is read: the leading fields are well inside it, and a long value isn't kept whole. */
export const PARTIAL_SCAN = 4096;

const FIELD = new Map(LEADING.map((k) => [k, new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)]));

/**
 * The leading fields whose value has arrived whole, from the start of a call's arguments as streamed so far.
 * A key inside a string value doesn't count: there, its quotes are escaped.
 */
export function partialInput(json: string): Record<string, string> {
    const out: Record<string, string> = {};
    const head = json.slice(0, PARTIAL_SCAN);
    for (const [key, re] of FIELD) {
        const m = re.exec(head);
        if (!m) continue;
        try {
            out[key] = JSON.parse(`"${m[1]}"`);
        } catch {
            // An escape cut in two: next time.
        }
    }
    return out;
}
