// Minimal Server-Sent Events parser for fetch() response bodies.

import { ProviderError } from "./types";

export interface SseEvent {
    event?: string;
    data: string;
}

/**
 * How long a request may go without a byte from the server before it counts
 * as stalled. Generous on purpose: some endpoints (Vertex) send no headers
 * until the model's first token, and thinking can take minutes.
 */
export const stall = {
    ms: 5 * 60_000,
    /**
     * The first byte, from an endpoint that holds the whole reply until it's
     * ready (Vertex: no headers before the first token, and a tool call comes
     * in one piece). A 32k-token file at Gemini's ~90 tokens/s is ~6 minutes,
     * after up to a few minutes before the first token.
     */
    firstByteMs: 10 * 60_000,
};

/**
 * A signal that aborts when `parent` does, or when `touch` isn't called for
 * `stall.ms` (`stall.firstByteMs` before the first touch, if `holdsReply`).
 */
export function stallTimer(parent: AbortSignal | undefined, holdsReply = false) {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let limit = 0;
    const arm = (ms: number) => {
        clearTimeout(timer);
        limit = ms;
        timer = setTimeout(() => ac.abort(), ms);
    };
    const first = () => arm(holdsReply ? Math.max(stall.ms, stall.firstByteMs) : stall.ms);
    first();
    return {
        signal: parent ? AbortSignal.any([parent, ac.signal]) : ac.signal,
        touch: () => arm(stall.ms),
        /** A new request on the same timer (a retry after a refreshed token): wait for its first byte again. */
        restart: first,
        stalled: () => ac.signal.aborted && !parent?.aborted,
        /** How long it waits now, for the message when it gives up. */
        limit: () => limit,
        stop: () => clearTimeout(timer),
    };
}

/** The error for a stalled request: retryable, and marked so the agent gives up after a few. */
export function stallError(provider: string, ms = stall.ms): ProviderError {
    const e = new ProviderError(stallMessage(provider, ms), undefined, true);
    e.stalled = true;
    return e;
}

export function stallMessage(provider: string, ms = stall.ms): string {
    const s = Math.round(ms / 1000);
    return `No response from ${provider} for ${s >= 60 ? `${Math.round(s / 60)} minutes` : `${s}s`}`;
}

export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal, onData?: () => void): AsyncGenerator<SseEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let skipLf = false;
    let event: string | undefined;
    let data: string[] = [];
    const onAbort = () => reader.cancel().catch(() => {});
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
        while (true) {
            const { value, done } = await reader.read();
            // Cancelling the reader on abort ends the stream "normally"; callers
            // must not mistake a cut-off response for a complete one.
            if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
            if (done) break;
            onData?.();
            let chunk = decoder.decode(value, { stream: true });
            if (skipLf && chunk.length) {
                if (chunk.startsWith("\n")) chunk = chunk.slice(1);
                skipLf = false;
            }
            buf += chunk;
            let nl: number;
            while ((nl = buf.search(/[\r\n]/)) >= 0) {
                const line = buf.slice(0, nl);
                // A trailing CR ends the line now; swallow its LF if it arrives later.
                skipLf = buf[nl] === "\r" && nl === buf.length - 1;
                buf = buf.slice(buf[nl] === "\r" && buf[nl + 1] === "\n" ? nl + 2 : nl + 1);
                if (line === "") {
                    if (data.length) yield { event, data: data.join("\n") };
                    event = undefined;
                    data = [];
                    continue;
                }
                if (line.startsWith(":")) continue; // comment / keep-alive
                const colon = line.indexOf(":");
                const field = colon < 0 ? line : line.slice(0, colon);
                let val = colon < 0 ? "" : line.slice(colon + 1);
                if (val.startsWith(" ")) val = val.slice(1);
                if (field === "data") data.push(val);
                else if (field === "event") event = val;
            }
        }
        buf += decoder.decode();
        if (buf.trim().startsWith("data:")) data.push(buf.trim().slice(5).trimStart());
        if (data.length) yield { event, data: data.join("\n") };
    } finally {
        signal?.removeEventListener("abort", onAbort);
        reader.releaseLock();
    }
}
