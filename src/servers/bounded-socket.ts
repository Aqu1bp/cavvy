// A WebSocket client that takes in no more than it was told to. The system's own client hands over a message only
// once it has all of it, however big (measured with Bun 1.3: a 200 MB message from the other end grew this process
// by over a gigabyte before any size check of ours could run). For a connection to a machine that may not be doing
// what its user wants (src/servers/watch.ts), the size of a message is read from its frame's first bytes, and one
// over the limit ends the connection there, before its body is read.
//
// Only what that connection needs: text messages, to and from a server on this machine's own loopback (the end of an
// SSH tunnel). No extensions (so nothing is compressed), no binary messages.

import { createHash, randomBytes } from "crypto";

export interface BoundedSocket {
    send(text: string): void;
    close(): void;
    readonly open: boolean;
    /** Bytes taken in so far, the handshake included. */
    readonly bytesIn: number;
}

export type Closed = "closed" | "too-much" | "failed";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/**
 * What each piece of a message counts for beside its bytes: a message sent as endless empty pieces would otherwise
 * never reach the limit, and each piece costs this end memory of its own (measured before this: 65 MB of two-byte
 * frames grew the process by 3 GB).
 */
const PIECE_COST = 64;
/** What may wait to go out when the other end is slow to take it, unless told otherwise: this end says little. */
const MAX_UNSENT = 64 * 1024;
/** The answer to the handshake is a few hundred bytes. */
const MAX_HEAD = 16 * 1024;

