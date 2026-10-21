// The Language Server Protocol's wire format: JSON-RPC 2.0 messages, each
// after a `Content-Length: <bytes>\r\n\r\n` header, over a server's stdio.

export interface RpcMessage {
    jsonrpc: "2.0";
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeMessage(msg: RpcMessage): Uint8Array {
    const body = encoder.encode(JSON.stringify(msg));
    const head = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
    const out = new Uint8Array(head.length + body.length);
    out.set(head);
    out.set(body, head.length);
    return out;
}

/** Splits a byte stream into messages. Bodies that aren't JSON are skipped, never fatal. */
export class MessageReader {
    /** Unread bytes are buf[start, end); the buffer doubles as needed, so a large message isn't copied for every chunk. */
    private buf = new Uint8Array(64 * 1024);
    private start = 0;
    private end = 0;
    /** A message this large (64 MB) means the stream is broken, not that a server has that much to say. */
    static readonly MAX_BODY = 64 * 1024 * 1024;

    constructor(private onMessage: (msg: RpcMessage) => void) {}

    push(chunk: Uint8Array) {
        this.append(chunk);
        for (;;) {
            const view = this.buf.subarray(this.start, this.end);
            const head = headerEnd(view);
            if (head < 0) return;
            const header = decoder.decode(view.subarray(0, head));
            const len = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
            if (!Number.isFinite(len) || len > MessageReader.MAX_BODY) {
                // No usable length: drop the header and look for the next one.
                this.start += head + 4;
                continue;
            }
            if (view.length < head + 4 + len) return;
            const body = decoder.decode(view.subarray(head + 4, head + 4 + len));
            this.start += head + 4 + len;
            let msg: unknown;
            try {
                msg = JSON.parse(body);
            } catch {
                continue;
            }
            if (msg && typeof msg === "object" && !Array.isArray(msg)) this.onMessage(msg as RpcMessage);
        }
    }

    private append(chunk: Uint8Array) {
        const used = this.end - this.start;
        if (this.end + chunk.length > this.buf.length) {
            // Move what's unread to the front, into a bigger buffer when it doesn't fit.
            let size = this.buf.length;
            while (size < used + chunk.length) size *= 2;
            if (size === this.buf.length) this.buf.copyWithin(0, this.start, this.end);
            else {
                const next = new Uint8Array(size);
                next.set(this.buf.subarray(this.start, this.end));
                this.buf = next;
            }
            this.start = 0;
            this.end = used;
        }
        this.buf.set(chunk, this.end);
        this.end += chunk.length;
    }
}

function headerEnd(buf: Uint8Array): number {
    for (let i = 0; i + 3 < buf.length; i++) {
        if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
    }
    return -1;
}
