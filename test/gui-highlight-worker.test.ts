import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function client(Worker: any) {
    const source = readFileSync(new URL("../gui/src/lib/highlight.ts", import.meta.url), "utf8").replace(/export /g, "").replace('new URL("./highlight-worker.ts", import.meta.url)', '"worker.js"');
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    return new Function("Worker", `${js}; return { highlight, highlightLines, warmUp };`)(Worker);
}

test("highlight client shares a worker, correlates out-of-order responses, bounds payloads and retries failures", async () => {
    const workers: FakeWorker[] = [];
    class FakeWorker {
        onmessage?: (event: any) => void;
        onerror?: (event: any) => void;
        onmessageerror?: () => void;
        messages: any[] = [];
        terminated = false;
        constructor() { workers.push(this); }
        postMessage(message: any) { this.messages.push(message); }
        terminate() { this.terminated = true; }
        reply(at: number, result: any) { this.onmessage?.({ data: { id: this.messages[at].id, result } }); }
    }
    const c = client(FakeWorker);
    expect(await c.highlight("plain", undefined)).toBeUndefined();
    expect(await c.highlight("x".repeat(200_001), "ts")).toBeUndefined();
    expect(workers).toHaveLength(0);
    const a = c.highlight("const a = 1", "ts"), b = c.highlightLines("a\nb", "ts");
    expect(workers).toHaveLength(1);
    const w = workers[0]!;
    expect(w.messages.map((m) => m.kind)).toEqual(["html", "lines"]);
    w.reply(1, ["a", "b"]); w.reply(0, "<span>a</span>");
    expect(await a).toBe("<span>a</span>");
    expect(await b).toEqual(["a", "b"]);
    const failed = c.highlight("more", "ts");
    const rejection = failed.catch((error: Error) => error.message);
    w.onerror?.({ preventDefault() {} });
    expect(await rejection).toContain("worker failed");
    expect(w.terminated).toBe(true);
    const retried = c.highlight("more", "ts");
    expect(workers).toHaveLength(2);
    workers[1]!.reply(0, "more");
    expect(await retried).toBe("more");
    expect(await client(undefined).highlight("readable", "ts")).toBeUndefined();
});

test("actual Shiki worker produces HTML and diff lines while the UI event loop remains responsive", async () => {
    const worker = new Worker(new URL("../gui/src/lib/highlight-worker.ts", import.meta.url).href, { type: "module" });
    let sequence = 0;
    const pending = new Map<number, (data: any) => void>();
    worker.onmessage = (event) => { pending.get(event.data.id)?.(event.data); pending.delete(event.data.id); };
    const send = (kind: string, code: string) => new Promise<any>((resolve) => { const id = ++sequence; pending.set(id, resolve); worker.postMessage({ id, kind, code, lang: "ts" }); });
    try {
        expect((await send("html", "const warm = 1;")).error).toBeUndefined();
        const code = Array.from({ length: 2000 }, (_, i) => `const value${i}: number = ${i};`).join("\n");
        let ticks = 0;
        const timer = setInterval(() => ticks++, 5);
        const start = performance.now();
        let response: any;
        try { response = await send("html", code); }
        finally { clearInterval(timer); }
        expect(response.error).toBeUndefined();
        expect(response.result).toContain("value1999");
        expect(response.result).toContain("<span");
        expect(ticks).toBeGreaterThan(0);
        console.log(JSON.stringify({ highlightChars: code.length, elapsedMs: performance.now() - start, uiTicks: ticks }));
        const lines = await send("lines", "const x = 1;\nconst y = 2;");
        expect(lines.result).toHaveLength(2);
    } finally { worker.terminate(); }
}, 15_000);
