// Keep grammar loading and tokenization off the UI thread. The worker owns the
// shared grammar/result caches; callers retain their existing async API.
export type HighlightRequest = { id: number; kind: "html" | "lines" | "warm" | "stream" | "cancel" | "more" | "end"; code?: string; lang?: string; writing?: number };
/** A stream's parts carry `from` (the first line's index); its last message has `done`, and `plain` when nothing was colored. */
export type HighlightResponse = { id: number; result?: string | string[]; error?: string; from?: number; done?: boolean; plain?: boolean };

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (value: string | string[] | undefined) => void; reject: (error: Error) => void; part?: (from: number, lines: string[]) => void }>();

function start(): Worker {
    const active = new Worker(new URL("./highlight-worker.ts", import.meta.url), { type: "module" });
    active.onmessage = (event: MessageEvent<HighlightResponse>) => {
        const { id, result, error, from, done } = event.data;
        const request = pending.get(id);
        if (!request) return;
        if (from !== undefined && !error) {
            request.part?.(from, result as string[]);
            return;
        }
        pending.delete(id);
        if (done) return request.resolve(undefined);
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

function request(kind: HighlightRequest["kind"], code?: string, lang?: string, part?: (from: number, lines: string[]) => void, started?: (id: number) => void, writing?: number): Promise<string | string[] | undefined> {
    // Unsupported worker environments retain readable plain code. Large inputs
    // also stay plain, matching the tokenizer's existing 200k character limit.
    if (typeof Worker === "undefined" || (kind !== "warm" && (!lang || (code?.length ?? 0) > 200_000))) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
        worker ??= start();
        const id = ++sequence;
        pending.set(id, { resolve, reject, part });
        started?.(id);
        try { worker.postMessage({ id, kind, code, lang, writing } satisfies HighlightRequest); }
        catch (error) { pending.delete(id); reject(error); }
    });
}

export async function highlight(code: string, lang: string | undefined): Promise<string | undefined> {
    return await request("html", code, lang) as string | undefined;
}

let writings = 0;
/** A number for a code block starting to be written, for highlightMore. */
export const newWriting = () => ++writings;

/** The HTML of lines just finished in a block being written, each read once (highlight-core.ts). */
export async function highlightMore(writing: number, lines: string, lang: string | undefined): Promise<string | undefined> {
    return await request("more", lines, lang, undefined, undefined, writing) as string | undefined;
}

export function endWriting(writing: number) {
    try { worker?.postMessage({ id: 0, kind: "end", writing } satisfies HighlightRequest); } catch { /* the worker is gone */ }
}

export async function highlightLines(code: string, lang: string | undefined): Promise<string[] | undefined> {
    return await request("lines", code, lang) as string[] | undefined;
}

/**
 * Each line highlighted, handed to `part(from, lines)` a part at a time: the first lines come at once, the
 * rest follow. Settles when the last part is in (or it stays plain); `cancel()` stops the work in the worker.
 */
export function highlightLineStream(code: string, lang: string | undefined, part: (from: number, lines: string[]) => void): { done: Promise<void>; cancel: () => void } {
    let id: number | undefined;
    let over = false;
    const done = request("stream", code, lang, (from, lines) => !over && part(from, lines), (n) => (id = n)).then(() => { over = true; });
    return {
        done,
        cancel() {
            if (over) return;
            over = true;
            if (id === undefined) return;
            pending.get(id)?.resolve(undefined);
            pending.delete(id);
            try { worker?.postMessage({ id, kind: "cancel" } satisfies HighlightRequest); } catch { /* the worker is gone */ }
        },
    };
}

/** Start loading Shiki in the background (after first paint). */
export function warmUp() {
    void request("warm").catch(() => undefined);
}