export function openBoundedSocket(o: {
    port: number;
    path: string;
    protocols: string[];
    /** The most one message may hold, in bytes. */
    maxMessage: number;
    /** The most that may wait to go out to an end that isn't reading (MAX_UNSENT): past it the connection ends. */
    maxUnsent?: number;
    onOpen(): void;
    onMessage(text: string): void;
    /** Once, however it ends: by either side ("closed"), for a message over the limit ("too-much"), or never opened or broken ("failed"). */
    onClose(why: Closed): void;
}): BoundedSocket {
    let socket: import("bun").Socket<undefined> | undefined;
    let buffered = Buffer.alloc(0);
    let state: "connecting" | "open" | "closed" = "connecting";
    let bytesIn = 0;
    /** A message that came in pieces: the pieces so far. */
    let parts: Buffer[] = [];
    let partsSize = 0;
    /** What hasn't gone out yet, in order: the other end was slow to take it. Only so much (maxUnsent). */
    let unsent: Buffer[] = [];
    let unsentBytes = 0;
    const key = randomBytes(16).toString("base64");

    const end = (why: Closed) => {
        if (state === "closed") return;
        state = "closed";
        buffered = Buffer.alloc(0);
        parts = [];
        unsent = [];
        unsentBytes = 0;
        try {
            socket?.terminate();
        } catch {
            // gone already
        }
        o.onClose(why);
    };

    const hold = (data: Buffer) => {
        unsent.push(data);
        unsentBytes += data.length;
        // An end that takes nothing in while this one keeps answering it isn't one to stay connected to.
        if (unsentBytes > (o.maxUnsent ?? MAX_UNSENT)) end("failed");
    };

    const write = (data: Buffer) => {
        if (!socket || state === "closed") return;
        if (unsent.length) return hold(data);
        const n = socket.write(data);
        if (n < 0) return end("failed");
        if (n < data.length) hold(data.subarray(n));
    };

    /** One frame from this end: masked, as a client's must be. */
    const frame = (opcode: number, payload: Buffer) => {
        const n = payload.length;
        const head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 0xff]) : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), bigLength(n)]);
        const mask = randomBytes(4);
        const body = Buffer.from(payload);
        for (let i = 0; i < n; i++) body[i]! ^= mask[i & 3]!;
        write(Buffer.concat([head, mask, body]));
    };

    const handshake = (): boolean => {
        const at = buffered.indexOf("\r\n\r\n");
        if (at < 0) {
            if (buffered.length > MAX_HEAD) end("failed");
            return false;
        }
        const head = buffered.subarray(0, at).toString("latin1");
        buffered = buffered.subarray(at + 4);
        const accept = /^sec-websocket-accept:\s*(\S+)\s*$/im.exec(head)?.[1];
        const wanted = createHash("sha1")
            .update(key + GUID)
            .digest("base64");
        if (!/^HTTP\/1\.1 101\b/.test(head) || accept !== wanted) {
            end("failed");
            return false;
        }
        state = "open";
        o.onOpen();
        return true;
    };

    /** Takes whole frames off the front of what's come in. False when it ended the connection. */
    const frames = (): boolean => {
        for (;;) {
            if (buffered.length < 2) return true;
            const first = buffered[0]!;
            const second = buffered[1]!;
            const opcode = first & 0x0f;
            let length = second & 0x7f;
            let at = 2;
            if (length === 126) {
                if (buffered.length < 4) return true;
                length = buffered.readUInt16BE(2);
                at = 4;
            } else if (length === 127) {
                if (buffered.length < 10) return true;
                const big = buffered.readBigUInt64BE(2);
                // Said before a byte of it is read: the connection ends here.
                if (big > BigInt(o.maxMessage)) return (end("too-much"), false);
                length = Number(big);
                at = 10;
            }
            // A server's frames aren't masked, extensions weren't asked for, and nothing here is binary.
            if (second & 0x80 || first & 0x70) return (end("failed"), false);
            const control = opcode >= 0x8;
            if (control ? length > 125 || !(first & 0x80) : partsSize + length > o.maxMessage) return (end(control ? "failed" : "too-much"), false);
            if (buffered.length < at + length) return true;
            const payload = buffered.subarray(at, at + length);
            buffered = buffered.subarray(at + length);
            if (opcode === 0x8) {
                frame(0x8, Buffer.alloc(0));
                return (end("closed"), false);
            }
            // A ping is answered unless what was said before hasn't gone out yet: answers don't pile up for an end that isn't reading.
            if (opcode === 0x9) {
                if (!unsent.length) frame(0xa, Buffer.from(payload));
            }
            else if (opcode === 0x1 || opcode === 0x0) {
                // A piece with nothing before it, or a new message inside another: not how messages are sent.
                if ((opcode === 0x0) !== parts.length > 0) return (end("failed"), false);
                parts.push(Buffer.from(payload));
                partsSize += length + (first & 0x80 && parts.length === 1 ? 0 : PIECE_COST);
                if (first & 0x80) {
                    const text = (parts.length === 1 ? parts[0]! : Buffer.concat(parts)).toString("utf-8");
                    parts = [];
                    partsSize = 0;
                    o.onMessage(text);
                    if (state !== "open") return false;
                }
            } else if (opcode !== 0xa) return (end("failed"), false);
        }
    };

    void Bun.connect({
        hostname: "127.0.0.1",
        port: o.port,
        socket: {
            open(s) {
                socket = s;
                if (state === "closed") return void s.terminate();
                write(Buffer.from(`GET ${o.path} HTTP/1.1\r\nHost: 127.0.0.1:${o.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${o.protocols.join(", ")}\r\n\r\n`, "latin1"));
            },
            data(_s, chunk) {
                if (state === "closed") return;
                bytesIn += chunk.length;
                buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
                if (state === "connecting" && !handshake()) return;
                frames();
            },
            drain(s) {
                while (unsent.length && state !== "closed") {
                    const next = unsent[0]!;
                    const n = s.write(next);
                    if (n < 0) return end("failed");
                    unsentBytes -= n;
                    if (n < next.length) {
                        unsent[0] = next.subarray(n);
                        return;
                    }
                    unsent.shift();
                }
            },
            close() {
                end(state === "open" ? "closed" : "failed");
            },
            error() {
                end("failed");
            },
            connectError() {
                end("failed");
            },
            timeout() {
                end("failed");
            },
        },
    }).catch(() => end("failed"));

    return {
        send(text) {
            if (state === "open") frame(0x1, Buffer.from(text, "utf-8"));
        },
        close() {
            if (state === "open") frame(0x8, Buffer.alloc(0));
            end("closed");
        },
        get open() {
            return state === "open";
        },
        get bytesIn() {
            return bytesIn;
        },
    };
}

function bigLength(n: number): Buffer {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    return b;
}
