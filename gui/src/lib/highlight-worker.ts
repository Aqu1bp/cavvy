import { highlight, highlightLineChunks, highlightLines, warmUp } from "./highlight-core";
import type { HighlightRequest, HighlightResponse } from "./highlight";

/** Streams under way that were asked to stop. */
const cancelled = new Set<number>();

self.onmessage = async (event: MessageEvent<HighlightRequest>) => {
    const { id, kind, code = "", lang } = event.data;
    if (kind === "cancel") {
        cancelled.add(id);
        return;
    }
    try {
        if (kind === "stream") {
            const done = await highlightLineChunks(code, lang, (from, lines) => self.postMessage({ id, from, result: lines } satisfies HighlightResponse), () => cancelled.has(id));
            cancelled.delete(id);
            self.postMessage({ id, done: true, plain: !done } satisfies HighlightResponse);
            return;
        }
        if (kind === "warm") warmUp();
        const result = kind === "warm" ? undefined : await (kind === "html" ? highlight(code, lang) : highlightLines(code, lang));
        self.postMessage({ id, result } satisfies HighlightResponse);
    } catch {
        cancelled.delete(id);
        // A failed grammar/chunk can be retried through the existing boundary.
        self.postMessage({ id, error: "Syntax highlighting failed" } satisfies HighlightResponse);
    }
};
