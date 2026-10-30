// Binary pictures use their own authenticated socket, away from chat and tool traffic.
// One message = uint32 header byte length (big endian), UTF-8 JSON metadata, encoded image bytes.
export interface BrowserImageFrame {
    sessionId: string;
    frameId: string;
    tab: number;
    width: number;
    height: number;
    data: Uint8Array<ArrayBuffer>;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_HEADER = 4096;

export function encodeBrowserFrame(frame: Omit<BrowserImageFrame, "data">, data: Uint8Array): Uint8Array<ArrayBuffer> {
    const header = encoder.encode(JSON.stringify(frame));
    if (header.length > MAX_HEADER) throw new Error("Browser frame header is too large");
    const packet = new Uint8Array(4 + header.length + data.length);
    new DataView(packet.buffer).setUint32(0, header.length);
    packet.set(header, 4);
    packet.set(data, 4 + header.length);
    return packet;
}

export function decodeBrowserFrame(packet: ArrayBuffer): BrowserImageFrame | undefined {
    if (packet.byteLength < 5) return;
    const length = new DataView(packet).getUint32(0);
    if (length > MAX_HEADER || 4 + length >= packet.byteLength) return;
    try {
        const h = JSON.parse(decoder.decode(new Uint8Array(packet, 4, length)));
        if (typeof h.sessionId !== "string" || typeof h.frameId !== "string" ||
            !Number.isSafeInteger(h.tab) || !Number.isSafeInteger(h.width) || !Number.isSafeInteger(h.height) ||
            h.width < 1 || h.height < 1 || h.width > 16000 || h.height > 16000) return;
        return { sessionId: h.sessionId, frameId: h.frameId, tab: h.tab, width: h.width, height: h.height, data: new Uint8Array(packet, 4 + length) };
    } catch { return; }
}

/** A picture of a session's simulator screen, on the same socket: told apart from a browser frame by its header's `simulator`. */
export interface SimulatorImageFrame {
    sessionId: string;
    frameId: string;
    width: number;
    height: number;
    data: Uint8Array<ArrayBuffer>;
}

export function encodeSimulatorFrame(frame: Omit<SimulatorImageFrame, "data">, data: Uint8Array): Uint8Array<ArrayBuffer> {
    return encodeBrowserFrame({ ...frame, tab: -1, simulator: true } as Omit<BrowserImageFrame, "data">, data);
}

/** A simulator picture, or undefined when the packet isn't one. */
export function decodeSimulatorFrame(packet: ArrayBuffer): SimulatorImageFrame | undefined {
    if (packet.byteLength < 5) return;
    const length = new DataView(packet).getUint32(0);
    if (length > MAX_HEADER || 4 + length >= packet.byteLength) return;
    try {
        const h = JSON.parse(decoder.decode(new Uint8Array(packet, 4, length)));
        if (h.simulator !== true || typeof h.sessionId !== "string" || typeof h.frameId !== "string" || !Number.isSafeInteger(h.width) || !Number.isSafeInteger(h.height) || h.width < 1 || h.height < 1 || h.width > 16000 || h.height > 16000) return;
        return { sessionId: h.sessionId, frameId: h.frameId, width: h.width, height: h.height, data: new Uint8Array(packet, 4 + length) };
    } catch {
        return;
    }
}
