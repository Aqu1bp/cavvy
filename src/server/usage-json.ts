/** Streaming JSON projection for JSONL usage scans. Unselected values (including
 * prompts, tool output and assistant content) are never retained. A line may be
 * arbitrarily large; only whitelisted scalar fields and a bounded stack survive. */
type Fields = { [key: string]: true | Fields };
const counters: Fields = Object.fromEntries([
    "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cacheWrite1hTokens", "webSearchRequests", "cost", "costEstimated", "fastMode", "resolvedModel", "billing",
    "input_tokens", "output_tokens", "cached_input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "cache_write_input_tokens", "total_tokens", "speed",
].map(k => [k, true]));
counters.cache_creation = { ephemeral_5m_input_tokens: true, ephemeral_1h_input_tokens: true };
const fields: Fields = {
    t: true, type: true, at: true, timestamp: true, model: true, cost: true, unknown: true, accountId: true,
    // A Cavvy session's account, backend, parked and subagent lines (usage-reader.ts ran()).
    provider: true, id: true, fork: true, createdAt: true,
    sessionId: true, requestId: true, usage: counters,
    message: { id: true, model: true, usage: counters },
    payload: { type: true, id: true, session_id: true, model: true,
        forked_from_id: true, source: { subagent: { thread_spawn: { parent_thread_id: true } } },
        thread_settings: { service_tier: true },
        info: { total_token_usage: counters, last_token_usage: counters },
    },
};
type Frame = { array: boolean; fields?: Fields; value?: Record<string, unknown>; key: string; phase: "key" | "colon" | "value" | "comma"; empty: boolean };
export class UsageJson {
    private stack: Frame[] = [];
    private root: unknown;
    private invalid = false;
    private quoted = false;
    private escaped = false;
    private token = "";
    private capture = false;
    private primitive = false;
    private selection(): true | Fields | undefined {
        if (!this.stack.length) return this.root === undefined ? fields : undefined;
        const f = this.stack.at(-1)!;
        return f.phase === "value" && f.fields && Object.hasOwn(f.fields, f.key) ? f.fields[f.key] : undefined;
    }
    private value(v: unknown) {
        const f = this.stack.at(-1);
        if (!f) { if (this.root !== undefined) this.invalid = true; this.root = v; return; }
        if (f.phase !== "value") { this.invalid = true; return; }
        if (f.value && this.selection()) f.value[f.key] = v;
        f.phase = "comma"; f.empty = false;
    }
    private scalar() {
        try {
            const f = this.stack.at(-1);
            const v = this.capture ? JSON.parse(Buffer.from(this.token, "latin1").toString("utf8")) : null;
            if (f?.phase === "key" && !this.primitive) { f.key = typeof v === "string" ? v : ""; f.phase = "colon"; }
            else this.value(v);
        } catch { this.invalid = true; }
        this.token = ""; this.primitive = false;
    }
    /**
     * Where the string being skipped ends in `bytes` from `i`: its closing quote, or -1 when it runs past them (with
     * `escaped` set if they end on a backslash). Native searches: most of a transcript is text nobody reads.
     */
    private skipString(bytes: Buffer, i: number): number {
        // A backslash is looked for only before the next quote, so each byte is searched once.
        let quote = bytes.indexOf(34, i);
        for (;;) {
            const slash = (quote === -1 ? bytes.subarray(i) : bytes.subarray(i, quote)).indexOf(92);
            if (slash === -1) return quote;
            i += slash + 2;
            if (i > bytes.length) { this.escaped = true; return -1; }
            if (quote !== -1 && quote < i) quote = bytes.indexOf(34, i);
        }
    }
    feed(bytes: Buffer) {
        for (let i = 0; i < bytes.length; i++) {
            if (this.invalid) return;
            const byte = bytes[i]!;
            if (this.quoted) {
                if (!this.capture) {
                    // Unread, so not checked for raw control bytes: a line can't hold a newline, and nothing else in it matters.
                    if (this.escaped) { this.escaped = false; continue; }
                    const end = this.skipString(bytes, i);
                    if (end === -1) return;
                    i = end; this.quoted = false; this.scalar();
                    continue;
                }
                if (byte < 32) { this.invalid = true; continue; }
                this.token += String.fromCharCode(byte);
                if (this.token.length > 2048) { this.invalid = true; continue; }
                if (this.escaped) this.escaped = false;
                else if (byte === 92) this.escaped = true;
                else if (byte === 34) { this.quoted = false; this.scalar(); }
                continue;
            }
            const space = byte === 32 || byte === 10 || byte === 13 || byte === 9;
            if (this.primitive && !(space || byte === 44 || byte === 125 || byte === 93)) {
                this.token += String.fromCharCode(byte);
                if (this.token.length > 128) this.invalid = true;
                continue;
            }
            if (this.primitive) this.scalar();
            if (space) continue;
            const c = String.fromCharCode(byte);
            const f = this.stack.at(-1);
            if (c === '"') {
                this.quoted = true; this.capture = f?.phase === "key" ? !!f.fields : this.selection() === true;
                this.token = this.capture ? '"' : "";
            } else if (c === "{" || c === "[") {
                const selected = this.selection();
                const value = c === "{" && selected && selected !== true ? Object.create(null) : undefined;
                this.value(value ?? null);
                this.stack.push({ array: c === "[", fields: value ? selected as Fields : undefined, value, key: "", phase: c === "{" ? "key" : "value", empty: true });
                if (this.stack.length > 100) this.invalid = true;
            } else if (c === "}" || c === "]") {
                if (!f || f.array !== (c === "]") || !(f.phase === "comma" || f.empty)) this.invalid = true;
                this.stack.pop();
            } else if (c === ":") {
                if (!f || f.phase !== "colon") this.invalid = true;
                else f.phase = "value";
            } else if (c === ",") {
                if (!f || f.phase !== "comma") this.invalid = true;
                else { f.phase = f.array ? "value" : "key"; f.empty = false; }
            } else {
                this.capture = this.selection() === true; this.primitive = true; this.token = c;
            }
        }
    }
    finish(): any {
        if (this.primitive) this.scalar();
        return !this.invalid && !this.quoted && !this.stack.length ? this.root : undefined;
    }
}
