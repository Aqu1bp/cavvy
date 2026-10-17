// Keep grammar loading and tokenization off the UI thread. The worker owns the
// shared grammar/result caches; callers retain their existing async API.
export type HighlightRequest = { id: number; kind: "html" | "lines" | "warm"; code?: string; lang?: string };
export type HighlightResponse = { id: number; result?: string | string[]; error?: string };

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (value: string | string[] | undefined) => void; reject: (error: Error) => void }>();

function start(): Worker {
    const active = new Worker(new URL("./highlight-worker.ts", import.meta.url), { type: "module" });
    active.onmessage = (event: MessageEvent<HighlightResponse>) => {
        const { id, result, error } = event.data;
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        if (error) request.reject(new Error(error));
        else request.resolve(result);
    };
    const fail = () => {
        if (worker !== active) return;
        worker = undefined;
        active.terminate();
        for (const request of pending.values()) request.reject(new Error("Syntax highlighting worker failed"));
        pending.clear();
    };
    active.onerror = (event) => { event.preventDefault(); fail(); };
    active.onmessageerror = fail;
    return active;
}

function request(kind: HighlightRequest["kind"], code?: string, lang?: string): Promise<string | string[] | undefined> {
    // Unsupported worker environments retain readable plain code. Large inputs
    // also stay plain, matching the tokenizer's existing 200k character limit.
    if (typeof Worker === "undefined" || (kind !== "warm" && (!lang || (code?.length ?? 0) > 200_000))) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
        worker ??= start();
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        try { worker.postMessage({ id, kind, code, lang } satisfies HighlightRequest); }
        catch (error) { pending.delete(id); reject(error); }
    });
}

export async function highlight(code: string, lang: string | undefined): Promise<string | undefined> {
    return await request("html", code, lang) as string | undefined;
}

export async function highlightLines(code: string, lang: string | undefined): Promise<string[] | undefined> {
    return await request("lines", code, lang) as string[] | undefined;
}

/** Start loading Shiki in the background (after first paint). */
export function warmUp() {
    void request("warm").catch(() => undefined);
}
