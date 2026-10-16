// Secret redaction. Every API key the harness knows about is registered here,
// and all tool output / transcript text passes through `redact` before it is
// shown, stored, or sent to a model. Known-format keys that the harness does
// not own (e.g. a teammate's key in a .env file) are caught by pattern.

const exact = new Map<string, string>(); // secret -> label

const PATTERNS: [RegExp, string][] = [
    [/sk-ant-(?:api|admin|oat|sid)\d{0,2}-[A-Za-z0-9_-]{20,}/g, "anthropic-key"],
    [/sk-or-v1-[A-Za-z0-9]{32,}/g, "openrouter-key"],
    [/sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g, "openai-key"],
    [/\bAIza[0-9A-Za-z_-]{35}\b/g, "google-key"],
    [/\bgsk_[A-Za-z0-9]{40,}\b/g, "groq-key"],
    [/\bxai-[A-Za-z0-9]{40,}\b/g, "xai-key"],
    [/\btvly-[A-Za-z0-9_-]{20,}\b/g, "tavily-key"],
    [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, "github-token"],
    [/\bgithub_pat_[A-Za-z0-9_]{50,}\b/g, "github-token"],
    [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "aws-key-id"],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "slack-token"],
    [/\bya29\.[A-Za-z0-9._-]{20,}/g, "google-token"],
];

export function registerSecret(value: string | undefined, label = "secret") {
    if (!value || value.length < 8) return;
    exact.set(value, label);
}

export function unregisterSecret(value: string | undefined) {
    if (value) exact.delete(value);
}

export function knownSecrets(): string[] {
    return [...exact.keys()];
}

interface SecretSpan {
    start: number;
    end: number;
    length: number;
    label: string;
}

export function redact(text: string): string {
    if (!text) return text;
    const spans: SecretSpan[] = [];
    // Match the original text: replacing one value first can break a longer or overlapping value.
    for (const [secret, label] of exact) {
        let span: SecretSpan | undefined;
        let start = text.indexOf(secret);
        while (start >= 0) {
            const end = start + secret.length;
            if (span && start < span.end) span.end = end;
            else {
                span = { start, end, length: secret.length, label };
                spans.push(span);
            }
            // A value can overlap itself. Advancing by its length would expose the final suffix.
            start = text.indexOf(secret, start + 1);
        }
    }
    for (const [re, label] of PATTERNS) {
        re.lastIndex = 0;
        for (let match; (match = re.exec(text)); ) {
            spans.push({ start: match.index, end: match.index + match[0].length, length: match[0].length, label });
        }
    }
    if (!spans.length) return text;
    spans.sort((a, b) => a.start - b.start || b.length - a.length);
    const out: string[] = [];
    let cursor = 0;
    let current = spans[0]!;
    for (let i = 1; i < spans.length; i++) {
        const next = spans[i]!;
        if (next.start < current.end) {
            current.end = Math.max(current.end, next.end);
            if (next.length > current.length) {
                current.length = next.length;
                current.label = next.label;
            }
        } else {
            out.push(text.slice(cursor, current.start), `[REDACTED ${current.label}]`);
            cursor = current.end;
            current = next;
        }
    }
    out.push(text.slice(cursor, current.start), `[REDACTED ${current.label}]`, text.slice(current.end));
    return out.join("");
}

/** Longer than this, the rest of a line isn't kept for showing (`head -c 1G /dev/zero` has no line breaks). */
const MAX_PARTIAL_LINE = 64 * 1024;

/**
 * For output shown as it arrives: a key split between two pieces gets past
 * redact() in each. Keys don't span lines, so each piece returns the whole
 * lines it completes, redacted before and after `prep` (such as stripping colors), and
 * the rest waits for more. A line too long to wait for isn't shown; the full
 * output, redacted whole at the end, still has it.
 */
export function lineRedactor(prep: (text: string) => string = (t) => t): (chunk: string) => string {
    let pending = "";
    let skipping = false;
    return (chunk) => {
        let text = pending + chunk;
        if (skipping) {
            const end = text.search(/[\r\n]/);
            pending = "";
            if (end < 0) return "";
            text = text.slice(end + 1);
            skipping = false;
        }
        const cut = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1;
        pending = text.slice(cut);
        if (pending.length > MAX_PARTIAL_LINE) {
            pending = "";
            skipping = true;
        }
        return cut ? redact(prep(redact(text.slice(0, cut)))) : "";
    };
}

export function containsSecret(text: string): boolean {
    return redact(text) !== text;
}

/** Display form: first few chars, ellipsis, last 4. Never enough to reuse. */
export function maskKey(key: string): string {
    if (key.length <= 12) return "•".repeat(Math.max(4, key.length));
    const prefixMatch = key.match(/^([A-Za-z]+[-_](?:[A-Za-z0-9]+[-_])?)/);
    // Always hide at least 8 characters, however short the key.
    const head = (prefixMatch ? prefixMatch[1]!.slice(0, 10) : key.slice(0, 4)).slice(0, Math.max(0, key.length - 12));
    return `${head}…${key.slice(-4)}`;
}

/**
 * Fields that must be stored byte for byte: image and PDF bytes, and signed or
 * encrypted reasoning that providers verify on replay. Matched by the shape
 * of the object holding them, so a tool input's own `data` field is still redacted.
 */
function opaque(holder: { type?: unknown } | undefined, key: string): boolean {
    const t = holder?.type;
    switch (key) {
        case "data":
            return t === "image" || t === "base64" || t === "redacted_thinking" || (t === "file" && (holder as { kind?: unknown }).kind === "pdf");
        case "signature":
        case "redactedData":
        case "thinking":
        case "text":
            return t === "thinking";
        case "encrypted_content":
            return t === "reasoning";
        case "thought_signature":
            return true;
        default:
            return false;
    }
}

/**
 * JSON with every string value redacted before it is escaped. Redacting the
 * serialized text instead misses a secret whose characters JSON escapes.
 */
export function redactedJson(v: unknown): string {
    return JSON.stringify(v, function (this: { type?: unknown } | undefined, k, x) {
        return typeof x === "string" && !opaque(this, k) ? redact(x) : x;
    });
}
