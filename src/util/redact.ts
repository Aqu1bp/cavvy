// Secret redaction. Every API key the harness knows about is registered here,
// and all tool output / transcript text passes through `redact` before it is
// shown, stored, or sent to a model. Known-format keys that the harness does
// not own (e.g. a teammate's key in a .env file) are caught by pattern.

import { SECRET_PATTERNS as PATTERNS } from "./secret-patterns";
import { APP_NAME } from "../config/paths";

const exact = new Map<string, { label: string; prefix?: Uint32Array }>();
let revision = 0;

/** Cached, shortened text must be rebuilt when the secrets used to redact it change. */
export function redactionVersion(): number {
    return revision;
}

export function registerSecret(value: string | undefined, label = "secret") {
    if (!value || value.length < 8) return;
    if (exact.get(value)?.label === label) return;
    const prefix = new Uint32Array(value.length);
    for (let i = 1, j = 0; i < value.length; i++) {
        while (j && value[i] !== value[j]) j = prefix[j - 1]!;
        if (value[i] === value[j]) j++;
        prefix[i] = j;
    }
    // A proper prefix equal to a suffix means occurrences can overlap. Keep its
    // failure table so repetitive inputs take linear time even for very long values.
    exact.set(value, { label, prefix: prefix[value.length - 1] ? prefix : undefined });
    revision++;
}

export function unregisterSecret(value: string | undefined) {
    if (value && exact.delete(value)) revision++;
}

export function knownSecrets(): string[] {
    return [...exact.keys()];
}

export function redactionMarkers(extraLabels: string[] = []): string[] {
    const labels = new Set(["secret", "gui-token", `${APP_NAME} MCP token`, ...extraLabels, ...PATTERNS.map(([, label]) => label), ...[...exact.values()].map(({ label }) => label)]);
    return [...labels].map((label) => `[REDACTED ${label}]`);
}

interface SecretSpan {
    start: number;
    end: number;
    length: number;
    label: string;
}

export function redact(text: string): string {
    return redactThrough(text, text.length);
}

/** Match the full text, but show only original positions before the limit.
 * Redaction can shrink text, so cutting its result could expose an incomplete
 * secret near the end of an already bounded input. Crossing matches stay whole.
 */
export function redactPrefix(text: string, sourceLimit: number): string {
    return redactThrough(text, Math.max(0, Math.min(text.length, Math.floor(sourceLimit))));
}

function* exactSpans(text: string, secret: string, label: string, prefix?: Uint32Array): Generator<SecretSpan> {
    function* starts() {
        if (prefix) {
            for (let i = 0, j = 0; i < text.length; i++) {
                while (j && text[i] !== secret[j]) j = prefix[j - 1]!;
                if (text[i] === secret[j]) j++;
                if (j === secret.length) {
                    yield i + 1 - secret.length;
                    j = prefix[j - 1]!;
                }
            }
        } else {
            let start = text.indexOf(secret);
            while (start >= 0) {
                yield start;
                start = text.indexOf(secret, start + secret.length);
            }
        }
    }
    let span: SecretSpan | undefined;
    for (const start of starts()) {
        const end = start + secret.length;
        if (span && start <= span.end) span.end = end;
        else {
            if (span) yield span;
            span = { start, end, length: secret.length, label };
        }
    }
    if (span) yield span;
}

function* patternSpans(text: string, pattern: RegExp, label: string): Generator<SecretSpan> {
    const re = new RegExp(pattern.source, pattern.flags);
    for (let match; (match = re.exec(text)); ) {
        yield { start: match.index, end: match.index + match[0].length, length: match[0].length, label };
    }
}

interface SpanSource {
    span: SecretSpan;
    iterator: Iterator<SecretSpan>;
    order: number;
}

function redactThrough(text: string, sourceLimit: number): string {
    if (!text || sourceLimit <= 0) return "";
    // Each matcher keeps only its next span. A dense line can have millions of
    // matches, so collecting and sorting all matches would exhaust the server.
    const heap: SpanSource[] = [];
    const before = (a: SpanSource, b: SpanSource) => a.span.start - b.span.start || b.span.length - a.span.length || a.order - b.order;
    let order = 0;
    const add = (iterator: Iterator<SecretSpan>) => {
        const result = iterator.next();
        const sourceOrder = order++;
        if (result.done) return;
        const source = { span: result.value, iterator, order: sourceOrder };
        let i = heap.length;
        heap.push(source);
        while (i > 0) {
            const parent = (i - 1) >>> 1;
            if (before(heap[parent]!, source) <= 0) break;
            heap[i] = heap[parent]!;
            i = parent;
        }
        heap[i] = source;
    };
    const take = (): SecretSpan => {
        const root = heap[0]!;
        const span = root.span;
        const next = root.iterator.next();
        if (next.done) {
            const last = heap.pop()!;
            if (heap.length) heap[0] = last;
        } else root.span = next.value;
        if (heap.length) {
            const source = heap[0]!;
            let i = 0;
            while (i * 2 + 1 < heap.length) {
                let child = i * 2 + 1;
                if (child + 1 < heap.length && before(heap[child + 1]!, heap[child]!) < 0) child++;
                if (before(source, heap[child]!) <= 0) break;
                heap[i] = heap[child]!;
                i = child;
            }
            heap[i] = source;
        }
        return span;
    };
    // Match original text: replacement first can break longer or overlapping values.
    for (const [secret, { label, prefix }] of exact) {
        if (secret.length <= text.length) add(exactSpans(text, secret, label, prefix));
    }
    for (const [pattern, label] of PATTERNS) add(patternSpans(text, pattern, label));
    if (!heap.length) return text.slice(0, sourceLimit);
    const out: string[] = [];
    let parts: string[] = [];
    let partLength = 0;
    const append = (part: string) => {
        if (!part) return;
        parts.push(part);
        partLength += part.length;
        // Bound intermediate output objects too; only the final text grows with output.
        if (partLength >= 8192) {
            out.push(parts.join(""));
            parts = [];
            partLength = 0;
        }
    };
    const finish = () => {
        if (parts.length) out.push(parts.join(""));
        return out.join("");
    };
    let cursor = 0;
    const emit = (span: SecretSpan) => {
        if (span.start >= sourceLimit) return;
        append(text.slice(cursor, span.start));
        append(`[REDACTED ${span.label}]`);
        cursor = span.end;
    };
    let current = take();
    while (heap.length) {
        const next = take();
        if (next.start < current.end) {
            current.end = Math.max(current.end, next.end);
            if (next.length > current.length) {
                current.length = next.length;
                current.label = next.label;
            }
        } else {
            emit(current);
            if (cursor >= sourceLimit) return finish();
            current = next;
        }
    }
    emit(current);
    append(text.slice(cursor, sourceLimit));
    return finish();
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
