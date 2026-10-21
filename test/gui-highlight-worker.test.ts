import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function client(Worker: any) {
    const source = readFileSync(new URL("../gui/src/lib/highlight.ts", import.meta.url), "utf8").replace(/export /g, "").replace('new URL("./highlight-worker.ts", import.meta.url)', '"worker.js"');
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    return new Function("Worker", `${js}; return { highlight, highlightLines, highlightLineStream, warmUp };`)(Worker);
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

test("a highlight stream hands over its parts in order, settles on its last, and a cancel reaches the worker", async () => {
    const workers: any[] = [];
    class FakeWorker {
        onmessage?: (event: any) => void;
        messages: any[] = [];
        constructor() { workers.push(this); }
        postMessage(message: any) { this.messages.push(message); }
        terminate() {}
    }
    const c = client(FakeWorker);
    const parts: [number, string[]][] = [];
    const s = c.highlightLineStream("a\nb\nc", "ts", (from: number, lines: string[]) => parts.push([from, lines]));
    const w = workers[0]!;
    const id = w.messages[0].id;
    expect(w.messages[0].kind).toBe("stream");
    w.onmessage?.({ data: { id, from: 0, result: ["A"] } });
    w.onmessage?.({ data: { id, from: 1, result: ["B", "C"] } });
    w.onmessage?.({ data: { id, done: true } });
    await s.done;
    expect(parts).toEqual([[0, ["A"]], [1, ["B", "C"]]]);
    // Cancelled: the worker is told, later parts are dropped, and it still settles.
    const later: unknown[] = [];
    const t = c.highlightLineStream("d\ne", "ts", (...a: unknown[]) => later.push(a));
    const tid = w.messages[1].id;
    t.cancel();
    expect(w.messages[2]).toEqual({ id: tid, kind: "cancel" });
    w.onmessage?.({ data: { id: tid, from: 0, result: ["D"] } });
    await t.done;
    expect(later).toEqual([]);
    // No language: plain, nothing sent.
    const u = c.highlightLineStream("x", undefined, () => later.push(1));
    await u.done;
    expect(w.messages).toHaveLength(3);
});

test("actual worker streams a long diff side in parts: the first screenful first, then the rest; a cancel stops it", async () => {
    const worker = new Worker(new URL("../gui/src/lib/highlight-worker.ts", import.meta.url).href, { type: "module" });
    const got = new Map<number, any[]>();
    const done = new Map<number, () => void>();
    worker.onmessage = (event) => {
        const d = event.data;
        got.set(d.id, [...(got.get(d.id) ?? []), d]);
        if (d.done || d.error) done.get(d.id)?.();
    };
    const stream = (id: number, code: string) => new Promise<void>((resolve) => { done.set(id, resolve); worker.postMessage({ id, kind: "stream", code, lang: "ts" }); });
    try {
        const code = Array.from({ length: 1000 }, (_, i) => `const value${i}: number = ${i};`).join("\n");
        await stream(1, code);
        const parts = got.get(1)!.filter((d) => d.from !== undefined);
        expect(parts[0].from).toBe(0);
        expect(parts[0].result).toHaveLength(80);
        expect(parts.reduce((n, d) => n + d.result.length, 0)).toBe(1000);
        expect(parts.map((d) => d.from)).toEqual(parts.map((_, i) => (i ? 80 + (i - 1) * 400 : 0)));
        expect(got.get(1)!.at(-1)).toEqual({ id: 1, done: true, plain: false });
        // Asked again: from the cache, in one part.
        await stream(2, code);
        expect(got.get(2)!.filter((d) => d.from !== undefined)).toHaveLength(1);
        // Cancelled after its first part: it stops there.
        const other = `${code}\n// another`;
        const p = stream(3, other);
        worker.postMessage({ id: 3, kind: "cancel" });
        await p;
        const partsAfterCancel = got.get(3)!.filter((d) => d.from !== undefined);
        expect(partsAfterCancel.length).toBeLessThanOrEqual(1);
        expect(got.get(3)!.at(-1)).toEqual({ id: 3, done: true, plain: true });
    } finally {
        worker.terminate();
    }
});
