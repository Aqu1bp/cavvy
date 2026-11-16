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

/** What `streamCoalescer` takes and sends: a session's ops, or anything else. */
export type CoalescedEvent = { type: string; sessionId?: string; seq?: number; ops?: unknown[] };
type Append = { op: "append"; turnId: string; blockId: string; field: string; text: string };

/**
 * For a window on another machine: a reply's text, streamed a few characters a message, goes in fewer, bigger messages.
 * Each message costs its frame, and over an ssh tunnel a packet with its MAC and an acknowledgement back: 20 characters
 * every 33 ms was 3.8 bytes a character on the wire, compressed (measured through a tunnel to a VPS): about 50 bytes a
 * message whatever it holds, so a message needs some 70 characters to come to 1.2 a character. Text that comes after a
 * quiet `ms` goes at once (the first words of a reply aren't held); after that, what comes within `ms` of the last
 * message goes together, a block's text in one append, or sooner once `chars` characters are held. Anything else (a
 * status, a question, a reply) goes at once, after what's held, so nothing is reordered and nothing but text waits.
 */
export function streamCoalescer(send: (ev: CoalescedEvent) => void, ms: number, chars = Infinity) {
    let held: Map<string, { seq: number; ops: unknown[] }> | undefined;
    let heldChars = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = -Infinity;
    const flush = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        if (!held) return;
        const h = held;
        held = undefined;
        heldChars = 0;
        last = performance.now();
        for (const [sessionId, { seq, ops }] of h) send({ type: "session.ops", sessionId, seq, ops });
    };
    const textOnly = (ev: CoalescedEvent) => ev.type === "session.ops" && !!ev.ops?.length && ev.ops.every((o) => (o as { op?: string }).op === "append");
    return {
        send(ev: CoalescedEvent) {
            if (!textOnly(ev)) {
                flush();
                send(ev);
                return;
            }
            const now = performance.now();
            if (!held && now - last >= ms) {
                last = now;
                send(ev);
                return;
            }
            held ??= new Map();
            const h = held.get(ev.sessionId!) ?? { seq: ev.seq!, ops: [] };
            held.set(ev.sessionId!, h);
            h.seq = ev.seq!;
            for (const op of ev.ops as Append[]) {
                heldChars += op.text.length;
                const prev = h.ops.at(-1) as Append | undefined;
                if (prev && prev.turnId === op.turnId && prev.blockId === op.blockId && prev.field === op.field) h.ops[h.ops.length - 1] = { ...prev, text: prev.text + op.text };
                else h.ops.push(op);
            }
            if (heldChars >= chars) flush();
            else timer ??= setTimeout(flush, Math.max(0, ms - (now - last)));
        },
        /** What's held goes now (before anything else is sent on the socket). */
        flush,
    };
}
