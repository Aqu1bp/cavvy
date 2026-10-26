import { afterAll, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { parseSse } = await import("../src/providers/sse");
afterAll(() => iso.cleanup());

async function parseChunks(chunks: Uint8Array[]) {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    });
    return Array.fromAsync(parseSse(body));
}

for (const ending of ["\r", "\n", "\r\n"]) {
    test(`SSE parses ${JSON.stringify(ending)} lines across every byte boundary`, async () => {
        const bytes = new TextEncoder().encode([": keep-alive", "event: update", "data: café", "data: two", "", "data: three", "", ""].join(ending));
        const expected = [{ event: "update", data: "café\ntwo" }, { event: undefined, data: "three" }];
        expect(await parseChunks([bytes])).toEqual(expected);
        for (let i = 1; i < bytes.length; i++) {
            expect(await parseChunks([bytes.slice(0, i), new Uint8Array(), bytes.slice(i)])).toEqual(expected);
        }
        expect(await parseChunks(Array.from(bytes, (b) => new Uint8Array([b])))).toEqual(expected);
    });
}

test("SSE accepts mixed line endings", async () => {
    const bytes = new TextEncoder().encode("event: update\rdata: one\r\ndata: two\n\rdata: three\n\n");
    expect(await parseChunks(Array.from(bytes, (b) => new Uint8Array([b])))).toEqual([
        { event: "update", data: "one\ntwo" },
        { event: undefined, data: "three" },
    ]);
});

test("SSE yields CR-delimited events before the stream closes", async () => {
    const ac = new AbortController();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode("data: one\r\r"));
        },
    });
    const events = parseSse(body, ac.signal);
    const timer = setTimeout(() => ac.abort(), 1000);
    try {
        expect(await events.next()).toEqual({ done: false, value: { event: undefined, data: "one" } });
    } finally {
        clearTimeout(timer);
        ac.abort();
        await events.return(undefined);
    }
});
