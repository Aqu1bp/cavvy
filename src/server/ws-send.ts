// What a WebSocket sends goes out in order, and none of it is lost. Bun's send() drops a message (it returns 0) that's
// sent while the socket already holds more than it will take: measured, 30 MB sent and then a small message at once,
// and the small one never arrived. A rewind of a long session was sent whole and its reply right after: the window
// never heard back. So what the socket won't take waits here, and everything after it, until it drains.
//
// A window so far behind that what waits passes MAX_QUEUED_BYTES is disconnected: it connects again and opens its
// sessions afresh (what it gets then is complete), rather than this growing for as long as it can't keep up.

/** The part of Bun's ServerWebSocket this uses. */
export interface Sink {
    send(data: string | Uint8Array, compress?: boolean): number;
    close(code?: number, reason?: string): void;
}

export const MAX_QUEUED_BYTES = 256 * 1024 * 1024;

export interface OrderedSender {
    send(data: string | Uint8Array): void;
    /** The socket can take more (Bun's drain): what waits goes, in order, as far as it will take. */
    drain(): void;
    /** What's waiting, in bytes (UTF-16 units for text). */
    readonly queued: number;
}

/** `compress`: each message compressed, if the connection agreed to it (permessage-deflate). */
export function orderedSender(ws: Sink, max = MAX_QUEUED_BYTES, compress = false): OrderedSender {
    const queue: (string | Uint8Array)[] = [];
    let queued = 0;
    let gone = false;
    const size = (d: string | Uint8Array) => (typeof d === "string" ? d.length : d.byteLength);
    const wait = (d: string | Uint8Array) => {
        queue.push(d);
        queued += size(d);
        if (queued <= max) return;
        gone = true;
        queue.length = 0;
        queued = 0;
        ws.close(1013, "Too far behind; reconnect");
    };
    return {
        send(d) {
            if (gone) return;
            // Behind something still waiting: after it.
            if (queue.length) return wait(d);
            if (ws.send(d, compress) === 0) wait(d);
        },
        drain() {
            while (queue.length && !gone) {
                const d = queue[0]!;
                if (ws.send(d, compress) === 0) return;
                queue.shift();
                queued -= size(d);
            }
        },
        get queued() {
            return queued;
        },
    };
}
