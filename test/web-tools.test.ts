import { afterAll, expect, spyOn, test } from "bun:test";
import { isolate } from "./helpers/isolate";
import type { ToolContext } from "../src/tools/types";

const iso = isolate();
const { WebFetchTool } = await import("../src/tools/web-tools");
afterAll(() => iso.cleanup());

const ctx = { signal: new AbortController().signal } as ToolContext;
const MAX_BYTES = 5 * 1024 * 1024;

for (const status of [200, 500]) {
    test(`WebFetch limits and cancels streamed HTTP ${status} bodies`, async () => {
        let consumed = 0;
        let cancelled = false;
        const chunk = new Uint8Array(64 * 1024).fill(0x61);
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (consumed >= 2 * MAX_BYTES) return controller.close();
                consumed += chunk.length;
                controller.enqueue(chunk);
            },
            cancel() { cancelled = true; },
        }, { highWaterMark: 0 });
        const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status, headers: { "content-type": "text/plain" } }));
        try {
            const result = await WebFetchTool.run({ url: "https://example.com" }, ctx);
            expect(cancelled).toBe(true);
            expect(consumed).toBeLessThanOrEqual(status === 200 ? MAX_BYTES : chunk.length);
            expect(result.content).toContain("may be truncated");
            expect(result.content).toContain(`${status === 200 ? MAX_BYTES : 500}-byte limit`);
            expect(result.display?.summary).toContain("byte limit reached");
            expect(Boolean(result.isError)).toBe(status !== 200);
        } finally {
            fetch.mockRestore();
        }
    });
}

test("WebFetch cancels an oversized declared body without reading it", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream({
        pull() { pulls++; },
        cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { headers: { "content-length": String(MAX_BYTES + 1) } }));
    try {
        const result = await WebFetchTool.run({ url: "https://example.com" }, ctx);
        expect(result.isError).toBe(true);
        expect(result.content).toContain("Response too large");
        expect(cancelled).toBe(true);
        expect(pulls).toBe(0);
    } finally {
        fetch.mockRestore();
    }
});

test("WebFetch decodes UTF-8 across chunks and reports bytes", async () => {
    const bytes = new TextEncoder().encode("€".repeat(1024));
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(bytes.subarray(0, 1));
            controller.enqueue(bytes.subarray(1));
            controller.close();
        },
    });
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { headers: { "content-type": "text/plain" } }));
    try {
        const result = await WebFetchTool.run({ url: "https://example.com" }, ctx);
        expect(result.content).toEndWith("€".repeat(1024));
        expect(result.content).not.toContain("truncated");
        expect(result.display?.summary).toBe("Fetched 3 KB (200)");
    } finally {
        fetch.mockRestore();
    }
});

test("WebFetch preserves the byte-limit notice when condensing a page", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("a".repeat(MAX_BYTES + 1), { headers: { "content-type": "text/plain" } }));
    try {
        const result = await WebFetchTool.run({ url: "https://example.com", prompt: "Summarize" }, { ...ctx, summarize: async () => "summary" });
        expect(result.content).toContain("summary");
        expect(result.content).toContain("may be truncated");
        expect(result.display?.summary).toContain("byte limit reached");
    } finally {
        fetch.mockRestore();
    }
});

test("WebFetch stops a chunked HTTP server at its byte limits", async () => {
    const produced: Record<string, number> = {};
    const total = 32 * 1024 * 1024;
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
            const path = new URL(req.url).pathname;
            produced[path] = 0;
            const chunk = new Uint8Array(64 * 1024).fill(0x61);
            return new Response(new ReadableStream({
                async pull(controller) {
                    await Bun.sleep(1);
                    if (produced[path]! >= total) return controller.close();
                    produced[path]! += chunk.length;
                    controller.enqueue(chunk);
                },
            }), { status: path === "/error" ? 500 : 200, headers: { "content-type": "text/plain" } });
        },
    });
    try {
        for (const path of ["/ok", "/error"]) {
            const result = await WebFetchTool.run({ url: `http://127.0.0.1:${server.port}${path}` }, ctx);
            expect(result.content).toContain("may be truncated");
            expect(produced[path]).toBeLessThan(total);
            expect(Boolean(result.isError)).toBe(path === "/error");
        }
    } finally {
        server.stop(true);
    }
});
