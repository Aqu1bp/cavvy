import { describe, expect, test } from "bun:test";
import { decodeBrowserFrame, encodeBrowserFrame } from "../src/server/browser-wire";

const header = { sessionId: "session", frameId: "frame", tab: 2, width: 900, height: 600 };
describe("browser binary transport", () => {
    test("carries raw encoded bytes and CSS coordinates without base64", () => {
        const image = Uint8Array.of(255, 216, 255, 0, 128, 15);
        const packet = encodeBrowserFrame(header, image);
        const frame = decodeBrowserFrame(packet.buffer)!;
        expect(frame).toEqual({ ...header, data: image });
        // Decoding retains a view of the packet rather than copying a whole image.
        expect(frame.data.buffer).toBe(packet.buffer);
    });
    test("rejects truncated headers, absent images and invalid coordinate metadata", () => {
        expect(decodeBrowserFrame(new ArrayBuffer(3))).toBeUndefined();
        const tooLarge = new Uint8Array(8);
        new DataView(tooLarge.buffer).setUint32(0, 1_000_000);
        expect(decodeBrowserFrame(tooLarge.buffer)).toBeUndefined();
        expect(decodeBrowserFrame(encodeBrowserFrame(header, new Uint8Array()).buffer)).toBeUndefined();
        expect(decodeBrowserFrame(encodeBrowserFrame({ ...header, width: NaN }, Uint8Array.of(1)).buffer)).toBeUndefined();
    });
});
