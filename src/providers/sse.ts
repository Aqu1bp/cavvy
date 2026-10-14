// Minimal Server-Sent Events parser for fetch() response bodies.

export interface SseEvent {
    event?: string;
    data: string;
}

export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
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
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.search(/\r?\n/)) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(buf[nl] === "\r" ? nl + 2 : nl + 1);
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
